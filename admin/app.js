// Code Universe admin UI (plain ES module, no build). Talks to /admin/api
// (server/admin.mjs, mounted on the dev server).

const API = '/admin/api';
const ROOT = 'root';
const BLOCK_TYPES = [
  ['para', 'Đoạn văn'],
  ['heading', 'Tiêu đề nhỏ'],
  ['list', 'Danh sách'],
  ['code', 'Code'],
  ['deflist', 'Định nghĩa'],
];

// ------------------------------------------------------------------ helpers

async function api(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  if (value !== undefined) el.value = value; // after <option> children exist
  return el;
}
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function toast(text, type = '') {
  const el = h('div', { class: `toast ${type}` }, text);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'err' ? 8000 : type === 'warn' ? 7000 : 3000);
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'err');
    return undefined;
  }
}

function modal(title, body, { wide = false } = {}) {
  const overlay = h('div', { class: 'overlay' });
  const box = h('div', { class: `modal${wide ? ' wide' : ''}` }, h('h3', {}, title), body);
  overlay.append(box);
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      box.dispatchEvent(new CustomEvent('dismiss'));
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) {
      close();
      box.dispatchEvent(new CustomEvent('dismiss'));
    }
  });
  document.body.append(overlay);
  return { box, close };
}

function confirmDialog(message, okLabel = 'Đồng ý', danger = false) {
  return new Promise((resolve) => {
    const ok = h('button', { class: danger ? 'danger' : 'primary', onclick: () => (m.close(), resolve(true)) }, okLabel);
    const no = h('button', { onclick: () => (m.close(), resolve(false)) }, 'Hủy');
    const m = modal('Xác nhận', h('div', {}, h('div', { style: 'white-space:pre-wrap' }, message), h('div', { class: 'btns' }, no, ok)));
    m.box.addEventListener('dismiss', () => resolve(false));
    ok.focus();
  });
}

// Search for a node by title / alias / #id; resolves with it, or null.
function pickNode(title, { exclude = new Set(), allowRoot = false } = {}) {
  return new Promise((resolve) => {
    let results = [];
    let active = 0;
    const list = h('div', { class: 'results' });
    const input = h('input', { type: 'search', placeholder: 'Gõ tiêu đề, alias hoặc #id…', style: 'width:100%' });
    const draw = () => {
      list.replaceChildren(
        ...(allowRoot ? [h('div', { class: 'res', onclick: () => (m.close(), resolve({ id: null })) }, '— Không có cha (node gốc) —')] : []),
        ...results.map((r, i) =>
          h(
            'div',
            { class: `res${i === active ? ' active' : ''}`, onclick: () => (m.close(), resolve(r)) },
            `${r.title}  `,
            h('span', { class: 'kind' }, r.kind),
            h('small', {}, `#${r.id}${r.path ? ' · ' + r.path : ''}`)
          )
        )
      );
    };
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        results = q ? (await guarded(() => api('GET', `/search?q=${encodeURIComponent(q)}`)))?.results.filter((r) => !exclude.has(r.id)) ?? [] : [];
        active = 0;
        draw();
      }, 180);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') (active = Math.min(results.length - 1, active + 1)), draw();
      else if (e.key === 'ArrowUp') (active = Math.max(0, active - 1)), draw();
      else if (e.key === 'Enter' && results[active]) (m.close(), resolve(results[active]));
    });
    const m = modal(title, h('div', {}, input, list, h('div', { class: 'btns' }, h('button', { onclick: () => (m.close(), resolve(null)) }, 'Hủy'))));
    m.box.addEventListener('dismiss', () => resolve(null));
    draw();
    input.focus();
  });
}

// ------------------------------------------------------------------- state

const state = {
  meta: { kinds: [], categories: [], languages: [] },
  nodes: new Map(), // id -> {id,parent_id,kind,title,category,language,importance,order_index}
  kids: new Map(), // parent id | ROOT -> ids in order
  expanded: new Set(JSON.parse(localStorage.getItem('admin.expanded') ?? '[]')),
  f: { text: '', category: '', language: '', section: '', kind: '' },
  selected: null,
  detail: null, // what /node/:id returned
  draft: null, // editable copy
  dirty: false,
};
const colorOf = (cat) => state.meta.categories.find((c) => c.name === cat)?.color ?? '#9FB3C8';
const keyOf = (n) => (n.parent_id == null ? ROOT : n.parent_id);

