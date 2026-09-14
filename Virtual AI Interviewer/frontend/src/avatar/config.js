/* Everything tunable about the avatar, in one place.
 *
 * The model URL is the important one: drop a GLB at the path below and the
 * application picks it up on the next load with no code change. Nothing else
 * in the app names a model file.
 */

// Vite serves public/ at the base path: "/" in dev, "/static/" in the build
// that FastAPI serves. Resolving against BASE_URL keeps one URL correct in both.
const base = import.meta.env.BASE_URL || "/";

/** Where the realistic model is expected. Override at runtime by setting
 *  `window.AVATAR_MODEL_URL` before the bundle loads (useful for A/B testing a
 *  model without a rebuild). */
export const MODEL_URL =
  (typeof window !== "undefined" && window.AVATAR_MODEL_URL) ||
  `${base}models/realistic-monkey.glb`;

/** Decoder binaries for compressed GLBs, copied out of the three package. */
export const DRACO_PATH = `${base}vendor/draco/`;
export const BASIS_PATH = `${base}vendor/basis/`;

/** Portrait framing. A long lens (~85mm equivalent) keeps the face free of the
 *  wide-angle bulge a 30-degree field of view gives at this distance. */
export const CAMERA = {
  fov: 20,
  near: 0.1,
  far: 60,
  position: [0, 1.52, 5.62],
  target: [0, 1.42, 0],
  // Narrow containers get a slightly wider field so the head is never cropped.
  minAspect: 0.78,
};

/** Low-key studio lighting, in the spirit of a corporate headshot. */
export const LIGHTS = {
  exposure: 0.95,
  hemisphere: { sky: 0x6d7f84, ground: 0x120f0d, intensity: 0.38 },
  key: { color: 0xfff1e0, intensity: 3.0, position: [-2.1, 2.9, 2.6] },
  fill: { color: 0x7d99b4, intensity: 0.45, position: [3.0, 0.4, 1.8] },
  rim: { color: 0xbcd2cc, intensity: 1.6, position: [-1.7, 1.6, -2.4] },
  catchlight: { color: 0xffffff, intensity: 0.9, distance: 8, position: [0.25, 1.75, 2.4] },
  envIntensity: 0.55,
};

/** The dark cinematic backdrop. */
export const BACKDROP = { top: 0x1f2b27, bottom: 0x080c0b };

/** Cap the device pixel ratio: a 3x phone screen triples the fragment cost for
 *  no visible gain on a 420px portrait. */
export const MAX_PIXEL_RATIO = 2;
