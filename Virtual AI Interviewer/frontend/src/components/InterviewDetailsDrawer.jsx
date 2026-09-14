import { useEffect, useState } from "react";

import Drawer from "./Drawer.jsx";
import { useConfirm } from "./Confirm.jsx";
import { useToast } from "./Toast.jsx";
import { getJson, seg } from "../lib/api.js";
import { has, pct, properName, titleise, when } from "../lib/format.js";

function Field({ label, value }) {
  if (!has(value)) return null;
  return (
    <>
      <h4>{label}</h4>
      <p>{String(value)}</p>
    </>
  );
}

/**
 * One candidate's full picture: who they are, what was sent, and their link.
 *
 * History is the only list that spans both kinds of candidate, so this is where
 * the three sources get shown together - the interview record for the person,
 * the screening app for the mail, and whichever of the two minted the link.
 */
export default function InterviewDetailsDrawer({ interviewId, onClose, onOpenReport }) {
  const toast = useToast();
  const confirm = useConfirm();

  const [data, setData] = useState(null);

  useEffect(() => {
    if (!interviewId) return undefined;
    let cancelled = false;
    setData(null);

    getJson(`/api/interviews/${seg(interviewId)}/details`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (cancelled) return;
        toast(`Could not open those details: ${err.message}`, "err");
        onClose();
      });

    return () => {
      cancelled = true;
    };
  }, [interviewId, onClose, toast]);

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Link copied", "ok");
    } catch {
      await confirm({
        title: "Copy this",
        body: "The clipboard is not available here. Select the text below and copy it.",
        copy: text,
        ok: "Done",
        cancel: "",
      });
    }
  };

  const c = data?.candidate || {};
  const mail = data?.mail;
  const link = data?.link || {};

  return (
    <Drawer
      open={Boolean(interviewId)}
      title={properName(c.candidate_name) || interviewId || "Interview"}
      onClose={onClose}
    >
      {!data && (
        <div className="drafting">
          <div className="spinner" />
          <p className="sub">Loading…</p>
        </div>
      )}

      {data && (
        <>
          <div className="inline-note">
            {data.job_title} · {titleise(data.status)} · prepared {when(data.created_at)} · from{" "}
            {data.source}
            <br />
            {interviewId} · {data.answered} of ~{data.planned_total || "?"} answered
            {data.overall_score != null
              ? ` · scored ${pct(data.overall_score)} (${titleise(data.verdict || "")})`
              : ""}
          </div>

          <Field label="Email" value={c.email_id} />
          <Field label="Phone" value={c.phone_number} />
          <Field label="Current role" value={c.current_role} />
          <Field label="Experience" value={c.experience} />
          <Field label="Location" value={c.location} />
          <Field label="Highest education" value={c.highest_education} />
          <Field label="Education" value={c.education_details} />
          <Field label="Certifications" value={c.certification} />
          <Field label="Skills" value={c.skills} />
          <Field label="Projects" value={c.projects} />

          <h4>Invitation</h4>
          {mail ? (
            <>
              <p className="sub">
                {mail.sent
                  ? `Sent ${when(mail.sent_at)} · ${
                      mail.source === "screening" ? "by the screening app" : "recorded here"
                    }`
                  : mail.source === "screening"
                    ? "Drafted by the screening app, not sent yet"
                    : "Not marked as sent yet"}
              </p>
              <p>
                <strong>{mail.subject}</strong>
              </p>
              <pre className="mail-body">{mail.body}</pre>
            </>
          ) : (
            <p className="sub">
              No invitation on record. This candidate has not been invited by the screening app,
              and no link was issued here.
            </p>
          )}

          <h4>Interview link</h4>
          {link.url ? (
            <>
              <div className="link-cell">
                <code className="link-short" title={link.url}>
                  {link.url}
                </code>
              </div>
              <p className="sub">
                {link.revoked
                  ? "This link has been deactivated — opening it is refused."
                  : link.origin === "screening"
                    ? "Minted and sent by the screening app."
                    : "Issued here, for a candidate who was never on a shortlist."}
              </p>
            </>
          ) : (
            <p className="sub">No link — this interview can only be conducted here.</p>
          )}

          <div className="drawer-actions">
            {link.url && (
              <button type="button" className="btn btn-ghost" onClick={() => copy(link.url)}>
                Copy link
              </button>
            )}
            {data.overall_score != null && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  onClose();
                  onOpenReport(interviewId);
                }}
              >
                Open report
              </button>
            )}
          </div>
        </>
      )}
    </Drawer>
  );
}
