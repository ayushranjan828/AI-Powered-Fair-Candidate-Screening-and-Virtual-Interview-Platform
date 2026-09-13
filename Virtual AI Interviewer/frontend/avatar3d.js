/* The 3D interviewer - a monkey in a suit, built and animated with three.js.
 *
 * This stands in for the 2D SVG rig (avatar.js) and keeps exactly the same
 * public surface, so app.js and candidate.js drive it without knowing which one
 * is running:
 *
 *   Avatar.mount(el) .setState(s) .setEmotion(e) .setViseme(v, i)
 *         .stopSpeaking() .pulse(level) .nod(n) .isReady()
 *
 * Nothing here is a downloaded model or a baked animation clip. The character
 * is assembled from primitives at runtime and every joint is a number
 * recomputed each frame, which is what lets the mouth follow real speech and
 * the hands answer the candidate's voice instead of looping canned motion.
 *
 * Three things move the rig, same as the 2D one:
 *   1. procedural life - breathing, blinking, saccades, weight shifts, an ear
 *      twitch. Always running, so the figure is never frozen.
 *   2. state + emotion - posture and expression, set by the app per turn.
 *   3. visemes - jaw, lips and tongue pushed in by speech.js during speech.
 *
 * Every value is eased toward a target rather than assigned, so a state change
 * reads as movement rather than a cut. If WebGL is missing or the context is
 * lost we hand control back to the 2D rig rather than leaving an empty box.
 */
