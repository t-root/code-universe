import * as THREE from 'three';
import {
  GLOW_WHITEN,
  STREAK_STEPS,
  chamfer,
  pointAlong,
  polylineLength,
  streakAt,
  titleSide,
  via,
} from './circuit.js';

// The traces into the content screen (FocusContent), drawn like a circuit
// board. A heavy trunk leaves from right at the end of the focus title's
// text and runs straight across (round a corner cut at 45° if the screen's
// middle isn't level with it). Short of the screen, traces peel off it at
// different points: some jog once or twice at 45° and run on into the
// screen's left edge at uneven heights (the screen shows a lit port where
// each comes in), some are dead ends that turn off and stop on a ring pad
// or a dot. Some traces are heavy (drawn three times over), most fine.
// Current spreads out from the focus along the trunk and down each branch
// as it reaches it, then keeps running down every one. Each screen gets one
// of five boards at random (makeBoard), a different one every time it opens.
//
// The screen always faces the camera, so everything near it is laid out
// along the camera's right / up from the screen's centre.

export const WIRE_TIME = 0.75; // the current reaching the farthest end

// A board, in the screen's own units: each branch a polyline of [d, y]
// points, d how far short of the screen's left edge (SPAN, the farthest, is
// where the trunk ends and the board starts), y how far above where the
// trunk comes in; each starts on the trunk line (y = 0), every cut at 45°.
// `end`: 'edge' (on into the screen), 'ring' or 'dot' (a dead end);
// `heavy`: drawn three times over; `k`: brightness.
const SPAN = 2.0;
const MIN_FIT = 0.75; // the most the board shrinks; past that, branches drop out

// Branch shapes: into the screen with one cut (peeling off at d0 over to
// height y), or with a cut, a run and another cut; a dead end with a cut,
// an optional run and an optional last cut out.
const into = (d0, y, k, heavy = false) => ({ pts: [[d0, 0], [d0 - Math.abs(y), y], [0, y]], end: 'edge', k, heavy });
const into2 = (d0, y1, run, y, k, heavy = false) => {
  const dA = d0 - Math.abs(y1);
  const dB = dA - run;
  return { pts: [[d0, 0], [dA, y1], [dB, y1], [dB - Math.abs(y - y1), y], [0, y]], end: 'edge', k, heavy };
};
const stub = (d0, y, run, end, k, y2 = null) => {
  const pts = [[d0, 0], [d0 - Math.abs(y), y]];
  let d = d0 - Math.abs(y);
  if (run) pts.push([(d -= run), y]);
  if (y2 !== null) pts.push([d - Math.abs(y2 - y), y2]);
  return { pts, end, k };
};
const TRUNK = { pts: [[SPAN, 0], [0, 0]], end: 'edge', heavy: true, k: 0.75 };

// Five boards, one picked at random each time a screen opens. None is
// even or mirrored: only a few traces reach the screen, at uneven heights,
// and dead ends stop at all sorts of distances.
const BOARDS = [
  // Drift: a fine trace wandering far up in two steps, a heavy one dropping
  // in below, dead ends scattered, one stopping just short of the screen.
  [
    TRUNK,
    into2(0.55, 0.06, 0.2, 0.31, 0.5),
    into(0.9, -0.14, 0.5, true),
    stub(0.4, -0.05, 0.12, 'dot', 0.35),
    stub(1.25, 0.12, 0.35, 'ring', 0.4),
    stub(1.6, -0.22, 0.12, 'dot', 0.35),
    stub(1.85, 0.09, 0.2, 'ring', 0.35),
  ],
  // Cascade: traces stepping down below, one long one up, dead ends either
  // side.
  [
    TRUNK,
    into2(1.2, -0.08, 0.3, -0.18, 0.45, true),
    into(0.6, -0.05, 0.45),
    into(0.75, 0.26, 0.4),
    stub(0.35, 0.1, 0.1, 'dot', 0.35),
    stub(1.45, 0.15, 0.25, 'ring', 0.4, 0.2),
    stub(1.75, -0.12, 0.2, 'dot', 0.35),
  ],
  // Antenna: few traces, long dead-end runs.
  [
    TRUNK,
    into(0.45, 0.16, 0.5, true),
    into2(1.0, -0.1, 0.5, -0.33, 0.4),
    stub(0.7, -0.05, 0.3, 'dot', 0.35),
    stub(1.3, 0.24, 0.5, 'ring', 0.4),
    stub(1.7, -0.16, 0.15, 'ring', 0.35),
  ],
  // Offset bus: a pair turning together below, a heavy trace stepping up
  // high, dead ends behind and in front.
  [
    TRUNK,
    into(0.68, -0.08, 0.5),
    into(0.73, -0.13, 0.42),
    into2(1.1, 0.1, 0.35, 0.27, 0.45, true),
    stub(0.4, 0.06, 0.1, 'dot', 0.35),
    stub(1.4, -0.2, 0.3, 'ring', 0.38),
    stub(1.8, 0.13, 0.12, 'ring', 0.35),
  ],
  // Sparse: a trace well down, a short step up, two dead ends.
  [
    TRUNK,
    into(0.85, -0.22, 0.5),
    into2(0.5, 0.05, 0.15, 0.12, 0.45),
    stub(1.2, 0.18, 0.4, 'ring', 0.4),
    stub(1.55, -0.1, 0.25, 'dot', 0.35),
  ],
];
let lastBoard = -1;

