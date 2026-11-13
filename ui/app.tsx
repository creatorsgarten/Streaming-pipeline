import { render } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import Hls from 'hls.js'

// ---------- types (mirror Hub.snapshot) ----------

type WorkerView = {
  state: 'stopped' | 'waiting' | 'starting' | 'live' | 'retrying' | 'failed'
  reason: string | null
  since: number
  liveSince: number | null
  restarts: number
  nextRetryAt: number | null
  kbps: number
  fps: number
  speed: number
  dropFrames: number
  tail: string[]
}
type Dest = { id: string; name: string; platform: string; server: string; keyHint: string | null; profile: string; enabled: boolean; autoStart: boolean; worker: WorkerView | null }
type Live = { ready: boolean; since: number | null; tracks: string[]; video: boolean; audio: boolean; kbps: number; readers: number }
type Source = {
  id: string; name: string; slug: string; kind: 'ingest' | 'youtube' | 'url'
  pullUrl: string | null; pullRealtime: boolean; pullEnabled: boolean
  pull: (WorkerView & { title?: string | null; expiresAt?: number | null }) | null
  live: Live; destinations: Dest[]
}
type State = { mediaServer: boolean; ingest: { rtmp: string; srt: string }; sources: Source[] }
type Presets = { platforms: Record<string, { label: string; server: string; hint: string }>; profiles: Record<string, { label: string }> }
type LogLine = { seq: number; ts: number; level: 'debug' | 'info' | 'warn' | 'error'; origin: string; sourceId: string | null; text: string }

// ---------- api ----------

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j
}

// ---------- helpers ----------

