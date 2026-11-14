"""
Nooi photo render worker — RunPod serverless handler.

One job = one image. The backend (nooi-backend, services/render.service.ts)
sends:

    {
      "job_id":            "<render_jobs.id>",
      "scene_url":         signed GET URL of scene.glb (optionally gzipped),
      "spec":              camera / sun / lamps / size (lib/render/sceneSpec.ts),
      "result_upload_url": signed PUT URL for the finished image,
      "time_limit_s":      hard stop for the render itself
    }

and gets back {"ok": true, "stats": {...}} or a failed job with the error.
Blender runs as a child process so a crash or a hang can't take the worker
down with it.
"""

import gzip
import json
import os
import shutil
import subprocess
import tempfile
import time

import requests
import runpod

BLENDER = os.environ.get("BLENDER_BIN", "/opt/blender/blender")
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "render_scene.py")
MAX_SCENE_BYTES = 400 * 1024 * 1024


def download(url, dest):
    with requests.get(url, stream=True, timeout=(10, 120)) as r:
        r.raise_for_status()
        n = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                n += len(chunk)
                if n > MAX_SCENE_BYTES:
                    raise ValueError("scene is too large")
                f.write(chunk)
    # the browser gzips the GLB before uploading; accept either
    with open(dest, "rb") as f:
        magic = f.read(2)
    if magic == b"\x1f\x8b":
        raw = dest + ".raw"
        with gzip.open(dest, "rb") as src, open(raw, "wb") as out:
            shutil.copyfileobj(src, out)
        os.replace(raw, dest)
    return os.path.getsize(dest)


def upload(url, path, content_type):
    with open(path, "rb") as f:
        r = requests.put(url, data=f, headers={"Content-Type": content_type, "x-upsert": "true"}, timeout=(10, 120))
    if r.status_code >= 300:
        raise RuntimeError(f"upload failed: {r.status_code} {r.text[:200]}")


def handler(job):
    inp = job.get("input") or {}
    for key in ("scene_url", "spec", "result_upload_url"):
        if not inp.get(key):
            raise ValueError(f"missing {key}")
    limit = float(inp.get("time_limit_s") or 270)
    t0 = time.time()
    work = tempfile.mkdtemp(prefix="nooi-render-")
    try:
        scene = os.path.join(work, "scene.glb")
        size = download(inp["scene_url"], scene)
        spec = dict(inp["spec"])
        # Cycles stops sampling at this, leaving time to denoise and upload
        spec["timeLimitS"] = max(20.0, limit - 40.0)
        spec_path = os.path.join(work, "spec.json")
        with open(spec_path, "w") as f:
            json.dump(spec, f)
        out = os.path.join(work, "render.jpg")
        stats_path = os.path.join(work, "stats.json")
        proc = subprocess.run(
            [BLENDER, "-b", "--factory-startup", "-noaudio", "-P", SCRIPT, "--", scene, spec_path, out, stats_path],
            capture_output=True, text=True, timeout=limit,
        )
        if proc.returncode != 0 or not os.path.exists(out):
            tail = (proc.stdout or "")[-1500:] + (proc.stderr or "")[-1500:]
            raise RuntimeError(f"blender failed ({proc.returncode}): {tail}")
        upload(inp["result_upload_url"], out, "image/jpeg")
        stats = {}
        if os.path.exists(stats_path):
            with open(stats_path) as f:
                stats = json.load(f)
        stats.update(scene_bytes=size, image_bytes=os.path.getsize(out), total_s=round(time.time() - t0, 1))
        return {"ok": True, "job_id": inp.get("job_id"), "stats": stats}
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
