import * as THREE from 'three';

export const CAMERA_FOV = 68;
// CameraController frames preview/focus from this orbit radius, on +Z.
export const FOCUS_CAMERA_RADIUS = 11;
export const IDLE_CAMERA_RADIUS = 8;
const FOCUS_Z = 4.8;

const INNER_TILT = 0.42;
const OUTER_TILT = -0.3;
// Rings never grow past this, or their near side would reach the camera.
const MAX_RING_R = 4.2;
// Rough half-width of a satellite label, for keeping clear of the rings.
const LABEL_HALF = 1.6;

// Per-frame scene state shared by the 3D components outside React:
// roles are written by KnowledgeScene when the store changes, every
// KeywordNode registers its Object3D, and the orbit angle advances each
// frame (paused while a satellite is hovered so it can be clicked).
export const sceneState = {
  roles: new Map(),
  registry: new Map(),
  orbitAngle: 0,
  // Per-node screen-declutter push in world units (see utils/declutter.js).
  nudge: new Map(),
  // Same, for the focus's navigation row (<<PREV [ESC] NEXT>>).
  buttonsNudge: new THREE.Vector3(),
  // Opacity factors of the related scatter, the focus group and the content
  // column, lowered for whichever the camera has swung behind another
  // (utils/depthFade.js).
  depthFade: { related: 1, center: 1, content: 1 },
  // Where RelatedHud has scattered the related keywords:
  // node id -> world position of the label's centre, for `relatedSpotsKey`.
  relatedSpots: new Map(),
  // ... and the circuit trace routed from each into the hub (world corner
  // points, label centre first).
  relatedRoutes: new Map(),
  // ... and from the hub out of the scatter, toward the focus.
  relatedOut: [],
  relatedSpotsKey: '',
  // What a crowded scatter shrank the related labels to (KeywordNode).
  relatedFit: 1,
  // When the focus's trace reaches each child (SatelliteLinks): node id ->
  // scene time; a child stays hidden until then (KeywordNode).
  childArrival: new Map(),
  layout: computeLayout(16, 9, 0),
};
// World-space arc length each satellite wants on its ring; a crowded ring
// grows until its labels get this much room (as far as the screen allows).
const SATELLITE_SPACING = 2.3;
const roomFor = (n) => (n * SATELLITE_SPACING) / (Math.PI * 2);

// Once children spill past one ring, each extra ring takes about this many.
const RING_CAPACITY = 14;

// Children orbit their parent on one tilted ring, or on several crossing
// rings when there are many of them — as many rings as it takes, so any
// number of children keeps its spacing. Rings alternate tilt and direction.
// `fit` (<= 1) shrinks all rings when the spacing they want doesn't fit the
// viewport.
function ringSpec(count, fit = 1) {
  if (count <= 10) {
    const r = Math.max(1.6 + count * 0.13, roomFor(count)) * fit;
    return { rings: [{ start: 0, count, r }], outerR: r };
  }
  const n = Math.max(2, Math.ceil(count / RING_CAPACITY));
  const rings = [];
  let start = 0;
  let r = 0;
  for (let k = 0; k < n; k++) {
    const c = Math.floor(count / n) + (k < count % n ? 1 : 0);
    r = k === 0 ? Math.max(2.0, roomFor(c)) : Math.max(k === 1 ? 3.1 : 0, roomFor(c), r + 1.1);
    rings.push({ start, count: c, r });
    start += c;
  }
  for (const ring of rings) ring.r *= fit;
  return { rings, outerR: rings[rings.length - 1].r };
}

export function satellitePosition(out, index, count, angle, layout) {
  const { rings } = ringSpec(count, layout.ringFit);
  let k = rings.length - 1;
  while (k > 0 && index < rings[k].start) k--;
  const ring = rings[k];
  const i = index - ring.start;
  const r = ring.r;
  const even = k % 2 === 0;
  const tilt = even ? layout.innerTilt : layout.outerTilt;
  // Rings sharing a tilt (0, 2, 4...) are offset half a step from each other.
  const stagger = k >= 2 ? (Math.PI / ring.count) * Math.floor(k / 2) : 0;
  const a = (even ? angle : -angle) + (i / ring.count) * Math.PI * 2 + stagger;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  return out.set(
    layout.center.x + x,
    layout.center.y - z * Math.sin(tilt),
    layout.center.z + z * Math.cos(tilt)
  );
}