const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
const fmtKbps = (k: number) => (k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${Math.round(k)} kbps`)
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function useNow(ms = 1000) {
  const [n, setN] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t) }, [ms])
  return n
}

const PLATFORM_ICON: Record<string, string> = { youtube: '▶', facebook: 'f', twitch: '◆', custom: '⇢' }
const destOn = (d: Dest) => !!d.worker && d.worker.state !== 'stopped' && d.worker.state !== 'failed'

/** what a destination is doing, in plain words */
function destStatus(d: Dest, now: number): { tone: 'live' | 'busy' | 'idle' | 'bad'; text: string } {
  const w = d.worker
  if (!w || w.state === 'stopped') return { tone: 'idle', text: 'Not sending' }
  if (w.state === 'live') return { tone: 'live', text: `Live · ${fmtDur(now - (w.liveSince ?? now))}` }
  if (w.state === 'waiting') return { tone: 'busy', text: 'Ready — starts when video arrives' }
  if (w.state === 'starting') return { tone: 'busy', text: 'Connecting…' }
  if (w.state === 'retrying') return { tone: 'busy', text: `Connection dropped — trying again in ${Math.max(0, Math.ceil(((w.nextRetryAt ?? now) - now) / 1000))} s` }
  return { tone: 'bad', text: w.reason ?? 'Stopped because of a problem' }
}

// ---------- small pieces ----------

let toastFn: (m: string) => void = () => {}
const toast = (m: string) => toastFn(m)

function CopyBox({ label, value, secret, reveal }: { label: string; value?: string; secret?: boolean; reveal?: () => Promise<string> }) {
  const [shown, setShown] = useState<string | null>(secret ? null : value ?? null)
  const [copied, setCopied] = useState(false)
  const get = async () => shown ?? (reveal ? await reveal() : value ?? '')
  return (
    <div class="copybox">
      <div class="copybox-label">{label}</div>
      <div class="copybox-row">
        <code>{shown ?? '••••••••••••••••••••'}</code>
        {secret && <button class="btn small ghost" onClick={async () => setShown(shown ? null : await get())}>{shown ? 'Hide' : 'Show'}</button>}
        <button class="btn small" onClick={async () => {
          await navigator.clipboard.writeText(await get())
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}>{copied ? '✓ Copied' : 'Copy'}</button>
      </div>
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: any }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [])
  return (
    <div class="backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div class="card modal" role="dialog" aria-modal="true" aria-label={title}>
        <div class="modal-head"><h3>{title}</h3><button class="btn small ghost" aria-label="Close" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  )
}

function ConfirmDelete({ what, onYes, onClose }: { what: string; onYes: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={`Delete ${what}?`} onClose={onClose}>
      <p class="muted">This can’t be undone.</p>
      <div class="row end">
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn danger" disabled={busy} onClick={async () => { setBusy(true); try { await onYes(); onClose() } catch (e: any) { toast(e.message); setBusy(false) } }}>Delete</button>
      </div>
    </Modal>
  )
}

// ---------- preview ----------

function Preview({ source }: { source: Source }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const ready = source.live.ready && source.live.video
  useEffect(() => {
    const v = ref.current
    if (!v || !ready) return
    setErr(null)
    const url = `/preview/${source.slug}/index.m3u8`
    if (Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2 })
      hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) setErr('Preview paused') })
      hls.loadSource(url)
      hls.attachMedia(v)
      return () => hls.destroy()
    }
    v.src = url
    return () => { v.removeAttribute('src'); v.load() }
  }, [ready, source.slug])
  return (
    <div class="preview">
      {ready ? <video ref={ref} muted autoplay playsInline controls /> : null}
      {!ready && (
        <div class="empty">
          {source.live.ready
            ? <><b>Sound only, no picture</b><span>YouTube and Facebook won’t accept this — add a camera, screen or image in OBS.</span></>
            : <><span class="big-icon" aria-hidden="true">📡</span><b>No video yet</b><span>{source.kind === 'ingest' ? 'Start streaming in OBS and it shows up here.' : 'Press “Start” to fetch the stream.'}</span></>}
        </div>
      )}
      {ready && err && <div class="empty"><span>{err}</span></div>}
    </div>
  )
}

// ---------- step 1: video in ----------

function VideoIn({ source, state }: { source: Source; state: State }) {
  const l = source.live
  const now = useNow()
  const [help, setHelp] = useState(false)
  const reveal = () => call<{ key: string }>('GET', `/api/sources/${source.id}/key`).then(r => r.key)
  return (
    <section class="card step">
      <div class="step-head">
        <span class="step-no">1</span>
        <div>
          <h2>Video in</h2>
          <p class="muted">{source.kind === 'ingest' ? 'Send your video here from OBS (or any streaming app).' : source.kind === 'youtube' ? 'We fetch this YouTube live for you.' : 'We fetch this stream for you.'}</p>
        </div>
        <span class="spacer" />
        {l.ready
          ? <span class="pill live"><span class="dot" />Receiving · {fmtDur(now - (l.since ?? now))}</span>
          : <span class="pill"><span class="dot" />Waiting for video</span>}
      </div>

      <div class="step-body two">
        <Preview source={source} />
        <div>
          {source.kind === 'ingest' ? (
            <>
              <CopyBox label="Server" value={`${state.ingest.rtmp}/live`} />
              <CopyBox label="Stream key" secret reveal={async () => `${source.slug}?key=${await reveal()}`} />
              <button class="linkish" aria-expanded={help} onClick={() => setHelp(!help)}>{help ? 'Hide' : 'How do I set up OBS?'}</button>
              {help && (
                <ol class="howto">
                  <li>OBS → <b>Settings</b> → <b>Stream</b></li>
                  <li>Service: <b>Custom…</b></li>
                  <li>Paste the <b>Server</b> and <b>Stream key</b> above</li>
                  <li>Click <b>Start Streaming</b> in OBS</li>
                </ol>
              )}
              <details class="advanced">
                <summary>Advanced</summary>
                <CopyBox label="SRT address (lower delay, for vMix / ffmpeg)" secret reveal={async () => `${state.ingest.srt}?streamid=publish:live/${source.slug}:pub:${await reveal()}`} />
                <button class="btn small" onClick={async () => { await call('POST', `/api/sources/${source.id}/rotate-key`); toast('New stream key made. Paste it into OBS again.') }}>Make a new stream key</button>
              </details>
            </>
          ) : <PullControls source={source} />}
          {l.ready && (
            <div class="facts">
              <div><b>{fmtKbps(l.kbps)}</b><span>coming in</span></div>
              <div><b>{l.video ? '✓' : '✗'} picture</b><span>{l.tracks.find(t => !/audio|opus|aac/i.test(t)) ?? 'none'}</span></div>
              <div><b>{l.audio ? '✓' : '✗'} sound</b><span>{l.tracks.find(t => /audio|opus|aac/i.test(t)) ?? 'none'}</span></div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function PullControls({ source }: { source: Source }) {
  const now = useNow()
  const p = source.pull
  const [url, setUrl] = useState(source.pullUrl ?? '')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => setUrl(source.pullUrl ?? ''), [source.pullUrl])
  const act = (fn: () => Promise<unknown>) => async () => { setErr(null); try { await fn() } catch (e: any) { setErr(e.message) } }
  return (
    <div>
      {err && <div class="err-box">{err}</div>}
      {p?.title && <p class="pull-title">{p.title}</p>}
      <label class="field"><span>{source.kind === 'youtube' ? 'YouTube link' : 'Stream link'}</span>
        <input type="url" value={url} onInput={e => setUrl(e.currentTarget.value)} />
      </label>
      {url !== source.pullUrl && <button class="btn small" onClick={act(() => call('PATCH', `/api/sources/${source.id}`, { url }))}>Save link</button>}
      {source.pullEnabled
        ? <button class="btn stop" onClick={act(() => call('POST', `/api/sources/${source.id}/pull`, { on: false }))}>Stop fetching</button>
        : <button class="btn go" onClick={act(() => call('POST', `/api/sources/${source.id}/pull`, { on: true }))}>Start fetching</button>}
      {p && p.state !== 'stopped' && p.state !== 'live' && p.reason && <p class="hint bad">{p.reason}</p>}
      {p?.state === 'live' && p.expiresAt && <p class="hint">YouTube’s link expires in {fmtDur(Math.max(0, p.expiresAt - now))}; then we fetch a fresh one by ourselves (a few seconds’ gap).</p>}
    </div>
  )
}

// ---------- step 2: send to ----------

function AddDest({ source, presets, platform, onClose }: { source: Source; presets: Presets; platform: string; onClose: () => void }) {
  const p = presets.platforms[platform]!
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [server, setServer] = useState(p.server)
  const [profile, setProfile] = useState('copy')
  const [autoStart, setAutoStart] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (e: Event) => {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      await call('POST', '/api/destinations', { sourceId: source.id, platform, name, server, key, profile, autoStart })
      onClose()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal title={`Send to ${p.label}`} onClose={onClose}>
      <form onSubmit={save}>
        {err && <div class="err-box">{err}</div>}
        {platform === 'custom' && (
          <label class="field"><span>Server address</span>
            <input type="text" required value={server} onInput={e => setServer(e.currentTarget.value)} placeholder="rtmp://… or srt://…" />
          </label>
        )}
        <label class="field"><span>Stream key</span>
          <input type="password" autocomplete="off" autofocus value={key} onInput={e => setKey(e.currentTarget.value)} placeholder="Paste it here" />
          <small>Where to find it: {p.hint}</small>
        </label>
        <details class="advanced">
          <summary>Advanced</summary>
          <label class="field"><span>Name</span><input type="text" value={name} placeholder={p.label} onInput={e => setName(e.currentTarget.value)} /></label>
          {platform !== 'custom' && <label class="field"><span>Server</span><input type="text" value={server} onInput={e => setServer(e.currentTarget.value)} /></label>}
          <label class="field"><span>Quality</span>
            <select value={profile} onChange={e => setProfile(e.currentTarget.value)}>
              {Object.entries(presets.profiles).map(([id, x]) => <option value={id}>{x.label}</option>)}
            </select>
          </label>
          <label class="check"><input type="checkbox" checked={autoStart} onChange={e => setAutoStart(e.currentTarget.checked)} /> Go live by itself whenever video arrives</label>
        </details>
        <p class="hint">🔒 The key is stored encrypted and never shown again.</p>
        <div class="row end">
          <button type="button" class="btn" onClick={onClose}>Cancel</button>
          <button class="btn primary" disabled={busy}>Add {p.label}</button>
        </div>
      </form>
    </Modal>
  )
}

function EditDest({ d, presets, onClose }: { d: Dest; presets: Presets; onClose: () => void }) {
  const [key, setKey] = useState('')
  const [name, setName] = useState(d.name)
  const [server, setServer] = useState(d.server)
  const [profile, setProfile] = useState(d.profile)
  const [autoStart, setAutoStart] = useState(d.autoStart)
  const [err, setErr] = useState<string | null>(null)
  const [del, setDel] = useState(false)
  const save = async (e: Event) => {
    e.preventDefault()
    setErr(null)
    try { await call('PATCH', `/api/destinations/${d.id}`, { name, server, key: key || undefined, profile, autoStart }); onClose() } catch (e: any) { setErr(e.message) }
  }
  if (del) return <ConfirmDelete what={d.name} onClose={onClose} onYes={() => call('DELETE', `/api/destinations/${d.id}`)} />
  return (
    <Modal title={`${d.name} settings`} onClose={onClose}>
      <form onSubmit={save}>
        {err && <div class="err-box">{err}</div>}
        <label class="field"><span>New stream key</span>
          <input type="password" autocomplete="off" value={key} onInput={e => setKey(e.currentTarget.value)} placeholder="Leave empty to keep the current one" />
          <small>{presets.platforms[d.platform]?.hint}</small>
        </label>
        <label class="field"><span>Name</span><input type="text" value={name} onInput={e => setName(e.currentTarget.value)} /></label>
        <details class="advanced">
          <summary>Advanced</summary>
          <label class="field"><span>Server</span><input type="text" value={server} onInput={e => setServer(e.currentTarget.value)} /></label>
          <label class="field"><span>Quality</span>
            <select value={profile} onChange={e => setProfile(e.currentTarget.value)}>
              {Object.entries(presets.profiles).map(([id, x]) => <option value={id}>{x.label}</option>)}
            </select>
          </label>
          <label class="check"><input type="checkbox" checked={autoStart} onChange={e => setAutoStart(e.currentTarget.checked)} /> Go live by itself whenever video arrives</label>
          {!!d.worker?.tail.length && <><div class="copybox-label">Last messages</div><pre class="tail">{d.worker.tail.join('\n')}</pre></>}
        </details>
        <div class="row end">
          <button type="button" class="btn danger-ghost" onClick={() => setDel(true)}>Remove</button>
          <span class="spacer" />
          <button type="button" class="btn" onClick={onClose}>Cancel</button>
          <button class="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  )
}

function DestTile({ d, presets }: { d: Dest; presets: Presets }) {
  const now = useNow()
  const [edit, setEdit] = useState(false)
  const st = destStatus(d, now)
  const on = destOn(d)
  const toggle = async () => {
    try { await call('POST', `/api/destinations/${d.id}/${on ? 'stop' : 'start'}`) } catch (e: any) { toast(e.message) }
  }
  return (
    <div class={`tile tone-${st.tone}`}>
      <div class={`logo ${d.platform}`} aria-hidden="true">{PLATFORM_ICON[d.platform] ?? '⇢'}</div>
      <div class="tile-main">
        <div class="tile-name">{d.name}</div>
        <div class="tile-status">{st.tone === 'live' && <span class="dot pulse" />}{st.text}</div>
        {st.tone === 'live' && d.worker && <div class="tile-meta">{fmtKbps(d.worker.kbps)}{d.worker.speed > 0 && d.worker.speed < 0.97 ? ' · ⚠ slow connection' : ''}</div>}
        {st.tone === 'bad' && <button class="linkish" onClick={() => setEdit(true)}>Fix the stream key</button>}
      </div>
      <div class="tile-actions">
        <button class={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={`${on ? 'Stop' : 'Start'} sending to ${d.name}`} onClick={toggle}><span /></button>
        <button class="btn small ghost" aria-label={`${d.name} settings`} onClick={() => setEdit(true)}>⚙</button>
      </div>
      {edit && <EditDest d={d} presets={presets} onClose={() => setEdit(false)} />}
    </div>
  )
}

function SendTo({ source, presets }: { source: Source; presets: Presets }) {
  const [adding, setAdding] = useState<string | null>(null)
  return (
    <section class="card step">
      <div class="step-head">
        <span class="step-no">2</span>
        <div>
          <h2>Send to</h2>
          <p class="muted">Where should people watch? Add as many as you like.</p>
        </div>
      </div>
      <div class="tiles">
        {source.destinations.map(d => <DestTile key={d.id} d={d} presets={presets} />)}
      </div>
      <div class="add-row">
        {Object.entries(presets.platforms).map(([id, p]) => (
          <button class={`add-btn ${id}`} onClick={() => setAdding(id)}>
            <span class={`logo small ${id}`} aria-hidden="true">{PLATFORM_ICON[id]}</span>+ {id === 'custom' ? 'Other server' : p.label}
          </button>
        ))}
      </div>
      {adding && <AddDest source={source} presets={presets} platform={adding} onClose={() => setAdding(null)} />}
    </section>
  )
}

// ---------- step 3: go live ----------

function GoLive({ source }: { source: Source }) {
  const [busy, setBusy] = useState(false)
  const n = source.destinations.length
  const live = source.destinations.filter(d => d.worker?.state === 'live').length
  const anyOn = source.destinations.some(destOn)
  const problems = source.destinations.filter(d => d.worker?.state === 'failed').length
  const act = async (path: string) => {
    setBusy(true)
    try { await call('POST', `/api/sources/${source.id}/${path}`) } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }
  let line = ''
  if (!n) line = 'Add at least one place to send to.'
  else if (!anyOn) line = source.live.ready ? 'Video is coming in. Press Go live when you’re ready.' : 'You can press Go live now — sending starts as soon as video arrives.'
  else if (live === n) line = `Live on all ${n} ${n === 1 ? 'destination' : 'destinations'}.`
  else if (!source.live.ready) line = 'Ready. Waiting for video…'
  else line = `Live on ${live} of ${n}.`
  return (
    <section class={`card step golive ${anyOn ? 'is-on' : ''}`}>
      <div class="step-head">
        <span class="step-no">3</span>
        <div>
          <h2>{anyOn ? (live ? 'You’re live' : 'Getting ready') : 'Go live'}</h2>
          <p class="muted">{line}{problems ? ` ${problems} need${problems === 1 ? 's' : ''} attention — see above.` : ''}</p>
        </div>
        <span class="spacer" />
        {anyOn
          ? <button class="btn huge stop-solid" disabled={busy} onClick={() => act('stop-all')}>■ Stop everything</button>
          : <button class="btn huge go" disabled={busy || !n} onClick={() => act('start-all')}>● Go live</button>}
      </div>
    </section>
  )
}

// ---------- source page ----------

function SourcePage({ source, presets, state, onDeleted }: { source: Source; presets: Presets; state: State; onDeleted: () => void }) {
  const [del, setDel] = useState(false)
  const [rename, setRename] = useState(false)
  const [name, setName] = useState(source.name)
  return (
    <div class="stack">
      <div class="page-head">
        {rename
          ? <form class="row" onSubmit={async e => { e.preventDefault(); await call('PATCH', `/api/sources/${source.id}`, { name }); setRename(false) }}>
              <input type="text" value={name} autofocus onInput={e => setName(e.currentTarget.value)} />
              <button class="btn small primary">Save</button>
            </form>
          : <h1>{source.name} <button class="btn small ghost" aria-label="Rename" onClick={() => setRename(true)}>✎</button></h1>}
        <span class="spacer" />
        <button class="btn small danger-ghost" onClick={() => setDel(true)}>Delete stream</button>
      </div>
      {source.live.ready && !source.live.video && source.live.tracks.length > 0 && (
        <div class="warn-box"><b>Your stream has sound but no picture.</b> YouTube and Facebook stop streams like this after a few seconds. In OBS, add a camera, a screen capture or an image.</div>
      )}
      <VideoIn source={source} state={state} />
      <SendTo source={source} presets={presets} />
      <GoLive source={source} />
      {del && <ConfirmDelete what={`“${source.name}”`} onClose={() => setDel(false)} onYes={async () => { await call('DELETE', `/api/sources/${source.id}`); onDeleted() }} />}
    </div>
  )
}

// ---------- new stream ----------

function NewStream({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [kind, setKind] = useState<'ingest' | 'youtube' | 'url' | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const create = async (e: Event) => {
    e.preventDefault()
    setErr(null)
    try {
      const s = await call('POST', '/api/sources', { name: name || (kind === 'ingest' ? 'My stream' : 'Relay'), kind, url })
      if (kind !== 'ingest') await call('POST', `/api/sources/${s.id}/pull`, { on: true })
      onCreated(s.id)
    } catch (e: any) { setErr(e.message) }
  }
  return (
    <Modal title="New stream" onClose={onClose}>
      {!kind ? (
        <div class="choices">
          <button class="choice" onClick={() => setKind('ingest')}>
            <span class="big-icon" aria-hidden="true">🎥</span>
            <b>Stream from OBS</b>
            <span>You stream from your computer; we send it everywhere.</span>
          </button>
          <button class="choice" onClick={() => setKind('youtube')}>
            <span class="big-icon" aria-hidden="true">🔁</span>
            <b>Relay a YouTube live</b>
            <span>Already live on YouTube? Paste the link; we send it to Facebook and others.</span>
          </button>
          <button class="linkish" onClick={() => setKind('url')}>Other stream link (HLS, RTMP, SRT)…</button>
        </div>
      ) : (
        <form onSubmit={create}>
          {err && <div class="err-box">{err}</div>}
          <label class="field"><span>Name</span><input type="text" autofocus value={name} onInput={e => setName(e.currentTarget.value)} placeholder={kind === 'ingest' ? 'e.g. Main stage' : 'e.g. Meetup relay'} /></label>
          {kind !== 'ingest' && (
            <label class="field"><span>{kind === 'youtube' ? 'YouTube live link' : 'Stream link'}</span>
              <input type="url" required value={url} onInput={e => setUrl(e.currentTarget.value)} placeholder={kind === 'youtube' ? 'https://youtube.com/live/…' : 'https://…m3u8, rtmp://…, srt://…'} />
            </label>
          )}
          <div class="row end">
            <button type="button" class="btn" onClick={() => setKind(null)}>Back</button>
            <button class="btn primary">Create</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

// ---------- logs ----------

function Logs({ state }: { state: State }) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [only, setOnly] = useState<'all' | 'problems'>('all')
  const [src, setSrc] = useState('')
  const [q, setQ] = useState('')
  const [paused, setPaused] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const last = useRef(0)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await call<{ lines: LogLine[]; last: number }>('GET', `/api/logs?after=${last.current}&limit=1000`)
        if (!alive || !r.lines.length) return
        last.current = r.lines[r.lines.length - 1]!.seq
        setLines(cur => [...cur, ...r.lines].slice(-4000))
      } catch {}
    }
    load()
    const t = setInterval(load, 1000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return lines.filter(l =>
      l.level !== 'debug' &&
      (only === 'all' || l.level === 'warn' || l.level === 'error') &&
      (!src || l.sourceId === src) &&
      (!needle || l.text.toLowerCase().includes(needle) || l.origin.toLowerCase().includes(needle)))
  }, [lines, only, src, q])
  useEffect(() => { if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight }, [shown, paused])
  const download = () => {
    const txt = shown.map(l => `${new Date(l.ts).toISOString()} ${l.level.toUpperCase().padEnd(5)} [${l.origin}] ${l.text}`).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }))
    a.download = `streaming-pipeline-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <div class="stack">
      <div class="page-head"><h1>Logs</h1><span class="spacer" /><button class="btn small" onClick={download}>Download</button></div>
      <div class="card">
        <div class="log-tools">
          <div class="seg" role="radiogroup" aria-label="Show">
            <button role="radio" aria-checked={only === 'all'} class={only === 'all' ? 'on' : ''} onClick={() => setOnly('all')}>Everything</button>
            <button role="radio" aria-checked={only === 'problems'} class={only === 'problems' ? 'on' : ''} onClick={() => setOnly('problems')}>Problems only</button>
          </div>
          <select value={src} onChange={e => setSrc(e.currentTarget.value)} aria-label="Stream">
            <option value="">All streams</option>
            {state.sources.map(s => <option value={s.id}>{s.name}</option>)}
          </select>
          <input type="text" value={q} onInput={e => setQ(e.currentTarget.value)} placeholder="Search…" aria-label="Search logs" />
          <label class="check"><input type="checkbox" checked={!paused} onChange={e => setPaused(!e.currentTarget.checked)} /> Follow</label>
        </div>
        <div class="logview" ref={box} onScroll={e => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
          if (atBottom === paused) setPaused(!atBottom)
        }}>
          {shown.length === 0 && <p class="muted">Nothing to show yet.</p>}
          {shown.map(l => (
            <div key={l.seq} class={`ll lv-${l.level}`}>
              <time>{fmtTime(l.ts)}</time>
              <span class="origin">{l.origin}</span>
              <span class="text">{l.text}</span>
            </div>
          ))}
        </div>
        <p class="hint">Stream keys are hidden (••••) in everything shown here.</p>
      </div>
    </div>
  )
}

