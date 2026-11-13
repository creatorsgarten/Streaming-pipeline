// One supervised ffmpeg process: start, watch, restart with backoff, give up on fatal errors.
// Every line it prints passes through the redactor before it goes anywhere.

import { backoffMs, classifyExit, ProgressParser, type Progress } from './ffmpeg'
import type { Redactor } from './redact'

export type WorkerState = 'stopped' | 'waiting' | 'starting' | 'live' | 'retrying' | 'failed'

export interface WorkerSnapshot {
  state: WorkerState
  reason: string | null
  since: number
  liveSince: number | null
  restarts: number
  nextRetryAt: number | null
  progress: Progress | null
  tail: string[]
}

export interface Plan {
  args: string[]
  /** values to mask in this run's output (stream keys, signed URLs) */
  secrets: string[]
}

export interface WorkerOptions {
  id: string
  role: 'push' | 'pull'
  bin: string
  redactor: Redactor
  /** builds the command line; may be slow (yt-dlp). Throwing = a retryable failure with that message */
  plan: () => Promise<Plan>
  /** null when it may run, otherwise why it is waiting */
  blocker: () => string | null
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  /** every (redacted) line ffmpeg prints */
  onLine?: (line: string) => void
  onChange: () => void
  spawn?: (bin: string, args: string[]) => Proc
  now?: () => number
  /** a run must stay up this long before the backoff resets */
  stableMs?: number
}

export interface Proc {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number | null>
  kill(signal?: number | NodeJS.Signals): void
}

const TAIL = 30

/** thrown from plan(): don't retry, stop for good with this message */
export class StopRun extends Error {}

export class Worker {
  private desired = false
  private proc: Proc | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private generation = 0
  private s: WorkerSnapshot
  private now: () => number

  constructor(private o: WorkerOptions) {
    this.now = o.now ?? Date.now
    this.s = { state: 'stopped', reason: null, since: this.now(), liveSince: null, restarts: 0, nextRetryAt: null, progress: null, tail: [] }
  }

  get id() { return this.o.id }
  get wanted() { return this.desired }
  snapshot(): WorkerSnapshot { return { ...this.s, tail: [...this.s.tail] } }

  start() {
    this.desired = true
    this.attempt = 0
    if (this.s.state === 'failed' || this.s.state === 'stopped' || this.s.state === 'waiting') this.kick()
  }

  async stop(reason = 'Stopped') {
    this.desired = false
    this.clearTimer()
    this.generation++
    const p = this.proc
    this.proc = null
    this.set('stopped', reason)
    if (p) await this.terminate(p)
  }

  /** something changed outside (source came online, config edited): try again now if we should be running */
  poke() {
    if (!this.desired) return
    if (this.s.state === 'waiting' || this.s.state === 'retrying') {
      this.clearTimer()
      this.kick()
    }
  }

  /** restart with a fresh plan (config edited while live) */
  async restart() {
    if (!this.desired) return
    const p = this.proc
    this.generation++
    this.proc = null
    this.clearTimer()
    if (p) await this.terminate(p)
    this.attempt = 0
    this.kick()
  }

  private kick() {
    if (!this.desired || this.proc) return
    const block = this.o.blocker()
    if (block) { this.set('waiting', block); return }
    void this.run(++this.generation)
  }

