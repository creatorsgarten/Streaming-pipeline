// End-to-end against the running compose stack (docker compose up -d first).
// A test pattern goes into the hub, the hub relays it to a second MediaMTX path standing in for
// YouTube/Facebook, and ffprobe checks that real video arrives there. No real stream keys involved.

import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
const HUB = process.env.HUB_URL ?? 'http://localhost:8790'
const RTMP = process.env.RTMP_URL ?? 'rtmp://localhost:1936'

let cookie = ''
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(HUB + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie, origin: HUB },
    body: body ? JSON.stringify(body) : undefined,
  })
  const sc = r.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]!
  return { status: r.status, json: (await r.json().catch(() => null)) as any, headers: r.headers }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(500)
  }
  console.log(`  (timed out waiting for ${what})`)
  return null
}
const state = async () => (await api('GET', '/api/state')).json
const src = async (id: string) => (await state()).sources.find((s: any) => s.id === id)

function push(url: string, opts: { audioOnly?: boolean; seconds?: number } = {}) {
  const v = opts.audioOnly ? [] : ['-f', 'lavfi', '-re', '-i', 'testsrc2=size=1280x720:rate=30']
  const a = ['-f', 'lavfi', '-re', '-i', 'sine=frequency=440:sample_rate=48000']
  const enc = opts.audioOnly ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-pix_fmt', 'yuv420p', '-b:v', '2500k', '-c:a', 'aac', '-b:a', '128k']
  return Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', ...v, ...a, '-t', String(opts.seconds ?? 40), ...enc, '-f', 'flv', url], { stdout: 'ignore', stderr: 'pipe' })
}

