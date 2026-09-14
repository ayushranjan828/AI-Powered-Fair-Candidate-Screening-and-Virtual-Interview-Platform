import { useEffect, useState } from "react";

import Drawer from "./Drawer.jsx";
import { useConfirm } from "./Confirm.jsx";
import { useToast } from "./Toast.jsx";
import { getJson, postJson, seg } from "../lib/api.js";
import { properName, when } from "../lib/format.js";

/**
 * One candidate's invitation.
 *
 * Two different things share this drawer. A shortlisted candidate's mail was
 * written and sent by the screening app, so it is shown as a record - the
 * frozen text, and when it went - with nothing to act on. A one-off candidate
 * prepared in this app has no screening record, so that mail is a draft the
 * recruiter still has to send, and keeps the buttons that help them do it.
 */
export default function InvitationDrawer({ target, onClose, onSent }) {
  const toast = useToast();
  const confirm = useConfirm();

  const [mail, setMail] = useState(null);
  const [error, setError] = useState(null);

  const { candidateId, scope, displayName } = target || {};

  useEffect(() => {
    if (!target) return undefined;
    let cancelled = false;
    setMail(null);
    setError(null);

    getJson(`/api/invites/${seg(scope)}/${seg(candidateId)}/mail`)
      .then((data) => {
        if (!cancelled) setMail(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        toast(err.message, "err");
      });

    return () => {
      cancelled = true;
    };
  }, [target, scope, candidateId, toast]);

  const copy = async (text, okMsg) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg || "Copied", "ok");
    } catch {
      // The clipboard needs a secure context. Hand the text over to be copied
      // by hand instead.
      await confirm({
        title: "Copy this",
        body: "The clipboard is not available here. Select the text below and copy it.",
        copy: text,
        ok: "Done",
        cancel: "",
      });
    }
  };

  const markSent = async () => {
    try {
      await postJson(`/api/invites/${seg(scope)}/${seg(candidateId)}/sent`, {
        channel: "manual",
        by: "recruiter",
      });
      toast("Marked as sent", "ok");
      onClose();
      onSent?.();
    } catch (err) {
      toast(err.message, "err");
    }
  };

  const fromScreening = mail?.source === "screening";

  return (
    <Drawer
      open={Boolean(target)}
      title={`Invitation · ${properName(displayName || "")}`}
      onClose={onClose}
    >
      {error && <div className="inline-note">{error}</div>}

      {!mail && !error && (
        <div className="drafting">
          <div className="spinner" />
          <p className="sub">Loading the invitation…</p>
        </div>
      )}

      {mail && (
        <>
          <div className="inline-note">
            {fromScreening
              ? mail.sent
                ? `Sent by the screening app on ${when(mail.sent_at)}. This is the exact text that went out — it is a record, and cannot be changed here.`
                : "The screening app has drafted this but has not sent it yet. Send it from there; this app does not send email."
              : "This app does not send email. Open it in your own mail client, or copy the text — then mark it as sent so the record shows it went out."}
          </div>

          <h4>To</h4>
          <p>
            {mail.has_email ? (
              mail.to
            ) : (
              <span className="warn-text">no email address on this row</span>
            )}
          </p>

          <h4>Subject</h4>
          <p>{mail.subject}</p>

          <h4>Body</h4>
          <pre className="mail-body">{mail.body}</pre>

          <div className="drawer-actions">
            {!fromScreening && mail.has_email && (
              <a className="btn btn-primary" href={mail.mailto}>
                Open in my mail app
              </a>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => copy(`${mail.subject}\n\n${mail.body}`, "Invitation copied")}
            >
              Copy the text
            </button>
            {!fromScreening && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => copy(mail.link, "Link copied")}
                >
                  Copy just the link
                </button>
                <button type="button" className="btn btn-ghost" onClick={markSent}>
                  ✓ Mark as sent
                </button>
              </>
            )}
          </div>
        </>
      )}
    </Drawer>
  );
}