function rebuildKids() {
  state.kids = new Map();
  const sorted = [...state.nodes.values()].sort((a, b) => a.order_index - b.order_index || a.id - b.id);
  for (const n of sorted) {
    const k = keyOf(n);
    if (!state.kids.has(k)) state.kids.set(k, []);
    state.kids.get(k).push(n.id);
  }
}
const saveExpanded = () => localStorage.setItem('admin.expanded', JSON.stringify([...state.expanded]));

async function loadMeta() {
  state.meta = await api('GET', '/meta');
}
async function loadTree() {
  const { nodes } = await api('GET', '/tree');
  state.nodes = new Map(nodes.map((n) => [n.id, n]));
  rebuildKids();
  fillFilters();
}
async function loadStats() {
  const s = await api('GET', '/stats');
  $('#stats').textContent = `${s.nodes} node · ${s.roots} gốc · ${s.blocks} khối · ${s.relations} quan hệ · ${s.backups} bản sao lưu`;
}

// -------------------------------------------------------------------- tree

// A language's sections ("Module (Go)", "Library (Go)"...) are the items right
// under a language root, plus the ones grouped in its Fundamentals / Module
// (Syntax, Variable, OOP, Standard library...). Their name is the title
// without " (X)".
const sectionName = (n) => n.title.replace(/ \([^()]*(\([^()]*\))?[^()]*\)$/, '');
const parentOf = (n) => (n.parent_id == null ? null : state.nodes.get(n.parent_id));
const isSection = (n) => {
  if (n.kind !== 'item') return false;
  const p = parentOf(n);
  if (!p) return false;
  if (p.parent_id == null) return p.category === 'Language' || ['HTML', 'CSS', 'SQL'].includes(p.title);
  const top = parentOf(p);
  return !!top && top.parent_id == null && (top.category === 'Language' || ['HTML', 'CSS', 'SQL'].includes(top.title)) && /^(Fundamentals|Module)/.test(p.title);
};
const depthOf = (n) => {
  let d = 0;
  for (let p = parentOf(n); p; p = parentOf(p)) d++;
  return d;
};

