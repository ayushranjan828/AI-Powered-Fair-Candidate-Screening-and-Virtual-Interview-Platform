import { useCallback, useEffect, useRef, useState } from "react";

import AvatarStage from "./components/AvatarStage.jsx";
import Caption from "./components/Caption.jsx";
import QuestionPanel from "./components/QuestionPanel.jsx";
import TurnLog from "./components/TurnLog.jsx";
import { useConfirm } from "./components/Confirm.jsx";
import { useToast } from "./components/Toast.jsx";
import useInterviewRun from "./hooks/useInterviewRun.js";
import { getJson, postJson, seg } from "./lib/api.js";
import { duration } from "./lib/format.js";
import { speech } from "./lib/legacy.js";

/* The candidate's side of the interview, reached from the link in the
 * invitation email: /i/<token>.
 *
 * Deliberately a separate page from the recruiter console rather than a mode of
 * it - this must never be able to show a score, a grading key, another
 * candidate, or anything from the console. The only endpoints it touches are
 * the two invite routes and the ordinary interview loop, and it reads the
 * candidate-safe interview view.
 *
 * Two things it deliberately does not show: how many questions are left, and a
 * box to type into. The first changes how people answer once they can see the
 * end coming; the second is a paste target. What replaces them is a clock and a
 * microphone that is simply on, the way it would be on a call.
 */

