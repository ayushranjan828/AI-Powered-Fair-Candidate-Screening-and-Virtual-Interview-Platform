import { useCallback, useEffect, useRef, useState } from "react";

import { postJson, seg } from "../lib/api.js";
import { DEFAULT_VOICE_RATE } from "../lib/constants.js";
import { tokenise, words } from "../lib/format.js";
import { avatar, speech } from "../lib/legacy.js";

/**
 * The interview turn loop: ask the server what the interviewer says next, have
 * it said aloud (the avatar's mouth is driven from that same text), listen to
 * the reply, send it back, repeat. The server owns all the state; this owns the
 * performance.
 *
 * Answers are spoken and only spoken. There is no box to type into, because a
 * box to type into is a box to paste into, and an interview you can paste into
 * measures nothing. That one decision is what the rest of this file is about:
 * with no Submit-when-I-say-so keyboard, the loop has to work out for itself
 * when somebody has finished speaking (silence), when they have not started
 * (the nudge), and when what they said was not an answer at all - a request to
 * repeat the question, or to stop. That last one goes through the server, which
 * reads the intent and decides; see backend/intent.py.
 *
 * Shared by the recruiter's stage and the candidate's own page. It deals only in
 * prompts and answers - no scores, no grading keys, nothing a candidate must not
 * see - so both pages can drive it without the candidate page gaining access to
 * anything of the recruiter's.
 */

/** Quiet for this long, having said something, and the answer looks finished. */
const SILENCE_MS = 5000;
/** Then this many seconds of visible countdown, cancelled by speaking again. */
const COUNTDOWN_S = 4;
/** Said nothing at all for this long: check they are still with us. */
const IDLE_NUDGE_MS = 40000;
/** Still nothing: record it as unanswered and move the interview along. */
const IDLE_GIVE_UP_MS = 100000;
/** How often the watcher above runs. */
const WATCH_MS = 250;
/** And how often the clock redraws. Its own interval, for the reason below. */
const CLOCK_MS = 500;

