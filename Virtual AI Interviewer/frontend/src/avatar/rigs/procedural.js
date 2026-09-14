/* The built-in rig: a monkey in a suit, sculpted in code.
 *
 * This is what renders until a GLB is dropped at the configured path, and the
 * fallback if that model fails to load. It is not a stand-in box: the head is
 * one displaced, vertex-coloured surface (see `headShape`) rather than a pile
 * of spheres, because stacking primitives is what makes a character read as a
 * toy - every join shows as a crease.
 *
 * It implements the same rig contract as the glTF rig: `root`, `apply(pose,
 * dt)`, `dispose()`. The director does not know which of the two it is driving.
 */

import {
  BoxGeometry,
  BufferAttribute,
  CapsuleGeometry,
  Color,
  CanvasTexture,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
} from "three";

import { LIGHTS } from "../config.js";
import { bump, bumpWide, clamp, HALF_PI, lerp, sstep, TAU } from "../math.js";

/* ------------------------------------------------------------------ palette
 * Dark grizzled coat, a bare grey-pink face, charcoal suit - lit like a
 * headshot rather than a cartoon.
 */
const C = {
  furDark: 0x232220,
  fur: 0x302f2b,
  furLight: 0x46433c,
  skin: 0xa8958c,
  skinDeep: 0x7d6c66,
  skinLight: 0xbaa69d,
  eyeWhite: 0xcfc6b4,
  iris: 0xb08430,
  irisDark: 0x6b4a17,
  pupil: 0x0a0807,
  suit: 0x3a3f46,
  suitDark: 0x2b2f35,
  shirt: 0xd5d9dc,
  tie: 0x2a2f35,
  lip: 0x5b4a44,
  mouth: 0x24100f,
  tongue: 0x8f5555,
  tooth: 0xdcd6c8,
};

/* Lips are half-tori squashed this hard vertically - a full-height arc reads as
 * a ring drawn on the muzzle rather than a mouth. */
const LIP_FLAT = 0.4;

/* ----------------------------------------------------------------- textures */

/** Painted fur: a few thousand fine strokes in varying greys, used as the
 *  colour map *and* the bump map. This is what stops a sphere of flat brown
 *  reading as moulded plastic - real fur is grizzled, never one tone. */
