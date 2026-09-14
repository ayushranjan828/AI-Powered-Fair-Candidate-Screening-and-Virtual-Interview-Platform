import { useCallback, useMemo, useState } from "react";

import { useConfirm } from "./Confirm.jsx";
import { useToast } from "./Toast.jsx";
import { api, download, postJson, seg } from "../lib/api.js";
import { HIST_FILTERS, VERDICT_CLS } from "../lib/constants.js";
import { pct, properName, titleise, when } from "../lib/format.js";

/** Same shape as the bulk route, one request per id. Used only as a fallback. */
async function deleteOneByOne(ids) {
  const deleted = [];
  const missing = [];
  for (const id of ids) {
    try {
      await api(`/api/interviews/${seg(id)}`, { method: "DELETE" });
      deleted.push(id);
    } catch {
      missing.push(id);
    }
  }
  return { deleted: deleted.length, deleted_ids: deleted, missing };
}

export default function HistoryTab({ rows, onRefresh, onOpenReport, onOpenStage, onOpenDetails }) {
  const toast = useToast();
  const confirm = useConfirm();

  const [filter, setFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "ALL" && r.status !== filter) return false;
      if (!q) return true;
      return [r.candidate_name, r.job_title, r.interview_id, r.source].some((v) =>
        String(v || "").toLowerCase().includes(q),
      );
    });
  }, [rows, filter, query]);

  const counts = useMemo(() => {
    const out = { ALL: rows.length };
    rows.forEach((r) => {
      out[r.status] = (out[r.status] || 0) + 1;
    });
    return out;
  }, [rows]);

  const exportable = rows.filter((r) => selected.has(r.interview_id) && r.overall_score != null);
  const allShownPicked = visible.length > 0 && visible.every((r) => selected.has(r.interview_id));

  const toggle = (id, on) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  /**
   * Delete one or many. Deleting is irreversible and takes the transcript with
   * it, so the confirmation names what is going and how many.
   */
  const deleteInterviews = useCallback(
    async (ids) => {
      if (!ids.length) return;

      const picked = rows.filter((r) => ids.includes(r.interview_id));
      const named = picked.slice(0, 5).map((r) => properName(r.candidate_name)).join(", ");
      const more = picked.length > 5 ? ` and ${picked.length - 5} more` : "";
      const completed = picked.filter((r) => r.overall_score != null).length;
      const single = ids.length === 1;

      const ok = await confirm({
        title: single
          ? "Delete this interview and its transcript permanently?"
          : `Delete ${ids.length} interviews and their transcripts permanently?`,
        detail: `${named}${more}`,
        body:
          (completed
            ? single
              ? "It has a completed report. "
              : `${completed} of them have a completed report. `
            : "") + "This cannot be undone.",
        ok: single ? "Delete" : `Delete ${ids.length}`,
        danger: true,
      });
      if (!ok) return;

      setDeleting(true);
      try {
        if (single) {
          await api(`/api/interviews/${seg(ids[0])}`, { method: "DELETE" });
          toast("Interview deleted", "ok");
        } else {
          let res;
          let stale = false;
          try {
            res = await postJson("/api/interviews/bulk-delete", { interview_ids: ids });
          } catch (err) {
            // The browser always gets fresh JS but the Python process only loads
            // its code at startup, so a server that has not been restarted has
            // no bulk route. The path then falls through to /api/interviews/{id},
            // which rejects POST — hence 405 rather than 404.
            if (!/method not allowed|not found/i.test(err.message)) throw err;
            stale = true;
            res = await deleteOneByOne(ids);
          }
          toast(
            `Deleted ${res.deleted} interview${res.deleted === 1 ? "" : "s"}` +
              (res.missing.length ? ` · ${res.missing.length} were already gone` : "") +
              (stale ? " · one at a time: restart the server to enable bulk delete" : ""),
            "ok",
          );
        }
        setSelected((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
        await onRefresh(ids);
      } catch (err) {
        toast(`Delete failed: ${err.message}`, "err");
      } finally {
        setDeleting(false);
      }
    },
    [rows, confirm, onRefresh, toast],
  );

  const exportSelected = () => {
    if (!exportable.length) return;
    // One workbook per interview; the browser blocks a burst of navigations, so
    // they are opened as staggered hidden-iframe downloads instead.
    exportable.forEach((r, i) =>
      setTimeout(() => {
        const frame = document.createElement("iframe");
        frame.style.display = "none";
        frame.src = `/api/interviews/${seg(r.interview_id)}/export`;
        document.body.appendChild(frame);
        setTimeout(() => frame.remove(), 60000);
      }, i * 400),
    );
    toast(`Downloading ${exportable.length} workbook${exportable.length === 1 ? "" : "s"}`, "ok");
  };

  return (
    <div className="card">
      <div className="card-head-row">
        <div>
          <h2>Interviews</h2>
          <p className="sub">
            {rows.length ? `${rows.length} interview${rows.length === 1 ? "" : "s"} on record` : ""}
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => onRefresh()}>
          Refresh
        </button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <label className="check bulk-all">
            <input
              type="checkbox"
              checked={allShownPicked}
              onChange={(e) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  visible.forEach((r) =>
                    e.target.checked ? next.add(r.interview_id) : next.delete(r.interview_id),
                  );
                  return next;
                });
              }}
            />{" "}
            Select all shown
          </label>

          <div className="chipset">
            {HIST_FILTERS.filter(([key]) => key === "ALL" || counts[key]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`chip ${filter === key ? "active" : ""}`}
                onClick={() => setFilter(key)}
              >
                {label} ({counts[key] || 0})
              </button>
            ))}
          </div>

          <input
            type="search"
            value={query}
            placeholder="Search candidate, role, id…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="toolbar-right">
          <span className="hint">
            {selected.size ? `${selected.size} selected` : "none selected"}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={exportable.length === 0}
            onClick={exportSelected}
          >
            {exportable.length > 1 ? `⬇ Excel for ${exportable.length}` : "⬇ Excel for selected"}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={selected.size === 0 || deleting}
            onClick={() => deleteInterviews([...selected])}
          >
            {selected.size > 1 ? `🗑 Delete ${selected.size} selected` : "🗑 Delete selected"}
          </button>
        </div>
      </div>

      <div className="history-list">
        {visible.length === 0 && (
          <p className="sub">
            {rows.length ? "No interviews match this filter." : "No interviews yet."}
          </p>
        )}

        {visible.map((r) => {
          const picked = selected.has(r.interview_id);
          return (
            <div key={r.interview_id} className={`hrow ${picked ? "picked" : ""}`}>
              <label className="hrow-pick">
                <input
                  type="checkbox"
                  checked={picked}
                  onChange={(e) => toggle(r.interview_id, e.target.checked)}
                  aria-label={`Select ${properName(r.candidate_name)}`}
                />
              </label>

              <div
                className="hrow-main hrow-open"
                title="Open this candidate's details"
                onClick={() => onOpenDetails(r.interview_id)}
              >
                <div className="ht">
                  {properName(r.candidate_name)}
                  <span className="sub">· {r.job_title}</span>
                  {r.verdict ? (
                    <span className={`pill ${VERDICT_CLS[r.verdict] || "pill-bad"}`}>
                      {titleise(r.verdict)}
                      {r.overall_score != null ? ` · ${pct(r.overall_score)}` : ""}
                    </span>
                  ) : (
                    <span className="pill pill-muted">{titleise(r.status)}</span>
                  )}
                </div>
                <div className="hm">
                  {r.interview_id} · {when(r.created_at)} · {r.turns} answers · from {r.source}
                </div>
              </div>

              <div className="ha">
                {r.overall_score != null ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => onOpenReport(r.interview_id)}
                    >
                      Open report
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => download(`/api/interviews/${seg(r.interview_id)}/export`)}
                    >
                      ⬇ Excel
                    </button>
                  </>
                ) : r.status === "abandoned" ? null : (
                  // A discarded interview cannot be resumed; the row itself
                  // still opens its details.
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => onOpenStage(r.interview_id)}
                  >
                    {r.status === "planning" ? "Open" : "Resume"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => deleteInterviews([r.interview_id])}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
