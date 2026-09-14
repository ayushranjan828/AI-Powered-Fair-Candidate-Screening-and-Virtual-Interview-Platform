import { useCallback, useMemo, useState } from "react";

import AcceptModal from "./AcceptModal.jsx";
import CandidateDrawer from "./CandidateDrawer.jsx";
import { useConfirm } from "./Confirm.jsx";
import { useToast } from "./Toast.jsx";
import { download, postJson, putJson } from "../lib/api.js";
import { STATUSES } from "../lib/constants.js";
import { humanStatus, when } from "../lib/format.js";

const SEARCH_KEYS = [
  "candidate_name",
  "email_id",
  "phone_number",
  "skills",
  "certification",
  "highest_education",
  "candidate_id",
  "source_file",
];

const COLUMNS = [
  { key: "candidate_name", label: "Candidate Name", cls: "col-name" },
  { key: "phone_number", label: "Phone Number", cls: "col-phone" },
  { key: "email_id", label: "Email ID", cls: "col-email" },
  { key: "skills", label: "Skills", wide: true },
  { key: "certification", label: "Certification" },
  { key: "experience", label: "Experience", wide: true },
  { key: "highest_education", label: "Highest Education" },
];

const PAGE_SIZES = [25, 50, 100, 1000];

function Stats({ stats }) {
  const cells = [
    ["Resumes", stats.total ?? 0, ""],
    ["Shortlisted", stats.shortlisted ?? 0, "ok"],
    ["Needs review", stats.review ?? 0, "warn"],
    ["Below threshold", stats.not_shortlisted ?? 0, ""],
    ["Unreadable", stats.failed ?? 0, "bad"],
  ];
  return (
    <div className="stats">
      {cells.map(([label, n, kind]) => (
        <div key={label} className={`stat ${kind}`}>
          <div className="n">{n}</div>
          <div className="l">{label}</div>
        </div>
      ))}
    </div>
  );
}

function Rubric({ analysis, jdError }) {
  const r = analysis || {};
  const rows = [
    ["Role", r.role_title],
    ["Seniority", r.seniority],
    ["Min experience", r.min_experience_years != null ? `${r.min_experience_years} yrs` : "NA"],
    ["Education", r.required_education],
    ["Must-have skills", (r.must_have_skills || []).join(", ")],
    ["Good to have", (r.good_to_have_skills || []).join(", ")],
    ["Project types", (r.expected_project_types || []).join(", ")],
    ["Certifications", (r.preferred_certifications || []).join(", ")],
  ];

  return (
    <details className="rubric">
      <summary>JD rubric extracted by the agent</summary>
      <div className="rubric-body">
        {rows.map(([k, v]) => (
          <div key={k}>
            <span className="rk">{k}</span>
            {v || "NA"}
          </div>
        ))}
        {jdError && (
          <div className="bad-text">
            <span className="rk">JD analysis warning</span>
            {jdError}
          </div>
        )}
      </div>
    </details>
  );
}

