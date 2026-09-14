/** The conversation so far, newest first. */
export default function TurnLog({ turns, emptyAnswerText = "No answer given.", showIds = true }) {
  const answered = turns.filter((t) => t.question);

  if (!answered.length) return <p className="sub">Nothing yet.</p>;

  return (
    <>
      {[...answered].reverse().map((t) => {
        const text = (t.answer || "").trim();
        return (
          <div
            key={t.turn}
            className={`turn ${t.question_source === "followup" ? "followup" : ""}`}
          >
            <div className="turn-q">
              {showIds && <span>{t.question_id || `Q${t.turn}`}</span>}
              <span className="pill pill-muted">{t.category_label || t.category || ""}</span>
              {t.question_source === "followup" && (
                <span className="pill pill-warn">follow-up</span>
              )}
            </div>
            <p className="turn-question">{t.question}</p>
            <p className={`turn-answer ${text ? "" : "empty"}`}>{text || emptyAnswerText}</p>
          </div>
        );
      })}
    </>
  );
}
