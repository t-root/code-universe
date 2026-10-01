import * as THREE from 'three';
import { sceneState } from './sceneLayout.js';
import { pageRect } from './screenRotation.js';

// Screen-space label declutter, run once per frame before the keywords move.
//
// Every keyword with a role (focus, satellites, ancestors, related, search
// hits) is projected to the screen as a rectangle — title plus badge — at
// where it is actually drawn minus the push it already has, so labels still
// flying in or trailing their orbit point are measured where they are.
// Overlapping rectangles are pushed apart, mostly vertically since labels
// are wide; the focus, the top search hit, the related list and the
// content column don't move and act as obstacles, and the focus's
// navigation row (<<PREV [ESC] NEXT>>) drops below the focus and its satellites
// (sceneState.buttonsNudge). The
// resulting push is stored per node in sceneState.nudge (world units) and
// each KeywordNode eases toward it. Background keywords whose rectangle
// falls on an active one are flagged userData.occluded so they fade out.

const PAD = 7; // px of breathing room around each label
// World units between a related keyword's label and its HUD frame
// (RelatedHud): the frame counts as part of the label here.
export const RELATED_FRAME_PAD = 0.1;
// A label at least this opaque over a related keyword hides its frame; a
// fainter one (faded out behind) doesn't.
const FRAME_COVER_OPACITY = 0.5;
const ITERATIONS = 6;
// A title is 1 unit tall at scale 1 with the badge 0.7 below it (0.32 tall):
// the block spans +0.5 .. -0.86 around the node's origin.
const LABEL_TOP = 0.5;
const LABEL_BOTTOM = 0.86;

const v = new THREE.Vector3();
const camDir = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();
const unpushed = new THREE.Vector3();
const pairSign = new Map(); // "a|b" -> +1 / -1: which way a goes, kept while they overlap

const d = new THREE.Vector3();

// Screen position (px) of a world point and pixels per world unit at its depth.
function project(p, camera, W, H, tanHalf) {
  const depth = d.copy(p).sub(camera.position).dot(camDir);
  if (depth <= 0.05) return null;
  v.copy(p).project(camera);
  return { x: (v.x + 1) * 0.5 * W, y: (1 - v.y) * 0.5 * H, ppu: H / (2 * tanHalf * depth) };
}

function labelRect(g, base, camera, W, H, tanHalf, framePad = 0) {
  const s = project(base, camera, W, H, tanHalf);
  if (!s) return null;
  const scale = g.scale.x;
  if (!Number.isFinite(scale) || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return null;
  const width = Math.max(g.userData.textWidth ?? 1, g.userData.badgeWidth ?? 0, 0.6) * scale * s.ppu;
  const top = LABEL_TOP * scale * s.ppu;
  const bottom = LABEL_BOTTOM * scale * s.ppu;
  return {
    cx: s.x,
    cy: s.y + (bottom - top) / 2,
    hw: width / 2 + framePad * s.ppu + PAD,
    hh: (top + bottom) / 2 + framePad * s.ppu + PAD,
    ppu: s.ppu,
  };
}

// A world-space box (content column, button row) as a fixed screen rectangle.
function boxRect(x0, x1, y0, y1, z, camera, W, H, tanHalf) {
  const a = project(new THREE.Vector3(x0, y1, z), camera, W, H, tanHalf);
  const b = project(new THREE.Vector3(x1, y0, z), camera, W, H, tanHalf);
  if (!a || !b) return null;
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    hw: Math.abs(b.x - a.x) / 2,
    hh: Math.abs(b.y - a.y) / 2,
    ppu: a.ppu,
    dx: 0,
    dy: 0,
    fixed: true,
    obstacle: true,
  };
}

