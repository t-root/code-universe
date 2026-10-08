// The app's only "backend": fetches /data.json once (a static file — see
// server/export.mjs) and answers every query from memory afterwards. This
// is what makes `npm run build` produce a plain static site with no server
// needed at runtime.
import { createSearchIndex, search as searchNodes } from './utils/search.js';
import { slugify } from './utils/route.js';

let ready;

// The fields every list/search result carries — everything else (blocks,
// aliases, description...) is only fetched when a node is actually focused.
function light({ id, parent_id, kind, kind_label, title, short_title, category, color, scale, language, owner_language, importance, child_count }) {
  return { id, parent_id, kind, kind_label, title, short_title, category, color, scale, language, owner_language, importance, child_count };
}

async function load() {
  const url = `${import.meta.env.BASE_URL}data.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const { nodes } = await res.json();

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenByParent = new Map();
  for (const n of nodes) {
    if (n.parent_id === null) continue;
    if (!childrenByParent.has(n.parent_id)) childrenByParent.set(n.parent_id, []);
    childrenByParent.get(n.parent_id).push(n);
  }
  const byOrderThenTitle = (a, b) => a.order_index - b.order_index || a.title.localeCompare(b.title);
  for (const list of childrenByParent.values()) list.sort(byOrderThenTitle);
  const roots = nodes.filter((n) => n.parent_id === null).sort((a, b) => a.order_index - b.order_index);
  const languageByTitle = new Map(roots.filter((n) => n.category === 'Language' || ['HTML', 'CSS', 'SQL'].includes(n.title)).map((n) => [n.title, n]));

  // Roots listed by a language section (Framework, Library, Package...):
  // root id -> the sections that list it.
  const listedIn = new Map();
  for (const n of nodes) {
    for (const rid of n.listed_ids ?? []) {
      if (!listedIn.has(rid)) listedIn.set(rid, []);
      listedIn.get(rid).push(n);
    }
  }

  const index = createSearchIndex(nodes);

  // URL slugs, unique among siblings (a clash keeps the id as a suffix).
  const slugOf = new Map();
  const bySlug = new Map(); // parent id ('' for roots) -> slug -> node id
  for (const [parent, list] of [['', roots], ...childrenByParent]) {
    const taken = new Map();
    for (const n of list) {
      // The short title drops the "(CSS)" a section's full title repeats.
      let slug = slugify(n.short_title ?? n.title) || String(n.id);
      if (taken.has(slug)) slug = `${slug}-${n.id}`;
      taken.set(slug, n.id);
      slugOf.set(n.id, slug);
    }
    bySlug.set(parent, taken);
  }

  return { byId, childrenByParent, roots, languageByTitle, listedIn, index, slugOf, bySlug };
}

function db() {
  ready ??= load();
  return ready;
}

// A node's children: its own, then the roots a language section lists.
const childrenOf = (data, id) => [
  ...(data.childrenByParent.get(id) ?? []),
  ...(data.byId.get(id)?.listed_ids ?? []).map((rid) => data.byId.get(rid)).filter(Boolean),
];

// Slug segments -> node id like api.resolve, but a section's listed roots
// ("javascript/framework/react") count as its children too. null: no such path.
function resolvePath(data, slugs) {
  let id = null;
  for (const slug of slugs) {
    const list = id === null ? data.roots : childrenOf(data, id);
    const hit = list.find((n) => data.slugOf.get(n.id) === slug);
    if (!hit) return null;
    id = hit.id;
  }
  return id;
}

// Every node under `id` (not itself): children, what sections list, and so on.
const scopes = new Map();
function under(data, id) {
  if (scopes.has(id)) return scopes.get(id);
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    for (const n of childrenOf(data, stack.pop())) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      stack.push(n.id);
    }
  }
  scopes.set(id, seen);
  return seen;
}

const languageOf = (data, node) => {
  let n = node;
  while (n && n.parent_id !== null) n = data.byId.get(n.parent_id);
  return n;
};

// The chain above a root that isn't really anyone's child: a framework /
// library / tool listed by a language section hangs off that section
// (language -> section -> root); otherwise off its language alone. `via`
// is the section the user came through, when known.
function ownersOf(data, top, via) {
  const sections = data.listedIn.get(top.id) ?? [];
  const section =
    sections.find((s) => s.id === via) ??
    sections.find((s) => languageOf(data, s)?.title === top.owner_language) ??
    sections[0];
  if (section) {
    // language -> (Fundamentals ->) section -> root
    const chain = [];
    for (let p = data.byId.get(section.parent_id); p; p = data.byId.get(p.parent_id)) chain.unshift(light(p));
    return [...chain, light(section)];
  }
  const language = top.owner_language ? data.languageByTitle.get(top.owner_language) : null;
  return language ? [light(language)] : [];
}

function detail(data, id, via) {
  const node = data.byId.get(id);
  if (!node) return null;
  const path = [];
  for (let p = node.parent_id; p !== null; ) {
    const parent = data.byId.get(p);
    path.unshift(light(parent));
    p = parent.parent_id;
  }
  const related = node.related_ids
    .map((rid) => data.byId.get(rid))
    .filter(Boolean)
    .sort((a, b) => b.importance - a.importance || a.title.localeCompare(b.title))
    .map(light);
  // Everything above the real root (top-down), for roots that belong to a
  // language — and for anything under such a root.
  const top = path[0] ?? node;
  const owners = ownersOf(data, top, via).filter((o) => o.id !== node.id);
  return {
    ...light(node),
    listed_ids: node.listed_ids ?? [],
    description: node.description,
    blocks: node.blocks,
    aliases: node.aliases,
    path,
    owners,
    related,
  };
}

export const api = {
  roots: async () => (await db()).roots.map(light),
  // `via`: the language section the user reached this node's root through.
  node: async (id, via) => detail(await db(), id, via),
  children: async (id) => {
    const data = await db();
    const node = data.byId.get(id);
    // A language section's children: its own notes, then the roots it lists.
    const listed = (node?.listed_ids ?? [])
      .map((rid) => data.byId.get(rid))
      .filter(Boolean)
      .sort((a, b) => a.title.localeCompare(b.title));
    return [...(data.childrenByParent.get(id) ?? []), ...listed].map(light);
  },
  // A node's URL path: its real ancestors' slugs down to its own.
  route: async (id) => {
    const data = await db();
    const parts = [];
    for (let n = data.byId.get(id); n; n = n.parent_id === null ? null : data.byId.get(n.parent_id)) {
      parts.unshift(data.slugOf.get(n.id));
    }
    return parts.join('/');
  },
  // The path the search bar shows for a node: every owner above it too
  // (javascript/testing/jest), which search resolves back to the node.
  scopePath: async (id, via) => {
    const data = await db();
    const d = detail(data, id, via);
    return [...d.owners, ...d.path, d].map((n) => data.slugOf.get(n.id)).join('/');
  },
  // Slug segments -> node id, or null when the path no longer exists.
  resolve: async (segments) => {
    const data = await db();
    let id = null;
    for (const slug of segments) {
      id = data.bySlug.get(id === null ? '' : id)?.get(slug) ?? null;
      if (id === null) return null;
    }
    return id;
  },
  // "javascript/runtime/node": everything before the last "/" is a path
  // (slugs, as in the URL) that narrows the search to what lies under it.
  // `pending`: the path is there but nothing after it yet.
  search: async (q) => {
    const data = await db();
    const cut = q.lastIndexOf('/');
    let text = q;
    let within = null;
    // `at`: the node the whole text names as a path, with or without the
    // closing "/" (Enter goes there).
    let at = null;
    if (cut >= 0) {
      const slugs = (s) => s.split('/').map(slugify).filter(Boolean);
      at = resolvePath(data, slugs(q));
      const scope = resolvePath(data, slugs(q.slice(0, cut)));
      text = q.slice(cut + 1);
      if (scope !== null) {
        if (!text.trim()) return { results: [], closeness: 0, exact: false, pending: true, at };
        within = under(data, scope);
      }
    }
    const result = searchNodes(data.index, text, within);
    return { ...result, at, results: result.results.map((r) => ({ ...r, node: light(r.node) })) };
  },
};
