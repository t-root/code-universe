import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useKnowledgeStore } from '../../store/knowledgeStore.js';
import { damp } from '../../utils/animations.js';
import { FOCUS_CAMERA_RADIUS, IDLE_CAMERA_RADIUS, sceneState } from '../../utils/sceneLayout.js';
import { deviceQuaternion, pageTwist, toPage } from '../../utils/screenRotation.js';

const ORIGIN = new THREE.Vector3(0, 0, 0);
// How far from the origin the look-at point may go (world units): about the
// stretch the layout frames, so the scene can't be zoomed out of view.
const LOOK_X = 12;
const LOOK_Y = 8;
// Where the camera is headed (zoomAt measures what is under the pointer
// from there).
const ghost = new THREE.PerspectiveCamera();
const PICK = 70; // px: a label this near the pointer sets the depth zoomed about
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * Orbits the camera horizontally at eye level around a look-at point, the
 * origin unless zoomed in somewhere.
 *
 *   - Mouse / one-finger drag → rotate; wheel / pinch / vertical swipe → radius,
 *     zooming in and out about what is under the pointer (or between the
 *     fingers), which stays put on screen
 *   - Turning the device about the page's vertical axis → rotate, when the
 *     motion sensor is enabled
 *   - Idle → slow auto-rotation
 *   - Any new preview/focus layout → swing back to face +Z at the framing
 *     radius the 3D layout (sceneLayout.js) is computed for
 *
 * Pointer input over the focused node's 3D content is left to the content
 * (it scrolls its wheel).
 */
