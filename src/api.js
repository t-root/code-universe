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
  const languageByTitle = new Map(roots.filter((n) => n.category === 'Language').map((n) => [n.title, n]));

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

// The chain above a root that isn't really anyone's child: a framework /
// library / tool listed by a language section hangs off that section
// (language -> section -> root); otherwise off its language alone. `via`
// is the section the user came through, when known.
function ownersOf(data, top, via) {
  const sections = data.listedIn.get(top.id) ?? [];
  const section =
    sections.find((s) => s.id === via) ??
    sections.find((s) => data.byId.get(s.parent_id)?.title === top.owner_language) ??
    sections[0];
  if (section) {
    const language = data.byId.get(section.parent_id);
    return language ? [light(language), light(section)] : [light(section)];
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
  search: async (q) => {
    const data = await db();
    const result = searchNodes(data.index, q);
    return { ...result, results: result.results.map((r) => ({ ...r, node: light(r.node) })) };
  },
};