function furTexture(base, spread, strokes, repeat) {
  const size = 512;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = `#${base.toString(16).padStart(6, "0")}`;
  ctx.fillRect(0, 0, size, size);
  const r = (base >> 16) & 255;
  const g = (base >> 8) & 255;
  const b = base & 255;
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  for (let i = 0; i < strokes; i++) {
    // Lighter tips and darker roots in roughly equal measure, so the coat reads
    // as many hairs rather than as noise.
    const k = (Math.random() - 0.45) * spread;
    ctx.strokeStyle = `rgba(${clamp(r + k, 0, 255).toFixed(0)},${clamp(g + k, 0, 255).toFixed(0)},${clamp(b + k * 0.92, 0, 255).toFixed(0)},0.62)`;
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 5 + Math.random() * 11;
    const lean = (Math.random() - 0.5) * 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + lean * len, y + len);
    ctx.stroke();
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(repeat, repeat * 0.7);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Mottled skin: blotches and fine creases, for the bare face and ears. */
function skinTexture(base, repeat) {
  const size = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = `#${base.toString(16).padStart(6, "0")}`;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const k = (Math.random() - 0.5) * 34;
    ctx.fillStyle = `rgba(${(128 + k).toFixed(0)},${(120 + k).toFixed(0)},${(116 + k).toFixed(0)},0.10)`;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, 2 + Math.random() * 9, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(60,48,44,0.10)";
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 22, y + (Math.random() - 0.5) * 6);
    ctx.stroke();
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Flat grey noise, used as a bump map on cloth - cheaper than a painted
 *  texture where all that is wanted is a surface that is not perfectly flat. */
function noiseTexture(size, contrast, repeat) {
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
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  return tex;
}

/* -------------------------------------------------------------------- skull
 * `headShape` is the single source of truth for the face: the geometry is
 * built from it, and every feature that has to sit ON the head (eyes,
 * nostrils, mouth, ears) is positioned through it too, so a change to the
 * sculpt moves them with it instead of leaving them floating or buried.
 *
 * What makes this read as a monkey rather than a bald man is the layout, not
 * the fur: a snout that carries the nose and mouth forward, one heavy brow bar
 * over close-set sunken eyes, almost no forehead before the hairline, and no
 * chin to speak of.
 */
function headShape(x, y, z) {
  const muzzle = bump(x, y, z, 0, -0.3, 0.95, 0.46);
  const snoutTip = bump(x, y, z, 0, -0.3, 0.95, 0.24);
  const nose = bump(x, y, z, 0, -0.24, 0.97, 0.14);
  const brow = bumpWide(x, y, z, 0, 0.3, 0.95, 0.3, 0.55);
  const socket = bump(x, y, z, -0.27, 0.15, 0.95, 0.19) + bump(x, y, z, 0.27, 0.15, 0.95, 0.19);
  const forehead = bumpWide(x, y, z, 0, 0.66, 0.75, 0.34, 0.7);
  const cheek = bump(x, y, z, -0.6, -0.32, 0.72, 0.38) + bump(x, y, z, 0.6, -0.32, 0.72, 0.38);
  const crown = bump(x, y, z, 0, 1, 0.05, 0.48);
  const nape = bump(x, y, z, 0, -0.55, -0.82, 0.45);
  const jawline = bumpWide(x, y, z, 0, -0.92, 0.35, 0.3, 0.6);

  let r = 1;
  r += muzzle * 0.2;            // the snout: some radial mass, but mostly a
  const fwd = muzzle * 0.26;    // straight forward push, applied in headPoint
  r += snoutTip * 0.1;          // rounded off at the end rather than a cone
  r += nose * 0.03;             // a flat nose pad, no bridge
  r += brow * 0.105;            // one bony bar over both eyes
  r -= socket * 0.08;           // eyes sunk deep under it
  r -= forehead * 0.06;         // the forehead slopes straight back
  r += cheek * 0.045;
  r -= crown * 0.085;           // small cranium, big face
  r -= nape * 0.04;
  r -= jawline * 0.02;          // a slight chin - the jaw recedes under the snout

  // Bare skin: a narrow oval from just over the brow down to the jaw, plus the
  // whole snout. The hairline comes lowest in the middle - the widow's peak
  // every macaque has - and the coat closes in under the jaw.
  const peak = 0.2 + 0.16 * Math.abs(x);
  const band = sstep(-0.74, -0.5, y) * (1 - sstep(peak, peak + 0.13, y));
  const sides = 1 - sstep(0.23, 0.5, Math.abs(x));
  const front = sstep(0.4, 0.66, z);
  const snout = bump(x, y, z, 0, -0.34, 0.94, 0.4);
  const skin = Math.min(1, band * sides * front * 1.3 + snout * 1.15);

  // Skin is not one colour either: darker in the eye pits, paler on the snout.
  const eyeRing = bump(x, y, z, -0.27, 0.15, 0.95, 0.33) + bump(x, y, z, 0.27, 0.15, 0.95, 0.33);
  return { r, fwd, skin, dark: Math.min(1, eyeRing) * 0.58, pale: muzzle * 0.42 };
}

const HEAD_SCALE = { x: 0.428, y: 0.52, z: 0.5 };

/** Where a direction lands on the finished head, in head-local space. */
function headPoint(x, y, z, out) {
  const len = Math.sqrt(x * x + y * y + z * z);
  x /= len;
  y /= len;
  z /= len;
  const shape = headShape(x, y, z);
  out = out || {};
  out.x = x * shape.r * HEAD_SCALE.x;
  out.y = y * shape.r * HEAD_SCALE.y;
  out.z = (z * shape.r + shape.fwd) * HEAD_SCALE.z;
  return out;
}

/** Displace a sphere into the skull, colour it, and re-normal it. */
function skullGeometry(furColor, skinColor) {
  const geo = new SphereGeometry(1, 96, 72);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const fur = new Color(furColor);
  const skin = new Color(skinColor);
  const p = {};
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const shape = headShape(x, y, z);
    headPoint(x, y, z, p);
    pos.setXYZ(i, p.x, p.y, p.z);
    // Fur darkens over the crown, which is what stops a single flat brown from
    // reading as paint.
    const shade = 0.78 + 0.28 * (1 - Math.max(0, y));
    const t = shape.skin;
    const tone = (1 - shape.dark) * (1 + shape.pale);
    colors[i * 3] = fur.r * shade * (1 - t) + (skin.r * tone + shape.pale * 0.05) * t;
    colors[i * 3 + 1] = fur.g * shade * (1 - t) + skin.g * tone * t;
    colors[i * 3 + 2] = fur.b * shade * (1 - t) + (skin.b * tone - shape.pale * 0.02) * t;
  }
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/* ----------------------------------------------------------------- the rig */

export function createProceduralRig() {
  const R = {};
  const disposables = [];

  const coatMap = furTexture(0xffffff, 150, 14000, 3);
  const furMap = furTexture(C.fur, 118, 3500, 3);
  const furDarkMap = furTexture(C.furDark, 104, 3500, 3);
  const skinMap = skinTexture(C.skin, 2);
  const skinLightMap = skinTexture(C.skinLight, 2);
  const clothBump = noiseTexture(128, 0.3, 20);
  disposables.push(coatMap, furMap, furDarkMap, skinMap, skinLightMap, clothBump);

  const env = LIGHTS.envIntensity;
  const M = {
    // The skull is shaded by vertex colours, so its texture must stay neutral:
    // a brown map multiplied over a skin-coloured vertex turns the bare face
    // back into fur.
    hide: new MeshPhysicalMaterial({
      vertexColors: true, map: coatMap, bumpMap: coatMap, bumpScale: 1.6,
      roughness: 0.88, metalness: 0, envMapIntensity: env,
      sheen: 0.5, sheenRoughness: 0.9, sheenColor: new Color(0x6b6257),
    }),
    face: new MeshPhysicalMaterial({
      color: C.skin, map: coatMap, bumpMap: coatMap, bumpScale: 0.5,
      roughness: 0.7, metalness: 0, envMapIntensity: env,
    }),
    fur: new MeshStandardMaterial({ map: furMap, bumpMap: furMap, bumpScale: 2.2, roughness: 0.98, metalness: 0, envMapIntensity: env }),
    furDark: new MeshStandardMaterial({ map: furDarkMap, bumpMap: furDarkMap, bumpScale: 2.6, roughness: 0.99, metalness: 0, envMapIntensity: env }),
    skin: new MeshStandardMaterial({ map: skinMap, bumpMap: skinMap, bumpScale: 0.8, roughness: 0.66, metalness: 0, envMapIntensity: env }),
    skinDeep: new MeshStandardMaterial({ color: C.skinDeep, map: skinMap, bumpMap: skinMap, bumpScale: 0.7, roughness: 0.7, metalness: 0, envMapIntensity: env }),
    skinLight: new MeshStandardMaterial({ map: skinLightMap, bumpMap: skinLightMap, bumpScale: 0.7, roughness: 0.6, metalness: 0, envMapIntensity: env }),
    suit: new MeshPhysicalMaterial({
      color: C.suit, roughness: 0.92, metalness: 0.02, bumpMap: clothBump, bumpScale: 0.4,
      envMapIntensity: env * 0.7, sheen: 0.35, sheenRoughness: 0.8, sheenColor: new Color(0x5a626c),
    }),
    suitDark: new MeshPhysicalMaterial({
      color: C.suitDark, roughness: 0.9, metalness: 0.02, bumpMap: clothBump, bumpScale: 0.4,
      envMapIntensity: env * 0.7, sheen: 0.35, sheenRoughness: 0.8, sheenColor: new Color(0x5a626c),
    }),
    shirt: new MeshStandardMaterial({ color: C.shirt, roughness: 0.72, metalness: 0, envMapIntensity: env }),
    tie: new MeshPhysicalMaterial({ color: C.tie, roughness: 0.42, metalness: 0.08, envMapIntensity: env, sheen: 0.6, sheenRoughness: 0.5 }),
    // A wet cornea over the iris is most of what separates an eye from a bead.
    eyeWhite: new MeshPhysicalMaterial({ color: C.eyeWhite, roughness: 0.18, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: env * 1.6 }),
    iris: new MeshPhysicalMaterial({ color: C.iris, roughness: 0.22, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: env * 1.8 }),
    irisDark: new MeshStandardMaterial({ color: C.irisDark, roughness: 0.3, metalness: 0, envMapIntensity: env }),
    pupil: new MeshStandardMaterial({ color: C.pupil, roughness: 0.15, metalness: 0, envMapIntensity: env }),
    glint: new MeshBasicMaterial({ color: 0xfdfbf4 }),
    lip: new MeshPhysicalMaterial({ color: C.lip, roughness: 0.52, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.4, envMapIntensity: env }),
    mouth: new MeshStandardMaterial({ color: C.mouth, roughness: 1, metalness: 0 }),
    tongue: new MeshStandardMaterial({ color: C.tongue, roughness: 0.6, metalness: 0, transparent: true, opacity: 0 }),
    tooth: new MeshStandardMaterial({ color: C.tooth, roughness: 0.34, metalness: 0, transparent: true, opacity: 0 }),
  };
  R.M = M;
  disposables.push(...Object.values(M));

  const add = (parent, geo, material, pos, scale) => {
    const mesh = new Mesh(geo, material);
    if (pos) mesh.position.set(pos[0], pos[1], pos[2]);
    if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    disposables.push(geo);
    return mesh;
  };
  const group = (parent, x, y, z) => {
    const g = new Group();
    g.position.set(x || 0, y || 0, z || 0);
    parent.add(g);
    return g;
  };

  /* -- root: everything the body does (sway, lean, breathe) hangs off this -- */
  const root = new Group();
  R.root = root;

  /* ---------------------------------------------------------------- torso */
  const torso = group(root, 0, 0, 0);
  R.torso = torso;

  // The jacket is a spun profile: waist, chest, then a shoulder that slopes
  // into the neck instead of stopping dead. Flattened in z, because a chest is
  // not a barrel.
  const jacketProfile = [
    [0.5, 0.0], [0.53, 0.25], [0.555, 0.5], [0.585, 0.72], [0.625, 0.88],
    [0.672, 0.99], [0.7, 1.06], [0.69, 1.11], [0.6, 1.16], [0.44, 1.2],
    [0.3, 1.225], [0.205, 1.235],
  ].map((p) => new Vector2(p[0], p[1]));
  const jacket = add(torso, new LatheGeometry(jacketProfile, 56), M.suit);
  jacket.scale.set(1, 1, 0.74);
  for (const side of [-1, 1]) {
    add(torso, new SphereGeometry(0.19, 26, 20), M.suit, [side * 0.615, 1.045, 0], [1, 0.92, 0.84]);
  }

  // Neck, long enough that the jaw clears the collar.
  add(torso, new CylinderGeometry(0.205, 0.265, 0.36, 26), M.fur, [0, 1.28, 0.01]);

  /* ---- shirt, lapels and tie -------------------------------------------
   * All three are flat shapes extruded and laid on the chest. Boxes stood in
   * for them before and read as taped-on rectangles; a lapel is a shape with a
   * peak, and that peak is most of what says "suit".
   */
  const extrude = (points, depth) => {
    const shape = new Shape();
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
    shape.closePath();
    return new ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  };

  const shirt = add(torso, extrude([[-0.18, 0.255], [0.18, 0.255], [0, -0.28]], 0.03), M.shirt, [0, 0.95, 0.452]);
  shirt.rotation.x = -0.12;

  for (const side of [-1, 1]) {
    const lapel = add(torso, extrude([
      [0.015, 0.255], [0.205, 0.175], [0.245, 0.02], [0.13, -0.275], [0.02, -0.095],
    ], 0.035), M.suitDark, [side * 0.055, 0.945, 0.462]);
    lapel.scale.x = side;
    lapel.rotation.set(-0.12, side * 0.16, 0);
  }

  const knot = add(torso, new BoxGeometry(0.098, 0.092, 0.07), M.tie, [0, 1.055, 0.495]);
  knot.rotation.x = -0.16;
  const blade = add(torso, new CylinderGeometry(0.058, 0.092, 0.42, 4), M.tie, [0, 0.8, 0.47], [1, 1, 0.4]);
  blade.rotation.set(-0.07, Math.PI / 4, 0);

  /* ----------------------------------------------------------------- arms */
  const buildArm = (side) => {
    const arm = {};
    arm.shoulder = group(torso, side * 0.63, 1.035, 0);
    add(arm.shoulder, new CapsuleGeometry(0.14, 0.28, 6, 18), M.suit, [0, -0.28, 0]);

    arm.elbow = group(arm.shoulder, 0, -0.56, 0);
    add(arm.elbow, new CapsuleGeometry(0.128, 0.26, 6, 18), M.suit, [0, -0.255, 0]);
    // Cuff: a sliver of shirt at the wrist, the detail that sells a suit.
    add(arm.elbow, new CylinderGeometry(0.108, 0.104, 0.05, 20), M.shirt, [0, -0.49, 0]);

    arm.wrist = group(arm.elbow, 0, -0.52, 0);
    const hand = group(arm.wrist, 0, 0, 0);
    add(hand, new SphereGeometry(1, 20, 16), M.skinDeep, [0, -0.1, 0], [0.115, 0.135, 0.062]);
    for (let i = 0; i < 4; i++) {
      const finger = add(hand, new CapsuleGeometry(0.026, 0.085, 4, 10), M.skinDeep, [(i - 1.5) * 0.055, -0.235, 0.004]);
      finger.rotation.x = -0.22 - i * 0.03;
    }
    const thumb = add(hand, new CapsuleGeometry(0.029, 0.055, 4, 10), M.skinDeep, [side * -0.105, -0.145, 0.03]);
    thumb.rotation.set(-0.4, 0, side * 0.85);
    return arm;
  };
  R.armL = buildArm(-1);
  R.armR = buildArm(1);

  /* ----------------------------------------------------------------- head */
  const head = group(root, 0, 1.69, 0.02);
  head.scale.setScalar(0.88);
  R.head = head;
  add(head, skullGeometry(C.fur, C.skin), M.hide);

  const on = (x, y, z, out, push) => {
    const p = headPoint(x, y, z, out);
    if (push) {
      const len = Math.sqrt(x * x + y * y + z * z);
      p.x += (x / len) * push;
      p.y += (y / len) * push;
      p.z += (z / len) * push;
    }
    return [p.x, p.y, p.z];
  };

  // Brow hair: sparse, lying along the ridge rather than painted on as bars.
  R.brow = [-1, 1].map((side) => {
    const g = group(head, 0, 0, 0);
    const seat = on(side * 0.28, 0.31, 0.9, {}, -0.004);
    g.position.set(seat[0], seat[1], seat[2]);
    const hair = add(g, new CapsuleGeometry(0.017, 0.105, 5, 12), M.furDark);
    hair.rotation.set(0.34, side * -0.18, HALF_PI + side * 0.22);
    g.userData.side = side;
    g.userData.baseY = seat[1];
    return g;
  });

  // Nostrils, set into the end of the snout.
  for (const side of [-1, 1]) {
    const nostril = add(head, new SphereGeometry(0.029, 14, 12), M.mouth, on(side * 0.15, -0.28, 0.95, {}, 0.004), [1.0, 0.68, 0.8]);
    nostril.rotation.z = side * 0.55;
  }

  // Cheeks ride up on a smile; they sit just proud of the sculpted cheek.
  R.cheek = [-1, 1].map((side) => {
    const c = add(head, new SphereGeometry(0.085, 20, 16), M.face, on(side * 0.5, -0.3, 0.8, {}, -0.095), [1, 0.85, 0.5]);
    c.userData.base = c.position.y;
    return c;
  });

  /* ------------------------------------------------------------------ ears
   * Large, thin and bare, with a raised rim and a dark hollow, turned most of
   * the way toward the camera - edge-on they would vanish, and they are half of
   * why this reads as a monkey at a glance.
   */
  R.ear = [-1, 1].map((side) => {
    const seat = on(side * 0.99, 0.06, 0.02, {}, -0.015);
    const g = group(head, seat[0], seat[1], seat[2]);
    g.rotation.set(0.05, -side * 0.7, side * 0.14);
    add(g, new SphereGeometry(0.2, 26, 20), M.skin, [0, 0, 0], [0.13, 1, 0.92]);
    const rim = add(g, new TorusGeometry(0.182, 0.02, 10, 30), M.skin, [side * 0.008, 0, 0]);
    rim.rotation.y = HALF_PI;
    rim.scale.set(0.88, 1, 1);
    add(g, new SphereGeometry(0.112, 20, 16), M.skinDeep, [side * -0.028, -0.012, 0.02], [0.1, 0.8, 0.66]);
    add(g, new SphereGeometry(0.175, 22, 18), M.fur, [side * -0.075, -0.02, -0.04], [0.26, 0.8, 0.7]);
    g.userData.side = side;
    return g;
  });

  /* ------------------------------------------------------------------ eyes
   * Amber iris, deep in the socket the sculpt already carved. Two hemisphere
   * shells make the lids: a shell at rotation.x = 0 covers the top of the ball
   * (a naturally lidded eye) and tipping it forward is a blink.
   */
  R.eye = [-1, 1].map((side) => {
    const seat = on(side * 0.27, 0.15, 0.95, {}, -0.058);
    const socket = group(head, seat[0], seat[1], seat[2]);
    const e = {};
    e.ball = group(socket, 0, 0, 0);
    add(e.ball, new SphereGeometry(0.085, 30, 24), M.eyeWhite);
    add(e.ball, new SphereGeometry(0.057, 26, 20), M.irisDark, [0, 0, 0.058], [1, 1, 0.62]);
    add(e.ball, new SphereGeometry(0.052, 26, 20), M.iris, [0, 0, 0.064], [1, 1, 0.6]);
    add(e.ball, new SphereGeometry(0.024, 18, 14), M.pupil, [0, 0, 0.078], [1, 1, 0.5]);
    add(e.ball, new SphereGeometry(0.007, 10, 8), M.glint, [0.026, 0.03, 0.084], [1, 1, 0.6]);

    e.upper = add(socket, new SphereGeometry(0.091, 26, 14, 0, TAU, 0, HALF_PI), M.face);
    e.lower = add(socket, new SphereGeometry(0.091, 26, 14, 0, TAU, HALF_PI, HALF_PI), M.face);
    e.side = side;
    return e;
  });

  /* ----------------------------------------------------------------- mouth
   * Upper lip, cavity and teeth belong to the head; the lower lip and tongue
   * belong to the jaw, which hinges just behind and below the mouth so a
   * wide-open jaw drops the lip rather than swinging it off the face.
   */
  const lipSeat = on(0, -0.43, 0.9, {}, 0.005);
  const mouth = group(head, lipSeat[0], lipSeat[1], lipSeat[2]);
  R.mouth = mouth;
  R.cavity = add(mouth, new SphereGeometry(0.128, 20, 16), M.mouth, [0, 0, -0.03], [1, 0.1, 0.3]);
  R.upperLip = add(mouth, new TorusGeometry(0.128, 0.011, 8, 28, Math.PI), M.lip);
  R.upperLip.scale.set(1, LIP_FLAT, 1);
  R.teeth = add(mouth, new BoxGeometry(0.17, 0.022, 0.03), M.tooth, [0, 0.008, 0.012]);

  const jawY = -0.27;
  const jawZ = 0.24;
  const jaw = group(head, 0, jawY, jawZ);
  R.jaw = jaw;
  const lipY = lipSeat[1] - jawY;
  const lipZ = lipSeat[2] - jawZ;
  const lowerLip = add(jaw, new TorusGeometry(0.128, 0.012, 8, 28, Math.PI), M.lip, [0, lipY, lipZ]);
  lowerLip.rotation.z = Math.PI;
  R.lowerLip = lowerLip;
  R.lowerLip.userData.base = [lipY, lipZ];
  R.tongue = add(jaw, new SphereGeometry(0.055, 16, 12), M.tongue, [0, lipY + 0.012, lipZ - 0.04], [1, 0.42, 0.9]);
  R.tongue.userData.baseZ = lipZ - 0.04;

  /* ------------------------------------------------------------- the frame */
  function apply(pose) {
    /* -- body: breathing, sway, lean -- */
    R.torso.scale.set(1 + pose.breath * 0.012, 1 + pose.breath * 0.007, 1 + pose.breath * 0.022);
    R.root.position.set(pose.sway * 0.012, 0, pose.lean * 0.14);
    R.root.rotation.set(-pose.lean * 0.06, pose.swayYaw * 0.02, 0);

    /* -- head -- */
    R.head.rotation.set(pose.headPitch, pose.headYaw, pose.headRoll);

    /* -- arms: shoulder -> elbow -> wrist, mirrored -- */
    const setArm = (arm, side, a) => {
      arm.shoulder.rotation.set(-a.pitch, side * a.yaw, side * a.roll);
      arm.elbow.rotation.x = -a.elbow;
      arm.wrist.rotation.x = -a.wrist;
    };
    setArm(R.armL, -1, pose.arms.l);
    setArm(R.armR, 1, pose.arms.r);

    /* -- eyes: gaze, lids, squint -- */
    for (const eye of R.eye) {
      eye.ball.rotation.set(pose.gazeY * 0.55, pose.gazeX * 0.65, 0);
      // A hemisphere shell covers whatever lies within 90 degrees of its pole,
      // and rotation.x tips that pole forward: the upper lid only clears the
      // eye at a negative angle, the lower lid at a positive one.
      eye.upper.rotation.x = lerp(1.15, -0.16, clamp(pose.lidOpen, 0, 1.15));
      eye.lower.rotation.x = 0.2 - pose.squint * 0.38;
    }

    /* -- brows -- */
    for (const brow of R.brow) {
      const side = brow.userData.side;
      brow.position.y = brow.userData.baseY + pose.browRaise * 0.048 - pose.squint * 0.026;
      brow.rotation.z = pose.browTilt * side * -1 + pose.browRaise * 0.06 * side;
    }

    /* -- ears -- */
    for (let i = 0; i < R.ear.length; i++) {
      const twitch = i === pose.earSide ? pose.earTwitch : 0;
      R.ear[i].rotation.z = R.ear[i].userData.side * (0.14 + twitch);
    }

    /* -- mouth: jaw, lips, teeth, tongue -- */
    const open = clamp(pose.jawOpen, 0, 1);
    R.jaw.rotation.x = open * 0.24 + pose.mouthSmile * 0.01;

    // A wide shape stretches the lips and flattens them; a round one pulls them
    // in and pushes them forward, the way a real pucker works.
    const lipW = (1 + pose.mouthWide * 0.32) * (1 - pose.mouthPucker * 0.4);
    const lipH = (1 - pose.mouthWide * 0.22) * (1 + pose.mouthPucker * 0.12);
    const push = pose.mouthPucker * 0.055;
    R.upperLip.scale.set(lipW, LIP_FLAT * lipH * (1 + open * 0.3), 1 + pose.mouthPucker * 0.5);
    R.upperLip.position.set(0, pose.mouthSmile * 0.012, push);
    R.lowerLip.scale.set(lipW, LIP_FLAT * lipH * (1 + open * 0.12), 1 + pose.mouthPucker * 0.5);
    R.lowerLip.position.set(0, R.lowerLip.userData.base[0] - pose.lipBite * 0.012, R.lowerLip.userData.base[1] + push);
    R.mouth.scale.set(1, 1 + open * 0.2, 1);
    // The cavity grows DOWN to meet the lower lip on the hinged jaw; grown from
    // the centre it leaves a strip of still skin between the two.
    R.cavity.scale.set(1.1 + pose.mouthWide * 0.22 - pose.mouthPucker * 0.38, 0.1 + open * 0.9, 0.3);
    R.cavity.position.y = -open * 0.052;

    for (const cheek of R.cheek) {
      const lift = pose.mouthSmile * 0.03 + pose.squint * 0.012;
      cheek.position.y = cheek.userData.base + lift;
      cheek.scale.set(1 + pose.mouthSmile * 0.16, 0.95 + pose.mouthSmile * 0.12, 0.45);
    }

    M.tooth.opacity = clamp(pose.teeth * clamp(open * 4, 0, 1) + pose.lipBite * 0.85, 0, 1);
    M.tongue.opacity = clamp(pose.tongue * clamp(open * 3, 0, 1), 0, 1);
    R.tongue.position.z = R.tongue.userData.baseZ + pose.tongue * 0.045;
  }

  return {
    kind: "procedural",
    root,
    info: { note: "built-in sculpt" },
    apply,
    dispose() {
      for (const d of disposables) d?.dispose?.();
    },
  };
}
