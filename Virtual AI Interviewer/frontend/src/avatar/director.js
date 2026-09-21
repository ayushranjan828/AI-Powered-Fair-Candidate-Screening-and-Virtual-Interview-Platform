/* The director: everything the interviewer *does*, expressed as numbers and
 * nothing else. No three.js, no geometry, no morph targets.
 *
 * This is the layer that keeps the application independent of any one model.
 * The app pushes states, emotions and visemes in; the director folds them
 * together with the procedural life that runs regardless (breathing, blinking,
 * saccades, nods, gesture beats) and produces one canonical pose per frame. A
 * rig - the built-in sculpt, or a GLB with morph targets - then decides how to
 * express that pose. Swapping the model changes the rig, never this file.
 *
 * Every value is eased toward its target rather than assigned, so a state
 * change reads as movement rather than a jump cut.
 */

import { clamp, ease, TAU } from "./math.js";

/* --------------------------------------------------------------- visemes
 * Mouth *parameters*, not poses, so any two shapes blend on the way past.
 *   open  jaw drop      wide  lip stretch      round  lip pucker
 *   tongue / teeth / bite  visible detail
 */
export const VISEMES = {
  rest: { open: 0.04, wide: 0.00, round: 0.00 },
  AA: { open: 0.92, wide: 0.22, round: 0.00 },
  AE: { open: 0.66, wide: 0.46, round: 0.00 },
  EE: { open: 0.28, wide: 0.90, round: 0.00, teeth: 0.7 },
  IH: { open: 0.34, wide: 0.48, round: 0.00 },
  OH: { open: 0.62, wide: 0.00, round: 0.55 },
  OO: { open: 0.24, wide: 0.00, round: 0.95 },
  UH: { open: 0.46, wide: 0.18, round: 0.10 },
  MBP: { open: 0.00, wide: 0.10, round: 0.05 },
  FV: { open: 0.12, wide: 0.36, round: 0.00, bite: 1 },
  TH: { open: 0.22, wide: 0.40, round: 0.00, tongue: 1 },
  L: { open: 0.40, wide: 0.28, round: 0.00, tongue: 0.9 },
  SZ: { open: 0.14, wide: 0.62, round: 0.08, teeth: 1 },
  R: { open: 0.30, wide: 0.14, round: 0.42 },
  KG: { open: 0.36, wide: 0.30, round: 0.00 },
  NDT: { open: 0.26, wide: 0.36, round: 0.00, tongue: 0.5 },
  W: { open: 0.22, wide: 0.00, round: 0.92 },
};

/* ---------------------------------------------------------------- poses
 * Joint targets per state, in radians:
 *   shPitch  + swings the arm forward and up      elbow  + bends
 *   shRoll   + takes the elbow away from the body wrist  + flexes the hand
 *   shYaw    - turns the forearm across the chest
 *
 * The crop is a portrait, so a hand only reads once it comes up into shot. At
 * rest the hands hang below the bottom edge, exactly as they would on a real
 * video call; the gesturing poses fold the elbow to bring one hand up in front
 * of the chest. Each was solved backwards from where the hand should land on
 * screen, under the constraint that the elbow stays outside the jacket.
 */
