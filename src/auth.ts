// One admin password → a signed, HttpOnly session cookie. Logins are rate limited per IP.

import type { Database } from 'bun:sqlite'
import { safeEqual, type Vault } from './crypto'

const COOKIE = 'hub_session'
const SESSION_MS = 12 * 60 * 60 * 1000
const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 10

export class Auth {
  constructor(private db: Database, private vault: Vault, private password: string, private secure: boolean, private now = Date.now) {}

  /** null = ok, otherwise the error to show */
  async login(ip: string, password: string): Promise<{ cookie: string } | { error: string; status: number }> {
    const since = this.now() - WINDOW_MS
    this.db.query('DELETE FROM login_attempts WHERE ts < ?').run(since)
    const n = this.db.query<{ n: number }, [string, number]>('SELECT count(*) AS n FROM login_attempts WHERE ip = ? AND ts >= ?').get(ip, since)?.n ?? 0
    if (n >= MAX_ATTEMPTS) return { error: 'Too many attempts — try again in 15 minutes', status: 429 }
    if (!safeEqual(password, this.password)) {
      this.db.query('INSERT INTO login_attempts (ip, ts) VALUES (?, ?)').run(ip, this.now())
      return { error: 'Wrong password', status: 401 }
    }
    this.db.query('DELETE FROM login_attempts WHERE ip = ?').run(ip)
    const token = await this.vault.sign(`s1:${this.now() + SESSION_MS}`)
    return { cookie: this.cookie(token, SESSION_MS / 1000) }
  }

  logoutCookie() { return this.cookie('', 0) }

  async valid(req: Request): Promise<boolean> {
    const raw = req.headers.get('cookie') ?? ''
    const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))
    if (!m) return false
    const payload = await this.vault.verify(decodeURIComponent(m[1]!))
    if (!payload?.startsWith('s1:')) return false
    return Number(payload.slice(3)) > this.now()
  }

  private cookie(value: string, maxAge: number) {
    return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`
  }
}

/** state-changing requests must be JSON (or bodiless) and come from our own origin */
export function csrfProblem(req: Request): string | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null
  const origin = req.headers.get('origin')
  if (origin) {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
    try {
      if (new URL(origin).host !== host) return 'Cross-site request refused'
    } catch { return 'Bad origin' }
  }
  const len = req.headers.get('content-length')
  const ct = req.headers.get('content-type') ?? ''
  if (len && len !== '0' && !ct.startsWith('application/json')) return 'Send JSON'
  return null
}
