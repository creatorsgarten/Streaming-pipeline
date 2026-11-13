// SQLite storage (bun:sqlite). Migrations are numbered and run once each.

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Platform, ProfileId } from './presets'

export type SourceKind = 'ingest' | 'youtube' | 'url'

export interface SourceRow {
  id: string
  name: string
  /** MediaMTX path is live/<slug> */
  slug: string
  kind: SourceKind
  /** sealed publish secret (ingest) */
  publish_key: string | null
  /** youtube / url sources */
  pull_url: string | null
  pull_realtime: number
  /** start pulling as soon as the hub boots */
  pull_enabled: number
  created_at: number
}

export interface DestRow {
  id: string
  source_id: string
  name: string
  platform: Platform
  server: string
  /** sealed stream key */
  stream_key: string | null
  profile: ProfileId
  enabled: number
  /** go live automatically whenever the source is live */
  auto_start: number
  created_at: number
}

export interface EventRow {
  id: number
  ts: number
  level: 'info' | 'warn' | 'error'
  source_id: string | null
  dest_id: string | null
  message: string
}

const MIGRATIONS: string[] = [
  `CREATE TABLE sources (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 3 AND 40),
     kind TEXT NOT NULL CHECK (kind IN ('ingest','youtube','url')),
     publish_key TEXT,
     pull_url TEXT,
     pull_realtime INTEGER NOT NULL DEFAULT 0,
     pull_enabled INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE destinations (
     id TEXT PRIMARY KEY,
     source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     platform TEXT NOT NULL,
     server TEXT NOT NULL,
     stream_key TEXT,
     profile TEXT NOT NULL DEFAULT 'copy',
     enabled INTEGER NOT NULL DEFAULT 1,
     auto_start INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX destinations_source ON destinations(source_id);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     level TEXT NOT NULL,
     source_id TEXT,
     dest_id TEXT,
     message TEXT NOT NULL
   );
   CREATE INDEX events_ts ON events(ts);
   CREATE TABLE login_attempts (ip TEXT NOT NULL, ts INTEGER NOT NULL);
   CREATE INDEX login_attempts_ip ON login_attempts(ip, ts);`,
]

export function openDb(dir: string | ':memory:'): Database {
  let db: Database
  if (dir === ':memory:') db = new Database(':memory:')
  else {
    mkdirSync(dir, { recursive: true })
    db = new Database(join(dir, 'hub.sqlite'), { create: true })
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)')
  const row = db.query<{ v: number }, []>('SELECT v FROM schema_version').get()
  let v = row?.v ?? 0
  if (!row) db.exec('INSERT INTO schema_version (v) VALUES (0)')
  for (; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.exec(`UPDATE schema_version SET v = ${v + 1}`)
    })()
  }
  return db
}

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`

export const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 32) || 'stream'
