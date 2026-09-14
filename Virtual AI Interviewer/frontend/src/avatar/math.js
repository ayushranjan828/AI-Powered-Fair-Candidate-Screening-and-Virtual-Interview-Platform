/* Small numeric helpers shared by the director and the rigs. */

export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent exponential smoothing: `k` is roughly "fraction of
 *  the way there per 60th of a second". Every animated value goes through this,
 *  which is why a state change reads as movement rather than a cut. */
export function ease(cur, target, k, dt) {
  return cur + (target - cur) * (1 - Math.pow(1 - k, dt * 60));
}

/** Smoothstep between two edges - the workhorse for shading masks. */
export function sstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** A smooth blob centred on a direction, used to sculpt the procedural head:
 *  1 at the centre of the cone, falling to 0 at angular width `w`. */
export function bump(dx, dy, dz, cx, cy, cz, w) {
  const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const d = (dx * cx + dy * cy + dz * cz) / len;
  const k = (d - (1 - w)) / w;
  if (k <= 0) return 0;
  const t = k > 1 ? 1 : k;
  return t * t * (3 - 2 * t);
}

/** A bump stretched sideways: xs < 1 widens it across the face, which is how a
 *  brow becomes one bar instead of two knuckles. */
export function bumpWide(x, y, z, cx, cy, cz, w, xs) {
  const sx = x * xs;
  const len = Math.sqrt(sx * sx + y * y + z * z);
  return bump(sx / len, y / len, z / len, cx, cy, cz, w);
}