/**
 * One of the BOARDS at random (never the same one twice running). Returns
 * { branches, ports (where the branches into the screen come in, above the
 * trunk), spread (how far the farthest one is from it) }.
 */
export function makeBoard(rand = Math.random) {
  let i = Math.floor(rand() * BOARDS.length);
  if (i === lastBoard) i = (i + 1 + Math.floor(rand() * (BOARDS.length - 1))) % BOARDS.length;
  lastBoard = i;
  const branches = BOARDS[i];
  const ports = branches.filter((br) => br.end === 'edge').map((br) => br.pts[br.pts.length - 1][1]);
  return { branches, ports, spread: Math.max(0.3, ...ports.map(Math.abs)) };
}

const HEAVY = 0.011; // the extra lines of a heavy trace, either side
const RING = [0.045, 0.028]; // a ring pad: outer and inner radius
const DOT = [0.02, 0.009];
const SPARK = 0.5; // the spark riding a tip while current spreads
const VIA_K = 0.9;
// Line segments it may take (a generous bound).
export const WIRE_SEGMENTS = 900;
const WHITE = new THREE.Color(1, 1, 1);

const right = new THREE.Vector3();
const up = new THREE.Vector3();
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const e1 = new THREE.Vector3();
const e2 = new THREE.Vector3();
const o1 = new THREE.Vector3();
const o2 = new THREE.Vector3();
const perp = new THREE.Vector3();
const center = new THREE.Vector3();
const port = new THREE.Vector3();
const c = new THREE.Color();
const glow = new THREE.Color();
const raw = Array.from({ length: 8 }, () => new THREE.Vector3());
const trunk = Array.from({ length: 8 }, () => new THREE.Vector3());
const path = Array.from({ length: 16 }, () => new THREE.Vector3());

/**
 * Fills `buf` ({ positions, colors }) with `board` (makeBoard) from the `focus`
 * group's title into the left edge of the screen `box` ({ x, z, w, top,
 * bottom }, world units), current spreading from time `at`. Returns
 * { count: line segments drawn, entry: where the trunk meets the screen, as
 * a height above the screen's centre (world units), fit: how far the board
 * is shrunk (board.ports times it are where its traces come in), shown:
 * for each of board.ports, whether its trace has room to be drawn }.
 */
