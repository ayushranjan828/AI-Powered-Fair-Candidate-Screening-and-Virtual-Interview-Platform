import { useCallback, useMemo, useState } from "react";

import InterviewShape, { defaultOptions } from "./InterviewShape.jsx";
import ManualFold from "./ManualFold.jsx";
import Stats from "./Stats.jsx";
import { useConfirm } from "./Confirm.jsx";
import { useToast } from "./Toast.jsx";
import { postJson, seg } from "../lib/api.js";
import { STAGES, STAGE_ORDER } from "../lib/constants.js";
import { band, clip, pct, properName, titleise, when } from "../lib/format.js";

/* One row per shortlisted candidate: where they are, their link, and every
 * action the recruiter can take on them. The whole row set comes from
 * /api/dashboard/{id} in a single call — the browser never fans out per
 * candidate to find out who has an interview. */

/** A one-line summary of what a row will actually get, for the Actions column. */
function OptionsBadge({ row, cfg }) {
  if (!row.has_custom_options) return null;
  const o = row.options || {};
  const bits = [`${o.planned_count}Q`];
  if (o.max_followups !== undefined) bits.push(`${o.max_followups} follow-up`);
  const total = Object.keys(cfg.categories || {}).length;
  if (o.categories && total && o.categories.length < total) {
    bits.push(`${o.categories.length}/${total} categories`);
  }
  if (o.voice_name) bits.push("set voice");

  return (
    <div className="row-badge">
      <span className="pill pill-brand" title={row.options_note || "Settings set for this candidate"}>
        ⚙ {bits.join(" · ")}
      </span>
      {/* Custom weights get their own marker: it is the one override that makes
          this candidate's score not directly comparable with anybody else's. */}
      {row.has_custom_weights && (
        <span
          className="pill pill-warn"
          title="Scored on weights of their own, so this score is not directly comparable with one scored on the defaults."
        >
          ⚖ custom weights
        </span>
      )}
    </div>
  );
}

function RowActions({ row, cfg, onSettings, onMail, onRevoke, onReport, onResume, onExport, onNow }) {
  const iv = row.interview;
  const done = iv && iv.status === "completed";

  return (
    <div className="row-actions">
      {/* Settings first: it is what you set before doing anything else. */}
      {!done && (
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          title="Set this candidate's own question count, depth and categories"
          onClick={() => onSettings(row.candidate_id)}
        >
          ⚙ Settings
        </button>
      )}

      {/* Reading the invitation only makes sense once the screening app has
          written one; withdrawing works whether or not this app saw the link. */}
      {row.outreach && (
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          title="Read the invitation the screening app sent"
          onClick={() => onMail(row.candidate_id)}
        >
          Invitation…
        </button>
      )}

      {row.invite?.revoked ? (
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={() => onRevoke(row.candidate_id, false)}
        >
          Restore link
        </button>
      ) : (
        !done &&
        row.outreach && (
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            title="Stop this candidate's link from opening an interview"
            onClick={() => onRevoke(row.candidate_id, true)}
          >
            Deactivate link
          </button>
        )
      )}

      {iv && iv.overall_score != null ? (
        <>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => onReport(iv.interview_id)}
          >
            Report
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => onExport(iv.interview_id)}
          >
            ⬇
          </button>
        </>
      ) : iv && iv.status !== "abandoned" ? (
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={() => onResume(iv.interview_id)}
        >
          Open
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          title="Conduct this interview yourself, here and now"
          onClick={() => onNow(row)}
        >
          Interview now
        </button>
      )}

      <OptionsBadge row={row} cfg={cfg} />
    </div>
  );
}

