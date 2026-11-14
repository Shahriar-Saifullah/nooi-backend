"""
Nooi photo render — render_scene.py
============================================================================
Runs inside Blender (`blender -b --factory-startup -P render_scene.py -- …`)
or with the `bpy` Python module. Turns one Nooi scene into one photo-real
image with Cycles:

    render_scene.py -- scene.glb spec.json out.jpg [stats.json]

scene.glb   the browser's GLB export of the live 3D view
spec.json   camera, sun, lamps and size (frontend lib/render/sceneSpec.ts)

What it does beyond "import and render":

  * Lights are rebuilt. The GLB carries the browser's lights, several of which
    are stand-ins for bounced light (fill, floor bounce) that a path tracer
    computes for real. They are deleted; the sun and the lamps that are on
    come from the spec.
  * Materials the web export cannot describe are fixed by name: clear window
    glass ("nooi-glass") becomes real transmissive glass that lets the sun
    through.
  * Exposure is measured, not guessed: a tiny preview is rendered first and
    the exposure set so the image's average brightness lands where a
    photographer would put it. A sunny living room and a lamp-lit bedroom at
    night both come out readable.

Coordinates: the spec is in three.js space (Y up). glTF import converts to
Blender (Z up) as (x, y, z) -> (x, -z, y); everything here does the same.
"""

import json
import math
import os
import sys
import time

import bpy
from mathutils import Quaternion, Vector


def argv_after_dashes():
    a = sys.argv
    return a[a.index("--") + 1:] if "--" in a else a[1:]


def to_blender(v):
    x, y, z = v
    return Vector((x, -z, y))


# three.js world -> Blender world: +90 degrees about X
WORLD_ROT = Quaternion((1, 0, 0), math.radians(90))


def hex_rgb(h):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    # linear, which is what Blender colour sockets take
    return tuple((c / 12.92) if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)


def log(msg):
    print(f"[nooi-render] {msg}", flush=True)


# ── scene ──────────────────────────────────────────────────────────────────

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_scene(path):
    bpy.ops.import_scene.gltf(filepath=path)
    # the browser's lights are replaced below
    for o in list(bpy.data.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o, do_unlink=True)
        elif o.type == "CAMERA":
            bpy.data.objects.remove(o, do_unlink=True)


def principled(mat):
    if not mat.node_tree:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def set_input(node, names, value):
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def fix_materials():
    glass_mats = set()
    for mat in bpy.data.materials:
        name = (mat.name or "").lower()
        p = principled(mat)
        if p is None:
            continue
        if name.startswith("nooi-glass"):
            glass_mats.add(mat.name)
            set_input(p, ["Base Color"], (0.97, 0.99, 1.0, 1.0))
            set_input(p, ["Transmission Weight", "Transmission"], 1.0)
            set_input(p, ["Roughness"], 0.0)
            set_input(p, ["IOR"], 1.45)
            set_input(p, ["Alpha"], 1.0)
            # the importer wires the web material's opacity into Alpha
            for link in list(mat.node_tree.links):
                if link.to_node == p and link.to_socket.name == "Alpha":
                    mat.node_tree.links.remove(link)
        else:
            # A web material at 0 roughness is a mirror; nothing in a room is.
            r = p.inputs.get("Roughness")
            if r is not None and not r.is_linked and r.default_value < 0.08:
                r.default_value = 0.08
    # Glass must not block the sun. A real pane does let it through, but a
    # path tracer only finds that light through caustics, which are too noisy
    # to use; leaving glass out of shadow rays is the standard archviz fix.
    n = 0
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        if any(s.material and s.material.name in glass_mats for s in o.material_slots):
            o.visible_shadow = False
            n += 1
    log(f"glass objects: {n}")


