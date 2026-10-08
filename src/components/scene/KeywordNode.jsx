import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Billboard } from '@react-three/drei';
import * as THREE from 'three';
import { useKnowledgeStore } from '../../store/knowledgeStore.js';
import {
  clusterTarget,
  createFlight,
  damp,
  floatingOffset,
  wanderingOffset,
} from '../../utils/animations.js';
import {
  CAMERA_FOV,
  ancestorPosition,
  relatedPosition,
  satellitePosition,
  sceneState,
} from '../../utils/sceneLayout.js';
import { COLORS, FONT } from '../../utils/palette.js';

const TIER_DELAY = { center: 0, near: 0.05, medium: 0.12 };
// Related keywords come in top to bottom, their title wiping in left to
// right (a clip on the finished layout, so the text never re-flows).
const RELATED_STAGGER = 0.07;
const REVEAL_TIME = 0.6;
const TAN_HALF_FOV = Math.tan((CAMERA_FOV * Math.PI) / 360);
// "CORS (ASP.NET)" -> "CORS": the suffix only says where a node belongs.
const bareTitle = (title) => title.replace(/\s+\([^()]+\)$/, '');
// Past this many satellites the labels shrink so the rings stay readable.
const CROWD = 8;

/**
 * One keyword in 3D: a billboarded label plus a small category badge
 * (with the owning language for non-language nodes).
 * Everything per-frame mutates refs directly — its role in the scene
 * (see KnowledgeScene) decides where it goes, how big and how bright.
 */