  private async run(gen: number) {
    this.set('starting', null)
    this.s.progress = null
    let plan: Plan
    try {
      plan = await this.o.plan()
    } catch (e: any) {
      if (gen !== this.generation) return
      const msg = this.o.redactor.scrub(String(e?.message ?? e))
      if (e instanceof StopRun) {
        this.desired = false
        this.set('stopped', msg)
        this.o.log('warn', msg)
        return
      }
      this.scheduleRetry(msg)
      return
    }
    if (gen !== this.generation || !this.desired) return
    this.o.redactor.addTemp(...plan.secrets)
    const startedAt = this.now()
    const spawn = this.o.spawn ?? ((bin, args) => Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' }) as unknown as Proc)
    let proc: Proc
    try {
      proc = spawn(this.o.bin, plan.args)
    } catch (e: any) {
      this.o.redactor.removeTemp(...plan.secrets)
      this.set('failed', `Couldn’t start ffmpeg: ${e?.message ?? e}`)
      return
    }
    this.proc = proc
    const tail: string[] = []
    const parser = new ProgressParser(p => {
      if (gen !== this.generation) return
      this.s.progress = p
      // "live" once media has actually flowed for 2 s (a refused connection can still report a few bytes)
      if (this.s.state === 'starting' && p.outTimeMs >= 2000) {
        this.set('live', null)
        this.s.liveSince = this.now()
        this.o.log('info', this.o.role === 'push' ? 'Live' : 'Pulling')
      } else this.o.onChange()
    })
    const pumpOut = pump(proc.stdout, chunk => parser.push(chunk))
    const pumpErr = pumpLines(proc.stderr, line => {
      const clean = this.o.redactor.scrub(line)
      this.o.onLine?.(clean)
      tail.push(clean)
      if (tail.length > TAIL) tail.shift()
      if (gen === this.generation) this.s.tail = [...tail]
    })
    const code = await proc.exited
    await Promise.allSettled([pumpOut, pumpErr])
    // secrets stay registered a moment longer in case a straggling line is logged elsewhere
    setTimeout(() => this.o.redactor.removeTemp(...plan.secrets), 5000)
    if (gen !== this.generation) return // stopped or restarted on purpose
    this.proc = null
    this.s.liveSince = null
    if (this.now() - startedAt > (this.o.stableMs ?? 30_000)) this.attempt = 0
    const v = classifyExit(code, tail.slice(-10), this.o.role)
    const detail = tail.filter(l => !/^\s*$/.test(l)).slice(-1)[0]
    if (v.kind === 'fatal') {
      this.set('failed', v.reason)
      this.o.log('error', `${v.reason}${detail ? ` — ${detail}` : ''}`)
      return
    }
    // the source went away underneath us: wait for it instead of burning retries
    const block = this.o.blocker()
    if (block) {
      this.o.log('info', block)
      this.set('waiting', block)
      return
    }
    this.o.log('warn', `${v.reason}${detail ? ` — ${detail}` : ''}`)
    this.scheduleRetry(v.reason)
  }

  private scheduleRetry(reason: string) {
    if (!this.desired) return
    const wait = backoffMs(this.attempt++)
    this.s.restarts++
    this.s.nextRetryAt = this.now() + wait
    this.set('retrying', reason)
    this.timer = setTimeout(() => { this.timer = null; this.s.nextRetryAt = null; this.kick() }, wait)
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.s.nextRetryAt = null
  }

  private async terminate(p: Proc) {
    try { p.kill('SIGINT') } catch {}
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, 4000)
    await p.exited.catch(() => {})
    clearTimeout(t)
  }

  private set(state: WorkerState, reason: string | null) {
    if (this.s.state !== state || this.s.reason !== reason) {
      this.s.state = state
      this.s.reason = reason
      this.s.since = this.now()
    }
    if (state !== 'live') this.s.liveSince = null
    this.o.onChange()
  }
}

async function pump(stream: ReadableStream<Uint8Array>, on: (chunk: string) => void) {
  const dec = new TextDecoder()
  for await (const c of stream as any as AsyncIterable<Uint8Array>) on(dec.decode(c, { stream: true }))
}

async function pumpLines(stream: ReadableStream<Uint8Array>, on: (line: string) => void) {
  let buf = ''
  await pump(stream, chunk => {
    buf += chunk
    const parts = buf.split(/\r?\n|\r/)
    buf = parts.pop() ?? ''
    for (const l of parts) if (l.trim()) on(l)
  })
  if (buf.trim()) on(buf)
}
