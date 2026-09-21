/** The conversation so far, newest first.
 *
 * A question somebody said they did not know is shown as that, not as an answer
 * with unfortunate content: it was not graded, and displaying it alongside real
 * answers invites it to be read as one.
 */
export default function TurnLog({ turns, emptyAnswerText = "No answer given.", showIds = true }) {
  const asked = turns.filter((t) => t.question);

  if (!asked.length) return <p className="sub">Nothing yet.</p>;

  return (
    <>
      {[...asked].reverse().map((t) => {
        const text = (t.answer || "").trim();
        // Live from the turn just recorded, or from the stored record on reload.
        const declined = Boolean(text) && (t.answer_type === "no_answer" || t.declined === true);
        return (
          <div
            key={t.turn}
            className={`turn ${t.question_source === "followup" ? "followup" : ""} ${
              declined ? "declined" : ""
            }`}
          >
            <div className="turn-q">
              {showIds && <span>{t.question_id || `Q${t.turn}`}</span>}
              <span className="pill pill-muted">{t.category_label || t.category || ""}</span>
              {t.question_source === "followup" && (
                <span className="pill pill-warn">follow-up</span>
              )}
              {declined && <span className="pill pill-muted">moved on</span>}
            </div>
            <p className="turn-question">{t.question}</p>
            <p className={`turn-answer ${text ? "" : "unanswered"} ${declined ? "quiet" : ""}`}>
              {text || emptyAnswerText}
            </p>
          </div>
        );
      })}
    </>
  );
}
