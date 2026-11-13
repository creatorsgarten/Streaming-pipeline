// AES-256-GCM for stream keys at rest, HMAC for sessions. Keys are derived from HUB_SECRET
// with HKDF so the two uses never share key material.

const enc = new TextEncoder()
const dec = new TextDecoder()

const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

async function derive(secret: string, info: string, usage: 'AES-GCM' | 'HMAC'): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey'])
  const params = { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('streaming-pipeline/v1'), info: enc.encode(info) }
  return usage === 'AES-GCM'
    ? crypto.subtle.deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    : crypto.subtle.deriveKey(params, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'])
}

export class Vault {
  private constructor(private aes: CryptoKey, private mac: CryptoKey) {}

  static async create(secret: string) {
    return new Vault(await derive(secret, 'stream-keys', 'AES-GCM'), await derive(secret, 'sessions', 'HMAC'))
  }

  /** "v1.<iv>.<ciphertext>" — the id of the row is bound as associated data so ciphertexts can't be swapped between rows */
  async seal(plain: string, aad: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, this.aes, enc.encode(plain))
    return `v1.${b64(iv)}.${b64(ct)}`
  }

  async open(sealed: string, aad: string): Promise<string> {
    const [v, iv, ct] = sealed.split('.')
    if (v !== 'v1' || !iv || !ct) throw new Error('bad sealed value')
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(aad) }, this.aes, unb64(ct))
    return dec.decode(pt)
  }

  async sign(payload: string): Promise<string> {
    return `${payload}.${b64(await crypto.subtle.sign('HMAC', this.mac, enc.encode(payload)))}`
  }

  /** returns the payload when the signature is valid */
  async verify(token: string): Promise<string | null> {
    const i = token.lastIndexOf('.')
    if (i <= 0) return null
    const payload = token.slice(0, i)
    try {
      return (await crypto.subtle.verify('HMAC', this.mac, unb64(token.slice(i + 1)), enc.encode(payload))) ? payload : null
    } catch { return null }
  }
}

export const randomToken = (bytes = 24) => b64(crypto.getRandomValues(new Uint8Array(bytes)))

/** constant-time string compare */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
