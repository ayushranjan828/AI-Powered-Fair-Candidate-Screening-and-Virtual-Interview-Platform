/* The 2D interviewer.
 *
 * An SVG rig - head, eyes, brows, lids, jaw, mouth, two jointed arms, torso -
 * driven by one requestAnimationFrame loop. Nothing here is a video or a sprite
 * sheet: every part is a shape whose numbers are recomputed each frame, which is
 * what lets the mouth follow real speech instead of looping a canned animation.
 *
 * Three things move the rig:
 *   1. procedural life - breathing, blinking, idle sway, micro-saccades. Runs
 *      always, so the figure never looks frozen even when nothing is happening.
 *   2. state + emotion - posture and expression, set by the app per turn.
 *   3. visemes - mouth shapes pushed in by speech.js during speech.
 *
 * Every value is smoothed toward a target rather than set directly (see `ease`),
 * so state changes read as movement instead of a jump cut.
 */
window.Avatar = (function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false;

  /* ------------------------------------------------------------- geometry */
  const G = {
    headX: 210, headY: 152, faceRX: 63, faceRY: 75,
    eyeY: 150, eyeLX: 185, eyeRX: 235, eyeRX_r: 14, eyeRY: 10,
    browY: 126,
    mouthX: 210, mouthY: 196,
    neckY: 232,
    // Shoulders sit inside the torso silhouette and the arms are drawn in front
    // of it, so the sleeves read as arms rather than vanishing into the chest.
    shoulderY: 276, shoulderLX: 148, shoulderRX: 272,
    upperArm: 54, foreArm: 56,
    deskY: 366,
  };

  /* --------------------------------------------------------------- visemes
   * Mouth shape parameters, not paths - the path is generated from these each
   * frame, so any two shapes blend cleanly on the way past each other.
   *   open  vertical opening      wide  horizontal stretch
   *   round lip rounding          tongue / teeth / bite  visible detail
   */
  const VISEMES = {
    rest: { open: 0.05, wide: 0.00, round: 0.00 },
    AA:   { open: 0.90, wide: 0.22, round: 0.00 },
    AE:   { open: 0.66, wide: 0.46, round: 0.00 },
    EE:   { open: 0.30, wide: 0.88, round: 0.00, teeth: 0.7 },
    IH:   { open: 0.34, wide: 0.48, round: 0.00 },
    OH:   { open: 0.62, wide: 0.00, round: 0.55 },
    OO:   { open: 0.26, wide: 0.00, round: 0.95 },
    UH:   { open: 0.46, wide: 0.18, round: 0.10 },
    MBP:  { open: 0.00, wide: 0.10, round: 0.05 },
    FV:   { open: 0.13, wide: 0.36, round: 0.00, bite: 1 },
    TH:   { open: 0.22, wide: 0.40, round: 0.00, tongue: 1 },
    L:    { open: 0.40, wide: 0.28, round: 0.00, tongue: 0.9 },
    SZ:   { open: 0.15, wide: 0.62, round: 0.08, teeth: 1 },
    R:    { open: 0.30, wide: 0.14, round: 0.42 },
    KG:   { open: 0.36, wide: 0.30, round: 0.00 },
    NDT:  { open: 0.26, wide: 0.36, round: 0.00, tongue: 0.5 },
    W:    { open: 0.22, wide: 0.00, round: 0.92 },
  };

  /* ---------------------------------------------------------------- states */
  // Posture per state. Arm angles are degrees; see the arm rig notes below.
  // At rest the forearms run almost horizontally so both hands land on the desk.
  const POSES = {
    idle:      { sL: 14, eL: -76, sR: -14, eR: 76, lean: 0, wristR: 0 },
    listening: { sL: 12, eL: -80, sR: -12, eR: 80, lean: 3, wristR: 0 },
    noting:    { sL: 13, eL: -78, sR: -20, eR: 74, lean: 2, wristR: 0 },
    speaking:  { sL: 15, eL: -72, sR: -26, eR: 62, lean: 1, wristR: -16 },
    // Hand up near the face - what somebody actually does while thinking.
    thinking:  { sL: 14, eL: -76, sR: -30, eR: 148, lean: 1, wristR: -34 },
    greeting:  { sL: 16, eL: -68, sR: -38, eR: 52, lean: 2, wristR: -28 },
  };

  // Expression per emotion: brow height/angle, lid openness, smile.
  const EMOTIONS = {
    neutral:     { brow: 0, browTilt: 0, lid: 1.00, smile: 0.10, squint: 0 },
    friendly:    { brow: 2, browTilt: 0, lid: 0.97, smile: 0.55, squint: 0.10 },
    curious:     { brow: 5, browTilt: -7, lid: 1.05, smile: 0.20, squint: 0 },
    encouraging: { brow: 3, browTilt: 0, lid: 0.98, smile: 0.45, squint: 0.08 },
    thinking:    { brow: -4, browTilt: 9, lid: 0.86, smile: 0.05, squint: 0.25 },
  };

  /* ------------------------------------------------------------------ state */
  const S = {
    svg: null, el: {}, raf: null, t0: 0, t: 0,
    state: "idle", emotion: "neutral",
    // current (c) and target (g) animated values
    c: { open: 0.05, wide: 0, round: 0, tongue: 0, teeth: 0, bite: 0,
         brow: 0, browTilt: 0, lid: 1, smile: 0.1, squint: 0,
         sL: 8, eL: -64, sR: -8, eR: 64, lean: 0, wristR: 0,
         gazeX: 0, gazeY: 0, headTilt: 0, nod: 0, energy: 0 },
    g: {},
    blink: { next: 1.8, closing: 0, phase: 0 },
    gaze: { next: 2.2, x: 0, y: 0 },
    nodQueue: 0, nodT: 0,
    speaking: false, level: 0, energySmooth: 0,
    gestureT: 0, gestureIdx: 0,
    notePen: 0,
  };
  S.g = Object.assign({}, S.c);

  /* ----------------------------------------------------------------- helpers */
  function make(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (parent) parent.appendChild(node);
    return node;
  }
  const rad = (deg) => (deg * Math.PI) / 180;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // Frame-rate independent exponential smoothing: `k` is roughly "fraction of
  // the way there per 60th of a second".
  function ease(cur, target, k, dt) {
    const a = 1 - Math.pow(1 - k, dt * 60);
    return cur + (target - cur) * a;
  }

  /* -------------------------------------------------------------- build SVG */
  function build(container) {
    container.innerHTML = "";
    const svg = make("svg", {
      viewBox: "0 0 420 440", class: "avatar-svg",
      preserveAspectRatio: "xMidYMax meet",
      role: "img", "aria-label": "Animated interviewer",
    }, container);
    S.svg = svg;

    const defs = make("defs", {}, svg);
    // Face shading, so the head reads as a volume rather than a flat oval.
    const faceGrad = make("radialGradient",
      { id: "avFace", cx: "0.42", cy: "0.34", r: "0.78" }, defs);
    make("stop", { offset: "0", "stop-color": "#f6d9c4" }, faceGrad);
    make("stop", { offset: "1", "stop-color": "#e3b795" }, faceGrad);

    const shirtGrad = make("linearGradient",
      { id: "avShirt", x1: "0", y1: "0", x2: "0", y2: "1" }, defs);
    make("stop", { offset: "0", "stop-color": "#4a6fd4" }, shirtGrad);
    make("stop", { offset: "1", "stop-color": "#33529f" }, shirtGrad);

    const hairGrad = make("linearGradient",
      { id: "avHair", x1: "0", y1: "0", x2: "0.3", y2: "1" }, defs);
    make("stop", { offset: "0", "stop-color": "#3b2b26" }, hairGrad);
    make("stop", { offset: "1", "stop-color": "#241813" }, hairGrad);

    // The inner mouth is clipped so teeth and tongue can never spill onto the
    // chin when the mouth is barely open.
    const clip = make("clipPath", { id: "avMouthClip" }, defs);
    S.el.mouthClipPath = make("path", { d: "" }, clip);

    /* ---- backdrop: a room, so the figure is somewhere rather than floating -- */
    const bg = make("g", { class: "av-bg" }, svg);
    make("rect", { x: 0, y: 0, width: 420, height: 440, fill: "#eef2fb" }, bg);
    make("rect", { x: 24, y: 40, width: 128, height: 96, rx: 6,
                   fill: "#dfe8fa", stroke: "#cdd9f2" }, bg);       // window
    make("line", { x1: 88, y1: 40, x2: 88, y2: 136, stroke: "#cdd9f2" }, bg);
    make("line", { x1: 24, y1: 88, x2: 152, y2: 88, stroke: "#cdd9f2" }, bg);
    make("rect", { x: 300, y: 96, width: 84, height: 58, rx: 5,
                   fill: "#e4ebf9", stroke: "#cdd9f2" }, bg);        // whiteboard
    make("path", { d: "M312 130 h26 M312 140 h44 M312 120 h34",
                   stroke: "#c3d0ea", "stroke-width": 3,
                   "stroke-linecap": "round" }, bg);
    // desk plant
    const plant = make("g", { transform: "translate(356,300)" }, bg);
    make("path", { d: "M0 40 h30 l-4 26 h-22 Z", fill: "#c98b6b" }, plant);
    make("path", { d: "M15 40 C 2 28 4 8 15 2 C 26 8 28 28 15 40 Z",
                   fill: "#63a97f" }, plant);
    make("path", { d: "M15 40 C 0 34 -8 18 -2 12 C 8 14 14 28 15 40 Z",
                   fill: "#4f9a6e" }, plant);
    make("path", { d: "M15 40 C 30 34 38 18 32 12 C 22 14 16 28 15 40 Z",
                   fill: "#57a375" }, plant);

    /* ---- body ------------------------------------------------------------ */
    const body = make("g", { id: "avBody" }, svg);
    S.el.body = body;

    // neck first, so the collar overlaps it
    make("path", { d: `M194 ${G.neckY - 16} h32 v26 c 0 12 -32 12 -32 0 Z`,
                   fill: "#dbab88" }, body);

    // torso
    make("path", {
      d: `M${G.shoulderLX - 22} ${G.deskY}
          C ${G.shoulderLX - 14} ${G.shoulderY + 6} ${G.shoulderLX + 4} ${G.shoulderY - 22} 210 ${G.shoulderY - 26}
          C ${G.shoulderRX - 4} ${G.shoulderY - 22} ${G.shoulderRX + 14} ${G.shoulderY + 6} ${G.shoulderRX + 22} ${G.deskY} Z`,
      fill: "url(#avShirt)",
    }, body);
    // collar + neckline
    make("path", { d: `M188 ${G.shoulderY - 28} L210 ${G.shoulderY + 6} L232 ${G.shoulderY - 28}
                       C 224 ${G.shoulderY - 36} 196 ${G.shoulderY - 36} 188 ${G.shoulderY - 28} Z`,
                   fill: "#f2f5ff" }, body);
    // lanyard, because an interviewer in an office has a badge
    make("path", { d: `M196 ${G.shoulderY - 22} C 200 ${G.shoulderY + 30} 220 ${G.shoulderY + 30} 224 ${G.shoulderY - 22}`,
                   fill: "none", stroke: "#2c3f77", "stroke-width": 4 }, body);
    make("rect", { x: 200, y: G.shoulderY + 26, width: 22, height: 15, rx: 2.5,
                   fill: "#f2f5ff", stroke: "#c9d4ef" }, body);

    /* ---- head ------------------------------------------------------------ */
    const head = make("g", { id: "avHead" }, svg);
    S.el.head = head;

    make("path", { d: `M${G.headX - 66} ${G.headY - 6}
                       C ${G.headX - 74} ${G.headY - 86} ${G.headX + 74} ${G.headY - 86} ${G.headX + 66} ${G.headY - 6}
                       C ${G.headX + 58} ${G.headY - 60} ${G.headX - 58} ${G.headY - 60} ${G.headX - 66} ${G.headY - 6} Z`,
                   fill: "url(#avHair)" }, head);                    // hair, back
    make("ellipse", { cx: G.headX - 62, cy: G.headY + 8, rx: 8, ry: 13,
                      fill: "#e8bd9a" }, head);                      // ears
    make("ellipse", { cx: G.headX + 62, cy: G.headY + 8, rx: 8, ry: 13,
                      fill: "#e8bd9a" }, head);
    make("ellipse", { cx: G.headX, cy: G.headY, rx: G.faceRX, ry: G.faceRY,
                      fill: "url(#avFace)" }, head);                  // face

    // fringe
    make("path", { d: `M${G.headX - 64} ${G.headY - 22}
                       C ${G.headX - 60} ${G.headY - 78} ${G.headX + 60} ${G.headY - 78} ${G.headX + 64} ${G.headY - 22}
                       C ${G.headX + 40} ${G.headY - 56} ${G.headX + 6} ${G.headY - 40} ${G.headX - 14} ${G.headY - 54}
                       C ${G.headX - 34} ${G.headY - 40} ${G.headX - 52} ${G.headY - 44} ${G.headX - 64} ${G.headY - 22} Z`,
                   fill: "url(#avHair)" }, head);

    // brows
    S.el.browL = make("path", {
      d: `M${G.eyeLX - 17} ${G.browY + 3} Q ${G.eyeLX} ${G.browY - 6} ${G.eyeLX + 16} ${G.browY + 1}`,
      fill: "none", stroke: "#4a332b", "stroke-width": 4.4, "stroke-linecap": "round",
    }, head);
    S.el.browR = make("path", {
      d: `M${G.eyeRX - 16} ${G.browY + 1} Q ${G.eyeRX} ${G.browY - 6} ${G.eyeRX + 17} ${G.browY + 3}`,
      fill: "none", stroke: "#4a332b", "stroke-width": 4.4, "stroke-linecap": "round",
    }, head);

    S.el.eyeL = buildEye(head, G.eyeLX);
    S.el.eyeR = buildEye(head, G.eyeRX);

    // Nose: a soft shadow for volume plus a base curve and two nostrils. Drawn
    // this way rather than as one long stroke, which reads as a scar.
    make("ellipse", { cx: G.headX, cy: G.headY + 18, rx: 7, ry: 9.5,
                      fill: "#dcae8c", opacity: 0.32 }, head);
    make("path", { d: `M${G.headX - 10} ${G.headY + 26} q 10 6 20 0`,
                   fill: "none", stroke: "#c9997a", "stroke-width": 2.4,
                   "stroke-linecap": "round" }, head);
    make("ellipse", { cx: G.headX - 6, cy: G.headY + 26, rx: 2.1, ry: 1.5,
                      fill: "#b9835f" }, head);
    make("ellipse", { cx: G.headX + 6, cy: G.headY + 26, rx: 2.1, ry: 1.5,
                      fill: "#b9835f" }, head);

    /* ---- mouth ----------------------------------------------------------- */
    const mouth = make("g", { id: "avMouth" }, head);
    S.el.mouth = mouth;
    S.el.mouthOuter = make("path", { d: "", fill: "#c96a68" }, mouth);
    S.el.mouthInner = make("path", { d: "", fill: "#5e2a30" }, mouth);
    const clipped = make("g", { "clip-path": "url(#avMouthClip)" }, mouth);
    S.el.teeth = make("rect", { x: G.mouthX - 26, y: G.mouthY - 16, width: 52,
                                height: 11, rx: 3, fill: "#fdfcfa", opacity: 0 }, clipped);
    S.el.tongue = make("ellipse", { cx: G.mouthX, cy: G.mouthY + 9, rx: 16, ry: 8,
                                    fill: "#d1707a", opacity: 0 }, clipped);
    S.el.lipLine = make("path", { d: "", fill: "none", stroke: "#b05a5c",
                                  "stroke-width": 1.6, "stroke-linecap": "round" }, mouth);

    // headset - reads instantly as "this person is interviewing you"
    const set = make("g", { id: "avHeadset" }, head);
    make("path", { d: `M${G.headX - 66} ${G.headY - 4}
                       C ${G.headX - 70} ${G.headY - 74} ${G.headX + 70} ${G.headY - 74} ${G.headX + 66} ${G.headY - 4}`,
                   fill: "none", stroke: "#3b4a63", "stroke-width": 6,
                   "stroke-linecap": "round" }, set);
    make("rect", { x: G.headX - 76, y: G.headY - 12, width: 15, height: 30, rx: 7,
                   fill: "#2f3c52" }, set);
    make("rect", { x: G.headX + 61, y: G.headY - 12, width: 15, height: 30, rx: 7,
                   fill: "#2f3c52" }, set);
    make("path", { d: `M${G.headX + 68} ${G.headY + 16} q -4 26 -30 30`,
                   fill: "none", stroke: "#2f3c52", "stroke-width": 4,
                   "stroke-linecap": "round" }, set);
    S.el.micBead = make("circle", { cx: G.headX + 40, cy: G.headY + 47, r: 5,
                                    fill: "#2f3c52" }, set);

    /* ---- desk, then the arms on top of it -------------------------------- */
    const desk = make("g", {}, svg);
    make("rect", { x: 0, y: G.deskY, width: 420, height: 440 - G.deskY,
                   fill: "#cfd9ee" }, desk);
    make("rect", { x: 0, y: G.deskY, width: 420, height: 7, fill: "#bcc9e4" }, desk);
    // Notepad, placed where the writing hand actually lands.
    const pad = make("g", { transform: `translate(196,${G.deskY + 12})` }, desk);
    make("rect", { x: 0, y: 0, width: 80, height: 48, rx: 3,
                   fill: "#fdfdff", stroke: "#c3cee6" }, pad);
    S.el.padLines = make("path", { d: "M8 12 h40 M8 22 h52 M8 32 h30",
                                   stroke: "#d5deef", "stroke-width": 2.5,
                                   "stroke-linecap": "round", fill: "none" }, pad);

    // Arms last: in front of the chest and resting on the desk, which is how a
    // seated person actually reads. Built into their own group so they inherit
    // the same breathing offset as the torso and stay attached at the shoulder.
    const arms = make("g", { id: "avArms" }, svg);
    S.el.arms = arms;
    S.el.armL = buildArm(arms, "L");
    S.el.armR = buildArm(arms, "R");

    updateMouth();
    return svg;
  }

  /* Eye: sclera, iris that tracks gaze, pupil, catch-light, and a lid that
   * scales down over the top for blinking. */
  function buildEye(parent, cx) {
    const group = make("g", {}, parent);
    make("ellipse", { cx, cy: G.eyeY, rx: G.eyeRX_r, ry: G.eyeRY,
                      fill: "#fdfdff", stroke: "#cbb4a4", "stroke-width": 0.8 }, group);
    const iris = make("g", {}, group);
    make("circle", { cx, cy: G.eyeY, r: 6.6, fill: "#4a3a2c" }, iris);
    make("circle", { cx, cy: G.eyeY, r: 3.1, fill: "#171017" }, iris);
    make("circle", { cx: cx - 2.4, cy: G.eyeY - 2.6, r: 1.9, fill: "#ffffff",
                     opacity: 0.9 }, iris);
    const lid = make("ellipse", { cx, cy: G.eyeY, rx: G.eyeRX_r + 1.4,
                                  ry: G.eyeRY + 1.4, fill: "#eec3a1" }, group);
    const lower = make("path", {
      d: `M${cx - G.eyeRX_r} ${G.eyeY + 3} q ${G.eyeRX_r} 6 ${G.eyeRX_r * 2} 0`,
      fill: "none", stroke: "#d6a882", "stroke-width": 1.4,
    }, group);
    return { group, iris, lid, lower, cx };
  }

  /* Arm rig: two nested rotations, shoulder then elbow, plus a wrist. Angle 0
   * is straight down; positive rotates clockwise on screen. So the right arm
   * brings its hand toward the middle of the desk at a positive elbow angle,
   * and the left arm at a negative one. */
  function buildArm(parent, side) {
    const isRight = side === "R";
    const x = isRight ? G.shoulderRX : G.shoulderLX;
    const shoulder = make("g", { transform: `translate(${x},${G.shoulderY})` }, parent);
    make("path", { d: `M-11 0 q 11 -8 22 0 l -2 ${G.upperArm} q -9 6 -18 0 Z`,
                   fill: "#3f61bd" }, shoulder);
    const elbow = make("g", { transform: `translate(0,${G.upperArm})` }, shoulder);
    make("path", { d: `M-9 0 q 9 -6 18 0 l -2 ${G.foreArm} q -7 5 -14 0 Z`,
                   fill: "#4a6fd4" }, elbow);
    make("rect", { x: -8, y: G.foreArm - 12, width: 16, height: 9, rx: 2,
                   fill: "#f2f5ff" }, elbow);                       // cuff
    const wrist = make("g", { transform: `translate(0,${G.foreArm})` }, elbow);
    if (isRight) {
      // The pen is part of the hand, so it swings with the writing motion.
      make("path", { d: "M-2 -2 l -13 20", stroke: "#2f3c52", "stroke-width": 3.4,
                     "stroke-linecap": "round" }, wrist);
    }
    make("ellipse", { cx: 0, cy: 6, rx: 9.5, ry: 11, fill: "#e8bd9a" }, wrist);
    make("path", { d: "M-7 12 q 7 7 14 0", fill: "none", stroke: "#d2a17f",
                   "stroke-width": 1.6, "stroke-linecap": "round" }, wrist);
    return { shoulder, elbow, wrist };
  }

  /* -------------------------------------------------------- mouth rendering */
  function updateMouth() {
    const c = S.c;
    const open = clamp(c.open, 0, 1);
    const halfW = 25 * (1 + 0.34 * c.wide - 0.46 * c.round);
    const up = 2 + open * 17;
    const down = 3 + open * 24;
    const smile = c.smile * 7;

    // Corners lift with the smile; the top and bottom lips bow apart with `open`.
    const lx = G.mouthX - halfW, rx = G.mouthX + halfW;
    const cy = G.mouthY;
    const inner =
      `M${lx.toFixed(1)} ${(cy - smile).toFixed(1)} ` +
      `Q ${G.mouthX} ${(cy - up - smile * 0.4).toFixed(1)} ${rx.toFixed(1)} ${(cy - smile).toFixed(1)} ` +
      `Q ${G.mouthX} ${(cy + down).toFixed(1)} ${lx.toFixed(1)} ${(cy - smile).toFixed(1)} Z`;

    const outer =
      `M${(lx - 3).toFixed(1)} ${(cy - smile).toFixed(1)} ` +
      `Q ${G.mouthX} ${(cy - up - 5 - smile * 0.4).toFixed(1)} ${(rx + 3).toFixed(1)} ${(cy - smile).toFixed(1)} ` +
      `Q ${G.mouthX} ${(cy + down + 5).toFixed(1)} ${(lx - 3).toFixed(1)} ${(cy - smile).toFixed(1)} Z`;

    S.el.mouthInner.setAttribute("d", inner);
    S.el.mouthOuter.setAttribute("d", outer);
    S.el.mouthClipPath.setAttribute("d", inner);
    S.el.lipLine.setAttribute("d",
      `M${(lx - 2).toFixed(1)} ${(cy - smile).toFixed(1)} Q ${G.mouthX} ${(cy - up - smile * 0.4 - 1).toFixed(1)} ${(rx + 2).toFixed(1)} ${(cy - smile).toFixed(1)}`);

    // Teeth show on wide/closed shapes, tongue on the ones that need it.
    // Kept near-opaque when visible: a half-transparent white over the dark
    // mouth reads as a grey slab rather than as teeth.
    S.el.teeth.setAttribute(
      "opacity", (clamp(c.teeth * 1.5, 0, 1) * clamp(open * 4, 0, 1)).toFixed(2));
    S.el.teeth.setAttribute("y", (cy - up + 1).toFixed(1));
    S.el.tongue.setAttribute("opacity", (c.tongue * clamp(open * 3, 0, 1) * 0.95).toFixed(2));
    S.el.tongue.setAttribute("cy", (cy + down * 0.55).toFixed(1));
    S.el.tongue.setAttribute("rx", (halfW * 0.6).toFixed(1));

    // The lip-bite shape (f / v) pulls the lower lip under the teeth.
    S.el.mouthOuter.setAttribute("fill", c.bite > 0.4 ? "#bd5f61" : "#c96a68");
  }

  /* --------------------------------------------------------------- the loop */
  function frame(now) {
    const t = now / 1000;
    let dt = S.t ? t - S.t : 0.016;
    S.t = t;
    // A backgrounded tab returns a huge dt; clamping stops the rig snapping.
    dt = clamp(dt, 0.001, 0.05);
    const life = reduceMotion ? 0.35 : 1;

    const pose = POSES[S.state] || POSES.idle;
    const emo = EMOTIONS[S.emotion] || EMOTIONS.neutral;

    /* -- posture -- */
    for (const key of ["sL", "eL", "sR", "eR", "lean", "wristR"]) {
      S.g[key] = pose[key];
    }
    // While speaking, the free hand keeps time with the voice. Beat gestures
    // land on loud syllables, which is what makes speech look intentional.
    if (S.speaking) {
      S.energySmooth = ease(S.energySmooth, S.c.open, 0.25, dt);
      const beat = S.energySmooth * 12 * life;
      S.g.eR = pose.eR - beat;
      S.g.sR = pose.sR - beat * 0.35;
      S.g.wristR = pose.wristR - beat * 1.1;
      // Cycle through a couple of postures to avoid one frozen gesture.
      S.gestureT += dt;
      if (S.gestureT > 5.5) { S.gestureT = 0; S.gestureIdx = (S.gestureIdx + 1) % 3; }
      const swing = [0, -10, 6][S.gestureIdx];
      S.g.sR += swing * life;
      S.g.eR += swing * 0.5 * life;
    } else {
      S.energySmooth = ease(S.energySmooth, 0, 0.12, dt);
    }
    // Writing on the pad while listening.
    if (S.state === "noting") {
      S.notePen += dt * 6;
      S.g.wristR = pose.wristR + Math.sin(S.notePen) * 9;
      S.g.eR = pose.eR + Math.sin(S.notePen * 0.7) * 3;
    }

    for (const key of ["sL", "eL", "sR", "eR", "lean", "wristR"]) {
      S.c[key] = ease(S.c[key], S.g[key], 0.12, dt);
    }

    /* -- expression -- */
    S.g.brow = emo.brow + (S.speaking ? S.energySmooth * 2.5 : 0);
    S.g.browTilt = emo.browTilt;
    S.g.smile = emo.smile;
    S.g.squint = emo.squint;
    for (const key of ["brow", "browTilt", "smile", "squint"]) {
      S.c[key] = ease(S.c[key], S.g[key], 0.10, dt);
    }

    /* -- blinking -- */
    S.blink.next -= dt;
    if (S.blink.next <= 0 && S.blink.closing <= 0) {
      S.blink.closing = 0.16;
      S.blink.phase = 0;
      // Blinks cluster; a fixed interval reads as a metronome.
      S.blink.next = 2.2 + Math.random() * 4.2;
      if (Math.random() < 0.16) S.blink.next = 0.28;   // occasional double blink
    }
    let lidClose = 0;
    if (S.blink.closing > 0) {
      S.blink.phase += dt;
      const half = 0.08;
      lidClose = S.blink.phase < half
        ? S.blink.phase / half
        : clamp(1 - (S.blink.phase - half) / 0.1, 0, 1);
      if (S.blink.phase > half + 0.1) S.blink.closing = 0;
    }
    const lidOpen = clamp(emo.lid - S.c.squint * 0.35, 0.1, 1.2) * (1 - lidClose);

    /* -- gaze: mostly at the camera, with small saccades -- */
    S.gaze.next -= dt;
    if (S.gaze.next <= 0) {
      S.gaze.next = 1.4 + Math.random() * 3.4;
      if (S.state === "thinking") {
        // Looking away while thinking is what people actually do.
        S.gaze.x = (Math.random() - 0.5) * 5.5;
        S.gaze.y = -2.2 - Math.random() * 1.6;
      } else if (S.state === "noting" && Math.random() < 0.6) {
        S.gaze.x = -1.6; S.gaze.y = 2.6;             // down at the pad
      } else {
        S.gaze.x = (Math.random() - 0.5) * 2.2;
        S.gaze.y = (Math.random() - 0.5) * 1.4;
      }
    }
    S.c.gazeX = ease(S.c.gazeX, S.gaze.x * life, 0.22, dt);
    S.c.gazeY = ease(S.c.gazeY, S.gaze.y * life, 0.22, dt);

    /* -- head: idle sway, nods, tilt -- */
    const sway = Math.sin(t * 0.83) * 1.5 + Math.sin(t * 0.31 + 1.1) * 1.1;
    const swayY = Math.sin(t * 0.62 + 0.4) * 1.0;
    if (S.nodQueue > 0 && S.nodT <= 0) { S.nodT = 0.75; S.nodQueue -= 1; }
    let nod = 0;
    if (S.nodT > 0) {
      S.nodT -= dt;
      nod = Math.sin((0.75 - S.nodT) / 0.75 * Math.PI * 2) * 4.5;
    }
    const tiltTarget = (S.emotion === "curious" ? -4 : S.emotion === "thinking" ? 3.5 : 0);
    S.c.headTilt = ease(S.c.headTilt, tiltTarget, 0.06, dt);

    const headX = sway * life + S.c.gazeX * 0.5;
    const headY = swayY * life + nod * life + S.c.lean * 0.6;
    S.el.head.setAttribute(
      "transform",
      `translate(${headX.toFixed(2)},${headY.toFixed(2)}) ` +
      `rotate(${(S.c.headTilt * life).toFixed(2)},${G.headX},${G.headY + 60})`
    );

    /* -- torso: breathing + lean -- */
    const breathe = Math.sin(t * 0.9) * 1.1 * life;
    const bodyShift =
      `translate(${(sway * 0.35 * life).toFixed(2)},${(breathe + S.c.lean * 0.8).toFixed(2)})`;
    S.el.body.setAttribute("transform", bodyShift);
    // The arms live in their own group (they are drawn in front of the desk) so
    // they need the same shift, or the shoulders detach on every breath.
    S.el.arms.setAttribute("transform", bodyShift);

    /* -- eyes -- */
    for (const eye of [S.el.eyeL, S.el.eyeR]) {
      eye.iris.setAttribute("transform",
        `translate(${S.c.gazeX.toFixed(2)},${S.c.gazeY.toFixed(2)})`);
      // The lid is an eyelid-coloured ellipse scaled down from the top.
      const ry = (G.eyeRY + 1.4) * (1 - lidOpen) + 0.4;
      eye.lid.setAttribute("ry", ry.toFixed(2));
      eye.lid.setAttribute("cy", (G.eyeY - (G.eyeRY + 1.4) + ry).toFixed(2));
      eye.lower.setAttribute("opacity", (0.35 + S.c.squint * 0.65).toFixed(2));
    }

    /* -- brows -- */
    S.el.browL.setAttribute("transform",
      `translate(0,${(-S.c.brow).toFixed(2)}) rotate(${(S.c.browTilt).toFixed(2)},${G.eyeLX},${G.browY})`);
    S.el.browR.setAttribute("transform",
      `translate(0,${(-S.c.brow).toFixed(2)}) rotate(${(-S.c.browTilt).toFixed(2)},${G.eyeRX},${G.browY})`);

    /* -- arms -- */
    S.el.armL.shoulder.setAttribute("transform",
      `translate(${G.shoulderLX},${G.shoulderY}) rotate(${S.c.sL.toFixed(2)})`);
    S.el.armL.elbow.setAttribute("transform",
      `translate(0,${G.upperArm}) rotate(${S.c.eL.toFixed(2)})`);
    S.el.armR.shoulder.setAttribute("transform",
      `translate(${G.shoulderRX},${G.shoulderY}) rotate(${S.c.sR.toFixed(2)})`);
    S.el.armR.elbow.setAttribute("transform",
      `translate(0,${G.upperArm}) rotate(${S.c.eR.toFixed(2)})`);
    S.el.armR.wrist.setAttribute("transform",
      `translate(0,${G.foreArm}) rotate(${S.c.wristR.toFixed(2)})`);

    /* -- mouth -- */
    // When not speaking the mouth settles to a closed, slightly smiling rest.
    if (!S.speaking) {
      S.g.open = 0.04; S.g.wide = 0; S.g.round = 0;
      S.g.tongue = 0; S.g.teeth = 0; S.g.bite = 0;
    }
    for (const key of ["open", "wide", "round", "tongue", "teeth", "bite"]) {
      // Visemes must move fast or speech looks dubbed; posture can be slow.
      S.c[key] = ease(S.c[key], S.g[key], S.speaking ? 0.42 : 0.14, dt);
    }
    updateMouth();

    // Mic bead glows during speech.
    S.el.micBead.setAttribute("fill", S.speaking ? "#3ec27f" : "#2f3c52");

    S.raf = requestAnimationFrame(frame);
  }

  /* -------------------------------------------------------------- public API */
  return {
    mount(container) {
      build(container);
      if (S.raf) cancelAnimationFrame(S.raf);
      S.t = 0;
      S.raf = requestAnimationFrame(frame);
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
    isReady() { return Boolean(S.svg); },

    visemeNames() { return Object.keys(VISEMES); },
  };
})();
