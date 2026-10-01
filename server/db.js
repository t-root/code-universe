import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const DB_PATH = fileURLToPath(new URL('./data.db', import.meta.url));

// One tree for everything: concepts are root nodes; a concept (e.g. Python)
// can own items (groups), and items own topics (the actual study notes).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS kinds (
  name TEXT PRIMARY KEY,       -- 'concept' | 'item' | 'topic'
  label TEXT NOT NULL,         -- display name ('KHÁI NIỆM'...)
  sort_order INTEGER NOT NULL  -- tie-break when ranking search results
);

CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY,       -- 'Language', 'Data Structure', 'Note'...
  color TEXT NOT NULL,         -- keyword colour in the 3D scene
  scale REAL NOT NULL DEFAULT 1 -- relative keyword size
);

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL REFERENCES kinds(name),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL REFERENCES categories(name),
  language TEXT,
  importance INTEGER NOT NULL DEFAULT 5,
  description TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  raw_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);

CREATE TABLE IF NOT EXISTS aliases (
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  alias TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_node ON aliases(node_id);

CREATE TABLE IF NOT EXISTS relations (
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  related_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, related_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  block_type TEXT NOT NULL,    -- 'para' | 'heading' | 'list' | 'code' | 'deflist'
  lines TEXT NOT NULL          -- JSON-encoded array of strings
);
CREATE INDEX IF NOT EXISTS idx_blocks_node ON blocks(node_id);
`;

export function openDb(file = DB_PATH) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
