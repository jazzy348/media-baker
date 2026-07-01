FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV MEDIA_BAKER_DOCKER=1
ENV PATH="/opt/ffsubsync/bin:${PATH}"
ENV NVIDIA_DRIVER_CAPABILITIES="compute,video,utility"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    i965-va-driver \
    intel-media-va-driver \
    libmfx1 \
    libva2 \
    libva-drm2 \
    libvpl2 \
    mesa-va-drivers \
    python3 \
    python3-venv \
    tini \
    vainfo \
  && python3 -m venv /opt/ffsubsync \
  && /opt/ffsubsync/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/ffsubsync/bin/pip install --no-cache-dir ffsubsync yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /config /cache /fallback /logs /downloads \
  && chown -R node:node /app /config /cache /fallback /logs /downloads /opt/ffsubsync

EXPOSE 5000

VOLUME ["/cache", "/fallback", "/logs", "/downloads"]

ENTRYPOINT ["tini", "--"]
CMD ["node", "src/supervisor.js"]
