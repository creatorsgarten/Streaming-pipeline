// Stream keys must never reach logs, the event log or the browser. ffmpeg happily prints the
// full output URL in its errors ("Error writing trailer of rtmp://…/<key>"), so every line
// that leaves a child process goes through here.

export class Redactor {
  /** stream keys, publish keys, internal token: masked for as long as the process lives */
  private fixed = new Set<string>()
  /** per-run values (signed URLs, full output URLs), counted so overlapping runs don't unmask each other */
  private temp = new Map<string, number>()

  add(...values: (string | null | undefined)[]) {
    for (const v of values) if (v && v.length >= 4) this.fixed.add(v)
  }

  addTemp(...values: (string | null | undefined)[]) {
    for (const v of values) if (v && v.length >= 4) this.temp.set(v, (this.temp.get(v) ?? 0) + 1)
  }

  /** releases a run's values; never touches the permanent ones */
  removeTemp(...values: (string | null | undefined)[]) {
    for (const v of values) {
      if (!v) continue
      const n = (this.temp.get(v) ?? 0) - 1
      if (n > 0) this.temp.set(v, n)
      else this.temp.delete(v)
    }
  }

  scrub(text: string): string {
    let out = text
    // longest first so a key that contains another key is fully masked
    const all = new Set([...this.fixed, ...this.temp.keys()])
    for (const s of [...all].sort((a, b) => b.length - a.length)) out = out.split(s).join('••••')
    return scrubUrls(out)
  }
}

/**
 * Masks what looks like a credential in any URL even if we never registered it:
 * the last path segment of rtmp(s)/srt URLs, user:pass@, and key/pass/token/streamid query values.
 */
export function scrubUrls(text: string): string {
  return text
    .replace(/\b(?:rtmps?|rtmpt|srt):\/\/[^\s'"]+/gi, url => {
      // the key is the last path segment, wherever a query sits (YouTube's backup URL is live2?backup=1/<key>)
      const m = url.match(/^(.*?)([:,;.]*)$/)!
      const body = m[1]!, trail = m[2]!
      const at = body.lastIndexOf('/')
      const head = body.slice(0, at), last = body.slice(at + 1).replace(/\?.*$/, '')
      const masked = at > body.indexOf('://') + 2 && last.length >= 6 ? `${head}/••••` : body
      return masked + trail
    })
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+:[^\s/@'"]+@/gi, '$1••••@')
    .replace(/([?&](?:key|pass|password|token|streamid|passphrase|sig|signature)=)[^&\s'"]+/gi, '$1••••')
}