async function probe(url: string): Promise<{ video: boolean; audio: boolean; raw: string }> {
  const p = Bun.spawn(['ffprobe', '-v', 'error', '-rw_timeout', '10000000', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', url], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  const streams = (JSON.parse(out || '{}').streams ?? []) as any[]
  return { video: streams.some(s => s.codec_type === 'video'), audio: streams.some(s => s.codec_type === 'audio'), raw: JSON.stringify(streams) }
}

// ---------------------------------------------------------------------------------

check('health', (await fetch(`${HUB}/healthz`)).ok)
const page = await fetch(HUB + '/')
check('dashboard served with CSP', page.ok && !!page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"))
check('API refuses without a session', (await api('GET', '/api/state')).status === 401)
check('wrong password refused', (await api('POST', '/api/login', { password: 'nope' })).status === 401)
check('cross-site POST refused', (await fetch(`${HUB}/api/login`, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' })).status === 403)
check('login', (await api('POST', '/api/login', { password: env.ADMIN_PASSWORD })).status === 200 && !!cookie)

const a = (await api('POST', '/api/sources', { name: 'E2E Stage', kind: 'ingest' })).json
const sink = (await api('POST', '/api/sources', { name: 'E2E Sink', kind: 'ingest' })).json
const aKey = (await api('GET', `/api/sources/${a.id}/key`)).json.key
const sinkKey = (await api('GET', `/api/sources/${sink.id}/key`)).json.key
check('sources created', !!a.id && !!sink.id && aKey.length > 10)

// destination = the sink path, reached the same way an outside RTMP server would be
const dest = await api('POST', '/api/destinations', { sourceId: a.id, platform: 'custom', name: 'Fake YouTube', server: 'rtmp://mediamtx:1935/live', key: `${sink.slug}?key=${sinkKey}` })
check('destination added', dest.status === 201, dest.json?.error)

// wrong key can't publish
const bad = push(`${RTMP}/live/${a.slug}?key=wrong`, { seconds: 3 })
await bad.exited
check('publishing with a wrong key is refused', bad.exitCode !== 0)

const p1 = push(`${RTMP}/live/${a.slug}?key=${aKey}`)
const live = await waitFor('source live', async () => (await src(a.id))?.live.ready && (await src(a.id)))
check('source goes live', !!live, live ? live.live.tracks.join(', ') : '')
const d = await waitFor('destination live', async () => {
  const s = await src(a.id)
  const x = s?.destinations[0]
  return x?.worker?.state === 'live' ? x : null
})
check('destination auto-started and is live', !!d, d ? `${d.worker.kbps} kbps` : JSON.stringify((await src(a.id))?.destinations[0]?.worker))

const sinkLive = await waitFor('sink receives', async () => (await src(sink.id))?.live.ready)
check('relayed stream arrives at the destination', !!sinkLive)
const pr = await probe(`${RTMP}/live/${sink.slug}?user=hub&pass=${env.INTERNAL_TOKEN}`)
check('destination stream has video and audio', pr.video && pr.audio, pr.raw)

const m3u8 = await waitFor('preview playlist', async () => {
  const r = await fetch(`${HUB}/preview/${a.slug}/index.m3u8`, { headers: { cookie } })
  return r.ok ? await r.text() : null
}, 20_000)
check('HLS preview through the hub', !!m3u8?.includes('#EXTM3U'))
check('preview needs a session', (await fetch(`${HUB}/preview/${a.slug}/index.m3u8`)).status === 401)

const metrics = await fetch(`${HUB}/metrics`, { headers: { cookie } }).then(r => r.text())
check('metrics', metrics.includes(`pipeline_destination_up{source="${a.slug}",destination="Fake YouTube",platform="custom"} 1`))

// source stops → destination waits; comes back → resumes by itself
p1.kill()
await p1.exited
const waiting = await waitFor('destination waiting', async () => (await src(a.id))?.destinations[0]?.worker?.state === 'waiting', 30_000)
check('destination waits when the source stops', !!waiting, JSON.stringify((await src(a.id))?.destinations[0]?.worker?.state))
const p2 = push(`${RTMP}/live/${a.slug}?key=${aKey}`, { seconds: 20 })
const resumed = await waitFor('destination resumes', async () => (await src(a.id))?.destinations[0]?.worker?.state === 'live', 30_000)
check('destination resumes when the source comes back', !!resumed)
p2.kill()

// audio only → warning (the bug that started this project)
const radio = (await api('POST', '/api/sources', { name: 'E2E Radio', kind: 'ingest' })).json
const radioKey = (await api('GET', `/api/sources/${radio.id}/key`)).json.key
const p3 = push(`${RTMP}/live/${radio.slug}?key=${radioKey}`, { audioOnly: true, seconds: 15 })
const warned = await waitFor('audio-only warning', async () => {
  const ev = (await api('GET', '/api/events?limit=100')).json as any[]
  return ev.some(e => e.source_id === radio.id && e.message.includes('no video track'))
}, 20_000)
check('audio-only source is flagged', !!warned)
const rs = await src(radio.id)
check('dashboard knows it has no video', rs?.live.ready === true && rs?.live.video === false, rs?.live.tracks.join(','))
p3.kill()

// nothing secret leaks into the log or the state
const everything = JSON.stringify((await api('GET', '/api/events?limit=500')).json) + JSON.stringify(await state())
check('no keys in events or state', !everything.includes(aKey) && !everything.includes(sinkKey) && !everything.includes(env.INTERNAL_TOKEN!))
const logs = Bun.spawnSync(['docker', 'compose', 'logs', 'hub', '--no-color'], { cwd: new URL('..', import.meta.url).pathname }).stdout.toString()
check('no keys in container logs', !logs.includes(aKey) && !logs.includes(sinkKey) && !logs.includes(env.INTERNAL_TOKEN!))

// a destination whose key ends up in a non-URL log line (MediaMTX: "path 'live/<key>' is not configured")
const leaky = 'FB-0000000000-0-not-a-real-key'
const ld = (await api('POST', '/api/destinations', { sourceId: a.id, platform: 'custom', name: 'Leak probe', server: 'rtmp://mediamtx:1935/live', key: leaky, autoStart: false })).json
const p4 = push(`${RTMP}/live/${a.slug}?key=${aKey}`, { seconds: 15 })
await waitFor('source live again', async () => (await src(a.id))?.live.ready)
await api('POST', `/api/destinations/${ld.id}/start`)
await sleep(9000) // a couple of failed attempts, runs end, media log tailed
await api('POST', `/api/destinations/${ld.id}/stop`)
p4.kill()

// the Logs page: ffmpeg output and the media server's log, keys hidden
const logs2 = (await api('GET', '/api/logs?limit=2000')).json
const lines = (logs2?.lines ?? []) as any[]
check('logs include the media server', lines.some(l => l.origin === 'media'), `${lines.length} lines`)
check('logs include hub events', lines.some(l => l.origin === 'hub' || l.sourceId === a.id))
const logText = JSON.stringify(lines)
check('no keys in the Logs page', !logText.includes(aKey) && !logText.includes(sinkKey) && !logText.includes(env.INTERNAL_TOKEN!))
const leakedLine = lines.find(l => l.text.includes(leaky))
check('the leak probe reached the media server', logText.includes('not configured'))
check('a key in a non-URL media log line stays hidden after its runs end', !leakedLine, leakedLine ? JSON.stringify(leakedLine) : '')

// rtmps works inside the image (Facebook needs it)
const protos = Bun.spawnSync(['docker', 'compose', 'exec', '-T', 'hub', 'ffmpeg', '-hide_banner', '-protocols'], { cwd: new URL('..', import.meta.url).pathname }).stdout.toString()
check('ffmpeg in the image supports rtmps', /\n\s+rtmps\n/.test(protos))
const ytv = Bun.spawnSync(['docker', 'compose', 'exec', '-T', 'hub', 'yt-dlp', '--version'], { cwd: new URL('..', import.meta.url).pathname }).stdout.toString().trim()
check('yt-dlp present in the image', /^\d{4}\.\d{2}\.\d{2}/.test(ytv), ytv)

for (const s of [a, sink, radio]) await api('DELETE', `/api/sources/${s.id}`)
check('cleanup', !(await state()).sources.some((s: any) => [a.id, sink.id, radio.id].includes(s.id)))

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
