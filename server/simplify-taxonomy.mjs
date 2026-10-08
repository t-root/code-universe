// Final taxonomy: two axes, nothing redundant.
//
//   category (which LAYER / DOMAIN):
//     Language Module Library Framework Web Database Tooling
//     Runtime Testing AI Concept
//   kind (WHAT it is):
//     item     a folder that groups (sections, "Array", "Iterating arrays")
//     concept  an explanation page
//     function a callable: function, method, command
//     type     a data type or class
//     element  a piece of syntax or markup: property, attribute, tag, event, directive
//
// A folder (kind item) has no category of its own: it takes the one of what it
// holds (Library -> Library, Package manager -> Tooling, Data type -> Concept...).
// Idempotent; backs the database up first.
//
//   node server/simplify-taxonomy.mjs          apply
//   DRY=1 node server/simplify-taxonomy.mjs    only count
import fs from 'node:fs';
import path from 'node:path';
import { openDb, DB_PATH } from './db.js';

const DRY = !!process.env.DRY;
const db = openDb();

const CATEGORIES = {
  Language: ['#00FF66', 1.4],
  Module: ['#C8FF4D', 0.95],
  Library: ['#FFD84D', 1.1],
  Framework: ['#FF8A3D', 1.25],
  Web: ['#A07CFF', 1],
  Database: ['#3DFFC8', 1],
  Tooling: ['#9FB3C8', 0.9],
  Runtime: ['#7FD1E8', 1],
  Testing: ['#A5E36B', 0.9],
  AI: ['#FF5CF0', 1],
  Concept: ['#3AB0FF', 1],
};
const KINDS = [
  ['concept', 'CONCEPT', 0],
  ['item', 'SECTION', 1],
  ['function', 'FUNCTION', 2],
  ['type', 'TYPE', 3],
  ['element', 'ELEMENT', 4],
];
const CATEGORY_OF_OLD = { Algorithm: 'Concept', Pattern: 'Concept', Security: 'Concept', Network: 'Concept', DevOps: 'Tooling', Section: null, Package: 'Tooling' };
const KIND_OF_OLD = {
  topic: 'concept', algorithm: 'concept', method: 'function', command: 'function',
  property: 'element', tag: 'element', event: 'element', directive: 'element',
};
// A section (or anything inside it) takes this category.
const SECTION_CAT = [
  [/^Library \(/, 'Library'], [/^Framework \(/, 'Framework'], [/^Package manager \(/, 'Tooling'], [/^Package \(/, 'Library'],
  [/^Module \(/, 'Module'], [/^Testing \(/, 'Testing'], [/^Tooling \(/, 'Tooling'], [/^Runtime \(/, 'Runtime'],
];
const SPECIAL = new Set(['HTML', 'CSS', 'SQL']);

const nodes = db.prepare('SELECT id, parent_id, title, kind, category FROM nodes').all();
const byId = new Map(nodes.map((n) => [n.id, n]));
const top = (n) => {
  let t = n;
  while (t.parent_id !== null) t = byId.get(t.parent_id);
  return t;
};
const chain = (n) => {
  const list = [n];
  for (let p = byId.get(n.parent_id); p; p = byId.get(p.parent_id)) list.push(p);
  return list;
};
const sectionCat = (n) => {
  for (const a of chain(n)) {
    if (a.kind !== 'item') continue;
    for (const [re, c] of SECTION_CAT) if (re.test(a.title)) return c;
  }
  return null;
};

const result = new Map();
for (const n of nodes) {
  const t = top(n);
  let cat = n.category in CATEGORY_OF_OLD ? CATEGORY_OF_OLD[n.category] : n.category;
  // Mobile folded away: Android / iOS are platforms (Runtime), the rest frameworks.
  if (cat === 'Mobile') cat = ['Android', 'iOS'].includes(t.title) ? 'Runtime' : 'Framework';
  if (n.kind === 'item' || cat === null) {
    if (n.parent_id === null) cat = 'Concept';
    else if (t.title === 'SQL') cat = 'Database';
    else if (SPECIAL.has(t.title)) cat = 'Web';
    else if (t.category !== 'Language') cat = CATEGORY_OF_OLD[t.category] || t.category;
    else cat = sectionCat(n) ?? 'Concept';
  }
  result.set(n.id, { category: cat, kind: KIND_OF_OLD[n.kind] ?? n.kind });
}

const count = (key) => {
  const m = new Map();
  for (const v of result.values()) m.set(v[key], (m.get(v[key]) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}: ${c}`).join(' | ');
};
console.log('category:', count('category'));
console.log('kind:', count('kind'));
const bad = [...new Set([...result.values()].map((v) => v.category))].filter((c) => !CATEGORIES[c]);
const badK = [...new Set([...result.values()].map((v) => v.kind))].filter((k) => !KINDS.some(([n]) => n === k));
if (bad.length || badK.length) throw new Error(`lạ: ${[...bad, ...badK].join(', ')}`);
if (DRY) process.exit(0);

fs.copyFileSync(DB_PATH, path.join(path.dirname(DB_PATH), 'backups', `data-${Date.now()}-taxonomy.db`));
db.exec('BEGIN');
for (const [name, [color, scale]] of Object.entries(CATEGORIES)) {
  if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name)) db.prepare('UPDATE categories SET color = ?, scale = ? WHERE name = ?').run(color, scale, name);
  else db.prepare('INSERT INTO categories (name, color, scale) VALUES (?, ?, ?)').run(name, color, scale);
}
for (const [name, label, order] of KINDS) {
  if (db.prepare('SELECT 1 FROM kinds WHERE name = ?').get(name)) db.prepare('UPDATE kinds SET label = ?, sort_order = ? WHERE name = ?').run(label, order, name);
  else db.prepare('INSERT INTO kinds (name, label, sort_order) VALUES (?, ?, ?)').run(name, label, order);
}
const upd = db.prepare('UPDATE nodes SET category = ?, kind = ? WHERE id = ?');
for (const [id, v] of result) {
  const n = byId.get(id);
  if (n.category !== v.category || n.kind !== v.kind) upd.run(v.category, v.kind, id);
}
for (const { name } of db.prepare('SELECT name FROM categories').all()) if (!CATEGORIES[name]) db.prepare('DELETE FROM categories WHERE name = ?').run(name);
for (const { name } of db.prepare('SELECT name FROM kinds').all()) if (!KINDS.some(([n]) => n === name)) db.prepare('DELETE FROM kinds WHERE name = ?').run(name);
db.exec('COMMIT');
console.log('xong');