// Which nodes the filters let through. null = no filter at all. Otherwise:
//   show     matching nodes and the ancestors leading to them
//   full     matching nodes whose whole subtree is listed too (structural
//            filters only: pick "Framework" and you still see their children)
//   autoOpen open every branch down to the matches (text search)
function computeScope() {
  const f = state.f;
  const q = f.text.trim().toLowerCase().replace(/^#/, '');
  const structural = f.category || f.language || f.section || f.kind;
  if (!q && !structural) return null;
  const match = (n) => {
    if (q && !n.title.toLowerCase().includes(q) && String(n.id) !== q) return false;
    if (f.category && n.category !== f.category) return false;
    if (f.kind && n.kind !== f.kind) return false;
    if (f.language && n.language !== f.language) return false;
    if (f.section && !(isSection(n) && sectionName(n) === f.section)) return false;
    return true;
  };
  const show = new Set();
  const full = new Set();
  const open = new Set(); // ancestors of matches: opened so the matches are in view
  for (const n of state.nodes.values()) {
    if (!match(n)) continue;
    if (!q) full.add(n.id);
    for (let c = n; c && !show.has(c.id); c = parentOf(c)) show.add(c.id);
    for (let c = parentOf(n); c && !open.has(c.id); c = parentOf(c)) open.add(c.id);
  }
  return { show, full, open, autoOpen: !!q };
}
// A branch is forced open only to reveal matches below it; one that is itself
// a match (structural filters) opens and closes like any other.
const isOpen = (scope, id) =>
  !!scope?.autoOpen || (!!scope?.open.has(id) && !scope.full.has(id)) || state.expanded.has(id);

function visibleRows(scope) {
  const rows = [];
  const walk = (id, depth, inFull) => {
    if (scope && !inFull && !scope.show.has(id)) return;
    rows.push({ id, depth });
    const ks = state.kids.get(id) ?? [];
    if (ks.length && isOpen(scope, id)) {
      const nextFull = inFull || (scope?.full.has(id) ?? false);
      for (const k of ks) walk(k, depth + 1, nextFull);
    }
  };
  for (const id of state.kids.get(ROOT) ?? []) walk(id, 0, false);
  return rows;
}

function renderTree() {
  const scope = computeScope();
  const rows = visibleRows(scope);
  const capped = rows.slice(0, 4000);
  $('#tree-count').textContent = scope ? `${rows.length} dòng khớp bộ lọc` : `${state.nodes.size} node`;
  $('#tree').innerHTML =
    capped
      .map(({ id, depth }) => {
        const n = state.nodes.get(id);
        const count = state.kids.get(id)?.length ?? 0;
        const open = isOpen(scope, id);
        return `<div class="trow${id === state.selected ? ' sel' : ''}" data-id="${id}" style="padding-left:${8 + depth * 16}px">
          <span class="tog" data-tog="${id}">${count ? (open ? '▾' : '▸') : ''}</span>
          <i class="dot" style="background:${colorOf(n.category)}"></i>
          <span class="ttl" title="#${id} · ${esc(n.title)}">${esc(n.title)}</span>
          ${n.kind !== 'concept' ? `<span class="kind">${esc(n.kind)}</span>` : ''}
          ${count ? `<span class="cnt">${count}</span>` : ''}
        </div>`;
      })
      .join('') + (rows.length > capped.length ? `<div class="muted" style="padding:8px">… còn ${rows.length - capped.length} dòng, hãy lọc thêm</div>` : '');
}

// The filter dropdowns: only values that exist, with how many nodes use them.
function fillFilters() {
  const count = (fn) => {
    const m = new Map();
    for (const n of state.nodes.values()) {
      const k = fn(n);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const fill = (sel, placeholder, entries, current) => {
    sel.replaceChildren(
      h('option', { value: '' }, placeholder),
      ...entries.map(([value, label]) => h('option', { value }, label))
    );
    sel.value = entries.some(([v]) => v === current) ? current : '';
  };
  const sorted = (m, order) => [...m.entries()].sort((a, b) => (order ? order(a[0]) - order(b[0]) : 0) || a[0].localeCompare(b[0]));

  const cats = count((n) => n.category);
  fill($('#f-category'), 'Nhóm (category): tất cả', sorted(cats).map(([k, c]) => [k, `${k} (${c})`]), state.f.category);

  const langs = count((n) => n.language);
  fill($('#f-language'), 'Ngôn ngữ: tất cả', sorted(langs).map(([k, c]) => [k, `${k} (${c})`]), state.f.language);

  const secs = count((n) => (isSection(n) ? sectionName(n) : null));
  const order = [
    'Fundamentals', 'Getting started', 'Syntax', 'Variable', 'Data type', 'Control flow', 'Function', 'OOP', 'Error handling',
    'Async & concurrency', 'Runtime', 'Module', 'Standard library', 'Package', 'Package manager', 'Library', 'Framework', 'Testing',
    'Tooling', 'Best practices', 'Tooling & testing',
  ];
  fill(
    $('#f-section'),
    'Mục của ngôn ngữ: tất cả',
    sorted(secs, (k) => (order.includes(k) ? order.indexOf(k) : 99)).map(([k, c]) => [k, `${k} (${c})`]),
    state.f.section
  );

  const kinds = count((n) => n.kind);
  fill($('#f-kind'), 'Kind: tất cả', sorted(kinds).map(([k, c]) => [k, `${k} (${c})`]), state.f.kind);
}

$('#tree').addEventListener('click', (e) => {
  const tog = e.target.closest('[data-tog]');
  if (tog && tog.textContent.trim()) {
    const id = Number(tog.dataset.tog);
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    saveExpanded();
    renderTree();
    return;
  }
  const row = e.target.closest('.trow');
  if (row) select(Number(row.dataset.id));
});

let filterTimer;
$('#filter').addEventListener('input', (e) => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    state.f.text = e.target.value;
    renderTree();
  }, 150);
});
for (const [sel, key] of [['#f-category', 'category'], ['#f-language', 'language'], ['#f-section', 'section'], ['#f-kind', 'kind']]) {
  $(sel).addEventListener('change', (e) => {
    state.f[key] = e.target.value;
    renderTree();
  });
}
$('#btn-clear').addEventListener('click', () => {
  state.f = { text: '', category: '', language: '', section: '', kind: '' };
  $('#filter').value = '';
  fillFilters();
  renderTree();
});

