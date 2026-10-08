// Scatters the focus's related keywords all round their hub —
// each at a random spot, the same ones every time for the same focus, no
// two labels overlapping, a clearing left round the hub — and routes every
// one a circuit trace into the hub round the labels in its way, plus one
// trace from the hub out of the scatter on the side facing the focus. Traces
// wander and may cross each other, but never run through a label.

const MARGIN = 0.25; // world units kept clear around each frame when scattering
const TRIES = 200; // candidate spots per keyword; the clearest good one wins
const ROOM = 6; // clearance beyond this doesn't count for more
const HUB_CLEAR = 1.0; // no frame this close to the hub

// Routing grid and costs.
const CELL = 0.2;
const CLEARANCE = 0.08; // a trace keeps this far off any frame
const STEP = 1; // cost of a cell
const SHARED = 1.4; // ... on a cell another trace already runs along
const TURN = 1.5; // each bend
const WOBBLE = 1.6; // random extra per cell, so the traces wander

// Deterministic PRNG (mulberry32).
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const overlaps = (p, q) => p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;

// When they don't all fit cleanly: shrink every label by these factors in
// turn, trying each first in the area as given, then widened toward the
// focus to maxX1; at the last, the least-bad spots are kept.
const FITS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42];

// The more keywords, the smaller they all start (the list stays readable
// instead of every label fighting for room): 1 up to 4, then -4% each.
const baseFit = (n) => Math.min(1, Math.max(0.5, 1 - 0.04 * (n - 4)));

/**
 * items: [{ id, hw, top, bottom }] — each frame's half-width and how far it
 * reaches above / below its centre, at full size. area: { x0, x1, y0, y1 }
 * the frames must stay inside. hub: { x, y }. Returns { spots: Map id ->
 * { x, y } centre, area: the area used, fit: the factor the labels must be
 * scaled by (1 = as given) }. obstacles: [{ x, y, hw, top, bottom }] labels
 * of other parts of the scene (the ancestor chain) that nothing may cover.
 */
export function scatterRelated(items, area, hub, seed, maxX1 = area.x1, obstacles = []) {
  let last = null;
  const start = baseFit(items.length);
  let prevFit = 0;
  for (const rung of FITS) {
    // Never smaller than still reads; rungs that land on the floor repeat.
    const fit = Math.max(0.45, rung * start);
    if (fit === prevFit) continue;
    prevFit = fit;
    const scaled = items.map((it) => ({ ...it, hw: it.hw * fit, top: it.top * fit, bottom: it.bottom * fit }));
    for (const x1 of maxX1 > area.x1 ? [area.x1, maxX1] : [area.x1]) {
      const tried = { ...area, x1 };
      const { spots, clean } = scatterIn(scaled, tried, hub, seed, obstacles);
      last = { spots, area: tried, fit, items: scaled };
      if (clean) return last;
    }
  }
  return last;
}

function scatterIn(items, area, hub, seed, obstacles = []) {
  const rand = random(seed);
  const placed = obstacles.map((o) => ({
    x: o.x,
    y: o.y,
    box: { x0: o.x - o.hw - MARGIN, x1: o.x + o.hw + MARGIN, y0: o.y - o.bottom - MARGIN, y1: o.y + o.top + MARGIN },
  }));
  const spots = new Map();
  let clean = true;
  for (const it of items) {
    let best = null;
    let bestScore = -Infinity;
    let bestBad = 0;
    for (let k = 0; k < TRIES; k++) {
      const x = area.x0 + it.hw + (area.x1 - area.x0 - 2 * it.hw) * rand();
      const y = area.y0 + it.bottom + (area.y1 - area.y0 - it.top - it.bottom) * rand();
      const box = { x0: x - it.hw - MARGIN, x1: x + it.hw + MARGIN, y0: y - it.bottom - MARGIN, y1: y + it.top + MARGIN };
      let bad = 0;
      if (hub.x > box.x0 - HUB_CLEAR && hub.x < box.x1 + HUB_CLEAR && hub.y > box.y0 - HUB_CLEAR && hub.y < box.y1 + HUB_CLEAR) {
        // Worst of all: a frame on the hub walls every trace out.
        bad += 100;
      }
      let clear = ROOM;
      for (const p of placed) {
        if (overlaps(box, p.box)) bad += 10;
        clear = Math.min(clear, Math.hypot(x - p.x, y - p.y));
      }
      const score = clear - bad * 1000;
      if (score > bestScore) {
        bestScore = score;
        bestBad = bad;
        best = { x, y, box };
      }
    }
    if (bestBad) clean = false;
    placed.push(best);
    spots.set(it.id, { x: best.x, y: best.y });
  }
  return { spots, clean };
}

