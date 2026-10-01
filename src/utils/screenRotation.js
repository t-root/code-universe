import * as THREE from 'three';

// There is one layout and it is landscape: whatever the device, the longer
// side of the screen runs across. A screen taller than it is wide (a phone
// held upright, a tall window) gets it laid on its side: App turns .app a
// quarter turn clockwise (ui.css, .app.is-rotated), so the top of the page
// runs along the screen's right edge and it is read turned sideways. Canvas sizes and R3F's offsetX/Y are already in the
// page's own frame; pointer clientX/Y and bounding rects are still in the
// screen's, and go through the helpers below. Phones that allow it go full
// screen, locked landscape, on the first tap instead (startFullscreenLandscape).
const ROTATE_QUERY = '(orientation: portrait)';

let rotated = false;

// Calls onChange(rotated) now and whenever the screen turns (or a window is
// resized past square); returns a stop function.
export function watchRotation(onChange) {
  const mq = window.matchMedia(ROTATE_QUERY);
  const update = () => {
    rotated = mq.matches;
    onChange(rotated);
  };
  update();
  mq.addEventListener('change', update);
  return () => mq.removeEventListener('change', update);
}

// A screen point (clientX/Y) in page coordinates.
export function toPage(x, y) {
  return rotated ? { x: y, y: window.innerWidth - x } : { x, y };
}

// An element's bounding box in page coordinates: centre and half-size.
export function pageRect(el) {
  const b = el.getBoundingClientRect();
  const c = toPage((b.left + b.right) / 2, (b.top + b.bottom) / 2);
  return rotated
    ? { cx: c.x, cy: c.y, hw: b.height / 2, hh: b.width / 2 }
    : { cx: c.x, cy: c.y, hw: b.width / 2, hh: b.height / 2 };
}

// How far the device has turned about the page's vertical axis since
// `from` (a quaternion from deviceQuaternion), in radians. Swing-twist:
// only the twist about that axis counts, so it holds however the phone is
// held (upright, sideways, or turned by the CSS rotation).
const euler = new THREE.Euler();
const rel = new THREE.Quaternion();
const axis = new THREE.Vector3();
export function deviceQuaternion(out, e) {
  const d = Math.PI / 180;
  // DeviceOrientation's Z-X'-Y' angles in a y-up frame (as three.js'
  // DeviceOrientationControls): device x -> x, device y -> -z, device z -> y.
  euler.set((e.beta ?? 0) * d, (e.alpha ?? 0) * d, -(e.gamma ?? 0) * d, 'YXZ');
  return out.setFromEuler(euler);
}
export function pageTwist(from, current) {
  // Page "up" in device axes: the screen's rotation plus ours.
  const screenAngle = window.screen?.orientation?.angle ?? window.orientation ?? 0;
  const a = ((screenAngle + (rotated ? 90 : 0)) * Math.PI) / 180;
  axis.set(Math.sin(a), 0, -Math.cos(a));
  rel.copy(from).invert().multiply(current);
  const along = rel.x * axis.x + rel.y * axis.y + rel.z * axis.z;
  let angle = 2 * Math.atan2(along, rel.w);
  if (angle > Math.PI) angle -= Math.PI * 2;
  if (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

// Phones: a tap puts the page in full screen locked landscape, so the
// browser itself is sideways and the on-screen keyboard comes up sideways
// too (the CSS quarter turn then no longer applies). Leaving full screen
// unlocks it; the next tap goes back in. Where either isn't allowed —
// iPhone Safari has neither — the CSS quarter turn stands in.
export function startFullscreenLandscape() {
  const phone =
    window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 760;
  const el = document.documentElement;
  const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (!phone || !request) return () => {};
  const onTap = async (e) => {
    if (e.pointerType === 'mouse' || document.fullscreenElement || document.webkitFullscreenElement) return;
    try {
      await request.call(el, { navigationUI: 'hide' });
      await screen.orientation?.lock?.('landscape');
    } catch {
      // Not allowed here: stay as is.
    }
  };
  // pointerup (not pointerdown) is what counts as a user gesture for touch.
  window.addEventListener('pointerup', onTap, true);
  return () => window.removeEventListener('pointerup', onTap, true);
}
