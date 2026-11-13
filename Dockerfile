FROM oven/bun:1.2.19-slim

# ffmpeg (with TLS for rtmps://), CA certificates, and a current yt-dlp (YouTube changes often, so it is
# not pinned; rebuild the image to update it). yt-dlp uses bun as its JavaScript runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-pip tini \
 && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" \
 && apt-get purge -y python3-pip && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui

ENV NODE_ENV=production PORT=8080 INTERNAL_PORT=8081 DATA_DIR=/data
RUN mkdir -p /data /media-logs && chown bun:bun /data /media-logs
VOLUME /data
EXPOSE 8080
USER bun
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "src/server.ts"]
HEALTHCHECK --interval=15s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
