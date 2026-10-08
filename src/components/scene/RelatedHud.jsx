import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useKnowledgeStore } from '../../store/knowledgeStore.js';
import { damp } from '../../utils/animations.js';
import { sceneState, ancestorPosition, CAMERA_FOV, FOCUS_CAMERA_RADIUS } from '../../utils/sceneLayout.js';
import { RELATED_FRAME_PAD as PAD } from '../../utils/declutter.js';
import {
  GLOW_WHITEN,
  MAX_POINTS,
  STREAK_STEPS,
  TRACE_DIM,
  STREAK_SPEED,
  chamfer,
  hash01,
  pointAlong,
  polylineLength,
  titleSide,
  streakAt,
} from '../../utils/circuit.js';
import { routeRelated, scatterRelated } from '../../utils/relatedScatter.js';

// Segments per frame: 8 corner arms per box plus every trace and its
// streak. The buffer starts at this size and doubles whenever a frame needs
// more, so any number of related keywords is fully wired.
const START_SEGMENTS = 512;
// A label spans +0.5 .. -0.86 around its origin at scale 1 (title + badge,
// see utils/declutter.js) — the nominal block, till its glyphs are measured.
const LABEL_TOP = 0.5;
const LABEL_BOTTOM = 0.86;
// Where a label's glyphs are, at scale 1: half their width, how far the
// title reaches above the node and the badge below it (KeywordNode measures
// them). Frames hug these, PAD clear.
const glyphs = (g) => {
  const t = g.userData.titleBox;
  return {
    hw: Math.max(t ? t.x1 - t.x0 : g.userData.textWidth ?? 1, g.userData.badgeGlyphWidth ?? g.userData.badgeWidth ?? 0) / 2,
    top: t ? t.y1 : LABEL_TOP,
    bottom: g.userData.badgeBottom !== undefined ? -g.userData.badgeBottom : LABEL_BOTTOM,
  };
};
const LOCK_TIME = 0.7; // seconds for a frame to close in on its label
// Once every related keyword has landed and its frame locked on, the wires
// grow from them into the hub, then the trunk from the hub to the focus.
const WIRE_TIME = 0.6;
const TRUNK_DELAY = 0.1;
const TRUNK_TIME = 0.5;
// On the trunk the current keeps its keyword's colour so you can follow it
// into the focus: its own colour, over a darker trunk, and short — every
// wire feeds the trunk, so many run down it at once, and overlapping (the
// lines add up) they would wash out white.
const TRUNK_WHITEN = 0;
const TRUNK_TRAIL = 0.5;
const TRUNK_DIM = 0.4;
const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const WHITE = new THREE.Color(1, 1, 1);
// The trunk's last turn onto the scatter's way out is left out (a straight
// run instead) when it would be a step this small in NDC: it reads as a kink.
const LEVEL = 0.03;
const ndcA = new THREE.Vector3();
const ndcB = new THREE.Vector3();

/**
 * Wiring for the focus's related keywords: each label is framed by four
 * corner brackets (locking on as it arrives). It also scatters them
 * (utils/relatedScatter.js) once they are measured and routes
 * each a circuit trace into one hub a little below the focus — round the
 * other labels, free to cross or join other traces — and, once they have
 * all landed, wires those up and the hub on into the focus. Current runs like on
 * the focus's own links (utils/circuit.js): down each wire in its keyword's
 * colour to the hub, where every streak that arrives carries on down the
 * trunk into the focus in the colour it came in.
 * Screen-aligned (labels are billboards), written straight into one GPU
 * buffer per frame.
 */
