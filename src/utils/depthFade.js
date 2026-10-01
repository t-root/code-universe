import * as THREE from 'three';
import { damp } from './animations.js';
import { sceneState } from './sceneLayout.js';

// Whatever the camera has swung behind something else fades, so the part in
// front reads cleanly. Facing the view head-on, nothing fades.
//
// 1. Whole parts, standing side by side: the related
//    scatter (left, set further back), the focus with its rings (centre) and
//    the content column (right). How far a part has fallen behind = how much
//    further back it sits than the nearest part, compared with head-on.
//    Zoomed in until the camera is right up to a part, or past it, that part
//    no longer counts as the nearest and fades away: the next one along
//    takes over, so the focus can be looked at from either side.
// 2. Single labels: a keyword the content column covers on screen fades
//    unless it is clearly in front of the column — swinging round slides
//    the text over the focus and its rings.
const BEHIND_FROM = 0.5; // world units behind before a part starts fading (~6° of swing)
const BEHIND_TO = 2.0; // ... and where it bottoms out (~25° for the centre)
const MIN = 0.25; // opacity factor of whatever is fully behind
// How far in front of the camera (along its view) a part is when it counts
// as zoomed past — no longer the nearest part, starting to fade — and where
// it has faded right down (to PASSED_MIN).
const PASS_FROM = 1.6;
const PASS_TO = 0.2;
const PASSED_MIN = 0.08;
// A label under the content column counts as covered unless it is clearly in
// front of it: the focus sits at the column's own depth, and swinging round
// slides the column right over it.
const LABEL_BEHIND = -0.4;
// A label spans +0.5 .. -0.86 around its origin at scale 1 (see declutter.js).
const LABEL_TOP = 0.5;
const LABEL_BOTTOM = 0.86;

const want = { related: 1, center: 1, content: 1 };
const points = { related: null, center: null, content: null };
const camDir = new THREE.Vector3();
const v = new THREE.Vector3();
const d = new THREE.Vector3();

// Screen position (px) of a world point, its depth and pixels per world unit there.
function project(p, camera, W, H, tanHalf) {
  const depth = d.copy(p).sub(camera.position).dot(camDir);
  if (depth <= 0.05) return null;
  v.copy(p).project(camera);
  return { x: (v.x + 1) * 0.5 * W, y: (1 - v.y) * 0.5 * H, depth, ppu: H / (2 * tanHalf * depth) };
}

// Eases sceneState.depthFade (whole parts; read by KeywordNode,
// SatelliteLinks, RelatedHud through the labels' opacity, FocusContent) and
// each keyword's userData.behindFade (single labels; read by KeywordNode).
export function updateDepthFade(state, focused, dt) {
  const { camera, size } = state;
  const fade = sceneState.depthFade;
  const L = sceneState.layout;
  want.related = want.center = want.content = 1;
  if (focused) {
    const R = L.related;
    let hasRelated = false;
    for (const role of sceneState.roles.values()) {
      if (role.type === 'related') {
        hasRelated = true;
        break;
      }
    }
    // Where each part sits on the ground plane (x, z).
    points.center = [L.center.x, L.center.z];
    points.content = [L.content.x, L.content.z];
    points.related = hasRelated ? [R.hub.x, R.z] : null;

    // The camera looks along the ground at eye level (at the origin unless
    // zoomed in somewhere): nearer = further back along its view, and a
    // part `radius - that` in front of the camera, `radius` being how far
    // back along its view the camera itself is.
    camera.getWorldDirection(camDir);
    const flat = Math.hypot(camDir.x, camDir.z) || 1;
    const dx = -camDir.x / flat;
    const dz = -camDir.z / flat;
    const along = (p) => p[0] * dx + p[1] * dz;
    const radius = camera.position.x * dx + camera.position.z * dz;
    let front = -Infinity;
    let frontHeadOn = -Infinity;
    // The nearest part the camera hasn't come right up to (if it has come
    // up to all of them, the nearest of all).
    for (const pass of [true, false]) {
      for (const p of Object.values(points)) {
        if (!p || (pass && radius - along(p) < PASS_FROM)) continue;
        front = Math.max(front, along(p));
        frontHeadOn = Math.max(frontHeadOn, p[1]);
      }
      if (front > -Infinity) break;
    }
    for (const [key, p] of Object.entries(points)) {
      if (!p) continue;
      const ahead = radius - along(p);
      if (ahead < PASS_FROM) {
        // Zoomed past: fading away as the camera closes on it.
        want[key] = PASSED_MIN + (1 - PASSED_MIN) * THREE.MathUtils.smoothstep(ahead, PASS_TO, PASS_FROM);
        continue;
      }
      const behind = front - along(p) - (frontHeadOn - p[1]);
      want[key] = 1 - (1 - MIN) * THREE.MathUtils.smoothstep(behind, BEHIND_FROM, BEHIND_TO);
    }
  }
  for (const key of Object.keys(want)) fade[key] = damp(fade[key], want[key], 4, dt);

  // ---- Single labels covered by the content column.
  let cover = null;
  if (focused && fade.content > 0.5) {
    const W = size.width;
    const H = size.height;
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    camera.getWorldDirection(camDir);
    // The column on screen: the same box the declutter keeps labels out of.
    const c = L.content;
    const s = project(new THREE.Vector3(c.x, (c.top + c.bottom) / 2, c.z), camera, W, H, tanHalf);
    if (s) {
      cover = { x: s.x, y: s.y, hw: (c.w / 2) * s.ppu, hh: ((c.top - c.bottom) / 2) * s.ppu, depth: s.depth };
      for (const [id, role] of sceneState.roles) {
        if (role.type === 'hit') continue;
        const g = sceneState.registry.get(id);
        if (!g) continue;
        const p = project(g.position, camera, W, H, tanHalf);
        let behind = false;
        if (p && p.depth > cover.depth + LABEL_BEHIND) {
          const sc = g.scale.x * p.ppu;
          const hw = (Math.max(g.userData.textWidth ?? 1, g.userData.badgeWidth ?? 0) * sc) / 2;
          const cy = p.y + ((LABEL_BOTTOM - LABEL_TOP) / 2) * sc;
          const hh = ((LABEL_TOP + LABEL_BOTTOM) / 2) * sc;
          behind = Math.abs(p.x - cover.x) < hw + cover.hw && Math.abs(cy - cover.y) < hh + cover.hh;
        }
        g.userData.behindFade = damp(g.userData.behindFade ?? 1, behind ? MIN : 1, 6, dt);
      }
    }
  }
  if (!cover) {
    for (const g of sceneState.registry.values()) {
      if (g.userData.behindFade !== undefined) g.userData.behindFade = damp(g.userData.behindFade, 1, 6, dt);
    }
  }
}
