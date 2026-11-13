// HTTP entry: dashboard + JSON API (public port) and the MediaMTX auth hook (internal port only).

import { join } from 'node:path'
import { Auth, csrfProblem } from './auth'
import { tailFile } from './logbuf'
import { config } from './config'
import { Vault } from './crypto'
import { openDb } from './db'
import { Hub, HttpError } from './hub'
import { MediaMtx } from './mediamtx'
import { PLATFORMS, PROFILES } from './presets'

const db = openDb(config.dataDir)
const vault = await Vault.create(config.secret)
const hub = new Hub({
  db,
  vault,
  mtx: new MediaMtx(config.mediamtx.api),
  internalToken: config.internalToken,
  rtmpBase: config.mediamtx.rtmp,
  ffmpeg: config.ffmpeg,
  ytdlp: config.ytdlp,
  publicRtmp: config.publicRtmp,
  publicSrt: config.publicSrt,
})
const auth = new Auth(db, vault, config.adminPassword, config.secureCookies)
await hub.boot()
// the media server writes its log to a shared volume; follow it for the Logs page
if (process.env.MEDIAMTX_LOG) tailFile(process.env.MEDIAMTX_LOG, line => hub.mediaLog(line))

const SECURITY: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...SECURITY, ...headers } })

// the dashboard: bundled once at boot (Preact + hls.js), served from memory with our headers
const ui = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>()
{
  const out = await Bun.build({ entrypoints: [join(import.meta.dir, '../ui/index.html')], minify: true, target: 'browser' })
  if (!out.success) throw new AggregateError(out.logs, 'UI build failed')
  for (const a of out.outputs) {
    const name = a.path.replace(/^\.?\//, '')
    ui.set(name === 'index.html' ? '' : name, { body: new Uint8Array(await a.arrayBuffer()) as Uint8Array<ArrayBuffer>, type: a.type })
  }
}
const asset = (name: string) => {
  const f = ui.get(name)
  if (!f) return json({ error: 'Not found' }, 404)
  return new Response(f.body, {
    headers: { 'Content-Type': f.type, 'Cache-Control': name ? 'public, max-age=31536000, immutable' : 'no-store', ...SECURITY },
  })
}

type Handler = (req: Request & { params: Record<string, string> }, server: Bun.Server<unknown>) => Promise<Response> | Response

/** wraps an API handler: session check, CSRF, error → JSON */
function api(fn: Handler, opts: { public?: boolean } = {}): Handler {
  return async (req, server) => {
    try {
      const csrf = csrfProblem(req)
      if (csrf) return json({ error: csrf }, 403)
      if (!opts.public && !(await auth.valid(req))) return json({ error: 'Sign in first' }, 401)
      return await fn(req, server)
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status)
      if (e instanceof SyntaxError) return json({ error: 'Bad JSON' }, 400)
      console.error(hub.redactor.scrub(String(e?.stack ?? e)))
      return json({ error: 'Something went wrong' }, 500)
    }
  }
}

const body = async (req: Request): Promise<any> => {
  const t = await req.text()
  return t ? JSON.parse(t) : {}
}

const clientIp = (req: Request, server: Bun.Server<unknown>) =>
  (process.env.TRUST_PROXY === '1' && req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()) || server.requestIP(req)?.address || 'unknown'