// "Mở tới cấp N": N tiers are shown — branches above tier N open, deeper ones
// close (1 = only the roots, 99 = everything). The filter still decides what
// is listed.
$('#f-level').addEventListener('change', (e) => {
  const level = Number(e.target.value);
  e.target.value = '';
  if (Number.isNaN(level)) return;
  state.expanded = new Set();
  for (const n of state.nodes.values()) if (state.kids.has(n.id) && depthOf(n) < level - 1) state.expanded.add(n.id);
  saveExpanded();
  renderTree();
});
$('#btn-root').addEventListener('click', () => createDialog(null));

function revealInTree(id) {
  for (let n = state.nodes.get(id); n && n.parent_id != null; n = state.nodes.get(n.parent_id)) state.expanded.add(n.parent_id);
  saveExpanded();
}

// ------------------------------------------------------------------ select

function makeDraft(d) {
  const n = d.node;
  return {
    title: n.title,
    slug: n.slug ?? '',
    kind: n.kind,
    category: n.category,
    language: n.language ?? '',
    importance: n.importance,
    order_index: n.order_index,
    description: n.description ?? '',
    aliases: [...d.aliases],
    blocks: d.blocks.map((b) => ({ type: b.type, text: b.lines.join('\n') })),
  };
}

async function select(id, { force = false } = {}) {
  if (!force && state.dirty && !(await confirmDialog('Có thay đổi chưa lưu ở node đang mở. Bỏ qua và chuyển node?', 'Bỏ thay đổi', true))) return;
  const detail = await guarded(() => api('GET', `/node/${id}`));
  if (!detail) return;
  state.selected = id;
  state.detail = detail;
  state.draft = makeDraft(detail);
  state.dirty = false;
  revealInTree(id);
  renderTree();
  renderEditor();
  $('#tree').querySelector('.trow.sel')?.scrollIntoView({ block: 'nearest' });
  history.replaceState(null, '', `#${id}`);
  document.title = `${detail.node.title} · Admin`;
}

function markDirty() {
  if (state.dirty) return;
  state.dirty = true;
  document.querySelector('.dirty')?.removeAttribute('hidden');
}

// ------------------------------------------------------------------ editor

function field(label, input, cls = '') {
  return h('label', { class: `f ${cls}` }, label, input);
}

