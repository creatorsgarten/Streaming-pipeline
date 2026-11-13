// In-memory ring of recent log lines (hub events, every ffmpeg's output, the media server's log)
// for the dashboard's Logs page. Lines arrive here already redacted.

import { open, stat, truncate } from 'node:fs/promises'

export type Level = 'debug' | 'info' | 'warn' | 'error'

export interface LogLine {
  seq: number
  ts: number
  level: Level
  /** hub · media · <destination name> · pull:<source> */
  origin: string
  sourceId: string | null
  text: string
}

export class LogBuffer {
  private lines: LogLine[] = []
  private seq = 0
  constructor(private max = 4000) {}

  push(l: Omit<LogLine, 'seq' | 'ts'> & { ts?: number }) {
    this.lines.push({ ...l, ts: l.ts ?? Date.now(), seq: ++this.seq })
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max)
  }

  /** lines after `seq` (0 = from the oldest kept), at most `limit` of the newest */
  since(seq: number, limit = 1000): { lines: LogLine[]; last: number } {
    const i = this.lines.findIndex(l => l.seq > seq)
    const out = i < 0 ? [] : this.lines.slice(i)
    return { lines: out.slice(-limit), last: this.seq }
  }
}

/** ffmpeg with -loglevel level+… prefixes "[warning]" / "[error]" etc. */
export function ffmpegLevel(line: string): Level {
  if (/\[(fatal|panic|error)\]/i.test(line)) return 'error'
  if (/\[warning\]/i.test(line)) return 'warn'
  if (/\[(verbose|debug|trace)\]/i.test(line)) return 'debug'
  return 'info'
}

/** MediaMTX: "2026/11/13 20:01:02 INF [RTMP] [conn …] …" */
export function mediamtxLevel(line: string): Level {
  const m = line.match(/\b(DEB|INF|WAR|ERR)\b/)
  return m?.[1] === 'ERR' ? 'error' : m?.[1] === 'WAR' ? 'warn' : m?.[1] === 'DEB' ? 'debug' : 'info'
}

/** follows a growing file (handles truncation by starting over); empties it past maxBytes so it can't fill the disk */
export function tailFile(path: string, onLine: (line: string) => void, everyMs = 1000, maxBytes = 50 * 1024 * 1024): () => void {
  let pos = -1
  let partial = ''
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const st = await stat(path)
      if (pos < 0) pos = Math.max(0, st.size - 64 * 1024) // start near the end
      if (st.size < pos) { pos = 0; partial = '' }
      if (st.size > pos) {
        const fh = await open(path, 'r')
        try {
          const len = Math.min(st.size - pos, 1024 * 1024)
          const buf = Buffer.alloc(len)
          await fh.read(buf, 0, len, pos)
          pos += len
          const parts = (partial + buf.toString('utf8')).split('\n')
          partial = parts.pop() ?? ''
          for (const l of parts) if (l.trim()) onLine(l)
        } finally { await fh.close() }
      }
      // the writer appends (O_APPEND), so emptying the file is safe; recent lines live on in the Logs buffer
      if (pos >= maxBytes) { await truncate(path, 0); pos = 0; partial = '' }
    } catch { /* file not there yet */ } finally { busy = false }
  }
  const t = setInterval(() => void tick(), everyMs)
  void tick()
  return () => clearInterval(t)
}
