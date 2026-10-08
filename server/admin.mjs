// Admin for server/data.db: add / edit / delete nodes at every level, their
// content blocks, aliases and relations, plus categories and kinds.
//
// Mounted by vite.config.js on the dev server: http://localhost:5199/admin
// (UI in admin/, JSON API under /admin/api). The first write of each run
// copies data.db to server/backups/. "Xuất data.json" runs server/export.mjs,
// so the app shows the changes on reload.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'admin');
const BACKUPS = path.join(ROOT, 'server', 'backups');
const BLOCK_TYPES = ['para', 'heading', 'list', 'code', 'deflist'];

const db = openDb();
const get = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => new HttpError(400, message);

// ---------------------------------------------------------------- helpers

let backedUp = false;
function backupOnce() {
  if (backedUp) return;
  fs.mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  fs.copyFileSync(DB_PATH, path.join(BACKUPS, `data-${stamp}.db`));
  backedUp = true;
}

function transaction(fn) {
  backupOnce();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const slugify = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// raw_text mirrors the blocks: lines joined by \n, blocks by a blank line.
const rawTextOf = (blocks) => blocks.map((b) => b.lines.join('\n')).join('\n\n');

function pathOf(id) {
  const parts = [];
  for (let n = get('SELECT id, parent_id, title, kind FROM nodes WHERE id = ?', id); n; ) {
    parts.unshift({ id: n.id, title: n.title, kind: n.kind });
    n = n.parent_id === null ? null : get('SELECT id, parent_id, title, kind FROM nodes WHERE id = ?', n.parent_id);
  }
  return parts;
}

function requireNode(id) {
  const node = get('SELECT * FROM nodes WHERE id = ?', id);
  if (!node) throw new HttpError(404, `Không có node ${id}`);
  return node;
}

function nextOrder(parentId) {
  const row =
    parentId === null
      ? get('SELECT MAX(order_index) m FROM nodes WHERE parent_id IS NULL')
      : get('SELECT MAX(order_index) m FROM nodes WHERE parent_id = ?', parentId);
  return (row.m ?? -1) + 1;
}

function descendantIds(id) {
  return all(
    `WITH RECURSIVE d(id) AS (SELECT id FROM nodes WHERE parent_id = ?
       UNION ALL SELECT n.id FROM nodes n JOIN d ON n.parent_id = d.id) SELECT id FROM d`,
    id
  ).map((r) => r.id);
}

// Soft checks the UI shows after a save; none of them blocks it.
function warningsFor(node, blocks) {
  const out = [];
  const dup = get('SELECT id FROM nodes WHERE lower(title) = lower(?) AND id != ?', node.title, node.id);
  if (dup) out.push(`Tiêu đề trùng với node #${dup.id} (quy ước: tiêu đề duy nhất toàn DB).`);
  if (node.title.includes(',')) out.push('Tiêu đề có dấu phẩy (quy ước: không dùng dấu phẩy).');
  const text = `${node.title}\n${blocks.map((b) => b.lines.join('\n')).join('\n')}`;
  if (text.includes('\t')) out.push('Nội dung có ký tự tab (font không hỗ trợ).');
  if (/\p{Extended_Pictographic}/u.test(text)) out.push('Có emoji (font Square-VN không hỗ trợ).');
  return out;
}

function cleanBlocks(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((b) => ({
      type: String(b.type),
      lines: (Array.isArray(b.lines) ? b.lines : String(b.lines ?? '').split('\n')).map(String),
    }))
    .filter((b) => b.lines.some((l) => l.trim() !== ''))
    .map((b) => {
      if (!BLOCK_TYPES.includes(b.type)) throw bad(`Loại khối không hợp lệ: ${b.type}`);
      return b;
    });
}

function checkRefs({ kind, category }) {
  if (!get('SELECT 1 FROM kinds WHERE name = ?', kind)) throw bad(`Kind không tồn tại: ${kind}`);
  if (!get('SELECT 1 FROM categories WHERE name = ?', category)) throw bad(`Category không tồn tại: ${category}`);
}

function writeAliases(id, aliases) {
  run('DELETE FROM aliases WHERE node_id = ?', id);
  const seen = new Set();
  for (const a of aliases ?? []) {
    const alias = String(a).trim();
    if (alias && !seen.has(alias.toLowerCase())) {
      seen.add(alias.toLowerCase());
      run('INSERT INTO aliases (node_id, alias) VALUES (?, ?)', id, alias);
    }
  }
}

function writeBlocks(id, blocks) {
  run('DELETE FROM blocks WHERE node_id = ?', id);
  blocks.forEach((b, i) =>
    run('INSERT INTO blocks (node_id, order_index, block_type, lines) VALUES (?, ?, ?, ?)', id, i, b.type, JSON.stringify(b.lines))
  );
}

function nodeDetail(id) {
  const node = requireNode(id);
  const blocks = all('SELECT block_type, lines FROM blocks WHERE node_id = ? ORDER BY order_index', id).map((b) => ({
    type: b.block_type,
    lines: JSON.parse(b.lines),
  }));
  const aliases = all('SELECT alias FROM aliases WHERE node_id = ?', id).map((a) => a.alias);
  const related = all(
    `SELECT n.id, n.title, n.kind, n.parent_id FROM nodes n WHERE n.id IN (
       SELECT related_id FROM relations WHERE node_id = ?
       UNION SELECT node_id FROM relations WHERE related_id = ?) ORDER BY n.title`,
    id,
    id
  ).map((r) => ({ ...r, path: pathOf(r.id).slice(0, -1).map((p) => p.title).join(' > ') }));
  const children = all(
    'SELECT id, title, kind, order_index FROM nodes WHERE parent_id = ? ORDER BY order_index, id',
    id
  );
  return { node, blocks, aliases, related, children, path: pathOf(id) };
}

// ------------------------------------------------------------------ routes

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'
  );
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/meta', () => ({
  kinds: all('SELECT * FROM kinds ORDER BY sort_order, name'),
  categories: all(
    `SELECT c.*, (SELECT COUNT(*) FROM nodes n WHERE n.category = c.name) AS used FROM categories c ORDER BY c.name`
  ),
  languages: all("SELECT title FROM nodes WHERE parent_id IS NULL AND (category = 'Language' OR title IN ('HTML', 'CSS', 'SQL')) ORDER BY title").map((r) => r.title),
}));