def add_camera(spec):
    c = spec["camera"]
    data = bpy.data.cameras.new("NooiCamera")
    data.sensor_fit = "VERTICAL"
    data.angle_y = math.radians(c["fovDeg"])
    data.clip_start = 0.03
    data.clip_end = 1000
    cam = bpy.data.objects.new("NooiCamera", data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = to_blender(c["position"])
    qx, qy, qz, qw = c["quaternion"]
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = WORLD_ROT @ Quaternion((qw, qx, qy, qz))
    bpy.context.scene.camera = cam


# The browser's light units are tuned for its look, not physical. These map
# them to Blender's: checked against the live view on the same scene.
SUN_STRENGTH_PER_UNIT = 1.4     # three intensity 2.8 -> 3.9 W/m^2
LAMP_WATTS_PER_UNIT = 14.0      # pendant at 5 -> 70 W
SKY_STRENGTH = 0.35


def add_lights(spec):
    scene = bpy.context.scene
    sun = spec.get("sun")
    sun_dir = None
    if sun:
        sun_dir = to_blender(sun["direction"]).normalized()
        data = bpy.data.lights.new("NooiSun", "SUN")
        data.energy = sun["intensity"] * SUN_STRENGTH_PER_UNIT
        data.color = hex_rgb(sun["color"])
        data.angle = math.radians(1.2)  # a little softer than the real 0.53 deg
        o = bpy.data.objects.new("NooiSun", data)
        scene.collection.objects.link(o)
        o.rotation_mode = "QUATERNION"
        # a sun light shines down its local -Z; point +Z at the sun
        o.rotation_quaternion = sun_dir.to_track_quat("Z", "Y")
    for i, lamp in enumerate(spec.get("lamps", [])):
        data = bpy.data.lights.new(f"NooiLamp{i}", "POINT")
        data.energy = lamp["intensity"] * LAMP_WATTS_PER_UNIT
        data.color = hex_rgb(lamp["color"])
        data.shadow_soft_size = 0.08
        # The lamp sits inside its own fitting (the pendant's shade, the
        # table lamp's drum). In the browser that doesn't matter; in a path
        # tracer the shade swallows all of it. Lamp light casts no shadow —
        # the sun and the sky still give every object its shadows.
        data.use_shadow = False
        o = bpy.data.objects.new(f"NooiLamp{i}", data)
        scene.collection.objects.link(o)
        o.location = to_blender(lamp["position"])
    return sun_dir


def add_world(spec, sun_dir):
    world = bpy.data.worlds.new("NooiWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    if sun_dir is not None:
        # a physical sky with the sun where the sun light is — what you see
        # through the windows matches the light coming in
        sky = nt.nodes.new("ShaderNodeTexSky")
        types = sky.bl_rna.properties["sky_type"].enum_items.keys()
        sky.sky_type = "MULTIPLE_SCATTERING" if "MULTIPLE_SCATTERING" in types else (
            "NISHITA" if "NISHITA" in types else types[0])
        if hasattr(sky, "sun_disc"):
            sky.sun_disc = False  # the sun light draws the sun
        if hasattr(sky, "sun_elevation"):
            sky.sun_elevation = math.asin(max(-1.0, min(1.0, sun_dir.z)))
            sky.sun_rotation = math.atan2(sun_dir.y, sun_dir.x) - math.pi / 2
        nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = SKY_STRENGTH * max(0.2, spec.get("environment", 0.6) / 0.6)
    else:
        # night: a dim blue sky, the lamps do the work
        bg.inputs["Color"].default_value = (0.012, 0.016, 0.03, 1)
        bg.inputs["Strength"].default_value = 1.0


# ── render settings ────────────────────────────────────────────────────────

def pick_device():
    """GPU if there is one (OptiX, then CUDA, then the others), else CPU."""
    scene = bpy.context.scene
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except KeyError:
        scene.cycles.device = "CPU"
        return "CPU"
    for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
        except Exception:
            continue
        gpus = [d for d in prefs.devices if d.type == kind]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == kind
            scene.cycles.device = "GPU"
            return kind
    scene.cycles.device = "CPU"
    return "CPU"


def configure(spec, width, height, samples, time_limit):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    c = scene.cycles
    c.samples = samples
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.015
    c.use_denoising = True
    if hasattr(c, "denoiser"):
        c.denoiser = "OPENIMAGEDENOISE"
    if hasattr(c, "denoising_use_gpu"):
        c.denoising_use_gpu = scene.cycles.device == "GPU"
    c.max_bounces = 10
    c.diffuse_bounces = 5
    c.glossy_bounces = 4
    c.transmission_bounces = 8
    c.transparent_max_bounces = 8
    c.caustics_reflective = False
    c.caustics_refractive = False
    c.sample_clamp_indirect = 8.0
    if time_limit:
        c.time_limit = time_limit
    r = scene.render
    r.resolution_x = width
    r.resolution_y = height
    r.resolution_percentage = 100
    r.film_transparent = False
    vs = scene.view_settings
    vs.view_transform = "AgX"
    try:
        vs.look = "AgX - Base Contrast"
    except TypeError:
        pass


def save(path, quality=92):
    s = bpy.context.scene.render.image_settings
    if path.lower().endswith((".jpg", ".jpeg")):
        s.file_format = "JPEG"
        s.quality = quality
    else:
        s.file_format = "PNG"
    s.color_mode = "RGB"
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


# Where the average display brightness of a well-exposed interior sits.
TARGET_MEAN = 0.6


def mean_brightness(path):
    img = bpy.data.images.load(path)
    px = img.pixels[:]
    n = len(px) // 4
    total = 0.0
    # an 8-bit PNG comes back as its stored (display) values
    for i in range(0, len(px), 4):
        total += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
    bpy.data.images.remove(img)
    return total / max(1, n)


def auto_expose(out_dir, width, height):
    """Two quick low-res passes to settle the exposure."""
    scene = bpy.context.scene
    keep = (scene.cycles.samples, scene.render.resolution_x, scene.render.resolution_y, scene.cycles.time_limit)
    aspect = width / height
    scene.render.resolution_x = 240 if aspect >= 1 else int(240 * aspect)
    scene.render.resolution_y = int(240 / aspect) if aspect >= 1 else 240
    scene.cycles.samples = 24
    scene.cycles.time_limit = 0
    probe = os.path.join(out_dir, "exposure-probe.png")
    ev = 0.0
    for _ in range(2):
        scene.view_settings.exposure = ev
        save(probe)
        m = mean_brightness(probe)
        log(f"probe at {ev:+.2f} EV: mean {m:.3f}")
        if m <= 1e-4:
            ev += 3
            continue
        # AgX is close to log in the mid-tones: about 1 stop per 0.1 of mean
        step = max(-3.0, min(3.0, (TARGET_MEAN - m) / 0.1))
        ev = max(-4.0, min(5.0, ev + step))
        if abs(TARGET_MEAN - m) < 0.03:
            break
    scene.cycles.samples, scene.render.resolution_x, scene.render.resolution_y, scene.cycles.time_limit = keep
    scene.view_settings.exposure = ev
    try:
        os.remove(probe)
    except OSError:
        pass
    return ev


def main():
    args = argv_after_dashes()
    if len(args) < 3:
        raise SystemExit("usage: render_scene.py -- scene.glb spec.json out.jpg [stats.json]")
    glb, spec_path, out = (os.path.abspath(a) for a in args[:3])
    stats_path = args[3] if len(args) > 3 else None
    with open(spec_path) as f:
        spec = json.load(f)

    width = int(max(64, min(7680, spec.get("width", 1920))))
    height = int(max(64, min(7680, spec.get("height", 1080))))
    samples = int(max(8, min(4096, spec.get("samples", 256))))
    time_limit = float(spec.get("timeLimitS", 0) or 0)

    t0 = time.time()
    reset()
    import_scene(glb)
    fix_materials()
    add_camera(spec)
    sun_dir = add_lights(spec)
    add_world(spec, sun_dir)
    device = pick_device()
    configure(spec, width, height, samples, time_limit)
    log(f"device {device}; {width}x{height} @ {samples} spp; import {time.time() - t0:.1f}s")

    t1 = time.time()
    ev = auto_expose(os.path.dirname(os.path.abspath(out)) or ".", width, height)
    log(f"exposure {ev:+.2f} EV ({time.time() - t1:.1f}s)")

    t2 = time.time()
    save(out)
    log(f"rendered in {time.time() - t2:.1f}s -> {out}")

    if stats_path:
        with open(stats_path, "w") as f:
            json.dump({
                "device": device, "width": width, "height": height, "samples": samples,
                "exposure": round(ev, 2), "seconds": round(time.time() - t0, 1),
            }, f)


if __name__ == "__main__":
    main()
