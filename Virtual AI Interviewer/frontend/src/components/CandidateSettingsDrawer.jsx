import { useEffect, useState } from "react";

import Drawer from "./Drawer.jsx";
import InterviewShape from "./InterviewShape.jsx";
import { useConfirm } from "./Confirm.jsx";
import { useToast } from "./Toast.jsx";
import { del, getJson, putJson, seg } from "../lib/api.js";
import { properName, when } from "../lib/format.js";

/* Overrides the dashboard defaults for a single named person. Question count,
 * depth of follow-up and which categories are probed are all fair game -
 * tailoring what you ask is ordinary interviewer judgement.
 *
 * Evaluation weights are here too, but flagged hard: scoring two people for the
 * same role on differently weighted criteria makes their scores incomparable,
 * which is the unfairness this project exists to avoid. So it is allowed, and
 * it is recorded - the report and the dashboard row both say so.
 */
export default function CandidateSettingsDrawer({
  cfg,
  historyId,
  candidateId,
  candidateName,
  voices,
  preferred,
  onClose,
  onSaved,
}) {
  const toast = useToast();
  const confirm = useConfirm();

  const [info, setInfo] = useState(null);
  const [options, setOptions] = useState(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const open = Boolean(candidateId);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setInfo(null);
    setOptions(null);

    getJson(`/api/candidate-options/${seg(historyId)}/${seg(candidateId)}`)
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setOptions({
          ...data.options,
          weights: { ...(data.options.weights || data.default_weights || {}) },
        });
        setNote(data.note || "");
      })
      .catch((err) => {
        if (!cancelled) toast(err.message, "err");
      });

    return () => {
      cancelled = true;
    };
  }, [open, historyId, candidateId, toast]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await putJson(`/api/candidate-options/${seg(historyId)}/${seg(candidateId)}`, {
        options,
        note: note.trim(),
        set_by: "recruiter",
      });
      onClose();
      await onSaved();
      toast(
        "Settings saved for this candidate" +
          (res.applied_to_existing_link ? " · their existing link now uses them" : "") +
          (res.interview_already_started
            ? " · their interview in progress keeps its original plan"
            : ""),
        "ok",
      );
    } catch (err) {
      toast(`Could not save: ${err.message}`, "err");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    const ok = await confirm({
      title: "Use the dashboard defaults?",
      body: "This candidate's own settings will be dropped.",
      ok: "Use defaults",
    });
    if (!ok) return;
    try {
      await del(`/api/candidate-options/${seg(historyId)}/${seg(candidateId)}`);
      onClose();
      await onSaved();
      toast("Back to the dashboard defaults", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  };

  return (
    <Drawer
      open={open}
      title={`Interview settings · ${properName(candidateName || "")}`}
      onClose={onClose}
    >
      {!options && (
        <div className="drafting">
          <div className="spinner" />
          <p className="sub">Loading settings…</p>
        </div>
      )}

      {options && info && (
        <>
          {info.locked && (
            <div className="inline-note">
              {info.lock_reason} Saving here will apply if you re-run this candidate, but it will
              not change the interview in progress.
            </div>
          )}

          <div className={`inline-note ${info.has_override ? "" : "inline-note-quiet"}`}>
            {info.has_override
              ? `This candidate has settings of their own. They override the dashboard defaults${
                  info.updated_at ? ` · set ${when(info.updated_at)}` : ""
                }.`
              : `Following the dashboard defaults. Change anything below to give ${properName(
                  candidateName || "",
                )} their own shape.`}
          </div>

          <InterviewShape
            cfg={cfg}
            options={options}
            onChange={setOptions}
            voices={voices}
            preferred={preferred}
            tightWeights
            capNote={false}
          />

          <div className="inline-note">
            Weights decide how the parameters combine into the overall score. Setting them for one
            candidate means their score is <strong>not directly comparable</strong> with anybody
            scored on the defaults. It is allowed, and it is recorded: the report and the row both
            say so.
          </div>

          <p className="hint">
            The voice and rate apply wherever this interview is taken — including in the
            candidate&apos;s own browser when they open their link. If the named voice is not
            installed there, the best available English voice is used.
          </p>

          <h4>Why this candidate</h4>
          <input
            type="text"
            value={note}
            placeholder="optional — e.g. specialist hire, weight technical higher"
            onChange={(e) => setNote(e.target.value)}
          />

          {info.link_issued && (
            <div className="inline-note inline-note-quiet">
              A link has already been issued. Saving updates it, so long as they have not started.
            </div>
          )}

          <div className="drawer-actions">
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save for this candidate"}
            </button>
            {info.has_override && (
              <button type="button" className="btn btn-ghost" onClick={reset}>
                Use the defaults instead
              </button>
            )}
            <button type="button" className="btn btn-link" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Drawer>
  );
}
