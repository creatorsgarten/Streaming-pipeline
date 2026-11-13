// Turning a YouTube Live page into an HLS URL ffmpeg can read.
// The URL is signed for the IP that asked and expires after ~6 h, so it is resolved inside the
// same container that runs ffmpeg, over IPv4 only, and again every time the puller restarts.

export function isYoutubeUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname.replace(/^www\.|^m\./, '')
    return h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com')
  } catch { return false }
}

export interface Resolved {
  /** one URL (muxed) or two (video, audio) — some YouTube clients only offer split streams */
  urls: string[]
  /** unix ms; null when YouTube didn't say */
  expiresAt: number | null
  title: string | null
  live: boolean
}

type Run = (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

const defaultRun: Run = async cmd => {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => p.kill(), 60_000)
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(timer)
  return { code, stdout, stderr }
}

/** best H.264 HLS up to maxHeight (H.264 so pass-through works everywhere), muxed or video+audio */
export async function resolveYoutube(pageUrl: string, opts: { bin?: string; maxHeight?: number; run?: Run } = {}): Promise<Resolved> {
  const h = opts.maxHeight ?? 1080
  const cmd = [
    opts.bin ?? 'yt-dlp', '--no-update', '--no-warnings', '--force-ipv4', '--js-runtimes', 'bun',
    '-f', [
      `best[protocol^=m3u8][vcodec^=avc1][height<=${h}]`,
      `bestvideo[protocol^=m3u8][vcodec^=avc1][height<=${h}]+bestaudio[protocol^=m3u8]`,
      `best[protocol^=m3u8][height<=${h}]`,
      `bestvideo[protocol^=m3u8][height<=${h}]+bestaudio[protocol^=m3u8]`,
      'best[protocol^=m3u8]',
    ].join('/'),
    '--print', '%(live_status)s\t%(title)s', '-g', pageUrl,
  ]
  const r = await (opts.run ?? defaultRun)(cmd)
  if (r.code !== 0) {
    const err = r.stderr.split('\n').find(l => l.startsWith('ERROR')) ?? r.stderr.trim().split('\n').pop() ?? 'yt-dlp failed'
    throw new Error(err.replace(/^ERROR:\s*/, '').slice(0, 300))
  }
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  const urls = lines.filter(l => /^https?:\/\//.test(l)).slice(0, 2)
  if (!urls.length) throw new Error('yt-dlp returned no stream URL')
  const meta = lines.find(l => l.includes('\t'))?.split('\t') ?? []
  const exp = urls[0]!.match(/\/expire\/(\d+)/) ?? urls[0]!.match(/[?&]expire=(\d+)/)
  return {
    urls,
    expiresAt: exp ? Number(exp[1]) * 1000 : null,
    title: meta[1] ?? null,
    live: meta[0] === 'is_live',
  }
}