route('GET', '/api/tree', () => ({
  nodes: all('SELECT id, parent_id, kind, title, category, language, importance, order_index FROM nodes ORDER BY order_index, id'),
}));

route('GET', '/api/stats', () => ({
  nodes: get('SELECT COUNT(*) c FROM nodes').c,
  roots: get('SELECT COUNT(*) c FROM nodes WHERE parent_id IS NULL').c,
  blocks: get('SELECT COUNT(*) c FROM blocks').c,
  relations: get('SELECT COUNT(*) c FROM relations').c,
  aliases: get('SELECT COUNT(*) c FROM aliases').c,
  backups: fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).length : 0,
}));

route('GET', '/api/node/:id', ({ params }) => nodeDetail(Number(params.id)));

route('GET', '/api/search', ({ query }) => {
  const q = (query.get('q') ?? '').trim();
  if (!q) return { results: [] };
  let rows;
  if (/^#?\d+$/.test(q)) {
    rows = all('SELECT id, title, kind, parent_id FROM nodes WHERE id = ?', Number(q.replace('#', '')));
  } else {
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const prefix = `${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    rows = all(
      `SELECT id, title, kind, parent_id FROM nodes
       WHERE title LIKE ? ESCAPE '\\' OR id IN (SELECT node_id FROM aliases WHERE alias LIKE ? ESCAPE '\\')
       ORDER BY (title LIKE ? ESCAPE '\\') DESC, parent_id IS NULL DESC, length(title) LIMIT 40`,
      like,
      like,
      prefix
    );
  }
  return {
    results: rows.map((r) => ({ ...r, path: pathOf(r.id).slice(0, -1).map((p) => p.title).join(' > ') })),
  };
});

route('POST', '/api/node', ({ body }) => {
  const parentId = body.parent_id ?? null;
  const parent = parentId === null ? null : requireNode(parentId);
  const title = String(body.title ?? '').trim();
  if (!title) throw bad('Thiếu tiêu đề');
  const kind = body.kind ?? 'concept';
  const category = body.category ?? 'Concept';
  checkRefs({ kind, category });
  const blocks = cleanBlocks(body.blocks);
  const id = transaction(() => {
    const { lastInsertRowid } = run(
      `INSERT INTO nodes (parent_id, kind, slug, title, category, language, importance, description, order_index, raw_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      parentId,
      kind,
      slugify(title),
      title,
      category,
      body.language ?? parent?.language ?? null,
      Math.min(10, Math.max(1, Number(body.importance ?? 5))),
      body.description || null,
      body.order_index ?? nextOrder(parentId),
      rawTextOf(blocks) || null
    );
    writeBlocks(Number(lastInsertRowid), blocks);
    writeAliases(Number(lastInsertRowid), body.aliases);
    return Number(lastInsertRowid);
  });
  return { id, warnings: warningsFor(requireNode(id), blocks) };
});

