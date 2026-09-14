import { useCallback, useEffect, useRef, useState } from "react";

import AvatarStage from "./AvatarStage.jsx";
import Caption from "./Caption.jsx";
import QuestionPanel from "./QuestionPanel.jsx";
import TurnLog from "./TurnLog.jsx";
import { useConfirm } from "./Confirm.jsx";
import { useToast } from "./Toast.jsx";
import useInterviewRun from "../hooks/useInterviewRun.js";
import { getJson, postJson, seg } from "../lib/api.js";
import { properName } from "../lib/format.js";

/**
 * The recruiter conducting an interview themselves — used when they are sitting
 * with the candidate, or resuming one that was left half-finished.
 *
 * The candidate's own page runs the same turn loop through the same hook; what
 * differs is everything around it, which is why they are separate components.
 */
export default function StageTab({ interviewId, onEvaluated, onAbandoned }) {
  const toast = useToast();
  const confirm = useConfirm();

  const [interview, setInterview] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [gate, setGate] = useState("start"); // start | running | finish
  const [evaluating, setEvaluating] = useState(false);
  const loadedFor = useRef(null);

  const run = useInterviewRun({
    interviewId,
    options: interview?.options,
    onClosing: () => setGate("finish"),
    onError: (msg, kind = "err") => toast(msg, kind),
  });

  /* -------------------------------------------------------------- loading */
  useEffect(() => {
    if (!interviewId || loadedFor.current === interviewId) return;
    loadedFor.current = interviewId;

    let cancelled = false;
    (async () => {
      let view;
      try {
        view = await getJson(`/api/interviews/${seg(interviewId)}`);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message);
          toast(`Could not open the interview: ${err.message}`, "err");
        }
        return;
      }
      if (cancelled) return;

      setInterview(view);
      setLoadError(null);
      const turns = view.turns || [];
      run.setTurns(turns);
      run.setProgress(view.progress || {});
      if (view.options?.voice === false && !run.muted) run.toggleMute();

      if (view.status === "completed") {
        setGate("finish");
        run.setChip({ text: "Completed", cls: "pill-ok" });
        return;
      }

      const last = turns[turns.length - 1];
      if (last && !(last.answer || "").trim()) {
        // Mid-interview reload: pick the conversation back up where it stopped.
        setGate("running");
        run.resumeAt(last, view.progress || {});
      } else if (turns.length) {
        // Answers all in, mid-interview: carry on with the next question.
        setGate("running");
        run.runNext();
      } else {
        setGate("start");
      }
    })();

    return () => {
      cancelled = true;
    };
    // `run` is rebuilt every render; depending on it would reload in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interviewId]);

  /* An interview in progress must not be lost to a stray tab close. */
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (interviewId && interview?.status === "in_progress") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [interviewId, interview]);

  /* -------------------------------------------------------------- actions */
  const begin = useCallback(async () => {
    setGate("running");
    await run.begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.begin]);

  const skip = useCallback(async () => {
    const ok = await confirm({
      title: "Skip this question?",
      body: "It will be recorded as unanswered.",
      ok: "Skip",
    });
    if (ok) await run.submit("skipped");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm, run.submit]);

  const evaluate = useCallback(async () => {
    setEvaluating(true);
    await run.teardown();
    window.Avatar?.setEmotion?.("thinking")?.setState?.("thinking");
    run.setChip({ text: "Writing up the interview", cls: "pill-muted" });
    try {
      await postJson(`/api/interviews/${seg(interviewId)}/finish`);
      toast("Evaluation complete", "ok");
      await onEvaluated(interviewId);
    } catch (err) {
      toast(`Evaluation failed: ${err.message}`, "err");
    } finally {
      setEvaluating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interviewId, onEvaluated, toast]);

  const abandon = useCallback(async () => {
    const ok = await confirm({
      title: "End this interview and discard it?",
      body: "The transcript so far is kept, but it will not be evaluated.",
      ok: "End interview",
      danger: true,
    });
    if (!ok) return;

    await run.teardown();
    try {
      await postJson(`/api/interviews/${seg(interviewId)}/abandon`, {
        reason: "Ended by the operator",
      });
      toast("Interview ended", "");
      loadedFor.current = null;
      setInterview(null);
      await onAbandoned();
    } catch (err) {
      toast(err.message, "err");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm, interviewId, onAbandoned, toast]);

  /* --------------------------------------------------------------- render */
  if (!interviewId || loadError) {
    return (
      <div className="empty">
        <h2>No interview prepared</h2>
        <p>
          Set a candidate up on the <strong>Dashboard</strong> tab, or reopen one from{" "}
          <strong>History</strong>.
        </p>
      </div>
    );
  }

  if (!interview) {
    return (
      <div className="empty">
        <div className="spinner" />
        <p>Opening the interview…</p>
      </div>
    );
  }

  const who = interview.interviewer || {};
  const total = run.progress.planned_total || interview.planned_total || 0;
  const asked = run.progress.planned_asked || 0;
  const followups = run.progress.followups || 0;
  const answered = run.progress.answered ?? 0;

  const countLabel = total
    ? `Question ${Math.min(asked, total)} of ${total}` +
      (followups ? ` · ${followups} follow-up${followups === 1 ? "" : "s"}` : "")
    : "";

  return (
    <div className="stage-grid">
      <div className="card stage-card">
        <div className="stage-head">
          <div>
            <h2>{who.name || "Interviewer"}</h2>
            <p className="sub">
              {`${who.role || "Interviewer"}${who.company ? ` · ${who.company}` : ""}`}
              {` — interviewing ${
                properName(interview.candidate?.candidate_name) || "the candidate"
              } for ${interview.job_title || "the role"}`}
            </p>
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
            title="Have the question asked again"
          >
            ↻ Repeat question
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              run.toggleMute();
              toast(
                run.muted ? "Voice on" : "Voice muted — the questions are still on screen",
                "",
              );
            }}
            title="Silence the interviewer's voice"
          >
            {run.muted ? "🔊 Unmute voice" : "🔈 Mute voice"}
          </button>
          <button type="button" className="btn btn-link" onClick={abandon}>
            End &amp; discard
          </button>
        </div>
      </div>

      <div className="stage-col">
        <QuestionPanel
          run={run}
          showDifficulty
          countLabel={countLabel}
          questionFallback={
            gate === "finish"
              ? "This interview is finished."
              : "The interview has not started yet."
          }
        >
          <button type="button" className="btn btn-ghost" onClick={skip} disabled={run.busy}>
            Skip this question
          </button>
        </QuestionPanel>

        {gate === "start" && (
          <div className="start-gate">
            <p>
              <strong>Ready when you are.</strong>
            </p>
            <p className="sub">
              The interviewer will greet you, then ask the first question. Answer out loud — your
              microphone is only used to transcribe your answer in this browser.
            </p>
            <button type="button" className="btn btn-primary btn-lg" onClick={begin}>
              Begin the interview
            </button>
          </div>
        )}

        {gate === "finish" && (
          <div className="start-gate">
            <p>
              <strong>That is the end of the interview.</strong>
            </p>
            <p className="sub">
              The interviewer will now review the whole conversation and score it on
              communication, technical and domain knowledge, project understanding, fit to the job
              description, problem solving and answer quality.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={evaluate}
              disabled={evaluating}
            >
              {evaluating ? "Reviewing the whole conversation…" : "Evaluate this interview"}
            </button>
          </div>
        )}

        <div className="card">
          <div className="card-head-row">
            <h2>Conversation so far</h2>
            <span className="sub">
              {answered} answer{answered === 1 ? "" : "s"} recorded
            </span>
          </div>
          <div className="turn-log">
            <TurnLog turns={run.turns} />
          </div>
        </div>
      </div>
    </div>
  );
}
