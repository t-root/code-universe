// Bulk content import: writes / updates nodes in server/data.db from Markdown
// files (content/**.md). Idempotent — a node is found by title, so running a
// file again updates it instead of duplicating it.
//
//   node server/import-md.mjs content/javascript/*.md          apply
//   node server/import-md.mjs --dry content/javascript/a.md    check only (rolls back)
//
// File format — one block per node:
//
//   @@ NODE
//   parent: Data type (JavaScript)        existing title, "#id", or "-" for a root
//   title: arr.map()                      unique across the DB (case-insensitive)
//   kind: method                          default concept
//   category: Array Method                default Concept
//   importance: 8                         default 6
//   aliases: map; array map; biến đổi mảng
//   related: arr.filter(); arr.reduce()   links both ways (titles)
//   desc: One English line                -> nodes.description
//   ---
//   Paragraph text (wrapped lines are joined).
//
//   ```js
//   console.log([1, 2].map(x => x * 2))
//   ```
//   @RESULT                                 <- runs the code block above and writes
//                                              "## Kết quả" with the real output
//   ## Lưu ý
//   - bullet lines become a list
//   + name: text lines become a definition list
//
// A ```js block is executed for @RESULT; use ```js norun for code that can't run
// (DOM, Node I/O, frameworks) and write its "## Kết quả" by hand.
// A title already used by a node of ANOTHER language gets " (JavaScript)" added.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './db.js';
import { runExample } from './run-example.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOCK_TYPES = new Set(['para', 'heading', 'list', 'code', 'deflist']);
const RESULT = 'Kết quả';

// ------------------------------------------------------------------ parsing

export function parseFile(text, file) {
  const entries = [];
  const parts = text.split(/^@@ ?NODE[ \t]*$/m).slice(1);
  let offset = text.split(/^@@ ?NODE[ \t]*$/m)[0].split('\n').length;
  for (const part of parts) {
    const lines = part.replace(/^\r?\n/, '').split(/\r?\n/);
    const sep = lines.indexOf('---');
    const header = {};
    const headerLines = sep < 0 ? lines : lines.slice(0, sep);
    for (const l of headerLines) {
      const m = /^([a-z]+):\s*(.*)$/i.exec(l);
      if (m) header[m[1].toLowerCase()] = m[2].trim();
    }
    entries.push({ header, body: sep < 0 ? '' : lines.slice(sep + 1).join('\n'), file, line: offset });
    offset += lines.length + 1;
  }
  return entries;
}

// Body Markdown -> blocks. Code fences marked @RESULT are executed.
export async function parseBody(body, problems, where) {
  const blocks = [];
  const lines = body.split(/\r?\n/);
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'para', lines: [para.join(' ')] });
    para = [];
  };
  const pushRun = (type, line) => {
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) last.lines.push(line);
    else blocks.push({ type, lines: [line] });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```\s*(\S*)\s*(.*)$/.exec(line);
    if (fence) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      while (code.length && code[code.length - 1].trim() === '') code.pop();
      blocks.push({ type: 'code', lines: code, lang: fence[1] || 'text', flags: fence[2].split(/\s+/) });
      continue;
    }
    if (/^@RESULT\s*$/.test(line)) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (!prev || prev.type !== 'code' || prev.lang !== 'js' || prev.flags.includes('norun')) {
        problems.push(`${where}: @RESULT phải đứng ngay sau một khối \`\`\`js (không norun)`);
        continue;
      }
      const run = await runExample(prev.lines.join('\n'));
      if (run.error && !prev.flags.includes('throws')) problems.push(`${where}: ví dụ lỗi khi chạy: ${run.error}`);
      if (!run.lines.length) problems.push(`${where}: ví dụ không in ra gì (cần console.log)`);
      blocks.push({ type: 'heading', lines: [RESULT] });
      const out = run.lines.flatMap((l) => l.split('\n'));
      blocks.push({ type: 'code', lines: out.length ? out : ['(không in ra gì)'], lang: 'text', flags: [] });
      continue;
    }
    const h = /^#{2,3}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ type: 'heading', lines: [h[1].trim()] });
    } else if (/^- /.test(line)) {
      flush();
      pushRun('list', line);
    } else if (/^\+ /.test(line)) {
      flush();
      pushRun('deflist', line.slice(2));
    } else if (line.trim() === '') flush();
    else para.push(line.trim());
  }
  flush();
  return blocks.map(({ type, lines: l }) => ({ type, lines: l }));
}

// ----------------------------------------------------------------- database