export function RelatedHud({ linkColor }) {
  const focused = useKnowledgeStore((s) => !!s.focus);
  const lines = useRef();
  const lockedAt = useRef(new Map());
  // When the current set of frames was wired up (null: still arriving).
  const wiring = useRef({ key: '', start: null });

  const [capacity, setCapacity] = useState(START_SEGMENTS);
  const positions = useMemo(() => new Float32Array(capacity * 6), [capacity]);
  const colors = useMemo(() => new Float32Array(capacity * 6), [capacity]);
  const scratch = useMemo(
    () => ({
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      c: new THREE.Color(),
      glow: new THREE.Color(),
      exit: new THREE.Vector3(),
      hub: new THREE.Vector3(),
      circuitPts: Array.from({ length: MAX_POINTS }, () => new THREE.Vector3()),
      trunkPts: [],
      // The trunk and a spoke with their corners cut (utils/circuit.js).
      trunkCut: [],
      spokeCut: [],
      boxes: [],
      related: [],
      items: [],
    }),
    []
  );

  useFrame((state, dt) => {
    if (!lines.current) return;
    const { right, up, a, b, c, glow, exit, hub, circuitPts, trunkPts, boxes, related, items } = scratch;
    const time = state.clock.elapsedTime;
    right.setFromMatrixColumn(state.camera.matrixWorld, 0);
    up.setFromMatrixColumn(state.camera.matrixWorld, 1);

    let seg = 0;
    let needed = 0;
    const add = (p, q, color, k) => {
      needed++;
      if (seg >= capacity) return;
      positions.set([p.x, p.y, p.z, q.x, q.y, q.z], seg * 6);
      const r = color.r * k, g = color.g * k, bl = color.b * k;
      colors.set([r, g, bl, r, g, bl], seg * 6);
      seg++;
    };

    let focusGroup = null;
    for (const [id, role] of sceneState.roles) {
      if (role.type === 'focus') focusGroup = sceneState.registry.get(id);
    }
    const L = sceneState.layout;
    const seen = new Set();
    boxes.length = 0;

    // ---- Scatter, once every related label is measured at
    // its resting size; again whenever the list or the screen changes.
    if (focusGroup) {
      related.length = 0;
      let focusId = 0;
      for (const [id, role] of sceneState.roles) {
        if (role.type === 'related') related.push([id, role]);
        else if (role.type === 'focus') focusId = id;
      }
      const R = L.related;
      const key = `${focusId}|${R.area.x0.toFixed(3)}|${R.area.y1.toFixed(3)}|${related.map(([id]) => id).join(',')}`;
      if (related.length && key !== sceneState.relatedSpotsKey) {
        items.length = 0;
        for (const [id, role] of related) {
          const g = sceneState.registry.get(id);
          // At full size: undo the fit the labels are currently shrunk by.
          const sc = g?.userData.restScale / sceneState.relatedFit;
          if (!g?.userData.textWidth || !Number.isFinite(sc)) break;
          items.push({
            id,
            index: role.index,
            hw: glyphs(g).hw * sc + PAD,
            top: glyphs(g).top * sc + PAD,
            bottom: glyphs(g).bottom * sc + PAD,
          });
        }
        if (items.length === related.length) {
          items.sort((p, q) => p.index - q.index);
          const seed = focusId * 7919 + items.length;
          // A crowded list may come back shrunk (KeywordNode scales the
          // labels by relatedFit) and / or with the area widened toward the
          // focus: the trunk leaves on that side of it.
          // The ancestor chain's labels, mapped onto the scatter's plane (the
          // same screen spot), are off limits.
          const tanHalf = Math.tan((CAMERA_FOV * Math.PI) / 360);
          const halfAt = (z) => tanHalf * (FOCUS_CAMERA_RADIUS - z);
          const obstacles = [];
          for (const [aid, arole] of sceneState.roles) {
            if (arole.type !== 'parent') continue;
            const ag = sceneState.registry.get(aid);
            if (!ag?.userData.textWidth) continue;
            const p = ancestorPosition(scratch.a, arole.depth, L);
            const k = halfAt(R.z) / halfAt(p.z);
            const gl = glyphs(ag);
            const sc = (ag.userData.restScale ?? 1) * k;
            obstacles.push({
              x: p.x * k,
              y: p.y * k,
              hw: gl.hw * sc + PAD,
              top: gl.top * sc + PAD,
              bottom: gl.bottom * sc + PAD,
            });
          }
          const { spots, area, fit, items: fitted } = scatterRelated(items, R.area, R.hub, seed, R.maxX1, obstacles);
          sceneState.relatedFit = fit;
          exit.copy(R.exit).setX(Math.max(R.exit.x, area.x1 + 0.3));
          const { routes, out } = routeRelated(fitted, spots, area, R.hub, exit, seed);
          const toWorld = (pt) => new THREE.Vector3(pt.x, pt.y, R.z);
          sceneState.relatedSpots.clear();
          sceneState.relatedRoutes.clear();
          for (const [id, spot] of spots) sceneState.relatedSpots.set(id, toWorld(spot));
          for (const [id, route] of routes) sceneState.relatedRoutes.set(id, route.map(toWorld));
          sceneState.relatedOut = out.map(toWorld);
          sceneState.relatedSpotsKey = key;
        }
      }
    }

    // ---- Frames.
    for (const [id, role] of sceneState.roles) {
      if (role.type !== 'related') continue;
      const g = sceneState.registry.get(id);
      // Not until the title is measured, or the frame would snap wider.
      if (!g || g.scale.x < 0.02 || !g.userData.textWidth) continue;
      seen.add(id);
      if (!lockedAt.current.has(id)) lockedAt.current.set(id, time);
      const t = Math.min(1, (time - lockedAt.current.get(id)) / LOCK_TIME);
      const ease = 1 - Math.pow(1 - t, 3);
      // Fades out while another label overlaps it (see utils/declutter.js).
      g.userData.frameAlpha = damp(g.userData.frameAlpha ?? 1, g.userData.frameCovered ? 0 : 1, 8, dt);
      const k = (g.userData.opacity ?? 1) * ease * g.userData.frameAlpha;
      c.set(g.userData.color ?? linkColor);

      const s = g.scale.x;
      const grow = 1 + 0.5 * (1 - ease);
      const gl = glyphs(g);
      const hw = (gl.hw * s + PAD) * grow;
      const hTop = (gl.top * s + PAD) * grow;
      const hBottom = (gl.bottom * s + PAD) * grow;
      const arm = Math.min(0.2, hw * 0.3, (hTop + hBottom) * 0.35);

      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          a.copy(g.position).addScaledVector(right, sx * hw).addScaledVector(up, sy > 0 ? hTop : -hBottom);
          add(a, b.copy(a).addScaledVector(right, -sx * arm), c, k);
          add(a, b.copy(a).addScaledVector(up, -sy * arm), c, k);
        }
      }

      const settled = t >= 1 && !g.userData.inFlight && g.userData.revealStart === undefined;
      boxes.push({ id, g, hw, hTop, mid: (hTop - hBottom) / 2, k, settled, index: role.index });
    }
    for (const id of lockedAt.current.keys()) if (!seen.has(id)) lockedAt.current.delete(id);

    // A new set of related keywords starts over; wiring begins once all of
    // them have settled.
    const w = wiring.current;
    const key = [...seen].join(',');
    if (key !== w.key) {
      w.key = key;
      w.start = null;
    }
    if (w.start === null && boxes.length && boxes.every((box) => box.settled)) w.start = time;
    const wireReach = w.start === null ? 0 : easeOut((time - w.start) / WIRE_TIME);
    const trunkReach = w.start === null ? 0 : easeOut((time - w.start - WIRE_TIME - TRUNK_DELAY) / TRUNK_TIME);

    // A wire along P[0..count-1], grown `reach` of the way, drawn dim;
    // returns its full length and how much of it is drawn.
    const wire = (P, count, reach, color, k) => {
      const length = polylineLength(P, count);
      const end = length * reach;
      let run = 0;
      for (let j = 0; j + 1 < count && run < end; j++) {
        const len = P[j].distanceTo(P[j + 1]);
        b.copy(P[j + 1]);
        if (run + len > end) b.lerpVectors(P[j], P[j + 1], (end - run) / len);
        add(P[j], b, color, k * TRACE_DIM);
        run += len;
      }
      return { length, end };
    };
    // A streak of current on P, its head at `head` and `trail` long, drawn
    // no further than `end`: its colour lit `whiten` of the way toward white,
    // fading from the head (1) back to the tail (0).
    const streak = (P, count, end, head, trail, color, k, whiten = GLOW_WHITEN) => {
      if (head - trail >= end || head <= 0) return;
      glow.copy(color).lerp(WHITE, whiten);
      pointAlong(a, P, count, Math.min(end, head - trail));
      for (let i = 1; i <= STREAK_STEPS; i++) {
        pointAlong(b, P, count, Math.min(end, head - trail + (trail * i) / STREAK_STEPS));
        add(a, b, glow, (k * (i - 0.5)) / STREAK_STEPS);
        a.copy(b);
      }
    };

    // ---- Wires -> hub -> trunk to the focus.
    if (focusGroup && boxes.length && wireReach > 0) {
      hub.copy(L.related.hub);
      // The trunk: out of the scatter from the hub, round the labels, as
      // routed when they were scattered (to `exit`), then on into the focus,
      // stopping right at its title's text on the left (utils/circuit.js,
      // titleSide): laid out on screen, across from there and up or down
      // onto the scatter's way out (straight if that is all but level),
      // its depth leg along the line of sight so it doesn't show. Built
      // from the focus back and walked backwards.
      const outPts = sceneState.relatedOut;
      const start = outPts.length ? outPts[outPts.length - 1] : hub;
      const cam = state.camera;
      titleSide(circuitPts[0], focusGroup, -1, cam);
      ndcA.copy(circuitPts[0]).project(cam);
      ndcB.copy(start).project(cam);
      circuitPts[1].set(ndcA.x, ndcA.y, ndcB.z).unproject(cam);
      let circuitCount = 2;
      if (Math.abs(ndcA.y - ndcB.y) > LEVEL) circuitPts[circuitCount++].set(ndcB.x, ndcA.y, ndcB.z).unproject(cam);
      circuitPts[circuitCount++].copy(start);
      const trunkCount = outPts.length + circuitCount - (outPts.length ? 1 : 0);
      while (trunkPts.length < trunkCount) trunkPts.push(new THREE.Vector3());
      outPts.forEach((pt, i) => trunkPts[i].copy(pt));
      for (let i = outPts.length ? 1 : 0, j = outPts.length; i < circuitCount; i++, j++) {
        trunkPts[j].copy(circuitPts[circuitCount - 1 - i]);
      }
      let k = 0;
      for (const box of boxes) k = Math.max(k, box.k);
      // Corners cut at 45° (utils/circuit.js).
      const cut = (into, P, count) => {
        while (into.length < 2 * count) into.push(new THREE.Vector3());
        return chamfer(into, P, count);
      };
      const trunkCut = scratch.trunkCut;
      const trunkM = cut(trunkCut, trunkPts, trunkCount);
      // The trunk runs into the focus: it dims with it when the camera has
      // swung the focus behind the scatter (utils/depthFade.js).
      const onFocus = sceneState.depthFade.center ** 2; // squared: thin lines read stronger than text
      const trunk = wire(trunkCut, trunkM, trunkReach, WHITE, k * TRUNK_DIM * onFocus);
      const trunkTrail = Math.min(TRUNK_TRAIL, trunk.length * 0.6);

      // Each keyword's trace, as routed when they were scattered.
      for (const box of boxes) {
        const route = sceneState.relatedRoutes.get(box.id);
        if (!route) continue;
        c.set(box.g.userData.color ?? linkColor);
        const h = hash01(box.index + 1, 17);
        const P = scratch.spokeCut;
        const m = cut(P, route, route.length);
        const spoke = wire(P, m, wireReach, c, box.k);
        const { head, trail } = streakAt(spoke.length, time, h);
        streak(P, m, spoke.end, head, trail, c, box.k);

        // Every streak that has reached the hub carries on down the trunk
        // in this wire's colour: the p-th reaches it at
        // (p + length / span - h) * span / STREAK_SPEED.
        if (trunkReach <= 0 || spoke.length <= 0) continue;
        const span = spoke.length + trail;
        const arrive = spoke.length / span - h;
        const period = span / STREAK_SPEED;
        const lifetime = (trunk.length + trunkTrail) / STREAK_SPEED;
        for (let pass = Math.floor(time / period - arrive); ; pass--) {
          const since = time - (pass + arrive) * period;
          if (since > lifetime) break;
          streak(trunkCut, trunkM, trunk.end, since * STREAK_SPEED, trunkTrail, c, box.k * onFocus, TRUNK_WHITEN);
        }
      }
    }

    const geom = lines.current.geometry;
    geom.setDrawRange(0, seg * 2);
    geom.attributes.position.needsUpdate = true;
    geom.attributes.color.needsUpdate = true;
    // Ran out of room: grow the buffer (the next render draws everything).
    if (needed > capacity) {
      let next = capacity * 2;
      while (next < needed) next *= 2;
      setCapacity(next);
    }
  });

  if (!focused) return null;
  return (
    <>
      {/* keyed by capacity: a bigger buffer needs a fresh geometry */}
      <lineSegments key={capacity} ref={lines} frustumCulled={false} renderOrder={1}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" array={positions} count={capacity * 2} itemSize={3} />
          <bufferAttribute attach="attributes-color" array={colors} count={capacity * 2} itemSize={3} />
        </bufferGeometry>
        {/* Drawn over everything, like a HUD: the spokes
            start inside their labels and the trunk runs into the focus
            title, and those billboards would otherwise hide whatever part
            of a line runs behind them once the camera swings round. */}
        <lineBasicMaterial
          vertexColors
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </lineSegments>
    </>
  );
}
