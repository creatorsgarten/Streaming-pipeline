// The orchestrator: sources, destinations, their workers, and what MediaMTX says is live.

import type { Database } from 'bun:sqlite'
import { safeEqual, randomToken, type Vault } from './crypto'
import { newId, slugify, type DestRow, type EventRow, type SourceKind, type SourceRow } from './db'
import { pullArgs, pushArgs } from './ffmpeg'
import { hasAudio, hasVideo, type MediaMtx, type PathInfo } from './mediamtx'
import { isPlatform, isProfile, joinTarget, PLATFORMS, targetProblem, type Platform, type ProfileId } from './presets'
import { ffmpegLevel, LogBuffer, mediamtxLevel } from './logbuf'
import { Redactor } from './redact'
import { StopRun, Worker, type WorkerSnapshot } from './worker'
import { isYoutubeUrl, resolveYoutube } from './youtube'

export interface HubDeps {
  db: Database
  vault: Vault
  mtx: MediaMtx
  internalToken: string
  rtmpBase: string
  ffmpeg: string
  ytdlp: string
  publicRtmp: string
  publicSrt: string
  /** for tests */
  workerSpawn?: ConstructorParameters<typeof Worker>[0]['spawn']
  resolve?: typeof resolveYoutube
}

export interface SourceLive {
  ready: boolean
  since: number | null
  tracks: string[]
  video: boolean
  audio: boolean
  kbps: number
  readers: number
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

const OFFLINE: SourceLive = { ready: false, since: null, tracks: [], video: false, audio: false, kbps: 0, readers: 0 }

export class Hub {
  readonly redactor = new Redactor()
  readonly logs = new LogBuffer()
  private dests = new Map<string, Worker>()
  private pullers = new Map<string, Worker>()
  private live = new Map<string, SourceLive>()
  /** byte counter samples per source, ~5 s, so bursty inputs (HLS segments) don't flicker to 0 */
  private samples = new Map<string, { bytes: number; at: number }[]>()
  private warnedAudioOnly = new Set<string>()
  private listeners = new Set<() => void>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private mtxDown = false
  private changeQueued = false
  private pullInfo = new Map<string, { title: string | null; expiresAt: number | null }>()
  /** YouTube sources we've seen live: when they stop being live, the event is over */
  private pullWasLive = new Set<string>()

  constructor(private d: HubDeps) {
    this.redactor.add(d.internalToken)
  }

  // ---------- lifecycle ----------

  async boot() {
    for (const s of this.sources()) {
      if (s.publish_key) this.redactor.add(await this.d.vault.open(s.publish_key, s.id))
      if (s.kind !== 'ingest') this.ensurePuller(s)
    }
    for (const r of this.destRows()) {
      if (r.stream_key) this.redactor.add(await this.d.vault.open(r.stream_key, r.id))
      this.ensureDest(r)
    }
    for (const s of this.sources()) if (s.kind !== 'ingest' && s.pull_enabled) this.pullers.get(s.id)?.start()
    await this.poll()
    this.pollTimer = setInterval(() => void this.poll(), 1000)
  }

  async shutdown() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    await Promise.all([...this.dests.values(), ...this.pullers.values()].map(w => w.stop('Hub shutting down')))
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed() {
    // coalesce bursts (progress lines from many workers) into one notification per tick
    if (this.changeQueued) return
    this.changeQueued = true
    queueMicrotask(() => {
      this.changeQueued = false
      for (const fn of this.listeners) try { fn() } catch {}
    })
  }

  // ---------- MediaMTX state ----------

