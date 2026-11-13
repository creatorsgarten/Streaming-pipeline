import { describe, expect, test } from 'bun:test'
import { Auth, csrfProblem } from '../src/auth'
import { Vault } from '../src/crypto'
import { openDb } from '../src/db'
import { Hub } from '../src/hub'
import type { MediaMtx, PathInfo } from '../src/mediamtx'
import type { Proc } from '../src/worker'

/** a fake ffmpeg: emits progress, then exits with what the test says */
class FakeProc implements Proc {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number | null>
  private outC!: ReadableStreamDefaultController<Uint8Array>
  private errC!: ReadableStreamDefaultController<Uint8Array>
  private done!: (c: number | null) => void
  killed = false
  constructor(public args: string[]) {
    this.stdout = new ReadableStream({ start: c => { this.outC = c } })
    this.stderr = new ReadableStream({ start: c => { this.errC = c } })
    this.exited = new Promise(r => { this.done = r })
  }
  progress(bytes: number) { this.outC.enqueue(new TextEncoder().encode(`frame=10\nbitrate=2500kbits/s\ntotal_size=${bytes}\nout_time_us=3000000\nspeed=1x\nprogress=continue\n`)) }
  exit(code: number, stderr = '') {
    if (stderr) this.errC.enqueue(new TextEncoder().encode(stderr + '\n'))
    this.outC.close(); this.errC.close(); this.done(code)
  }
  kill() { this.killed = true; this.exit(255) }
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

async function setup() {
  const db = openDb(':memory:')
  const vault = await Vault.create('s'.repeat(40))
  const paths = new Map<string, PathInfo>()
  const mtx = { paths: async () => [...paths.values()], kickPublisher: async () => {} } as unknown as MediaMtx
  const procs: FakeProc[] = []
  const logs: string[] = []
  const hub = new Hub({
    db, vault, mtx,
    internalToken: 'internal-token-123456',
    rtmpBase: 'rtmp://mediamtx:1935', ffmpeg: 'ffmpeg', ytdlp: 'yt-dlp',
    publicRtmp: 'rtmp://localhost:1936', publicSrt: 'srt://localhost:8891',
    workerSpawn: (_bin, args) => { const p = new FakeProc(args); procs.push(p); return p },
    resolve: async () => ({ urls: ['https://manifest.googlevideo.com/x/expire/1/index.m3u8'], expiresAt: 1000, title: 'Talk', live: true }),
  })
  const origLog = console.log
  console.log = (m: string) => logs.push(m)
  await hub.boot()
  const goLive = async (slug: string, tracks = ['H264', 'MPEG-4 Audio']) => {
    paths.set(`live/${slug}`, { name: `live/${slug}`, ready: true, readyTime: new Date().toISOString(), tracks, bytesReceived: 1000, bytesSent: 0, readers: 0, sourceType: 'rtmpConn' })
    await hub.poll()
    await tick()
  }
  const goOffline = async (slug: string) => { paths.delete(`live/${slug}`); await hub.poll(); await tick() }
  const done = async () => { console.log = origLog; await hub.shutdown() }
  return { db, hub, procs, logs, goLive, goOffline, done, vault }
}

describe('hub', () => {
  test('ingest auth: right key publishes, wrong key and reads are refused', async () => {
    const h = await setup()
    const s = await h.hub.createSource({ name: 'Main Stage', kind: 'ingest' })
    const key = await h.hub.revealKey(s.id)
    expect(s.slug).toBe('mainstage')
    expect(await h.hub.authorize({ action: 'publish', path: 'live/mainstage', query: `key=${key}` })).toBe(true)
    expect(await h.hub.authorize({ action: 'publish', path: 'live/mainstage', user: 'pub', password: key })).toBe(true) // SRT style
    expect(await h.hub.authorize({ action: 'publish', path: 'live/mainstage', query: 'key=nope' })).toBe(false)
    expect(await h.hub.authorize({ action: 'publish', path: 'live/other', query: `key=${key}` })).toBe(false)
    expect(await h.hub.authorize({ action: 'read', path: 'live/mainstage', query: `key=${key}` })).toBe(false)
    expect(await h.hub.authorize({ action: 'read', path: 'live/mainstage', user: 'hub', password: 'internal-token-123456' })).toBe(true)
    expect(await h.hub.authorize({ action: 'read', path: 'live/mainstage', user: 'hub', password: 'wrong' })).toBe(false)
    await h.hub.rotateKey(s.id)
    expect(await h.hub.authorize({ action: 'publish', path: 'live/mainstage', query: `key=${key}` })).toBe(false)
    await h.done()
  })

  test('stream keys are stored encrypted and never in the snapshot', async () => {
    const h = await setup()
    const s = await h.hub.createSource({ name: 'stage', kind: 'ingest' })
    await h.hub.createDest({ sourceId: s.id, platform: 'facebook', key: 'FB-1111111111111111-0-SECRET' })
    const raw = h.db.query<{ stream_key: string }, []>('SELECT stream_key FROM destinations').get()!
    expect(raw.stream_key).not.toContain('SECRET')
    expect(JSON.stringify(h.hub.snapshot())).not.toContain('SECRET')
    await h.done()
  })

  test('auto start on source live, keys redacted from args in logs, waits when source goes away', async () => {
    const h = await setup()
    const s = await h.hub.createSource({ name: 'stage', kind: 'ingest' })
    const d = await h.hub.createDest({ sourceId: s.id, platform: 'youtube', key: 'yt-key-abcdef' })
    expect(h.procs).toHaveLength(0)
    await h.goLive('stage')
    expect(h.procs).toHaveLength(1)
    const p = h.procs[0]!
    expect(p.args.at(-1)).toBe('rtmp://a.rtmp.youtube.com/live2/yt-key-abcdef')
    expect(p.args).toContain('rtmp://mediamtx:1935/live/stage?user=hub&pass=internal-token-123456')
    p.progress(5000)
    await tick()
    const dest = () => h.hub.snapshot().sources[0]!.destinations[0]!
    expect(dest().worker?.state).toBe('live')
    // source stops → ffmpeg ends → destination waits instead of retrying
    await h.goOffline('stage')
    p.exit(0, 'rtmp://mediamtx:1935/live/stage: End of file')
    await tick(30)
    expect(dest().worker?.state).toBe('waiting')
    // comes back → starts again on its own
    await h.goLive('stage')
    expect(h.procs).toHaveLength(2)
    // nothing secret in the event log, even in lines that aren't URLs, after runs have ended
    h.hub.mediaLog("2026/11/13 INF [RTMP] closed: path 'live/yt-key-abcdef' is not configured")
    const all = JSON.stringify(h.hub.events(500)) + h.logs.join('\n') + JSON.stringify(h.hub.logs.since(0))
    expect(all).not.toContain('yt-key-abcdef')
    expect(all).not.toContain('internal-token-123456')
    await h.hub.stopDest(d.id)
    expect(h.procs[1]!.killed).toBe(true)
    await h.done()
  })

  test('a rejected key is fatal (no retry loop); broken pipe retries', async () => {
    const h = await setup()
    const s = await h.hub.createSource({ name: 'stage', kind: 'ingest' })
    await h.hub.createDest({ sourceId: s.id, platform: 'youtube', key: 'yt-key-abcdef' })
    await h.goLive('stage')
    h.procs[0]!.exit(1, '[rtmp @ 0x1] Server error: NetStream.Publish.BadName rtmp://a.rtmp.youtube.com/live2/yt-key-abcdef')
    await tick(30)
    const w = () => h.hub.snapshot().sources[0]!.destinations[0]!.worker!
    expect(w().state).toBe('failed')
    expect(w().tail.join('\n')).not.toContain('yt-key-abcdef')
    expect(h.procs).toHaveLength(1)

    const d2 = await h.hub.createDest({ sourceId: s.id, platform: 'facebook', key: 'FB-abcdef-123' })
    await tick()
    const fb = h.procs[1]!
    expect(fb.args.at(-1)).toBe('rtmps://live-api-s.facebook.com:443/rtmp/FB-abcdef-123')
    fb.exit(1, 'av_interleaved_write_frame(): Broken pipe')
    await tick(30)
    const w2 = h.hub.snapshot().sources[0]!.destinations.find(x => x.id === d2.id)!.worker!
    expect(w2.state).toBe('retrying')
    expect(w2.reason).toBe('The destination closed the connection')
    await h.done()
  })

  test('media log: unknown paths are masked (a key from before a restart, never registered)', async () => {
    const h = await setup()
    await h.hub.createSource({ name: 'stage', kind: 'ingest' })
    h.hub.mediaLog("2026/11/13 INF [RTMP] [conn 1.2.3.4:5] closed: path 'live/FB-0000000000-0-not-a-real-key' is not configured")
    h.hub.mediaLog("2026/11/13 INF [RTMP] [conn 1.2.3.4:6] is publishing to path 'live/stage', 2 tracks (H264, MPEG-4 Audio)")
    const lines = h.hub.logs.since(0).lines.filter(l => l.origin === 'media')
    expect(lines[0]!.text).toBe("2026/11/13 INF [RTMP] [conn 1.2.3.4:5] closed: path 'live/••••' is not configured")
    expect(lines[1]!.text).toContain("path 'live/stage'")
    expect(lines[1]!.sourceId).not.toBeNull()
    await h.done()
  })

  test('audio-only source gets one clear warning', async () => {
    const h = await setup()
    const s = await h.hub.createSource({ name: 'radio', kind: 'ingest' })
    await h.goLive('radio', ['MPEG-4 Audio'])
    await h.hub.poll()
    const warns = h.hub.events(50).filter(e => e.message.includes('no video track'))
    expect(warns).toHaveLength(1)
    expect(h.hub.snapshot().sources[0]!.live.video).toBe(false)
    void s
    await h.done()
  })

  test('youtube source pulls via the resolved HLS URL into MediaMTX', async () => {
    const h = await setup()
    const s = await h.hub.createSource({ name: 'meetup', kind: 'youtube', url: 'https://youtube.com/live/abcdefghijk' })
    await h.hub.setPull(s.id, true)
    await tick()
    const p = h.procs[0]!
    expect(p.args).toContain('https://manifest.googlevideo.com/x/expire/1/index.m3u8')
    expect(p.args.at(-1)).toBe('rtmp://mediamtx:1935/live/meetup?user=hub&pass=internal-token-123456')
    expect(h.hub.snapshot().sources[0]!.pull?.title).toBe('Talk')
    await expect(h.hub.createSource({ name: 'x', kind: 'youtube', url: 'https://example.com' })).rejects.toThrow('That isn’t a YouTube link')
    await expect(h.hub.createSource({ name: 'x', kind: 'url', url: 'https://youtube.com/live/x' })).rejects.toThrow('YouTube')
    await h.done()
  })

  test('youtube: expired link → fresh link; live ended → stop, never replay the recording', async () => {
    let calls = 0
    const live = [true, true, false]
    const db = openDb(':memory:')
    const vault = await Vault.create('s'.repeat(40))
    const procs: FakeProc[] = []
    const paths = new Map<string, PathInfo>()
    const hub = new Hub({
      db, vault, mtx: { paths: async () => [...paths.values()], kickPublisher: async () => {} } as unknown as MediaMtx,
      internalToken: 'internal-token-123456', rtmpBase: 'rtmp://mediamtx:1935', ffmpeg: 'ffmpeg', ytdlp: 'yt-dlp',
      publicRtmp: '', publicSrt: '',
      workerSpawn: (_b, args) => { const p = new FakeProc(args); procs.push(p); return p },
      resolve: async () => { const i = calls++; return { urls: [`https://manifest.googlevideo.com/run${i}/index.m3u8`], expiresAt: 1, title: 'T', live: live[i] ?? false } },
    })
    const orig = console.log; console.log = () => {}
    await hub.boot()
    const s = await hub.createSource({ name: 'meetup', kind: 'youtube', url: 'https://youtube.com/live/abcdefghijk' })
    await hub.setPull(s.id, true)
    await tick()
    expect(procs).toHaveLength(1)
    procs[0]!.exit(1, '[https @ 0x1] HTTP error 403 Forbidden')
    await tick(1500) // backoff ~1 s
    expect(procs).toHaveLength(2)
    expect(procs[1]!.args).toContain('https://manifest.googlevideo.com/run1/index.m3u8')
    procs[1]!.exit(0, '')
    await tick(2600) // backoff ~2 s, then the resolve says it's no longer live
    expect(procs).toHaveLength(2)
    const pull = hub.snapshot().sources[0]!.pull!
    expect(pull.state).toBe('stopped')
    expect(pull.reason).toContain('live has ended')
    expect(hub.snapshot().sources[0]!.pullEnabled).toBe(false)
    console.log = orig
    await hub.shutdown()
  }, 10_000)

  test('validation', async () => {
    const h = await setup()
    const s = await h.hub.createSource({ name: 'stage', kind: 'ingest' })
    await expect(h.hub.createDest({ sourceId: s.id, platform: 'youtube', key: '' })).rejects.toThrow('Paste the stream key')
    await expect(h.hub.createDest({ sourceId: s.id, platform: 'custom', server: 'http://x' })).rejects.toThrow('rtmp://')
    await expect(h.hub.createDest({ sourceId: s.id, platform: 'nope', key: 'k' })).rejects.toThrow('Unknown platform')
    await expect(h.hub.createDest({ sourceId: s.id, platform: 'youtube', key: 'a b' })).rejects.toThrow('no spaces')
    // same name twice → distinct slugs
    const s2 = await h.hub.createSource({ name: 'stage', kind: 'ingest' })
    expect(s2.slug).not.toBe(s.slug)
    await h.done()
  })

  test('metrics', async () => {
    const h = await setup()
    const s = await h.hub.createSource({ name: 'stage', kind: 'ingest' })
    await h.hub.createDest({ sourceId: s.id, platform: 'youtube', name: 'YT "main"', key: 'k-123456' })
    const m = h.hub.metrics()
    expect(m).toContain('pipeline_source_live{source="stage"} 0')
    expect(m).toContain('destination="YT _main_"')
    expect(m).not.toContain('k-123456')
    await h.done()
  })
})

describe('admin auth', () => {
  test('login, session, rate limit', async () => {
    const db = openDb(':memory:')
    const vault = await Vault.create('s'.repeat(40))
    const a = new Auth(db, vault, 'correct horse', false)
    const ok = await a.login('1.1.1.1', 'correct horse')
    expect('cookie' in ok).toBe(true)
    const cookie = (ok as any).cookie.split(';')[0]
    expect(await a.valid(new Request('http://x/', { headers: { cookie } }))).toBe(true)
    expect(await a.valid(new Request('http://x/', { headers: { cookie: 'hub_session=forged.sig' } }))).toBe(false)
    for (let i = 0; i < 10; i++) await a.login('2.2.2.2', 'wrong')
    const blocked = await a.login('2.2.2.2', 'correct horse')
    expect(blocked).toEqual({ error: 'Too many attempts — try again in 15 minutes', status: 429 })
  })
  test('expired sessions are refused', async () => {
    const db = openDb(':memory:')
    const vault = await Vault.create('s'.repeat(40))
    let now = 1_000_000
    const a = new Auth(db, vault, 'pw-12345678', false, () => now)
    const cookie = ((await a.login('1', 'pw-12345678')) as any).cookie.split(';')[0]
    now += 13 * 3600_000
    expect(await a.valid(new Request('http://x/', { headers: { cookie } }))).toBe(false)
  })
  test('csrf', () => {
    expect(csrfProblem(new Request('http://h/api', { method: 'POST', headers: { host: 'h', origin: 'http://evil' } }))).not.toBeNull()
    expect(csrfProblem(new Request('http://h/api', { method: 'POST', headers: { host: 'h', origin: 'http://h', 'content-type': 'text/plain', 'content-length': '3' }, body: 'abc' }))).toBe('Send JSON')
    expect(csrfProblem(new Request('http://h/api', { method: 'POST', headers: { host: 'h', origin: 'http://h', 'content-type': 'application/json', 'content-length': '2' }, body: '{}' }))).toBeNull()
  })
})
