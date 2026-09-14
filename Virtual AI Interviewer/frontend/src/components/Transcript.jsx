import { band, titleise } from "../lib/format.js";

function List({ items }) {
  if (!items?.length) return <p className="sub">—</p>;
  return (
    <ul>
      {items.map((i, idx) => (
        <li key={idx}>{i}</li>
      ))}
    </ul>
  );
}

/** Every question, the answer, and the grades that answer earned. */
export default function Transcript({ turns }) {
  if (!turns.length) return <p className="sub">No transcript.</p>;

  return (
    <div className="transcript">
      {turns.map((t) => {
        const a = t.assessment || {};
        const scores = a.scores || {};
        const answered = (t.answer || "").trim();

        return (
          <div
            key={t.turn}
            className={`tr-turn ${t.question_source === "followup" ? "followup" : ""}`}
          >
            <div className="tr-head">
              <span className="pill pill-muted">{t.question_id || `Q${t.turn}`}</span>
              <span className="pill pill-brand">{t.category_label || t.category}</span>
              {t.difficulty && <span className="pill pill-muted">{t.difficulty}</span>}
              {t.question_source === "followup" && (
                <span className="pill pill-warn">follow-up</span>
              )}
              {a.answer_type && (
                <span className="pill pill-muted">{a.answer_type.replace(/_/g, " ")}</span>
              )}
              {a.source === "fallback" && (
                <span className="pill pill-bad" title={a.error || ""}>
                  not graded
                </span>
              )}
              <span className="sub">
                {t.metrics?.words || 0} words · {t.answer_seconds || 0}s
              </span>
            </div>

            <p className="tr-q">{t.question}</p>
            <div className={`tr-a ${answered ? "" : "empty"}`}>
              {answered || "No answer given."}
            </div>

            {Object.keys(scores).length > 0 && (
              <div className="tr-grades">
                {Object.entries(scores).map(([k, v]) => (
                  <span key={k} className={`tr-grade ${band(v)}`}>
                    {titleise(k)} {v}
                  </span>
                ))}
              </div>
            )}

            {a.evidence && <p className="tr-evidence">Evidence: {a.evidence}</p>}

            <div className="tr-notes">
              <div>
                <h5>Strengths</h5>
                <List items={a.strengths} />
              </div>
              <div>
                <h5>Concerns</h5>
                <List items={a.concerns} />
              </div>
            </div>

            {t.intent && (
              <p className="sub" style={{ marginTop: 8 }}>
                Tested: {t.intent}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