const rawTextOf = (blocks) => blocks.map((b) => b.lines.join('\n')).join('\n\n');
const slugify = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export async function importFiles(files, { dry = false, quiet = false } = {}) {
  const db = openDb();
  const q = (sql) => db.prepare(sql);
  const get = (sql, ...a) => q(sql).get(...a);
  const run = (sql, ...a) => q(sql).run(...a);
  const problems = [];
  const notes = [];
  const stats = { created: 0, updated: 0, moved: 0, renamed: 0, relations: 0 };
  const pendingRelations = [];
  const parentsTouched = new Map(); // parent id -> [node ids in file order]

  const kinds = new Set(q('SELECT name FROM kinds').all().map((r) => r.name));
  const categories = new Set(q('SELECT name FROM categories').all().map((r) => r.name));
  const byTitle = (t) => get('SELECT * FROM nodes WHERE lower(title) = lower(?)', t);
  const byRef = (ref) => (ref.startsWith('#') ? get('SELECT * FROM nodes WHERE id = ?', Number(ref.slice(1))) : byTitle(ref));

  if (!dry) {
    fs.mkdirSync(path.join(ROOT, 'server', 'backups'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    fs.copyFileSync(DB_PATH, path.join(ROOT, 'server', 'backups', `data-${stamp}-import.db`));
  }
  db.exec('BEGIN');
  try {
    for (const file of files) {
      const entries = parseFile(fs.readFileSync(file, 'utf8'), file);
      for (const e of entries) {
        const h = e.header;
        const where = `${path.basename(file)}:${e.line} (${h.title ?? '?'})`;
        if (!h.title) {
          problems.push(`${where}: thiếu title`);
          continue;
        }
        const kind = h.kind ?? 'concept';
        const category = h.category ?? 'Concept';
        if (!kinds.has(kind)) problems.push(`${where}: kind không tồn tại: ${kind}`);
        if (!categories.has(category)) problems.push(`${where}: category không tồn tại: ${category}`);
        if (/[,\t]/.test(h.title)) problems.push(`${where}: tiêu đề có dấu phẩy hoặc tab`);
        if (/\p{Extended_Pictographic}/u.test(h.title + (e.body ?? ''))) problems.push(`${where}: có emoji`);

        // parent
        let parent = null;
        if (h.parent && h.parent !== '-') {
          parent = byRef(h.parent);
          if (!parent) {
            problems.push(`${where}: không thấy parent "${h.parent}"`);
            continue;
          }
        }
        const language = h.language ?? parent?.language ?? null;

        // find or create — a title used by another language is suffixed
        let title = h.title;
        let node = h.title.startsWith('#') ? byRef(h.title) : byTitle(title);
        if (node && h.title[0] !== '#' && (node.language ?? null) !== language && language) {
          title = `${h.title} (${language})`;
          node = byTitle(title);
          stats.renamed++;
        }
        // A concept root (Closure, Class...) is not the note being written:
        // never overwrite or move it by accident.
        if (node && node.parent_id === null && h.parent && h.parent !== '-' && h.title[0] !== '#') {
          problems.push(`${where}: trùng tên với node gốc "${node.title}" — đặt tên khác (vd "${h.title} (JavaScript)")`);
          continue;
        }

        const blocks = e.body.trim() ? await parseBody(e.body, problems, where) : null;
        if (blocks) {
          for (const b of blocks) if (!BLOCK_TYPES.has(b.type)) problems.push(`${where}: block lạ ${b.type}`);
          const hasCode = blocks.some((b) => b.type === 'code');
          const hasResult = blocks.some((b) => b.type === 'heading' && b.lines[0] === RESULT);
          if (hasCode && !hasResult) problems.push(`${where}: có code nhưng thiếu mục "## ${RESULT}"`);
          for (const b of blocks) {
            if (b.type === 'code') {
              b.lines.forEach((l, i) => {
                if (l.length > 110) problems.push(`${where}: dòng code ${i + 1} dài ${l.length} ký tự (>110)`);
                if (l.includes('\t')) problems.push(`${where}: code có tab`);
              });
            }
          }
        }
        const aliases = h.aliases ? h.aliases.split(';').map((s) => s.trim()).filter(Boolean) : null;
        const importance = h.importance ? Math.min(10, Math.max(1, Number(h.importance))) : null;

        let id;
        if (node) {
          id = node.id;
          const newParent = parent ? parent.id : node.parent_id;
          if (parent && newParent !== node.parent_id) {
            if (descendantsOf(db, node.id).has(newParent) || newParent === node.id) {
              problems.push(`${where}: không thể chuyển vào con cháu của chính nó`);
              continue;
            }
            stats.moved++;
          }
          run(
            `UPDATE nodes SET parent_id = ?, title = ?, slug = ?, kind = ?, category = ?, language = ?,
               importance = COALESCE(?, importance), description = COALESCE(?, description),
               raw_text = COALESCE(?, raw_text) WHERE id = ?`,
            newParent, h.retitle ?? node.title, slugify(h.retitle ?? node.title),
            h.kind ?? node.kind, h.category ?? node.category, h.language ?? node.language ?? language,
            importance, h.desc ?? null, blocks ? rawTextOf(blocks) : null, id
          );
          stats.updated++;
        } else {
          if (h.title.startsWith('#')) {
            problems.push(`${where}: không thấy node ${h.title}`);
            continue;
          }
          const { lastInsertRowid } = run(
            `INSERT INTO nodes (parent_id, kind, slug, title, category, language, importance, description, order_index, raw_text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
            parent ? parent.id : null, kind, slugify(title), title, category, language,
            importance ?? 6, h.desc ?? null, blocks ? rawTextOf(blocks) : null
          );
          id = Number(lastInsertRowid);
          stats.created++;
        }
        // `replaces: Old title; Other` — this note takes over their links and they are deleted.
        if (h.replaces) {
          for (const oldTitle of h.replaces.split(';').map((s) => s.trim()).filter(Boolean)) {
            const old = byRef(oldTitle);
            if (!old || old.id === id) continue;
            if (get('SELECT 1 FROM nodes WHERE parent_id = ?', old.id)) {
              problems.push(`${where}: "${oldTitle}" còn node con, không thể thay thế`);
              continue;
            }
            run('UPDATE OR IGNORE relations SET node_id = ? WHERE node_id = ? AND related_id != ?', id, old.id, id);
            run('UPDATE OR IGNORE relations SET related_id = ? WHERE related_id = ? AND node_id != ?', id, old.id, id);
            run('DELETE FROM nodes WHERE id = ?', old.id);
            stats.replaced = (stats.replaced ?? 0) + 1;
          }
        }
        if (blocks) {
          run('DELETE FROM blocks WHERE node_id = ?', id);
          blocks.forEach((b, i) =>
            run('INSERT INTO blocks (node_id, order_index, block_type, lines) VALUES (?, ?, ?, ?)', id, i, b.type, JSON.stringify(b.lines))
          );
        }
        if (aliases) {
          run('DELETE FROM aliases WHERE node_id = ?', id);
          const seen = new Set();
          for (const a of aliases) if (!seen.has(a.toLowerCase())) (seen.add(a.toLowerCase()), run('INSERT INTO aliases (node_id, alias) VALUES (?, ?)', id, a));
        }
        if (h.related) for (const r of h.related.split(';').map((s) => s.trim()).filter(Boolean)) pendingRelations.push({ id, title, r, language, where });

        const pid = get('SELECT parent_id FROM nodes WHERE id = ?', id).parent_id;
        const key = pid ?? 'root';
        if (!parentsTouched.has(key)) parentsTouched.set(key, []);
        parentsTouched.get(key).push(id);
      }
    }

    // relations (both ways count as one)
    for (const { id, title, r, language, where } of pendingRelations) {
      const other = byRef(r) ?? (language ? byTitle(`${r} (${language})`) : null);
      if (!other) {
        notes.push(`${where}: related "${r}" chưa có`);
        continue;
      }
      if (other.id === id) continue;
      const exists = get(
        'SELECT 1 FROM relations WHERE (node_id = ? AND related_id = ?) OR (node_id = ? AND related_id = ?)',
        id, other.id, other.id, id
      );
      if (!exists) (run('INSERT INTO relations (node_id, related_id) VALUES (?, ?)', id, other.id), stats.relations++);
    }

    // sibling order follows the file for every parent it touched
    for (const [key, ids] of parentsTouched) {
      const rows =
        key === 'root'
          ? q('SELECT id FROM nodes WHERE parent_id IS NULL ORDER BY order_index, id').all()
          : q('SELECT id FROM nodes WHERE parent_id = ? ORDER BY order_index, id').all(key);
      if (key === 'root') continue; // never reshuffle the roots
      const first = [...new Set(ids)];
      const rest = rows.map((r) => r.id).filter((id) => !first.includes(id));
      [...first, ...rest].forEach((id, i) => run('UPDATE nodes SET order_index = ? WHERE id = ?', i, id));
    }
    db.exec(dry || problems.length ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (!quiet) {
    for (const n of notes) console.log('  ghi chú:', n);
    for (const p of problems) console.log('  LỖI:', p);
    console.log(
      `${dry ? '[chạy thử] ' : problems.length ? '[HỦY, có lỗi] ' : ''}tạo ${stats.created}, cập nhật ${stats.updated}, chuyển ${stats.moved}, đổi tên (thêm ngôn ngữ) ${stats.renamed}, quan hệ mới ${stats.relations}, node cũ bị thay ${stats.replaced ?? 0}`
    );
  }
  return { problems, notes, stats };
}

function descendantsOf(db, id) {
  const out = new Set();
  for (const r of db
    .prepare(`WITH RECURSIVE d(id) AS (SELECT id FROM nodes WHERE parent_id = ? UNION ALL SELECT n.id FROM nodes n JOIN d ON n.parent_id = d.id) SELECT id FROM d`)
    .all(id)) out.add(r.id);
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('import-md.mjs')) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('Dùng: node server/import-md.mjs [--dry] file.md ...');
    process.exit(1);
  }
  const { problems } = await importFiles(files, { dry });
  process.exit(problems.length ? 1 : 0);
}
