/**
 * Seeded pseudo-random number generator (Mulberry32).
 */
export function createRng(seed = 1337) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const SHELLS = [
  { r: 10.0, yJitter: 0.45 },
  { r: 16.0, yJitter: 0.75 },
  { r: 23.0, yJitter: 1.1 },
];

/**
 * Idle positions for `count` keywords: round-robin across three shells so
 * each gets an even share, golden-angle spiral within a shell, plus a
 * little jitter so nothing lines up. Never inside the camera's radius.
 */
export function generateShellPositions(count, rng) {
  const perShell = [0, 0, 0];
  const positions = [];
  for (let index = 0; index < count; index++) {
    const shellIdx = index % 3;
    const shell = SHELLS[shellIdx];
    const localIndex = perShell[shellIdx]++;
    const shellTotal = Math.ceil((count - shellIdx) / 3);
    const yUnit = 1 - ((localIndex + 0.5) / shellTotal) * 2;
    const horizontal = Math.sqrt(Math.max(0, 1 - yUnit * yUnit));
    const theta = localIndex * GOLDEN_ANGLE + shellIdx * 1.71 + rng() * 0.18;
    const radius = shell.r + (rng() - 0.5) * 1.4;
    positions.push([
      Math.cos(theta) * horizontal * radius,
      yUnit * radius + (rng() - 0.5) * shell.yJitter,
      Math.sin(theta) * horizontal * radius,
    ]);
  }
  return positions;
}