function renderEditor() {
  const box = $('#editor');
  const top = box.scrollTop;
  box.replaceChildren();
  const d = state.detail;
  if (!d) {
    box.append(h('div', { class: 'empty' }, 'Chọn một node ở cây bên trái, hoặc bấm "+ Gốc" để tạo node gốc mới.'));
    return;
  }
  const dr = state.draft;
  const input = (key, props = {}) =>
    h('input', {
      value: dr[key],
      ...props,
      oninput: (e) => {
        dr[key] = props.type === 'number' ? e.target.value : e.target.value;
        markDirty();
      },
    });
  const select_ = (key, options) =>
    h(
      'select',
      { value: dr[key], onchange: (e) => ((dr[key] = e.target.value), markDirty()) },
      options.map((o) => h('option', { value: o.value }, o.label))
    );

  // ---- header
  box.append(
    h(
      'div',
      { class: 'crumbs' },
      d.path.slice(0, -1).flatMap((p) => [h('a', { onclick: () => select(p.id) }, p.title), '›']),
      h('span', {}, `#${d.node.id}`)
    ),
    h(
      'div',
      { class: 'head' },
      h('h1', {}, dr.title || '(chưa có tiêu đề)'),
      h('span', { class: 'dirty', hidden: !state.dirty }, '● chưa lưu'),
      h('button', { class: 'primary', onclick: save, title: 'Ctrl+S' }, 'Lưu'),
      h('button', { onclick: () => select(d.node.id, { force: true }) }, 'Hoàn tác'),
      h('button', { onclick: () => createDialog(d.node.id) }, '+ Thêm con'),
      h('button', { onclick: moveNode }, 'Di chuyển…'),
      h('button', { class: 'danger', onclick: deleteNode }, 'Xóa')
    )
  );

  // ---- info
  box.append(
    h(
      'div',
      { class: 'sec' },
      h('h2', {}, 'Thông tin'),
      h(
        'div',
        { class: 'grid' },
        field('Tiêu đề', input('title'), 'wide'),
        field('Kind (loại node)', select_('kind', state.meta.kinds.map((k) => ({ value: k.name, label: `${k.name} — ${k.label}` })))),
        field('Category (màu / cỡ trong scene)', select_('category', state.meta.categories.map((c) => ({ value: c.name, label: c.name })))),
        field('Language', input('language', { list: 'langs', placeholder: 'vd: Python' })),
        field('Độ quan trọng (1–10)', input('importance', { type: 'number', min: 1, max: 10 })),
        field('Thứ tự trong cha', input('order_index', { type: 'number' })),
        field('Slug (để trống = tự sinh từ tiêu đề)', input('slug')),
        field(
          'Mô tả ngắn',
          h('textarea', { rows: 2, value: dr.description, oninput: (e) => ((dr.description = e.target.value), markDirty()) }),
          'wide'
        )
      )
    )
  );

  // ---- aliases
  const aliasInput = h('input', {
    placeholder: 'Thêm alias rồi Enter…',
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = e.target.value.trim();
      if (v && !dr.aliases.includes(v)) {
        dr.aliases.push(v);
        markDirty();
        renderEditor();
        $('#editor input[placeholder^="Thêm alias"]').focus();
      }
    },
  });
  box.append(
    h(
      'div',
      { class: 'sec' },
      h('h2', {}, `Alias (${dr.aliases.length})`),
      h(
        'div',
        { class: 'chips' },
        dr.aliases.map((a, i) =>
          h('span', { class: 'chip' }, a, h('button', { title: 'Xóa', onclick: () => (dr.aliases.splice(i, 1), markDirty(), renderEditor()) }, '✕'))
        ),
        aliasInput
      )
    )
  );

  // ---- blocks
  const move = (i, delta) => {
    const j = i + delta;
    if (j < 0 || j >= dr.blocks.length) return;
    [dr.blocks[i], dr.blocks[j]] = [dr.blocks[j], dr.blocks[i]];
    markDirty();
    renderEditor();
  };
  const addBlock = (type) => {
    dr.blocks.push({ type, text: '' });
    markDirty();
    renderEditor();
    const areas = document.querySelectorAll('.block textarea');
    areas[areas.length - 1]?.focus();
  };
  box.append(
    h(
      'div',
      { class: 'sec' },
      h('h2', {}, `Nội dung (${dr.blocks.length} khối)`),
      dr.blocks.map((b, i) =>
        h(
          'div',
          { class: `block t-${b.type}` },
          h(
            'div',
            { class: 'block-bar' },
            h(
              'select',
              { value: b.type, onchange: (e) => ((b.type = e.target.value), markDirty(), renderEditor()) },
              BLOCK_TYPES.map(([v, l]) => h('option', { value: v }, `${v} — ${l}`))
            ),
            h('span', { class: 'spacer' }),
            h('button', { class: 'small', onclick: () => move(i, -1), title: 'Lên' }, '↑'),
            h('button', { class: 'small', onclick: () => move(i, 1), title: 'Xuống' }, '↓'),
            h('button', { class: 'small danger', onclick: () => (dr.blocks.splice(i, 1), markDirty(), renderEditor()), title: 'Xóa khối' }, '✕')
          ),
          h('textarea', {
            rows: Math.min(30, Math.max(2, b.text.split('\n').length + 1)),
            value: b.text,
            spellcheck: 'false',
            oninput: (e) => {
              b.text = e.target.value;
              e.target.rows = Math.min(30, Math.max(2, b.text.split('\n').length + 1));
              markDirty();
            },
            onkeydown: (e) => {
              if (e.key === 'Tab' && b.type === 'code') {
                e.preventDefault();
                const t = e.target;
                t.setRangeText('    ', t.selectionStart, t.selectionEnd, 'end');
                t.dispatchEvent(new Event('input'));
              }
            },
          })
        )
      ),
      h('div', { class: 'addbar' }, BLOCK_TYPES.map(([v]) => h('button', { onclick: () => addBlock(v) }, `+ ${v}`)))
    )
  );

  // ---- relations (saved at once; they don't touch the draft)
  box.append(
    h(
      'div',
      { class: 'sec' },
      h('h2', {}, `Quan hệ (${d.related.length})`, h('span', { class: 'spacer' }), h('button', { onclick: addRelation }, '+ Thêm quan hệ')),
      d.related.length
        ? h(
            'div',
            { class: 'list' },
            d.related.map((r) =>
              h(
                'div',
                { class: 'item' },
                h('span', { class: 'ttl', onclick: () => select(r.id) }, r.title),
                h('span', { class: 'kind' }, r.kind),
                h('small', { class: 'spacer' }, `#${r.id}${r.path ? ' · ' + r.path : ''}`),
                h('button', { class: 'small danger', onclick: () => removeRelation(r.id), title: 'Gỡ quan hệ' }, '✕')
              )
            )
          )
        : h('div', { class: 'muted' }, 'Chưa có quan hệ. Quan hệ hai chiều: thêm ở node này thì node kia cũng thấy.')
    )
  );

  // ---- children (reorder at once)
  box.append(
    h(
      'div',
      { class: 'sec' },
      h('h2', {}, `Node con (${d.children.length})`, h('span', { class: 'spacer' }), h('button', { onclick: () => createDialog(d.node.id) }, '+ Thêm con')),
      d.children.length
        ? h(
            'div',
            { class: 'list' },
            d.children.map((c, i) =>
              h(
                'div',
                { class: 'item' },
                h('small', {}, `${i + 1}.`),
                h('span', { class: 'ttl', onclick: () => select(c.id) }, c.title),
                h('span', { class: 'kind' }, c.kind),
                h('span', { class: 'spacer' }),
                h('button', { class: 'small', disabled: i === 0, onclick: () => reorderChild(i, -1) }, '↑'),
                h('button', { class: 'small', disabled: i === d.children.length - 1, onclick: () => reorderChild(i, 1) }, '↓')
              )
            )
          )
        : h('div', { class: 'muted' }, 'Chưa có node con.')
    )
  );

  box.scrollTop = top;
}