export default function DashboardTab({
  cfg,
  shortlists,
  shortlistsMeta,
  historyId,
  onPickShortlist,
  dash,
  onRefresh,
  defaults,
  setDefaults,
  voices,
  preferred,
  onOpenStage,
  onOpenReport,
  onOpenMail,
  onOpenSettings,
  onExportInterview,
  planProgress,
  setPlanProgress,
  waitForPlan,
}) {
  const toast = useToast();
  const confirm = useConfirm();

  const [stageFilter, setStageFilter] = useState("ALL");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const all = dash?.rows || [];
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      if (stageFilter !== "ALL" && r.stage !== stageFilter) return false;
      if (!q) return true;
      return [r.candidate_name, r.current_role, r.email_id, r.experience].some((v) =>
        String(v || "").toLowerCase().includes(q),
      );
    });
  }, [dash, stageFilter, query]);

  const setRevoked = useCallback(
    async (cid, revoked) => {
      if (revoked) {
        const ok = await confirm({
          title: "Deactivate this link?",
          body:
            "The candidate will not be able to start or resume their interview with it. " +
            "You can restore it afterwards.",
          ok: "Deactivate",
          danger: true,
        });
        if (!ok) return;
      }
      try {
        await postJson(`/api/invites/${seg(historyId)}/${seg(cid)}/revoke`, { revoked });
        await onRefresh();
        toast(revoked ? "Link withdrawn" : "Link restored", "ok");
      } catch (err) {
        toast(err.message, "err");
      }
    },
    [confirm, historyId, onRefresh, toast],
  );

  /** Conduct this shortlisted candidate's interview here and now, no link. */
  const interviewNow = useCallback(
    async (row) => {
      if (!row) return;
      const ok = await confirm({
        title: "Start this interview here and now?",
        detail: properName(row.candidate_name),
        body:
          "Use this when you are sitting with the candidate. To let them take it in their own " +
          "time, send them their link instead.",
        ok: "Start now",
      });
      if (!ok) return;

      setPlanProgress({ stage: "Starting", detail: "" });
      try {
        const res = await postJson("/api/interviews", {
          source: "screening",
          history_id: historyId,
          candidate_id: row.candidate_id,
          job_title: dash.job_title,
          jd_text: dash.jd_text,
          jd_analysis: dash.jd_analysis || {},
          options: defaults,
        });
        await waitForPlan(res.interview_id, { openStage: true });
        await onRefresh();
      } catch (err) {
        toast(`Could not prepare the interview: ${err.message}`, "err");
        setPlanProgress(null);
      }
    },
    [confirm, dash, defaults, historyId, onRefresh, setPlanProgress, toast, waitForPlan],
  );

  const stats = dash?.stats;
  const counts = useMemo(() => {
    const out = { ALL: dash?.rows?.length || 0 };
    (dash?.rows || []).forEach((r) => {
      out[r.stage] = (out[r.stage] || 0) + 1;
    });
    return out;
  }, [dash]);

  const rubric = dash?.jd_analysis || {};

  return (
    <>
      <div className="card">
        <div className="card-head-row">
          <div>
            <h2>Interview dashboard</h2>
            <p className="sub">
              {dash
                ? `${dash.job_title} · ${stats.total} shortlisted · accepted ${when(dash.accepted_at)}`
                : "Choose a shortlist to see every candidate, their interview link, and where they have got to."}
            </p>
          </div>
          <div className="toolbar-right">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onRefresh}
              disabled={!historyId}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="dash-controls">
          <label className="field field-grow">
            <span>Accepted shortlist</span>
            <select value={historyId || ""} onChange={(e) => onPickShortlist(e.target.value)}>
              {shortlists.length === 0 ? (
                <option value="">No shortlists found</option>
              ) : (
                <>
                  <option value="">Choose a shortlist…</option>
                  {shortlists.map((r) => (
                    <option key={r.history_id} value={r.history_id}>
                      {r.job_title} — {r.interviewable} to interview · accepted{" "}
                      {when(r.accepted_at)}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>
        </div>

        {shortlists.length === 0 && shortlistsMeta && (
          <div className="inline-note">
            No accepted shortlist was found from the screening app. Accept one there first, or use
            “Interview somebody not on a shortlist” below. Looked in:{" "}
            {(shortlistsMeta.searched || []).join("  ·  ")}
            {shortlistsMeta.legacy_count
              ? `  —  note: ${shortlistsMeta.legacy_count} file(s) are sitting in the old folder ${shortlistsMeta.legacy_dir}, which is no longer read. Move them into the folder above to use them.`
              : ""}
          </div>
        )}

        {dash && !dash.links_enabled && (
          <div className="inline-note">
            Interview links are not configured on this server, so links sent by the screening app
            cannot be opened. Set INTERVIEW_LINK_SECRET (or AZURE_OPENAI_API_KEY) in .env — it must
            match the screening app&apos;s.
          </div>
        )}

        {dash && (
          <Stats
            cells={[
              ["Shortlisted", stats.total, ""],
              ["Not invited", stats.counts.NOT_INVITED || 0, stats.counts.NOT_INVITED ? "warn" : ""],
              // Named for what it means to the recruiter: invited, not started
              // yet. Someone who has begun counts under "In progress" instead.
              ["Awaiting start", (stats.counts.DRAFTED || 0) + (stats.counts.SENT || 0), ""],
              ["In progress", (stats.counts.IN_PROGRESS || 0) + (stats.counts.PREPARING || 0), ""],
              ["Completed", stats.completed, stats.completed ? "ok" : ""],
              ["Average score", stats.average_score == null ? "—" : `${stats.average_score}%`, ""],
            ]}
          />
        )}
      </div>

      {dash && (
        <div className="card">
          <div className="sim-banner">
            <span className="sim-dot" />
            <div>
              <strong>Invitations are sent from the screening app.</strong>
              <span>
                This app does not issue or send links. Here you can read the invitation that went
                out, see when it was sent, set a candidate&apos;s interview shape, and deactivate a
                link if you need to stop it being used.
              </span>
            </div>
          </div>

          <div className="toolbar">
            <div className="toolbar-left">
              <div className="chipset">
                {STAGE_ORDER.filter((k) => k === "ALL" || counts[k]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`chip ${stageFilter === k ? "active" : ""}`}
                    onClick={() => setStageFilter(k)}
                  >
                    {k === "ALL" ? "All" : STAGES[k].label} ({counts[k] || 0})
                  </button>
                ))}
              </div>
              <input
                type="search"
                value={query}
                placeholder="Search name, role, email…"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="table-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Current role</th>
                  <th className="col-narrow">Resume ATS</th>
                  <th className="col-narrow">Stage</th>
                  <th className="col-narrow">Interview</th>
                  <th className="col-wide">Invitation</th>
                  <th className="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="sub" style={{ padding: 18 }}>
                      No candidates match this filter.
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const stage = STAGES[r.stage] || STAGES.NOT_INVITED;
                  const iv = r.interview;
                  const out = r.outreach;
                  return (
                    <tr key={r.candidate_id}>
                      <td>
                        <strong>{properName(r.candidate_name)}</strong>
                        <br />
                        <span className="sub">{r.email_id}</span>
                      </td>
                      <td className="cell-role">
                        {clip(r.current_role, 70)}
                        <span className="sub" title={r.experience}>
                          {clip(r.experience, 90)}
                        </span>
                      </td>
                      <td>
                        <span className={`score ${band(r.ats_score)}`}>{r.ats_score ?? "—"}%</span>
                      </td>
                      <td>
                        <span className={`pill ${stage.cls}`}>{stage.label}</span>
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
                        ) : iv ? (
                          // "of ~N", not "n/N": live follow-ups take the real
                          // count past the plan.
                          <span className="sub">
                            {iv.answered} of ~{iv.planned_total || "?"} answered
                          </span>
                        ) : (
                          <span className="sub">—</span>
                        )}
                      </td>
                      <td>
                        <div className="link-cell">
                          {out ? (
                            out.sent ? (
                              <span className="sub">sent {when(out.sent_at)}</span>
                            ) : (
                              <>
                                <span className="pill pill-brand">draft ready</span>
                                <span className="sub">not sent yet</span>
                              </>
                            )
                          ) : (
                            <span className="sub">not invited from screening</span>
                          )}
                          {r.invite?.revoked && <span className="pill pill-bad">withdrawn</span>}
                        </div>
                      </td>
                      <td>
                        <RowActions
                          row={r}
                          cfg={cfg}
                          onSettings={onOpenSettings}
                          onMail={onOpenMail}
                          onRevoke={setRevoked}
                          onReport={onOpenReport}
                          onResume={onOpenStage}
                          onExport={onExportInterview}
                          onNow={interviewNow}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="hint">
            The resume score is shown for context only. The interviewer is never told it, and it
            forms no part of the interview score — that is the point of this stage.
          </p>
        </div>
      )}

      <details className="card fold">
        <summary>
          <span className="fold-title">Interview settings</span>
          <span className="fold-sub">
            {defaults.planned_count} questions · up to {defaults.max_followups} follow-ups each ·{" "}
            {(defaults.categories || []).length} categor
            {(defaults.categories || []).length === 1 ? "y" : "ies"}
          </span>
        </summary>
        <div className="fold-body">
          <div className="card-head-row">
            <p className="hint">
              These apply to every link you issue from here, and to any interview you run yourself.
              A link keeps the settings it was issued with.
            </p>
            <button
              type="button"
              className="btn btn-link"
              onClick={() => setDefaults(defaultOptions(cfg))}
            >
              Reset to defaults
            </button>
          </div>

          <InterviewShape
            cfg={cfg}
            options={defaults}
            onChange={setDefaults}
            voices={voices}
            preferred={preferred}
          />
        </div>
      </details>

      <ManualFold
        cfg={cfg}
        dash={dash}
        rubric={rubric}
        voices={voices}
        preferred={preferred}
        onOpenStage={onOpenStage}
        onOpenMail={onOpenMail}
        setPlanProgress={setPlanProgress}
        waitForPlan={waitForPlan}
      />

      {planProgress && (
        <div className="progress-wrap">
          <div className="progress-head">
            <strong>{planProgress.stage || "Starting…"}</strong>
            <span>{planProgress.detail || ""}</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill progress-fill-indef" />
          </div>
        </div>
      )}
    </>
  );
}
