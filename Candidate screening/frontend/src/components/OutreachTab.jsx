import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import DraftCard from "./DraftCard.jsx";
import { useConfirm } from "./Confirm.jsx";
import { useToast } from "./Toast.jsx";
import { getJson, postJson, putJson } from "../lib/api.js";
import { when } from "../lib/format.js";

const FILTERS = [
  ["ALL", "All"],
  ["DRAFT", "Awaiting review"],
  ["SENT", "Sent"],
];

/**
 * The Invite tab needs a live screening session, which a page reload clears.
 * Rather than dead-ending, offer the sessions that can be invited from.
 */
function SessionPicker({ fromHistory, onOpenSession }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getJson("/api/sessions")
      .then((all) => {
        if (!cancelled) setRows(all.filter((s) => s.shortlisted > 0));
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (rows === null) {
    return (
      <div className="empty">
        <div className="spinner" />
        <p>Looking for screenings you can invite from…</p>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="empty">
        <div className="empty-ico">📨</div>
        <h2>No shortlist to invite from yet</h2>
        <p>
          Run a screening on the <strong>Screen</strong> tab first. Once candidates are shortlisted
          they appear here so you can invite them.
        </p>
      </div>
    );
  }

  return (
    <div className="empty" style={{ alignItems: "stretch", textAlign: "left" }}>
      <div style={{ textAlign: "center" }}>
        <h2>Pick a screening to invite from</h2>
        <p className="sub">These completed screenings have shortlisted candidates.</p>
        {fromHistory && (
          <p className="sim-inline">
            You have a <strong>history record</strong> open. Invitations are sent from the live
            screening session it came from — pick it below.
          </p>
        )}
      </div>

      <div className="history-list" style={{ marginTop: 18 }}>
        {rows.map((s) => (
          <div className="hrow" key={s.session_id}>
            <div>
              <div className="ht">
                {s.job_title}
                {s.accepted && <span className="pill pill-locked">accepted</span>}
              </div>
              <div className="hm">
                {s.session_id} · {when(s.created_at)} · <strong>{s.shortlisted}</strong> shortlisted
                of {s.total_resumes}
              </div>
            </div>
            <div className="ha">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onOpenSession(s.session_id)}
              >
                Open &amp; draft mails
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SentBanner({ result, onDismiss }) {
  const n = result.sent_count;
  return (
    <div className="sent-banner">
      <div className="sent-banner-mark">✓</div>
      <div className="sent-banner-text">
        <h2>Mail has been sent</h2>
        <p>
          {n} interview invitation{n === 1 ? "" : "s"} sent to shortlisted candidate
          {n === 1 ? "" : "s"}.
        </p>
        <p className="sent-banner-sim">
          Simulated — no email actually left this machine. Everything else behaved exactly as a real
          send would.
        </p>
        {result.skipped?.length > 0 && (
          <p className="sent-banner-skip">
            <strong>{result.skipped.length} skipped:</strong>{" "}
            {result.skipped.map((s) => s.candidate_name).join(", ")} — {result.skipped[0].reason}
          </p>
        )}
        <div className="sent-banner-actions">
          <button type="button" className="btn btn-link" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OutreachTab({ session, onOpenSession }) {
  const toast = useToast();
  const confirm = useConfirm();

  const [outreach, setOutreach] = useState(null);
  const [filter, setFilter] = useState("ALL");
  const [edits, setEdits] = useState({});
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentResult, setSentResult] = useState(null);

  const sessionId = session && !session.is_history ? session.session_id : null;

  // Read inside callbacks without making them depend on every keystroke.
  const editsRef = useRef(edits);
  editsRef.current = edits;

  const load = useCallback(
    async (id) => {
      const data = await getJson(`/api/sessions/${id}/outreach`);
      setOutreach(data);
      // Seed the editable fields from whatever the server last stored.
      setEdits(
        Object.fromEntries(
          (data.drafts || []).map((d) => [
            d.candidate_id,
            {
              subject: d.subject || "",
              body: (d.status === "SENT" ? d.sent_body || d.body : d.body) || "",
            },
          ]),
        ),
      );
      return data;
    },
    [],
  );

  const draftMails = useCallback(
    async (regenerate, auto) => {
      setDrafting(true);
      try {
        const res = await postJson(`/api/sessions/${sessionId}/outreach/draft`, { regenerate });
        await load(sessionId);
        if (res.drafted === 0 && !auto) {
          toast(res.detail || "Nothing to draft", "");
        } else if (res.drafted) {
          toast(
            `Drafted ${res.drafted} invitation${res.drafted === 1 ? "" : "s"} — review and edit, then send` +
              (res.failures ? ` · ${res.failures} used the fallback template` : ""),
            "ok",
          );
        }
      } catch (err) {
        toast(`Drafting failed: ${err.message}`, "err");
        await load(sessionId).catch(() => {});
      } finally {
        setDrafting(false);
      }
    },
    [sessionId, load, toast],
  );

  /* Landing on this tab should already have the mails written. */
  useEffect(() => {
    if (!sessionId) {
      setOutreach(null);
      return undefined;
    }
    let cancelled = false;

    (async () => {
      try {
        const data = await load(sessionId);
        if (cancelled) return;
        const nothingDrafted = !(data.drafts || []).length;
        if (nothingDrafted && (data.eligible || []).length) {
          await draftMails(false, true);
        }
      } catch (err) {
        if (!cancelled) toast(`Could not load invitations: ${err.message}`, "err");
      }
    })();

    return () => {
      cancelled = true;
    };
    // draftMails is stable for a given sessionId; re-running on its identity
    // would re-draft on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const saveDraft = useCallback(
    async (cid, { quiet } = {}) => {
      const edit = editsRef.current[cid];
      if (!edit) return;
      try {
        await putJson(
          `/api/sessions/${sessionId}/outreach/${encodeURIComponent(cid)}`,
          { subject: edit.subject, body: edit.body },
        );
        setOutreach((prev) =>
          prev
            ? {
                ...prev,
                drafts: prev.drafts.map((d) =>
                  d.candidate_id === cid
                    ? { ...d, subject: edit.subject, body: edit.body, edited: true }
                    : d,
                ),
              }
            : prev,
        );
        if (!quiet) toast("Draft saved", "ok");
      } catch (err) {
        toast(`Save failed: ${err.message}`, "err");
        throw err;
      }
    },
    [sessionId, toast],
  );

  const sendMails = useCallback(
    async (ids) => {
      setSending(true);
      try {
        // Persist any edits still sitting in the textareas before they go out.
        await Promise.all(ids.map((cid) => saveDraft(cid, { quiet: true }).catch(() => {})));
        const res = await postJson(`/api/sessions/${sessionId}/outreach/send`, {
          candidate_ids: ids,
        });
        await load(sessionId);
        setSentResult(res);
        toast(`✓ Mail has been sent to ${res.sent_count} candidate${res.sent_count === 1 ? "" : "s"}`, "ok");
      } catch (err) {
        toast(`Send failed: ${err.message}`, "err");
      } finally {
        setSending(false);
      }
    },
    [sessionId, saveDraft, load, toast],
  );

  const sendAll = useCallback(async () => {
    const pending = (outreach?.drafts || []).filter((d) => d.status !== "SENT");
    if (!pending.length) return toast("Every invitation has already been sent", "");
    const ready = pending.filter((d) => d.has_email);
    if (!ready.length) {
      return toast("None of these rows has an email address — add them on the Review tab", "err");
    }
    await sendMails(ready.map((d) => d.candidate_id));
  }, [outreach, sendMails, toast]);

  const redraft = useCallback(async () => {
    const ok = await confirm({
      title: "Re-draft every invitation",
      message: "Re-drafting rewrites every unsent invitation, discarding your edits. Continue?",
      confirmLabel: "Re-draft all",
      danger: true,
    });
    if (ok) await draftMails(true);
  }, [confirm, draftMails]);

  /* -------------------------------------------------------------- render */
  if (!sessionId) {
    return (
      <SessionPicker
        fromHistory={Boolean(session?.is_history)}
        onOpenSession={onOpenSession}
      />
    );
  }

  if (!outreach) {
    return (
      <div className="empty">
        <div className="spinner" />
        <p>Loading invitations…</p>
      </div>
    );
  }

  const drafts = outreach.drafts || [];
  const sent = drafts.filter((d) => d.status === "SENT").length;
  const noEmail = drafts.filter((d) => !d.has_email).length;
  const undrafted = (outreach.eligible || []).filter(
    (e) => !drafts.some((d) => d.candidate_id === e.candidate_id),
  ).length;

  const counts = { ALL: drafts.length, DRAFT: drafts.length - sent, SENT: sent };
  const shown = drafts.filter((d) =>
    filter === "ALL" ? true : filter === "SENT" ? d.status === "SENT" : d.status !== "SENT",
  );

  const stats = [
    ["Eligible", outreach.eligible.length, ""],
    ["Drafted", drafts.length, ""],
    ["Sent", sent, "ok"],
    ["Not yet drafted", undrafted, undrafted ? "warn" : ""],
    ["Missing email", noEmail, noEmail ? "bad" : ""],
  ];

  return (
    <>
      <div className="sim-banner">
        <span className="sim-dot" />
        <div>
          <strong>Simulation mode — no email is ever transmitted.</strong>
          <span>
            There is no mail server wired into this app. “Send” records the invitation as sent so
            you have a record of it. Nothing leaves this machine.
          </span>
        </div>
      </div>

      <div className="card">
        <div className="card-head-row">
          <div>
            <h2>Interview invitations — {outreach.job_title || "Shortlist"}</h2>
            <p className="sub">
              From {outreach.recruiter_name} &lt;{outreach.recruiter_email}&gt; · {outreach.company}{" "}
              · send mode: {outreach.send_mode}
            </p>
          </div>
          <div className="toolbar-right">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={redraft}
              disabled={drafting || sending}
              title="Rewrite every unsent draft from scratch"
            >
              {drafting ? "Drafting…" : "↻ Re-draft all"}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={sendAll}
              disabled={drafting || sending}
            >
              {sending ? "Sending…" : "📨 Send the mails"}
            </button>
          </div>
        </div>

        <div className="stats">
          {stats.map(([label, n, kind]) => (
            <div key={label} className={`stat ${kind}`}>
              <div className="n">{n}</div>
              <div className="l">{label}</div>
            </div>
          ))}
        </div>

        <p className="hint">
          The agent drafts one personalised invitation per shortlisted candidate, each carrying that
          candidate&apos;s own interview link. Read them, edit anything you like, then send. Opening
          a link starts that candidate&apos;s interview immediately — nothing to schedule.
        </p>
      </div>

      {sentResult && <SentBanner result={sentResult} onDismiss={() => setSentResult(null)} />}

      <div className="card">
        <div className="toolbar">
          <div className="toolbar-left">
            <div className="chipset">
              {FILTERS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`chip ${filter === id ? "active" : ""}`}
                  onClick={() => setFilter(id)}
                >
                  {label} ({counts[id]})
                </button>
              ))}
            </div>
          </div>
          <div className="toolbar-right">
            <span className="hint">
              {outreach.eligible.length} shortlisted · {sent} sent
            </span>
          </div>
        </div>

        <div className="draft-list">
          {drafting && (
            <div className="drafting">
              <div className="spinner" />
              <p>
                <strong>
                  The agent is writing {outreach.eligible.length} invitation
                  {outreach.eligible.length === 1 ? "" : "s"}…
                </strong>
              </p>
              <p className="sub">
                Each one is personalised from that candidate&apos;s own resume. This takes a few
                seconds.
              </p>
            </div>
          )}

          {!drafting && shown.length === 0 && (
            <p className="sub" style={{ padding: 20, textAlign: "center" }}>
              {drafts.length
                ? "No drafts match this filter."
                : "No drafts yet — use Re-draft all to have the agent write them."}
            </p>
          )}

          {!drafting &&
            shown.map((d) => {
              const edit = edits[d.candidate_id] || { subject: d.subject || "", body: d.body || "" };
              return (
                <DraftCard
                  key={d.candidate_id}
                  draft={d}
                  subject={edit.subject}
                  body={edit.body}
                  busy={sending}
                  onChange={(next) =>
                    setEdits((prev) => ({ ...prev, [d.candidate_id]: next }))
                  }
                  onSave={() => saveDraft(d.candidate_id).catch(() => {})}
                  onSend={() => sendMails([d.candidate_id])}
                />
              );
            })}
        </div>
      </div>
    </>
  );
}
