/* Bridge to the two non-React modules loaded as classic scripts in the HTML:
 * window.Avatar (avatar.js, superseded by avatar3d.js where WebGL works) and
 * window.Speech (speech.js).
 *
 * Both are looked up on EVERY call rather than captured once. avatar3d.js
 * replaces window.Avatar with the 2D rig again if the WebGL context is lost, and
 * a captured reference would keep driving a rig that is no longer on screen.
 */

/** Does nothing, but chains, so `avatar().setEmotion(x).setState(y)` is safe. */
const NOOP_AVATAR = {
  mount() {
    return this;
  },
  setState() {
    return this;
  },
  setEmotion() {
    return this;
  },
  setViseme() {
    return this;
  },
  stopSpeaking() {
    return this;
  },
  pulse() {
    return this;
  },
  nod() {
    return this;
  },
  isReady() {
    return false;
  },
};

const NOOP_SPEECH = {
  speak: async () => {},
  cancel() {},
  listen: () => ({ supported: false, stop: async () => "" }),
  stopListening() {},
  startMeter() {},
  stopMeter() {},
  voices: () => [],
  pickVoice: () => null,
  canSpeak: false,
  canListen: false,
};

/** The live avatar rig, whichever one is currently installed. */
export const avatar = () => window.Avatar || NOOP_AVATAR;

/** The speech layer. Falls back to a silent stub if speech.js did not load. */
export const speech = () => window.Speech || NOOP_SPEECH;

/** True once the real modules are present. */
export const legacyReady = () => Boolean(window.Avatar && window.Speech);

/** English voices only — the interviewer prompts are written in English. */
export const englishVoices = () =>
  speech()
    .voices()
    .filter((v) => (v.lang || "").toLowerCase().startsWith("en"));