export function KeywordNode({ node, initialPosition }) {
  const groupRef = useRef();
  const labelRef = useRef();
  const labelMaterial = useRef();
  const badgeMaterial = useRef();
  const flight = useRef(null);
  const layoutKey = useRef(null);
  const textWidth = useRef(0);

  const color = node.color; // from the node's category in the DB
  const baseScale =
    (0.16 + ((node.importance ?? 5) / 10) * 0.23) * node.scale;
  // While searching, the badge shows how closely this word matches the
  // query instead of its child count.
  const percent = useKnowledgeStore((s) =>
    s.mode === 'preview' ? s.preview.results.find((r) => r.node.id === node.id)?.percent : undefined
  );
  const tail =
    percent === undefined
      ? node.child_count ? ` +${node.child_count}` : ''
      : percent > 0 ? ` ${percent}%` : '';
  // Anything that isn't a language itself (framework, library, module...)
  // also names the language it belongs to.
  const ownSuffix = !!node.language && node.title.endsWith(`(${node.language})`);
  const owner = node.owner_language ? ` / ${node.owner_language}` : ownSuffix ? ` / ${node.language}` : '';
  const badge = `[${`${node.category}${owner}`.toUpperCase()}]${tail}`;
  const phase = (node.id * 2.399) % (Math.PI * 2);
  // A title drops its "(ASP.NET)" / "(CSS)" suffix while the scene already
  // says where it belongs: orbiting the focus (unless a sibling would then
  // read the same) or in the chain above it. A language's section (which has
  // a short_title) keeps it short when focused too.
  const brief = node.short_title ?? bareTitle(node.title);
  const inContext = useKnowledgeStore((s) => {
    if (brief === node.title || !s.focus) return false;
    const f = s.focus.node;
    if (f.id === node.id) return !!node.short_title;
    if (f.path.some((p) => p.id === node.id) || (f.owners ?? []).some((o) => o.id === node.id)) return true;
    const kids = s.focus.children;
    if (!kids.some((c) => c.id === node.id)) return false;
    return kids.filter((c) => (c.short_title ?? bareTitle(c.title)) === brief).length === 1;
  });
  // A "(JavaScript)" suffix only keeps titles unique; the label never shows it
  // (the badge names the language instead).
  const label = inContext || ownSuffix ? brief : node.title;

  const basePos = useMemo(() => new THREE.Vector3(...initialPosition), [initialPosition]);
  const target = useMemo(() => new THREE.Vector3(), []);
  const offset = useMemo(() => new THREE.Vector3(), []);
  const anchor = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const g = groupRef.current;
    sceneState.registry.set(node.id, g);
    return () => {
      if (sceneState.registry.get(node.id) === g) sceneState.registry.delete(node.id);
    };
  }, [node.id]);

  useFrame((state, dt) => {
    const g = groupRef.current;
    const time = state.clock.elapsedTime;
    const { mode, hoveredNodeId, layoutRevision, preview } = useKnowledgeStore.getState();
    const role = sceneState.roles.get(node.id);
    const L = sceneState.layout;
    const closeness = preview?.closeness ?? 0;

    // ---- Where it should be.
    let orbiting = false;
    let steady = false;
    switch (role?.type) {
      case 'focus':
        target.copy(L.center);
        steady = true;
        break;
      case 'child':
        satellitePosition(target, role.index, role.count, sceneState.orbitAngle, L);
        orbiting = true;
        break;
      case 'parent':
        ancestorPosition(target, role.depth, L);
        break;
      case 'related': {
        // The spot RelatedHud scattered it to, once it has; the hub till then.
        const spot = sceneState.relatedSpots.get(node.id);
        if (spot) target.copy(spot);
        else relatedPosition(target, L);
        // Held still: RelatedHud's traces are routed from these very spots.
        steady = true;
        break;
      }
      case 'hit': {
        // The whole cluster starts toward the right edge and slides to the
        // centre as the query gets closer to the top match's full title.
        const k = 1 - closeness;
        anchor.set(L.edgeX * k, k, -2.5 * k);
        target
          .copy(clusterTarget(role.tier, role.index, node.id * 7.3))
          .add(anchor);
        steady = role.primary;
        break;
      }
      default:
        target.copy(basePos);
        if (mode !== 'idle') {
          // Not part of the current query/focus: recede into a rear layer.
          target.multiplyScalar(1.08);
          target.z = -Math.abs(basePos.z) * 0.35 - 1;
        }
    }

    if (!steady && !orbiting) {
      const amp = role || mode !== 'idle' ? 0.12 : 0.4;
      offset.copy(floatingOffset(time, phase, amp, amp, amp * 0.75));
      const wander = role ? 0.16 : mode !== 'idle' ? 0.8 : 1.55;
      offset.add(wanderingOffset(time, phase + node.id * 1.37, wander, wander * 0.72, wander * 0.9));
      target.add(offset);
    }

    // ---- Declutter: remember the planned spot, then ease toward the push
    // that keeps this label off its neighbours (utils/declutter.js).
    (g.userData.base ??= new THREE.Vector3()).copy(target);
    const push = sceneState.nudge.get(node.id);
    const want = push && Number.isFinite(push.x + push.y + push.z) ? push : null;
    const nudge = (g.userData.nudge ??= new THREE.Vector3());
    nudge.set(
      damp(nudge.x, want?.x ?? 0, 10, dt),
      damp(nudge.y, want?.y ?? 0, 10, dt),
      damp(nudge.z, want?.z ?? 0, 10, dt)
    );
    target.add(nudge);

    // ---- How it gets there: satellites follow their moving orbit point;
    // everything else flies an arc once per layout change, then settles.
    if (orbiting) {
      flight.current = null;
      layoutKey.current = null;
      g.position.set(
        damp(g.position.x, target.x, 4, dt),
        damp(g.position.y, target.y, 4, dt),
        damp(g.position.z, target.z, 4, dt)
      );
    } else {
      const key = `${role?.type ?? mode}|${role?.tier ?? ''}|${role?.index ?? ''}|${layoutRevision}`;
      if (key !== layoutKey.current) {
        layoutKey.current = key;
        const distance = g.position.distanceTo(target);
        flight.current = createFlight(g.position, target, {
          delay:
            role?.type === 'related'
              ? role.index * RELATED_STAGGER
              : (TIER_DELAY[role?.tier] ?? 0) + (node.id % 12) * 0.02,
          duration: Math.min(1.6, 0.25 + distance * 0.08),
          arcHeight: 0.6 + Math.min(2.4, distance * 0.18),
        });
        flight.current.startTime = time;
      }
      const f = flight.current;
      if (f) {
        f.end.copy(target);
        if (!f.hasStarted && time - f.startTime >= f.delay) {
          f.hasStarted = true;
          f.startTime = time;
        }
        if (f.hasStarted) {
          const t = Math.min(1, (time - f.startTime) / f.duration);
          f.pointAt(g.position, 1 - Math.pow(1 - t, 3));
          if (t >= 1) {
            flight.current = null;
            // A related keyword settles into its list without the pop.
            g.userData.arrivalPop = role?.type === 'related' ? 0 : 1;
          }
        }
      } else {
        g.position.set(
          damp(g.position.x, target.x, 6, dt),
          damp(g.position.y, target.y, 6, dt),
          damp(g.position.z, target.z, 6, dt)
        );
      }
    }

    // Still landing (RelatedHud waits for every related keyword to settle
    // before wiring them up).
    g.userData.inFlight = !!flight.current;

    // ---- How big and how bright.
    let scale = baseScale;
    // Unrelated keywords: a quiet backdrop, quieter still while reading a
    // focused node's content.
    let opacity = mode === 'idle' ? 0.38 : mode === 'focused' ? 0.12 : 0.22;
    let tint = color;
    switch (role?.type) {
      case 'focus':
        scale = Math.min(0.46, Math.max(0.36, baseScale));
        opacity = 1;
        tint = COLORS.highlight;
        break;
      case 'child': {
        // A crowded ring gets smaller labels (17 satellites: ~70%).
        const crowd = role.count > CROWD ? Math.max(0.62, Math.sqrt(CROWD / role.count)) : 1;
        scale = Math.max(0.18, baseScale * 0.7) * crowd;
        // Undo most of the perspective: the near side of a ring would
        // otherwise balloon while the far side shrinks to nothing.
        const ref = state.camera.position.distanceTo(L.center);
        const dist = g.position.distanceTo(state.camera.position);
        scale *= Math.pow(dist / ref, 0.7);
        // The far half of the ring fades and shrinks back, so the near half
        // reads cleanly on top (hovering one brings it back).
        const back = THREE.MathUtils.clamp((dist - ref) / 2.5, 0, 1);
        scale *= 1 - 0.2 * back;
        opacity = 0.95 - 0.6 * back;
        break;
      }
      case 'parent':
        scale = baseScale * 0.9;
        opacity = Math.max(0.55, 0.85 - 0.1 * (role.depth - 1));
        break;
      case 'related':
        // A crowded scatter shrinks them all (RelatedHud, relatedFit).
        scale = 0.3 * sceneState.relatedFit;
        opacity = 0.85;
        break;
      case 'hit':
        if (role.primary) {
          scale = baseScale * (1 + 0.5 * closeness);
          opacity = 0.55 + 0.45 * closeness;
        } else {
          scale = baseScale * (role.tier === 'near' ? 0.82 : 0.68);
          opacity = role.tier === 'near' ? 0.85 : 0.7;
        }
        break;
      default:
        if (mode !== 'idle') scale = baseScale * 0.9;
    }
    // Background words lying under an active label get out of the way.
    if (g.userData.occluded) opacity *= 0.15;
    // The related scatter or the focus group fades once the camera has
    // swung another part in front of it (utils/depthFade.js).
    if (role?.type === 'related') opacity *= sceneState.depthFade.related;
    else if (role && role.type !== 'hit') opacity *= sceneState.depthFade.center;
    // ... and a single label fades while it is behind the content column.
    if (role && role.type !== 'hit') opacity *= g.userData.behindFade ?? 1;
    // A child waits for the focus's trace to reach it (SatelliteLinks),
    // then pops in.
    let waiting = false;
    if (role?.type === 'child') {
      const at = sceneState.childArrival.get(node.id);
      if (at === undefined || time < at) {
        waiting = true;
        opacity = 0;
      } else if (g.userData.arrivedAt !== at) {
        g.userData.arrivedAt = at;
        g.userData.arrivalPop = 1;
      }
    }
    if (hoveredNodeId === node.id && !waiting) {
      scale *= 1.4;
      opacity = 1;
    }
    // Never let a label loom over the camera; the focus group may come closer.
    const distance = g.position.distanceTo(state.camera.position);
    const closeRange = role && role.type !== 'hit' ? 3.2 : 6;
    scale *= THREE.MathUtils.clamp(distance / closeRange, 0.12, 1);
    // Nor be wider than a share of the visible width at its depth — long
    // titles would otherwise run off the screen.
    if (textWidth.current > 0) {
      const visibleW = 2 * TAN_HALF_FOV * distance * (state.size.width / state.size.height);
      const share = role?.type === 'focus' ? 0.9 : 0.45;
      scale = Math.min(scale, (visibleW * share) / textWidth.current);
      // The focus title also keeps clear of the content column beside it.
      if (role?.type === 'focus') scale = Math.min(scale, L.focusW / textWidth.current);
    }
    g.userData.restScale = scale;
    if (g.userData.arrivalPop > 0) {
      scale *= 1 + 0.25 * g.userData.arrivalPop;
      g.userData.arrivalPop = Math.max(0, g.userData.arrivalPop - dt * 2.2);
    }
    g.scale.setScalar(damp(g.scale.x, scale, 5, dt));

    const material = labelMaterial.current;
    // Hidden at once while waiting; fading in quickly once its trace is in.
    material.opacity = waiting ? 0 : damp(material.opacity, opacity, role?.type === 'child' ? 9 : 4, dt);
    material.color.set(tint);
    // The badge always takes its title's colour.
    badgeMaterial.current.color.set(tint);
    badgeMaterial.current.opacity = material.opacity * 0.75;
    g.userData.opacity = material.opacity;
    g.userData.color = color;

    // ---- Becoming a related keyword: the title wipes in left to right as
    // it starts to fly (RelatedHud frames it meanwhile).
    const related = role?.type === 'related';
    if (related && !g.userData.wasRelated) g.userData.revealStart = time + role.index * RELATED_STAGGER;
    g.userData.wasRelated = related;
    const mesh = labelRef.current;
    if (g.userData.revealStart !== undefined && mesh) {
      const t = Math.max(0, (time - g.userData.revealStart) / REVEAL_TIME);
      const b = mesh.textRenderInfo?.blockBounds;
      if (t >= 1 || !related) {
        g.userData.revealStart = undefined;
        mesh.clipRect = null;
      } else if (b) {
        const e = 1 - Math.pow(1 - t, 3);
        const clip = (g.userData.clip ??= [0, 0, 0, 0]);
        clip[0] = b[0] - 1;
        clip[1] = b[1] - 1;
        clip[2] = b[0] + (b[2] - b[0]) * e;
        clip[3] = b[3] + 1;
        mesh.clipRect = clip;
      }
    }
  });

  const measure = (mesh) => {
    const b = mesh.textRenderInfo?.blockBounds;
    if (b && groupRef.current) {
      textWidth.current = b[2] - b[0];
      groupRef.current.userData.textWidth = textWidth.current;
      // Where the glyphs themselves are (at scale 1): the fixed traces out
      // of the focus run right up to its text (RelatedHud, panelWire), and
      // the related keywords' frames hug it (RelatedHud).
      const v = mesh.textRenderInfo.visibleBounds;
      if (v) groupRef.current.userData.titleBox = { x0: v[0], y0: v[1], x1: v[2], y1: v[3] };
    }
  };

  const handleClick = (e) => {
    e.stopPropagation();
    if (sceneState.roles.get(node.id)?.type !== 'focus') {
      useKnowledgeStore.getState().focusNode(node.id);
    }
  };
  const handlePointerOver = (e) => {
    e.stopPropagation();
    useKnowledgeStore.getState().setHovered(node.id);
    document.body.style.cursor = 'pointer';
  };
  const handlePointerOut = () => {
    useKnowledgeStore.getState().setHovered(null);
    document.body.style.cursor = 'auto';
  };

  return (
    <group ref={groupRef} position={initialPosition} scale={0.001}>
      <Billboard>
        <Text
          ref={labelRef}
          font={FONT}
          fontSize={1}
          anchorX="center"
          anchorY="middle"
          onClick={handleClick}
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
          renderOrder={2}
          onSync={measure}
        >
          {label}
          <meshBasicMaterial
            ref={labelMaterial}
            attach="material"
            color={color}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </Text>
        <Text
          font={FONT}
          position={[0, -0.7, 0]}
          fontSize={0.32}
          anchorX="center"
          anchorY="middle"
          renderOrder={3}
          onSync={(mesh) => {
            const b = mesh.textRenderInfo?.blockBounds;
            if (b && groupRef.current) groupRef.current.userData.badgeWidth = b[2] - b[0];
            // How far below the node its glyphs reach (at scale 1), for
            // frames that hug the text (RelatedHud).
            const v = mesh.textRenderInfo?.visibleBounds;
            if (v && groupRef.current) {
              groupRef.current.userData.badgeBottom = -0.7 + v[1];
              groupRef.current.userData.badgeGlyphWidth = v[2] - v[0];
            }
          }}
        >
          {badge}
          <meshBasicMaterial
            ref={badgeMaterial}
            attach="material"
            color={color}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </Text>
      </Billboard>
    </group>
  );
}
