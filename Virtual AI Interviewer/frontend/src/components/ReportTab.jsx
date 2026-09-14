import { useCallback, useEffect, useMemo, useState } from "react";

import Stats from "./Stats.jsx";
import Transcript from "./Transcript.jsx";
import { useToast } from "./Toast.jsx";
import { download, getJson, postJson, putJson, seg } from "../lib/api.js";
import {
  ALL_SCOPE,
  ATTEND,
  ATTEND_FILTERS,
  DECISION,
  DECISION_FILTERS,
  VERDICT_CLS,
} from "../lib/constants.js";
import { band, clip, pct, properName, titleise, when } from "../lib/format.js";

const DECISIONS = [
  ["PROCEED", "Proceed"],
  ["HOLD", "Hold"],
  ["REJECT", "Do not proceed"],
];

function Bullets({ items, empty }) {
  if (!items?.length) return <p className="sub">{empty}</p>;
  return (
    <ul>
      {items.map((i, idx) => (
        <li key={idx}>{i}</li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------- who attended, per list */
function Overview({ shortlists, scope, onScope, data, onRefresh, onOpenReport }) {
  const [attend, setAttend] = useState("ALL");
  const [decision, setDecision] = useState("ALL");
  const [query, setQuery] = useState("");

  const allMode = data?.scope === "all";
  const s = data?.stats;

  const rows = useMemo(() => {
    const all = data?.rows || [];
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      if (attend === "ATTENDED" && !r.attended) return false;
      if (attend === "NOT_ATTENDED" && r.attended) return false;
      if (!["ALL", "ATTENDED", "NOT_ATTENDED"].includes(attend) && r.attendance !== attend) {
        return false;
      }
      if (decision === "NONE" && r.decision) return false;
      if (decision !== "ALL" && decision !== "NONE" && r.decision !== decision) return false;
      if (!q) return true;
      return [r.candidate_name, r.current_role, r.email_id].some((v) =>
        String(v || "").toLowerCase().includes(q),
      );
    });
  }, [data, attend, decision, query]);

  // Counts come from the unfiltered set so a chip never reads zero just because
  // the other filter is narrowing the view.
  const attendCount = (key) =>
    !s
      ? 0
      : key === "ALL"
        ? data.rows.length
        : key === "ATTENDED"
          ? s.attended
          : key === "NOT_ATTENDED"
            ? s.not_attended
            : s.attendance[key] || 0;

  return (
    <div className="card">
      <div className="card-head-row">
        <div>
          <h2>Candidate reports</h2>
          <p className="sub">
            {!data
              ? "Choose a shortlist to see who attended, how they scored, and what was decided."
              : allMode
                ? `Every interview on record · ${s.total} in total · ${s.attended} answered something`
                : `${data.job_title} · ${s.total} shortlisted · ${s.attended} attended · ${s.not_attended} did not`}
          </p>
        </div>
        <div className="toolbar-right">
          <button type="button" className="btn btn-ghost" onClick={onRefresh} disabled={!scope}>
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!data || allMode}
            title={
              allMode
                ? "Pick a shortlist to export its report"
                : "Download this shortlist as one Excel report"
            }
            onClick={() => download(`/api/dashboard/${seg(scope)}/export`)}
          >
            ⬇ Excel report
          </button>
        </div>
      </div>

      <div className="dash-controls">
        <label className="field field-grow">
          <span>Shortlist</span>
          <select value={scope || ""} onChange={(e) => onScope(e.target.value)}>
            {shortlists.length === 0 && <option value="">No shortlists found</option>}
            {shortlists.length > 0 && <option value="">Choose a shortlist…</option>}
            {/* Always offered: the only view that includes one-off interviews
                and ones whose shortlist has since been deleted. */}
            <option value={ALL_SCOPE}>All interviews — every shortlist, plus one-offs</option>
            {shortlists.map((r) => (
              <option key={r.history_id} value={r.history_id}>
                {r.job_title} — {r.interviewable} candidates · accepted {when(r.accepted_at)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {data && (
        <>
          <Stats
            cells={[
              [allMode ? "Interviews" : "Shortlisted", s.total, ""],
              [
                allMode ? "Answered something" : "Attended",
                s.attended,
                s.attended ? "ok" : "",
              ],
              [
                allMode ? "Never started" : "Did not attend",
                s.not_attended,
                s.not_attended ? "bad" : "",
              ],
              ["Proceed", s.decisions.PROCEED || 0, "ok"],
              ["Hold", s.decisions.HOLD || 0, "warn"],
              ["Do not proceed", s.decisions.REJECT || 0, "bad"],
              ["Not decided", s.decisions.NONE || 0, ""],
            ]}
          />

          <div>
            <div className="filter-row">
              <span className="filter-label">Attended</span>
              <div className="chipset">
                {ATTEND_FILTERS.filter(
                  ([k]) => ["ALL", "ATTENDED", "NOT_ATTENDED"].includes(k) || attendCount(k),
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`chip ${attend === k ? "active" : ""}`}
                    onClick={() => setAttend(k)}
                  >
                    {label} ({attendCount(k)})
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-row">
              <span className="filter-label">Decision</span>
              <div className="chipset">
                {DECISION_FILTERS.map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`chip ${decision === k ? "active" : ""}`}
                    onClick={() => setDecision(k)}
                  >
                    {label} ({k === "ALL" ? data.rows.length : s.decisions[k] || 0})
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-row">
              <span className="filter-label">Search</span>
              <input
                type="search"
                value={query}
                placeholder="Candidate, role, email…"
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-link"
                onClick={() => {
                  setAttend("ALL");
                  setDecision("ALL");
                  setQuery("");
                }}
              >
                Clear filters
              </button>
            </div>
          </div>

          <div className="table-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Current role</th>
                  <th className="col-narrow">Attended</th>
                  <th className="col-narrow">Answers</th>
                  <th className="col-narrow">Interview</th>
                  <th className="col-narrow">Decision</th>
                  <th>Reviewed by</th>
                  <th className="col-narrow">Resume ATS</th>
                  <th className="col-tiny" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="sub" style={{ padding: 18 }}>
                      No candidates match these filters.
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const att = ATTEND[r.attendance] || ATTEND.NO_INTERVIEW;
                  const dec = DECISION[r.decision] || DECISION[""];
                  const iv = r.interview;
                  const review = iv?.human_review;
                  return (
                    <tr key={iv?.interview_id || r.candidate_id}>
                      <td>
                        <strong>{properName(r.candidate_name)}</strong>
                        <br />
                        <span className="sub">{r.email_id}</span>
                      </td>
                      <td className="cell-role">{clip(r.current_role, 60)}</td>
                      <td>
                        <span className={`pill ${att.cls}`}>{att.label}</span>
                      </td>
                      <td>
                        {!iv ? (
                          "—"
                        ) : iv.status === "completed" ? (
                          // Follow-ups push the real count past the planned one,
                          // so "11 / 10" would read like a bug. Once finished,
                          // the count stands alone.
                          iv.answered
                        ) : (
                          <>
                            {iv.answered}
                            <span className="sub"> of ~{iv.planned_total || "?"}</span>
                          </>
                        )}
                      </td>
                      <td>
                        {iv && iv.overall_score != null ? (
                          <>
                            <span className={`score ${band(iv.overall_score)}`}>
                              {pct(iv.overall_score)}
                            </span>
                            <br />
                            <span className="sub">{titleise(iv.verdict || "")}</span>
                          </>
                        ) : (
                          <span className="sub">—</span>
                        )}
                      </td>
                      <td>
                        <span className={`pill ${dec.cls}`}>{dec.label}</span>
                        {review?.override_score != null && (
                          <>
                            <br />
                            <span className="sub">override {review.override_score}%</span>
                          </>
                        )}
                      </td>
                      <td>
                        {review?.reviewer && review.reviewer !== "NA" ? (
                          <>
                            {review.reviewer}
                            <br />
                            <span className="sub">{when(review.reviewed_at)}</span>
                          </>
                        ) : (
                          <span className="sub">—</span>
                        )}
                      </td>
                      <td>
                        <span className={`score ${band(r.ats_score)}`}>{r.ats_score ?? "—"}%</span>
                      </td>
                      <td>
                        {iv && iv.overall_score != null && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => onOpenReport(iv.interview_id)}
                          >
                            Open
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="hint">
            {allMode ? (
              <>
                This view lists every interview, including one-offs and any whose shortlist has
                been deleted. <strong>It cannot show who did not attend</strong> — with no
                candidate list there is nobody to be absent. Pick a shortlist above for that.
              </>
            ) : (
              <>
                “Attended” means they answered at least one question. Somebody invited who never
                opened their link counts as not attended. Decisions are recorded on an individual
                report below — open one to set or change it.
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------- one full report */
function Report({ cfg, data, onReload, onChanged }) {
  const toast = useToast();
  const [decision, setDecision] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [notes, setNotes] = useState("");
  const [override, setOverride] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [regrading, setRegrading] = useState(false);

  const interviewId = data.interview_id;

  useEffect(() => {
    const review = data.human_review;
    setDecision(review?.decision || "");
    setReviewer(review?.reviewer === "NA" ? "" : review?.reviewer || "");
    setNotes(review?.notes || "");
    setOverride(review?.override_score ?? "");
    setSavedAt(review?.reviewed_at ? `Last saved ${when(review.reviewed_at)}` : "");
  }, [data]);

  const rep = data.report || {};
  const cand = data.candidate || {};
  const cov = rep.coverage || {};
  const score = rep.overall_score;
  const params = rep.parameters || {};
  const weights = rep.parameter_weights || {};
  const notesByParam = rep.parameter_notes || {};

  const saveReview = async () => {
    if (!decision) return toast("Pick Proceed, Hold or Do not proceed", "err");
    try {
      const res = await putJson(`/api/interviews/${seg(interviewId)}/review`, {
        decision,
        reviewer: reviewer.trim(),
        notes: notes.trim(),
        override_score: String(override).trim(),
      });
      setSavedAt(`Saved ${when(res.human_review.reviewed_at)}`);
      toast("Decision saved", "ok");
      onChanged?.();
    } catch (err) {
      toast(err.message, "err");
    }
  };

  const regrade = async () => {
    setRegrading(true);
    try {
      await postJson(`/api/interviews/${seg(interviewId)}/regrade`);
      await onReload(interviewId);
      toast("Re-reviewed", "ok");
    } catch (err) {
      toast(err.message, "err");
    } finally {
      setRegrading(false);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-head-row">
          <div>
            <h2>{properName(cand.candidate_name) || "Candidate"}</h2>
            <p className="sub">
              {`${data.job_title || "Role"} · interviewed by ${
                data.interviewer?.name || "the AI interviewer"
              } · ${when(data.completed_at || data.started_at)} · ${
                data.interviewer?.company || ""
              }`}
            </p>
          </div>
          <div className="toolbar-right">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={regrade}
              disabled={regrading}
              title="Re-run the closing review over this transcript"
            >
              {regrading ? "Re-reviewing…" : "↻ Re-review"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => download(`/api/interviews/${seg(interviewId)}/export`)}
            >
              ⬇ Excel
            </button>
          </div>
        </div>

        <div className="score-hero">
          <div className="score-dial" style={{ "--pct": score ?? 0 }}>
            <div className="score-value">{pct(score)}</div>
            <div className="score-label">interview score</div>
          </div>
          <div className="score-side">
            <div className="verdict-row">
              <span className={`pill pill-lg ${VERDICT_CLS[rep.verdict] || "pill-bad"}`}>
                {titleise(rep.verdict || "not assessed")}
              </span>
              <span className="pill pill-muted">{rep.confidence || "?"} confidence</span>
            </div>
            <p className="score-summary">
              {rep.summary || "No written summary was produced."}
            </p>

            {/* A score produced on bespoke weights must never look like a
                like-for-like number. Say so, with the deltas. */}
            {rep.weights_are_custom && (
              <div className="inline-note">
                <strong>Scored on weights set for this candidate.</strong> This overall score is
                not directly comparable with one produced on the default weights. Differences:{" "}
                {Object.entries(rep.weight_differences || {})
                  .map(([k, d]) => `${titleise(k)} ${d.used}% (default ${d.default}%)`)
                  .join(" · ")}
                .
              </div>
            )}

            {(rep.confidence_reasons || []).length > 0 && (
              <div className="inline-note inline-note-quiet">
                Confidence was limited because {rep.confidence_reasons.join("; ")}.
              </div>
            )}
          </div>
        </div>

        {/* The comparison a hiring manager actually wants: how the interview
            landed against how the resume looked. */}
        <div className="compare-strip">
          {[
            [pct(score), "Interview score", "how they performed today"],
            [
              pct((rep.screening_reference || {}).ats_score),
              "Resume ATS score",
              "screening stage · not part of the interview score",
            ],
            [
              `${cov.answered || 0} / ${cov.asked || 0}`,
              "Questions answered",
              `${cov.followups || 0} follow-ups asked`,
            ],
            [
              `${cov.graded || 0}`,
              "Answers graded",
              cov.ungraded ? `${cov.ungraded} could not be graded` : "every answer graded",
            ],
            [
              `${Math.round((cov.total_seconds || 0) / 60)} min`,
              "Speaking time",
              `${cov.total_words || 0} words`,
            ],
          ].map(([n, l, d]) => (
            <div className="compare" key={l}>
              <div className="n">{n}</div>
              <div className="l">{l}</div>
              <div className="d">{d}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Evaluation parameters</h2>
        <p className="sub">
          Each score blends the grades given to individual answers with the closing review of the
          whole transcript. A parameter the interview never tested is marked as such rather than
          scored.
        </p>
        <div className="param-list">
          {Object.keys(cfg.parameters || params).map((key) => {
            const p = params[key] || {};
            const value = p.score;
            const untested = value == null;
            return (
              <div key={key} className={`param ${untested ? "unevidenced" : ""}`}>
                <div className="param-head">
                  <span className="param-name">
                    {titleise(key)}
                    <span className="param-weight"> · weight {weights[key] ?? "—"}%</span>
                  </span>
                  <span className={`param-score ${band(value)}`}>
                    {untested ? "not tested by this interview" : `${value}%`}
                  </span>
                </div>
                {!untested && (
                  <div className="param-bar">
                    <i className={band(value)} style={{ width: `${Math.max(2, value)}%` }} />
                  </div>
                )}
                <div className="param-note">{notesByParam[key] || ""}</div>
                <div className="param-basis">
                  {p.basis || ""}
                  {p.answers ? ` · from ${p.answers} answer${p.answers === 1 ? "" : "s"}` : ""}
                  {p.turn_score != null && p.holistic_score != null
                    ? ` · per-answer ${p.turn_score}% vs closing review ${p.holistic_score}%`
                    : ""}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Strengths shown</h2>
          <div className="bullet-block">
            <Bullets items={rep.strengths} empty="Nothing recorded." />
          </div>
        </div>
        <div className="card">
          <h2>Gaps shown</h2>
          <div className="bullet-block">
            <Bullets items={rep.gaps} empty="Nothing recorded." />
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Standout moments</h2>
          <div className="bullet-block">
            <Bullets items={rep.standout_moments} empty="No single answer stood out." />
          </div>
        </div>
        <div className="card">
          <h2>Not covered by this interview</h2>
          <div className="bullet-block">
            <Bullets items={rep.not_covered} empty="Nothing flagged as untested." />
          </div>
          <h3 className="mini-head">Risk flags</h3>
          <div className="bullet-block">
            <Bullets items={rep.risk_flags} empty="None." />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head-row">
          <h2>Recommended next step</h2>
          <span className="pill pill-muted">the AI recommends; a human decides</span>
        </div>
        <p className="next-step">
          {rep.recommended_next_step ||
            "No next step was recommended — read the transcript and decide."}
        </p>

        <h3 className="mini-head">Your decision</h3>
        <div className="grid-2">
          <label className="field">
            <span>Reviewer</span>
            <input
              type="text"
              value={reviewer}
              placeholder="Your name"
              onChange={(e) => setReviewer(e.target.value)}
            />
          </label>
          <label className="field">
            <span>
              Override the score <em>(optional)</em>
            </span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.5"
              value={override}
              placeholder="leave blank to keep the AI score"
              onChange={(e) => setOverride(e.target.value)}
            />
          </label>
        </div>

        <label className="field">
          <span>Notes</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div className="actions-row">
          <div className="chipset">
            {DECISIONS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`chip ${decision === key ? "active" : ""}`}
                onClick={() => setDecision(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-primary" onClick={saveReview}>
            Save decision
          </button>
          <span className="hint">{savedAt}</span>
        </div>
      </div>

      <div className="card">
        <div className="card-head-row">
          <h2>Transcript &amp; per-answer grades</h2>
          <span className="sub">
            {cov.asked || 0} asked · {cov.answered || 0} answered · {cov.followups || 0} follow-ups
          </span>
        </div>
        <Transcript turns={data.turns || []} />
      </div>
    </>
  );
}

export default function ReportTab({
  cfg,
  shortlists,
  scope,
  onScope,
  overview,
  onRefreshOverview,
  report,
  onOpenReport,
  onChanged,
}) {
  const toast = useToast();

  const reload = useCallback(
    async (id) => {
      try {
        await onOpenReport(id);
      } catch (err) {
        toast(`Report: ${err.message}`, "err");
      }
    },
    [onOpenReport, toast],
  );

  return (
    <>
      <Overview
        shortlists={shortlists}
        scope={scope}
        onScope={onScope}
        data={overview}
        onRefresh={onRefreshOverview}
        onOpenReport={onOpenReport}
      />

      {report ? (
        <Report cfg={cfg} data={report} onReload={reload} onChanged={onChanged} />
      ) : (
        <div className="empty empty-tight">
          <h2>No individual report open</h2>
          <p>
            Open a candidate above, or pick a completed interview from <strong>History</strong>.
          </p>
        </div>
      )}
    </>
  );
}

/** Fetches one report; exported so App can drive it from a deep link. */
export const fetchReport = (interviewId) =>
  getJson(`/api/interviews/${seg(interviewId)}/report`);
