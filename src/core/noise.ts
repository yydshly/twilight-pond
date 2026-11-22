/**
 * Lightweight deterministic hash, 2D value noise, fBm, and organic random distributions.
 * Used across pond SDF, procedural PBR textures, wind gusts, and non-repetitive duck behavior.
 */

export function hash2D(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

export function valueNoise2D(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const a = hash2D(ix, iy);
  const b = hash2D(ix + 1, iy);
  const c = hash2D(ix, iy + 1);
  const d = hash2D(ix + 1, iy + 1);

  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

export function fbm2D(x: number, y: number, octaves = 4): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise2D(x * frequency, y * frequency);
    norm += amplitude;
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return value / norm;
}

/**
 * Produces organic, right-skewed wait durations (never rigid fixed intervals).
 */
export function organicDuration(minSeconds: number, maxSeconds: number): number {
  // Multiply two uniform samples to bias gently toward shorter/medium pauses with occasional long lingering waits
  const u = (Math.random() + Math.random() * Math.random()) * 0.5;
  return lerp(minSeconds, maxSeconds, clamp(u, 0, 1));
}
