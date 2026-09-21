/* The glTF rig: a realistic model, driven by the same director as the sculpt.
 *
 * Load a GLB at the configured path and this takes over. It does three jobs the
 * built-in sculpt does not need:
 *
 *   1. fit  - models arrive at wildly different scales and origins (a head-only
 *             bust, a full body in centimetres, a character standing at the
 *             origin). The model is measured and placed so the head lands in
 *             the portrait crop, rather than requiring the artist to author to
 *             our units.
 *   2. bind - canonical pose channels are matched to the model's blendshapes
 *             and bones by name (see morph-map.js).
 *   3. dress- materials are nudged toward the studio: environment intensity,
 *             shadow flags, and a wetter cornea where an eye mesh is found.
 *
 * Nothing here is model-specific. A different GLB at the same path works, as
 * long as it is a head-and-shoulders character; what it does not carry (no
 * blendshapes, no eye bones) simply goes unused.
 */

import {
  AnimationMixer,
  Box3,
  LoopRepeat,
  MathUtils,
  Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import { BASIS_PATH, DRACO_PATH, LIGHTS } from "../config.js";
import { clamp } from "../math.js";
import { bindBones, bindMorphs } from "../morph-map.js";

/* Where the head should end up, in the world the camera is already framing. */
const TARGET_HEAD_Y = 1.69;
/* Roughly the interocular distance of the built-in sculpt, used as the scale
 * reference when the model has eye bones - it is the most reliable measurement
 * a character carries. */
const TARGET_EYE_SPAN = 0.20;
const TARGET_HEAD_HEIGHT = 0.58;

let loader = null;

/** One loader for the session, with the decoders wired up once. */
function getLoader(renderer) {
  if (loader) return loader;
  loader = new GLTFLoader();

  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_PATH);
  loader.setDRACOLoader(draco);

  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath(BASIS_PATH);
  ktx2.detectSupport(renderer);
  loader.setKTX2Loader(ktx2);

  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** Is there really a model at this URL?
 *
 *  A plain `res.ok` is not enough: a dev server with an SPA fallback answers
 *  every unknown path with index.html and a cheerful 200, which the loader then
 *  tries to parse as glTF ("Unexpected token '<'"). Anything that comes back as
 *  HTML is a missing model, not a model. */
async function exists(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return false;
    const type = res.headers.get("content-type") || "";
    return !type.includes("text/html");
  } catch {
    return false;
  }
}

/** Scale and place the model so the head sits where the camera is looking. */
function fit(root, bones) {
  const override = typeof window !== "undefined" && window.AVATAR_MODEL_FIT;
  if (override) {
    root.scale.setScalar(override.scale ?? 1);
    root.position.set(override.x ?? 0, override.y ?? 0, override.z ?? 0);
    return { how: "override" };
  }

  root.updateWorldMatrix(true, true);
  let scale = 1;
  let how = "bounds";

  const eyeL = bones.eyeLeft;
  const eyeR = bones.eyeRight;
  if (eyeL && eyeR) {
    const span = eyeL.getWorldPosition(new Vector3())
      .distanceTo(eyeR.getWorldPosition(new Vector3()));
    if (span > 1e-5) {
      scale = TARGET_EYE_SPAN / span;
      how = "eye span";
    }
  } else if (bones.head) {
    // Head height: from the head joint to the top of everything above it.
    const box = new Box3().setFromObject(root);
    const headY = bones.head.getWorldPosition(new Vector3()).y;
    const height = box.max.y - headY;
    if (height > 1e-5) {
      scale = TARGET_HEAD_HEIGHT / height;
      how = "head bone";
    }
  } else {
    // No rig at all: assume the top quarter of the model is the head.
    const box = new Box3().setFromObject(root);
    const height = box.max.y - box.min.y;
    if (height > 1e-5) {
      scale = TARGET_HEAD_HEIGHT / (height * 0.25);
      how = "bounding box";
    }
  }

  root.scale.setScalar(scale);
  root.updateWorldMatrix(true, true);

  // Centre horizontally and drop the head onto the camera's target height.
  const box = new Box3().setFromObject(root);
  const centre = box.getCenter(new Vector3());
  const headY = bones.head
    ? bones.head.getWorldPosition(new Vector3()).y
    : box.max.y - TARGET_HEAD_HEIGHT * 0.5;

  root.position.x -= centre.x;
  root.position.z -= centre.z;
  root.position.y += TARGET_HEAD_Y - headY;
  return { how, scale };
}

/** Push the model's materials toward the studio look. */
function dress(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false;   // a morphing head can outgrow its bounding box

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if ("envMapIntensity" in m) m.envMapIntensity = LIGHTS.envIntensity;
      // Eyes read as plastic without a wet specular layer over the iris.
      const name = `${o.name} ${m.name}`.toLowerCase();
      if (/eye|cornea|iris/.test(name) && "clearcoat" in m) {
        m.clearcoat = 1;
        m.clearcoatRoughness = 0.06;
      }
      m.needsUpdate = true;
    }
  });
}

/**
 * Load the model. Resolves to a rig, or to null when there is no model at the
 * path - which is not an error, it is the signal to keep the built-in sculpt.
 */