export function declutter(state, focused) {
  const { camera, size } = state;
  const W = size.width;
  const H = size.height;
  const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
  camera.getWorldDirection(camDir);
  right.setFromMatrixColumn(camera.matrixWorld, 0);
  up.setFromMatrixColumn(camera.matrixWorld, 1);
  const L = sceneState.layout;
  const nudge = sceneState.nudge;

  // ---- Active labels.
  const items = [];
  let buttons = null;
  for (const [id, role] of sceneState.roles) {
    const g = sceneState.registry.get(id);
    if (!g || !g.userData.base || g.scale.x < 0.01) continue;
    const base = unpushed.copy(g.position);
    if (g.userData.nudge) base.sub(g.userData.nudge);
    const r = labelRect(g, base, camera, W, H, tanHalf, role.type === 'related' ? RELATED_FRAME_PAD : 0);
    if (!r) continue;
    r.id = id;
    r.related = role.type === 'related';
    r.opacity = g.userData.opacity ?? 1;
    r.orbit = role.type === 'focus' || role.type === 'child';
    r.dx = 0;
    r.dy = 0;
    r.fixed =
      role.type === 'focus' ||
      (role.type === 'hit' && role.primary) ||
      role.type === 'related';
    // Heavier labels give way less: ancestors keep their chain readable.
    r.mass = role.type === 'parent' ? 2 : 1;
    items.push(r);
  }
  // The 2D search bar sits over the top of the canvas: nothing may hide under it.
  const bar = typeof document !== 'undefined' && document.querySelector('.search-bar');
  if (bar) {
    // In page coordinates, the canvas filling the page from its top-left.
    const b = pageRect(bar);
    items.push({
      cx: b.cx,
      cy: b.cy,
      hw: b.hw + PAD,
      hh: b.hh + PAD,
      dx: 0,
      dy: 0,
      fixed: true,
    });
  }
  if (focused) {
    const c = L.content;
    const content = boxRect(c.x - c.w / 2, c.x + c.w / 2, c.bottom, c.top, c.z, camera, W, H, tanHalf);
    if (content) items.push(content);
    const infoY = L.center.y + L.infoY;
    const info = boxRect(L.center.x - 1.4, L.center.x + 1.4, infoY - 0.3, infoY + 0.05, L.center.z + 0.2, camera, W, H, tanHalf);
    // The navigation row (<<PREV [ESC] NEXT>>) isn't an obstacle: it goes
    // below the keywords
    // instead (see the end of the relaxation).
    buttons = info;
  }

  // ---- Relax overlaps.
  const seen = new Set();
  for (let it = 0; it < ITERATIONS; it++) {
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        if (a.fixed && b.fixed) continue;
        const ax = a.cx + a.dx, ay = a.cy + a.dy;
        const bx = b.cx + b.dx, by = b.cy + b.dy;
        const ox = a.hw + b.hw - Math.abs(ax - bx);
        const oy = a.hh + b.hh - Math.abs(ay - by);
        if (ox <= 0 || oy <= 0) continue;
        const key = a.id !== undefined && b.id !== undefined ? `${a.id}|${b.id}` : `${a.id ?? 'o' + i}|${b.id ?? 'o' + j}`;
        seen.add(key);
        // Share of the push each side takes.
        const wa = a.fixed ? 0 : b.fixed ? 1 : b.mass / (a.mass + b.mass);
        const wb = 1 - wa;
        // Vertical unless the horizontal overlap is much smaller.
        if (oy <= ox * 1.6) {
          let sign = pairSign.get(key);
          if (sign === undefined) {
            sign = Math.abs(ay - by) > 1 ? Math.sign(ay - by) : (a.id ?? i) < (b.id ?? j) ? -1 : 1;
            pairSign.set(key, sign);
          }
          const push = oy;
          a.dy += sign * push * wa;
          b.dy -= sign * push * wb;
        } else {
          const sign = Math.sign(ax - bx) || 1;
          const push = ox;
          a.dx += sign * push * wa;
          b.dx -= sign * push * wb;
        }
      }
    }
  }
  for (const key of pairSign.keys()) if (!seen.has(key)) pairSign.delete(key);

  // ---- The navigation row drops just below the lowest of the focus and its
  // satellites, as they are drawn after the push.
  sceneState.buttonsNudge.set(0, 0, 0);
  if (buttons) {
    let lowest = -Infinity;
    for (const r of items) if (r.orbit) lowest = Math.max(lowest, r.cy + r.dy + r.hh);
    // Never off the bottom of the screen.
    const drop = Math.min(lowest - (buttons.cy - buttons.hh), H - 12 - (buttons.cy + buttons.hh));
    if (drop > 0 && Number.isFinite(drop)) sceneState.buttonsNudge.copy(up).multiplyScalar(-drop / buttons.ppu);
  }

  // ---- Screen push -> world offset at each label's depth.
  const active = new Set();
  for (const r of items) {
    if (r.id === undefined) continue;
    active.add(r.id);
    if (r.fixed || (r.dx === 0 && r.dy === 0)) {
      nudge.delete(r.id);
      continue;
    }
    if (!Number.isFinite(r.dx) || !Number.isFinite(r.dy) || !Number.isFinite(r.ppu)) {
      if (import.meta.env?.DEV) console.warn('declutter: bad push', r);
      nudge.delete(r.id);
      continue;
    }
    let n = nudge.get(r.id);
    if (!n) nudge.set(r.id, (n = new THREE.Vector3()));
    n.copy(right).multiplyScalar(r.dx / r.ppu).addScaledVector(up, -r.dy / r.ppu);
  }
  for (const id of nudge.keys()) if (!active.has(id)) nudge.delete(id);

  const shown = items.map((r) => ({ cx: r.cx + r.dx, cy: r.cy + r.dy, hw: r.hw, hh: r.hh }));
  const overlaps = (a, b) => Math.abs(a.cx - b.cx) < a.hw + b.hw - PAD && Math.abs(a.cy - b.cy) < a.hh + b.hh - PAD;

  // ---- A related keyword's HUD frame hides while something still overlaps
  // it (the push can't always clear it, e.g. a satellite sweeping past), so
  // it never looks like it frames the other label. Only a label that is
  // clearly showing counts: one faded out behind (the focus group once the
  // camera has swung the related scatter in front, utils/depthFade.js) doesn't.
  items.forEach((r, i) => {
    if (!r.related) return;
    const g = sceneState.registry.get(r.id);
    // Only other keywords count: its neighbours in the related list are laid
    // out not to overlap it, and the content column fades out above it.
    if (g) {
      g.userData.frameCovered = shown.some(
        (s, j) =>
          items[j].id !== undefined &&
          !items[j].related &&
          items[j].opacity >= FRAME_COVER_OPACITY &&
          overlaps(shown[i], s)
      );
    }
  });

  // ---- Background keywords under an active label fade out.
  for (const [id, g] of sceneState.registry) {
    if (sceneState.roles.has(id)) {
      g.userData.occluded = false;
      continue;
    }
    let hidden = false;
    if (shown.length) {
      const r = labelRect(g, g.position, camera, W, H, tanHalf);
      if (r) {
        for (const s of shown) {
          if (overlaps(r, s)) {
            hidden = true;
            break;
          }
        }
      }
    }
    g.userData.occluded = hidden;
  }
}
