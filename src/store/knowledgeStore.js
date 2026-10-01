import { create } from 'zustand';
import { api } from '../api.js';

// Monotonic tokens: a slow response for an older query/focus must never
// overwrite the state produced by a newer one.
let searchToken = 0;
let focusToken = 0;

const IDLE = { mode: 'idle', preview: null, focus: null, history: [], future: [], via: null };

export const useKnowledgeStore = create((set, get) => ({
  roots: [],
  query: '',
  // 'idle'    — the cloud floats freely
  // 'preview' — a query that isn't a full title match yet: the result
  //             cluster sits off-centre, closer the better the match
  // 'focused' — one node at dead centre, its children orbiting it and its
  //             content floating beside it in 3D
  ...IDLE,
  hoveredNodeId: null,
  contentHover: false,
  layoutRevision: 0,

  loadRoots: async () => {
    set({ roots: await api.roots() });
  },

  setQuery: (query) => set({ query }),

  search: async (raw, { confirmed = false } = {}) => {
    const q = raw.trim();
    if (!q) return get().resetView();
    const token = ++searchToken;
    const data = await api.search(q);
    if (token !== searchToken) return;

    if (data.results.length === 0) {
      focusToken++;
      set((s) => ({ mode: 'idle', preview: null, focus: null, layoutRevision: s.layoutRevision + 1 }));
      return;
    }

    const top = data.results[0].node;
    // Only a full title match (or an explicit Enter) earns the centre.
    if (confirmed || data.exact) {
      if (get().focus?.node.id !== top.id) get().focusNode(top.id);
      return;
    }

    focusToken++;
    set((s) => ({
      mode: 'preview',
      preview: { results: data.results, closeness: data.closeness },
      focus: null,
      layoutRevision: s.layoutRevision + 1,
    }));
  },

  // `pushHistory`: a step of its own (the node left goes on the back stack
  // and the forward stack is dropped, as in a browser); goBack / goForward
  // move between the stacks themselves.
  focusNode: async (id, { pushHistory = true } = {}) => {
    const token = ++focusToken;
    // Stepping from a listing section (Framework (JavaScript)...) into one of
    // the roots it lists: remember that section as the way in, so the chain
    // reads language -> section -> root. Going deeper keeps the same way in
    // (a stale one is ignored: it only counts if it lists the node's root).
    const cur = get().focus;
    let via = get().via;
    if (cur?.node.listed_ids?.includes(id)) via = cur.node.id;
    const [node, children] = await Promise.all([api.node(id, via), api.children(id)]);
    if (token !== focusToken) return;

    set((s) => {
      const prev = s.focus?.node.id;
      return {
        mode: 'focused',
        preview: null,
        focus: { node, children },
        via,
        history: pushHistory && prev != null && prev !== id ? [...s.history, prev] : s.history,
        future: pushHistory && prev !== id ? [] : s.future,
        layoutRevision: s.layoutRevision + 1,
      };
    });
  },

  goBack: () => {
    const { history, future, focus } = get();
    if (history.length === 0) return;
    set({ history: history.slice(0, -1), future: focus ? [...future, focus.node.id] : future });
    get().focusNode(history[history.length - 1], { pushHistory: false });
  },

  goForward: () => {
    const { history, future, focus } = get();
    if (future.length === 0) return;
    set({ future: future.slice(0, -1), history: focus ? [...history, focus.node.id] : history });
    get().focusNode(future[future.length - 1], { pushHistory: false });
  },

  resetView: () => {
    searchToken++;
    focusToken++;
    set((s) => ({ ...IDLE, query: '', layoutRevision: s.layoutRevision + 1 }));
  },

  setHovered: (id) => set({ hoveredNodeId: id }),
  setContentHover: (contentHover) => set({ contentHover }),
}));