// The focus's ancestors form a chain: the parent at parentOffset, each
// level above it one step further back and a little further out along the
// same screen direction, so the whole path to the root stays in view.
const ANCESTOR_DEPTH_STEP = 2.5;
export function ancestorPosition(out, depth, layout) {
  out.copy(layout.center).add(layout.parentOffset);
  if (depth <= 1) return out;
  const tanHalf = Math.tan((CAMERA_FOV * Math.PI) / 360);
  const halfH = (z) => tanHalf * (FOCUS_CAMERA_RADIUS - z);
  const fx = out.x / (halfH(out.z) * layout.aspect);
  const fy = out.y / halfH(out.z);
  const { step } = layout.ancestors;
  const z = out.z - ANCESTOR_DEPTH_STEP * (depth - 1);
  const x = THREE.MathUtils.clamp(fx + step.x * (depth - 1), -0.85, 0.85);
  const y = Math.min(0.8, fy + step.y * (depth - 1));
  return out.set(x * halfH(z) * layout.aspect, y * halfH(z), z);
}

// Where a related node heads until RelatedHud has scattered the list
// (sceneState.relatedSpots): the hub, which they then fan out from.
export function relatedPosition(out, layout) {
  return out.copy(layout.related.hub);
}

// How far the rings reach on screen over a full turn, perspective
// included, in FOCUS_Z-plane units: { x: max |x|, top, bottom }.
function ringExtent(count, layout) {
  const p = new THREE.Vector3();
  const d0 = FOCUS_CAMERA_RADIUS - FOCUS_Z;
  let x = 0;
  let top = 0;
  let bottom = 0;
  for (let i = 0; i < count; i++) {
    for (let step = 0; step < 24; step++) {
      satellitePosition(p, i, count, (step / 24) * Math.PI * 2, layout);
      const k = d0 / Math.max(0.5, FOCUS_CAMERA_RADIUS - p.z);
      x = Math.max(x, Math.abs(p.x - layout.center.x) * k);
      top = Math.max(top, (p.y - layout.center.y) * k);
      bottom = Math.min(bottom, (p.y - layout.center.y) * k);
    }
  }
  return { x, top, bottom };
}

// Radius of the outermost ring, before any fitting to the screen.
function ringRadius(count) {
  if (!count) return 0.9;
  return ringSpec(count).outerR;
}

// The old fixed radius: what MIN_FIT of is the least the rings shrink to.
function baseRingRadius(count) {
  if (!count) return 0.9;
  return count <= 10 ? 1.6 + count * 0.13 : 3.1;
}

/**
 * Where the focused node, its satellites and its content wheel go for a
 * given viewport — one layout for every screen, which is always landscape
 * (a portrait screen is turned on its side, utils/screenRotation.js): focus
 * at dead centre, related keywords to the left, content to the right of
 * the rings.
 * `content` is the content screen: centred on x at depth z, `w` wide,
 * from `top` down to `bottom`. `edgeX` is how far right a search-preview cluster starts
 * before it slides to the centre.
 */