window.Avatar3D = (function () {
  "use strict";

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false;
  const TAU = Math.PI * 2;
  // Lips are half-tori squashed this hard vertically - a full-height arc reads
  // as a ring drawn on the muzzle rather than a mouth.
  const LIP_FLAT = 0.40;
  const HALF_PI = Math.PI / 2;

  /* ------------------------------------------------------------- palette
   * Warm grey-brown fur, a lighter face, charcoal suit on a dark studio
   * backdrop - lit like a headshot rather than a cartoon.
   */
  const C = {
    furDark:   0x232220,
    fur:       0x302f2b,
    furLight:  0x46433c,
    skin:      0xa8958c,
    skinDeep:  0x7d6c66,
    skinLight: 0xbaa69d,
    eyeWhite:  0xcfc6b4,
    iris:      0xb08430,
    irisDark:  0x6b4a17,
    pupil:     0x0a0807,
    suit:      0x3a3f46,
    suitDark:  0x2b2f35,
    shirt:     0xd5d9dc,
    tie:       0x2a2f35,
    lip:       0x74615b,
    mouth:     0x24100f,
    tongue:    0x8f5555,
    tooth:     0xdcd6c8,
    bgTop:     0x1f2b27,
    bgBottom:  0x080c0b,
  };

  /* --------------------------------------------------------------- visemes
   * Mouth *parameters*, not poses - the jaw, lips, tongue and teeth are driven
   * from these numbers each frame, so any two shapes blend on the way past.
   *   open  jaw drop        wide  lip stretch       round  lip pucker
   *   tongue / teeth / bite  visible detail
   */
  const VISEMES = {
    rest: { open: 0.04, wide: 0.00, round: 0.00 },
    AA:   { open: 0.92, wide: 0.22, round: 0.00 },
    AE:   { open: 0.66, wide: 0.46, round: 0.00 },
    EE:   { open: 0.28, wide: 0.90, round: 0.00, teeth: 0.7 },
    IH:   { open: 0.34, wide: 0.48, round: 0.00 },
    OH:   { open: 0.62, wide: 0.00, round: 0.55 },
    OO:   { open: 0.24, wide: 0.00, round: 0.95 },
    UH:   { open: 0.46, wide: 0.18, round: 0.10 },
    MBP:  { open: 0.00, wide: 0.10, round: 0.05 },
    FV:   { open: 0.12, wide: 0.36, round: 0.00, bite: 1 },
    TH:   { open: 0.22, wide: 0.40, round: 0.00, tongue: 1 },
    L:    { open: 0.40, wide: 0.28, round: 0.00, tongue: 0.9 },
    SZ:   { open: 0.14, wide: 0.62, round: 0.08, teeth: 1 },
    R:    { open: 0.30, wide: 0.14, round: 0.42 },
    KG:   { open: 0.36, wide: 0.30, round: 0.00 },
    NDT:  { open: 0.26, wide: 0.36, round: 0.00, tongue: 0.5 },
    W:    { open: 0.22, wide: 0.00, round: 0.92 },
  };

  /* ---------------------------------------------------------------- poses
   * Joint targets per state, in radians, with the sign conventions the rig
   * applies below:
   *   shPitch  + swings the arm forward and up      elbow  + bends
   *   shRoll   + takes the elbow away from the body wrist  + flexes the hand
   *   shYaw    - turns the forearm across the chest
   *
   * The crop is a portrait, so a hand only reads once it comes up into shot.
   * At rest the hands hang below the bottom edge, exactly as they would on a
   * real video call; the gesturing poses fold the elbow to bring one hand up in
   * front of the chest. Each was solved backwards from where the hand should
   * land on screen for this 0.56 + 0.66 arm, under the constraint that the
   * elbow stays outside the jacket - without the yaw term the forearm can only
   * reach across the body by driving the elbow through the chest.
   */
  const POSES = {
    idle: {
      lean: 0.00, headPitch: 0.00, headYaw: 0.00,
      shPitchL: 0.06, shYawL: 0.00, shRollL: 0.16, elbowL: 0.55, wristL: 0.00,
      shPitchR: 0.06, shYawR: 0.00, shRollR: 0.16, elbowR: 0.55, wristR: 0.00,
    },
    listening: {
      lean: 0.06, headPitch: 0.02, headYaw: 0.00,
      shPitchL: 0.10, shYawL: 0.00, shRollL: 0.15, elbowL: 0.72, wristL: 0.00,
      shPitchR: 0.10, shYawR: 0.00, shRollR: 0.15, elbowR: 0.72, wristR: 0.00,
    },
    // Head down toward a pad, writing hand busy just inside the frame.
    noting: {
      lean: 0.08, headPitch: 0.17, headYaw: -0.09,
      shPitchL: 0.12, shYawL: 0.00, shRollL: 0.14, elbowL: 0.78, wristL: 0.00,
      shPitchR: 0.18, shYawR: -0.24, shRollR: -0.31, elbowR: 1.94, wristR: 0.30,
    },
    // One hand up and open - beat gestures ride on top of this.
    speaking: {
      lean: 0.02, headPitch: -0.02, headYaw: 0.00,
      shPitchL: 0.08, shYawL: 0.00, shRollL: 0.15, elbowL: 0.62, wristL: 0.00,
      shPitchR: 0.64, shYawR: -0.25, shRollR: -0.28, elbowR: 2.02, wristR: 0.22,
    },
    // Hand to the chin. What somebody actually does while thinking.
    thinking: {
      lean: 0.03, headPitch: 0.06, headYaw: 0.10,
      shPitchL: 0.08, shYawL: 0.00, shRollL: 0.14, elbowL: 0.64, wristL: 0.00,
      shPitchR: 0.96, shYawR: -0.42, shRollR: -0.35, elbowR: 1.91, wristR: 0.34,
    },
    // A small raised-palm hello.
    greeting: {
      lean: 0.05, headPitch: -0.06, headYaw: 0.00,
      shPitchL: 0.08, shYawL: 0.00, shRollL: 0.15, elbowL: 0.62, wristL: 0.00,
      shPitchR: 1.23, shYawR: -0.12, shRollR: -0.13, elbowR: 2.04, wristR: -0.10,
    },
  };

  const POSE_KEYS = [
    "lean", "headPitch", "headYaw",
    "shPitchL", "shYawL", "shRollL", "elbowL", "wristL",
    "shPitchR", "shYawR", "shRollR", "elbowR", "wristR",
  ];

  /* Expression per emotion: brow height/angle, lid openness, smile, squint. */
  const EMOTIONS = {
    neutral:     { brow: 0.00, browTilt: 0.00, lid: 1.00, smile: 0.12, squint: 0.00 },
    friendly:    { brow: 0.30, browTilt: 0.00, lid: 0.96, smile: 0.62, squint: 0.14 },
    curious:     { brow: 0.62, browTilt: -0.20, lid: 1.08, smile: 0.24, squint: 0.00 },
    encouraging: { brow: 0.40, browTilt: 0.00, lid: 0.98, smile: 0.50, squint: 0.10 },
    thinking:    { brow: -0.32, browTilt: 0.26, lid: 0.84, smile: 0.04, squint: 0.26 },
  };

  /* ------------------------------------------------------------------ state */
  const S = {
    renderer: null, scene: null, camera: null, canvas: null,
    container: null, R: null, raf: null, t: 0, built: false, failed: false,
    visible: true, docVisible: true,
    state: "idle", emotion: "neutral",
    c: {}, g: {},                                    // current / goal values
    blink: { next: 1.8, closing: 0, phase: 0 },
    gaze: { next: 2.2, x: 0, y: 0 },
    ear: { next: 4, t: 0, side: 1 },
    nodQueue: 0, nodT: 0,
    speaking: false, level: 0, levelSmooth: 0, energySmooth: 0,
    gestureT: 0, gestureIdx: 0, notePen: 0, wave: 0,
    ro: null, io: null,
  };

  // Everything that gets eased: mouth, expression, posture, gaze.
  const REST = {
    open: 0.04, wide: 0, round: 0, tongue: 0, teeth: 0, bite: 0,
    brow: 0, browTilt: 0, lid: 1, smile: 0.12, squint: 0,
    gazeX: 0, gazeY: 0, headTilt: 0,
  };
  for (const key of POSE_KEYS) REST[key] = POSES.idle[key];
  S.c = Object.assign({}, REST);
  S.g = Object.assign({}, REST);

  /* ----------------------------------------------------------------- helpers */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  // Frame-rate independent exponential smoothing: `k` is roughly "fraction of
  // the way there per 60th of a second".
  function ease(cur, target, k, dt) {
    return cur + (target - cur) * (1 - Math.pow(1 - k, dt * 60));
  }

  function supported() {
    if (!window.THREE) return false;
    try {
      const cv = document.createElement("canvas");
      return Boolean(cv.getContext("webgl2") || cv.getContext("webgl"));
    } catch (err) {
      return false;
    }
  }

  /* --------------------------------------------------------------- materials */
  /** Painted fur: a few thousand fine strokes in varying greys, used as the
   *  colour map *and* the bump map. This is what stops a sphere of flat brown
   *  reading as moulded plastic - real fur is grizzled, never one tone. */
  function furTexture(THREE, base, spread, strokes, repeat) {
    const size = 512;
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#" + base.toString(16).padStart(6, "0");
    ctx.fillRect(0, 0, size, size);
    const r = (base >> 16) & 255, g = (base >> 8) & 255, b = base & 255;
    ctx.lineWidth = 1.1;
    ctx.lineCap = "round";
    for (let i = 0; i < strokes; i++) {
      // Lighter tips and darker roots in roughly equal measure, so the coat
      // reads as many hairs rather than as noise.
      const k = (Math.random() - 0.45) * spread;
      ctx.strokeStyle = "rgba(" + clamp(r + k, 0, 255).toFixed(0) + "," +
        clamp(g + k, 0, 255).toFixed(0) + "," + clamp(b + k * 0.92, 0, 255).toFixed(0) + ",0.62)";
      const x = Math.random() * size;
      const y = Math.random() * size;
      const len = 5 + Math.random() * 11;
      const lean = (Math.random() - 0.5) * 0.7;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + lean * len, y + len);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat * 0.7);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Mottled skin: blotches and fine creases, for the bare face and ears. */
  function skinTexture(THREE, base, repeat) {
    const size = 256;
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#" + base.toString(16).padStart(6, "0");
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 900; i++) {
      const k = (Math.random() - 0.5) * 34;
      ctx.fillStyle = "rgba(" + (128 + k).toFixed(0) + "," + (120 + k).toFixed(0) +
        "," + (116 + k).toFixed(0) + ",0.10)";
      ctx.beginPath();
      ctx.arc(Math.random() * size, Math.random() * size, 2 + Math.random() * 9, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(60,48,44,0.10)";
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * size, y = Math.random() * size;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 22, y + (Math.random() - 0.5) * 6);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Flat grey noise, used as a bump map on cloth - cheaper than a painted
   *  texture where all that is wanted is a surface that is not perfectly flat. */
  function noiseTexture(THREE, size, contrast, repeat) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const n = clamp(128 + (Math.random() - 0.5) * 255 * contrast, 0, 255);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = n;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    return tex;
  }

  /** The studio backdrop: a vertical gradient with a pool of light behind the
   *  shoulders, painted into a texture rather than lit for real. */
  function backdropTexture(THREE) {
    const cv = document.createElement("canvas");
    cv.width = 8; cv.height = 512;
    const ctx = cv.getContext("2d");
    const hex = (n) => "#" + n.toString(16).padStart(6, "0");
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0.00, hex(C.bgBottom));
    grad.addColorStop(0.40, hex(C.bgTop));
    grad.addColorStop(1.00, hex(C.bgBottom));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 8, 512);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ------------------------------------------------------------------ skull
   * The head is one sculpted surface, not a pile of spheres. Stacking
   * primitives is what made earlier versions read as a toy: every join showed
   * as a crease or a bulge. Instead a sphere is displaced by a handful of
   * directional bumps - muzzle, brow ridge, eye sockets, cheeks, chin - and
   * shaded with vertex colours that fade from fur into bare skin, so the face
   * is continuous the way an actual head is.
   *
   * `headShape` is the single source of truth for that surface: the geometry
   * is built from it, and every feature that has to sit ON the face (eyes,
   * nostrils, mouth, ears) is positioned with it too.
   */
  function bump(dx, dy, dz, cx, cy, cz, w) {
    const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const d = (dx * cx + dy * cy + dz * cz) / len;
    const k = (d - (1 - w)) / w;
    if (k <= 0) return 0;
    const t = k > 1 ? 1 : k;
    return t * t * (3 - 2 * t);
  }

  /** Smoothstep between two edges - the workhorse for shading masks. */
  function sstep(a, b, v) {
    const t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** Radius and skin-vs-fur mix for a direction on the unit sphere. */
  function headShape(x, y, z) {
    const muzzle = bump(x, y, z, 0, -0.40, 0.92, 0.42);
    const brow = bump(x, y, z, -0.32, 0.33, 0.89, 0.26) + bump(x, y, z, 0.32, 0.33, 0.89, 0.26);
    const socket = bump(x, y, z, -0.34, 0.13, 0.93, 0.17) + bump(x, y, z, 0.34, 0.13, 0.93, 0.17);
    const cheek = bump(x, y, z, -0.62, -0.30, 0.72, 0.38) + bump(x, y, z, 0.62, -0.30, 0.72, 0.38);
    const chin = bump(x, y, z, 0, -0.80, 0.58, 0.30);
    const crown = bump(x, y, z, 0, 1, 0.05, 0.45);
    const nape = bump(x, y, z, 0, -0.55, -0.82, 0.45);

    let r = 1;
    r += muzzle * 0.330;          // the snout, which a sphere alone never has
    r += brow * 0.055;            // heavy ridge over each eye
    r -= socket * 0.055;          // eyes sit in a hollow, not on the surface
    r += cheek * 0.048;
    r += chin * 0.030;
    r -= crown * 0.055;           // the cranium is an egg, not a ball
    r -= nape * 0.040;

    // Bare skin over the brow, the eyes and the whole muzzle; fur everywhere
    // else, with a soft border rather than a painted line.
    // Bare skin is a band, not a cone: a radial patch cannot tell the brow
    // from the forehead, and every version that used one ended up bald. The
    // band runs from just above the eyes down to the jaw, closes in at the
    // temples, and only applies to the front of the head - with the snout
    // added separately so it stays bare all the way round its tip.
    const band = sstep(-0.76, -0.50, y) * (1 - sstep(0.16, 0.44, y));
    const sides = 1 - sstep(0.26, 0.56, Math.abs(x));
    const front = sstep(0.40, 0.66, z);
    const snout = bump(x, y, z, 0, -0.42, 0.90, 0.34);
    const skin = Math.min(1, band * sides * front * 1.30 + snout * 1.15);
    return { r: r, skin: skin };
  }

  /** Where a direction lands on the finished head, in head-local space. */
  const HEAD_SCALE = { x: 0.455, y: 0.505, z: 0.485 };
  function headPoint(x, y, z, out) {
    const len = Math.sqrt(x * x + y * y + z * z);
    x /= len; y /= len; z /= len;
    const r = headShape(x, y, z).r;
    out = out || {};
    out.x = x * r * HEAD_SCALE.x;
    out.y = y * r * HEAD_SCALE.y;
    out.z = z * r * HEAD_SCALE.z;
    return out;
  }

  /** Build the skull mesh: displace a sphere, colour it, re-normal it. */
  function skullGeometry(THREE, furColor, skinColor) {
    const geo = new THREE.SphereGeometry(1, 96, 72);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const fur = new THREE.Color(furColor);
    const skin = new THREE.Color(skinColor);
    const p = {};
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const shape = headShape(x, y, z);
      headPoint(x, y, z, p);
      pos.setXYZ(i, p.x, p.y, p.z);
      // Fur darkens over the crown and lightens on the cheeks, which is what
      // stops a single flat brown from reading as paint.
      const shade = 0.78 + 0.28 * (1 - Math.max(0, y));
      const t = shape.skin;
      colors[i * 3] = fur.r * shade * (1 - t) + skin.r * t;
      colors[i * 3 + 1] = fur.g * shade * (1 - t) + skin.g * t;
      colors[i * 3 + 2] = fur.b * shade * (1 - t) + skin.b * t;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return geo;
  }

  /* ------------------------------------------------------------ the character
   * Built once into a tree of named groups. `R` below is the handle the frame
   * loop writes to; nothing outside this function knows the geometry.
   */
  function buildCharacter(THREE, scene) {
    const R = {};
    const coatMap = furTexture(THREE, 0xffffff, 150, 14000, 3);
    const furMap = furTexture(THREE, C.fur, 118, 3500, 3);
    const furDarkMap = furTexture(THREE, C.furDark, 104, 3500, 3);
    const skinMap = skinTexture(THREE, C.skin, 2);
    const skinLightMap = skinTexture(THREE, C.skinLight, 2);
    const clothBump = noiseTexture(THREE, 128, 0.30, 20);

    const M = {
      hide:      new THREE.MeshStandardMaterial({ vertexColors: true, map: coatMap, bumpMap: coatMap, bumpScale: 1.6, roughness: 0.88, metalness: 0 }),
      face:      new THREE.MeshStandardMaterial({ color: C.skin, map: coatMap, bumpMap: coatMap, bumpScale: 0.5, roughness: 0.70, metalness: 0 }),
      fur:       new THREE.MeshStandardMaterial({ map: furMap, bumpMap: furMap, bumpScale: 2.2, roughness: 0.98, metalness: 0 }),
      furDark:   new THREE.MeshStandardMaterial({ map: furDarkMap, bumpMap: furDarkMap, bumpScale: 2.6, roughness: 0.99, metalness: 0 }),
      furLight:  new THREE.MeshStandardMaterial({ color: C.furLight, map: furMap, bumpMap: furMap, bumpScale: 1.8, roughness: 0.97, metalness: 0 }),
      skin:      new THREE.MeshStandardMaterial({ map: skinMap, bumpMap: skinMap, bumpScale: 0.8, roughness: 0.66, metalness: 0 }),
      skinDeep:  new THREE.MeshStandardMaterial({ color: C.skinDeep, map: skinMap, bumpMap: skinMap, bumpScale: 0.7, roughness: 0.70, metalness: 0 }),
      skinLight: new THREE.MeshStandardMaterial({ map: skinLightMap, bumpMap: skinLightMap, bumpScale: 0.7, roughness: 0.60, metalness: 0 }),
      suit:      new THREE.MeshStandardMaterial({ color: C.suit, roughness: 0.92, metalness: 0.02, bumpMap: clothBump, bumpScale: 0.4 }),
      suitDark:  new THREE.MeshStandardMaterial({ color: C.suitDark, roughness: 0.90, metalness: 0.02, bumpMap: clothBump, bumpScale: 0.4 }),
      shirt:     new THREE.MeshStandardMaterial({ color: C.shirt, roughness: 0.72, metalness: 0 }),
      tie:       new THREE.MeshStandardMaterial({ color: C.tie, roughness: 0.46, metalness: 0.10 }),
      eyeWhite:  new THREE.MeshStandardMaterial({ color: C.eyeWhite, roughness: 0.20, metalness: 0 }),
      iris:      new THREE.MeshStandardMaterial({ color: C.iris, roughness: 0.24, metalness: 0.12 }),
      irisDark:  new THREE.MeshStandardMaterial({ color: C.irisDark, roughness: 0.30, metalness: 0 }),
      pupil:     new THREE.MeshStandardMaterial({ color: C.pupil, roughness: 0.18, metalness: 0 }),
      glint:     new THREE.MeshBasicMaterial({ color: 0xfdfbf4 }),
      lip:       new THREE.MeshStandardMaterial({ color: C.lip, roughness: 0.58, metalness: 0 }),
      mouth:     new THREE.MeshStandardMaterial({ color: C.mouth, roughness: 1, metalness: 0 }),
      tongue:    new THREE.MeshStandardMaterial({ color: C.tongue, roughness: 0.6, metalness: 0, transparent: true, opacity: 0 }),
      tooth:     new THREE.MeshStandardMaterial({ color: C.tooth, roughness: 0.34, metalness: 0, transparent: true, opacity: 0 }),
    };
    R.M = M;

    const add = (parent, geo, material, pos, scale) => {
      const mesh = new THREE.Mesh(geo, material);
      if (pos) mesh.position.set(pos[0], pos[1], pos[2]);
      if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
      parent.add(mesh);
      return mesh;
    };
    const group = (parent, x, y, z) => {
      const g = new THREE.Group();
      g.position.set(x || 0, y || 0, z || 0);
      parent.add(g);
      return g;
    };

    /* -- root: everything the body does (sway, lean, breathe) hangs off this -- */
    const root = group(scene, 0, 0, 0);
    R.root = root;

    /* ---------------------------------------------------------------- torso */
    const torso = group(root, 0, 0, 0);
    R.torso = torso;

    // The jacket is a spun profile: waist, chest, then a shoulder that slopes
    // into the neck instead of stopping dead. Flattened in z, because a chest
    // is not a barrel.
    const jacketProfile = [
      [0.50, 0.00], [0.53, 0.25], [0.555, 0.50], [0.585, 0.72], [0.625, 0.88],
      [0.672, 0.99], [0.700, 1.06], [0.690, 1.11], [0.600, 1.16], [0.440, 1.20],
      [0.300, 1.225], [0.205, 1.235],
    ].map((p) => new THREE.Vector2(p[0], p[1]));
    const jacket = add(torso, new THREE.LatheGeometry(jacketProfile, 56), M.suit);
    jacket.scale.set(1, 1, 0.74);
    for (const side of [-1, 1]) {
      add(torso, new THREE.SphereGeometry(0.19, 26, 20), M.suit,
        [side * 0.615, 1.045, 0], [1, 0.92, 0.84]);
    }

    // Neck, long enough that the jaw clears the collar.
    add(torso, new THREE.CylinderGeometry(0.205, 0.265, 0.36, 26), M.fur, [0, 1.28, 0.01]);

    /* ---- shirt, lapels and tie -------------------------------------------
     * All three are flat shapes extruded and laid on the chest. Boxes stood in
     * for them before and read as taped-on rectangles; a lapel is a shape with
     * a peak, and that peak is most of what says "suit".
     */
    const extrude = (points, depth) => {
      const shape = new THREE.Shape();
      shape.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
      shape.closePath();
      return new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: false });
    };

    // Shirt: a V of white between the lapels.
    const shirt = add(torso, extrude([[-0.180, 0.255], [0.180, 0.255], [0, -0.280]], 0.03),
      M.shirt, [0, 0.950, 0.452]);
    shirt.rotation.x = -0.12;

    // Peak lapels: mirrored, angled off the chest.
    for (const side of [-1, 1]) {
      const lapel = add(torso, extrude([
        [0.015, 0.255], [0.205, 0.175], [0.245, 0.020], [0.130, -0.275], [0.020, -0.095],
      ], 0.035), M.suitDark, [side * 0.055, 0.945, 0.462]);
      lapel.scale.x = side;
      lapel.rotation.set(-0.12, side * 0.16, 0);
    }

    // Tie: knot, then a blade that tapers under the jacket.
    const knot = add(torso, new THREE.BoxGeometry(0.098, 0.092, 0.07), M.tie, [0, 1.055, 0.495]);
    knot.rotation.x = -0.16;
    const blade = add(torso, new THREE.CylinderGeometry(0.058, 0.092, 0.42, 4), M.tie,
      [0, 0.800, 0.470], [1, 1, 0.40]);
    blade.rotation.set(-0.07, Math.PI / 4, 0);

    /* ----------------------------------------------------------------- arms */
    const buildArm = (side) => {
      const arm = {};
      arm.shoulder = group(torso, side * 0.630, 1.035, 0);
      add(arm.shoulder, new THREE.CapsuleGeometry(0.14, 0.28, 6, 18), M.suit, [0, -0.28, 0]);

      arm.elbow = group(arm.shoulder, 0, -0.56, 0);
      add(arm.elbow, new THREE.CapsuleGeometry(0.128, 0.26, 6, 18), M.suit, [0, -0.255, 0]);
      // Cuff: a sliver of shirt at the wrist, the detail that sells a suit.
      add(arm.elbow, new THREE.CylinderGeometry(0.108, 0.104, 0.05, 20), M.shirt, [0, -0.49, 0]);

      arm.wrist = group(arm.elbow, 0, -0.52, 0);
      const hand = group(arm.wrist, 0, 0, 0);
      arm.hand = hand;
      add(hand, new THREE.SphereGeometry(1, 20, 16), M.skinDeep, [0, -0.10, 0], [0.115, 0.135, 0.062]);
      // Four fingers and a thumb, curled slightly - an open but relaxed hand.
      for (let i = 0; i < 4; i++) {
        const finger = add(hand, new THREE.CapsuleGeometry(0.026, 0.085, 4, 10), M.skinDeep,
          [(i - 1.5) * 0.055, -0.235, 0.004]);
        finger.rotation.x = -0.22 - i * 0.03;
      }
      const thumb = add(hand, new THREE.CapsuleGeometry(0.029, 0.055, 4, 10), M.skinDeep,
        [side * -0.105, -0.145, 0.03]);
      thumb.rotation.set(-0.4, 0, side * 0.85);
      return arm;
    };
    R.armL = buildArm(-1);
    R.armR = buildArm(1);

    /* ----------------------------------------------------------------- head
     * One sculpted skull (see headShape) carrying the features. Everything
     * that must sit on the face is placed through headPoint, so a change to
     * the sculpt moves the eyes and nostrils with it instead of leaving them
     * floating or buried.
     */
    const head = group(root, 0, 1.690, 0.02);
    head.scale.setScalar(0.88);
    R.head = head;
    add(head, skullGeometry(THREE, C.fur, C.skin), M.hide);

    const on = (x, y, z, out, push) => {
      const p = headPoint(x, y, z, out);
      if (push) {
        const len = Math.sqrt(x * x + y * y + z * z);
        p.x += (x / len) * push; p.y += (y / len) * push; p.z += (z / len) * push;
      }
      return [p.x, p.y, p.z];
    };

    // Brow hair: sparse, lying along the ridge rather than painted on as bars.
    R.brow = [-1, 1].map((side) => {
      const g = group(head, 0, 0, 0);
      const seat = on(side * 0.33, 0.36, 0.87, {}, -0.005);
      g.position.set(seat[0], seat[1], seat[2]);
      const hair = add(g, new THREE.CapsuleGeometry(0.017, 0.105, 5, 12), M.furDark);
      hair.rotation.set(0.34, side * -0.18, HALF_PI + side * 0.22);
      g.userData.side = side;
      g.userData.baseY = seat[1];
      return g;
    });

    // Nostrils, set into the end of the snout.
    for (const side of [-1, 1]) {
      const nostril = add(head, new THREE.SphereGeometry(0.021, 14, 12), M.mouth,
        on(side * 0.115, -0.26, 0.96, {}, -0.006), [0.9, 0.6, 0.8]);
      nostril.rotation.z = side * 0.55;
    }
    // Cheeks ride up on a smile; they sit just proud of the sculpted cheek.
    R.cheek = [-1, 1].map((side) => {
      const c = add(head, new THREE.SphereGeometry(0.085, 20, 16), M.face,
        on(side * 0.50, -0.30, 0.80, {}, -0.062), [1, 0.85, 0.5]);
      c.userData.base = c.position.y;
      return c;
    });

    /* ------------------------------------------------------------------ ears
     * Large, thin and bare, with a raised rim and a dark hollow, turned most of
     * the way toward the camera - edge-on they would vanish, and they are half
     * of why the reference reads as a monkey at a glance.
     */
    R.ear = [-1, 1].map((side) => {
      const seat = on(side * 0.99, 0.02, 0.04, {}, -0.015);
      const g = group(head, seat[0], seat[1], seat[2]);
      g.rotation.set(0.05, -side * 0.70, side * 0.14);
      add(g, new THREE.SphereGeometry(0.200, 26, 20), M.skin, [0, 0, 0], [0.13, 1, 0.92]);
      const rim = add(g, new THREE.TorusGeometry(0.182, 0.020, 10, 30), M.skin, [side * 0.008, 0, 0]);
      rim.rotation.y = HALF_PI;
      rim.scale.set(0.88, 1, 1);
      add(g, new THREE.SphereGeometry(0.112, 20, 16), M.skinDeep,
        [side * -0.028, -0.012, 0.02], [0.10, 0.80, 0.66]);
      add(g, new THREE.SphereGeometry(0.175, 22, 18), M.fur,
        [side * -0.075, -0.02, -0.04], [0.26, 0.80, 0.70]);
      g.userData.side = side;
      return g;
    });

    /* ------------------------------------------------------------------ eyes
     * Amber iris, deep in the socket the sculpt already carved. Two hemisphere
     * shells make the lids: a shell at rotation.x = 0 covers the top of the
     * ball (a naturally lidded eye) and tipping it forward is a blink.
     */
    R.eye = [-1, 1].map((side) => {
      const seat = on(side * 0.34, 0.13, 0.93, {}, -0.040);
      const socket = group(head, seat[0], seat[1], seat[2]);
      const e = {};
      e.ball = group(socket, 0, 0, 0);
      add(e.ball, new THREE.SphereGeometry(0.085, 30, 24), M.eyeWhite);
      add(e.ball, new THREE.SphereGeometry(0.057, 26, 20), M.irisDark, [0, 0, 0.058], [1, 1, 0.62]);
      add(e.ball, new THREE.SphereGeometry(0.052, 26, 20), M.iris, [0, 0, 0.064], [1, 1, 0.60]);
      add(e.ball, new THREE.SphereGeometry(0.024, 18, 14), M.pupil, [0, 0, 0.078], [1, 1, 0.5]);
      add(e.ball, new THREE.SphereGeometry(0.007, 10, 8), M.glint, [0.026, 0.030, 0.084], [1, 1, 0.6]);

      e.upper = add(socket, new THREE.SphereGeometry(0.091, 26, 14, 0, TAU, 0, HALF_PI), M.face);
      e.lower = add(socket, new THREE.SphereGeometry(0.091, 26, 14, 0, TAU, HALF_PI, HALF_PI), M.face);
      e.side = side;
      return e;
    });

    /* ----------------------------------------------------------------- mouth
     * Upper lip, cavity and teeth belong to the head; the lower lip, tongue and
     * chin belong to the jaw, which hinges about a pivot behind the muzzle.
     */
    const lipSeat = on(0, -0.52, 0.85, {}, 0.004);
    const mouth = group(head, lipSeat[0], lipSeat[1], lipSeat[2]);
    R.mouth = mouth;
    R.cavity = add(mouth, new THREE.SphereGeometry(0.105, 20, 16), M.mouth, [0, 0, -0.03], [1, 0.10, 0.3]);

    R.upperLip = add(mouth, new THREE.TorusGeometry(0.105, 0.015, 8, 26, Math.PI), M.lip);
    R.upperLip.scale.set(1, LIP_FLAT, 1);
    R.teeth = add(mouth, new THREE.BoxGeometry(0.14, 0.022, 0.03), M.tooth, [0, 0.008, 0.012]);

    const jaw = group(head, 0, -0.16, 0.06);
    R.jaw = jaw;
    const lowerLip = add(jaw, new THREE.TorusGeometry(0.105, 0.016, 8, 26, Math.PI), M.lip,
      [lipSeat[0], lipSeat[1] + 0.16, lipSeat[2] - 0.06]);
    lowerLip.rotation.z = Math.PI;
    R.lowerLip = lowerLip;
    R.lowerLip.userData.base = [lipSeat[1] + 0.16, lipSeat[2] - 0.06];
    R.tongue = add(jaw, new THREE.SphereGeometry(0.055, 16, 12), M.tongue,
      [0, lipSeat[1] + 0.175, lipSeat[2] - 0.10], [1, 0.42, 0.9]);
    R.tongue.userData.baseZ = lipSeat[2] - 0.10;

    return R;
  }

  /* ------------------------------------------------------------------ scene */
  function buildScene(container) {
    const THREE = window.THREE;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.domElement.className = "avatar-canvas";
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.setAttribute("aria-label", "Animated interviewer");
    S.renderer = renderer;
    S.canvas = renderer.domElement;

    const scene = new THREE.Scene();
    S.scene = scene;

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
    camera.position.set(0, 1.58, 3.95);
    camera.lookAt(0, 1.43, 0);
    S.camera = camera;

    // Backdrop sphere: the gradient is painted, not lit, so it stays clean.
    const backdrop = new THREE.Mesh(
      new THREE.SphereGeometry(14, 32, 24),
      new THREE.MeshBasicMaterial({ map: backdropTexture(THREE), side: THREE.BackSide })
    );
    scene.add(backdrop);

    // Low-key portrait lighting, as in the reference: one soft key high on the
    // left doing nearly all the work, a dim cool fill so the shadow side is not
    // black, and a rim behind to separate the shoulders from the backdrop.
    scene.add(new THREE.HemisphereLight(0x6d7f84, 0x120f0d, 0.42));
    const key = new THREE.DirectionalLight(0xfff0dc, 3.1);
    key.position.set(-2.1, 2.9, 2.6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x7d99b4, 0.42);
    fill.position.set(3.0, 0.4, 1.8);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xbcd2cc, 1.5);
    rim.position.set(-1.7, 1.6, -2.4);
    scene.add(rim);
    // A weak catchlight from the camera, purely so the eyes stay alive.
    const catchlight = new THREE.PointLight(0xffffff, 0.9, 8, 2);
    catchlight.position.set(0.25, 1.75, 2.4);
    scene.add(catchlight);

    S.R = buildCharacter(THREE, scene);

    renderer.domElement.addEventListener("webglcontextlost", onContextLost, false);
    container.appendChild(renderer.domElement);
    S.built = true;
  }

  /** WebGL can be pulled out from under us (driver reset, GPU pressure). Hand
   *  the session back to the 2D rig rather than showing a dead canvas. */
  function onContextLost(event) {
    event.preventDefault();
    stopLoop();
    S.failed = true;
    if (window.Avatar2D && S.container) {
      window.Avatar = window.Avatar2D;
      try { window.Avatar2D.mount(S.container); } catch (err) { /* nothing left to try */ }
    }
  }

  function resize() {
    if (!S.renderer || !S.container) return;
    const w = S.container.clientWidth || 320;
    const h = S.container.clientHeight || Math.round(w * 440 / 420);
    S.renderer.setSize(w, h, false);
    S.camera.aspect = w / h;
    S.camera.updateProjectionMatrix();
  }

  /* --------------------------------------------------------------- the loop */
  function frame(now) {
    S.raf = requestAnimationFrame(frame);
    const t = now / 1000;
    let dt = S.t ? t - S.t : 0.016;
    S.t = t;
    // A backgrounded tab returns a huge dt; clamping stops the rig snapping.
    dt = clamp(dt, 0.001, 0.05);
    if (!S.visible || !S.docVisible) return;

    const life = reduceMotion ? 0.35 : 1;
    const pose = POSES[S.state] || POSES.idle;
    const emo = EMOTIONS[S.emotion] || EMOTIONS.neutral;
    const c = S.c;
    const g = S.g;
    const R = S.R;

    /* -- posture -- */
    for (const key of POSE_KEYS) g[key] = pose[key];

    // While speaking, the free hand keeps time with the voice: beats land on
    // loud syllables, which is what makes speech look intentional rather than
    // like a puppet with a moving mouth.
    if (S.speaking) {
      S.energySmooth = ease(S.energySmooth, c.open, 0.25, dt);
      const beat = S.energySmooth * life;
      g.elbowR = pose.elbowR + beat * 0.30;
      g.shPitchR = pose.shPitchR + beat * 0.16;
      g.wristR = pose.wristR - beat * 0.34;
      // Cycle a few postures so one gesture is not held for a whole answer.
      S.gestureT += dt;
      if (S.gestureT > 5.5) { S.gestureT = 0; S.gestureIdx = (S.gestureIdx + 1) % 3; }
      const swing = [0, -0.18, 0.12][S.gestureIdx];
      g.shPitchR += swing * life;
      g.shRollR += swing * 0.5 * life;
      g.headYaw += swing * 0.18 * life;
    } else {
      S.energySmooth = ease(S.energySmooth, 0, 0.12, dt);
    }

    // Writing on the pad while listening.
    if (S.state === "noting") {
      S.notePen += dt * 6 * life;
      g.wristR = pose.wristR + Math.sin(S.notePen) * 0.16;
      g.elbowR = pose.elbowR + Math.sin(S.notePen * 0.7) * 0.05;
    }

    // A hello wave, for the first turn of an interview.
    if (S.state === "greeting") {
      S.wave += dt * 7 * life;
      g.shRollR = pose.shRollR + Math.sin(S.wave) * 0.26;
      g.wristR = pose.wristR + Math.sin(S.wave) * 0.18;
    } else {
      S.wave = 0;
    }

    // The candidate talking for a while earns a little attentive lean.
    S.levelSmooth = ease(S.levelSmooth, S.level, 0.08, dt);
    if (S.state === "listening") g.lean += S.levelSmooth * 0.05;

    for (const key of POSE_KEYS) c[key] = ease(c[key], g[key], 0.12, dt);

    /* -- expression -- */
    g.brow = emo.brow + (S.speaking ? S.energySmooth * 0.28 : 0);
    g.browTilt = emo.browTilt;
    g.smile = emo.smile;
    g.squint = emo.squint;
    for (const key of ["brow", "browTilt", "smile", "squint"]) {
      c[key] = ease(c[key], g[key], 0.10, dt);
    }

    /* -- blinking -- */
    S.blink.next -= dt;
    if (S.blink.next <= 0 && S.blink.closing <= 0) {
      S.blink.closing = 0.16;
      S.blink.phase = 0;
      // Blinks cluster; a fixed interval reads as a metronome.
      S.blink.next = 2.2 + Math.random() * 4.2;
      if (Math.random() < 0.16) S.blink.next = 0.28;        // occasional double blink
    }
    let lidClose = 0;
    if (S.blink.closing > 0) {
      S.blink.phase += dt;
      const half = 0.08;
      lidClose = S.blink.phase < half
        ? S.blink.phase / half
        : clamp(1 - (S.blink.phase - half) / 0.10, 0, 1);
      if (S.blink.phase > half + 0.10) S.blink.closing = 0;
    }
    const lidOpen = clamp(emo.lid - c.squint * 0.35, 0.1, 1.2) * (1 - lidClose);

    /* -- gaze: mostly at the camera, with small saccades -- */
    S.gaze.next -= dt;
    if (S.gaze.next <= 0) {
      S.gaze.next = 1.4 + Math.random() * 3.4;
      if (S.state === "thinking") {
        // Looking away while thinking is what people actually do.
        S.gaze.x = (Math.random() - 0.5) * 0.9;
        S.gaze.y = -0.34 - Math.random() * 0.26;
      } else if (S.state === "noting" && Math.random() < 0.6) {
        S.gaze.x = -0.22; S.gaze.y = 0.40;                   // down at the pad
      } else {
        S.gaze.x = (Math.random() - 0.5) * 0.34;
        S.gaze.y = (Math.random() - 0.5) * 0.22;
      }
    }
    c.gazeX = ease(c.gazeX, S.gaze.x * life, 0.22, dt);
    c.gazeY = ease(c.gazeY, S.gaze.y * life, 0.22, dt);

    /* -- head: idle drift, nods, tilt -- */
    if (S.nodQueue > 0 && S.nodT <= 0) { S.nodT = 0.75; S.nodQueue -= 1; }
    let nod = 0;
    if (S.nodT > 0) {
      S.nodT -= dt;
      nod = Math.sin((0.75 - S.nodT) / 0.75 * TAU) * 0.13;
    }
    const tiltTarget = S.emotion === "curious" ? -0.11 : S.emotion === "thinking" ? 0.09 : 0;
    c.headTilt = ease(c.headTilt, tiltTarget, 0.06, dt);

    const driftY = (Math.sin(t * 0.31) * 0.030 + Math.sin(t * 0.83 + 1.1) * 0.016) * life;
    const driftX = Math.sin(t * 0.62 + 0.4) * 0.018 * life;
    R.head.rotation.set(
      c.headPitch + driftX + nod * life + c.gazeY * 0.30,
      c.headYaw + driftY + c.gazeX * 0.45,
      c.headTilt * life
    );

    /* -- body: breathing, sway, lean -- */
    const breath = Math.sin(t * 0.9) * life;
    R.torso.scale.set(1 + breath * 0.012, 1 + breath * 0.007, 1 + breath * 0.022);
    R.root.position.set(Math.sin(t * 0.41) * 0.012 * life, 0, c.lean * 0.14);
    R.root.rotation.set(-c.lean * 0.06, Math.sin(t * 0.27 + 0.7) * 0.020 * life, 0);

    /* -- arms: shoulder -> elbow -> wrist, mirrored -- */
    const setArm = (arm, side, pitch, yaw, roll, elbow, wrist) => {
      arm.shoulder.rotation.set(-pitch, side * yaw, side * roll);
      arm.elbow.rotation.x = -elbow;
      arm.wrist.rotation.x = -wrist;
    };
    setArm(R.armL, -1, c.shPitchL, c.shYawL, c.shRollL, c.elbowL, c.wristL);
    setArm(R.armR, 1, c.shPitchR, c.shYawR, c.shRollR, c.elbowR, c.wristR);

    /* -- eyes: gaze, lids, squint -- */
    for (const eye of R.eye) {
      eye.ball.rotation.set(c.gazeY * 0.55, c.gazeX * 0.65, 0);
      // 0 leaves the shell over the top of the ball (a lidded eye); +90 degrees
      // sweeps it across the front, which is a closed eye.
      eye.upper.rotation.x = lerp(1.15, -0.16, clamp(lidOpen, 0, 1.15));
      eye.lower.rotation.x = 0.20 - c.squint * 0.38;
    }

    /* -- brows -- */
    for (const brow of R.brow) {
      const side = brow.userData.side;
      brow.position.y = brow.userData.baseY + c.brow * 0.048 - c.squint * 0.026;
      brow.rotation.z = c.browTilt * side * -1 + c.brow * 0.06 * side;
    }

    /* -- ears: an occasional twitch, because a still ear looks like plastic -- */
    S.ear.next -= dt;
    if (S.ear.next <= 0 && S.ear.t <= 0) {
      S.ear.t = 0.4;
      S.ear.side = Math.random() < 0.5 ? 0 : 1;
      S.ear.next = 5 + Math.random() * 9;
    }
    for (let i = 0; i < R.ear.length; i++) {
      let twitch = 0;
      if (S.ear.t > 0 && i === S.ear.side) {
        twitch = Math.sin((0.4 - S.ear.t) / 0.4 * TAU * 2) * 0.13 * life;
      }
      R.ear[i].rotation.z = R.ear[i].userData.side * (0.14 + twitch);
    }
    if (S.ear.t > 0) S.ear.t -= dt;

    /* -- mouth: jaw, lips, teeth, tongue -- */
    for (const key of ["open", "wide", "round", "tongue", "teeth", "bite"]) {
      c[key] = ease(c[key], S.speaking ? g[key] : (key === "open" ? 0.04 : 0), 0.30, dt);
    }
    const open = clamp(c.open, 0, 1);
    R.jaw.rotation.x = open * 0.40 + c.smile * 0.01;

    // A wide shape stretches the lips and flattens them; a round one pulls them
    // in and pushes them forward, the way a real pucker works.
    const lipW = (1 + c.wide * 0.32) * (1 - c.round * 0.40);
    const lipH = (1 - c.wide * 0.22) * (1 + c.round * 0.35);
    const push = c.round * 0.055;
    R.upperLip.scale.set(lipW, LIP_FLAT * lipH * (1 + open * 0.30), 1 + c.round * 0.5);
    R.upperLip.position.set(0, c.smile * 0.012, push);
    R.lowerLip.scale.set(lipW, LIP_FLAT * lipH * (1 + open * 0.45), 1 + c.round * 0.5);
    R.lowerLip.position.set(0, R.lowerLip.userData.base[0] - c.bite * 0.012,
                        R.lowerLip.userData.base[1] + push);
    R.mouth.scale.set(1, 1 + open * 0.20, 1);
    R.cavity.scale.set(1.1 + c.wide * 0.22, 0.10 + open * 0.80, 0.30);

    // Cheeks full on a smile - the part people actually read.
    for (const cheek of R.cheek) {
      const lift = c.smile * 0.030 + c.squint * 0.012;
      cheek.position.y = cheek.userData.base + lift;
      cheek.scale.set(1 + c.smile * 0.16, 0.95 + c.smile * 0.12, 0.45);
    }

    R.M.tooth.opacity = clamp(c.teeth * clamp(open * 4, 0, 1) + c.bite * 0.85, 0, 1);
    R.M.tongue.opacity = clamp(c.tongue * clamp(open * 3, 0, 1), 0, 1);
    R.tongue.position.z = R.tongue.userData.baseZ + c.tongue * 0.045;

    S.renderer.render(S.scene, S.camera);
  }

  function startLoop() {
    if (S.raf) return;
    S.t = 0;
    S.raf = requestAnimationFrame(frame);
  }
  function stopLoop() {
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = null;
  }

  /** Don't burn a GPU on a rig nobody is looking at. */
  function watchVisibility(container) {
    if (S.io) S.io.disconnect();
    if (window.IntersectionObserver) {
      S.io = new IntersectionObserver((entries) => {
        S.visible = entries.some((e) => e.isIntersecting);
      }, { threshold: 0.01 });
      S.io.observe(container);
    }
    if (S.ro) S.ro.disconnect();
    if (window.ResizeObserver) {
      S.ro = new ResizeObserver(resize);
      S.ro.observe(container);
    } else {
      window.addEventListener("resize", resize);
    }
  }

  document.addEventListener("visibilitychange", () => {
    S.docVisible = !document.hidden;
  });

  /* -------------------------------------------------------------- public API */
  return {
    supported,

    mount(container) {
      if (!container) return this;
      S.container = container;
      try {
        if (!S.built) {
          container.innerHTML = "";
          buildScene(container);
        } else if (S.canvas.parentNode !== container) {
          // The candidate flow mounts twice - welcome card, then the interview
          // stage. Move the one canvas rather than building a second scene.
          container.innerHTML = "";
          container.appendChild(S.canvas);
        }
      } catch (err) {
        // Nothing about a broken avatar should stop an interview.
        console.warn("Avatar3D: could not build the 3D rig, using the 2D one", err);
        S.failed = true;
        if (window.Avatar2D) {
          window.Avatar = window.Avatar2D;
          return window.Avatar2D.mount(container);
        }
        return this;
      }
      watchVisibility(container);
      resize();
      S.visible = true;
      startLoop();
      return this;
    },

    /** Posture: idle | listening | noting | speaking | thinking | greeting. */
    setState(state) {
      if (POSES[state]) S.state = state;
      S.speaking = state === "speaking" || state === "greeting";
      if (!S.speaking) S.gestureT = 0;
      return this;
    },

    /** Expression: neutral | friendly | curious | encouraging | thinking. */
    setEmotion(emotion) {
      if (EMOTIONS[emotion]) S.emotion = emotion;
      return this;
    },

    /** Push a mouth shape. Called many times a second by speech.js. */
    setViseme(name, intensity = 1) {
      const v = VISEMES[name] || VISEMES.rest;
      S.speaking = true;
      S.g.open = (v.open || 0) * intensity;
      S.g.wide = v.wide || 0;
      S.g.round = v.round || 0;
      S.g.tongue = v.tongue || 0;
      S.g.teeth = v.teeth || 0;
      S.g.bite = v.bite || 0;
      return this;
    },

    /** Stop lip-sync and let the mouth close. */
    stopSpeaking() {
      S.speaking = false;
      if (S.state === "speaking" || S.state === "greeting") S.state = "idle";
      return this;
    },

    /** Candidate live mic level, 0-1. Drives nodding along to sustained speech. */
    pulse(level) {
      S.level = clamp(level || 0, 0, 1);
      if (S.level > 0.45 && Math.random() < 0.012) this.nod();
      return this;
    },

    /** One acknowledging nod. */
    nod(times = 1) {
      S.nodQueue = Math.min(4, S.nodQueue + times);
      return this;
    },

    /** True when the rig is mounted - the app checks before driving it. */
    isReady() { return S.built && !S.failed; },

    visemeNames() { return Object.keys(VISEMES); },
  };
})();

/* Swap the 3D rig in for the 2D one when the browser can run it, keeping the
 * SVG version reachable as Avatar2D. Both expose the same methods and the app
 * looks `Avatar` up on every call, so a fallback mid-session is seamless. */
(function () {
  "use strict";
  if (window.Avatar3D && window.Avatar3D.supported()) {
    window.Avatar2D = window.Avatar;
    window.Avatar = window.Avatar3D;
  }
})();
