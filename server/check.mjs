// Quality check of one language's tree (and, with --roots, the ecosystem
// roots it owns: frameworks, libraries, tools).
//
//   node server/check.mjs JavaScript            summary + the first issues of each kind
//   node server/check.mjs JavaScript --all      every issue
//   node server/check.mjs JavaScript --roots    include owned roots (React, Express...)
//
// Rules (stack.txt "Quy tắc nội dung"): a leaf has description -> code ->
// "## Kết quả"; every code block needs a Kết quả; no empty nodes; no tab /
// emoji / comma-in-title; code lines <= 110; unique titles.
import { openDb } from './db.js';

const args = process.argv.slice(2);
const language = args.find((a) => !a.startsWith('--'));
const all = args.includes('--all');
const withRoots = args.includes('--roots');
if (!language) {
  console.error('Dùng: node server/check.mjs <Ngôn ngữ> [--all] [--roots]');
  process.exit(1);
}
const db = openDb();
const root = db.prepare("SELECT id FROM nodes WHERE title = ? AND parent_id IS NULL AND (category = 'Language' OR title IN ('HTML', 'CSS', 'SQL'))").get(language);
if (!root) {
  console.error(`Không có ngôn ngữ ${language}`);
  process.exit(1);
}
const rootIds = [root.id];
if (withRoots) {
  for (const r of db.prepare('SELECT id FROM nodes WHERE parent_id IS NULL AND language = ? AND category != ? AND title != ?').all(language, 'Language', language)) rootIds.push(r.id);
}
const nodes = db
  .prepare(
    `WITH RECURSIVE d(id) AS (SELECT ${rootIds.map(() => '?').join(' UNION ALL SELECT ')} UNION ALL SELECT n.id FROM nodes n JOIN d ON n.parent_id = d.id)
     SELECT n.id, n.parent_id, n.title, n.kind, n.category, n.importance, n.description FROM nodes n WHERE n.id IN (SELECT id FROM d)`
  )
  .all(...rootIds);
const blocksOf = db.prepare('SELECT block_type, lines FROM blocks WHERE node_id = ? ORDER BY order_index');
const childCount = new Map();
for (const n of nodes) if (n.parent_id !== null) childCount.set(n.parent_id, (childCount.get(n.parent_id) ?? 0) + 1);
const relCount = new Map(db.prepare('SELECT node_id, COUNT(*) c FROM relations GROUP BY node_id').all().map((r) => [r.node_id, r.c]));
const aliasCount = new Map(db.prepare('SELECT node_id, COUNT(*) c FROM aliases GROUP BY node_id').all().map((r) => [r.node_id, r.c]));

const issues = new Map();
const add = (kind, n, extra = '') => {
  if (!issues.has(kind)) issues.set(kind, []);
  issues.get(kind).push(`#${n.id} ${n.title}${extra ? ' — ' + extra : ''}`);
};
let withCode = 0;
let words = 0;
for (const n of nodes) {
  const blocks = blocksOf.all(n.id).map((b) => ({ type: b.block_type, lines: JSON.parse(b.lines) }));
  const leaf = !childCount.get(n.id);
  const hasCode = blocks.some((b) => b.type === 'code');
  const hasResult = blocks.some((b) => b.type === 'heading' && b.lines[0] === 'Kết quả');
  const text = blocks.filter((b) => b.type === 'para').map((b) => b.lines.join(' ')).join(' ');
  words += text.split(/\s+/).filter(Boolean).length;
  if (hasCode) withCode++;

  if (blocks.length === 0) add('Node không có nội dung', n);
  if (hasCode && !hasResult) add('Có code nhưng thiếu "## Kết quả"', n);
  if (leaf && n.kind !== 'item' && !hasCode) add('Node lá không có code', n);
  if (n.kind !== 'item' && text.split(/\s+/).filter(Boolean).length < 12) add('Mô tả quá ngắn (<12 từ)', n);
  if (!n.description) add('Thiếu description (EN)', n);
  if (!aliasCount.get(n.id)) add('Chưa có alias', n);
  if (n.kind === 'item' && leaf && !relCount.get(n.id)) add('Mục rỗng (chưa có node con)', n);
  if (/[,\t]/.test(n.title)) add('Tiêu đề có dấu phẩy / tab', n);
  const all_ = blocks.map((b) => b.lines.join('\n')).join('\n');
  if (all_.includes('\t')) add('Nội dung có tab', n);
  if (/\p{Extended_Pictographic}/u.test(n.title + all_)) add('Có emoji', n);
  for (const b of blocks) {
    if (b.type !== 'code') continue;
    const long = b.lines.findIndex((l) => l.length > 110);
    if (long >= 0) add('Dòng code dài hơn 110 ký tự', n, `dòng ${long + 1}`);
  }
}
const dupes = new Map();
for (const n of nodes) dupes.set(n.title.toLowerCase(), (dupes.get(n.title.toLowerCase()) ?? 0) + 1);
for (const [t, c] of dupes) if (c > 1) add('Tiêu đề trùng', { id: '', title: t }, `${c} lần`);

console.log(`\n${language}${withRoots ? ' (+ node gốc hệ sinh thái)' : ''}: ${nodes.length} node, ${withCode} có code, ~${words} từ mô tả`);
let total = 0;
for (const [kind, list] of [...issues].sort((a, b) => b[1].length - a[1].length)) {
  total += list.length;
  console.log(`\n${kind}: ${list.length}`);
  for (const l of all ? list : list.slice(0, 6)) console.log('   ' + l);
  if (!all && list.length > 6) console.log(`   … và ${list.length - 6} nữa (--all để xem hết)`);
}
console.log(`\n${total === 0 ? 'SẠCH — không còn vấn đề.' : `Tổng ${total} vấn đề.`}`);
process.exit(total === 0 ? 0 : 1);
