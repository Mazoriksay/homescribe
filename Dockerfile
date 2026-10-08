# syntax=docker/dockerfile:1

# deno is the JavaScript runtime yt-dlp recommends for YouTube (it sandboxes the code).
ARG DENO_VERSION=2.9.7
ARG TARGETARCH
FROM ghcr.io/denoland/deno:bin-${DENO_VERSION} AS deno

# yt-dlp's standalone build (bundles Python), one stage per architecture.
FROM scratch AS ytdlp-amd64
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /yt-dlp
FROM scratch AS ytdlp-arm64
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64 /yt-dlp
FROM ytdlp-${TARGETARCH} AS ytdlp

# ---- build the web UI ------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build

# ---- runtime: Node 24 + ffmpeg + yt-dlp + deno, server dependencies only ----
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno
# Owned by the app user so that `yt-dlp -U` (YTDLP_AUTO_UPDATE) can replace it.
COPY --from=ytdlp --chown=node:node /yt-dlp /opt/yt-dlp/yt-dlp
RUN chown node:node /opt/yt-dlp
ENV PATH=/opt/yt-dlp:$PATH
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/server --workspace packages/shared \
  && npm cache clean --force
COPY packages/shared/src packages/shared/src
COPY apps/server/src apps/server/src
COPY apps/extension apps/extension
COPY --from=build /app/apps/web/dist apps/web/dist

# Set by the image workflow from the release tag; shown in the browser extension.
ARG HOMESCRIBE_VERSION=0.0.0
ENV HOMESCRIBE_VERSION=$HOMESCRIBE_VERSION
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

# Runs inside the container, so it comes from 127.0.0.1 (always allowed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+(process.env.BASE_PATH||'')+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# One process (no tsx CLI wrapper), so SIGTERM reaches the server directly.
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
