// Building ffmpeg command lines and making sense of what ffmpeg prints back.

import { PROFILES, type ProfileId } from './presets'

export interface Progress {
  frame: number
  fps: number
  kbps: number
  speed: number
  outTimeMs: number
  totalBytes: number
  dropFrames: number
  dupFrames: number
}

/** -progress emits key=value lines; a block ends with progress=continue|end */
export class ProgressParser {
  private cur: Record<string, string> = {}
  private buf = ''
  constructor(private onBlock: (p: Progress, ended: boolean) => void) {}

  push(chunk: string) {
    this.buf += chunk
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    for (const line of lines) {
      const i = line.indexOf('=')
      if (i <= 0) continue
      const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim()
      if (k === 'progress') {
        this.onBlock(toProgress(this.cur), v === 'end')
        this.cur = {}
      } else this.cur[k] = v
    }
  }
}

const num = (s: string | undefined) => {
  const n = parseFloat(s ?? '')
  return Number.isFinite(n) ? n : 0
}

export function toProgress(r: Record<string, string>): Progress {
  return {
    frame: num(r.frame),
    fps: num(r.fps),
    kbps: num(r.bitrate?.replace('kbits/s', '')),
    speed: num(r.speed?.replace('x', '')),
    outTimeMs: Math.round(num(r.out_time_us ?? r.out_time_ms) / 1000),
    totalBytes: num(r.total_size),
    dropFrames: num(r.drop_frames),
    dupFrames: num(r.dup_frames),
  }
}

export type Verdict =
  | { kind: 'fatal'; reason: string } // retrying won't help (bad key, banned, wrong URL)
  | { kind: 'source_gone'; reason: string } // input ended: wait for the source to come back
  | { kind: 'retry'; reason: string }

const FATAL: [RegExp, string][] = [
  [/\b(401|403)\b|Unauthorized|Forbidden/i, 'The destination refused the stream (check the stream key)'],
  [/NetStream\.Publish\.(BadName|Rejected)|Connect\.Rejected|Invalid stream ?key/i, 'The destination rejected the stream key'],
  [/Protocol not found|Unknown protocol|rtmps.*not supported|https protocol not found/i, 'This ffmpeg can’t talk to that kind of server'],
  [/No such file or directory/i, 'The input file doesn’t exist'],
  [/Name or service not known|nodename nor servname|Failed to resolve hostname/i, 'The server’s host name doesn’t resolve'],
]

const SOURCE_GONE = /(\b404\b|Not Found|no one is publishing|stream not found|End of file|Input\/output error)/i

/** decides what to do after ffmpeg exits, from its exit code and the last lines it printed */
export function classifyExit(code: number | null, tail: string[], role: 'push' | 'pull'): Verdict {
  const text = tail.join('\n')
  // pulling: a 401/403 means the signed source link expired (YouTube, ~6 h) — the next run fetches a fresh one
  if (role === 'pull' && /\b(401|403)\b|Unauthorized|Forbidden/i.test(text)) return { kind: 'retry', reason: 'The source link expired — getting a fresh one' }
  for (const [re, reason] of FATAL) if (re.test(text)) return { kind: 'fatal', reason }
  if (role === 'push' && SOURCE_GONE.test(text) && /mediamtx|Input|input/.test(text)) return { kind: 'source_gone', reason: 'The source stopped' }
  if (/Broken pipe/i.test(text)) return { kind: 'retry', reason: 'The destination closed the connection' }
  if (/Connection refused/i.test(text)) return { kind: 'retry', reason: 'The server refused the connection' }
  if (/timed out|Connection timed out|rw_timeout/i.test(text)) return { kind: 'retry', reason: 'The connection timed out' }
  return { kind: 'retry', reason: code === 0 ? 'ffmpeg finished' : `ffmpeg exited (${code ?? 'killed'})` }
}

/** exponential backoff with jitter: 1 s, 2 s, 4 s … capped */
export function backoffMs(attempt: number, capMs = 60_000, rand = Math.random): number {
  const base = Math.min(capMs, 1000 * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.8 + rand() * 0.4))
}

const common = ['-hide_banner', '-nostdin', '-loglevel', 'level+warning', '-progress', 'pipe:1', '-stats_period', '1']

/** relay one source (already in MediaMTX) to one destination */
export function pushArgs(input: string, output: string, profile: ProfileId): string[] {
  const p = PROFILES[profile]
  const codec = p.video
    ? [
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high',
        '-b:v', `${p.video.kbps}k`, '-maxrate', `${p.video.kbps}k`, '-bufsize', `${p.video.kbps * 2}k`,
        '-vf', `scale=w=${p.video.width}:h=${p.video.height}:force_original_aspect_ratio=decrease,pad=${p.video.width}:${p.video.height}:(ow-iw)/2:(oh-ih)/2,fps=${p.video.fps}`,
        // keyframe every 2 s: what YouTube and Facebook ask for
        '-g', String(p.video.fps * 2), '-keyint_min', String(p.video.fps * 2), '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', `${p.audioKbps}k`, '-ar', '48000', '-ac', '2',
      ]
    : ['-c', 'copy']
  const out = output.startsWith('srt://') ? ['-f', 'mpegts', output] : ['-f', 'flv', '-flvflags', 'no_duration_filesize', output]
  return [...common, '-rw_timeout', '15000000', '-i', input, '-map', '0:v?', '-map', '0:a?', ...codec, ...out]
}

/** bring an outside stream (HLS from YouTube, another RTMP/SRT server, a file URL) into MediaMTX */
export function pullArgs(input: string | string[], output: string, opts: { realtime?: boolean } = {}): string[] {
  const inputs = Array.isArray(input) ? input : [input]
  const inOpts = (u: string) => [
    ...(/^https?:/i.test(u) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-user_agent', 'Mozilla/5.0'] : []),
    ...(opts.realtime ? ['-re'] : []),
    '-rw_timeout', '15000000',
  ]
  // split video + audio (two inputs): video from the first, audio from the second
  const maps = inputs.length > 1 ? ['-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v?', '-map', '0:a?']
  return [...common, ...inputs.flatMap(u => [...inOpts(u), '-i', u]), ...maps, '-c', 'copy', '-f', 'flv', output]
}
