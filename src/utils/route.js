// The focused node lives in the URL path as its chain of ancestors, e.g.
// /css/typography-effects/backgrounds-effects/aspect-ratio (under the
// build's base, /code-universe/ on GitHub Pages). Pages serves 404.html for
// such paths, which the build makes a copy of index.html (vite.config.js).

const BASE = import.meta.env.BASE_URL;

// "Backgrounds & effects" -> "backgrounds-effects", "a[href]" -> "a-href",
// "<h1> - <h6>" -> "h1-h6", "C++" -> "c-plus-plus", "C#" -> "c-sharp".
export function slugify(title) {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/\+/g, ' plus ')
    .replace(/#/g, ' sharp ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// URL -> slug segments ([] for the idle cloud). Old #/... links still work.
export function readUrl(loc = window.location) {
  const path = loc.hash.startsWith('#/') ? BASE + loc.hash.slice(2) : loc.pathname;
  if (!path.startsWith(BASE)) return [];
  return decodeURIComponent(path.slice(BASE.length)).split('/').filter(Boolean);
}

export function toUrl(path) {
  return BASE + (path ?? '');
}
