// Ranks nodes against a query and assembles the small cluster the 3D scene
// shows for it: the best match plus the other words that look like the
// query. Runs in the browser over the nodes loaded from data.json —
// ported from the SQLite-backed version this project used before it became
// a static site (see server/export.mjs for where the data comes from).

// No cap on how many results show: after the best match, every node whose
// title looks at least this much like the query (0..100, see closenessOf).
// A title containing the query only reaches it when it is at most ~3.5x the
// query's length, so short queries stay small on their own.
const MIN_PERCENT = 20;

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// How close the typed text is to a node's own displayed title, 0..1.
// Only a full (case-insensitive) title match counts as 1 — aliases don't.
// Titles that merely look alike (typos, one letter off) get a smaller share.
function closenessOf(query, title) {
  if (title === query) return 1;
  if (title.startsWith(query)) return query.length / title.length;
  if (title.includes(query)) return (0.7 * query.length) / title.length;
  const similar = 1 - editDistance(query, title) / Math.max(query.length, title.length);
  return similar >= 0.6 ? similar * 0.6 : 0;
}

// Multi-word queries ("sql join") also get credit per word matched.
function matchOf(query, tokens, title) {
  const whole = closenessOf(query, title);
  if (tokens.length < 2) return whole;
  const perToken = tokens.reduce((sum, t) => sum + closenessOf(t, title), 0) / tokens.length;
  return Math.max(whole, perToken);
}

function scoreNode(entry, tokens, index) {
  const { title, aliases, category, language, text } = entry;
  let score = 0;
  let matched = 0;
  for (const t of tokens) {
    let s = 0;
    if (title === t) s = 100;
    // An alias hit (90) or a prefix hit, whichever is higher. A prefix ramps
    // toward (never reaching) 100 as more of the title is typed.
    else if (aliases.includes(t) || title.startsWith(t)) {
      s = Math.max(aliases.includes(t) ? 90 : 0, title.startsWith(t) ? 60 + Math.round(39 * (t.length / title.length)) : 0);
    }
    // Query containing the whole title only counts for real words — otherwise
    // one-letter titles like "C" would match anything with a c in it.
    else if (title.includes(t) || (title.length >= 3 && t.includes(title))) s = 60;
    else if (aliases.some((a) => a.includes(t))) s = 50;
    else if (entry.relatedIds.some((id) => index.entries.get(id)?.title === t)) s = 60;
    else if (category.includes(t)) s = 40;
    else if (language.includes(t)) s = 30;
    else if (t.length >= 3 && text.includes(t)) s = 15;
    else if (t.length >= 3) {
      // Typo tolerance: a title only a letter or two off still counts.
      const similar = 1 - editDistance(t, title) / Math.max(t.length, title.length);
      if (similar >= 0.6) s = Math.round(similar * 50);
    }
    if (s > 0) matched++;
    score += s;
  }
  if (tokens.length > 1 && matched === tokens.length) score += 20 * tokens.length;
  return score;
}

// `nodes` are the raw objects from data.json (each already carries its own
// `aliases` and `related_ids`).
export function createSearchIndex(nodes) {
  const entries = new Map();
  for (const node of nodes) {
    const { description, raw_text, kind_rank, aliases, related_ids, ...light } = node;
    entries.set(node.id, {
      node: light,
      kindRank: kind_rank,
      // The title as shown ("Map", not "Map (JavaScript)"): the language
      // suffix only keeps titles unique, so it must not make "javas" match
      // every JavaScript note. The full title stays searchable as an alias.
      title: (node.short_title ?? node.title).toLowerCase(),
      aliases: [...new Set([...aliases, node.title].map((a) => a.toLowerCase()))],
      relatedIds: related_ids,
      category: (node.category ?? '').toLowerCase(),
      language: (node.language ?? '').toLowerCase(),
      // Belongs to one programming language (a node inside its tree, or a
      // root it owns). General words rank above these when titles tie.
      owned: !!node.owner_language || (node.parent_id !== null && !!node.language),
      text: `${description ?? ''}\n${raw_text ?? ''}`.toLowerCase(),
    });
  }
  return { entries };
}

export function search(index, rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return { results: [], closeness: 0, exact: false };
  const tokens = query.split(/\s+/).filter(Boolean);

  const ranked = [];
  for (const entry of index.entries.values()) {
    const score = scoreNode(entry, tokens, index);
    if (score > 0) ranked.push({ entry, score });
  }
  if (ranked.length === 0) return { results: [], closeness: 0, exact: false };
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      // a general word lands on its language-neutral hub, not on one language's node
      a.entry.owned - b.entry.owned ||
      b.entry.node.importance - a.entry.node.importance ||
      a.entry.kindRank - b.entry.kindRank
  );

  // The best match always shows (it may have matched through an alias);
  // after it, only words that actually look like the query.
  const primary = ranked[0].entry;
  const results = [];
  for (const { entry, score } of ranked) {
    const percent = Math.round(matchOf(query, tokens, entry.title) * 100);
    if (results.length > 0 && percent < MIN_PERCENT) continue;
    const tier = results.length === 0 ? 'center' : results.length <= 4 ? 'near' : 'medium';
    results.push({ node: entry.node, tier, score, percent });
  }

  return {
    results,
    closeness: matchOf(query, tokens, primary.title),
    exact: primary.title === query,
  };
}
