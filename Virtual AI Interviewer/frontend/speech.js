/* Speech in and out, and the lip-sync that ties the voice to the face.
 *
 * Out: the Web Speech synthesiser says the question while a viseme timeline,
 * built from the same text, tells the avatar what shape its mouth should be in
 * at each moment. The timeline is estimated up front (so it works even on voices
 * that report nothing) and re-synced whenever the synthesiser fires a word
 * boundary event (so it stays honest on voices that do).
 *
 * In: SpeechRecognition transcribes the answer, with interim results so the
 * candidate can see they are being heard, plus a mic level meter so the avatar
 * can nod along to actual speech.
 *
 * Everything degrades: no synthesiser means silent lip-sync on the estimated
 * timeline, and no recogniser means the candidate types instead. The interview
 * never depends on either being present.
 */
window.Speech = (function () {
  "use strict";

  const synth = window.speechSynthesis || null;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  /* ------------------------------------------------------- viseme timeline */
  // Two-letter clusters first, so "sh" is not read as s + h.
  const DIGRAPHS = {
    ch: "SZ", sh: "SZ", th: "TH", ph: "FV", wh: "W", ck: "KG", ng: "NDT",
    qu: "W", gh: "KG", kn: "NDT", wr: "R",
    oo: "OO", ee: "EE", ea: "EE", ie: "EE", ei: "EE",
    ou: "OH", ow: "OH", oa: "OH", oi: "OH", oy: "OH", au: "OH", aw: "OH",
    ai: "AE", ay: "AE", ue: "OO", ui: "OO", ew: "OO",
  };
  const LETTERS = {
    a: "AE", e: "EE", i: "IH", o: "OH", u: "UH", y: "IH",
    m: "MBP", b: "MBP", p: "MBP",
    f: "FV", v: "FV",
    s: "SZ", z: "SZ", c: "SZ", x: "SZ",
    t: "NDT", d: "NDT", n: "NDT",
    l: "L", r: "R",
    k: "KG", g: "KG", q: "KG", j: "KG",
    w: "W", h: "UH",
  };
  const VOWELS = "aeiou";

  // Milliseconds at rate 1.0. Vowels carry the shape; consonants pass through.
  const DUR = { vowel: 96, consonant: 56, closure: 62, space: 72 };
  const PAUSE = { ",": 160, ";": 180, ":": 180, ".": 290, "!": 290, "?": 300, "-": 90 };

  /** Build [{viseme, start, dur, charIndex, intensity}] for a piece of text. */
  function buildTimeline(text, rate) {
    const items = [];
    const lower = text.toLowerCase();
    let clock = 0;
    let i = 0;
    let sinceVowel = 0;

    const push = (viseme, dur, charIndex, intensity) => {
      items.push({ viseme, start: clock, dur, charIndex, intensity });
      clock += dur;
    };

    while (i < lower.length) {
      const ch = lower[i];

      if (ch === " " || ch === "\n" || ch === "\t") {
        push("rest", DUR.space, i, 0.25);
        sinceVowel = 0;
        i += 1;
        continue;
      }
      if (PAUSE[ch] !== undefined) {
        push("rest", PAUSE[ch], i, 0.12);
        sinceVowel = 0;
        i += 1;
        continue;
      }
      if (!/[a-z0-9]/.test(ch)) { i += 1; continue; }

      // Digits are spoken as words; approximate with an open shape.
      if (/[0-9]/.test(ch)) {
        push("AE", DUR.vowel, i, 0.9);
        i += 1;
        continue;
      }

      const pair = lower.slice(i, i + 2);
      if (DIGRAPHS[pair]) {
        const viseme = DIGRAPHS[pair];
        const isVowelPair = VOWELS.includes(pair[0]) && VOWELS.includes(pair[1]);
        push(viseme, isVowelPair ? DUR.vowel * 1.25 : DUR.consonant * 1.1, i,
             isVowelPair ? 1 : 0.8);
        sinceVowel = isVowelPair ? 0 : sinceVowel + 1;
        i += 2;
        continue;
      }

      const viseme = LETTERS[ch] || "UH";
      const isVowel = VOWELS.includes(ch);
      // Doubled consonants ("letter") are one closure, not two.
      if (!isVowel && lower[i + 1] === ch) {
        push(viseme, DUR.closure, i, 0.75);
        i += 2;
        continue;
      }
      // The first vowel of a word takes the stress, so it opens wider.
      const stressed = isVowel && sinceVowel <= 1;
      push(viseme,
           isVowel ? DUR.vowel : (viseme === "MBP" ? DUR.closure : DUR.consonant),
           i,
           isVowel ? (stressed ? 1 : 0.82) : 0.7);
      sinceVowel = isVowel ? 0 : sinceVowel + 1;
      i += 1;
    }

    const scale = 1 / Math.max(0.5, rate || 1);
    for (const item of items) {
      item.start *= scale;
      item.dur *= scale;
      // A touch of variance per syllable: identical amplitudes look mechanical.
      item.intensity *= 0.88 + Math.random() * 0.12;
    }
    return { items, duration: clock * scale };
  }

  /* --------------------------------------------------------- voice selection */
  let voiceCache = null;

  function allVoices() {
    if (!synth) return [];
    const list = synth.getVoices() || [];
    if (list.length) voiceCache = list;
    return voiceCache || [];
  }

  // Warm the list: on Chrome the first getVoices() is empty until this fires.
  if (synth) {
    try {
      synth.addEventListener("voiceschanged", () => { voiceCache = synth.getVoices(); });
      allVoices();
    } catch { /* older engines have no event; the cache fills on first speak */ }
  }

  // Preferred first: clear, natural English voices that exist on Windows/Chrome.
  const PREFERRED = [
    "microsoft aria", "microsoft jenny", "microsoft libby", "microsoft sonia",
    "google uk english female", "google us english", "samantha",
    "microsoft zira", "microsoft hazel", "microsoft david",
  ];

  function pickVoice(nameHint) {
    const voices = allVoices();
    if (!voices.length) return null;
    if (nameHint) {
      const exact = voices.find((v) => v.name === nameHint);
      if (exact) return exact;
    }
    const english = voices.filter((v) => (v.lang || "").toLowerCase().startsWith("en"));
    const pool = english.length ? english : voices;
    for (const want of PREFERRED) {
      const hit = pool.find((v) => v.name.toLowerCase().includes(want));
      if (hit) return hit;
    }
    return pool.find((v) => v.default) || pool[0];
  }

  /* ------------------------------------------------------------------ speak */
  let current = null;   // the utterance in flight

  /**
   * Say `text`, driving the avatar's mouth from the same text.
   * Resolves when speech finishes, or immediately when cancelled.
   * opts: { onViseme(name, intensity), onWord(charIndex), rate, pitch,
   *         voiceName, mute }
   */
  function speak(text, opts = {}) {
    const clean = String(text || "").trim();
    cancel();
    if (!clean) return Promise.resolve({ spoke: false, reason: "empty" });

    const rate = opts.rate ?? 0.98;
    const timeline = buildTimeline(clean, rate);
    const onViseme = opts.onViseme || (() => {});
    const onWord = opts.onWord || (() => {});

    return new Promise((resolve) => {
      const session = {
        cancelled: false, finished: false, raf: null,
        playhead: 0, last: performance.now(), index: 0, utterance: null,
      };
      current = session;

      const done = (result) => {
        if (session.finished) return;
        session.finished = true;
        if (session.raf) cancelAnimationFrame(session.raf);
        onViseme("rest", 0);
        if (current === session) current = null;
        resolve(result);
      };

      /* The mouth is driven by the timeline, never by the audio itself - there
       * is no way to read the synthesiser's output signal from the page. */
      const tick = (now) => {
        if (session.cancelled) return;
        session.playhead += now - session.last;
        session.last = now;

        while (session.index < timeline.items.length - 1 &&
               timeline.items[session.index + 1].start <= session.playhead) {
          session.index += 1;
        }
        const item = timeline.items[session.index];
        if (item) onViseme(item.viseme, item.intensity);

        // Without a synthesiser there is no onend, so the timeline ends it.
        if (!session.utterance && session.playhead >= timeline.duration + 120) {
          return done({ spoke: false, reason: "no-synth", silent: true });
        }
        session.raf = requestAnimationFrame(tick);
      };

      if (!synth || opts.mute) {
        // Silent mode: the face still moves in time with the text, so a muted
        // interview is watchable rather than a frozen portrait.
        session.raf = requestAnimationFrame(tick);
        return;
      }

      let utterance;
      try {
        utterance = new SpeechSynthesisUtterance(clean);
      } catch {
        session.raf = requestAnimationFrame(tick);
        return;
      }
      session.utterance = utterance;
      utterance.rate = rate;
      utterance.pitch = opts.pitch ?? 1.03;
      utterance.volume = 1;
      const voice = pickVoice(opts.voiceName);
      if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }

      utterance.onboundary = (event) => {
        if (session.cancelled || typeof event.charIndex !== "number") return;
        // Ground truth from the engine: snap the timeline to the word actually
        // being spoken, so drift never accumulates over a long question.
        const target = timeline.items.findIndex((it) => it.charIndex >= event.charIndex);
        if (target >= 0) {
          session.index = target;
          session.playhead = timeline.items[target].start;
          session.last = performance.now();
        }
        if (event.name === "word" || event.name === undefined) onWord(event.charIndex);
      };
      utterance.onend = () => done({ spoke: true });
      utterance.onerror = (event) => {
        // "interrupted" / "canceled" are our own cancel() and not failures.
        const kind = event?.error || "error";
        if (kind === "interrupted" || kind === "canceled") return done({ spoke: false, reason: kind });
        done({ spoke: false, reason: kind, silent: true });
      };

      session.last = performance.now();
      session.raf = requestAnimationFrame(tick);
      try {
        synth.speak(utterance);
      } catch {
        // Leave the timeline running so the mouth still moves.
      }

      // Chrome occasionally drops an utterance without firing onend. The timeline
      // knows how long the text should take, so use it as a watchdog.
      const watchdogMs = timeline.duration + 4000 + clean.length * 12;
      setTimeout(() => {
        if (!session.finished && !session.cancelled) {
          done({ spoke: true, reason: "watchdog" });
        }
      }, watchdogMs);
    });
  }

  function cancel() {
    if (current) {
      current.cancelled = true;
      if (current.raf) cancelAnimationFrame(current.raf);
      current.finished = true;
      current = null;
    }
    if (synth) {
      try { synth.cancel(); } catch { /* nothing in flight */ }
    }
  }

  /* ------------------------------------------------------------------ listen */
  let recognizer = null;
  let meter = null;

  /**
   * Transcribe the candidate until stop() is called.
   * opts: { onInterim(text), onFinal(fullText), onError(msg), onStart(), lang }
   * Returns { stop(), abort(), supported } - stop() resolves the final text.
   */
  function listen(opts = {}) {
    if (!Recognition) {
      opts.onError?.("This browser cannot transcribe speech - please type your answer.");
      return { supported: false, stop: () => Promise.resolve(""), abort: () => {} };
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = opts.lang || "en-IN";
    recognition.maxAlternatives = 1;

    let finalText = "";
    let stopping = false;
    let resolveStop = null;
    recognizer = recognition;

    recognition.onstart = () => opts.onStart?.();

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript || "";
        if (result.isFinal) {
          finalText = `${finalText} ${text}`.trim();
        } else {
          interim += text;
        }
      }
      opts.onInterim?.(`${finalText} ${interim}`.trim());
    };

    recognition.onerror = (event) => {
      const kind = event?.error || "error";
      // A pause in speech is normal in an interview - people think before they
      // talk - so no-speech is not an error worth showing anybody.
      if (kind === "no-speech" || kind === "aborted") return;
      if (kind === "not-allowed" || kind === "service-not-allowed") {
        opts.onError?.("Microphone access was blocked - allow it, or type your answer.");
      } else if (kind === "network") {
        opts.onError?.("Speech recognition needs a network connection - type instead.");
      } else {
        opts.onError?.(`Microphone error: ${kind}`);
      }
    };

    recognition.onend = () => {
      // The engine stops itself after silence; restart until we really want out.
      if (!stopping) {
        try { recognition.start(); return; } catch { /* fall through to finish */ }
      }
      recognizer = null;
      resolveStop?.(finalText.trim());
    };

    try {
      recognition.start();
    } catch (err) {
      opts.onError?.(`Could not start the microphone: ${err.message}`);
    }

    return {
      supported: true,
      stop() {
        stopping = true;
        return new Promise((resolve) => {
          resolveStop = resolve;
          try { recognition.stop(); } catch { resolve(finalText.trim()); }
          // Belt and braces: onend does not always fire after stop().
          setTimeout(() => resolve(finalText.trim()), 1200);
        });
      },
      abort() {
        stopping = true;
        try { recognition.abort(); } catch { /* already gone */ }
        recognizer = null;
      },
      text() { return finalText.trim(); },
    };
  }

  function stopListening() {
    if (recognizer) {
      try { recognizer.abort(); } catch { /* already gone */ }
      recognizer = null;
    }
  }

  /* -------------------------------------------------------------- mic meter */
  /** Live mic level, 0-1, for the level bar and the avatar's nodding. */
  async function startMeter(onLevel) {
    if (meter) return meter;
    if (!navigator.mediaDevices?.getUserMedia) return null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      let raf = null;

      const loop = () => {
        analyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
        const rms = Math.sqrt(sum / buffer.length) / 255;
        onLevel?.(Math.min(1, rms * 3.2));
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);

      meter = {
        stop() {
          if (raf) cancelAnimationFrame(raf);
          stream.getTracks().forEach((track) => track.stop());
          ctx.close().catch(() => {});
          meter = null;
        },
      };
      return meter;
    } catch {
      // Denied or unavailable: the level bar just stays quiet.
      return null;
    }
  }

  function stopMeter() {
    meter?.stop();
    meter = null;
  }

  return {
    speak,
    cancel,
    listen,
    stopListening,
    startMeter,
    stopMeter,
    voices: allVoices,
    pickVoice,
    buildTimeline,
    get canSpeak() { return Boolean(synth); },
    get canListen() { return Boolean(Recognition); },
  };
})();
