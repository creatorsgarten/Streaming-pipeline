# Streaming Pipeline

Send one live stream to many places at once (YouTube, Facebook, Twitch, any RTMP/RTMPS/SRT server) and watch every destination's health from one dashboard.

```
 OBS / ffmpeg ──RTMP/SRT──┐                      ┌── ffmpeg ──► YouTube      (rtmp)
                          ▼                      ├── ffmpeg ──► Facebook     (rtmps)
 YouTube Live link ──► [ MediaMTX ] ──► hub ─────┼── ffmpeg ──► Twitch
 (yt-dlp, re-resolved)    live/<slug>            └── ffmpeg ──► custom RTMP/SRT
                          │
                          └── LL-HLS ──► dashboard preview (through the hub, login required)
```

- **Sources**: push from OBS/ffmpeg (RTMP or SRT, per-source secret key), pull a **YouTube Live link** (the hub finds the HLS stream with yt-dlp, fetches a fresh link when YouTube's ~6 h link expires (a few seconds' gap), and stops by itself when the live ends instead of replaying the recording), or pull any HLS/HTTP-FLV/RTMP/SRT/RTSP URL.
- **Destinations**: one supervised ffmpeg per destination, so one platform failing never takes the others down. Pass-through (`-c copy`) by default, or re-encode to 1080p/720p/480p with 2 s keyframes.
- **Self-healing**: exponential backoff with jitter. A rejected stream key is treated as fatal, so the hub doesn't hammer the platform with retries. Destinations wait while the source is offline and start again on their own when it returns. You can set any destination to go live automatically when its source does.
- **Catches the classic mistake**: an audio-only input (`video:0kB`) is flagged straight away, because YouTube and Facebook silently drop streams without video.
- **Secrets**: stream keys are encrypted at rest (AES-256-GCM, bound to their row), never sent to the browser, and scrubbed from every log line. ffmpeg likes to print full output URLs in its errors; those are scrubbed too.
- **Simple dashboard**: three steps per stream: *Video in* (preview, OBS details to copy), *Send to* (tap a platform, paste the key), *Go live*. Problems are explained in plain words. Technical settings stay under “Advanced”.
- **Logs page**: everything in one live view (hub events, every ffmpeg, the media server's connections and refusals), with filters, search and a download button. Keys are always masked.
- **Ops**: Prometheus `/metrics`, `/healthz`, structured event log in SQLite.

## Quick start

Requires Docker.

```sh
./scripts/setup.sh          # writes .env with random secrets and prints the admin password
docker compose up -d --build
open http://localhost:8790
```

| Port (host) | What |
|---|---|
| `127.0.0.1:8790` | dashboard + API (`HUB_PORT`, `HUB_BIND`) |
| `1936/tcp` | RTMP ingest (`RTMP_PORT`) |
| `8891/udp` | SRT ingest (`SRT_PORT`) |

MediaMTX's API and HLS ports are not published. The hub talks to them inside the compose network, and MediaMTX asks the hub before any publish or read (`authMethod: http`, on an internal-only port).

### Streaming from OBS

Create a **Push** source, then in OBS → Settings → Stream → Custom…

- Server: `rtmp://<host>:1936/live`
- Stream key: copy it from the dashboard (looks like `<slug>?key=<secret>`)

ffmpeg: `ffmpeg … -c:v libx264 -g 60 -pix_fmt yuv420p -c:a aac -f flv "rtmp://<host>:1936/live/<slug>?key=<secret>"`

### Relaying a YouTube Live to Facebook

1. **New source → YouTube Live link**, paste `https://youtube.com/live/…`, then **Start pulling**.
2. **Add destination → Facebook**, paste the stream key from Live Producer. The server is pre-filled (`rtmps://live-api-s.facebook.com:443/rtmp`).

YouTube signs the HLS link for the IP that asked for it. That's why yt-dlp runs in the same container as ffmpeg, and with `--force-ipv4`. Only relay streams you have the rights to.

## Configuration (`.env`)

| Variable | |
|---|---|
| `HUB_SECRET` | ≥ 32 chars. Encrypts stream keys and signs sessions. Changing it makes stored keys unreadable. |
| `ADMIN_PASSWORD` | dashboard password (≥ 8 chars) |
| `INTERNAL_TOKEN` | credentials the hub uses with MediaMTX |
| `SECURE_COOKIES` | `0` for plain-http localhost; leave unset (secure) behind HTTPS |
| `COMPOSE_PROFILES=https`, `DOMAIN` | run Caddy with automatic HTTPS for `DOMAIN` |
| `RTMP_PORT`, `SRT_PORT`, `HUB_PORT`, `HUB_BIND` | host ports (defaults 1936, 8891/udp, 127.0.0.1:8790) |
| `TRUST_PROXY` | `1` behind a reverse proxy (rate limit by `X-Forwarded-For`) |
| `METRICS_TOKEN` | optional Bearer token for `/metrics` (otherwise a signed-in session) |
| `PUBLIC_RTMP`, `PUBLIC_SRT` | addresses shown to people in the dashboard |

## Running it as the team's server (VPS)

One server everyone streams to. You need a small Linux VPS (2 vCPU / 2 GB is plenty for pass-through) with Docker and a domain name.

```sh
# on the server
git clone <this repo> streaming-pipeline && cd streaming-pipeline
./scripts/setup.sh stream.example.com      # writes .env for HTTPS on that domain, prints the admin password
docker compose up -d --build
```

1. Point `stream.example.com` (DNS **A** record) at the server's IP.
2. Open the firewall: **80/tcp, 443/tcp** (dashboard, HTTPS certificate), **1935/tcp** (RTMP from OBS), **8890/udp** (SRT).
3. Open `https://stream.example.com`. Caddy fetches the certificate on first visit.

OBS then uses `rtmp://stream.example.com/live` plus the key from the dashboard.

Sizing: upload bandwidth ≈ incoming bitrate × number of destinations (6 Mbps in → YouTube + Facebook ≈ 12 Mbps out). Pass-through uses almost no CPU. Each destination with a re-encode profile needs about one core at 720p30.

Update: `git pull && docker compose up -d --build` (this also picks up a fresh yt-dlp). Back up the `streaming-pipeline_hub-data` volume (SQLite) together with `.env`, because without `HUB_SECRET` the stored keys can't be read.

## Development

```sh
bun install
bun test              # unit tests: redaction, crypto, ffmpeg args/progress/exit classification, hub, auth
bunx tsc --noEmit -p .
docker compose up -d --build && bun scripts/e2e.ts   # end to end against the real containers
```

`scripts/e2e.ts` publishes a test pattern and relays it through the hub to a second MediaMTX path standing in for a platform. It then checks with ffprobe that H.264 video and AAC audio arrive. It also covers auto-start, waiting and resuming, the audio-only warning, the preview, metrics, rejected keys, and that no key appears in events, state or container logs.

Layout:

```
src/server.ts     HTTP: dashboard, JSON API, SSE, preview proxy, metrics; MediaMTX auth hook (internal port)
src/hub.ts        sources, destinations, workers, MediaMTX polling, event log
src/worker.ts     one supervised ffmpeg: backoff, fatal vs retry, progress, redacted stderr tail
src/ffmpeg.ts     command lines, -progress parser, exit classification
src/youtube.ts    yt-dlp resolution (muxed or split video+audio HLS)
src/redact.ts     key scrubbing (permanent keys + per-run values)
src/logbuf.ts     Logs page buffer, media server log tailing
src/crypto.ts     AES-GCM vault, HMAC sessions
ui/               Preact dashboard (bundled by Bun at boot)
mediamtx.yml      ingest + HLS, auth delegated to the hub
Caddyfile         HTTPS in front of the dashboard (profile `https`)
```