// ----------------------------------------------------------------- actions

async function save() {
  const dr = state.draft;
  if (!state.detail || !dr) return;
  const id = state.detail.node.id;
  const res = await guarded(() =>
    api('PUT', `/node/${id}`, {
      ...dr,
      importance: Number(dr.importance),
      order_index: Number(dr.order_index),
      blocks: dr.blocks.map((b) => ({ type: b.type, lines: b.text.split('\n') })),
    })
  );
  if (!res) return;
  toast('Đã lưu');
  for (const w of res.warnings ?? []) toast(w, 'warn');
  const fresh = await api('GET', `/node/${id}`);
  const n = fresh.node;
  state.nodes.set(id, { id, parent_id: n.parent_id, kind: n.kind, title: n.title, category: n.category, language: n.language, importance: n.importance, order_index: n.order_index });
  rebuildKids();
  state.detail = fresh;
  state.draft = makeDraft(fresh);
  state.dirty = false;
  renderTree();
  renderEditor();
  loadStats();
}

async function createDialog(parentId) {
  const parent = parentId == null ? null : state.nodes.get(parentId);
  const defaults = parent ? { kind: 'concept', category: 'Concept' } : { kind: 'concept', category: 'Concept' };
  const f = { title: '', kind: defaults.kind, category: defaults.category, language: parent?.language ?? '', importance: 5 };
  const title = h('input', { placeholder: 'Tiêu đề (tiếng Anh, duy nhất)', style: 'width:100%', oninput: (e) => (f.title = e.target.value) });
  const kind = h('select', { value: f.kind, onchange: (e) => (f.kind = e.target.value) }, state.meta.kinds.map((k) => h('option', { value: k.name }, `${k.name} — ${k.label}`)));
  const category = h('select', { value: f.category, onchange: (e) => (f.category = e.target.value) }, state.meta.categories.map((c) => h('option', { value: c.name }, c.name)));
  const language = h('input', { value: f.language, list: 'langs', oninput: (e) => (f.language = e.target.value) });
  const importance = h('input', { type: 'number', min: 1, max: 10, value: 5, oninput: (e) => (f.importance = e.target.value) });
  const submit = async () => {
    if (!f.title.trim()) return toast('Thiếu tiêu đề', 'err');
    if (state.dirty && !(await confirmDialog('Có thay đổi chưa lưu ở node đang mở sẽ bị bỏ khi chuyển sang node mới. Tiếp tục?', 'Tiếp tục', true))) return;
    const res = await guarded(() => api('POST', '/node', { parent_id: parentId, ...f, importance: Number(f.importance), language: f.language || null }));
    if (!res) return;
    m.close();
    toast('Đã tạo node');
    for (const w of res.warnings ?? []) toast(w, 'warn');
    await loadTree();
    if (parentId != null) (state.expanded.add(parentId), saveExpanded());
    await select(res.id, { force: true });
    loadStats();
  };
  const m = modal(
    parent ? `Thêm con cho “${parent.title}”` : 'Thêm node gốc',
    h(
      'div',
      { class: 'grid', style: 'grid-template-columns:1fr 1fr' },
      field('Tiêu đề', title, 'wide'),
      field('Kind', kind),
      field('Category', category),
      field('Language', language),
      field('Độ quan trọng', importance),
      h('div', { class: 'btns wide', style: 'grid-column:1/-1' }, h('button', { onclick: () => m.close() }, 'Hủy'), h('button', { class: 'primary', onclick: submit }, 'Tạo'))
    )
  );
  m.box.addEventListener('keydown', (e) => e.key === 'Enter' && e.target.tagName === 'INPUT' && submit());
  title.focus();
}

