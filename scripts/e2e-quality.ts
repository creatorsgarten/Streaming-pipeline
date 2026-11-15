// Re-encode profiles, for real: HD (1080p30) goes in, each profile comes out at a stand-in destination,
// and ffprobe checks the resolution, frame rate and 2 s keyframes there. Also reports whether this
// machine encodes each profile in real time (speed ≥ 1×). Run against the compose stack:
//   bun scripts/e2e-quality.ts            all profiles
//   bun scripts/e2e-quality.ts 720p30 2160p30

import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
const HUB = process.env.HUB_URL ?? 'http://localhost:8790'
const RTMP = process.env.RTMP_URL ?? 'rtmp://localhost:1936'
const EXPECT: Record<string, { w: number; h: number; fps: number }> = {
  '480p30': { w: 854, h: 480, fps: 30 },
  '720p30': { w: 1280, h: 720, fps: 30 },
  '720p60': { w: 1280, h: 720, fps: 60 },
  '1080p30': { w: 1920, h: 1080, fps: 30 },
  '1080p60': { w: 1920, h: 1080, fps: 60 },
  '1440p30': { w: 2560, h: 1440, fps: 30 },
  '1440p60': { w: 2560, h: 1440, fps: 60 },
  '2160p30': { w: 3840, h: 2160, fps: 30 },
  '2160p60': { w: 3840, h: 2160, fps: 60 },
}
const which = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(EXPECT)

let cookie = ''
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(HUB + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie, origin: HUB }, body: body ? JSON.stringify(body) : undefined })
  const sc = r.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]!
  return (await r.json().catch(() => null)) as any
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const dest = async (srcId: string, id: string) => (await api('GET', '/api/state')).sources.find((s: any) => s.id === srcId)?.destinations.find((d: any) => d.id === id)
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms: number): Promise<T | null> {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500) }
  return null
}
async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out
}

await api('POST', '/api/login', { password: env.ADMIN_PASSWORD })
const src = await api('POST', '/api/sources', { name: 'Quality test', kind: 'ingest' })
const key = (await api('GET', `/api/sources/${src.id}/key`)).key
// HD in: 1080p30, keyframe every 2 s, the way OBS usually sends
const push = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', process.env.HARD ? 'testsrc2=size=1920x1080:rate=30,noise=alls=25:allf=t+u' : 'testsrc2=size=1920x1080:rate=30', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-pix_fmt', 'yuv420p', '-b:v', '6000k', '-c:a', 'aac', '-b:a', '160k', '-f', 'flv', `${RTMP}/live/${src.slug}?key=${key}`], { stdout: 'ignore', stderr: 'ignore' })
check('HD source live', !!(await until(async () => (await api('GET', '/api/state')).sources.find((s: any) => s.id === src.id)?.live.ready, 20_000)))

const results: string[] = []
for (const profile of which) {
  const want = EXPECT[profile]!
  const sink = await api('POST', '/api/sources', { name: `q sink ${profile}`, kind: 'ingest' })
  const sinkKey = (await api('GET', `/api/sources/${sink.id}/key`)).key
  const d = await api('POST', '/api/destinations', { sourceId: src.id, platform: 'custom', name: profile, server: 'rtmp://mediamtx:1935/live', key: `${sink.slug}?key=${sinkKey}`, profile, autoStart: false })
  await api('POST', `/api/destinations/${d.id}/start`)
  const live = await until(async () => (await dest(src.id, d.id))?.worker?.state === 'live', 30_000)
  if (!live) { check(`${profile}: goes live`, false, JSON.stringify((await dest(src.id, d.id))?.worker)); continue }
  // let the encoder settle, then sample its speed for 8 s
  await sleep(4000)
  const speeds: number[] = []
  for (let i = 0; i < 8; i++) { await sleep(1000); const w = (await dest(src.id, d.id))?.worker; if (w?.speed) speeds.push(w.speed) }
  const speed = speeds.length ? speeds.reduce((a, b) => a + b) / speeds.length : 0
  const url = `${RTMP}/live/${sink.slug}?user=hub&pass=${env.INTERNAL_TOKEN}`
  const info = JSON.parse(await run(['ffprobe', '-v', 'error', '-rw_timeout', '10000000', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,r_frame_rate,pix_fmt', '-of', 'json', url]) || '{}').streams?.[0] ?? {}
  const pk = await run(['ffprobe', '-v', 'error', '-rw_timeout', '10000000', '-select_streams', 'v:0', '-read_intervals', '%+7', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', url])
  const keys = pk.split('\n').filter(l => l.includes(',K')).map(l => parseFloat(l))
  const gaps = keys.slice(1).map((t, i) => t - keys[i]!)
  const fps = (() => { const [a, b] = String(info.r_frame_rate ?? '0/1').split('/').map(Number); return b ? a! / b : 0 })()
  check(`${profile}: ${info.width}x${info.height} ${info.codec_name} ${info.pix_fmt}`, info.width === want.w && info.height === want.h && info.codec_name === 'h264' && info.pix_fmt === 'yuv420p')
  check(`${profile}: ${fps.toFixed(0)} fps`, Math.abs(fps - want.fps) < 1)
  check(`${profile}: keyframe every ${gaps.length ? gaps.map(g => g.toFixed(1)).join('/') : '?'} s`, gaps.length > 0 && gaps.every(g => Math.abs(g - 2) < 0.2))
  const realtime = speed >= 0.97
  results.push(`${profile.padEnd(8)} speed ${speed.toFixed(2)}×  ${realtime ? 'real time ✓' : 'TOO SLOW on this machine'}  ${Math.round((await dest(src.id, d.id))?.worker?.kbps ?? 0)} kbps`)
  await api('POST', `/api/destinations/${d.id}/stop`)
  await api('DELETE', `/api/sources/${sink.id}`)
}

push.kill()
await api('DELETE', `/api/sources/${src.id}`)
console.log('\nencoder speed on this machine (HD 1080p30 in):')
for (const r of results) console.log('  ' + r)
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
