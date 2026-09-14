import { useCallback, useEffect, useRef, useState } from "react";

import AvatarStage from "./components/AvatarStage.jsx";
import Caption from "./components/Caption.jsx";
import QuestionPanel from "./components/QuestionPanel.jsx";
import TurnLog from "./components/TurnLog.jsx";
import { useConfirm } from "./components/Confirm.jsx";
import { useToast } from "./components/Toast.jsx";
import useInterviewRun from "./hooks/useInterviewRun.js";
import { getJson, postJson, seg } from "./lib/api.js";
import { speech } from "./lib/legacy.js";

/* The candidate's side of the interview, reached from the link in the
 * invitation email: /i/<token>.
 *
 * Deliberately a separate page from the recruiter console rather than a mode of
 * it - this must never be able to show a score, a grading key, another
 * candidate, or anything from the console. The only endpoints it touches are
 * the two invite routes and the ordinary interview loop, and it reads the
 * candidate-safe interview view.
 */

// /i/<token> — trailing slashes and any query string are tolerated.
const TOKEN = decodeURIComponent(
  (window.location.pathname.match(/\/i\/([^/?#]+)/) || [])[1] || "",
);

const PLAN_POLL_MS = 1200;

function DeviceNote() {
  const problems = [];
  if (!speech().canListen) {
    problems.push(
      "This browser cannot turn speech into text, so you will need to type your answers. " +
        "Chrome or Edge supports the microphone.",
    );
  }
  if (!speech().canSpeak) {
    problems.push(
      "This browser has no voice, so the questions will appear on screen without being read aloud.",
    );
  }

  return problems.length ? (
    <div className="inline-note">{problems.join(" ")}</div>
  ) : (
    <div className="inline-note inline-note-ok">
      Your browser supports both the voice and the microphone. You will be asked for microphone
      access when you begin.
    </div>
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

  const finishedRef = useRef(false);

  const fail = useCallback((title, body) => {
    setError({ title, body });
    setChip({ text: "Cannot start", cls: "pill-bad" });
    setPanel("error");
  }, []);

  /* --------------------------------------------------------- wrapping up */
  const wrapUp = useCallback(async () => {
    finishedRef.current = true;
    setPanel("wrapping");
    setChip({ text: "Finishing", cls: "pill-muted" });

    // The evaluation is produced for the recruiter. The candidate is never
    // shown it, and never sees a score - they only need to know it saved.
    try {
      await postJson(`/api/interviews/${seg(interviewId)}/finish`);
    } catch (err) {
      // Their answers are already stored turn by turn, so this is not their
      // problem to solve - the recruiter can re-run the review.
      console.warn("finish failed:", err.message);
    }

    const who = info?.interviewer?.name || "your interviewer";
    setDoneLead(
      `Thank you for talking with ${who} today. Your interview has been saved and the team will ` +
        "review it and be in touch about the next step.",
    );
    setChip({ text: "Completed", cls: "pill-ok" });
    setPanel("done");
  }, [interviewId, info]);

  const run = useInterviewRun({
    interviewId,
    options,
    onClosing: async () => {
      await run.teardown();
      await wrapUp();
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

    // Started from the click that got us here, so the browser grants audio.
    if (speech().canListen) {
      speech().startMeter((level) => {
        const el = run.levelRef.current;
        if (el) el.style.width = `${Math.round(level * 100)}%`;
        window.Avatar?.pulse?.(level);
      });
    }

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

  const skip = useCallback(async () => {
    const ok = await confirm({
      title: "Skip this question?",
      body: "It will be recorded as unanswered.",
      ok: "Skip",
    });
    if (ok) await run.submit("skipped");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm, run.submit]);

  /* --------------------------------------------------------------- render */
  const greetingName =
    info?.greeting_name && info.greeting_name !== "there" ? info.greeting_name : "there";

  const total = run.progress.planned_total || 0;
  const asked = run.progress.planned_asked || 0;

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
                    A conversation, not a form. You will be asked about your background, your
                    projects and a few scenarios, with follow-up questions based on what you say.
                  </li>
                  <li>
                    <strong>Speak your answers, or type them</strong> — whichever you prefer. You
                    can switch at any point.
                  </li>
                  <li>
                    There is no timer. Take as long as you need on each answer, and think aloud if
                    it helps.
                  </li>
                  <li>You can have any question repeated, and you can skip a question.</li>
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

                <DeviceNote />

                <div className="actions-row">
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    onClick={begin}
                    disabled={starting}
                  >
                    {info?.state === "resume" || info?.state === "preparing"
                      ? "Continue my interview"
                      : "Begin my interview"}
                  </button>
                  <span className="hint">
                    Your microphone is used only to turn your speech into text in this browser. No
                    audio is recorded or uploaded.
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

                <div className="stage-tools">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={run.repeat}
                    disabled={run.busy}
                  >
                    ↻ Repeat the question
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={run.toggleMute}>
                    {run.muted ? "🔊 Unmute voice" : "🔈 Mute voice"}
                  </button>
                </div>
              </div>

              <div className="stage-col">
                <QuestionPanel
                  run={run}
                  topicFallback="Getting started"
                  countLabel={total ? `Question ${Math.min(asked, total)} of about ${total}` : ""}
                >
                  <button
                    type="button"
                    className="btn btn-link"
                    onClick={skip}
                    disabled={run.busy}
                  >
                    Skip this question
                  </button>
                </QuestionPanel>

                <div className="card">
                  <div className="card-head-row">
                    <h2>Your answers so far</h2>
                    <span className="sub">{run.progress.answered ?? 0} answered</span>
                  </div>
                  <div className="turn-log">
                    <TurnLog turns={run.turns} emptyAnswerText="Skipped." showIds={false} />
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
                You can close this page now. There is nothing further for you to do, and this link
                will no longer start a new interview.
              </p>
            </div>
          </section>
        )}
      </main>
    </>
  );
}