export function CameraController() {
  const { camera, gl } = useThree();
  const orbit = useRef({ radius: IDLE_CAMERA_RADIUS, theta: 0.4 });
  const dragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const lastPinchDistance = useRef(null);
  const sensor = useRef({
    available: false,
    active: false,
    quat: new THREE.Quaternion(),
    offset: new THREE.Quaternion(),
    // Set on switching on: the next reading becomes the centre pose.
    needsOffset: false,
    twist: 0,
    // Camera angle the centre pose looks from.
    base: 0,
  });
  // Where the camera looks: `goal` follows zooming at once, `at` eases to it
  // with the camera.
  const look = useRef({ at: new THREE.Vector3(), goal: new THREE.Vector3() });
  const autoRadius = useRef(0);
  const autoTheta = useRef(null);
  const lastRevision = useRef(-1);
  const lastMode = useRef('idle');

  useEffect(() => {
    const dom = gl.domElement;
    const overContent = () => useKnowledgeStore.getState().contentHover;
    const clampRadius = () => {
      orbit.current.radius = THREE.MathUtils.clamp(orbit.current.radius, 4, 36);
    };
    // Change the radius by `delta`, keeping the scene point under page point
    // (px, py) where it is on screen, in and out alike: the look-at point
    // moves toward (or away from) that point by the same factor as the
    // radius — the view scales about it. The look-at point stays within the
    // stretch the layout frames, so zooming out never loses the scene.
    const zoomAt = (delta, px, py) => {
      const o = orbit.current;
      const L = look.current;
      const from = o.radius;
      o.radius += delta;
      clampRadius();
      const to = o.radius;
      if (to === from) return;
      // Seen from where the camera is headed, not where it is on the way
      // (zooming again before it has settled would otherwise drift): the
      // point under the pointer, at the depth of the label it is on (the
      // nearest on screen within PICK px), else the focus's — scaling about
      // a point at another depth would slide that label off the pointer.
      ghost.copy(camera);
      ghost.position.set(L.goal.x + from * Math.cos(o.theta), L.goal.y, L.goal.z + from * Math.sin(o.theta));
      ghost.lookAt(L.goal);
      ghost.updateMatrixWorld();
      const nx = (px / dom.offsetWidth) * 2 - 1;
      const ny = 1 - (py / dom.offsetHeight) * 2;
      ghost.getWorldDirection(_fwd);
      let depth = null;
      let best = PICK * PICK;
      for (const g of sceneState.registry.values()) {
        if (!g.visible || (g.userData.opacity ?? 1) < 0.3) continue;
        _v.copy(g.position).project(ghost);
        if (_v.z > 1) continue;
        const dx = ((_v.x - nx) / 2) * dom.offsetWidth;
        const dy = ((_v.y - ny) / 2) * dom.offsetHeight;
        if (dx * dx + dy * dy < best) {
          best = dx * dx + dy * dy;
          depth = _v.subVectors(g.position, ghost.position).dot(_fwd);
        }
      }
      depth ??= _v.subVectors(sceneState.layout.center, ghost.position).dot(_fwd);
      _v.set(nx, ny, 0.5).unproject(ghost);
      _dir.subVectors(_v, ghost.position).normalize();
      const t = depth / Math.max(1e-4, _dir.dot(_fwd));
      const under = _v.copy(ghost.position).addScaledVector(_dir, t);
      L.goal.sub(under).multiplyScalar(to / from).add(under);
      L.goal.x = THREE.MathUtils.clamp(L.goal.x, -LOOK_X, LOOK_X);
      L.goal.y = THREE.MathUtils.clamp(L.goal.y, -LOOK_Y, LOOK_Y);
      L.goal.z = THREE.MathUtils.clamp(L.goal.z, -LOOK_X, LOOK_X);
    };

    // Mouse and wheel are listened for on window, i.e. after R3F's own
    // handlers have run — so the 3D content has already claimed the event
    // (contentHover) when the pointer is on it. Only canvas events count.
    const onDown = (e) => {
      if (e.target !== dom || e.pointerType === 'touch' || overContent()) return;
      dragging.current = true;
      lastPointer.current = toPage(e.clientX, e.clientY);
    };
    const onMove = (e) => {
      if (e.pointerType === 'touch' || !dragging.current || sensor.current.active) return;
      const p = toPage(e.clientX, e.clientY);
      orbit.current.theta += (p.x - lastPointer.current.x) * 0.005;
      lastPointer.current = p;
    };
    const onUp = (e) => {
      if (e.pointerType !== 'touch') dragging.current = false;
    };
    const onWheel = (e) => {
      if (e.target !== dom) return;
      e.preventDefault();
      if (overContent()) return;
      const p = toPage(e.clientX, e.clientY);
      zoomAt(e.deltaY * 0.012, p.x, p.y);
    };

    const touchDistance = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e) => {
      if (overContent()) {
        dragging.current = false;
        return;
      }
      if (e.touches.length === 2) {
        dragging.current = false;
        lastPinchDistance.current = touchDistance(e.touches);
      } else if (e.touches.length === 1) {
        dragging.current = true;
        lastPinchDistance.current = null;
        lastPointer.current = toPage(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const onTouchMove = (e) => {
      e.preventDefault();
      if (overContent()) return;
      if (e.touches.length === 2) {
        const distance = touchDistance(e.touches);
        if (lastPinchDistance.current !== null) {
          const mid = toPage(
            (e.touches[0].clientX + e.touches[1].clientX) / 2,
            (e.touches[0].clientY + e.touches[1].clientY) / 2
          );
          zoomAt(-(distance - lastPinchDistance.current) * 0.012, mid.x, mid.y);
        }
        lastPinchDistance.current = distance;
        return;
      }
      if (!dragging.current || e.touches.length !== 1) return;
      const p = toPage(e.touches[0].clientX, e.touches[0].clientY);
      const dx = p.x - lastPointer.current.x;
      const dy = p.y - lastPointer.current.y;
      lastPointer.current = p;
      // Horizontal swipe rotates; vertical swipe zooms (down = closer).
      if (!sensor.current.active) orbit.current.theta -= dx * 0.005;
      orbit.current.radius -= dy * 0.018;
      clampRadius();
    };
    const onTouchEnd = (e) => {
      if (e.touches.length === 1) {
        dragging.current = true;
        lastPinchDistance.current = null;
        lastPointer.current = toPage(e.touches[0].clientX, e.touches[0].clientY);
      } else {
        dragging.current = false;
        lastPinchDistance.current = null;
      }
    };

    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('touchstart', onTouchStart, { passive: false });
    dom.addEventListener('touchmove', onTouchMove, { passive: false });
    dom.addEventListener('touchend', onTouchEnd, { passive: true });
    dom.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('wheel', onWheel);
      dom.removeEventListener('touchstart', onTouchStart);
      dom.removeEventListener('touchmove', onTouchMove);
      dom.removeEventListener('touchend', onTouchEnd);
      dom.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [gl]);

  // Device orientation: only turning about the page's vertical axis (the
  // phone's long side held upright, its short side held sideways) steers the
  // camera. The pose the sensor was switched on in is the centre: held
  // there, the camera stays where it was looking; turned away, it swings by
  // twice the turn. The centre pose is the first reading after switching on
  // (on iOS no readings arrive before permission is granted).
  useEffect(() => {
    const s = sensor.current;
    s.available = 'DeviceOrientationEvent' in window;
    const onOrientation = (e) => {
      deviceQuaternion(s.quat, e);
      if (s.needsOffset) {
        s.offset.copy(s.quat);
        s.needsOffset = false;
      }
      s.twist = pageTwist(s.offset, s.quat);
    };
    const onToggle = (e) => {
      s.active = Boolean(e.detail?.enabled);
      if (s.active) {
        s.needsOffset = true;
        s.twist = 0;
        s.base = orbit.current.theta;
        autoTheta.current = null;
      }
    };
    window.addEventListener('deviceorientation', onOrientation, true);
    window.addEventListener('code-universe:sensor', onToggle);
    return () => {
      window.removeEventListener('deviceorientation', onOrientation, true);
      window.removeEventListener('code-universe:sensor', onToggle);
    };
  }, []);

  useFrame((_, dt) => {
    const { mode, layoutRevision } = useKnowledgeStore.getState();
    const o = orbit.current;
    const s = sensor.current;

    if (mode !== 'idle' && layoutRevision !== lastRevision.current) {
      autoRadius.current = FOCUS_CAMERA_RADIUS;
      look.current.goal.copy(ORIGIN);
      if (s.active && s.available) {
        // Steering: the centre pose now looks head-on (the nearest turn to
        // the old centre), so the camera swings there with the device.
        s.base = Math.PI / 2 + Math.round((s.base - Math.PI / 2) / (Math.PI * 2)) * Math.PI * 2;
      } else {
        autoTheta.current = Math.PI / 2;
      }
    }
    if (mode === 'idle' && lastMode.current !== 'idle') {
      autoRadius.current = IDLE_CAMERA_RADIUS;
      look.current.goal.copy(ORIGIN);
      autoTheta.current = null;
    }
    lastRevision.current = layoutRevision;
    lastMode.current = mode;

    if (s.active && s.available) {
      o.theta = damp(o.theta, s.base - s.twist * 2.0, 5, dt);
    } else if (mode === 'idle' && !dragging.current) {
      o.theta += dt * 0.04;
    }

    if (autoTheta.current !== null) {
      let diff = autoTheta.current - o.theta;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      o.theta = damp(o.theta, o.theta + diff, 2.5, dt);
      if (Math.abs(diff) < 0.02) autoTheta.current = null;
    }
    if (autoRadius.current > 0) {
      o.radius = damp(o.radius, autoRadius.current, 2.2, dt);
      if (Math.abs(o.radius - autoRadius.current) < 0.05) autoRadius.current = 0;
    }

    const L = look.current;
    L.at.x = damp(L.at.x, L.goal.x, 2.5, dt);
    L.at.y = damp(L.at.y, L.goal.y, 2.5, dt);
    L.at.z = damp(L.at.z, L.goal.z, 2.5, dt);
    camera.position.x = damp(camera.position.x, L.goal.x + o.radius * Math.cos(o.theta), 2.5, dt);
    camera.position.y = damp(camera.position.y, L.goal.y, 2.5, dt);
    camera.position.z = damp(camera.position.z, L.goal.z + o.radius * Math.sin(o.theta), 2.5, dt);
    camera.lookAt(L.at);
    // Settled before anything else this frame (priority -2), matrices
    // included: traces that start at a label's text (utils/circuit.js,
    // titleSide) are measured along the camera's axes and must use the
    // camera this frame is drawn with, or they trail it off the text.
    camera.updateMatrixWorld();
  }, -2);

  return null;
}