route('PUT', '/api/node/:id', ({ params, body }) => {
  const id = Number(params.id);
  const current = requireNode(id);
  const title = String(body.title ?? '').trim();
  if (!title) throw bad('Thiếu tiêu đề');
  const kind = body.kind ?? current.kind;
  const category = body.category ?? current.category;
  checkRefs({ kind, category });
  const blocks = cleanBlocks(body.blocks);
  transaction(() => {
    run(
      `UPDATE nodes SET title = ?, slug = ?, kind = ?, category = ?, language = ?, importance = ?,
         description = ?, order_index = ?, raw_text = ? WHERE id = ?`,
      title,
      body.slug ? slugify(body.slug) : slugify(title),
      kind,
      category,
      body.language || null,
      Math.min(10, Math.max(1, Number(body.importance ?? current.importance))),
      body.description || null,
      Number(body.order_index ?? current.order_index),
      rawTextOf(blocks) || null,
      id
    );
    writeBlocks(id, blocks);
    writeAliases(id, body.aliases);
  });
  return { id, warnings: warningsFor(requireNode(id), blocks) };
});

route('DELETE', '/api/node/:id', ({ params }) => {
  const id = Number(params.id);
  const node = requireNode(id);
  const count = descendantIds(id).length + 1;
  transaction(() => run('DELETE FROM nodes WHERE id = ?', id));
  return { deleted: count, parent_id: node.parent_id };
});

route('GET', '/api/node/:id/descendants', ({ params }) => ({ count: descendantIds(Number(params.id)).length }));

route('POST', '/api/node/:id/move', ({ params, body }) => {
  const id = Number(params.id);
  requireNode(id);
  const parentId = body.parent_id ?? null;
  if (parentId !== null) {
    requireNode(parentId);
    if (parentId === id || descendantIds(id).includes(parentId)) throw bad('Không thể chuyển node vào chính nó hoặc con cháu của nó');
  }
  transaction(() =>
    run('UPDATE nodes SET parent_id = ?, order_index = ? WHERE id = ?', parentId, body.order_index ?? nextOrder(parentId), id)
  );
  return { id };
});

// Body: { ids: [...] } — the new order of one parent's children.
route('POST', '/api/reorder', ({ body }) => {
  if (!Array.isArray(body.ids)) throw bad('Thiếu danh sách ids');
  transaction(() => body.ids.forEach((id, i) => run('UPDATE nodes SET order_index = ? WHERE id = ?', i, Number(id))));
  return { ok: true };
});

route('POST', '/api/relations', ({ body }) => {
  const a = Number(body.node_id);
  const b = Number(body.related_id);
  if (a === b) throw bad('Không thể liên kết node với chính nó');
  requireNode(a);
  requireNode(b);
  const exists = get(
    'SELECT 1 FROM relations WHERE (node_id = ? AND related_id = ?) OR (node_id = ? AND related_id = ?)',
    a, b, b, a
  );
  if (!exists) transaction(() => run('INSERT INTO relations (node_id, related_id) VALUES (?, ?)', a, b));
  return { ok: true };
});

route('DELETE', '/api/relations', ({ body }) => {
  const a = Number(body.node_id);
  const b = Number(body.related_id);
  transaction(() =>
    run('DELETE FROM relations WHERE (node_id = ? AND related_id = ?) OR (node_id = ? AND related_id = ?)', a, b, b, a)
  );
  return { ok: true };
});

// ---- categories & kinds (names are keys other rows point at, so they are
// never renamed; deleting one that is still used is refused).