// /i/<token> — trailing slashes and any query string are tolerated.
const TOKEN = decodeURIComponent(
  (window.location.pathname.match(/\/i\/([^/?#]+)/) || [])[1] || "",
);

const PLAN_POLL_MS = 1200;
/** An alt-tab shorter than this is a notification, not somebody leaving. */
const AWAY_FLOOR_S = 2;
const MIC_CHECK_MS = 5000;

const MIC_TROUBLE = {
  denied: {
    title: "The microphone is blocked",
    body:
      "This interview is spoken, so it cannot run without a microphone. Click the microphone " +
      "icon in your browser's address bar, choose Allow, and try again.",
  },
  missing: {
    title: "No microphone was found",
    body:
      "Plug in or connect a microphone — a headset is ideal — then try again. If you are on a " +
      "laptop, check that the built-in microphone is not disabled in your system settings.",
  },
  unsupported: {
    title: "This browser cannot use the microphone",
    body: "Please open your interview link in Chrome or Edge on a laptop or desktop.",
  },
};

function micTrouble(code) {
  return (
    MIC_TROUBLE[code] || {
      title: "The microphone could not be started",
      body:
        "Close anything else that might be using it — another call, or a recording app — and " +
        "try again.",
    }
  );
}

export default function CandidateApp() {
  const toast = useToast();
  const confirm = useConfirm();

  const [panel, setPanel] = useState("loading");
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [chip, setChip] = useState({ text: "Loading…", cls: "pill-muted" });
  const [interviewId, setInterviewId] = useState(null);
  const [prep, setPrep] = useState({ stage: "Preparing your interview…", detail: "" });
  const [options, setOptions] = useState({});
  const [doneLead, setDoneLead] = useState("");
  const [starting, setStarting] = useState(false);
  const [micProblem, setMicProblem] = useState(null);

  const finishedRef = useRef(false);

  const fail = useCallback((title, body) => {
    setError({ title, body });
    setChip({ text: "Cannot start", cls: "pill-bad" });
    setPanel("error");
  }, []);

  /* --------------------------------------------------------- wrapping up */
  const wrapUp = useCallback(
    async ({ evaluate = true, lead = "" } = {}) => {
      finishedRef.current = true;
      setPanel("wrapping");
      setChip({ text: "Finishing", cls: "pill-muted" });

      // The evaluation is produced for the recruiter. The candidate is never
      // shown it, and never sees a score - they only need to know it saved.
      if (evaluate) {
        try {
          await postJson(`/api/interviews/${seg(interviewId)}/finish`);
        } catch (err) {
          // Their answers are already stored turn by turn, so this is not their
          // problem to solve - the recruiter can re-run the review.
          console.warn("finish failed:", err.message);
        }
      }

      const who = info?.interviewer?.name || "your interviewer";
      setDoneLead(
        lead ||
          `Thank you for talking with ${who} today. Your interview has been saved and the team ` +
            "will review it and be in touch about the next step.",
      );
      setChip({ text: "Completed", cls: "pill-ok" });
      setPanel("done");
    },
    [interviewId, info],
  );

  const run = useInterviewRun({
    interviewId,
    options,
    onClosing: async () => {
      await run.teardown();
      await wrapUp();
    },
    // They asked to stop, out loud, and the interviewer agreed. The microphone
    // goes off here - not when they eventually close the tab.
    onEnded: async (res) => {
      await run.teardown();
      await wrapUp({
        evaluate: res?.evaluate !== false,
        lead:
          "Your interview was ended, and everything you answered has been saved. The team will " +
          "be in touch about the next step.",
      });
    },
    onError: (msg, kind = "err") => toast(msg, kind),
  });

  /* ------------------------------------------------------------ invitation */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!TOKEN) {
        fail(
          "This link is incomplete",
          "The address is missing its invitation code. Please open the link from your email " +
            "again, copying the whole of it.",
        );
        return;
      }

      let data;
      try {
        data = await getJson(`/api/invite/${seg(TOKEN)}`);
      } catch (err) {
        if (cancelled) return;
        const message = String(err.message || "");
        if (/expired/i.test(message)) {
          fail("This interview link has expired", message);
        } else {
          fail(
            "This link cannot be opened",
            message || "The invitation code was not recognised.",
          );
        }
        return;
      }
      if (cancelled) return;

      setInfo(data);
      if (data.state === "completed") {
        setChip({ text: "Completed", cls: "pill-ok" });
        setDoneLead(
          "You have already completed this interview. The team has your responses and will be " +
            "in touch about the next step.",
        );
        setPanel("done");
        return;
      }

      setChip({ text: "Ready when you are", cls: "pill-ok" });
      setPanel("welcome");
    })();

    return () => {
      cancelled = true;
    };
  }, [fail]);

  /* Half an interview must not be lost to a stray tab close. */
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (interviewId && !finishedRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [interviewId]);

  /* Leaving the page mid-interview, and losing the microphone, are both recorded
   * - as observations for the reviewer to read, never as anything that touches a
   * score. Somebody who looked away may have answered their door. */
  useEffect(() => {
    if (!interviewId || panel !== "stage") return undefined;

    let awaySince = 0;
    let micWarned = false;

    const report = (kind, seconds) =>
      postJson(`/api/interviews/${seg(interviewId)}/event`, { kind, seconds }).catch(() => {});

    const onVisibility = () => {
      if (document.hidden) {
        awaySince = Date.now();
        return;
      }
      if (!awaySince) return;
      const seconds = Math.round((Date.now() - awaySince) / 1000);
      awaySince = 0;
      if (seconds < AWAY_FLOOR_S) return;
      report("tab_hidden", seconds);
      toast("Please stay on this page until the interview has finished.", "");
    };

    const micCheck = setInterval(() => {
      if (speech().micLive() || micWarned) return;
      micWarned = true;
      report("mic_lost", 0);
      toast("The microphone stopped. Check it is connected and still allowed.", "err");
    }, MIC_CHECK_MS);

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(micCheck);
    };
  }, [interviewId, panel, toast]);

  /* ------------------------------------------------------------- starting */
  const openStage = useCallback(
    async (id) => {
      let view;
      try {
        view = await getJson(`/api/interviews/${seg(id)}`);
      } catch (err) {
        setPanel("welcome");
        setStarting(false);
        toast(err.message, "err");
        return;
      }

      const turns = view.turns || [];
      run.setTurns(turns);
      setOptions(view.options || {});
      if (view.options?.voice === false) {
        if (!run.muted) run.toggleMute();
      }

      setPanel("stage");
      setChip({ text: "Interview in progress", cls: "pill-live" });

      const last = turns[turns.length - 1];
      if (last && !(last.answer || "").trim()) {
        // Reload mid-question: re-present it rather than requesting a new one.
        run.resumeAt(last, view.progress || {});
        return;
      }
      await run.begin();
    },
    // `run` is rebuilt each render; depending on it would restart the interview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast],
  );

  const begin = useCallback(async () => {
    setStarting(true);
    setMicProblem(null);

    /* The microphone is asked for here and nowhere else, inside the click that
     * browsers require for it - and before anything is created, so a candidate
     * who cannot grant it has not half-started an interview. */
    const granted = await run.arm();
    if (!granted.ok) {
      setStarting(false);
      setMicProblem(granted.error || "denied");
      return;
    }

    setPanel("preparing");
    setChip({ text: "Preparing", cls: "pill-muted" });

    let started;
    try {
      started = await postJson(`/api/invite/${seg(TOKEN)}/start`);
    } catch (err) {
      const message = String(err.message || "");
      if (/already completed/i.test(message)) {
        setChip({ text: "Completed", cls: "pill-ok" });
        setDoneLead(message);
        setPanel("done");
        return;
      }
      setStarting(false);
      setPanel("welcome");
      toast(message || "Could not start the interview", "err");
      return;
    }

    setInterviewId(started.interview_id);

    // Wait for the question plan before showing the stage.
    await new Promise((resolve) => {
      const timer = setInterval(async () => {
        let status;
        try {
          status = await getJson(`/api/interviews/${seg(started.interview_id)}/status`);
        } catch (err) {
          clearInterval(timer);
          setPanel("welcome");
          setStarting(false);
          toast(`Could not prepare the interview: ${err.message}`, "err");
          resolve();
          return;
        }
        setPrep({
          stage: status.progress?.stage || "Preparing your interview…",
          detail: status.progress?.detail || "",
        });
        if (status.status !== "planning") {
          clearInterval(timer);
          await openStage(started.interview_id);
          resolve();
        }
      }, PLAN_POLL_MS);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openStage, toast]);

  /** The button version of saying "I would like to stop". Same ending either way. */
  const endNow = useCallback(async () => {
    const ok = await confirm({
      title: "End the interview now?",
      body:
        "Everything you have answered so far is kept and sent to the team. You will not be " +
        "able to carry on afterwards.",
      ok: "End interview",
      danger: true,
    });
    if (!ok) return;

    const res = await run.endInterview("Ended by the candidate.");
    await run.teardown();
    await wrapUp({
      evaluate: res?.evaluate !== false,
      lead:
        "You ended the interview, and everything you answered has been saved. The team will be " +
        "in touch about the next step.",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm, run.endInterview, wrapUp]);

  /* --------------------------------------------------------------- render */
  const greetingName =
    info?.greeting_name && info.greeting_name !== "there" ? info.greeting_name : "there";

  const limit = info?.time_limit_minutes || 0;
  const remaining = run.progress.time_limit_seconds
    ? Math.max(0, run.progress.time_limit_seconds - run.elapsed)
    : null;
  const lowOnTime = remaining !== null && remaining <= 120;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            🎙️
          </span>
          <div>
            <h1>
              {info?.job_title && info.job_title !== "NA"
                ? `Interview · ${info.job_title}`
                : "Your interview"}
            </h1>
            <p>{info?.company || ""}</p>
          </div>
        </div>
        <div className="topbar-right">
          {panel === "stage" && (
            <span
              className={`clock ${lowOnTime ? "clock-low" : ""}`}
              title={
                remaining !== null
                  ? "Time elapsed, and how long is left"
                  : "How long you have been in the interview"
              }
            >
              <span className="clock-face">{duration(run.elapsed)}</span>
              {remaining !== null && (
                <span className="clock-left">{duration(remaining)} left</span>
              )}
            </span>
          )}
          <span className={`pill ${chip.cls}`}>{chip.text}</span>
        </div>
      </header>

      <main className="candidate-main">
        {panel === "loading" && (
          <section className="card cand-card">
            <div className="drafting">
              <div className="spinner" />
              <p>
                <strong>Checking your invitation…</strong>
              </p>
            </div>
          </section>
        )}

        {panel === "error" && (
          <section className="card cand-card">
            <h2>{error.title}</h2>
            <p className="sub">{error.body}</p>
            <p className="hint">
              If you think this is a mistake, reply to the invitation email and the team will help.
            </p>
          </section>
        )}

        {panel === "welcome" && (
          <section className="card cand-card">
            <div className="welcome-grid">
              <div className="welcome-avatar">
                <AvatarStage />
              </div>
              <div>
                <h2>Hello {greetingName}</h2>
                <p className="welcome-lead">
                  {info?.interviewer?.name || "Your interviewer"} will be interviewing you
                  {info?.job_title && info.job_title !== "NA"
                    ? ` for the ${info.job_title} role`
                    : ""}
                  {info?.company ? ` at ${info.company}` : ""}.
                </p>

                <h3 className="mini-head">What to expect</h3>
                <ul className="welcome-list">
                  <li>
                    A spoken conversation, not a form. You will be asked about your background,
                    your projects and a few scenarios, with follow-up questions based on what you
                    say.
                  </li>
                  <li>
                    <strong>Answers are spoken aloud.</strong> Your microphone stays on for the
                    whole interview and there is nothing to type — just talk, and pause when you
                    have finished an answer.
                  </li>
                  <li>
                    Ask for a question again at any time — say <em>&ldquo;could you repeat
                    that&rdquo;</em> — as often as you need. It is not held against you.
                  </li>
                  <li>
                    If you do not know something, say so and the interviewer will move on to a
                    different question.
                  </li>
                  <li>
                    {limit
                      ? `The interview is scheduled for about ${limit} minutes, and a clock is on screen throughout.`
                      : "There is no per-question timer. Take as long as you need, and think aloud if it helps."}
                  </li>
                  <li>
                    You can stop at any point — say so out loud, or use{" "}
                    <strong>End interview</strong>. Your microphone switches off when you do.
                  </li>
                  <li>
                    If you close this page, opening your link again picks up where you left off.
                  </li>
                </ul>

                {(info?.state === "resume" || info?.state === "preparing") && (
                  <div className="inline-note inline-note-ok">
                    {info.answered
                      ? `Welcome back — you have answered ${info.answered} question${
                          info.answered === 1 ? "" : "s"
                        } so far. We will carry on from there.`
                      : "Welcome back — we will pick up where you left off."}
                  </div>
                )}

                {!run.canListen ? (
                  <div className="inline-note inline-note-bad">
                    <strong>This browser cannot transcribe speech.</strong> The interview is
                    spoken, so please open your link in <strong>Chrome</strong> or{" "}
                    <strong>Edge</strong> on a laptop or desktop. Nothing is lost by switching —
                    your link works exactly the same there.
                  </div>
                ) : micProblem ? (
                  <div className="inline-note inline-note-bad">
                    <strong>{micTrouble(micProblem).title}.</strong>{" "}
                    {micTrouble(micProblem).body}
                  </div>
                ) : (
                  <div className="inline-note inline-note-ok">
                    Your browser supports the interview. You will be asked for microphone access
                    once, when you begin, and it is used only to turn your speech into text in
                    this browser — no audio is recorded or uploaded.
                  </div>
                )}

                <div className="actions-row">
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    onClick={begin}
                    disabled={starting || !run.canListen}
                  >
                    {micProblem
                      ? "Try again"
                      : info?.state === "resume" || info?.state === "preparing"
                        ? "Continue my interview"
                        : "Begin my interview"}
                  </button>
                  <span className="hint">
                    Somewhere quiet, with a headset if you have one, gives the clearest
                    transcription.
                  </span>
                </div>
              </div>
            </div>
          </section>
        )}

        {panel === "preparing" && (
          <section className="card cand-card">
            <div className="drafting">
              <div className="spinner" />
              <p>
                <strong>{prep.stage}</strong>
              </p>
              <p className="sub">
                {prep.detail ||
                  "Your questions are being written from your own experience, so this takes a few seconds."}
              </p>
            </div>
          </section>
        )}

        {panel === "stage" && (
          <section>
            <div className="stage-grid">
              <div className="card stage-card">
                <div className="stage-head">
                  <div>
                    <h2>{info?.interviewer?.name || "Interviewer"}</h2>
                    <p className="sub">{info?.interviewer?.role || ""}</p>
                  </div>
                  <span className={`pill ${run.chip.cls}`}>{run.chip.text}</span>
                </div>

                <AvatarStage badge={run.badge} />
                <Caption tokens={run.caption.tokens} active={run.caption.active} />

                {/* Repeating lives next to the answer, where it is needed; this
                    is only for leaving, which should not sit beside it. */}
                <div className="stage-tools">
                  <button
                    type="button"
                    className="btn btn-danger-ghost"
                    onClick={endNow}
                    disabled={run.busy}
                    title="Stop here — your answers so far are kept"
                  >
                    End interview
                  </button>
                </div>
              </div>

              <div className="stage-col">
                <QuestionPanel
                  run={run}
                  topicFallback="Getting started"
                  showProgress={false}
                  meta=""
                />

                <div className="card">
                  <div className="card-head-row">
                    <h2>Your answers so far</h2>
                    <span className="sub">{run.progress.answered ?? 0} answered</span>
                  </div>
                  <div className="turn-log">
                    <TurnLog turns={run.turns} emptyAnswerText="Not answered." showIds={false} />
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {panel === "wrapping" && (
          <section className="card cand-card">
            <div className="drafting">
              <div className="spinner" />
              <p>
                <strong>Thank you — just wrapping up.</strong>
              </p>
              <p className="sub">
                Please keep this page open for a moment while your interview is saved.
              </p>
            </div>
          </section>
        )}

        {panel === "done" && (
          <section className="card cand-card">
            <div className="done-block">
              <div className="done-mark">✓</div>
              <h2>Your interview is complete</h2>
              <p className="welcome-lead">{doneLead}</p>
              <p className="hint">
                Your microphone has been switched off. You can close this page now — there is
                nothing further for you to do, and this link will no longer start a new interview.
              </p>
            </div>
          </section>
        )}
      </main>
    </>
  );
}
