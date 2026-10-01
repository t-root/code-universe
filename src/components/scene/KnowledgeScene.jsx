import { Suspense, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useKnowledgeStore } from '../../store/knowledgeStore.js';
import { KeywordNode } from './KeywordNode.jsx';
import { SatelliteLinks } from './SatelliteLinks.jsx';
import { FocusContent } from './FocusContent.jsx';
import { RelatedHud } from './RelatedHud.jsx';
import { createRng, generateShellPositions } from '../../utils/positions.js';
import { computeLayout, sceneState } from '../../utils/sceneLayout.js';
import { COLORS } from '../../utils/palette.js';
import { declutter } from '../../utils/declutter.js';
import { updateDepthFade } from '../../utils/depthFade.js';

/**
 * Which nodes are on stage, and what each is doing:
 *   idle     — just the root concepts, floating on their shells
 *   preview  — plus every search hit ('hit' role, by tier)
 *   focused  — plus the focus, its children ('child', orbiting), every
 *              ancestor up to the root ('parent', by depth; a framework's
 *              language counts as one more above its root) and its related
 *              nodes; everything else recedes
 */
function buildScene(roots, preview, focus) {
  const nodes = new Map(roots.map((n) => [n.id, n]));
  const roles = new Map();
  const put = (node, role) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    if (!roles.has(node.id)) roles.set(node.id, role);
  };

  if (focus) {
    const f = focus.node;
    put(f, { type: 'focus' });
    const count = focus.children.length;
    focus.children.forEach((c, index) => put(c, { type: 'child', index, count }));
    // Every ancestor up to the root, nearest first (depth 1 = parent), then
    // for a listed root (framework, library...) the section listing it and
    // its language: language -> section -> root -> ... -> focus.
    const ancestors = [...f.path].reverse();
    ancestors.push(...[...(f.owners ?? [])].reverse());
    ancestors.forEach((a, i) => put(a, { type: 'parent', depth: i + 1 }));
    // Every related node is shown (sceneLayout adds columns as needed).
    const related = f.related.filter((r) => !roles.has(r.id));
    related.forEach((r, index) => put(r, { type: 'related', index, count: related.length }));
  } else if (preview) {
    const tierIndex = {};
    preview.results.forEach((r, i) => {
      const index = tierIndex[r.tier] ?? 0;
      tierIndex[r.tier] = index + 1;
      put(r.node, { type: 'hit', tier: r.tier, index, primary: i === 0 });
    });
  }
  return { nodes: [...nodes.values()], roles };
}

export function KnowledgeScene() {
  const roots = useKnowledgeStore((s) => s.roots);
  const preview = useKnowledgeStore((s) => s.preview);
  const focus = useKnowledgeStore((s) => s.focus);
  const size = useThree((s) => s.size);
  const spawned = useRef(new Map());

  const { nodes, roles } = useMemo(() => buildScene(roots, preview, focus), [roots, preview, focus]);
  const layout = useMemo(
    () => computeLayout(size.width, size.height, focus?.children.length ?? 0),
    [size.width, size.height, focus]
  );
  useLayoutEffect(() => {
    sceneState.roles = roles;
    sceneState.layout = layout;
    for (const id of spawned.current.keys()) if (!roles.has(id)) spawned.current.delete(id);
  }, [roles, layout]);

  // Roots get fixed shell positions; any other node spawns where its parent
  // currently is (so satellites visibly come out of the focused node).
  const rootPositions = useMemo(() => {
    const rng = createRng(Math.floor(performance.timeOrigin + performance.now()) & 0xffffffff);
    const positions = generateShellPositions(roots.length, rng);
    return new Map(roots.map((n, i) => [n.id, positions[i]]));
  }, [roots]);
  const initialPosition = (node) => {
    if (rootPositions.has(node.id)) return rootPositions.get(node.id);
    if (!spawned.current.has(node.id)) {
      const from = sceneState.registry.get(node.parent_id)?.position ?? layout.center;
      spawned.current.set(node.id, from.toArray());
    }
    return spawned.current.get(node.id);
  };

  const clearColor = useMemo(() => new THREE.Color(COLORS.bg), []);
  useFrame((state, dt) => {
    const { gl, scene } = state;
    // Animated transparent text must start from a clean framebuffer each
    // frame, or old glyph pixels smear into a solid sheet.
    gl.autoClear = true;
    gl.setClearColor(clearColor, 1);
    scene.background = clearColor;
    gl.clear(true, true, true);

    const { hoveredNodeId, focus } = useKnowledgeStore.getState();
    if (sceneState.roles.get(hoveredNodeId)?.type !== 'child') sceneState.orbitAngle += dt * 0.16;
    // Push overlapping labels apart; runs before the keywords' own frames.
    declutter(state, !!focus);
    // Parts the camera has swung behind another fade (utils/depthFade.js).
    updateDepthFade(state, !!focus, dt);
  }, -1);

  return (
    <>
      {nodes.map((node) => (
        <KeywordNode
          key={node.id}
          node={node}
          initialPosition={initialPosition(node)}
        />
      ))}
      <SatelliteLinks color={COLORS.fg} />
      <RelatedHud linkColor={COLORS.dim} />
      <Suspense fallback={null}>
        <FocusContent layout={layout} />
      </Suspense>
    </>
  );
}
