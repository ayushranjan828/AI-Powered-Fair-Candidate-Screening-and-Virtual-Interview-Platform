/* The avatar backend, assembled.
 *
 *   Avatar (this file - the public API the React app already calls)
 *     |- scene.js      renderer, portrait camera, studio lighting, backdrop
 *     |- director.js   states, emotions, visemes, blinking, gaze, gestures
 *     |- rigs/gltf.js  a realistic GLB, if one is present
 *     `- rigs/procedural.js  the built-in sculpt, otherwise
 *
 * Importing this module installs it as `window.Avatar`, taking over from the
 * 2D SVG rig that the classic script installed before the bundle loaded. The
 * React side (src/lib/legacy.js) resolves `window.Avatar` on every call, so the
 * handover mid-session is invisible - and so is handing control back if WebGL
 * dies under us.
 *
 * The public surface has not changed since the SVG rig:
 *   mount(el) setState(s) setEmotion(e) setViseme(v, i) stopSpeaking()
 *   pulse(level) nod(n) isReady()
 */

import { MODEL_URL } from "./config.js";
import { createDirector, VISEMES } from "./director.js";
import { clamp } from "./math.js";
import { createScene } from "./scene.js";
import { createProceduralRig } from "./rigs/procedural.js";
import { loadGltfRig } from "./rigs/gltf.js";

const reduceMotion =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const S = {
  stage: null,        // { renderer, scene, camera, canvas, setSize, dispose }
  rig: null,
  director: createDirector({ reduceMotion }),
  container: null,
  raf: null,
  last: 0,
  visible: true,
  docVisible: true,
  built: false,
  failed: false,
  ro: null,
  io: null,
  modelTried: false,
};

