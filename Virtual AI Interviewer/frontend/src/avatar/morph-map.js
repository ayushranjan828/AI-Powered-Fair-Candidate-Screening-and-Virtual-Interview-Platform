/* The mapping layer between the director's canonical pose and whatever a model
 * happens to call its blendshapes.
 *
 * Models disagree about names. ARKit says `jawOpen` and `eyeBlinkLeft`; Ready
 * Player Me adds Oculus visemes (`viseme_aa`); Mixamo and one-off sculpts say
 * `mouthOpen` or `Blink_L` or `blinkLeft`. Rather than demand one convention,
 * every canonical channel lists the spellings it answers to, and names are
 * compared with punctuation and case stripped - so `Eye_Blink_L`, `eyeBlinkL`
 * and `EYEBLINKLEFT` all land on the same channel.
 *
 * Nothing here is required: a model that resolves none of these still animates,
 * it just falls back to bone rotation and the head-level motion.
 */

/** Canonical channel -> the names models use for it, best match first. */
export const CHANNELS = {
  jawOpen: ["jawOpen", "mouthOpen", "jaw_open", "JawOpen", "Jaw", "openMouth", "AA"],
  mouthSmileLeft: ["mouthSmileLeft", "mouthSmile_L", "mouthSmileL", "smileLeft", "mouthSmile"],
  mouthSmileRight: ["mouthSmileRight", "mouthSmile_R", "mouthSmileR", "smileRight", "mouthSmile"],
  mouthPucker: ["mouthPucker", "mouthFunnel", "pucker", "viseme_U", "OO"],
  mouthStretchLeft: ["mouthStretchLeft", "mouthStretch_L", "mouthStretchL", "mouthWide", "stretchLeft"],
  mouthStretchRight: ["mouthStretchRight", "mouthStretch_R", "mouthStretchR", "mouthWide", "stretchRight"],
  mouthPressLeft: ["mouthPressLeft", "mouthPress_L", "mouthPressL", "mouthClose"],
  mouthPressRight: ["mouthPressRight", "mouthPress_R", "mouthPressR", "mouthClose"],
  mouthLowerDown: ["mouthLowerDownLeft", "mouthLowerDown_L", "mouthLowerDown"],
  tongueOut: ["tongueOut", "tongue_out", "TongueOut", "tongue"],

  eyeBlinkLeft: ["eyeBlinkLeft", "eyeBlink_L", "eyeBlinkL", "blinkLeft", "blink_L", "Blink_Left", "eyesClosed"],
  eyeBlinkRight: ["eyeBlinkRight", "eyeBlink_R", "eyeBlinkR", "blinkRight", "blink_R", "Blink_Right", "eyesClosed"],
  eyeSquintLeft: ["eyeSquintLeft", "eyeSquint_L", "eyeSquintL", "squintLeft"],
  eyeSquintRight: ["eyeSquintRight", "eyeSquint_R", "eyeSquintR", "squintRight"],
  eyeLookUp: ["eyeLookUpLeft", "eyeLookUp_L", "eyeLookUp"],
  eyeLookDown: ["eyeLookDownLeft", "eyeLookDown_L", "eyeLookDown"],
  eyeLookLeft: ["eyeLookOutLeft", "eyeLookLeft", "eyeLookOut_L"],
  eyeLookRight: ["eyeLookOutRight", "eyeLookRight", "eyeLookOut_R"],

  browInnerUp: ["browInnerUp", "browsInnerUp", "browInnerUpLeft", "browRaiseInner"],
  browOuterUpLeft: ["browOuterUpLeft", "browOuterUp_L", "browOuterUpL", "browUpLeft", "browsUp"],
  browOuterUpRight: ["browOuterUpRight", "browOuterUp_R", "browOuterUpR", "browUpRight", "browsUp"],
  browDownLeft: ["browDownLeft", "browDown_L", "browDownL", "browsDown", "browFurrow"],
  browDownRight: ["browDownRight", "browDown_R", "browDownR", "browsDown", "browFurrow"],

  cheekSquintLeft: ["cheekSquintLeft", "cheekSquint_L", "cheekRaiseLeft"],
  cheekSquintRight: ["cheekSquintRight", "cheekSquint_R", "cheekRaiseRight"],
};

/** Our viseme names -> Oculus/Ready-Player-Me `viseme_*` blendshapes, for
 *  models that ship those instead of (or as well as) parametric channels. */