async function deleteNode() {
  const id = state.detail.node.id;
  const { count } = await api('GET', `/node/${id}/descendants`);
  const text =
    `Xóa “${state.detail.node.title}” (#${id})?\n` +
    (count ? `Sẽ xóa luôn ${count} node con cháu, cùng nội dung, alias và quan hệ của chúng.\n` : '') +
    'Không hoàn tác được (chỉ khôi phục từ bản sao lưu trong server/backups/).';
  if (!(await confirmDialog(text, 'Xóa', true))) return;
  const parentId = state.detail.node.parent_id;
  const res = await guarded(() => api('DELETE', `/node/${id}`));
  if (!res) return;
  toast(`Đã xóa ${res.deleted} node`);
  await loadTree();
  state.detail = null;
  state.draft = null;
  state.dirty = false;
  state.selected = null;
  if (parentId != null && state.nodes.has(parentId)) await select(parentId, { force: true });
  else (renderTree(), renderEditor(), history.replaceState(null, '', location.pathname));
  loadStats();
}

async function moveNode() {
  const id = state.detail.node.id;
  const picked = await pickNode('Chuyển tới cha mới', { exclude: new Set([id]), allowRoot: true });
  if (!picked) return;
  const res = await guarded(() => api('POST', `/node/${id}/move`, { parent_id: picked.id }));
  if (!res) return;
  toast('Đã di chuyển');
  await loadTree();
  if (picked.id != null) (state.expanded.add(picked.id), saveExpanded());
  await select(id, { force: true });
}

async function addRelation() {
  const id = state.detail.node.id;
  const picked = await pickNode('Thêm quan hệ với node…', { exclude: new Set([id, ...state.detail.related.map((r) => r.id)]) });
  if (!picked) return;
  if (!(await guarded(() => api('POST', '/relations', { node_id: id, related_id: picked.id })))) return;
  await refreshDetailKeepingDraft();
}
async function removeRelation(relatedId) {
  const id = state.detail.node.id;
  if (!(await guarded(() => api('DELETE', '/relations', { node_id: id, related_id: relatedId })))) return;
  await refreshDetailKeepingDraft();
}
async function refreshDetailKeepingDraft() {
  const fresh = await api('GET', `/node/${state.detail.node.id}`);
  state.detail = fresh;
  renderEditor();
  loadStats();
}

async function reorderChild(index, delta) {
  const children = [...state.detail.children];
  const j = index + delta;
  [children[index], children[j]] = [children[j], children[index]];
  if (!(await guarded(() => api('POST', '/reorder', { ids: children.map((c) => c.id) })))) return;
  children.forEach((c, i) => {
    c.order_index = i;
    const n = state.nodes.get(c.id);
    if (n) n.order_index = i;
  });
  state.detail.children = children;
  rebuildKids();
  renderTree();
  renderEditor();
}

// -------------------------------------------------- category / kind manager

