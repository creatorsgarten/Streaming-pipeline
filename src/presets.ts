// Where people usually send streams, and how to encode for them.

export type Platform = 'youtube' | 'facebook' | 'twitch' | 'custom'

export const PLATFORMS: Record<Platform, { label: string; server: string; hint: string; needsRtmps?: boolean }> = {
  youtube: { label: 'YouTube', server: 'rtmp://a.rtmp.youtube.com/live2', hint: 'YouTube Studio → Go live → Stream → Stream key' },
  facebook: { label: 'Facebook', server: 'rtmps://live-api-s.facebook.com:443/rtmp', hint: 'Live Producer → Go live → Streaming software → Stream key', needsRtmps: true },
  twitch: { label: 'Twitch', server: 'rtmp://live.twitch.tv/app', hint: 'Creator dashboard → Settings → Stream → Primary stream key' },
  custom: { label: 'Custom RTMP / SRT', server: '', hint: 'Any rtmp://, rtmps:// or srt:// server' },
}

export type ProfileId = 'copy' | '1080p60' | '1080p30' | '720p60' | '720p30' | '480p30'

export interface Profile {
  label: string
  /** null = pass the source through untouched */
  video: null | { width: number; height: number; fps: number; kbps: number }
  audioKbps: number
}

export const PROFILES: Record<ProfileId, Profile> = {
  copy: { label: 'Pass-through (no re-encode, lowest CPU)', video: null, audioKbps: 0 },
  '1080p60': { label: '1080p 60 fps · 6 Mbps', video: { width: 1920, height: 1080, fps: 60, kbps: 6000 }, audioKbps: 160 },
  '1080p30': { label: '1080p 30 fps · 4.5 Mbps', video: { width: 1920, height: 1080, fps: 30, kbps: 4500 }, audioKbps: 160 },
  '720p60': { label: '720p 60 fps · 4.5 Mbps', video: { width: 1280, height: 720, fps: 60, kbps: 4500 }, audioKbps: 128 },
  '720p30': { label: '720p 30 fps · 3 Mbps', video: { width: 1280, height: 720, fps: 30, kbps: 3000 }, audioKbps: 128 },
  '480p30': { label: '480p 30 fps · 1.5 Mbps', video: { width: 854, height: 480, fps: 30, kbps: 1500 }, audioKbps: 96 },
}

export const isProfile = (p: string): p is ProfileId => p in PROFILES
export const isPlatform = (p: string): p is Platform => p in PLATFORMS

/** joins server + key the way each service expects (a slash between, no doubles) */
export function joinTarget(server: string, key: string): string {
  if (!key) return server
  if (server.startsWith('srt://')) {
    // SRT targets carry the key as streamid
    const u = new URL(server)
    if (!u.searchParams.has('streamid')) u.searchParams.set('streamid', key)
    return u.toString()
  }
  return `${server.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`
}

export function targetProblem(server: string): string | null {
  let u: URL
  try { u = new URL(server) } catch { return 'Server must be a URL like rtmp://host/app' }
  if (!['rtmp:', 'rtmps:', 'srt:'].includes(u.protocol)) return 'Server must start with rtmp://, rtmps:// or srt://'
  if (!u.hostname) return 'Server needs a host name'
  return null
}
