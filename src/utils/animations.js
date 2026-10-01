import { Vector3 } from 'three';

const _float = new Vector3();

/**
 * Layered slow drift around an anchor — never still, never repeating.
 */
export function floatingOffset(time, phase, ampX = 0.6, ampY = 0.6, ampZ = 0.45) {
  const slow = 0.18;
  const med = 0.41;
  const fast = 0.77;
  return _float.set(
    (Math.sin(time * slow + phase) +
      Math.sin(time * med + phase * 1.7) * 0.45 +
      Math.sin(time * fast + phase * 0.3) * 0.18) * ampX,
    (Math.cos(time * slow * 0.9 + phase * 1.3) +
      Math.cos(time * med + phase * 0.6) * 0.5 +
      Math.sin(time * fast * 1.1 + phase * 2.1) * 0.18) * ampY,
    (Math.sin(time * slow * 0.8 + phase * 0.7) +
      Math.cos(time * med + phase * 1.4) * 0.45 +
      Math.sin(time * fast + phase * 0.4) * 0.18) * ampZ
  );
}

const _wander = new Vector3();
function seededUnit(seed) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * Travels smoothly between seeded random 3D waypoints.
 */
export function wanderingOffset(time, seed, ampX = 1, ampY = 1, ampZ = 1) {
  const segmentDuration = 2.2 + seededUnit(seed * 3.1) * 1.7;
  const segment = Math.floor(time / segmentDuration);
  const progress = time / segmentDuration - segment;
  const t = progress * progress * (3 - 2 * progress);
  const point = (step, axis) => seededUnit(seed * 19.19 + step * 17.71 + axis * 53.17) * 2 - 1;
  return _wander.set(
    (point(segment, 0) + (point(segment + 1, 0) - point(segment, 0)) * t) * ampX,
    (point(segment, 1) + (point(segment + 1, 1) - point(segment, 1)) * t) * ampY,
    (point(segment, 2) + (point(segment + 1, 2) - point(segment, 2)) * t) * ampZ
  );
}

export function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

// Hits per ring of the medium tier before the next ring opens.
const MEDIUM_LAYER = 10;

/**
 * Offset of a search-result keyword inside its cluster (the cluster itself
 * is moved around by the caller). 'center' is the top match, straight in
 * front of the camera; 'near' and 'medium' rings layer behind it.
 */
export function clusterTarget(tier, indexInTier, seed = 0) {
  if (tier === 'center') return new Vector3(0, 0, 4.8);
  // Start off to the side so the first runner-up isn't hidden right behind
  // the top match.
  const theta = -Math.PI / 2 + 1.2 + ((seed * 0.071) % 0.28) + indexInTier * Math.PI * (3 - Math.sqrt(5));
  const near = tier === 'near';
  // The medium tier has no size limit: every MEDIUM_LAYER hits it opens a
  // further ring, wider and further back, so a long result list spreads out
  // instead of piling up.
  const layer = near ? 0 : Math.floor(indexInTier / MEDIUM_LAYER);
  const radius = near ? 3.1 + (indexInTier % 3) * 0.42 : 5.9 + layer * 1.6 + (indexInTier % 3) * 0.45;
  const yJitter = near ? 0.6 : 1.1 + layer * 0.3;
  const y = (((indexInTier * 0.83) % 1) - 0.5) * yJitter * 1.4;
  const z = (near ? 2.3 : 0.4 - layer * 1.4) + Math.sin(indexInTier * 2.17 + seed) * 0.18;
  return new Vector3(Math.cos(theta) * radius, y, z);
}

/**
 * A quadratic Bezier arc from `from` to `to`, lifted in the middle so the
 * flight looks physical rather than a straight slide.
 */
export function createFlight(from, to, { delay = 0, duration = 0.9, arcHeight = 1.4 } = {}) {
  const start = from.clone();
  const end = to.clone();
  const ctrl = new Vector3().addVectors(start, end).multiplyScalar(0.5);
  const span = new Vector3().subVectors(end, start);
  const dist = span.length();
  const lifted = arcHeight * Math.min(1.5, 0.4 + dist / 14);
  if (Math.abs(span.y) / Math.max(0.001, dist) < 0.85) {
    ctrl.y += lifted;
  } else {
    ctrl.x += lifted * 0.6;
    ctrl.z += lifted * 0.6;
  }
  return {
    // The caller may keep moving `end` while in flight (a label that
    // re-centres once measured), so it lands where it should be now.
    end,
    delay,
    duration: Math.max(0.15, duration),
    startTime: 0,
    hasStarted: false,
    pointAt(out, t) {
      const u = 1 - t;
      return out
        .set(0, 0, 0)
        .addScaledVector(start, u * u)
        .addScaledVector(ctrl, 2 * u * t)
        .addScaledVector(end, t * t);
    },
  };
}