export function computeLayout(width, height, childCount) {
  const aspect = width / height;
  const tanHalf = Math.tan((CAMERA_FOV * Math.PI) / 360);
  // Half the visible height/width at depth z, seen from the framing camera.
  const halfHAt = (z) => tanHalf * (FOCUS_CAMERA_RADIUS - z);
  const halfWAt = (z) => halfHAt(z) * aspect;
  const halfH = halfHAt(FOCUS_Z);
  const halfW = halfWAt(FOCUS_Z);
  const edgeX = halfWAt(2.3) * 0.6;

  // The rings take what they want, as long as the content column keeps at
  // least MIN_CONTENT to their right; on a small screen they shrink further
  // (down to MIN_FIT of the old fixed radius) to leave it that.
  const MIN_CONTENT = 2.8;
  const MIN_FIT = 0.45;
  const wantR = Math.min(MAX_RING_R, ringRadius(childCount));
  // How far the rings really reach on screen, perspective included (the
  // near side of a big ring swings well past its radius), measured in
  // FOCUS_Z-plane units. Shrink them (not below MIN_FIT of the old radius) until
  // that plus a label's half-width leaves the content column its room.
  const minFit = Math.min(1, baseRingRadius(childCount) / ringRadius(childCount)) * MIN_FIT;
  const maxFit = wantR / ringRadius(childCount);
  const extentAt = (fit) =>
    ringExtent(childCount, {
      center: new THREE.Vector3(0, 0, FOCUS_Z),
      ringFit: fit,
      innerTilt: INNER_TILT,
      outerTilt: OUTER_TILT,
    });
  const fitsAt = (fit) => extentAt(fit).x + LABEL_HALF + MIN_CONTENT + 0.2 <= halfW * 0.94;
  let ringFit = maxFit;
  if (!fitsAt(maxFit)) {
    let lo = minFit;
    let hi = maxFit;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (fitsAt(mid)) lo = mid;
      else hi = mid;
    }
    ringFit = lo;
  }
  const ext = extentAt(ringFit);
  const wideLeft = Math.max(ext.x + LABEL_HALF, wantR * ringFit + 0.8);
  const wideRoom = halfW * 0.94 - wideLeft;
  const w = Math.max(2.4, Math.min(5, wideRoom - 0.2));
  // The content screen: this wide, from below the search bar down near the
  // bottom of the view (FocusContent; declutter and depthFade keep to it).
  const content = { x: wideLeft + w / 2, z: FOCUS_Z, w, top: halfH * 0.78, bottom: -halfH * 0.84 };

  // The parent sits further back; scale the rings' on-screen reach to its
  // depth so it clears them instead of hiding behind them.
  const toDepth = (z) => (FOCUS_CAMERA_RADIUS - z) / (FOCUS_CAMERA_RADIUS - FOCUS_Z);
  const parentZ = FOCUS_Z - 2.2;
  const parentY = Math.min(halfHAt(parentZ) * 0.75, Math.max(2.2, (ext.top + 0.7) * toDepth(parentZ)));
  // Related: scattered all round a hub in the middle of them, level with
  // the focus (utils/relatedScatter.js, placed by RelatedHud once the
  // labels are measured), wired out on the side facing the focus at
  // `exit`.
  const relatedZ = 2.0;
  const area = {
    x0: -halfWAt(relatedZ) * 0.97,
    x1: -halfWAt(relatedZ) * 0.5,
    y0: -halfHAt(relatedZ) * 0.78,
    y1: halfHAt(relatedZ) * 0.68,
  };
  const hubY = 0;
  const related = {
    z: relatedZ,
    hub: new THREE.Vector3((area.x0 + area.x1) / 2, hubY, relatedZ),
    exit: new THREE.Vector3(area.x1 + 0.3, hubY, relatedZ),
    area,
    // A crowded list may widen the area toward the focus up to here.
    maxX1: -halfWAt(relatedZ) * 0.43,
  };
  return {
    center: new THREE.Vector3(0, 0, FOCUS_Z),
    ringFit,
    innerTilt: INNER_TILT,
    outerTilt: OUTER_TILT,
    parentOffset: new THREE.Vector3(-2.8, parentY, parentZ - FOCUS_Z),
    ancestors: { step: { x: -0.13, y: 0.1 } },
    aspect,
    related,
    content,
    // The focus title stays this wide, clear of the content column.
    focusW: 2 * (wideLeft - 0.55),
    // The navigation row goes below the lowest point the orbiting satellites
    // reach (badge included), as far as the screen allows.
    infoY: Math.max(ext.bottom - 0.6, -halfHAt(FOCUS_Z + 0.2) * 0.9 + 0.3),
    edgeX,
  };
}
