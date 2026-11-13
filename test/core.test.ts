import { describe, expect, test } from 'bun:test'
import { Vault, safeEqual } from '../src/crypto'
import { backoffMs, classifyExit, ProgressParser, pullArgs, pushArgs } from '../src/ffmpeg'
import { hasAudio, hasVideo } from '../src/mediamtx'
import { joinTarget, targetProblem } from '../src/presets'
import { Redactor, scrubUrls } from '../src/redact'
import { isYoutubeUrl, resolveYoutube } from '../src/youtube'

describe('redaction', () => {
  test('masks the key in the exact ffmpeg error the user hit', () => {
    const line = 'Error writing trailer of rtmp://b.rtmp.youtube.com/live2?backup=1/abcd-1234-efgh-5678-ijkl: Broken pipe'
    const r = new Redactor()
    expect(r.scrub(line)).not.toContain('abcd-1234-efgh-5678-ijkl')
    expect(r.scrub(line)).toContain('Broken pipe')
  })
  test('masks registered secrets anywhere, longest first', () => {
    const r = new Redactor()
    r.add('abcd1234', 'abcd1234XYZ')
    expect(r.scrub('k=abcd1234XYZ and abcd1234')).toBe('k=•••• and ••••')
  })
  test('masks rtmps facebook keys, userinfo and query secrets', () => {
    expect(scrubUrls('rtmps://live-api-s.facebook.com:443/rtmp/FB-1234567890-0-Abc')).toBe('rtmps://live-api-s.facebook.com:443/rtmp/••••')
    expect(scrubUrls('rtmp://mediamtx:1935/live/x?user=hub&pass=supersecret')).not.toContain('supersecret')
    expect(scrubUrls('https://u:p4ss@host/x')).toBe('https://••••@host/x')
    expect(scrubUrls('srt://h:1?streamid=publish:live/x:pub:secret')).not.toContain('secret')
  })
  test('a run ending never unmasks a permanent key', () => {
    const r = new Redactor()
    r.add('FB-not-a-real-key-000')
    r.addTemp('FB-not-a-real-key-000', 'rtmps://x/rtmp/FB-not-a-real-key-000')
    r.removeTemp('FB-not-a-real-key-000', 'rtmps://x/rtmp/FB-not-a-real-key-000')
    expect(r.scrub("closed: path 'live/FB-not-a-real-key-000' is not configured")).toBe("closed: path 'live/••••' is not configured")
  })
  test('temporary values are counted across overlapping runs', () => {
    const r = new Redactor()
    r.addTemp('signed-url-1'); r.addTemp('signed-url-1')
    r.removeTemp('signed-url-1')
    expect(r.scrub('signed-url-1')).toBe('••••')
    r.removeTemp('signed-url-1')
    expect(r.scrub('signed-url-1')).toBe('signed-url-1')
  })
})

