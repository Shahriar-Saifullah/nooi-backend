# Nooi photo render worker: Blender (Cycles) behind a RunPod serverless handler.
# Built and published by .github/workflows/render-worker.yml.
FROM ubuntu:22.04

ARG BLENDER_VERSION=5.1.2
ARG BLENDER_SERIES=5.1

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    BLENDER_BIN=/opt/blender/blender \
    # OptiX lives in the driver's graphics libraries; without "graphics"
    # the container gets CUDA only
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils python3 python3-pip \
      libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 \
      libsm6 libice6 libgl1 libegl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://download.blender.org/release/Blender${BLENDER_SERIES}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /opt \
    && mv /opt/blender-${BLENDER_VERSION}-linux-x64 /opt/blender

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt
COPY handler.py render_scene.py ./

CMD ["python3", "-u", "handler.py"]
