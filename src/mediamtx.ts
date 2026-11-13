// MediaMTX control API (v3) — who is publishing, which tracks, how many bytes.

export interface PathInfo {
  name: string
  ready: boolean
  readyTime: string | null
  tracks: string[]
  bytesReceived: number
  bytesSent: number
  readers: number
  sourceType: string | null
}

const VIDEO = /^(H26[45]|AV1|VP[89]|MPEG-[124] Video|M-?JPEG)$/i
const AUDIO = /(Audio|Opus|AAC|G7|LPCM|AC-?3|MP3)/i

export const hasVideo = (tracks: string[]) => tracks.some(t => VIDEO.test(t))
export const hasAudio = (tracks: string[]) => tracks.some(t => AUDIO.test(t))

export class MediaMtx {
  constructor(private base: string, private fetcher: typeof fetch = fetch) {}

  async paths(): Promise<PathInfo[]> {
    const items: PathInfo[] = []
    for (let page = 0; page < 20; page++) {
      const r = await this.fetcher(`${this.base}/v3/paths/list?page=${page}&itemsPerPage=100`, { signal: AbortSignal.timeout(3000) })
      if (!r.ok) throw new Error(`MediaMTX API ${r.status}`)
      const j = (await r.json()) as { pageCount: number; items: any[] }
      for (const it of j.items ?? []) {
        items.push({
          name: it.name,
          ready: !!it.ready,
          readyTime: it.readyTime ?? null,
          tracks: Array.isArray(it.tracks) ? it.tracks.map(String) : [],
          bytesReceived: Number(it.bytesReceived ?? 0),
          bytesSent: Number(it.bytesSent ?? 0),
          readers: Array.isArray(it.readers) ? it.readers.length : 0,
          sourceType: it.source?.type ?? null,
        })
      }
      if (page + 1 >= (j.pageCount ?? 1)) break
    }
    return items
  }

  /** kick whoever is publishing a path (used when a source is deleted or its key rotated) */
  async kickPublisher(path: string): Promise<void> {
    const list = await this.paths()
    const p = list.find(x => x.name === path)
    if (!p?.ready) return
    for (const kind of ['rtmpconns', 'srtconns'] as const) {
      const r = await this.fetcher(`${this.base}/v3/${kind}/list?itemsPerPage=200`, { signal: AbortSignal.timeout(3000) })
      if (!r.ok) continue
      const j = (await r.json()) as { items: any[] }
      for (const c of j.items ?? []) {
        if (c.path === path && c.state === 'publish') {
          await this.fetcher(`${this.base}/v3/${kind}/kick/${c.id}`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {})
        }
      }
    }
  }
}