// ---------- shell ----------

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  return (
    <div class="login">
      <form class="card" onSubmit={async e => {
        e.preventDefault()
        try { await call('POST', '/api/login', { password: pw }); onDone() } catch (e: any) { setErr(e.message) }
      }}>
        <div class="brand big"><span class="brand-dot" />Streaming Pipeline</div>
        <p class="muted">Stream once, show up everywhere.</p>
        {err && <div class="err-box">{err}</div>}
        <label class="field"><span>Password</span><input type="password" autofocus value={pw} onInput={e => setPw(e.currentTarget.value)} /></label>
        <button class="btn primary wide">Sign in</button>
      </form>
    </div>
  )
}

function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [state, setState] = useState<State | null>(null)
  const [presets, setPresets] = useState<Presets | null>(null)
  const [view, setView] = useState<string>(() => location.hash.slice(1) || '')
  const [creating, setCreating] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  toastFn = m => { setMsg(m); setTimeout(() => setMsg(cur => (cur === m ? null : cur)), 4000) }

  useEffect(() => { call('GET', '/api/session').then(r => setSignedIn(r.signedIn)).catch(() => setSignedIn(false)) }, [])
  useEffect(() => {
    if (!signedIn) return
    call<Presets>('GET', '/api/presets').then(setPresets)
    const es = new EventSource('/api/stream')
    es.addEventListener('state', e => setState(JSON.parse((e as MessageEvent).data)))
    es.onerror = () => call('GET', '/api/session').then(r => { if (!r.signedIn) { es.close(); setSignedIn(false) } }).catch(() => {})
    return () => es.close()
  }, [signedIn])
  useEffect(() => { history.replaceState(null, '', view ? `#${view}` : location.pathname) }, [view])
  useEffect(() => {
    if (state && view !== 'logs' && (!view || !state.sources.some(s => s.id === view))) setView(state.sources[0]?.id ?? '')
  }, [state, view])

  if (signedIn === null) return null
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />
  const current = state?.sources.find(s => s.id === view) ?? null

  return (
    <>
      <header class="top">
        <div class="brand"><span class="brand-dot" />Streaming Pipeline</div>
        {state && !state.mediaServer && <span class="pill bad"><span class="dot" />Media server is down</span>}
        <span class="spacer" />
        <button class={`btn small ghost ${view === 'logs' ? 'active' : ''}`} onClick={() => setView('logs')}>Logs</button>
        <button class="btn small ghost" onClick={async () => { await call('POST', '/api/logout'); setSignedIn(false) }}>Sign out</button>
      </header>
      <div class="shell">
        <nav class="side" aria-label="Streams">
          <h2>Streams</h2>
          {state?.sources.map(s => {
            const live = s.destinations.filter(d => d.worker?.state === 'live').length
            return (
              <button class={`src-item ${s.id === view ? 'on' : ''}`} aria-current={s.id === view} onClick={() => setView(s.id)}>
                <span class={`dot ${live ? 'pulse' : ''}`} style={{ color: live ? 'var(--live)' : s.live.ready ? 'var(--ok)' : 'var(--wait)' }} />
                <span>{s.name}<small>{live ? `Live on ${live}` : s.live.ready ? 'Video in, not live' : 'Offline'}</small></span>
              </button>
            )
          })}
          <button class="btn primary new-btn" onClick={() => setCreating(true)}>+ New stream</button>
        </nav>
        <main class="main">
          {msg && <div class="toast" role="status">{msg}</div>}
          {!state || !presets ? <p class="muted">Loading…</p>
            : view === 'logs' ? <Logs state={state} />
            : current ? <SourcePage key={current.id} source={current} presets={presets} state={state} onDeleted={() => setView('')} />
            : (
              <div class="welcome card">
                <span class="big-icon" aria-hidden="true">📺</span>
                <h1>Stream once, show up everywhere</h1>
                <p class="muted">Send your video here one time; we pass it on to YouTube, Facebook and anywhere else — all at once.</p>
                <button class="btn primary huge" onClick={() => setCreating(true)}>Start a new stream</button>
              </div>
            )}
        </main>
      </div>
      {creating && <NewStream onClose={() => setCreating(false)} onCreated={id => { setCreating(false); setView(id) }} />}
    </>
  )
}

render(<App />, document.getElementById('app')!)
