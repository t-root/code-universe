// Merge a duplicate node into the one that stays: children, aliases and links
// move over, the kept node takes the dropped node's body when asked, and the
// dropped node is deleted.
//   import { mergeNode } from './merge-nodes.mjs'
//   mergeNode(db, { keep: 'Promise', drop: 'Promise (JavaScript)', content: 'drop', retitle: null })
export function mergeNode(db, { keep, drop, content = 'keep', retitle = null, category = null, kind = null }) {
  const find = (t) => (typeof t === 'number' ? { id: t } : db.prepare('SELECT id FROM nodes WHERE title = ? ORDER BY parent_id IS NULL DESC').get(t));
  const k = find(keep);
  const d = find(drop);
  if (!k || !d) throw new Error(`không thấy ${keep} / ${drop}`);
  if (k.id === d.id) return;
  for (const c of db.prepare('SELECT id FROM nodes WHERE parent_id = ?').all(d.id)) {
    db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(k.id, c.id);
  }
  for (const r of db.prepare('SELECT related_id x FROM relations WHERE node_id = ?').all(d.id)) {
    if (r.x !== k.id) db.prepare('INSERT OR IGNORE INTO relations (node_id, related_id) VALUES (?, ?)').run(k.id, r.x);
  }
  for (const r of db.prepare('SELECT node_id x FROM relations WHERE related_id = ?').all(d.id)) {
    if (r.x !== k.id) db.prepare('INSERT OR IGNORE INTO relations (node_id, related_id) VALUES (?, ?)').run(r.x, k.id);
  }
  for (const a of db.prepare('SELECT alias FROM aliases WHERE node_id = ?').all(d.id)) {
    if (!db.prepare('SELECT 1 FROM aliases WHERE node_id = ? AND lower(alias) = lower(?)').get(k.id, a.alias)) {
      db.prepare('INSERT INTO aliases (node_id, alias) VALUES (?, ?)').run(k.id, a.alias);
    }
  }
  if (content === 'drop') {
    const n = db.prepare('SELECT description, raw_text FROM nodes WHERE id = ?').get(d.id);
    db.prepare('UPDATE nodes SET description = ?, raw_text = ? WHERE id = ?').run(n.description, n.raw_text, k.id);
    db.prepare('DELETE FROM blocks WHERE node_id = ?').run(k.id);
    db.prepare(
      'INSERT INTO blocks (node_id, order_index, block_type, lines) SELECT ?, order_index, block_type, lines FROM blocks WHERE node_id = ?'
    ).run(k.id, d.id);
  }
  db.prepare('DELETE FROM relations WHERE node_id = ? OR related_id = ?').run(d.id, d.id);
  db.prepare('DELETE FROM aliases WHERE node_id = ?').run(d.id);
  db.prepare('DELETE FROM blocks WHERE node_id = ?').run(d.id);
  db.prepare('DELETE FROM nodes WHERE id = ?').run(d.id);
  if (retitle) {
    const slug = retitle.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    db.prepare('UPDATE nodes SET title = ?, slug = ? WHERE id = ?').run(retitle, slug, k.id);
  }
  if (category) db.prepare('UPDATE nodes SET category = ? WHERE id = ?').run(category, k.id);
  if (kind) db.prepare('UPDATE nodes SET kind = ? WHERE id = ?').run(kind, k.id);
}