function webglAvailable() {
  try {
    const cv = document.createElement("canvas");
    return Boolean(cv.getContext("webgl2") || cv.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Hand the session back to the SVG rig rather than leaving a dead canvas. */
function fallBackTo2D(reason, err) {
  if (err) console.warn(`Avatar: ${reason}, using the 2D rig`, err);
  stopLoop();
  S.failed = true;
  if (window.Avatar2D && S.container) {
    window.Avatar = window.Avatar2D;
    try {
      window.Avatar2D.mount(S.container);
    } catch {
      /* nothing left to try */
    }
  }
}

function swapRig(next) {
  if (!next || !S.stage) return;
  if (S.rig) {
    S.stage.scene.remove(S.rig.root);
    S.rig.dispose();
  }
  S.rig = next;
  S.stage.scene.add(next.root);
}

/** Look for the configured model. Absent is the normal case, not an error. */
async function tryLoadModel() {
  if (S.modelTried || !S.stage) return;
  S.modelTried = true;
  try {
    const rig = await loadGltfRig({ url: MODEL_URL, renderer: S.stage.renderer });
    if (!rig) {
      console.info(
        `Avatar: no model at ${MODEL_URL} - using the built-in sculpt. ` +
          "Drop a GLB there to switch to it.",
      );
      return;
    }
    swapRig(rig);
    console.info("Avatar: loaded", MODEL_URL, rig.info);
  } catch (err) {
    // A broken model must not take the interview down with it.
    console.warn("Avatar: model failed to load, keeping the built-in sculpt", err);
  }
}

function frame(now) {
  S.raf = requestAnimationFrame(frame);
  const t = now / 1000;
  let dt = S.last ? t - S.last : 0.016;
  S.last = t;
  // A backgrounded tab returns a huge dt; clamping stops the rig snapping.
  dt = clamp(dt, 0.001, 0.05);
  if (!S.visible || !S.docVisible || !S.stage || !S.rig) return;

  const pose = S.director.update(dt);
  S.rig.apply(pose, dt);
  S.stage.renderer.render(S.stage.scene, S.stage.camera);
}

function startLoop() {
  if (S.raf) return;
  S.last = 0;
  S.raf = requestAnimationFrame(frame);
}

function stopLoop() {
  if (S.raf) cancelAnimationFrame(S.raf);
  S.raf = null;
}

function resize() {
  if (!S.stage || !S.container) return;
  const w = S.container.clientWidth || 320;
  const h = S.container.clientHeight || Math.round((w * 440) / 420);
  S.stage.setSize(w, h);
}

/** Don't burn a GPU on a rig nobody is looking at. */
function watch(container) {
  S.io?.disconnect();
  if (window.IntersectionObserver) {
    S.io = new IntersectionObserver(
      (entries) => {
        S.visible = entries.some((e) => e.isIntersecting);
      },
      { threshold: 0.01 },
    );
    S.io.observe(container);
  }
  S.ro?.disconnect();
  if (window.ResizeObserver) {
    S.ro = new ResizeObserver(resize);
    S.ro.observe(container);
  } else {
    window.addEventListener("resize", resize);
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    S.docVisible = !document.hidden;
  });
}

const Avatar3D = {
  supported: webglAvailable,

  mount(container) {
    if (!container) return this;
    S.container = container;
    try {
      if (!S.built) {
        container.innerHTML = "";
        S.stage = createScene(container);
        S.stage.canvas.addEventListener(
          "webglcontextlost",
          (event) => {
            event.preventDefault();
            fallBackTo2D("WebGL context lost");
          },
          false,
        );
        swapRig(createProceduralRig());
        S.built = true;
        // The model load is deliberately not awaited: the sculpt is on screen
        // immediately and the GLB takes over whenever it arrives.
        tryLoadModel();
      } else if (S.stage.canvas.parentNode !== container) {
        // The candidate flow mounts twice - welcome card, then the interview
        // stage. Move the one canvas rather than building a second scene.
        container.innerHTML = "";
        container.appendChild(S.stage.canvas);
      }
    } catch (err) {
      fallBackTo2D("could not build the 3D stage", err);
      return window.Avatar === this ? this : window.Avatar;
    }
    watch(container);
    resize();
    S.visible = true;
    startLoop();
    return this;
  },

  /** Posture: idle | listening | noting | speaking | thinking | greeting. */
  setState(state) {
    S.director.setState(state);
    return this;
  },

  /** Expression: neutral | friendly | curious | encouraging | thinking. */
  setEmotion(emotion) {
    S.director.setEmotion(emotion);
    return this;
  },

  /** Push a mouth shape. Called many times a second by speech.js. */
  setViseme(name, intensity = 1) {
    S.director.setViseme(name, intensity);
    return this;
  },

  /** Stop lip-sync and let the mouth close. */
  stopSpeaking() {
    S.director.stopSpeaking();
    return this;
  },

  /** Candidate live mic level, 0-1. Drives nodding along to sustained speech. */
  pulse(level) {
    S.director.pulse(level);
    return this;
  },

  /** One acknowledging nod. */
  nod(times = 1) {
    S.director.nod(times);
    return this;
  },

  /** True when the rig is mounted - the app checks before driving it. */
  isReady() {
    return S.built && !S.failed;
  },

  visemeNames() {
    return Object.keys(VISEMES);
  },

  /** Which rig is on screen, and what the loader made of the model. Handy from
   *  the console when a model does not look the way it did in Blender. */
  describe() {
    return { rig: S.rig?.kind ?? null, model: MODEL_URL, info: S.rig?.info ?? null };
  },

  dispose() {
    stopLoop();
    S.io?.disconnect();
    S.ro?.disconnect();
    S.rig?.dispose();
    S.stage?.dispose();
    S.rig = null;
    S.stage = null;
    S.built = false;
  },
};

/* Install over the 2D rig where WebGL allows, keeping the SVG version reachable
 * as Avatar2D. Both expose the same methods and the app looks `Avatar` up on
 * every call, so falling back mid-session is seamless. */
if (typeof window !== "undefined" && Avatar3D.supported()) {
  window.Avatar2D = window.Avatar;
  window.Avatar = Avatar3D;
  window.Avatar3D = Avatar3D;
}

export default Avatar3D;