export async function loadGltfRig({ url, renderer, onProgress }) {
  if (!(await exists(url))) return null;

  const gltf = await getLoader(renderer).loadAsync(url, (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  });

  const root = gltf.scene;
  const bones = bindBones(root);
  const morphs = bindMorphs(root);
  const placement = fit(root, bones);
  dress(root);

  /* -- animation clips, if the model brought any -- */
  const mixer = gltf.animations.length ? new AnimationMixer(root) : null;
  const clips = {};
  if (mixer) {
    for (const clip of gltf.animations) {
      const key = clip.name.toLowerCase();
      if (/idle|breath|rest/.test(key)) clips.idle = clip;
      else if (/talk|speak/.test(key)) clips.talk = clip;
    }
    // Something has to play, or a rigged model stands in its T-pose.
    const first = clips.idle || gltf.animations[0];
    if (first) {
      const action = mixer.clipAction(first);
      action.setLoop(LoopRepeat, Infinity);
      action.play();
      clips.playing = action;
    }
  }

  const eyeRest = {
    l: bones.eyeLeft?.quaternion.clone(),
    r: bones.eyeRight?.quaternion.clone(),
  };

  return {
    kind: "gltf",
    root,
    info: {
      placement,
      morphChannels: morphs.resolved,
      visemes: morphs.hasVisemes,
      bones: Object.keys(bones),
      clips: gltf.animations.map((c) => c.name),
    },

    apply(pose, dt) {
      if (mixer) mixer.update(dt);

      /* -- head and neck. Applied as an offset from the authored rest pose, so
         a model that holds its head at an angle keeps doing so. -- */
      if (bones.head) {
        const rest = bones.head.userData.restQuaternion;
        bones.head.quaternion.copy(rest);
        bones.head.rotateX(pose.headPitch * 0.7);
        bones.head.rotateY(pose.headYaw * 0.7);
        bones.head.rotateZ(pose.headRoll * 0.7);
      }
      if (bones.neck) {
        const rest = bones.neck.userData.restQuaternion;
        bones.neck.quaternion.copy(rest);
        bones.neck.rotateX(pose.headPitch * 0.3);
        bones.neck.rotateY(pose.headYaw * 0.3);
      }

      /* -- eyes: bones if the model has them, look-morphs if not -- */
      if (bones.eyeLeft && eyeRest.l) {
        bones.eyeLeft.quaternion.copy(eyeRest.l);
        bones.eyeLeft.rotateX(pose.gazeY * 0.5);
        bones.eyeLeft.rotateY(pose.gazeX * 0.6);
      }
      if (bones.eyeRight && eyeRest.r) {
        bones.eyeRight.quaternion.copy(eyeRest.r);
        bones.eyeRight.rotateX(pose.gazeY * 0.5);
        bones.eyeRight.rotateY(pose.gazeX * 0.6);
      }

      if (morphs.isEmpty) return;
      morphs.clear();

      /* -- mouth. Parametric channels first; Oculus visemes as well, for models
         that carry both - the accumulator keeps them from fighting. -- */
      const open = clamp(pose.jawOpen, 0, 1);
      if (!morphs.set("jawOpen", open) && bones.jaw) {
        const rest = bones.jaw.userData.restQuaternion;
        bones.jaw.quaternion.copy(rest);
        bones.jaw.rotateX(open * 0.42);
      }
      morphs.set("mouthSmileLeft", pose.mouthSmile);
      morphs.set("mouthSmileRight", pose.mouthSmile);
      morphs.set("mouthPucker", pose.mouthPucker);
      morphs.set("mouthStretchLeft", pose.mouthWide);
      morphs.set("mouthStretchRight", pose.mouthWide);
      morphs.set("mouthPressLeft", pose.lipBite);
      morphs.set("mouthPressRight", pose.lipBite);
      morphs.set("tongueOut", pose.tongue * 0.35);
      if (morphs.hasVisemes) morphs.setViseme(pose.viseme, clamp(pose.visemeAmp, 0, 1));

      /* -- eyes -- */
      morphs.set("eyeBlinkLeft", pose.blink);
      morphs.set("eyeBlinkRight", pose.blink);
      morphs.set("eyeSquintLeft", pose.squint);
      morphs.set("eyeSquintRight", pose.squint);
      morphs.set("cheekSquintLeft", pose.mouthSmile * 0.4);
      morphs.set("cheekSquintRight", pose.mouthSmile * 0.4);
      if (!bones.eyeLeft) {
        morphs.set("eyeLookUp", Math.max(0, -pose.gazeY) * 1.5);
        morphs.set("eyeLookDown", Math.max(0, pose.gazeY) * 1.5);
        morphs.set("eyeLookLeft", Math.max(0, -pose.gazeX) * 1.5);
        morphs.set("eyeLookRight", Math.max(0, pose.gazeX) * 1.5);
      }

      /* -- brows -- */
      const raise = clamp(pose.browRaise, 0, 1);
      const furrow = clamp(-pose.browRaise, 0, 1);
      morphs.set("browInnerUp", raise * (0.5 + pose.browTilt));
      morphs.set("browOuterUpLeft", raise);
      morphs.set("browOuterUpRight", raise);
      morphs.set("browDownLeft", furrow);
      morphs.set("browDownRight", furrow);

      morphs.commit();
    },

    dispose() {
      mixer?.stopAllAction();
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const key of Object.keys(m || {})) {
            const v = m[key];
            if (v && v.isTexture) v.dispose();
          }
          m?.dispose();
        }
      });
    },
  };
}

/** Free the shared loader's worker pools. Called when the stage is torn down. */
export function disposeLoader() {
  loader = null;
}

export { MathUtils };