function metaDialog() {
  const body = h('div');
  const m = modal('Category và Kind', body, { wide: true });
  const draw = async () => {
    await loadMeta();
    const catRows = state.meta.categories.map((c) => {
      const color = h('input', { type: 'color', value: c.color });
      const scale = h('input', { type: 'number', step: '0.05', value: c.scale, style: 'width:80px' });
      return h(
        'tr',
        {},
        h('td', {}, c.name),
        h('td', {}, color),
        h('td', {}, scale),
        h('td', {}, `${c.used}`),
        h(
          'td',
          {},
          h('button', { class: 'small', onclick: () => guarded(async () => (await api('PUT', `/categories/${encodeURIComponent(c.name)}`, { color: color.value, scale: scale.value }), toast('Đã lưu'), renderTree())) }, 'Lưu'),
          ' ',
          h('button', { class: 'small danger', disabled: c.used > 0, title: c.used ? 'Còn node đang dùng' : 'Xóa', onclick: () => guarded(async () => (await api('DELETE', `/categories/${encodeURIComponent(c.name)}`), draw())) }, '✕')
        )
      );
    });
    const newCat = { name: '', color: '#E8F0FF', scale: 1 };
    const kindRows = state.meta.kinds.map((k) => {
      const label = h('input', { value: k.label, style: 'width:140px' });
      const order = h('input', { type: 'number', value: k.sort_order, style: 'width:70px' });
      return h(
        'tr',
        {},
        h('td', {}, k.name),
        h('td', {}, label),
        h('td', {}, order),
        h(
          'td',
          {},
          h('button', { class: 'small', onclick: () => guarded(async () => (await api('PUT', `/kinds/${encodeURIComponent(k.name)}`, { label: label.value, sort_order: order.value }), toast('Đã lưu'))) }, 'Lưu'),
          ' ',
          h('button', { class: 'small danger', title: 'Xóa (chỉ khi không node nào dùng)', onclick: () => guarded(async () => (await api('DELETE', `/kinds/${encodeURIComponent(k.name)}`), draw())) }, '✕')
        )
      );
    });
    const newKind = { name: '', label: '', sort_order: 5 };
    body.replaceChildren(
      h('h4', {}, 'Category — màu và cỡ chữ của keyword trong scene'),
      h('table', {}, h('tr', {}, h('th', {}, 'Tên'), h('th', {}, 'Màu'), h('th', {}, 'Cỡ'), h('th', {}, 'Dùng'), h('th')), catRows),
      h(
        'div',
        { class: 'addbar', style: 'margin:8px 0 18px' },
        h('input', { placeholder: 'Tên category mới', oninput: (e) => (newCat.name = e.target.value) }),
        h('input', { type: 'color', value: newCat.color, oninput: (e) => (newCat.color = e.target.value) }),
        h('button', { onclick: () => guarded(async () => (await api('POST', '/categories', newCat), draw())) }, '+ Thêm category')
      ),
      h('h4', {}, 'Kind — loại node (nhãn hiển thị và thứ tự xếp hạng khi tìm kiếm)'),
      h('table', {}, h('tr', {}, h('th', {}, 'Tên'), h('th', {}, 'Nhãn'), h('th', {}, 'Thứ tự'), h('th')), kindRows),
      h(
        'div',
        { class: 'addbar', style: 'margin:8px 0' },
        h('input', { placeholder: 'Tên kind mới', oninput: (e) => (newKind.name = e.target.value) }),
        h('input', { placeholder: 'Nhãn (vd: WIDGET)', oninput: (e) => (newKind.label = e.target.value) }),
        h('button', { onclick: () => guarded(async () => (await api('POST', '/kinds', newKind), draw())) }, '+ Thêm kind')
      ),
      h('div', { class: 'muted' }, 'Tên category / kind là khóa nên không đổi được; muốn đổi thì tạo mới, chuyển node sang rồi xóa cái cũ.'),
      h('div', { class: 'btns' }, h('button', { onclick: () => (m.close(), renderTree(), state.detail && renderEditor()) }, 'Đóng'))
    );
  };
  draw();
}

// ----------------------------------------------------------------- toolbar

$('#btn-meta').addEventListener('click', metaDialog);
$('#btn-backup').addEventListener('click', () => guarded(async () => (await api('POST', '/backup'), toast('Đã sao lưu vào server/backups/'), loadStats())));
$('#btn-export').addEventListener('click', () =>
  guarded(async () => {
    const r = await api('POST', '/export');
    toast(`Đã xuất.\n${r.output}\nTải lại app để thấy thay đổi.`);
  })
);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});
window.addEventListener('hashchange', () => {
  const id = Number(location.hash.slice(1));
  if (id && id !== state.selected) select(id);
});

// -------------------------------------------------------------------- boot

(async () => {
  await guarded(async () => {
    await Promise.all([loadMeta(), loadTree(), loadStats()]);
    document.body.append(h('datalist', { id: 'langs' }, state.meta.languages.map((l) => h('option', { value: l }))));
    renderTree();
    renderEditor();
    const id = Number(location.hash.slice(1));
    if (id && state.nodes.has(id)) await select(id, { force: true });
  });
})();
