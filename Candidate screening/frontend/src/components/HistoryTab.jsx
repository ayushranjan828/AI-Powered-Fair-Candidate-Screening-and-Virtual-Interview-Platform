import { useCallback, useEffect, useState } from "react";

import { useConfirm } from "./Confirm.jsx";
import { useToast } from "./Toast.jsx";
import { del, download, getJson } from "../lib/api.js";
import { when } from "../lib/format.js";

function List({ rows, empty, children }) {
  if (rows === null) {
    return (
      <p className="sub" style={{ padding: "8px 2px" }}>
        Loading…
      </p>
    );
  }
  if (!rows.length) return <p className="sub">{empty}</p>;
  return <div className="history-list">{rows.map(children)}</div>;
}

export default function HistoryTab({ nonce, onOpenHistory, onOpenSession, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();

  const [history, setHistory] = useState(null);
  const [sessions, setSessions] = useState(null);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await getJson("/api/history"));
    } catch (err) {
      setHistory([]);
      toast(`History load failed: ${err.message}`, "err");
    }
  }, [toast]);

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await getJson("/api/sessions"));
    } catch (err) {
      setSessions([]);
      toast(`Sessions load failed: ${err.message}`, "err");
    }
  }, [toast]);

  useEffect(() => {
    loadHistory();
    loadSessions();
  }, [loadHistory, loadSessions, nonce]);

  const deleteHistory = async (id) => {
    const ok = await confirm({
      title: "Delete history record",
      message: "Delete this accepted shortlist permanently? This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/history/${id}`);
      toast("History record deleted");
      loadHistory();
      onChanged?.();
    } catch (err) {
      toast(`Delete failed: ${err.message}`, "err");
    }
  };

  const deleteSession = async (id) => {
    const ok = await confirm({
      title: "Delete screening session",
      message: "Delete this screening session and its results?",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/sessions/${id}`);
      toast("Session deleted");
      loadSessions();
      onChanged?.();
    } catch (err) {
      toast(`Delete failed: ${err.message}`, "err");
    }
  };

  return (
    <>
      <header className="page-head">
        <p className="crumb">Step 4 of 4</p>
        <h2>History</h2>
        <p className="lede">
          Accepted shortlists are frozen, auditable records. Screening sessions below them can be
          reopened, exported or deleted.
        </p>
      </header>

      <div className="card">
        <div className="card-head-row">
          <div className="card-title">
            <span className="card-ico" aria-hidden="true">
              ✅
            </span>
            <h3>Accepted shortlists</h3>
          </div>
          <button type="button" className="btn btn-ghost" onClick={loadHistory}>
            ↻ Refresh
          </button>
        </div>

        <List rows={history} empty="No accepted shortlists yet.">
          {(h) => (
            <div className="hrow" key={h.history_id}>
              <div>
                <div className="ht">
                  {h.job_title} <span className="sub">· {h.final_count} candidates</span>
                </div>
                <div className="hm">
                  {h.history_id} · accepted {when(h.accepted_at)} by {h.accepted_by} · threshold{" "}
                  {h.threshold}% · evaluated {h.total_evaluated}
                </div>
              </div>
              <div className="ha">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => onOpenHistory(h.history_id)}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => download(`/api/history/${h.history_id}/export`)}
                >
                  ⬇ Excel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => deleteHistory(h.history_id)}
                >
                  Delete
                </button>
              </div>
            </div>
          )}
        </List>
      </div>

      <div className="card">
        <div className="card-head-row">
          <div className="card-title">
            <span className="card-ico" aria-hidden="true">
              🗄️
            </span>
            <h3>Screening sessions</h3>
          </div>
          <button type="button" className="btn btn-ghost" onClick={loadSessions}>
            ↻ Refresh
          </button>
        </div>

        <List rows={sessions} empty="No screening sessions yet.">
          {(s) => (
            <div className="hrow" key={s.session_id}>
              <div>
                <div className="ht">
                  {s.job_title}
                  {s.accepted && <span className="pill pill-locked">accepted</span>}
                </div>
                <div className="hm">
                  {s.session_id} · {when(s.created_at)} · {s.status} · {s.shortlisted}/
                  {s.total_resumes} shortlisted
                </div>
              </div>
              <div className="ha">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => onOpenSession(s.session_id)}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => download(`/api/sessions/${s.session_id}/export`)}
                >
                  ⬇ Excel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => deleteSession(s.session_id)}
                >
                  Delete
                </button>
              </div>
            </div>
          )}
        </List>
      </div>
    </>
  );
}
