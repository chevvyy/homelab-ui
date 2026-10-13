// Local state: deploy history and an audit log of actions. Small SQLite file on a PVC; the
// cluster itself remains the source of truth for what is deployed.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
export const dbPath = join(config.dataDir, 'homelab-ui.db');
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    ok INTEGER NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_target ON audit(target, at);
  CREATE TABLE IF NOT EXISTS builds (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    user TEXT NOT NULL,
    app TEXT NOT NULL,
    namespace TEXT NOT NULL,
    state TEXT NOT NULL,
    data TEXT NOT NULL
  );
`);

const insertAudit = db.prepare('INSERT INTO audit (at, user, action, target, ok, detail) VALUES (?, ?, ?, ?, ?, ?)');

export function audit(user: string, action: string, target: string, ok: boolean, detail?: unknown) {
  try {
    insertAudit.run(Date.now(), user, action, target, ok ? 1 : 0, detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 4000));
  } catch (e) {
    console.error('audit write failed', e);
  }
}

export function recentAudit(target?: string, limit = 100) {
  const rows = target
    ? db.prepare('SELECT * FROM audit WHERE target = ? OR target LIKE ? ORDER BY at DESC LIMIT ?').all(target, `${target}/%`, limit)
    : db.prepare('SELECT * FROM audit ORDER BY at DESC LIMIT ?').all(limit);
  return rows.map((r: any) => ({ ...r, ok: !!r.ok }));
}

export function saveBuild(b: { id: string; at: number; user: string; app: string; namespace: string; state: string; data: unknown }) {
  db.prepare('INSERT INTO builds (id, at, user, app, namespace, state, data) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data').run(
    b.id, b.at, b.user, b.app, b.namespace, b.state, JSON.stringify(b.data),
  );
}

export function listBuilds(limit = 50) {
  return db.prepare('SELECT * FROM builds ORDER BY at DESC LIMIT ?').all(limit).map((r: any) => ({ ...r, data: JSON.parse(r.data) }));
}

export function getBuild(id: string) {
  const r: any = db.prepare('SELECT * FROM builds WHERE id = ?').get(id);
  return r ? { ...r, data: JSON.parse(r.data) } : undefined;
}

// Consistent online copy for the nightly backup job.
export function backupTo(path: string) {
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
}
