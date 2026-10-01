import * as THREE from 'three';

// Circuit-board wiring shared by the focus's links (SatelliteLinks), the
// related keywords' wiring (RelatedHud) and the content screen's
// (panelWire): orthogonal traces, their corners cut at 45°, and a bright
// streak of "current" running along them like
// electricity down a wire.

export const MAX_POINTS = 5; // per routed trace, endpoints included (so also segments per trace)
// The moving streak: world length, speed and how many fading pieces.
const STREAK_LENGTH = 0.9;
export const STREAK_SPEED = 1.1;
export const STREAK_STEPS = 10;
// How far a streak's colour is lit toward white from its trace's.
export const GLOW_WHITEN = 0.45;
// How bright a trace is under its streak.
export const TRACE_DIM = 0.35;

// Stable pseudo-random value in [0, 1) for a pair of ids, so a trace keeps
// the same shape frame after frame while its endpoints move.
export function hash01(a, b) {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Orthogonal 3D route from a to b, PCB style, every bend 90°. The depth (z)
// leg comes first: seen from the camera (on +Z, facing the centre) a move in
// depth mostly slides toward the middle of the screen, which is where the
// focus sits, so it all but vanishes there. The x / y legs then run at b's
// own depth — part of the way along one, fully along the other, then finish
// the first — and end on b instead of overshooting it on screen (a leg run at
// the focus's depth toward an ancestor set further back would reach past it,
// then come back). Traces alternate which of x / y goes first.
export function route(out, a, b, h) {
  const first = Math.floor(h * 6) % 2;
  const order = [2, first, 1 - first];
  const lane = 0.3 + ((h * 7.13) % 1) * 0.4;
  const cur = [a.x, a.y, a.z];
  const end = [b.x, b.y, b.z];
  let n = 0;
  const push = () => {
    if (n > 0) {
      const p = out[n - 1];
      if (Math.abs(p.x - cur[0]) + Math.abs(p.y - cur[1]) + Math.abs(p.z - cur[2]) < 1e-3) return;
    }
    out[n++].set(cur[0], cur[1], cur[2]);
  };
  push();
  cur[order[0]] = end[order[0]];
  push();
  cur[order[1]] += (end[order[1]] - cur[order[1]]) * lane;
  push();
  cur[order[2]] = end[order[2]];
  push();
  cur[order[1]] = end[order[1]];
  push();
  return n;
}

// Point `dist` along the polyline pts[0..n-1], clamped to its ends.
export function pointAlong(out, pts, n, dist) {
  if (dist <= 0) return out.copy(pts[0]);
  for (let j = 0; j + 1 < n; j++) {
    const len = pts[j].distanceTo(pts[j + 1]);
    if (dist <= len) return out.lerpVectors(pts[j], pts[j + 1], len > 0 ? dist / len : 0);
    dist -= len;
  }
  return out.copy(pts[n - 1]);
}

// Length of the polyline pts[0..n-1].
export function polylineLength(pts, n) {
  let length = 0;
  for (let j = 0; j + 1 < n; j++) length += pts[j].distanceTo(pts[j + 1]);
  return length;
}

// Where a trace's streak is at `time`: its head's distance along the trace
// and which pass this is (how many streaks have run down it before). It runs
// from the start outward, fully leaving the far end before the next enters.
export function streakAt(length, time, h) {
  const trail = Math.min(STREAK_LENGTH, length * 0.6);
  const span = length + trail;
  const t = (time * STREAK_SPEED) / span + h;
  return { head: (t % 1) * span, trail, pass: Math.floor(t) };
}

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

// Where a trace that only reaches a keyword's text meets it: the side of
// its title (`side` -1 left, +1 right) at the title's mid-height, from the
// glyph bounds KeywordNode measures; its centre until they are measured.
export function titleSide(out, g, side, camera) {
  out.copy(g.position);
  const box = g.userData.titleBox;
  if (!box) return out;
  const s = g.scale.x;
  _right.setFromMatrixColumn(camera.matrixWorld, 0);
  _up.setFromMatrixColumn(camera.matrixWorld, 1);
  return out
    .addScaledVector(_right, (side > 0 ? box.x1 : box.x0) * s)
    .addScaledVector(_up, ((box.y0 + box.y1) / 2) * s);
}

// PCB look: corners cut at 45°, and round pads (vias) for the content
// screen's board (panelWire).
const CHAMFER = 0.12; // world length cut off each leg at a corner
const VIA_R = 0.035; // world radius of a via
export const VIA_SIDES = 6;

const _d0 = new THREE.Vector3();
const _d1 = new THREE.Vector3();

/**
 * Writes pts[0..n-1] into `out` with every corner (a real turn, not legs
 * running on in line) between two legs that run across the screen (not into
 * depth) cut at 45°: CHAMFER (at most 45% of the shorter leg) back along
 * each leg. Returns the new count (out needs room for 2n - 2 points).
 */
export function chamfer(out, pts, n) {
  let m = 0;
  out[m++].copy(pts[0]);
  for (let j = 1; j + 1 < n; j++) {
    _d0.subVectors(pts[j], pts[j - 1]);
    _d1.subVectors(pts[j + 1], pts[j]);
    const l0 = _d0.length();
    const l1 = _d1.length();
    const flat = (d, l) => l > 1e-4 && Math.abs(d.z) < l * 0.5;
    // Not a turn at all (the legs either side run on in line): nothing to cut.
    const straight = l0 > 1e-4 && l1 > 1e-4 && _d0.dot(_d1) > 0.995 * l0 * l1;
    if (straight || !flat(_d0, l0) || !flat(_d1, l1)) {
      out[m++].copy(pts[j]);
      continue;
    }
    const r = Math.min(CHAMFER, l0 * 0.45, l1 * 0.45);
    out[m++].copy(pts[j]).addScaledVector(_d0, -r / l0);
    out[m++].copy(pts[j]).addScaledVector(_d1, r / l1);
  }
  out[m++].copy(pts[n - 1]);
  return m;
}

/**
 * A via: a small ring round `c` facing the camera (`right` / `up` its
 * screen axes), drawn as VIA_SIDES segments through `seg(a, b)`.
 */
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
export function via(seg, c, right, up, r = VIA_R) {
  for (let k = 0; k < VIA_SIDES; k++) {
    const t0 = (k / VIA_SIDES) * Math.PI * 2;
    const t1 = ((k + 1) / VIA_SIDES) * Math.PI * 2;
    _a.copy(c).addScaledVector(right, Math.cos(t0) * r).addScaledVector(up, Math.sin(t0) * r);
    _b.copy(c).addScaledVector(right, Math.cos(t1) * r).addScaledVector(up, Math.sin(t1) * r);
    seg(_a, _b);
  }
}