export const POSES = {
  idle: {
    lean: 0.0, headPitch: 0.0, headYaw: 0.0,
    shPitchL: 0.06, shYawL: 0.0, shRollL: 0.16, elbowL: 0.55, wristL: 0.0,
    shPitchR: 0.06, shYawR: 0.0, shRollR: 0.16, elbowR: 0.55, wristR: 0.0,
  },
  listening: {
    lean: 0.06, headPitch: 0.02, headYaw: 0.0,
    shPitchL: 0.1, shYawL: 0.0, shRollL: 0.15, elbowL: 0.72, wristL: 0.0,
    shPitchR: 0.1, shYawR: 0.0, shRollR: 0.15, elbowR: 0.72, wristR: 0.0,
  },
  // Head down toward a pad, writing hand busy just inside the frame.
  noting: {
    lean: 0.08, headPitch: 0.17, headYaw: -0.09,
    shPitchL: 0.12, shYawL: 0.0, shRollL: 0.14, elbowL: 0.78, wristL: 0.0,
    shPitchR: 0.18, shYawR: -0.24, shRollR: -0.31, elbowR: 1.94, wristR: 0.3,
  },
  // One hand up and open - beat gestures ride on top of this.
  speaking: {
    lean: 0.02, headPitch: -0.02, headYaw: 0.0,
    shPitchL: 0.08, shYawL: 0.0, shRollL: 0.15, elbowL: 0.62, wristL: 0.0,
    shPitchR: 0.64, shYawR: -0.25, shRollR: -0.28, elbowR: 2.02, wristR: 0.22,
  },
  // Hand to the chin. What somebody actually does while thinking.
  thinking: {
    lean: 0.03, headPitch: 0.06, headYaw: 0.1,
    shPitchL: 0.08, shYawL: 0.0, shRollL: 0.14, elbowL: 0.64, wristL: 0.0,
    shPitchR: 0.96, shYawR: -0.42, shRollR: -0.35, elbowR: 1.91, wristR: 0.34,
  },
  // A small raised-palm hello.
  greeting: {
    lean: 0.05, headPitch: -0.06, headYaw: 0.0,
    shPitchL: 0.08, shYawL: 0.0, shRollL: 0.15, elbowL: 0.62, wristL: 0.0,
    shPitchR: 1.23, shYawR: -0.12, shRollR: -0.13, elbowR: 2.04, wristR: -0.1,
  },
};

const POSE_KEYS = [
  "lean", "headPitch", "headYaw",
  "shPitchL", "shYawL", "shRollL", "elbowL", "wristL",
  "shPitchR", "shYawR", "shRollR", "elbowR", "wristR",
];

/** Expression per emotion: brow height/angle, lid openness, smile, squint. */
export const EMOTIONS = {
  neutral: { brow: 0.0, browTilt: 0.0, lid: 1.0, smile: 0.12, squint: 0.0 },
  friendly: { brow: 0.3, browTilt: 0.0, lid: 0.96, smile: 0.62, squint: 0.14 },
  curious: { brow: 0.62, browTilt: -0.2, lid: 1.08, smile: 0.24, squint: 0.0 },
  encouraging: { brow: 0.4, browTilt: 0.0, lid: 0.98, smile: 0.5, squint: 0.1 },
  thinking: { brow: -0.32, browTilt: 0.26, lid: 0.84, smile: 0.04, squint: 0.26 },
};

const MOUTH_KEYS = ["open", "wide", "round", "tongue", "teeth", "bite"];

