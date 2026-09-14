/**
 * The question being asked, its progress through the plan, and the box the
 * answer goes into. Shared by the recruiter's stage and the candidate's page;
 * it is given only what a candidate may see, so neither can leak a grade.
 */
export default function QuestionPanel({
  run,
  countLabel,
  topicFallback = "Not started",
  questionFallback = "",
  showDifficulty = false,
  answerLabel,
  children,
}) {
  const { prompt, progress, answering, answer, setAnswer, answerWords, busy, micOn, canListen } =
    run;

  const label =
    answerLabel ??
    (!canListen
      ? "Your answer (type it)"
      : micOn
        ? "Your answer — listening, speak naturally"
        : "Your answer");

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
        <span className="qcount">{countLabel}</span>
      </div>

      <div className="progress-bar progress-bar-slim">
        <div className="progress-fill" style={{ width: `${progress.percent || 0}%` }} />
      </div>

      <p className="question-text">{prompt?.question || questionFallback}</p>
      {run.hint && <p className="hint">{run.hint}</p>}

      {answering && (
        <div className="answer-box">
          <label className="field">
            <span>{label}</span>
            <textarea
              rows={7}
              value={answer}
              disabled={busy}
              placeholder="Speak, or type your answer here…"
              onChange={(e) => setAnswer(e.target.value)}
            />
          </label>

          <div className="level-row">
            <span className="level-label">mic</span>
            <div className="level-bar">
              <div className="level-fill" ref={run.levelRef} />
            </div>
            <span className="level-stats">
              {answerWords} word{answerWords === 1 ? "" : "s"}
            </span>
          </div>

          <div className="answer-actions">
            <button
              type="button"
              className={micOn ? "btn btn-rec" : "btn btn-primary"}
              onClick={run.toggleMic}
              disabled={busy || !canListen}
            >
              {!canListen ? "🎤 Not available" : micOn ? "⏹ Stop the mic" : "🎤 Start answering"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => run.submit("voice")}
              disabled={busy || answerWords < 1}
            >
              Submit answer →
            </button>
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
