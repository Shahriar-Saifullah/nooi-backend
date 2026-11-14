# Nooi photo render worker

Blender (Cycles) behind a RunPod serverless handler. One job = one photo-real
image of a Nooi scene. The backend side is `src/services/render.service.ts`;
the browser side is the frontend's `lib/render/`.

| File | What it does |
|---|---|
| `handler.py` | RunPod entry point: downloads the scene, runs Blender, uploads the image |
| `render_scene.py` | the Blender script: imports the GLB, rebuilds lights, fixes glass, sets exposure, renders |
| `Dockerfile` | Ubuntu + Blender 5.1 + the handler |

Built and pushed to `ghcr.io/<owner>/nooi-render-worker` by
`.github/workflows/render-worker.yml` on every push that touches this folder (or by running the workflow by hand).

## Testing without a GPU

`render_scene.py` falls back to the CPU, and also runs with the `bpy` Python
module instead of the Blender binary:

```bash
python3 -m venv .venv && .venv/bin/pip install bpy==5.1.2
.venv/bin/python render_scene.py -- scene.glb spec.json out.jpg stats.json
```

(Use a small `width`/`height`/`samples` in the spec; a CPU is slow.)

## Setting up RunPod (once)

See `docs/photo-render-setup.md`.