export default function useInterviewRun({ interviewId, options, onClosing, onEnded, onError }) {
  const [prompt, setPrompt] = useState(null);
  const [turns, setTurns] = useState([]);
  const [progress, setProgressState] = useState({});
  const [answering, setAnswering] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [muted, setMuted] = useState(false);
  const [chip, setChip] = useState({ text: "Ready", cls: "pill-muted" });
  const [badge, setBadge] = useState(null);
  const [caption, setCaption] = useState({ tokens: [], active: -1 });
  const [hint, setHint] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [micError, setMicError] = useState("");
  const [elapsed, setElapsed] = useState(0);

  /* Refs for anything read inside async callbacks or the watcher interval that
   * must not go stale, and for the re-entrancy guard - `busy` as state lands a
   * render too late to stop a double click. */
  const busyRef = useRef(false);
  const mutedRef = useRef(muted);
  const micRef = useRef(null);
  const transcriptRef = useRef("");
  const answeringRef = useRef(false);
  const confirmingRef = useRef(false);
  const countdownRef = useRef(null);
  const answerStart = useRef(0);
  const promptRef = useRef(null);
  const optionsRef = useRef(options || {});
  const handlers = useRef({ onClosing, onEnded, onError });
  /* The id goes through a ref as well as the closure. The candidate page sets
   * it with setState and then drives the loop from a callback created before
   * that render, so a closed-over id would still be null and every turn would
   * be posted to /api/interviews/null/next. */
  const idRef = useRef(interviewId);

  /* Silence tracking. Pushed forward by the transcript growing, and by nothing
   * else - deliberately not by the microphone's level.
   *
   * The meter says "there is sound", which a fan, a noisy line or an aggressive
   * gain control satisfies permanently; an interview waiting on that waits for a
   * silence that never arrives. Words appearing is the honest signal for words
   * being spoken. It is also the safe one: speech the recogniser cannot make out
   * leaves the transcript empty, which lands on the "take your time" nudge below
   * rather than on an early submit, so failing to be understood never costs
   * somebody their answer. */
  const lastVoice = useRef(0);
  const nudged = useRef(false);
  /* The clock is anchored to the server's own elapsed time and then run locally,
   * so a browser whose tab was throttled still shows the true duration and a
   * clock that disagrees with the server's cannot drift the timer. */
  const clock = useRef({ base: 0, at: 0 });
  const actions = useRef({});

  mutedRef.current = muted;
  transcriptRef.current = transcript;
  answeringRef.current = answering;
  confirmingRef.current = confirming;
  countdownRef.current = countdown;
  promptRef.current = prompt;
  optionsRef.current = options || {};
  handlers.current = { onClosing, onEnded, onError };
  if (interviewId) idRef.current = interviewId;

  /* The mic meter fires at frame rate. Writing that through React state would
   * re-render the whole stage 60 times a second, so the level bar is driven
   * straight through a ref instead. */
  const levelRef = useRef(null);

  const canListen = speech().canListen;
  const spokenWords = words(transcript);

  const setLevel = useCallback((level) => {
    const el = levelRef.current;
    if (el) el.style.width = `${Math.round(level * 100)}%`;
  }, []);

  /** Progress from the server, which also carries the clock. */
  const setProgress = useCallback((next) => {
    const value = next || {};
    setProgressState(value);
    if (typeof value.elapsed_seconds === "number") {
      clock.current = { base: value.elapsed_seconds, at: performance.now() };
      setElapsed(value.elapsed_seconds);
    }
  }, []);

  /* ------------------------------------------------------------- speaking */
  const say = useCallback(async (text, emotion) => {
    if (!text) return;
    avatar().setEmotion(emotion || "neutral").setState("speaking");
    setChip({ text: "Speaking", cls: "pill-brand" });
    setBadge(null);

    const tokens = tokenise(text);
    setCaption({ tokens, active: -1 });

    // The interview's own settings win: it may have been configured for this
    // one candidate. Anything unset falls back to the shared default.
    const vo = optionsRef.current || {};
    await speech().speak(text, {
      rate: vo.voice_rate || DEFAULT_VOICE_RATE,
      voiceName: vo.voice_name || "",
      mute: mutedRef.current,
      onViseme: (name, intensity) => avatar().setViseme(name, intensity),
      onWord: (charIndex) => {
        const active = tokens.findIndex((t) => t.word && t.end > charIndex);
        setCaption({ tokens, active });
      },
    });

    avatar().stopSpeaking();
    setCaption({ tokens, active: -1 });
  }, []);

  /* ------------------------------------------------------------------ mic */
  /** Open the microphone for this interview. The one permission prompt there is.
   *
   *  Must be called from inside a click: browsers only grant audio capture from
   *  a user gesture. Nothing asks again after this - the capture is held for the
   *  whole interview and released when it ends.
   */
  const arm = useCallback(async () => {
    const granted = await speech().requestMic();
    if (!granted.ok) {
      setMicError(granted.error || "denied");
      return granted;
    }
    setMicError("");
    // The meter drives the level bar and the avatar's nodding, and nothing else.
    speech().startMeter((level) => {
      setLevel(level);
      avatar().pulse(level);
    });
    return granted;
  }, [setLevel]);

  const startMic = useCallback(() => {
    if (micRef.current) return;
    const handle = speech().listen({
      onInterim: (text) => {
        setTranscript(text);
        lastVoice.current = performance.now();
      },
      onError: (msg) => handlers.current.onError?.(msg),
    });
    if (!handle.supported) return;

    micRef.current = handle;
    lastVoice.current = performance.now();
    setListening(true);
    setBadge("Listening");
    // Taking notes while the candidate talks, which is what a human does.
    avatar().setState("noting");
  }, []);

  const stopMic = useCallback(async () => {
    const handle = micRef.current;
    if (!handle) return "";
    micRef.current = null;
    setListening(false);
    setBadge(null);
    setCountdown(null);
    setLevel(0);
    avatar().setState("listening");
    return handle.stop();
  }, [setLevel]);

  /** Hand the floor to the candidate: clear the slate and start transcribing. */
  const openAnswerBox = useCallback(
    (asConfirmation = false) => {
      setAnswering(true);
      setConfirming(asConfirmation);
      setTranscript("");
      transcriptRef.current = "";
      setCountdown(null);
      nudged.current = false;
      lastVoice.current = performance.now();
      answerStart.current = performance.now();
      avatar().setEmotion("encouraging").setState("listening");
      setBadge(null);
      startMic();
      setChip({ text: "Your turn", cls: "pill-live" });
    },
    [startMic],
  );

  /* ------------------------------------------------------------ turn loop */
  const runNext = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const next = await postJson(`/api/interviews/${seg(idRef.current)}/next`);
        setPrompt(next);
        promptRef.current = next;
        setProgress(next.progress);

        if (next.kind === "opening") {
          await say(next.speech, next.emotion || "friendly");
          continue; // straight on to the first real question
        }

        if (next.kind === "question") {
          setHint(
            next.question_source === "followup"
              ? "The interviewer asked this because of what you just said."
              : "",
          );
          await say(next.speech, next.emotion || "neutral");
          openAnswerBox();
          return;
        }

        // closing or done
        setAnswering(false);
        if (next.speech) await say(next.speech, "friendly");
        setChip({ text: "Interview complete", cls: "pill-ok" });
        await handlers.current.onClosing?.(next);
        return;
      }
    } catch (err) {
      handlers.current.onError?.(`Interview step failed: ${err.message}`);
      setChip({ text: "Paused", cls: "pill-bad" });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [say, openAnswerBox, setProgress]);

  /** The click that starts the interview is also what grants the microphone. */
  const begin = useCallback(async () => {
    const granted = await arm();
    if (!granted.ok) return granted;
    await runNext();
    return granted;
  }, [arm, runNext]);

  /**
   * Send whatever was just said. Not necessarily an answer: the server reads the
   * intent and may come back asking us to repeat the question, to check whether
   * they really want to stop, or to end. Only "recorded" moves the plan on.
   *
   * `silent` is the watcher giving up on an answer that never came; it is the
   * one mode allowed to submit nothing.
   */
  const submit = useCallback(
    async (mode = "voice") => {
      if (busyRef.current) return;
      const current = promptRef.current;
      if (!current) return;

      const seconds = answerStart.current
        ? (performance.now() - answerStart.current) / 1000
        : 0;
      const finalText = await stopMic();
      // The recogniser's own final text and the running interim text can differ
      // by a trailing phrase; keep whichever caught more of it.
      const interim = (transcriptRef.current || "").trim();
      const text = (finalText || "").trim().length > interim.length
        ? (finalText || "").trim()
        : interim;

      if (!text && mode !== "silent") {
        handlers.current.onError?.("I did not catch that — please say it again.", "");
        lastVoice.current = performance.now();
        nudged.current = false;
        startMic();
        return;
      }

      busyRef.current = true;
      setBusy(true);
      setCountdown(null);
      // The grading call is the real work, so showing it as thought rather than
      // a spinner is honest.
      avatar().setEmotion("thinking").setState("thinking");
      setChip({ text: "Considering your answer", cls: "pill-muted" });

      let res;
      try {
        res = await postJson(`/api/interviews/${seg(idRef.current)}/answer`, {
          turn: current.turn,
          answer: text,
          seconds,
          mode: mode === "silent" ? "voice" : mode,
        });
      } catch (err) {
        handlers.current.onError?.(`Could not send that: ${err.message}`);
        busyRef.current = false;
        setBusy(false);
        // Their words are not lost - the floor is simply handed back.
        lastVoice.current = performance.now();
        nudged.current = false;
        startMic();
        return;
      }

      setProgress(res.progress);

      /* Not an answer: the same question again, or the confirmation of a request
       * to stop. Either way the turn is still open on the server, so nothing has
       * been recorded and the floor goes straight back to the candidate.
       *
       * Busy stays set until the floor is actually handed back. Clearing it
       * before the question is spoken would re-enable the answer buttons over
       * the top of the interviewer talking, with the previous words still in the
       * transcript - and pressing one would send them a second time, at a turn
       * that has not recorded anything yet. */
      if (res.action === "repeat" || res.action === "confirm_end") {
        setHint(
          res.action === "confirm_end"
            ? "Say “yes” to end the interview, or “no” to carry on."
            : "",
        );
        await say(res.speech, res.emotion || "friendly");
        openAnswerBox(res.action === "confirm_end");
        busyRef.current = false;
        setBusy(false);
        return;
      }

      if (res.action === "ended") {
        setAnswering(false);
        setConfirming(false);
        setHint("");
        await say(res.speech, res.emotion || "friendly");
        setChip({ text: "Interview ended", cls: "pill-ok" });
        busyRef.current = false;
        setBusy(false);
        await handlers.current.onEnded?.(res);
        return;
      }

      const record = {
        turn: current.turn,
        question_id: current.question_id,
        category: current.category,
        category_label: current.category_label,
        question: current.question,
        question_source: current.question_source,
        answer: text,
        answer_type: res.answer_type,
      };
      setTurns((prev) => {
        const idx = prev.findIndex((t) => t.turn === current.turn);
        if (idx === -1) return [...prev, record];
        const next = [...prev];
        next[idx] = { ...next[idx], ...record };
        return next;
      });

      avatar().setEmotion(res.reaction?.emotion || "neutral");
      avatar().nod(res.answer_type === "substantive" ? 2 : 1);
      setHint(res.followup_queued ? "That is worth digging into…" : "");

      setAnswering(false);
      setConfirming(false);
      // Cleared before runNext(), which refuses to start while it is set.
      busyRef.current = false;
      setBusy(false);
      await runNext();
    },
    [openAnswerBox, runNext, say, setProgress, startMic],
  );

  /** Say the current question again. Costs the candidate nothing and is meant to
   *  be used - misheard questions are the interviewer's problem, not theirs. */
  const repeat = useCallback(async () => {
    const current = promptRef.current;
    if (!current?.question || busyRef.current) {
      handlers.current.onError?.("Nothing to repeat yet", "");
      return;
    }
    const wasListening = Boolean(micRef.current);
    if (wasListening) await stopMic();
    await say(current.question, "friendly");
    if (answeringRef.current) {
      avatar().setState("listening");
      setChip({ text: "Your turn", cls: "pill-live" });
      lastVoice.current = performance.now();
      nudged.current = false;
      if (wasListening) startMic();
    }
  }, [say, startMic, stopMic]);

  /** End the interview now, keeping everything answered so far for review. */
  const endInterview = useCallback(
    async (reason) => {
      if (busyRef.current) return null;
      busyRef.current = true;
      setBusy(true);
      setCountdown(null);
      await stopMic();
      try {
        const res = await postJson(`/api/interviews/${seg(idRef.current)}/end`, {
          reason: reason || "",
        });
        setAnswering(false);
        setConfirming(false);
        setChip({ text: "Interview ended", cls: "pill-ok" });
        return res;
      } catch (err) {
        handlers.current.onError?.(`Could not end the interview: ${err.message}`);
        return null;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [stopMic],
  );

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      mutedRef.current = next;
      if (next) speech().cancel();
      return next;
    });
  }, []);

  /** Re-present the question a reload interrupted, rather than asking for a new
   *  one - which would lose the candidate's place in the plan. */
  const resumeAt = useCallback(
    (lastTurn, initialProgress) => {
      const resumed = {
        kind: "question",
        turn: lastTurn.turn,
        question_id: lastTurn.question_id,
        category: lastTurn.category,
        category_label: lastTurn.category_label,
        question: lastTurn.question,
        speech: lastTurn.question,
        question_source: lastTurn.question_source,
        emotion: "neutral",
        expects_answer: true,
      };
      setPrompt(resumed);
      promptRef.current = resumed;
      setProgress(initialProgress);
      setCaption({ tokens: tokenise(lastTurn.question || ""), active: -1 });
      setHint('Picked up where you left off. Say "repeat that" to hear the question again.');
      openAnswerBox();
    },
    [openAnswerBox, setProgress],
  );

  /** Everything the page must stop doing when the interview ends or unmounts,
   *  including the microphone itself - the recording light goes out here. */
  const teardown = useCallback(async () => {
    speech().cancel();
    if (micRef.current) await stopMic();
    speech().releaseMic();
  }, [stopMic]);

  /* ------------------------------------------------------- silence watcher */
  /* One interval for the life of the hook, reading everything through refs. It
   * is the thing that decides an answer has finished, since nobody presses
   * anything to say so. */
  actions.current = { submit, say, startMic, stopMic };

  /* The clock keeps its own interval, deliberately apart from the watcher below.
   * The watcher awaits things that take real time - grading an answer takes
   * several seconds - and a clock sharing that loop stops during exactly the
   * pauses a candidate is most likely to be watching it, then jumps. A timer
   * that stalls whenever the system is busy is worse than no timer. */
  useEffect(() => {
    const timer = setInterval(() => {
      const { base, at } = clock.current;
      if (at) setElapsed(base + (performance.now() - at) / 1000);
    }, CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const tick = async () => {
      if (!answeringRef.current || busyRef.current || !micRef.current) {
        if (countdownRef.current !== null) setCountdown(null);
        return;
      }

      const silentFor = performance.now() - lastVoice.current;
      const said = words(transcriptRef.current);

      if (said > 0) {
        if (silentFor < SILENCE_MS) {
          if (countdownRef.current !== null) setCountdown(null);
          return;
        }
        const left = Math.ceil(COUNTDOWN_S - (silentFor - SILENCE_MS) / 1000);
        if (left > 0) {
          if (left !== countdownRef.current) setCountdown(left);
          return;
        }
        countdownRef.current = null;
        setCountdown(null);
        await actions.current.submit("voice");
        return;
      }

      // Nothing said at all yet.
      if (silentFor > IDLE_GIVE_UP_MS) {
        lastVoice.current = performance.now();
        postJson(`/api/interviews/${seg(idRef.current)}/event`, {
          kind: "no_response",
          seconds: Math.round(IDLE_GIVE_UP_MS / 1000),
        }).catch(() => {});
        await actions.current.submit("silent");
        return;
      }
      if (silentFor > IDLE_NUDGE_MS && !nudged.current) {
        nudged.current = true;
        await actions.current.stopMic();
        await actions.current.say(
          confirmingRef.current
            ? "Take your time. Say yes to end the interview, or no to carry on."
            : "Take your time. If you would like me to repeat the question, just say so.",
          "encouraging",
        );
        lastVoice.current = performance.now();
        if (answeringRef.current) {
          setChip({ text: "Your turn", cls: "pill-live" });
          actions.current.startMic();
        }
      }
    };

    let running = false;
    const timer = setInterval(() => {
      // The tick awaits speech; overlapping runs would talk over themselves.
      if (running) return;
      running = true;
      tick().finally(() => {
        running = false;
      });
    }, WATCH_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      // Unmount: a recogniser, a half-spoken sentence or a live microphone must
      // not outlive the page.
      speech().cancel();
      speech().releaseMic();
      micRef.current = null;
    },
    [],
  );

  return {
    prompt,
    turns,
    setTurns,
    progress,
    setProgress,
    answering,
    confirming,
    transcript,
    spokenWords,
    busy,
    listening,
    canListen,
    micError,
    countdown,
    elapsed,
    muted,
    toggleMute,
    chip,
    setChip,
    badge,
    caption,
    hint,
    setHint,
    levelRef,
    arm,
    begin,
    runNext,
    submit,
    repeat,
    endInterview,
    resumeAt,
    teardown,
    say,
  };
}
