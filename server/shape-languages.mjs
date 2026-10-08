// Shapes every programming language's level-1 sections by what it really has:
//  - an empty section (no children, nothing listed) is removed.
//  - the sections are put in the canonical order.
// There is no "Package (L)" section: small packages live under "Library (L)",
// and manifest notes (Cargo.toml...) under "Package manager (L)".
// Idempotent.   node server/shape-languages.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = ['Fundamentals', 'Runtime', 'Module', 'Package manager', 'Library', 'Framework', 'Testing', 'Tooling', 'Best practices'];

fs.copyFileSync(DB_PATH, path.join(ROOT, 'server', 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-shape-languages.db`));
const db = openDb();
const langs = db.prepare("SELECT id, title FROM nodes WHERE parent_id IS NULL AND category = 'Language'").all();
const countKids = db.prepare('SELECT COUNT(*) c FROM nodes WHERE parent_id = ?');
const countRel = db.prepare('SELECT COUNT(*) c FROM relations WHERE node_id = ? OR related_id = ?');
for (const l of langs) {
  const secs = db.prepare("SELECT id, title FROM nodes WHERE parent_id = ? AND kind = 'item'").all(l.id);
  const rank = (s) => {
    const i = ORDER.findIndex((o) => s.title === `${o} (${l.title})`);
    return i < 0 ? ORDER.length : i;
  };
  const kept = [];
  for (const s of secs) {
    const known = rank(s) < ORDER.length;
    const empty = countKids.get(s.id).c === 0 && countRel.get(s.id, s.id).c === 0;
    if (known && empty && rank(s) !== 0) {
      for (const tbl of ['aliases', 'blocks']) db.prepare(`DELETE FROM ${tbl} WHERE node_id = ?`).run(s.id);
      db.prepare('DELETE FROM nodes WHERE id = ?').run(s.id);
      console.log(`${l.title}: bỏ mục rỗng ${s.title}`);
    } else kept.push(s);
  }
  kept.sort((a, b) => rank(a) - rank(b));
  kept.forEach((s, i) => db.prepare('UPDATE nodes SET order_index = ? WHERE id = ?').run(i + 1, s.id));
}
