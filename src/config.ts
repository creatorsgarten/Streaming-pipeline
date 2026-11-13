// Everything the hub reads from the environment, checked once at boot.

function req(name: string, min = 1): string {
  const v = process.env[name]
  if (!v || v.length < min) throw new Error(`${name} must be set${min > 1 ? ` (at least ${min} characters)` : ''}`)
  return v
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  dataDir: process.env.DATA_DIR ?? './data',
  /** encrypts stream keys at rest and signs sessions */
  secret: req('HUB_SECRET', 32),
  adminPassword: req('ADMIN_PASSWORD', 8),
  /** credentials the hub uses to read from / publish to MediaMTX */
  internalToken: req('INTERNAL_TOKEN', 16),
  mediamtx: {
    api: process.env.MEDIAMTX_API ?? 'http://mediamtx:9997',
    rtmp: process.env.MEDIAMTX_RTMP ?? 'rtmp://mediamtx:1935',
    hls: process.env.MEDIAMTX_HLS ?? 'http://mediamtx:8888',
  },
  /** what the dashboard shows people to put in OBS */
  publicRtmp: process.env.PUBLIC_RTMP ?? 'rtmp://localhost:1936',
  publicSrt: process.env.PUBLIC_SRT ?? 'srt://localhost:8891',
  ffmpeg: process.env.FFMPEG ?? 'ffmpeg',
  ytdlp: process.env.YTDLP ?? 'yt-dlp',
  /** cookies get the Secure flag unless this is explicitly off (plain-http local use) */
  secureCookies: process.env.SECURE_COOKIES !== '0',
}