export default function ReviewTab({
  session,
  setSession,
  readOnly,
  dirty,
  setDirty,
  onGoToOutreach,
  onAccepted,
}) {
  const toast = useToast();
  const confirm = useConfirm();

  const [filter, setFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [detailId, setDetailId] = useState(null);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accepting, setAccepting] = useState(false);

  const candidates = useMemo(() => session?.candidates || [], [session]);

  const counts = useMemo(() => {
    const out = { ALL: candidates.length };
    for (const s of STATUSES) out[s] = candidates.filter((c) => c.status === s).length;
    return out;
  }, [candidates]);

  const rows = useMemo(() => {
    const q = query.toLowerCase().trim();
    return candidates.filter((c) => {
      if (filter !== "ALL" && c.status !== filter) return false;
      if (!q) return true;
      return SEARCH_KEYS.some((k) => String(c[k] ?? "").toLowerCase().includes(q));
    });
  }, [candidates, filter, query]);

  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);

  /* --------------------------------------------------------------- edits */
  const patchRow = useCallback(
    (cid, key, rawValue) => {
      // An emptied cell becomes "NA" so the export never has blank holes.
      const value = rawValue.trim() === "" ? "NA" : rawValue;
      setSession((prev) => ({
        ...prev,
        candidates: prev.candidates.map((c) =>
          c.candidate_id === cid ? { ...c, [key]: value, edited: true } : c,
        ),
      }));
      setDirty(true);
    },
    [setSession, setDirty],
  );

  const deleteRow = useCallback(
    async (cid) => {
      const row = candidates.find((c) => c.candidate_id === cid);
      const ok = await confirm({
        title: "Delete row",
        message: `Delete ${row?.candidate_name || cid} from the sheet?`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      setSession((prev) => ({
        ...prev,
        candidates: prev.candidates.filter((c) => c.candidate_id !== cid),
      }));
      setDirty(true);
    },
    [candidates, confirm, setSession, setDirty],
  );

  const addRow = useCallback(async () => {
    try {
      const blank = await postJson(`/api/sessions/${session.session_id}/blank-row`);
      setSession((prev) => ({ ...prev, candidates: [blank, ...prev.candidates] }));
      setDirty(true);
      setFilter("ALL");
      setPage(1);
      toast("Blank row added — fill it in, then Save edits");
    } catch (err) {
      toast(`Could not add a row: ${err.message}`, "err");
    }
  }, [session, setSession, setDirty, toast]);

  const saveEdits = useCallback(async () => {
    setSaving(true);
    try {
      const res = await putJson(`/api/sessions/${session.session_id}/candidates`, {
        candidates: session.candidates,
      });
      setSession((prev) => ({ ...prev, stats: res.stats }));
      setDirty(false);
      toast(`Saved ${res.count} rows`, "ok");
      return true;
    } catch (err) {
      toast(`Save failed: ${err.message}`, "err");
      return false;
    } finally {
      setSaving(false);
    }
  }, [session, setSession, setDirty, toast]);

  const acceptShortlist = useCallback(
    async (payload) => {
      setAccepting(true);
      try {
        // Accepting freezes the SERVER's copy — if the save failed, going ahead
        // would silently lock in stale rows without the reviewer's edits.
        if (dirty && !(await saveEdits())) {
          toast(
            "Fix the save error first — accepting now would freeze the shortlist without your edits",
            "err",
          );
          return;
        }
        const res = await postJson(`/api/sessions/${session.session_id}/accept`, payload);
        setAcceptOpen(false);
        toast(`Saved to history (${res.count} candidates)`, "ok");
        await onAccepted(res.history_id);
      } catch (err) {
        toast(`Accept failed: ${err.message}`, "err");
      } finally {
        setAccepting(false);
      }
    },
    [dirty, saveEdits, session, toast, onAccepted],
  );

  const downloadExcel = useCallback(() => {
    if (!session) return;
    // Export exactly what the current filter shows — no more REVIEW rows
    // sneaking into a "shortlisted only" file.
    const url = session.is_history
      ? `/api/history/${session.history_id}/export`
      : `/api/sessions/${session.session_id}/export${
          filter !== "ALL" ? `?status=${encodeURIComponent(filter)}` : ""
        }`;
    download(url);
  }, [session, filter]);

  /* -------------------------------------------------------------- render */
  if (!session) {
    return (
      <div className="empty">
        <div className="empty-ico">🗂️</div>
        <h2>No shortlist loaded</h2>
        <p>
          Run a screening from <strong>Step 1 · Screen</strong>, or open a record from{" "}
          <strong>History</strong>.
        </p>
      </div>
    );
  }

  const detail = candidates.find((c) => c.candidate_id === detailId) || null;
  const threshold = session.threshold ?? 60;

  return (
    <>
      <div className="card">
        <div className="card-head-row">
          <div>
            <h2>{session.job_title || "Shortlist"}</h2>
            <p className="sub">
              {session.is_history
                ? `History ${session.history_id} · accepted ${when(session.accepted_at)} by ${
                    session.accepted_by
                  } · threshold ${session.threshold}%`
                : `Session ${session.session_id} · ${when(session.created_at)} · threshold ${
                    session.threshold
                  }% · ${session.status}${
                    session.status === "failed" && session.error ? ` — ${session.error}` : ""
                  }`}
            </p>
          </div>
          {readOnly && <span className="pill pill-locked">🔒 Accepted &amp; locked</span>}
        </div>

        <Stats stats={session.stats || {}} />
        <Rubric analysis={session.jd_analysis} jdError={session.jd_error} />
      </div>

      <div className="card">
        <div className="toolbar">
          <div className="toolbar-left">
            <div className="chipset">
              {["ALL", ...STATUSES].map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`chip ${filter === k ? "active" : ""}`}
                  onClick={() => {
                    setFilter(k);
                    setPage(1);
                  }}
                >
                  {k === "ALL" ? "All" : humanStatus(k)} ({counts[k] || 0})
                </button>
              ))}
            </div>
            <input
              type="search"
              value={query}
              placeholder="Search name, skills, email…"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <div className="toolbar-right">
            <button type="button" className="btn btn-ghost" onClick={addRow} disabled={readOnly}>
              ＋ Add row
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={saveEdits}
              disabled={readOnly || saving}
            >
              {saving ? "Saving…" : "Save edits"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={downloadExcel}>
              ⬇ Excel
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onGoToOutreach}
              title="Draft interview invitations for the shortlisted candidates"
            >
              📨 Invite shortlisted
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setAcceptOpen(true)}
              disabled={readOnly}
            >
              ✓ Accept &amp; save
            </button>
          </div>
        </div>

        {dirty && (
          <div className="dirty-note">
            Unsaved edits — click <strong>Save edits</strong> to persist them.
          </div>
        )}

        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="col-narrow">Candidate ID</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} className={c.wide ? "col-wide" : c.cls}>
                    {c.label}
                  </th>
                ))}
                <th className="col-narrow">ATS %</th>
                <th className="col-narrow">Status</th>
                <th className="col-tiny" />
              </tr>
            </thead>
            <tbody>
              {slice.length === 0 && (
                <tr>
                  <td className="grid-empty" colSpan={COLUMNS.length + 4}>
                    No rows match this filter.
                  </td>
                </tr>
              )}

              {slice.map((c) => {
                const score = c.ats_score ?? 0;
                const cls = score >= 75 ? "hi" : score >= threshold ? "mid" : "lo";
                return (
                  <tr key={c.candidate_id} className={c.manually_added ? "added" : ""}>
                    <td className="ro">{c.candidate_id}</td>

                    {COLUMNS.map((col) =>
                      readOnly ? (
                        <td key={col.key} className="ro wrap">
                          <div className="cell-clamp">{c[col.key]}</div>
                        </td>
                      ) : (
                        <td key={col.key}>
                          <input
                            value={c[col.key] ?? ""}
                            onChange={(e) => patchRow(c.candidate_id, col.key, e.target.value)}
                          />
                        </td>
                      ),
                    )}

                    <td>
                      <button
                        type="button"
                        className={`score ${cls}`}
                        onClick={() => setDetailId(c.candidate_id)}
                        title="Open details"
                      >
                        {score}
                      </button>
                    </td>

                    <td>
                      {readOnly ? (
                        <span className="ro">{c.status}</span>
                      ) : (
                        <select
                          value={c.status}
                          onChange={(e) => patchRow(c.candidate_id, "status", e.target.value)}
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>

                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="row-info"
                          title="Details"
                          onClick={() => setDetailId(c.candidate_id)}
                        >
                          ⓘ
                        </button>
                        {!readOnly && (
                          <button
                            type="button"
                            className="row-del"
                            title="Delete row"
                            onClick={() => deleteRow(c.candidate_id)}
                          >
                            🗑
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setPage(current - 1)}
            disabled={current <= 1}
          >
            ← Prev
          </button>
          <span className="page-info">
            {rows.length ? `${start + 1}–${start + slice.length} of ${rows.length}` : "no rows"}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setPage(current + 1)}
            disabled={current >= pages}
          >
            Next →
          </button>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
        </div>
      </div>

      <CandidateDrawer candidate={detail} onClose={() => setDetailId(null)} />

      <AcceptModal
        open={acceptOpen}
        busy={accepting}
        onClose={() => setAcceptOpen(false)}
        onConfirm={acceptShortlist}
      />
    </>
  );
}
