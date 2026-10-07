# IPTV Hub container. No npm install step: the app uses Node built-ins only.
# Node 22.16 or newer is required (node:sqlite with FTS5). Debian trixie brings
# ffmpeg 7.1 for in-browser playback; it lives only in this image, never on the host.
FROM node:22-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB=/data/catalog.db \
    PLAY_DIR=/tmp/iptvhub-play

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# /data holds the database (a named volume); /backups is where backups land.
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node
VOLUME /data

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/player_api.php').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "--no-warnings", "src/index.js"]
