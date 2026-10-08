import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useKnowledgeStore } from '../../store/knowledgeStore.js';
import { hasLanded, sceneState } from '../../utils/sceneLayout.js';
import {
  GLOW_WHITEN,
  MAX_POINTS,
  STREAK_STEPS,
  TRACE_DIM,
  chamfer,
  hash01,
  pointAlong,
  route,
  streakAt,
} from '../../utils/circuit.js';

const MIN_CAPACITY = 32;
// Once the focus has landed its traces grow out, the ancestor chain first,
// then one child after another CHILD_STAGGER apart, each over GROW_TIME with
// a spark at its tip; a child shows up when its trace reaches it.
const GROW_TIME = 0.45;
const CHILD_STAGGER = 0.06;
const TIP = 0.5; // length of the spark riding a growing trace

// GPU buffers can't grow in place, so they are sized for the focused node's
// link count, rounded up to a power of two so that moving between nodes of
// similar size reuses them.
function capacityFor(links) {
  let cap = MIN_CAPACITY;
  while (cap < links) cap *= 2;
  return cap;
}

/**
 * Circuit-board style links while a node is focused: orthogonal 3D traces
 * from the focus to each orbiting child and up the ancestor chain (to the
 * owning language for frameworks and libraries), and a bright streak of "current" running along each trace
 * like electricity down a wire; corners cut at 45°
 * (utils/circuit.js). Each trace and its streak take the colour
 * of the link's parent up the ancestor chain and of its child out to the
 * children (`color` until it has one). Everything follows the nodes' live
 * positions and is written straight into GPU buffers.
 */
