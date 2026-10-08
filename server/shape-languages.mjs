// Shapes every programming language's level-1 sections by what it really has:
//  - "Package (L)" exists where the language has several small single-purpose
//    packages (taken out of "Library"); the manifest notes (Cargo.toml...) live
//    in "Package manager".
//  - an empty section (no children, nothing listed) is removed.
//  - the sections are put in the canonical order.
// Idempotent.   node server/shape-languages.mjs     (DRY=1 to preview)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './db.js';
import { importFiles } from './import-md.mjs';

process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'content', 'generic', 'packages.md');
const ORDER = ['Fundamentals', 'Runtime', 'Module', 'Package', 'Package manager', 'Library', 'Framework', 'Testing', 'Tooling', 'Best practices'];

// Small, single-purpose packages already in each language's ecosystem.
const PACKAGES = {
  Python: ['requests', 'httpx', 'Pydantic', 'BeautifulSoup'],
  Rust: ['Serde', 'Clap', 'Reqwest', 'tracing'],
  Go: ['zap', 'Viper', 'Cobra', 'sqlx', 'pgx'],
  Java: ['Lombok', 'Jackson', 'SLF4J & Logback'],
  Kotlin: ['kotlinx.serialization', 'Koin', 'Retrofit'],
  'C#': ['Dapper', 'Serilog', 'AutoMapper', 'MediatR', 'FluentValidation', 'Polly'],
  PHP: ['Guzzle', 'Carbon', 'Monolog'],
  Dart: ['Dio', 'freezed', 'Provider'],
};
const WHERE = { Python: 'pip / PyPI', Rust: 'cargo / crates.io', Go: 'go get', Java: 'Maven / Gradle', Kotlin: 'Gradle', 'C#': 'NuGet', PHP: 'Composer / Packagist', Dart: 'pub.dev' };

const db = openDb();
const langs = db.prepare("SELECT id, title FROM nodes WHERE parent_id IS NULL AND category = 'Language'").all();
const sectionOf = (lang, name) => db.prepare('SELECT id FROM nodes WHERE parent_id = ? AND title = ?').get(lang.id, `${name} (${lang.title})`);
const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// 1. Package sections
const md = [];
for (const [lang, titles] of Object.entries(PACKAGES)) {
  const t = `Package (${lang})`;
  md.push([
    '@@ NODE', `parent: ${lang}`, `title: ${t}`, 'kind: item', 'category: Library', 'importance: 8',
    `aliases: gói; package ${lang}; gói nhỏ; ${WHERE[lang]}`, `related: ${titles.join('; ')}`,
    `desc: Small single-purpose ${lang} packages you install and import in one line.`, '---',
    `Package là gói nhỏ làm MỘT việc rõ ràng, cài bằng ${WHERE[lang]} rồi dùng ngay: ${titles.slice(0, 4).join(', ')}. Library lớn hơn, là bộ công cụ nhiều phần; Framework quyết định cấu trúc cả ứng dụng. Cách khai báo, đánh phiên bản và xuất bản gói thuộc mục Package manager.`, '',
  ].join('\n'));
}
if (process.env.DRY) {
  console.log(`${md.length} mục Package`);
} else {
  fs.copyFileSync(DB_PATH, path.join(ROOT, 'server', 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-shape-languages.db`));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md.join('\n'));
  db.close?.();
  await importFiles([OUT]);
}
const db2 = openDb();
const rootId = (t) => db2.prepare('SELECT id FROM nodes WHERE title = ? AND parent_id IS NULL').get(t)?.id;
for (const [lang, titles] of Object.entries(PACKAGES)) {
  const l = langs.find((x) => x.title === lang);
  const pkg = db2.prepare('SELECT id FROM nodes WHERE parent_id = ? AND title = ?').get(l.id, `Package (${lang})`);
  const lib = db2.prepare('SELECT id FROM nodes WHERE parent_id = ? AND title = ?').get(l.id, `Library (${lang})`);
  if (!pkg || !lib) continue;
  for (const t of titles) {
    const id = rootId(t);
    if (!id) { console.log(`thiếu node gốc ${t}`); continue; }
    db2.prepare('DELETE FROM relations WHERE (node_id = ? AND related_id = ?) OR (node_id = ? AND related_id = ?)').run(lib.id, id, id, lib.id);
  }
}

// 2. empty sections out, canonical order in
const countKids = db2.prepare('SELECT COUNT(*) c FROM nodes WHERE parent_id = ?');
const countRel = db2.prepare('SELECT COUNT(*) c FROM relations WHERE node_id = ? OR related_id = ?');
for (const l of langs) {
  const secs = db2.prepare("SELECT id, title FROM nodes WHERE parent_id = ? AND kind = 'item'").all(l.id);
  const rank = (s) => {
    const i = ORDER.findIndex((o) => s.title === `${o} (${l.title})`);
    return i < 0 ? ORDER.length : i;
  };
  const kept = [];
  for (const s of secs) {
    const known = rank(s) < ORDER.length;
    const empty = countKids.get(s.id).c === 0 && countRel.get(s.id, s.id).c === 0;
    if (known && empty && rank(s) !== 0) {
      for (const tbl of ['aliases', 'blocks']) db2.prepare(`DELETE FROM ${tbl} WHERE node_id = ?`).run(s.id);
      db2.prepare('DELETE FROM nodes WHERE id = ?').run(s.id);
      console.log(`${l.title}: bỏ mục rỗng ${s.title}`);
    } else kept.push(s);
  }
  kept.sort((a, b) => rank(a) - rank(b));
  kept.forEach((s, i) => db2.prepare('UPDATE nodes SET order_index = ? WHERE id = ?').run(i + 1, s.id));
}
