// Flattens server/data.db into public/data.json — the ONLY thing the app
// reads at runtime (src/api.js fetches it once, client-side). This is what
// lets `npm run build` produce a dist/ that's a plain static site with no
// backend: the SQLite database only exists as the authoring source, read
// by this script at build/dev time, never shipped to the browser.
//
// Run automatically before `dev`/`build` (see package.json `pre*` scripts);
// run by hand after editing data.db directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/data.json');

const db = openDb();

const rows = db
  .prepare(
    `SELECT n.id, n.parent_id, n.kind, k.label AS kind_label, k.sort_order AS kind_rank,
        n.title, n.category, cat.color, cat.scale, n.language, n.importance,
        n.order_index, n.description, n.raw_text
     FROM nodes n
     JOIN categories cat ON cat.name = n.category
     JOIN kinds k ON k.name = n.kind`
  )
  .all();

function grouped(rows, keyOf, valueOf) {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(valueOf(row));
  }
  return map;
}

const aliasesByNode = grouped(
  db.prepare('SELECT node_id, alias FROM aliases').all(),
  (r) => r.node_id,
  (r) => r.alias
);

const blocksByNode = grouped(
  db.prepare('SELECT node_id, order_index, block_type, lines FROM blocks ORDER BY node_id, order_index').all(),
  (r) => r.node_id,
  (r) => ({ type: r.block_type, lines: JSON.parse(r.lines) })
);

// Relations are stored one-directional in the DB; bake both directions into
// each node so the client never needs a separate join to find them.
const relatedByNode = new Map();
const link = (a, b) => {
  if (!relatedByNode.has(a)) relatedByNode.set(a, new Set());
  relatedByNode.get(a).add(b);
};
for (const { node_id, related_id } of db.prepare('SELECT node_id, related_id FROM relations').all()) {
  link(node_id, related_id);
  link(related_id, node_id);
}

const childCount = new Map();
for (const r of rows) {
  if (r.parent_id !== null) childCount.set(r.parent_id, (childCount.get(r.parent_id) ?? 0) + 1);
}

// The programming languages are the roots filed under 'Language'. Any other
// root whose `language` is one of them (a framework, library, module...)
// carries it as `owner_language`, so the scene can say whose it is. Only
// top-level keywords get it; values like 'Web', 'Concept' or 'Tooling'
// aren't languages and are left out.
// HTML, CSS and SQL are not programming languages (they are filed under
// Web / Database) but they behave like languages (sections, owned roots).
const SPECIAL_LANGUAGES = new Set(['HTML', 'CSS', 'SQL']);
const isLanguage = (r) => r.parent_id === null && (r.category === 'Language' || SPECIAL_LANGUAGES.has(r.title));
const languageTitles = new Set(rows.filter(isLanguage).map((r) => r.title));

// A language's section (an item right under a language root) may also list
// other roots it links to — Framework (JavaScript) -> React, Vue...; Package
// (JavaScript) -> npm. Those roots are shown as extra children next to the
// section's own notes, and counted in its badge.
const rowById = new Map(rows.map((r) => [r.id, r]));
// The sections also include the ones grouped under Fundamentals / Module
// (OOP, Standard library...).
const GROUPS = ['Fundamentals', 'Module'];
const isSectionOf = (r, parent) =>
  parent.parent_id === null
    ? isLanguage(parent)
    : GROUPS.some((g) => parent.title === `${g} (${rowById.get(parent.parent_id)?.title})`);
const listedIds = (r) => {
  const parent = rowById.get(r.parent_id);
  if (r.kind !== 'item' || !parent || !isSectionOf(r, parent)) return [];
  return [...(relatedByNode.get(r.id) ?? [])].filter((id) => {
    const n = rowById.get(id);
    return n && n.parent_id === null && !isLanguage(n);
  });
};

// A language's section carries the language in its title so titles stay
// unique ("Hàm (Go)"); next to its language the short name is enough.
// Same for anything deeper in a language's tree ("Loop (Go)" -> "Loop").
const shortTitle = (r) => {
  let top = rowById.get(r.parent_id);
  while (top && top.parent_id !== null) top = rowById.get(top.parent_id);
  const suffix = top && isLanguage(top) ? ` (${top.title})` : null;
  return suffix && r.title.endsWith(suffix) ? r.title.slice(0, -suffix.length) : null;
};

const nodes = rows.map((r) => ({
  ...r,
  short_title: shortTitle(r),
  listed_ids: listedIds(r),
  owner_language:
    r.parent_id === null && !isLanguage(r) && languageTitles.has(r.language) ? r.language : null,
  child_count: (childCount.get(r.id) ?? 0) + listedIds(r).length,
  aliases: aliasesByNode.get(r.id) ?? [],
  related_ids: [...(relatedByNode.get(r.id) ?? [])],
  blocks: blocksByNode.get(r.id) ?? [],
}));

fs.writeFileSync(OUT, JSON.stringify({ nodes }));
console.log(`Wrote ${nodes.length} nodes to ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
