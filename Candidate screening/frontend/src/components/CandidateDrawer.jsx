import { useEffect } from "react";

import { clamp } from "../lib/format.js";

function Bar({ label, value }) {
  const v = Number(value) || 0;
  return (
    <div className="bar-row">
      <strong>{label}</strong> — {v}%
      <div className="bar">
        <i style={{ width: `${clamp(v, 0, 100)}%` }} />
      </div>
    </div>
  );
}

function Block({ title, children }) {
  return (
    <div>
      <h4>{title}</h4>
      <p>{children || "NA"}</p>
    </div>
  );
}

/** Read-only detail panel for one candidate row. */
export default function CandidateDrawer({ candidate, onClose }) {
  useEffect(() => {
    if (!candidate) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [candidate, onClose]);

  if (!candidate) return null;
  const c = candidate;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Candidate detail">
        <div className="drawer-head">
          <h3>{c.candidate_name || c.candidate_id}</h3>
          <button type="button" className="btn btn-link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          <p className="sub">
            {c.candidate_id} · {c.source_file || "manual entry"}
          </p>

          <div>
            <h4>Decision</h4>
            <p>
              <strong>{c.status}</strong> · ATS {c.ats_score}% · AI verdict {c.recommendation}
            </p>
            <p className="sub">{c.decision_reason}</p>
          </div>

          <div>
            <h4>Criterion scores</h4>
            <Bar label="Education" value={c.score_education} />
            <Bar label="Skills" value={c.score_skills} />
            <Bar label="Experience" value={c.score_experience} />
            <Bar label="Projects" value={c.score_projects} />
            <Bar label="Certifications" value={c.score_certifications} />
          </div>

          <Block title="AI justification">{c.justification}</Block>
          <Block title="Matched skills">{c.matched_skills}</Block>
          <Block title="Missing skills">{c.missing_skills}</Block>
          <Block title="Transferable strengths">{c.transferable_strengths}</Block>
          <Block title="Projects">{c.projects}</Block>
          <Block title="Education detail">{c.education_details}</Block>
          <Block title="Current role / location">
            {`${c.current_role || "NA"} · ${c.location || "NA"}`}
          </Block>
          <Block title="Flags">{c.red_flags}</Block>

          {c.extraction_error && (
            <div>
              <h4>Processing note</h4>
              <p className="bad-text">{c.extraction_error}</p>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