// A tiny binary min-heap of [priority, value].
class Heap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(p, v) {
    const a = this.a;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (a[j][0] <= a[i][0]) break;
      [a[i], a[j]] = [a[j], a[i]];
      i = j;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Routes each item (in order) from its spot's centre into the hub along the
 * routing grid: orthogonal, round every frame but its own, a little random,
 * a little shy of cells other traces already use (so they spread out over
 * many paths). Then one trace from the hub to `exit`, round every frame.
 * items as for scatterRelated; spots from it. Returns { routes: Map id ->
 * [{ x, y }] corner points, first the label's centre, last the hub; out:
 * [{ x, y }] from the hub to exit }.
 */
export function routeRelated(items, spots, area, hub, exit, seed) {
  const rand = random(seed ^ 0x5bd1e995);
  const x0 = Math.min(area.x0, hub.x, exit.x) - 3 * CELL;
  const y0 = Math.min(area.y0, hub.y, exit.y) - 3 * CELL;
  const cols = Math.ceil((Math.max(area.x1, hub.x, exit.x) + 3 * CELL - x0) / CELL) + 1;
  const rows = Math.ceil((Math.max(area.y1, hub.y, exit.y) + 3 * CELL - y0) / CELL) + 1;
  const n = cols * rows;
  const cx = (c) => x0 + c * CELL;
  const cy = (r) => y0 + r * CELL;
  const cellOf = (x, y) =>
    Math.max(0, Math.min(rows - 1, Math.round((y - y0) / CELL))) * cols +
    Math.max(0, Math.min(cols - 1, Math.round((x - x0) / CELL)));

  // Which frame (index into items + 1) covers each cell; 0 = free.
  const owner = new Int16Array(n);
  items.forEach((it, i) => {
    const s = spots.get(it.id);
    const bx0 = s.x - it.hw - CLEARANCE;
    const bx1 = s.x + it.hw + CLEARANCE;
    const by0 = s.y - it.bottom - CLEARANCE;
    const by1 = s.y + it.top + CLEARANCE;
    const first = cellOf(bx0, by0);
    const last = cellOf(bx1, by1);
    for (let r = Math.floor(first / cols); r <= Math.floor(last / cols); r++) {
      for (let c = first % cols; c <= last % cols; c++) {
        const x = cx(c);
        const y = cy(r);
        if (x >= bx0 && x <= bx1 && y >= by0 && y <= by1) owner[r * cols + c] = i + 1;
      }
    }
  });
  const wobble = new Float32Array(n);
  for (let i = 0; i < n; i++) wobble[i] = rand() * WOBBLE;
  const used = new Uint8Array(n);
  const cost = new Float32Array(n * 4);
  const from = new Int32Array(n * 4);

  // Cheapest path from cell `start` to cell `goal` through free cells (and
  // those of frame `own`), as corner points with both ends pinned exactly on
  // a and b.
  const search = (start, goal, own, a, b) => {
    const gc = goal % cols;
    const gr = Math.floor(goal / cols);
    const h = (cell) => (Math.abs((cell % cols) - gc) + Math.abs(Math.floor(cell / cols) - gr)) * STEP;
    cost.fill(Infinity);
    from.fill(-1);
    const heap = new Heap();
    for (let d = 0; d < 4; d++) {
      cost[start * 4 + d] = 0;
      heap.push(h(start), start * 4 + d);
    }
    let end = -1;
    while (heap.size) {
      const [, state] = heap.pop();
      const cell = state >> 2;
      const dir = state & 3;
      if (cell === goal) {
        end = state;
        break;
      }
      const c = cell % cols;
      const r = (cell - c) / cols;
      const base = cost[state];
      for (let d = 0; d < 4; d++) {
        const nc = c + DIRS[d][0];
        const nr = r + DIRS[d][1];
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const next = nr * cols + nc;
        if (owner[next] && owner[next] !== own) continue;
        const step = (used[next] ? SHARED : STEP) + wobble[next] + (d !== dir ? TURN : 0);
        const ns = next * 4 + d;
        if (base + step < cost[ns]) {
          cost[ns] = base + step;
          from[ns] = state;
          heap.push(base + step + h(next), ns);
        }
      }
    }
    const cells = [];
    if (end >= 0) {
      for (let st = end; st >= 0; st = from[st]) cells.push(st >> 2);
      cells.reverse();
    } else {
      cells.push(start, goal); // walled in: a straight run as a last resort
    }
    for (const cell of cells) used[cell] = 1;
    const points = [];
    for (let k = 0; k < cells.length; k++) {
      const prev = cells[k - 1];
      const cell = cells[k];
      const next = cells[k + 1];
      const corner = k === 0 || k === cells.length - 1 || cell - prev !== next - cell;
      if (corner) points.push({ x: cx(cell % cols), y: cy(Math.floor(cell / cols)) });
    }
    // Snap each end onto its exact point, and its neighbour onto the same line.
    const pin = (pt, toward, exact) => {
      if (toward && Math.abs(toward.y - pt.y) < 1e-6) toward.y = exact.y;
      else if (toward) toward.x = exact.x;
      pt.x = exact.x;
      pt.y = exact.y;
    };
    pin(points[0], points[1], a);
    pin(points[points.length - 1], points[points.length - 2], b);
    return points;
  };

  const hubCell = cellOf(hub.x, hub.y);
  const routes = new Map();
  items.forEach((it, i) => {
    const s = spots.get(it.id);
    routes.set(it.id, search(cellOf(s.x, s.y), hubCell, i + 1, s, hub));
  });
  const out = search(hubCell, cellOf(exit.x, exit.y), 0, hub, exit);
  return { routes, out };
}