const server = Bun.serve({
  port: config.port,
  development: process.env.NODE_ENV !== 'production',
  idleTimeout: 0, // SSE
  routes: {
    '/': () => asset(''),
    '/assets/:file': req => asset(req.params.file!),
    '/healthz': () => new Response('ok'),

    '/api/login': { POST: api(async (req, server) => {
      const b = await body(req)
      const r = await auth.login(clientIp(req, server), String(b.password ?? ''))
      if ('error' in r) return json({ error: r.error }, r.status)
      return json({ ok: true }, 200, { 'Set-Cookie': r.cookie })
    }, { public: true }) },
    '/api/logout': { POST: api(() => json({ ok: true }, 200, { 'Set-Cookie': auth.logoutCookie() }), { public: true }) },
    '/api/session': { GET: api(async req => json({ signedIn: await auth.valid(req) }), { public: true }) },

    '/api/presets': { GET: api(() => json({ platforms: PLATFORMS, profiles: PROFILES })) },
    '/api/state': { GET: api(() => json(hub.snapshot())) },
    '/api/events': { GET: api(req => {
      const u = new URL(req.url)
      return json(hub.events(Math.min(500, Number(u.searchParams.get('limit') ?? 200)), u.searchParams.get('source') ?? undefined))
    }) },
    '/api/logs': { GET: api(req => {
      const u = new URL(req.url)
      return json(hub.logs.since(Number(u.searchParams.get('after') ?? 0) || 0, Math.min(2000, Number(u.searchParams.get('limit') ?? 1000))))
    }) },
    '/api/stream': { GET: api(req => {
      // server-sent events: a full snapshot whenever something changes (at most every 500 ms)
      let unsub = () => {}
      let timer: ReturnType<typeof setInterval> | null = null
      const stream = new ReadableStream({
        start(c) {
          const enc = new TextEncoder()
          let dirty = true, closed = false
          const send = () => {
            if (!dirty || closed) return
            dirty = false
            try { c.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify(hub.snapshot())}\n\n`)) } catch { closed = true }
          }
          unsub = hub.subscribe(() => { dirty = true })
          timer = setInterval(() => {
            send()
            try { c.enqueue(enc.encode(': ping\n\n')) } catch { closed = true }
          }, 500)
          send()
          req.signal.addEventListener('abort', () => { closed = true; unsub(); if (timer) clearInterval(timer) })
        },
        cancel() { unsub(); if (timer) clearInterval(timer) },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } })
    }) },

    '/api/sources': { POST: api(async req => {
      const b = await body(req)
      return json(await hub.createSource({ name: String(b.name ?? ''), kind: b.kind, url: b.url, realtime: !!b.realtime }), 201)
    }) },
    '/api/sources/:id': {
      PATCH: api(async req => { await hub.updateSource(req.params.id!, await body(req)); return json({ ok: true }) }),
      DELETE: api(async req => { await hub.deleteSource(req.params.id!); return json({ ok: true }) }),
    },
    '/api/sources/:id/key': { GET: api(async req => json({ key: await hub.revealKey(req.params.id!) })) },
    '/api/sources/:id/rotate-key': { POST: api(async req => { await hub.rotateKey(req.params.id!); return json({ ok: true }) }) },
    '/api/sources/:id/pull': { POST: api(async req => { await hub.setPull(req.params.id!, !!(await body(req)).on); return json({ ok: true }) }) },
    '/api/sources/:id/start-all': { POST: api(async req => { await hub.startAll(req.params.id!); return json({ ok: true }) }) },
    '/api/sources/:id/stop-all': { POST: api(async req => { await hub.stopAll(req.params.id!); return json({ ok: true }) }) },

    '/api/destinations': { POST: api(async req => json(await hub.createDest(await body(req)), 201)) },
    '/api/destinations/:id': {
      PATCH: api(async req => { await hub.updateDest(req.params.id!, await body(req)); return json({ ok: true }) }),
      DELETE: api(async req => { await hub.deleteDest(req.params.id!); return json({ ok: true }) }),
    },
    '/api/destinations/:id/start': { POST: api(async req => { await hub.startDest(req.params.id!); return json({ ok: true }) }) },
    '/api/destinations/:id/stop': { POST: api(async req => { await hub.stopDest(req.params.id!); return json({ ok: true }) }) },

    // HLS preview of a source, proxied so MediaMTX never faces the internet and the session cookie guards it
    '/preview/:slug/*': { GET: async req => {
      if (!(await auth.valid(req))) return new Response('Sign in first', { status: 401 })
      const slug = req.params.slug!
      if (!/^[a-z0-9]{3,40}$/.test(slug)) return new Response('Not found', { status: 404 })
      const rest = new URL(req.url).pathname.split('/').slice(3).join('/')
      if (!/^[A-Za-z0-9_.-]+(\.m3u8|\.mp4|\.ts|\.m4s)$/.test(rest)) return new Response('Not found', { status: 404 })
      const upstream = await fetch(`${config.mediamtx.hls}/live/${slug}/${rest}${new URL(req.url).search}`, {
        headers: { Authorization: `Basic ${btoa(`hub:${config.internalToken}`)}` },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null)
      if (!upstream) return new Response('Preview unavailable', { status: 502 })
      const h = new Headers({ 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'no-store', ...SECURITY })
      return new Response(upstream.body, { status: upstream.status, headers: h })
    } },

    '/metrics': { GET: async req => {
      const token = process.env.METRICS_TOKEN
      const ok = token ? req.headers.get('authorization') === `Bearer ${token}` : await auth.valid(req)
      if (!ok) return new Response('Unauthorized', { status: 401 })
      return new Response(hub.metrics(), { headers: { 'Content-Type': 'text/plain; version=0.0.4' } })
    } },
  },
  fetch(req) {
    // bundler output lands next to index.html under hashed names
    const name = new URL(req.url).pathname.slice(1)
    return ui.has(name) && name ? asset(name) : json({ error: 'Not found' }, 404)
  },
  error(e) {
    console.error(hub.redactor.scrub(String(e?.stack ?? e)))
    return json({ error: 'Something went wrong' }, 500)
  },
})

// MediaMTX calls this for every publish/read. Separate port that is never published outside the compose network.
const internal = Bun.serve({
  port: Number(process.env.INTERNAL_PORT ?? 8081),
  routes: {
    '/mediamtx/auth': { POST: async req => {
      const b = await req.json().catch(() => ({}))
      const ok = await hub.authorize(b)
      return new Response(null, { status: ok ? 200 : 401 })
    } },
  },
  fetch: () => new Response('Not found', { status: 404 }),
})

console.log(`streaming-pipeline on :${server.port} (internal :${internal.port})`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log('shutting down…')
    await hub.shutdown()
    process.exit(0)
  })
}

