/**
 * The question being asked and the answer being spoken back.
 *
 * Shared by the recruiter's stage and the candidate's page, and given only what
 * a candidate may see, so neither can leak a grade. What differs between them is
 * passed in: the recruiter sees how far through the plan the interview is, and
 * the candidate sees the clock instead - knowing that two questions remain
 * changes how people answer the second-to-last one.
 *
 * There is nowhere to type. The transcript below is the microphone's, shown so
 * the candidate can see they are being heard, and it is deliberately read-only:
 * a text box in an interview is a paste target.
 */
export default function QuestionPanel({
  run,
  meta,
  topicFallback = "Not started",
  questionFallback = "",
  showDifficulty = false,
  showProgress = true,
  children,
}) {
  const { prompt, progress, answering, transcript, spokenWords, busy, listening, countdown } = run;

  const status = countdown
    ? `That looks like the end of your answer — sending in ${countdown}…`
    : listening
      ? "Listening — speak naturally, and take your time"
      : busy
        ? "One moment…"
        : "Microphone paused";

  return (
    <div className="card">
      <div className="qhead">
        <div className="qmeta">
          <span className={`pill ${prompt?.category_label ? "pill-brand" : "pill-muted"}`}>
            {prompt?.category_label || topicFallback}
          </span>
          {showDifficulty && prompt?.difficulty && (
            <span className="pill pill-muted">{prompt.difficulty}</span>
          )}
          {prompt?.question_source === "followup" && (
            <span className="pill pill-warn">follow-up</span>
          )}
        </div>
        <span className="qcount">{meta}</span>
      </div>

      {showProgress && (
        <div className="progress-bar progress-bar-slim">
          <div className="progress-fill" style={{ width: `${progress.percent || 0}%` }} />
        </div>
      )}

      <p className="question-text">{prompt?.question || questionFallback}</p>
      {run.hint && <p className="hint">{run.hint}</p>}

      {answering && (
        <div className="answer-box">
          <div className={`answer-status ${countdown ? "is-ending" : listening ? "is-live" : ""}`}>
            {listening && <span className="rec-dot" />}
            <span>{status}</span>
          </div>

          <div className="transcript" aria-live="polite" aria-label="What you are saying">
            {transcript ? (
              <p>{transcript}</p>
            ) : (
              <p className="transcript-empty">
                {run.confirming
                  ? "Say “yes” to end the interview, or “no” to carry on."
                  : "Your words will appear here as you speak."}
              </p>
            )}
          </div>

          <div className="level-row">
            <span className="level-label">mic</span>
            <div className="level-bar">
              <div className="level-fill" ref={run.levelRef} />
            </div>
            <span className="level-stats">
              {spokenWords} word{spokenWords === 1 ? "" : "s"}
            </span>
          </div>

          <div className="answer-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => run.submit("voice")}
              disabled={busy || spokenWords < 1}
              title="Send this answer and move to the next question"
            >
              {run.confirming ? "Send my reply →" : "Done answering →"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={run.repeat}
              disabled={busy}
              title="Have the question asked again — this costs you nothing"
            >
              ↻ Repeat the question
            </button>
            {children}
          </div>

          <p className="hint">
            There is no need to press anything: pause when you have finished and the interviewer
            moves on by itself. You can ask for the question again at any point, out loud.
          </p>
        </div>
      )}
    </div>
  );
}