export function createDirector({ reduceMotion = false } = {}) {
  const rest = {
    open: 0.04, wide: 0, round: 0, tongue: 0, teeth: 0, bite: 0,
    brow: 0, browTilt: 0, lid: 1, smile: 0.12, squint: 0,
    gazeX: 0, gazeY: 0, headTilt: 0,
  };
  for (const key of POSE_KEYS) rest[key] = POSES.idle[key];

  const S = {
    state: "idle",
    emotion: "neutral",
    c: { ...rest },   // current, eased
    g: { ...rest },   // goal
    blink: { next: 1.8, closing: 0, phase: 0 },
    gaze: { next: 2.2, x: 0, y: 0 },
    ear: { next: 4, t: 0, side: 1 },
    nodQueue: 0,
    nodT: 0,
    speaking: false,
    level: 0,
    levelSmooth: 0,
    energySmooth: 0,
    gestureT: 0,
    gestureIdx: 0,
    notePen: 0,
    wave: 0,
    clock: 0,
    viseme: "rest",
    visemeAmp: 0,
  };

  // The pose object is reused every frame; allocating one per frame would hand
  // the garbage collector 60 objects a second for no reason.
  const pose = {
    jawOpen: 0, mouthWide: 0, mouthPucker: 0, mouthSmile: 0,
    tongue: 0, teeth: 0, lipBite: 0,
    lidOpen: 1, blink: 0, squint: 0, gazeX: 0, gazeY: 0,
    browRaise: 0, browTilt: 0,
    headPitch: 0, headYaw: 0, headRoll: 0,
    breath: 0, lean: 0, earTwitch: 0, earSide: 0,
    speaking: false, state: "idle", emotion: "neutral", viseme: "rest", visemeAmp: 0,
    arms: {
      l: { pitch: 0, yaw: 0, roll: 0, elbow: 0, wrist: 0 },
      r: { pitch: 0, yaw: 0, roll: 0, elbow: 0, wrist: 0 },
    },
  };

  return {
    /* ------------------------------------------------------ inputs (the API) */
    setState(state) {
      if (POSES[state]) S.state = state;
      S.speaking = state === "speaking" || state === "greeting";
      if (!S.speaking) S.gestureT = 0;
    },
    setEmotion(emotion) {
      if (EMOTIONS[emotion]) S.emotion = emotion;
    },
    setViseme(name, intensity = 1) {
      const v = VISEMES[name] || VISEMES.rest;
      S.speaking = true;
      // Kept alongside the parameters because a model that ships Oculus-style
      // `viseme_*` blendshapes wants the name, not a jaw angle.
      S.viseme = VISEMES[name] ? name : "rest";
      S.visemeAmp = intensity;
      S.g.open = (v.open || 0) * intensity;
      S.g.wide = v.wide || 0;
      S.g.round = v.round || 0;
      S.g.tongue = v.tongue || 0;
      S.g.teeth = v.teeth || 0;
      S.g.bite = v.bite || 0;
    },
    stopSpeaking() {
      S.speaking = false;
      S.viseme = "rest";
      S.visemeAmp = 0;
      if (S.state === "speaking" || S.state === "greeting") S.state = "idle";
    },
    pulse(level) {
      S.level = clamp(level || 0, 0, 1);
      if (S.level > 0.45 && Math.random() < 0.012) this.nod();
    },
    nod(times = 1) {
      S.nodQueue = Math.min(4, S.nodQueue + times);
    },
    get state() {
      return S.state;
    },

    /* ------------------------------------------------------------ the frame */
    update(dt) {
      S.clock += dt;
      const t = S.clock;
      const life = reduceMotion ? 0.35 : 1;
      const posture = POSES[S.state] || POSES.idle;
      const emo = EMOTIONS[S.emotion] || EMOTIONS.neutral;
      const c = S.c;
      const g = S.g;

      /* -- posture -- */
      for (const key of POSE_KEYS) g[key] = posture[key];

      // While speaking, the free hand keeps time with the voice: beats land on
      // loud syllables, which is what makes speech look intentional rather than
      // like a puppet with a moving mouth.
      if (S.speaking) {
        S.energySmooth = ease(S.energySmooth, c.open, 0.25, dt);
        const beat = S.energySmooth * life;
        g.elbowR = posture.elbowR + beat * 0.3;
        g.shPitchR = posture.shPitchR + beat * 0.16;
        g.wristR = posture.wristR - beat * 0.34;
        // Cycle a few postures so one gesture is not held for a whole answer.
        S.gestureT += dt;
        if (S.gestureT > 5.5) {
          S.gestureT = 0;
          S.gestureIdx = (S.gestureIdx + 1) % 3;
        }
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
        g.wristR = posture.wristR + Math.sin(S.notePen) * 0.16;
        g.elbowR = posture.elbowR + Math.sin(S.notePen * 0.7) * 0.05;
      }

      // A hello wave, for the first turn of an interview.
      if (S.state === "greeting") {
        S.wave += dt * 7 * life;
        g.shRollR = posture.shRollR + Math.sin(S.wave) * 0.26;
        g.wristR = posture.wristR + Math.sin(S.wave) * 0.18;
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
        c[key] = ease(c[key], g[key], 0.1, dt);
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
          S.gaze.x = -0.22;
          S.gaze.y = 0.4;                                  // down at the pad
        } else {
          S.gaze.x = (Math.random() - 0.5) * 0.34;
          S.gaze.y = (Math.random() - 0.5) * 0.22;
        }
      }
      c.gazeX = ease(c.gazeX, S.gaze.x * life, 0.22, dt);
      c.gazeY = ease(c.gazeY, S.gaze.y * life, 0.22, dt);

      /* -- head: idle drift, nods, tilt -- */
      if (S.nodQueue > 0 && S.nodT <= 0) {
        S.nodT = 0.75;
        S.nodQueue -= 1;
      }
      let nod = 0;
      if (S.nodT > 0) {
        S.nodT -= dt;
        nod = Math.sin(((0.75 - S.nodT) / 0.75) * TAU) * 0.13;
      }
      const tiltTarget = S.emotion === "curious" ? -0.11 : S.emotion === "thinking" ? 0.09 : 0;
      c.headTilt = ease(c.headTilt, tiltTarget, 0.06, dt);

      const driftY = (Math.sin(t * 0.31) * 0.03 + Math.sin(t * 0.83 + 1.1) * 0.016) * life;
      const driftX = Math.sin(t * 0.62 + 0.4) * 0.018 * life;

      /* -- ears: an occasional twitch, because a still ear looks like plastic -- */
      S.ear.next -= dt;
      if (S.ear.next <= 0 && S.ear.t <= 0) {
        S.ear.t = 0.4;
        S.ear.side = Math.random() < 0.5 ? 0 : 1;
        S.ear.next = 5 + Math.random() * 9;
      }
      let twitch = 0;
      if (S.ear.t > 0) {
        twitch = Math.sin(((0.4 - S.ear.t) / 0.4) * TAU * 2) * 0.13 * life;
        S.ear.t -= dt;
      }

      /* -- mouth -- */
      for (const key of MOUTH_KEYS) {
        c[key] = ease(c[key], S.speaking ? g[key] : key === "open" ? 0.04 : 0, 0.3, dt);
      }

      /* -- publish the canonical pose -- */
      pose.jawOpen = clamp(c.open, 0, 1);
      pose.mouthWide = c.wide;
      pose.mouthPucker = c.round;
      pose.mouthSmile = c.smile;
      pose.tongue = c.tongue;
      pose.teeth = c.teeth;
      pose.lipBite = c.bite;

      pose.lidOpen = lidOpen;
      pose.blink = clamp(1 - lidOpen, 0, 1);
      pose.squint = c.squint;
      pose.gazeX = c.gazeX;
      pose.gazeY = c.gazeY;

      pose.browRaise = c.brow;
      pose.browTilt = c.browTilt;

      pose.headPitch = c.headPitch + driftX + nod * life + c.gazeY * 0.3;
      pose.headYaw = c.headYaw + driftY + c.gazeX * 0.45;
      pose.headRoll = c.headTilt * life;

      pose.breath = Math.sin(t * 0.9) * life;
      pose.lean = c.lean;
      pose.sway = Math.sin(t * 0.41) * life;
      pose.swayYaw = Math.sin(t * 0.27 + 0.7) * life;
      pose.earTwitch = twitch;
      pose.earSide = S.ear.side;

      pose.viseme = S.speaking ? S.viseme : "rest";
      pose.visemeAmp = S.speaking ? S.visemeAmp : 0;
      pose.speaking = S.speaking;
      pose.state = S.state;
      pose.emotion = S.emotion;

      pose.arms.l.pitch = c.shPitchL;
      pose.arms.l.yaw = c.shYawL;
      pose.arms.l.roll = c.shRollL;
      pose.arms.l.elbow = c.elbowL;
      pose.arms.l.wrist = c.wristL;
      pose.arms.r.pitch = c.shPitchR;
      pose.arms.r.yaw = c.shYawR;
      pose.arms.r.roll = c.shRollR;
      pose.arms.r.elbow = c.elbowR;
      pose.arms.r.wrist = c.wristR;

      return pose;
    },
  };
}
