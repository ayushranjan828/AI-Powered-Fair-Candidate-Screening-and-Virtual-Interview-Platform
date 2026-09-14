import { useToast } from "./Toast.jsx";
import { when } from "../lib/format.js";

function LinkBox({ label, url, onCopy }) {
  return (
    <div className="link-box">
      <span className="link-label">{label}</span>
      <a href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>
      <button type="button" className="btn btn-ghost" onClick={() => onCopy(url)}>
        Copy
      </button>
    </div>
  );
}

/**
 * One invitation. Subject/body are controlled by the parent so a "send all"
 * can flush every pending edit before anything goes out.
 */
export default function DraftCard({ draft, subject, body, onChange, onSave, onSend, busy }) {
  const toast = useToast();
  const isSent = draft.status === "SENT";

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Link copied", "ok");
    } catch {
      toast("Copy failed — select the link manually", "err");
    }
  };

  const sentLink = draft.sent_interview_link || draft.interview_link;

  return (
    <article className={`draft ${isSent ? "draft-sent" : ""}`}>
      <header className="draft-head">
        <div>
          <strong>{draft.candidate_name}</strong>
          <span className="sub">
            {draft.has_email ? (
              draft.email_id
            ) : (
              <span className="warn-text">no email on file — add it on the Review tab</span>
            )}
          </span>
        </div>
        <div className="draft-badges">
          {draft.draft_source === "fallback" && (
            <span className="pill pill-warn" title={draft.draft_error || ""}>
              template
            </span>
          )}
          {draft.edited && !isSent && <span className="pill pill-muted">edited</span>}
          {isSent ? (
            <span className="pill pill-sent">✓ Mail sent (simulated) · {when(draft.sent_at)}</span>
          ) : (
            <span className="pill pill-muted">awaiting your approval</span>
          )}
        </div>
      </header>

      <label className="field">
        <span>Subject</span>
        <input
          type="text"
          value={subject}
          disabled={isSent}
          onChange={(e) => onChange({ subject: e.target.value, body })}
        />
      </label>

      <label className="field">
        <span>Body</span>
        <textarea
          rows={12}
          value={body}
          disabled={isSent}
          onChange={(e) => onChange({ subject, body: e.target.value })}
        />
      </label>

      {draft.tone_note && !isSent && <p className="hint">Agent note: {draft.tone_note}</p>}

      {draft.interview_link ? (
        <>
          <LinkBox label="Interview link" url={draft.interview_link} onCopy={copy} />
          <p className="hint">
            Opening this link starts their interview straight away — it is unique to them. It is
            already in the body above; if you edit that text, keep the link.
          </p>
        </>
      ) : (
        <p className="hint warn-text">
          No interview link on this draft — check INCLUDE_INTERVIEW_LINK and that the interviewer
          app is configured.
        </p>
      )}

      {isSent ? (
        <>
          <div className="sent-box">
            ✓ Marked as sent {when(draft.sent_at)} — this is the exact text that would have gone
            out.
          </div>
          {sentLink && <LinkBox label="Their interview link" url={sentLink} onCopy={copy} />}
        </>
      ) : (
        <div className="draft-actions">
          <button type="button" className="btn btn-ghost" onClick={onSave} disabled={busy}>
            Save edits
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSend}
            disabled={busy || !draft.has_email}
          >
            📨 Send this invitation
          </button>
        </div>
      )}
    </article>
  );
}