export function drawPanelWire(buf, { camera, focus, box, board, time, at, color, fade }) {
  const { positions, colors: cols } = buf;
  const capacity = positions.length / 6;
  let seg = 0;
  const add = (p, q, col, k) => {
    if (seg >= capacity || k <= 0.002) return;
    positions.set([p.x, p.y, p.z, q.x, q.y, q.z], seg * 6);
    cols.set([col.r * k, col.g * k, col.b * k, col.r * k, col.g * k, col.b * k], seg * 6);
    seg++;
  };
  right.setFromMatrixColumn(camera.matrixWorld, 0);
  up.setFromMatrixColumn(camera.matrixWorld, 1);
  center.set(box.x, (box.top + box.bottom) / 2, box.z);
  const half = (box.top - box.bottom) / 2;
  const P = (out, x, y) => out.copy(center).addScaledVector(right, x).addScaledVector(up, y);

  // The port and where the trunk meets the screen, in the screen's own
  // coordinates (x across, y up, from its centre).
  titleSide(port, focus, 1, camera);
  e1.subVectors(port, center);
  const px = e1.dot(right);
  const py = e1.dot(up);
  const entry = THREE.MathUtils.clamp(py, -half + board.spread + 0.3, half - board.spread - 0.4);
  const edge = -box.w / 2;
  // A short run from the focus to the screen: the board shrinks a little,
  // then whatever peels off farther back than there is room for is left
  // out (rather than squeezing it all in), the trunk always kept.
  const room = Math.max(0, edge - px - 0.35);
  const fit = THREE.MathUtils.clamp(room / SPAN, MIN_FIT, 1);
  const extent = Math.min(SPAN, room / fit);
  const keep = board.branches.map((br, i) => i === 0 || br.pts[0][0] <= extent - 0.05);
  const shown = board.branches.filter((br) => br.end === 'edge').map((br) => keep[board.branches.indexOf(br)]);
  if (at === undefined || time < at) return { count: 0, entry, fit, shown };
  c.set(color);
  glow.copy(c).lerp(WHITE, GLOW_WHITEN);
  const B = (out, d, y) => P(out, edge - d * fit, entry + y * fit);

  // The trunk: from the port to where the board starts.
  let n = 0;
  raw[n++].copy(port);
  if (Math.abs(entry - py) > 1e-3) {
    const midX = (px + edge - extent * fit) / 2;
    P(raw[n++], midX, py);
    P(raw[n++], midX, entry);
  }
  B(raw[n++], extent, 0);
  const trunkN = chamfer(trunk, raw, n);
  const trunkLength = polylineLength(trunk, trunkN);

  // How far the current has spread, from the port.
  const longest = trunkLength + extent * fit * 1.6;
  const reach = Math.min(1, (time - at) / WIRE_TIME) * longest;
  const done = reach >= longest;

  const stretch = (Q, m, d0, d1, k, heavy) => {
    let run = 0;
    for (let j = 0; j + 1 < m; j++) {
      const len = Q[j].distanceTo(Q[j + 1]);
      const s0 = Math.max(d0, run);
      const s1 = Math.min(d1, run + len);
      if (s1 > s0 && len > 0) {
        e1.lerpVectors(Q[j], Q[j + 1], (s0 - run) / len);
        e2.lerpVectors(Q[j], Q[j + 1], (s1 - run) / len);
        add(e1, e2, c, k);
        if (heavy) {
          perp.subVectors(e2, e1);
          perp.copy(right).multiplyScalar(-perp.dot(up)).addScaledVector(up, perp.dot(right)).normalize().multiplyScalar(HEAVY);
          for (const s of [-1, 1]) {
            add(o1.copy(e1).addScaledVector(perp, s), o2.copy(e2).addScaledVector(perp, s), c, k * 0.6);
          }
        }
      }
      run += len;
    }
  };
  const spark = (Q, m, d0, d1, k) => {
    pointAlong(a, Q, m, d0);
    for (let j = 1; j <= STREAK_STEPS; j++) {
      pointAlong(b, Q, m, d0 + ((d1 - d0) * j) / STREAK_STEPS);
      add(a, b, glow, (k * (j - 0.5)) / STREAK_STEPS);
      a.copy(b);
    }
  };
  const ring = (at2, radii, k) => {
    for (const r of radii) via((p, q) => add(p, q, c, k), at2, right, up, r);
  };

  // The trunk, heavy.
  stretch(trunk, trunkN, 0, reach, fade * 0.75, true);
  if (!done) spark(trunk, trunkN, Math.max(0, reach - SPARK), Math.min(reach, trunkLength), fade);

  // Each branch: the trunk up to the board, along to where it peels off,
  // then its own way.
  board.branches.forEach((br, i) => {
    if (!keep[i]) return;
    let m = 0;
    for (let j = 0; j < trunkN; j++) path[m++].copy(trunk[j]);
    for (const [d, y] of br.pts) B(path[m++], Math.min(d, extent), y);
    const length = polylineLength(path, m);
    // Its own part starts where it leaves the trunk line.
    const own = trunkLength + (extent - Math.min(br.pts[0][0], extent)) * fit;
    if (reach <= own) return;
    stretch(path, m, own, reach, fade * br.k, br.heavy);
    if (reach < length) {
      spark(path, m, Math.max(own, reach - SPARK), reach, fade);
      return;
    }
    // Dead ends stop on a pad; traces into the screen just run in (it shows
    // a lit port there).
    if (br.end !== 'edge') ring(path[m - 1], br.end === 'ring' ? RING : DOT, fade * VIA_K);
    if (done) {
      const { head, trail } = streakAt(length - own, time, 0.21 + i * 0.137);
      spark(path, m, Math.max(own, own + head - trail), own + head, fade * (br.end === 'edge' ? 0.85 : 0.5));
    }
  });

  if (done) {
    // Current down the trunk as well.
    const { head, trail } = streakAt(trunkLength, time, 0.37);
    spark(trunk, trunkN, head - trail, head, fade);
  }
  return { count: seg, entry, fit, shown };
}