route('POST', '/api/categories', ({ body }) => {
  const name = String(body.name ?? '').trim();
  if (!name) throw bad('Thiếu tên category');
  if (get('SELECT 1 FROM categories WHERE name = ?', name)) throw bad('Category đã tồn tại');
  transaction(() => run('INSERT INTO categories (name, color, scale) VALUES (?, ?, ?)', name, body.color || '#E8F0FF', Number(body.scale ?? 1)));
  return { ok: true };
});
route('PUT', '/api/categories/:name', ({ params, body }) => {
  const name = decodeURIComponent(params.name);
  if (!get('SELECT 1 FROM categories WHERE name = ?', name)) throw new HttpError(404, 'Không có category');
  transaction(() => run('UPDATE categories SET color = ?, scale = ? WHERE name = ?', body.color, Number(body.scale), name));
  return { ok: true };
});
route('DELETE', '/api/categories/:name', ({ params }) => {
  const name = decodeURIComponent(params.name);
  const used = get('SELECT COUNT(*) c FROM nodes WHERE category = ?', name).c;
  if (used) throw bad(`Còn ${used} node dùng category này`);
  transaction(() => run('DELETE FROM categories WHERE name = ?', name));
  return { ok: true };
});

route('POST', '/api/kinds', ({ body }) => {
  const name = String(body.name ?? '').trim();
  if (!name) throw bad('Thiếu tên kind');
  if (get('SELECT 1 FROM kinds WHERE name = ?', name)) throw bad('Kind đã tồn tại');
  transaction(() => run('INSERT INTO kinds (name, label, sort_order) VALUES (?, ?, ?)', name, body.label || name.toUpperCase(), Number(body.sort_order ?? 5)));
  return { ok: true };
});
route('PUT', '/api/kinds/:name', ({ params, body }) => {
  const name = decodeURIComponent(params.name);
  if (!get('SELECT 1 FROM kinds WHERE name = ?', name)) throw new HttpError(404, 'Không có kind');
  transaction(() => run('UPDATE kinds SET label = ?, sort_order = ? WHERE name = ?', body.label, Number(body.sort_order), name));
  return { ok: true };
});
route('DELETE', '/api/kinds/:name', ({ params }) => {
  const name = decodeURIComponent(params.name);
  const used = get('SELECT COUNT(*) c FROM nodes WHERE kind = ?', name).c;
  if (used) throw bad(`Còn ${used} node dùng kind này`);
  transaction(() => run('DELETE FROM kinds WHERE name = ?', name));
  return { ok: true };
});

route('POST', '/api/backup', () => {
  backedUp = false;
  backupOnce();
  return { dir: BACKUPS };
});

route('POST', '/api/export', () =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'export.mjs')], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve({ output: out.split('\n').filter((l) => l.startsWith('Wrote')).join('\n') || out.trim() })
        : reject(new HttpError(500, out.trim() || `export thoát với mã ${code}`))
    );
  })
);

// -------------------------------------------------------------- middleware

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5_000_000) reject(bad('Nội dung quá lớn'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(bad('JSON không hợp lệ'));
      }
    });
    req.on('error', reject);
  });
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Only this machine's own pages may use it: the socket must be loopback and
// Host / Origin must be localhost on the port the request came in on. A
// tunnel to the dev server (Cloudflare...) or another site's request gets 403.
function assertLocal(req) {
  const port = req.socket.localPort;
  const ok = (host) => host === `localhost:${port}` || host === `127.0.0.1:${port}`;
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) throw new HttpError(403, 'Chỉ truy cập từ máy này');
  if (!ok(req.headers.host ?? '')) throw new HttpError(403, 'Host không hợp lệ');
  if (req.headers.origin && !ok(new URL(req.headers.origin).host)) throw new HttpError(403, 'Origin không hợp lệ');
}

const BASE = '/admin';

/**
 * Connect-style middleware mounted by vite.config.js (dev server only):
 * the UI (admin/) at /admin and its JSON API at /admin/api/*.
 */
export function adminMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return next();
    try {
      assertLocal(req);
      const rest = url.pathname.slice(BASE.length) || '/';

      if (rest.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers['x-admin'] !== '1') throw new HttpError(403, 'Thiếu header X-Admin');
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(rest);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
          const body = req.method === 'GET' ? {} : await readBody(req);
          return sendJson(res, 200, await r.handler({ params, body, query: url.searchParams }));
        }
        throw new HttpError(404, 'Không có API này');
      }

      // Static files of admin/.
      const file = path.join(WEB, rest === '/' ? 'index.html' : decodeURIComponent(rest));
      if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new HttpError(404, 'Không tìm thấy');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      sendJson(res, status, { error: e.message });
    }
  };
}