export function SatelliteLinks({ color }) {
  const focus = useKnowledgeStore((s) => s.focus);
  const traces = useRef();
  const streaks = useRef();

  // Ancestor chain first (focus -> ... -> language, then owning languages),
  // then one link per child — every link is drawn, however many children.
  // `tint` is the node whose colour the link takes: up the ancestor chain
  // the parent's, out to a child the child's. `delay`: when it starts
  // growing, after the focus has landed.
  const links = useMemo(() => {
    if (!focus) return [];
    const chain = [focus.node.id, ...[...focus.node.path].reverse().map((a) => a.id)];
    chain.push(...[...(focus.node.owners ?? [])].reverse().map((o) => o.id));
    const out = [];
    for (let i = 0; i + 1 < chain.length; i++) out.push({ from: chain[i], to: chain[i + 1], tint: chain[i + 1], delay: 0 });
    focus.children.forEach((ch, i) => {
      out.push({ from: focus.node.id, to: ch.id, tint: ch.id, delay: GROW_TIME * 0.5 + i * CHILD_STAGGER, child: true });
    });
    return out;
  }, [focus]);
  // When the focus landed, for this focus.
  const grown = useRef({ id: null, at: null });

  const capacity = capacityFor(links.length);
  const maxSegments = capacity * (2 * MAX_POINTS - 3);
  const maxGlow = capacity * STREAK_STEPS;
  const positions = useMemo(() => new Float32Array(maxSegments * 6), [maxSegments]);
  const traceColors = useMemo(() => new Float32Array(maxSegments * 6), [maxSegments]);
  const glowPositions = useMemo(() => new Float32Array(maxGlow * 6), [maxGlow]);
  const glowColors = useMemo(() => new Float32Array(maxGlow * 6), [maxGlow]);
  const scratch = useMemo(
    () => ({
      pts: Array.from({ length: MAX_POINTS }, () => new THREE.Vector3()),
      cut: Array.from({ length: 2 * MAX_POINTS }, () => new THREE.Vector3()),
      p: new THREE.Vector3(),
      r: new THREE.Vector3(),
      c: new THREE.Color(),
      glowColor: new THREE.Color(),
      white: new THREE.Color(1, 1, 1),
    }),
    []
  );

  useFrame((state) => {
    const { pts, cut, p, r, c, glowColor, white } = scratch;
    const time = state.clock.elapsedTime;
    if (!traces.current || !streaks.current) return;
    // The traces belong to the focus group: they fade with it when the
    // camera has swung another part in front (utils/depthFade.js).
    const fade = sceneState.depthFade.center;
    traces.current.material.opacity = TRACE_DIM * fade;
    streaks.current.material.opacity = fade;

    let seg = 0;
    let glow = 0;
    const addSeg = (a, b) => {
      positions.set([a.x, a.y, a.z, b.x, b.y, b.z], seg * 6);
      traceColors.set([c.r, c.g, c.b, c.r, c.g, c.b], seg * 6);
      seg++;
    };
    // One piece of a streak; brightness fades from head (1) to tail (0).
    const addGlow = (a, ka, b, kb) => {
      glowPositions.set([a.x, a.y, a.z, b.x, b.y, b.z], glow * 6);
      const g = glowColor;
      glowColors.set([g.r * ka, g.g * ka, g.b * ka, g.r * kb, g.g * kb, g.b * kb], glow * 6);
      glow++;
    };

    // A new focus: wait for it to land, then time every trace (and so when
    // each child shows up).
    const G = grown.current;
    const focusGroup = focus && sceneState.registry.get(focus.node.id);
    if (G.id !== (focus?.node.id ?? null)) {
      G.id = focus?.node.id ?? null;
      G.at = null;
      sceneState.childArrival.clear();
    }
    if (G.at === null && hasLanded(focusGroup)) {
      G.at = time;
      for (const l of links) if (l.child) sceneState.childArrival.set(l.to, time + l.delay + GROW_TIME);
    }

    for (const { from: fromId, to: toId, tint, delay } of links) {
      const a = sceneState.registry.get(fromId);
      const b = sceneState.registry.get(toId);
      if (!a || !b || G.at === null) continue;
      const grow = Math.min(1, (time - G.at - delay) / GROW_TIME);
      if (grow <= 0) continue;
      // The wire takes that node's colour; the current running down it is
      // the same colour, lit up toward white so it still reads as a spark.
      c.set(sceneState.registry.get(tint)?.userData.color ?? color);
      glowColor.copy(c).lerp(white, GLOW_WHITEN);
      const h = hash01(fromId, toId);
      const n = chamfer(cut, pts, route(pts, a.position, b.position, h));

      let length = 0;
      for (let j = 0; j + 1 < n; j++) length += cut[j].distanceTo(cut[j + 1]);
      // Grown this far from the focus.
      const drawn = length * grow;
      let run = 0;
      for (let j = 0; j + 1 < n && run < drawn; j++) {
        const len = cut[j].distanceTo(cut[j + 1]);
        r.copy(cut[j + 1]);
        if (run + len > drawn) r.lerpVectors(cut[j], cut[j + 1], (drawn - run) / len);
        addSeg(cut[j], r);
        run += len;
      }
      if (grow < 1) {
        // The spark riding its tip.
        pointAlong(p, cut, n, Math.max(0, drawn - TIP));
        for (let k = 1; k <= STREAK_STEPS; k++) {
          pointAlong(r, cut, n, Math.max(0, drawn - TIP) + (Math.min(TIP, drawn) * k) / STREAK_STEPS);
          addGlow(p, (k - 1) / STREAK_STEPS, r, k / STREAK_STEPS);
          p.copy(r);
        }
        continue;
      }

      // The streak runs from the focus outward, fully leaving the far end
      // before the next one enters, and follows the trace round its bends.
      if (length > 0) {
        const { head, trail } = streakAt(length, time, h);
        pointAlong(p, cut, n, head - trail);
        for (let k = 1; k <= STREAK_STEPS; k++) {
          pointAlong(r, cut, n, head - trail + (trail * k) / STREAK_STEPS);
          addGlow(p, (k - 1) / STREAK_STEPS, r, k / STREAK_STEPS);
          p.copy(r);
        }
      }
    }

    const geom = traces.current.geometry;
    geom.setDrawRange(0, seg * 2);
    geom.attributes.position.needsUpdate = true;
    geom.attributes.color.needsUpdate = true;
    const glowGeom = streaks.current.geometry;
    glowGeom.setDrawRange(0, glow * 2);
    glowGeom.attributes.position.needsUpdate = true;
    glowGeom.attributes.color.needsUpdate = true;
  });

  return (
    <group>
      {/* keyed by capacity: a bigger buffer needs a fresh geometry */}
      <lineSegments key={`t${capacity}`} ref={traces} frustumCulled={false} renderOrder={1}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" array={positions} count={maxSegments * 2} itemSize={3} />
          <bufferAttribute attach="attributes-color" array={traceColors} count={maxSegments * 2} itemSize={3} />
        </bufferGeometry>
        <lineBasicMaterial vertexColors transparent opacity={TRACE_DIM} depthWrite={false} />
      </lineSegments>

      <lineSegments key={`s${capacity}`} ref={streaks} frustumCulled={false} renderOrder={1}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" array={glowPositions} count={maxGlow * 2} itemSize={3} />
          <bufferAttribute attach="attributes-color" array={glowColors} count={maxGlow * 2} itemSize={3} />
        </bufferGeometry>
        <lineBasicMaterial
          vertexColors
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>
    </group>
  );
}