  async poll() {
    let paths: PathInfo[]
    try {
      paths = await this.d.mtx.paths()
      if (this.mtxDown) { this.mtxDown = false; this.log('info', null, null, 'Media server is reachable again') }
    } catch (e: any) {
      if (!this.mtxDown) { this.mtxDown = true; this.log('error', null, null, `Media server unreachable: ${e?.message ?? e}`) }
      paths = []
    }
    const byName = new Map(paths.map(p => [p.name, p]))
    const now = Date.now()
    for (const s of this.sources()) {
      const p = byName.get(pathOf(s.slug))
      const prev = this.live.get(s.id) ?? OFFLINE
      let next: SourceLive = OFFLINE
      if (p?.ready) {
        const win = (this.samples.get(s.id) ?? []).filter(x => now - x.at <= 5000 && x.bytes <= p.bytesReceived)
        win.push({ bytes: p.bytesReceived, at: now })
        this.samples.set(s.id, win)
        const first = win[0]!
        const kbps = now > first.at ? ((p.bytesReceived - first.bytes) * 8) / (now - first.at) : prev.kbps
        next = {
          ready: true,
          since: p.readyTime ? Date.parse(p.readyTime) : prev.since ?? now,
          tracks: p.tracks,
          video: hasVideo(p.tracks),
          audio: hasAudio(p.tracks),
          kbps: Math.round(kbps),
          readers: p.readers,
        }
      } else this.samples.delete(s.id)
      this.live.set(s.id, next)
      if (next.ready && !prev.ready) this.sourceUp(s, next)
      else if (!next.ready && prev.ready) this.sourceDown(s)
      if (next.ready && !next.video && next.tracks.length && !this.warnedAudioOnly.has(s.id)) {
        this.warnedAudioOnly.add(s.id)
        this.log('warn', s.id, null, 'The source has no video track (audio only). YouTube and Facebook drop streams without video — send video too, e.g. a still image.')
      }
    }
    this.changed()
  }

  private sourceUp(s: SourceRow, l: SourceLive) {
    this.warnedAudioOnly.delete(s.id)
    this.log('info', s.id, null, `Source is live (${l.tracks.join(', ') || 'no tracks yet'})`)
    for (const r of this.destRows(s.id)) {
      const w = this.dests.get(r.id)
      if (!w) continue
      if (r.enabled && r.auto_start && !w.wanted) w.start()
      else w.poke()
    }
  }

  private sourceDown(s: SourceRow) {
    this.log('info', s.id, null, 'Source went offline')
    // destinations notice by themselves (their input ends) and go to "waiting"
  }

  sourceLive(id: string): SourceLive { return this.live.get(id) ?? OFFLINE }

  // ---------- workers ----------

  private ensureDest(r: DestRow) {
    if (this.dests.has(r.id)) return
    const w = new Worker({
      id: r.id,
      role: 'push',
      bin: this.d.ffmpeg,
      redactor: this.redactor,
      spawn: this.d.workerSpawn,
      blocker: () => {
        const cur = this.destRow(r.id)
        if (!cur) return 'Deleted'
        return this.sourceLive(cur.source_id).ready ? null : 'Waiting for the source to go live'
      },
      plan: async () => {
        const cur = this.destRow(r.id)
        if (!cur) throw new Error('Destination was deleted')
        const src = this.source(cur.source_id)
        if (!src) throw new Error('Source was deleted')
        const key = cur.stream_key ? await this.d.vault.open(cur.stream_key, cur.id) : ''
        const output = joinTarget(cur.server, key)
        return { args: pushArgs(this.internalUrl(src.slug), output, cur.profile), secrets: [key, output] }
      },
      log: (level, msg) => this.log(level, r.source_id, r.id, msg),
      onLine: line => this.logs.push({ level: ffmpegLevel(line), origin: this.destRow(r.id)?.name ?? r.name, sourceId: r.source_id, text: line }),
      onChange: () => this.changed(),
    })
    this.dests.set(r.id, w)
  }

  private ensurePuller(s: SourceRow) {
    if (this.pullers.has(s.id)) return
    const w = new Worker({
      id: s.id,
      role: 'pull',
      bin: this.d.ffmpeg,
      redactor: this.redactor,
      spawn: this.d.workerSpawn,
      blocker: () => null,
      plan: async () => {
        const cur = this.source(s.id)
        if (!cur?.pull_url) throw new Error('No source URL')
        let input: string | string[] = cur.pull_url
        let realtime = !!cur.pull_realtime
        const secrets: string[] = []
        if (cur.kind === 'youtube') {
          const r = await (this.d.resolve ?? resolveYoutube)(cur.pull_url, { bin: this.d.ytdlp })
          this.pullInfo.set(s.id, { title: r.title, expiresAt: r.expiresAt })
          if (r.live) this.pullWasLive.add(s.id)
          else if (this.pullWasLive.has(s.id)) {
            // the live ended: never start replaying the whole recording to the destinations
            this.pullWasLive.delete(s.id)
            this.d.db.query('UPDATE sources SET pull_enabled = 0 WHERE id = ?').run(s.id)
            throw new StopRun('The YouTube live has ended — stopped fetching')
          } else this.log('warn', s.id, null, 'That YouTube video isn’t live right now — relaying the recording instead')
          input = r.urls
          realtime = !r.live
          secrets.push(...r.urls)
        }
        return { args: pullArgs(input, this.internalUrl(cur.slug), { realtime }), secrets }
      },
      log: (level, msg) => this.log(level, s.id, null, msg),
      onLine: line => this.logs.push({ level: ffmpegLevel(line), origin: `pull:${this.source(s.id)?.slug ?? s.slug}`, sourceId: s.id, text: line }),
      onChange: () => this.changed(),
    })
    this.pullers.set(s.id, w)
  }

