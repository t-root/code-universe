import { api } from '../api.js';
import { useKnowledgeStore } from '../store/knowledgeStore.js';
import { readUrl, toUrl } from './route.js';

/**
 * Keeps the focused node and the URL path in step (see utils/route.js):
 *  - opening a node (click, search, <<PREV / NEXT>>) pushes its path; leaving every
 *    node ([ESC] or the Esc key, [X], starting a new search) pushes the
 *    bare URL;
 *  - loading a URL or the browser's back / forward focus the node it names.
 * Returns a cleanup function.
 */
export function startUrlSync() {
  const store = useKnowledgeStore;

  const apply = async () => {
    const segments = readUrl();
    if (!segments.length) {
      if (store.getState().mode !== 'idle') store.getState().resetView();
      return;
    }
    const id = await api.resolve(segments);
    // A path that no longer exists falls back to the bare URL; an old
    // #/... link is rewritten as a path.
    const url = id === null ? toUrl('') : toUrl(await api.route(id));
    if (url !== window.location.pathname || window.location.hash) {
      window.history.replaceState(null, '', url + window.location.search);
    }
    if (id !== null && store.getState().focus?.node.id !== id) {
      store.getState().focusNode(id);
    }
  };

  const unsubscribe = store.subscribe(async (s, prev) => {
    const id = s.focus?.node.id ?? null;
    if (id === (prev.focus?.node.id ?? null)) return;
    const url = toUrl(id === null ? '' : await api.route(id));
    // Superseded while the path was being built.
    if ((store.getState().focus?.node.id ?? null) !== id) return;
    // Already there: the change came from the URL (apply() above).
    if (url === window.location.pathname) return;
    window.history.pushState(null, '', url + window.location.search);
  });

  window.addEventListener('popstate', apply);
  apply();
  return () => {
    unsubscribe();
    window.removeEventListener('popstate', apply);
  };
}