export const OVR_VISEMES = {
  rest: "viseme_sil",
  AA: "viseme_aa",
  AE: "viseme_aa",
  EE: "viseme_E",
  IH: "viseme_I",
  OH: "viseme_O",
  OO: "viseme_U",
  UH: "viseme_aa",
  MBP: "viseme_PP",
  FV: "viseme_FF",
  TH: "viseme_TH",
  L: "viseme_nn",
  SZ: "viseme_SS",
  R: "viseme_RR",
  KG: "viseme_kk",
  NDT: "viseme_DD",
  W: "viseme_U",
};

const normalise = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Walk a loaded model and index every morph target it exposes.
 *
 * Returns a writer with `set(channel, value)` / `commit()`. One canonical
 * channel can drive several meshes at once (a head and a separate tongue mesh
 * both carrying `jawOpen`, say), which is why each entry is a list.
 */
export function bindMorphs(root) {
  /** normalised morph name -> [{ mesh, index }] */
  const byName = new Map();
  const meshes = [];

  root.traverse((o) => {
    if (!o.isMesh || !o.morphTargetDictionary) return;
    meshes.push(o);
    for (const [name, index] of Object.entries(o.morphTargetDictionary)) {
      const key = normalise(name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push({ mesh: o, index });
    }
  });

  /** canonical channel -> targets, resolved once at load. */
  const channels = new Map();
  for (const [channel, aliases] of Object.entries(CHANNELS)) {
    for (const alias of aliases) {
      const hit = byName.get(normalise(alias));
      if (hit) {
        channels.set(channel, hit);
        break;
      }
    }
  }

  const visemeTargets = new Map();
  for (const [name, blend] of Object.entries(OVR_VISEMES)) {
    const hit = byName.get(normalise(blend));
    if (hit) visemeTargets.set(name, hit);
  }

  // Influences are accumulated into a scratch buffer per mesh and written once
  // per frame: two channels can share a blendshape (`eyesClosed` standing in
  // for both eyes), and the last writer must not silently win.
  const scratch = new Map();
  for (const mesh of meshes) scratch.set(mesh, new Float32Array(mesh.morphTargetInfluences.length));

  return {
    /** Which canonical channels this model actually understands. */
    resolved: [...channels.keys()],
    hasVisemes: visemeTargets.size > 0,
    isEmpty: channels.size === 0 && visemeTargets.size === 0,

    clear() {
      for (const buf of scratch.values()) buf.fill(0);
    },

    set(channel, value) {
      const targets = channels.get(channel);
      if (!targets) return false;
      for (const { mesh, index } of targets) {
        const buf = scratch.get(mesh);
        if (value > buf[index]) buf[index] = value;
      }
      return true;
    },

    setViseme(name, value) {
      const targets = visemeTargets.get(name) || visemeTargets.get("rest");
      if (!targets) return false;
      for (const { mesh, index } of targets) {
        const buf = scratch.get(mesh);
        if (value > buf[index]) buf[index] = value;
      }
      return true;
    },

    commit() {
      for (const mesh of meshes) {
        const buf = scratch.get(mesh);
        const inf = mesh.morphTargetInfluences;
        for (let i = 0; i < inf.length; i++) inf[i] = buf[i];
      }
    },
  };
}

/** Bone name patterns, for models rigged rather than blendshaped. */
const BONE_PATTERNS = {
  head: [/^head$/, /head(?!top|_end)/, /mixamorig.*head/],
  neck: [/^neck$/, /neck/],
  eyeLeft: [/lefteye/, /eye_?l$/, /eyel$/, /eye\.l/],
  eyeRight: [/righteye/, /eye_?r$/, /eyer$/, /eye\.r/],
  spine: [/^spine$/, /spine1/, /chest/],
  jaw: [/^jaw$/, /jaw(?!_end)/],
};

/** Find the head/neck/eye/jaw bones by name, whatever the rig calls them. */
export function bindBones(root) {
  const found = {};
  root.traverse((o) => {
    if (!o.isBone && !o.isObject3D) return;
    const name = normalise(o.name);
    if (!name) return;
    for (const [slot, patterns] of Object.entries(BONE_PATTERNS)) {
      if (found[slot]) continue;
      if (patterns.some((re) => re.test(name))) found[slot] = o;
    }
  });
  // Remember each bone's authored rotation: the pose is applied as an offset
  // from the model's own rest pose, never as an absolute.
  for (const bone of Object.values(found)) {
    bone.userData.restQuaternion = bone.quaternion.clone();
  }
  return found;
}