  /** how the hub itself reads from / publishes to MediaMTX */
  internalUrl(slug: string) {
    return `${this.d.rtmpBase}/${pathOf(slug)}?user=hub&pass=${encodeURIComponent(this.d.internalToken)}`
  }

  // ---------- MediaMTX auth hook ----------

  async authorize(req: { user?: string; password?: string; action?: string; path?: string; query?: string; protocol?: string }): Promise<boolean> {
    const action = req.action ?? ''
    if (req.user === 'hub' && req.password && safeEqual(req.password, this.d.internalToken)) return true
    if (action !== 'publish') return false
    const slug = (req.path ?? '').replace(/^live\//, '')
    if (pathOf(slug) !== req.path) return false
    const s = this.sources().find(x => x.slug === slug)
    if (!s || s.kind !== 'ingest' || !s.publish_key) return false
    const given = new URLSearchParams(req.query ?? '').get('key') ?? req.password ?? ''
    if (!given) return false
    return safeEqual(given, await this.d.vault.open(s.publish_key, s.id))
  }

  // ---------- sources ----------

  sources(): SourceRow[] {
    return this.d.db.query<SourceRow, []>('SELECT * FROM sources ORDER BY created_at').all()
  }
  source(id: string): SourceRow | null {
    return this.d.db.query<SourceRow, [string]>('SELECT * FROM sources WHERE id = ?').get(id)
  }

  async createSource(input: { name: string; kind: SourceKind; url?: string; realtime?: boolean }) {
    const name = input.name.trim().slice(0, 80)
    if (!name) throw new HttpError(400, 'Give the source a name')
    if (!['ingest', 'youtube', 'url'].includes(input.kind)) throw new HttpError(400, 'Unknown source type')
    let url: string | null = null
    if (input.kind !== 'ingest') {
      url = (input.url ?? '').trim()
      const problem = pullUrlProblem(input.kind, url)
      if (problem) throw new HttpError(400, problem)
    }
    const id = newId('src')
    let slug = slugify(name)
    if (slug.length < 3) slug = `${slug}src`
    const taken = new Set(this.sources().map(s => s.slug))
    for (let i = 2; taken.has(slug); i++) slug = `${slugify(name).slice(0, 30)}${i}`
    let sealed: string | null = null
    if (input.kind === 'ingest') {
      const key = randomToken(18)
      sealed = await this.d.vault.seal(key, id)
      this.redactor.add(key)
    }
    this.d.db.query(
      `INSERT INTO sources (id, name, slug, kind, publish_key, pull_url, pull_realtime, pull_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(id, name, slug, input.kind, sealed, url, input.realtime ? 1 : 0, Date.now())
    const s = this.source(id)!
    if (s.kind !== 'ingest') this.ensurePuller(s)
    this.log('info', id, null, `Source “${name}” created`)
    this.changed()
    return s
  }

  async updateSource(id: string, patch: { name?: string; url?: string; realtime?: boolean }) {
    const s = this.mustSource(id)
    const name = patch.name !== undefined ? patch.name.trim().slice(0, 80) : s.name
    if (!name) throw new HttpError(400, 'Give the source a name')
    let url = s.pull_url
    if (patch.url !== undefined && s.kind !== 'ingest') {
      url = patch.url.trim()
      const problem = pullUrlProblem(s.kind, url)
      if (problem) throw new HttpError(400, problem)
    }
    const realtime = patch.realtime !== undefined ? (patch.realtime ? 1 : 0) : s.pull_realtime
    this.d.db.query('UPDATE sources SET name = ?, pull_url = ?, pull_realtime = ? WHERE id = ?').run(name, url, realtime, id)
    if (url !== s.pull_url || realtime !== s.pull_realtime) await this.pullers.get(id)?.restart()
    this.changed()
  }

  async rotateKey(id: string) {
    const s = this.mustSource(id)
    if (s.kind !== 'ingest') throw new HttpError(400, 'Only push sources have a key')
    const key = randomToken(18)
    this.d.db.query('UPDATE sources SET publish_key = ? WHERE id = ?').run(await this.d.vault.seal(key, id), id)
    this.redactor.add(key)
    await this.d.mtx.kickPublisher(pathOf(s.slug)).catch(() => {})
    this.log('warn', id, null, 'Publish key changed — whoever was streaming with the old key was disconnected')
    this.changed()
  }

  async revealKey(id: string): Promise<string> {
    const s = this.mustSource(id)
    if (!s.publish_key) throw new HttpError(400, 'Only push sources have a key')
    return this.d.vault.open(s.publish_key, id)
  }

  async deleteSource(id: string) {
    const s = this.mustSource(id)
    for (const r of this.destRows(id)) await this.deleteDest(r.id, true)
    await this.pullers.get(id)?.stop('Deleted')
    this.pullers.delete(id)
    if (s.kind === 'ingest') await this.d.mtx.kickPublisher(pathOf(s.slug)).catch(() => {})
    this.d.db.query('DELETE FROM sources WHERE id = ?').run(id)
    this.live.delete(id)
    this.log('warn', null, null, `Source “${s.name}” deleted`)
    this.changed()
  }

  async setPull(id: string, on: boolean) {
    const s = this.mustSource(id)
    if (s.kind === 'ingest') throw new HttpError(400, 'Push sources start when you start streaming to them')
    this.d.db.query('UPDATE sources SET pull_enabled = ? WHERE id = ?').run(on ? 1 : 0, id)
    if (on) this.pullWasLive.delete(id)
    const w = this.pullers.get(id)!
    if (on) w.start()
    else await w.stop('Stopped')
    this.log('info', id, null, on ? 'Pull started' : 'Pull stopped')
  }

  private mustSource(id: string) {
    const s = this.source(id)
    if (!s) throw new HttpError(404, 'No such source')
    return s
  }

  // ---------- destinations ----------

  destRows(sourceId?: string): DestRow[] {
    return sourceId
      ? this.d.db.query<DestRow, [string]>('SELECT * FROM destinations WHERE source_id = ? ORDER BY created_at').all(sourceId)
      : this.d.db.query<DestRow, []>('SELECT * FROM destinations ORDER BY created_at').all()
  }
  destRow(id: string): DestRow | null {
    return this.d.db.query<DestRow, [string]>('SELECT * FROM destinations WHERE id = ?').get(id)
  }

  async createDest(input: { sourceId: string; name?: string; platform: string; server?: string; key?: string; profile?: string; autoStart?: boolean }) {
    this.mustSource(input.sourceId)
    if (!isPlatform(input.platform)) throw new HttpError(400, 'Unknown platform')
    const platform: Platform = input.platform
    const server = (input.server?.trim() || PLATFORMS[platform].server).replace(/\/+$/, '')
    const problem = targetProblem(server)
    if (problem) throw new HttpError(400, problem)
    const profile = input.profile ?? 'copy'
    if (!isProfile(profile)) throw new HttpError(400, 'Unknown quality profile')
    const key = (input.key ?? '').trim()
    if (!key && platform !== 'custom') throw new HttpError(400, 'Paste the stream key')
    if (/\s/.test(key)) throw new HttpError(400, 'A stream key has no spaces')
    const id = newId('dst')
    const name = (input.name?.trim() || PLATFORMS[platform].label).slice(0, 80)
    const sealed = key ? await this.d.vault.seal(key, id) : null
    this.redactor.add(key)
    this.d.db.query(
      `INSERT INTO destinations (id, source_id, name, platform, server, stream_key, profile, enabled, auto_start, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, input.sourceId, name, platform, server, sealed, profile, input.autoStart === false ? 0 : 1, Date.now())
    const r = this.destRow(id)!
    this.ensureDest(r)
    this.log('info', r.source_id, id, `Destination “${name}” added`)
    if (r.auto_start && this.sourceLive(r.source_id).ready) this.dests.get(id)!.start()
    this.changed()
    return r
  }

  async updateDest(id: string, patch: { name?: string; server?: string; key?: string; profile?: string; autoStart?: boolean; enabled?: boolean }) {
    const r = this.mustDest(id)
    const server = patch.server !== undefined ? patch.server.trim().replace(/\/+$/, '') : r.server
    const problem = targetProblem(server)
    if (problem) throw new HttpError(400, problem)
    const profile = patch.profile ?? r.profile
    if (!isProfile(profile)) throw new HttpError(400, 'Unknown quality profile')
    let sealed = r.stream_key
    if (patch.key !== undefined && patch.key.trim()) {
      const key = patch.key.trim()
      if (/\s/.test(key)) throw new HttpError(400, 'A stream key has no spaces')
      sealed = await this.d.vault.seal(key, id)
      this.redactor.add(key)
    }
    const name = patch.name !== undefined ? patch.name.trim().slice(0, 80) || r.name : r.name
    const autoStart = patch.autoStart !== undefined ? (patch.autoStart ? 1 : 0) : r.auto_start
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : r.enabled
    this.d.db.query('UPDATE destinations SET name = ?, server = ?, stream_key = ?, profile = ?, auto_start = ?, enabled = ? WHERE id = ?')
      .run(name, server, sealed, profile, autoStart, enabled, id)
    const w = this.dests.get(id)!
    const output = server !== r.server || sealed !== r.stream_key || profile !== r.profile
    if (!enabled && w.wanted) await w.stop('Disabled')
    else if (output && w.wanted) await w.restart()
    this.log('info', r.source_id, id, 'Destination updated')
    this.changed()
  }

  async startDest(id: string) {
    const r = this.mustDest(id)
    if (!r.enabled) this.d.db.query('UPDATE destinations SET enabled = 1 WHERE id = ?').run(id)
    this.dests.get(id)!.start()
    this.log('info', r.source_id, id, 'Started')
  }

  async stopDest(id: string) {
    const r = this.mustDest(id)
    await this.dests.get(id)!.stop('Stopped')
    this.log('info', r.source_id, id, 'Stopped')
  }

  async startAll(sourceId: string) {
    for (const r of this.destRows(sourceId)) if (r.enabled) this.dests.get(r.id)!.start()
    this.log('info', sourceId, null, 'Started every destination')
  }

  async stopAll(sourceId: string) {
    await Promise.all(this.destRows(sourceId).map(r => this.dests.get(r.id)!.stop('Stopped')))
    this.log('info', sourceId, null, 'Stopped every destination')
  }

  async deleteDest(id: string, quiet = false) {
    const r = this.mustDest(id)
    await this.dests.get(id)?.stop('Deleted')
    this.dests.delete(id)
    this.d.db.query('DELETE FROM destinations WHERE id = ?').run(id)
    if (!quiet) this.log('warn', r.source_id, null, `Destination “${r.name}” deleted`)
    this.changed()
  }

  private mustDest(id: string) {
    const r = this.destRow(id)
    if (!r) throw new HttpError(404, 'No such destination')
    return r
  }

  // ---------- event log ----------

  log(level: EventRow['level'], sourceId: string | null, destId: string | null, message: string) {
    const clean = this.redactor.scrub(message).slice(0, 1000)
    this.d.db.query('INSERT INTO events (ts, level, source_id, dest_id, message) VALUES (?, ?, ?, ?, ?)').run(Date.now(), level, sourceId, destId, clean)
    this.d.db.query('DELETE FROM events WHERE id <= (SELECT max(id) - 5000 FROM events)').run()
    const tag = [sourceId, destId].filter(Boolean).join('/')
    console.log(`[${level}]${tag ? ` ${tag}` : ''} ${clean}`)
    const origin = destId ? (this.destRow(destId)?.name ?? 'destination') : sourceId ? (this.source(sourceId)?.slug ?? 'source') : 'hub'
    this.logs.push({ level, origin, sourceId, text: clean })
    this.changed()
  }

  events(limit = 200, sourceId?: string): EventRow[] {
    return sourceId
      ? this.d.db.query<EventRow, [string, number]>('SELECT * FROM events WHERE source_id = ? OR source_id IS NULL ORDER BY id DESC LIMIT ?').all(sourceId, limit)
      : this.d.db.query<EventRow, [number]>('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
  }

  /** a line from the media server's own log; tags it with the source when it names one */
  mediaLog(line: string) {
    const slugs = new Set(this.sources().map(s => s.slug))
    // a path that isn't one of our streams is almost always somebody's key typed in the wrong place: mask it
    const masked = line.replace(/\blive\/([^\s'"?]+)/g, (all, name: string) => (slugs.has(name) ? all : 'live/••••'))
    const m = masked.match(/live\/([a-z0-9]{3,40})\b/)
    const src = m ? this.sources().find(x => x.slug === m[1]) : undefined
    this.logs.push({ level: mediamtxLevel(line), origin: 'media', sourceId: src?.id ?? null, text: this.redactor.scrub(masked) })
  }

  // ---------- what the dashboard sees ----------

  snapshot() {
    return {
      mediaServer: !this.mtxDown,
      ingest: { rtmp: this.d.publicRtmp, srt: this.d.publicSrt },
      sources: this.sources().map(s => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        kind: s.kind,
        pullUrl: s.pull_url,
        pullRealtime: !!s.pull_realtime,
        pullEnabled: !!s.pull_enabled,
        pull: s.kind === 'ingest' ? null : { ...view(this.pullers.get(s.id)?.snapshot()), ...this.pullInfo.get(s.id) },
        live: this.sourceLive(s.id),
        destinations: this.destRows(s.id).map(r => ({
          id: r.id,
          name: r.name,
          platform: r.platform,
          server: r.server,
          keyHint: r.stream_key ? '••••' : null,
          profile: r.profile,
          enabled: !!r.enabled,
          autoStart: !!r.auto_start,
          worker: view(this.dests.get(r.id)?.snapshot()),
        })),
      })),
    }
  }

  /** Prometheus text format */
  metrics(): string {
    const lines: string[] = []
    const g = (name: string, help: string) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`)
    const lbl = (o: Record<string, string>) => `{${Object.entries(o).map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`).join(',')}}`
    g('pipeline_media_server_up', '1 when the MediaMTX API answers')
    lines.push(`pipeline_media_server_up ${this.mtxDown ? 0 : 1}`)
    g('pipeline_source_live', '1 when the source is publishing')
    g('pipeline_source_kbps', 'incoming bitrate')
    for (const s of this.sources()) {
      const l = this.sourceLive(s.id)
      lines.push(`pipeline_source_live${lbl({ source: s.slug })} ${l.ready ? 1 : 0}`, `pipeline_source_kbps${lbl({ source: s.slug })} ${l.kbps}`)
    }
    g('pipeline_destination_up', '1 when the destination is live')
    g('pipeline_destination_kbps', 'outgoing bitrate')
    g('pipeline_destination_restarts', 'restarts since the hub started')
    g('pipeline_destination_dropped_frames', 'frames dropped by the encoder')
    for (const s of this.sources()) for (const r of this.destRows(s.id)) {
      const w = this.dests.get(r.id)?.snapshot()
      const l = lbl({ source: s.slug, destination: r.name, platform: r.platform })
      lines.push(
        `pipeline_destination_up${l} ${w?.state === 'live' ? 1 : 0}`,
        `pipeline_destination_kbps${l} ${Math.round(w?.progress?.kbps ?? 0)}`,
        `pipeline_destination_restarts${l} ${w?.restarts ?? 0}`,
        `pipeline_destination_dropped_frames${l} ${w?.progress?.dropFrames ?? 0}`,
      )
    }
    return lines.join('\n') + '\n'
  }
}

export const pathOf = (slug: string) => `live/${slug}`

function view(s: WorkerSnapshot | undefined) {
  if (!s) return null
  return {
    state: s.state,
    reason: s.reason,
    since: s.since,
    liveSince: s.liveSince,
    restarts: s.restarts,
    nextRetryAt: s.nextRetryAt,
    kbps: Math.round(s.progress?.kbps ?? 0),
    fps: s.progress?.fps ?? 0,
    speed: s.progress?.speed ?? 0,
    dropFrames: s.progress?.dropFrames ?? 0,
    tail: s.tail.slice(-8),
  }
}

export function pullUrlProblem(kind: SourceKind, url: string): string | null {
  if (!url) return 'Paste the link to pull from'
  let u: URL
  try { u = new URL(url) } catch { return 'That isn’t a link' }
  if (kind === 'youtube') return isYoutubeUrl(url) ? null : 'That isn’t a YouTube link'
  if (!['rtmp:', 'rtmps:', 'srt:', 'http:', 'https:', 'rtsp:'].includes(u.protocol)) return 'Use an rtmp://, srt://, rtsp:// or http(s):// (HLS / FLV) link'
  if (isYoutubeUrl(url)) return 'For YouTube links choose “YouTube Live” as the type'
  return null
}