describe('vault', () => {
  test('seal/open round trip, bound to the row id', async () => {
    const v = await Vault.create('x'.repeat(40))
    const s = await v.seal('stream-key', 'dst_1')
    expect(s.startsWith('v1.')).toBe(true)
    expect(s).not.toContain('stream-key')
    expect(await v.open(s, 'dst_1')).toBe('stream-key')
    await expect(v.open(s, 'dst_2')).rejects.toThrow()
  })
  test('a different secret cannot open it', async () => {
    const a = await Vault.create('a'.repeat(40)), b = await Vault.create('b'.repeat(40))
    await expect(b.open(await a.seal('k', 'id'), 'id')).rejects.toThrow()
  })
  test('sign/verify rejects tampering', async () => {
    const v = await Vault.create('x'.repeat(40))
    const t = await v.sign('s1:123')
    expect(await v.verify(t)).toBe('s1:123')
    expect(await v.verify(t.replace('s1:123', 's1:999'))).toBeNull()
    expect(await v.verify('garbage')).toBeNull()
  })
  test('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('ffmpeg', () => {
  test('progress parser handles chunks split mid-line', () => {
    const got: any[] = []
    const p = new ProgressParser((x, ended) => got.push({ ...x, ended }))
    p.push('frame=120\nfps=30.0\nbitr')
    p.push('ate=2500.5kbits/s\ntotal_size=1000\nout_time_us=4000000\nspeed=1.01x\ndrop_frames=2\nprogress=continue\n')
    p.push('frame=150\nprogress=end\n')
    expect(got).toHaveLength(2)
    expect(got[0]).toMatchObject({ frame: 120, fps: 30, kbps: 2500.5, totalBytes: 1000, outTimeMs: 4000, speed: 1.01, dropFrames: 2, ended: false })
    expect(got[1]).toMatchObject({ frame: 150, ended: true })
  })
  test('N/A values become 0', () => {
    const got: any[] = []
    new ProgressParser(x => got.push(x)).push('bitrate=N/A\nspeed=N/A\nprogress=continue\n')
    expect(got[0].kbps).toBe(0)
    expect(got[0].speed).toBe(0)
  })
  test('classifies exits', () => {
    expect(classifyExit(1, ['Server returned 403 Forbidden'], 'push').kind).toBe('fatal')
    expect(classifyExit(1, ['NetStream.Publish.BadName'], 'push').kind).toBe('fatal')
    expect(classifyExit(1, ['av_interleaved_write_frame(): Broken pipe'], 'push')).toEqual({ kind: 'retry', reason: 'The destination closed the connection' })
    expect(classifyExit(1, ['Connection refused'], 'push').kind).toBe('retry')
    expect(classifyExit(0, [], 'push').kind).toBe('retry')
    // an expired signed source link is not a bad stream key
    expect(classifyExit(1, ['[https @ 0x1] HTTP error 403 Forbidden'], 'pull').kind).toBe('retry')
    expect(classifyExit(1, ['[https @ 0x1] HTTP error 403 Forbidden'], 'push').kind).toBe('fatal')
  })
  test('backoff grows and caps', () => {
    const fixed = () => 0.5
    expect(backoffMs(0, 60_000, fixed)).toBe(1000)
    expect(backoffMs(3, 60_000, fixed)).toBe(8000)
    expect(backoffMs(20, 60_000, fixed)).toBe(60_000)
  })
  test('copy profile passes through, flv out', () => {
    const a = pushArgs('rtmp://in/live/x', 'rtmp://out/app/key', 'copy')
    expect(a).toContain('-c')
    expect(a[a.indexOf('-c') + 1]).toBe('copy')
    expect(a.slice(-1)[0]).toBe('rtmp://out/app/key')
    expect(a).toContain('flv')
    expect(a).toContain('-progress')
  })
  test('transcode profile sets 2 s keyframes and yuv420p', () => {
    const a = pushArgs('rtmp://in/live/x', 'rtmp://out/app/key', '720p30')
    expect(a[a.indexOf('-g') + 1]).toBe('60')
    expect(a).toContain('yuv420p')
    expect(a).toContain('libx264')
    expect(a[a.indexOf('-b:v') + 1]).toBe('3000k')
  })
  test('srt outputs are mpegts', () => {
    const a = pushArgs('rtmp://in/live/x', 'srt://h:9000?streamid=k', 'copy')
    expect(a[a.indexOf('-f', a.indexOf('-c')) + 1]).toBe('mpegts')
  })
  test('pull args: http gets reconnect, recordings get -re', () => {
    const a = pullArgs('https://x/y.m3u8', 'rtmp://mtx/live/s', { realtime: true })
    expect(a).toContain('-reconnect')
    expect(a).toContain('-re')
    expect(pullArgs('rtmp://x/y', 'rtmp://mtx/live/s')).not.toContain('-reconnect')
  })
})

describe('presets', () => {
  test('joinTarget', () => {
    expect(joinTarget('rtmp://a.rtmp.youtube.com/live2/', 'abc')).toBe('rtmp://a.rtmp.youtube.com/live2/abc')
    expect(joinTarget('rtmps://live-api-s.facebook.com:443/rtmp', 'FB-1')).toBe('rtmps://live-api-s.facebook.com:443/rtmp/FB-1')
    expect(joinTarget('srt://h:9000', 'k')).toBe('srt://h:9000?streamid=k')
    expect(joinTarget('rtmp://h/app', '')).toBe('rtmp://h/app')
  })
  test('targetProblem', () => {
    expect(targetProblem('rtmp://h/app')).toBeNull()
    expect(targetProblem('https://h/app')).not.toBeNull()
    expect(targetProblem('nope')).not.toBeNull()
  })
})

describe('mediamtx tracks', () => {
  test('video/audio detection', () => {
    expect(hasVideo(['H264', 'MPEG-4 Audio'])).toBe(true)
    expect(hasVideo(['MPEG-4 Audio'])).toBe(false)
    expect(hasAudio(['MPEG-4 Audio'])).toBe(true)
    expect(hasAudio(['Opus'])).toBe(true)
  })
})

describe('youtube', () => {
  test('recognises links', () => {
    expect(isYoutubeUrl('https://youtube.com/live/abcdefghijk')).toBe(true)
    expect(isYoutubeUrl('https://youtu.be/abc')).toBe(true)
    expect(isYoutubeUrl('https://m.youtube.com/watch?v=x')).toBe(true)
    expect(isYoutubeUrl('https://notyoutube.com/x')).toBe(false)
  })
  test('resolve parses url, expiry, title and asks for IPv4', async () => {
    let cmd: string[] = []
    const r = await resolveYoutube('https://youtube.com/live/x', {
      run: async c => { cmd = c; return { code: 0, stdout: 'is_live\tMy Talk\nhttps://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1794595468/ip/1.2.3.4/index.m3u8\n', stderr: '' } },
    })
    expect(cmd).toContain('--force-ipv4')
    expect(r).toEqual({ urls: [expect.stringContaining('manifest.googlevideo.com')], expiresAt: 1794595468000, title: 'My Talk', live: true })
  })
  test('split video + audio come back as two URLs and become two inputs', async () => {
    const r = await resolveYoutube('https://youtube.com/live/x', {
      run: async () => ({ code: 0, stdout: 'is_live\tT\nhttps://v.example/expire/5/v.m3u8\nhttps://a.example/a.m3u8\n', stderr: '' }),
    })
    expect(r.urls).toEqual(['https://v.example/expire/5/v.m3u8', 'https://a.example/a.m3u8'])
    const a = pullArgs(r.urls, 'rtmp://mtx/live/s')
    expect(a.filter(x => x === '-i')).toHaveLength(2)
    expect(a.join(' ')).toContain('-map 0:v:0 -map 1:a:0')
  })
  test('resolve surfaces the yt-dlp error', async () => {
    await expect(resolveYoutube('https://youtube.com/live/x', { run: async () => ({ code: 1, stdout: '', stderr: 'WARNING: x\nERROR: [youtube] x: This live event has ended.' }) }))
      .rejects.toThrow('[youtube] x: This live event has ended.')
  })
})
