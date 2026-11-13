import { expect, test } from 'bun:test'
import { mkdtempSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegLevel, LogBuffer, mediamtxLevel, tailFile } from '../src/logbuf'

test('ring buffer keeps the newest lines and pages by seq', () => {
  const b = new LogBuffer(3)
  for (let i = 1; i <= 5; i++) b.push({ level: 'info', origin: 'hub', sourceId: null, text: `l${i}` })
  expect(b.since(0).lines.map(l => l.text)).toEqual(['l3', 'l4', 'l5'])
  expect(b.since(4).lines.map(l => l.text)).toEqual(['l5'])
  expect(b.since(5).lines).toEqual([])
  expect(b.since(0, 1).lines.map(l => l.text)).toEqual(['l5'])
})

test('levels', () => {
  expect(ffmpegLevel('[flv @ 0x1] [error] Failed')).toBe('error')
  expect(ffmpegLevel('[warning] slow')).toBe('warn')
  expect(mediamtxLevel('2026/11/13 20:00:00 WAR [RTMP] x')).toBe('warn')
  expect(mediamtxLevel('2026/11/13 20:00:00 INF [RTMP] x')).toBe('info')
})

test('tailFile starts at the end, follows appends and survives truncation', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'tail-')), 'x.log')
  writeFileSync(f, 'from-before-the-restart\n')
  const got: string[] = []
  const stop = tailFile(f, l => got.push(l), 20)
  await Bun.sleep(60)
  appendFileSync(f, 'old\na\nb')
  await Bun.sleep(60)
  appendFileSync(f, 'c\n')
  await Bun.sleep(60)
  writeFileSync(f, 'new\n')
  await Bun.sleep(80)
  stop()
  expect(got).toEqual(['old', 'a', 'bc', 'new'])
})

test('tailFile empties the file past the size cap and keeps following', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'tail-')), 'x.log')
  writeFileSync(f, '')
  const got: string[] = []
  const stop = tailFile(f, l => got.push(l), 20, 10)
  await Bun.sleep(50)
  appendFileSync(f, 'aaaaaaaaaaaa\n')
  await Bun.sleep(60)
  expect(Bun.file(f).size).toBe(0)
  appendFileSync(f, 'b\n')
  await Bun.sleep(60)
  stop()
  expect(got).toEqual(['aaaaaaaaaaaa', 'b'])
})
