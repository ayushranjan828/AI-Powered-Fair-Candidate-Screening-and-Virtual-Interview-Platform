import { useCallback, useEffect, useRef, useState } from "react";

import { postJson, seg } from "../lib/api.js";
import { DEFAULT_VOICE_RATE } from "../lib/constants.js";
import { tokenise, words } from "../lib/format.js";
import { avatar, speech } from "../lib/legacy.js";

/**
 * The interview turn loop: ask the server what the interviewer says next, have
 * it said aloud (the avatar's mouth is driven from that same text), collect the
 * answer, send it back, repeat. The server owns all the state; this owns the
 * performance.
 *
 * Shared by the recruiter's stage and the candidate's own page. It deals only
 * in prompts and answers - no scores, no grading keys, nothing a candidate must
 * not see - so both pages can drive it without the candidate page gaining
 * access to anything of the recruiter's.
 */
export default function useInterviewRun({ interviewId, options, onClosing, onError }) {
  const [prompt, setPrompt] = useState(null);
  const [turns, setTurns] = useState([]);
  const [progress, setProgress] = useState({});
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [chip, setChip] = useState({ text: "Ready", cls: "pill-muted" });
  const [badge, setBadge] = useState(null);
  const [caption, setCaption] = useState({ tokens: [], active: -1 });
  const [hint, setHint] = useState("");

  /* Refs for anything read inside async callbacks that must not go stale, and
   * for the re-entrancy guard - `busy` as state lands a render too late to stop
   * a double click. */
  const busyRef = useRef(false);
  const mutedRef = useRef(muted);
  const listeningRef = useRef(null);
  const answerRef = useRef("");
  const answerStart = useRef(0);
  const promptRef = useRef(null);
  const optionsRef = useRef(options || {});
  const handlers = useRef({ onClosing, onError });
  /* The id goes through a ref as well as the closure. The candidate page sets
   * it with setState and then drives the loop from a callback created before
   * that render, so a closed-over id would still be null and every turn would
   * be posted to /api/interviews/null/next. */
  const idRef = useRef(interviewId);

  mutedRef.current = muted;
  answerRef.current = answer;
  promptRef.current = prompt;
  optionsRef.current = options || {};
  handlers.current = { onClosing, onError };
  if (interviewId) idRef.current = interviewId;

  /* The mic meter fires at frame rate. Writing that through React state would
   * re-render the whole stage 60 times a second, so the level bar is driven
   * straight through a ref instead. */
  const levelRef = useRef(null);

  const canListen = speech().canListen;
  const answerWords = words(answer);

  const setLevel = useCallback((level) => {
    const el = levelRef.current;
    if (el) el.style.width = `${Math.round(level * 100)}%`;
  }, []);

  /* ------------------------------------------------------------- speaking */
  const say = useCallback(
    async (text, emotion) => {
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
    },
    [],
  );

  /* ------------------------------------------------------------------ mic */
  const startMic = useCallback(() => {
    if (listeningRef.current) return;
    const handle = speech().listen({
      onInterim: (text) => setAnswer(text),
      onError: (msg) => handlers.current.onError?.(msg),
    });
    if (!handle.supported) return;

    listeningRef.current = handle;
    setMicOn(true);
    setBadge("Listening");
    // Taking notes while the candidate talks, which is what a human does.
    avatar().setState("noting");
  }, []);

  const stopMic = useCallback(async () => {
    const handle = listeningRef.current;
    if (!handle) return "";
    listeningRef.current = null;
    setMicOn(false);
    setBadge(null);
    setLevel(0);
    avatar().setState("listening");
    return handle.stop();
  }, [setLevel]);

  const toggleMic = useCallback(async () => {
    if (listeningRef.current) {
      const text = await stopMic();
      // Only fill in what the interim transcript missed; never clobber typing.
      if (text) setAnswer((prev) => (prev.trim() ? prev : text));
    } else {
      startMic();
    }
  }, [startMic, stopMic]);

  const openAnswerBox = useCallback(() => {
    setAnswering(true);
    setAnswer("");
    answerStart.current = performance.now();
    avatar().setEmotion("encouraging").setState("listening");
    setBadge(null);

    // Auto-start the microphone: making the candidate press record for every
    // question turns a conversation into a form.
    if (speech().canListen && !listeningRef.current) startMic();
  }, [startMic]);

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
        setProgress(next.progress || {});

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
          setChip({ text: "Your turn", cls: "pill-live" });
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
  }, [say, openAnswerBox]);

  /** The click that starts the interview is also what grants microphone access:
   *  browsers only allow audio capture from inside a user gesture. */
  const begin = useCallback(async () => {
    if (speech().canListen) {
      speech().startMeter((level) => {
        setLevel(level);
        avatar().pulse(level);
      });
    }
    await runNext();
  }, [runNext, setLevel]);

  const submit = useCallback(
    async (mode) => {
      if (busyRef.current) return;
      const current = promptRef.current;
      if (!current) return;

      const seconds = answerStart.current
        ? (performance.now() - answerStart.current) / 1000
        : 0;
      if (listeningRef.current) await stopMic();

      const text = (mode === "skipped" ? "" : answerRef.current).trim();
      if (!text && mode !== "skipped") {
        handlers.current.onError?.("Nothing to submit yet", "");
        return;
      }

      busyRef.current = true;
      setBusy(true);
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
          mode: mode || "voice",
        });
      } catch (err) {
        handlers.current.onError?.(`Could not submit that answer: ${err.message}`);
        busyRef.current = false;
        setBusy(false);
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
      };
      setTurns((prev) => {
        const idx = prev.findIndex((t) => t.turn === current.turn);
        if (idx === -1) return [...prev, record];
        const next = [...prev];
        next[idx] = { ...next[idx], ...record };
        return next;
      });

      setProgress(res.progress || {});
      avatar().setEmotion(res.reaction?.emotion || "neutral");
      avatar().nod(res.answer_type === "substantive" ? 2 : 1);
      if (res.followup_queued) setHint("That is worth digging into…");

      setAnswering(false);
      busyRef.current = false;
      setBusy(false);
      await runNext();
    },
    [stopMic, runNext],
  );

  const repeat = useCallback(async () => {
    const current = promptRef.current;
    if (!current?.question) {
      handlers.current.onError?.("Nothing to repeat yet", "");
      return;
    }
    const wasListening = Boolean(listeningRef.current);
    if (wasListening) await stopMic();
    await say(current.question, "friendly");
    if (answering) {
      avatar().setState("listening");
      setChip({ text: "Your turn", cls: "pill-live" });
      if (wasListening) startMic();
    }
  }, [answering, say, startMic, stopMic]);

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
      setProgress(initialProgress || {});
      setCaption({ tokens: tokenise(lastTurn.question || ""), active: -1 });
      setHint('Picked up where you left off. Use "Repeat question" to hear it again.');
      openAnswerBox();
      setChip({ text: "Your turn", cls: "pill-live" });
    },
    [openAnswerBox],
  );

  /** Everything the page must stop doing when the interview ends or unmounts. */
  const teardown = useCallback(async () => {
    speech().cancel();
    speech().stopMeter();
    if (listeningRef.current) await stopMic();
  }, [stopMic]);

  useEffect(
    () => () => {
      // Unmount: a recogniser or a half-spoken sentence must not outlive the page.
      speech().cancel();
      speech().stopMeter();
      listeningRef.current?.stop?.();
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
    setAnswering,
    answer,
    setAnswer,
    answerWords,
    busy,
    micOn,
    canListen,
    muted,
    toggleMute,
    chip,
    setChip,
    badge,
    caption,
    hint,
    setHint,
    levelRef,
    begin,
    runNext,
    submit,
    repeat,
    toggleMic,
    resumeAt,
    teardown,
    say,
  };
}
