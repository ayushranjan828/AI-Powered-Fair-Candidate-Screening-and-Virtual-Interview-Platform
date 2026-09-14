import { useCallback, useMemo, useState } from "react";

import Dropzone, { mergeFiles } from "./Dropzone.jsx";
import { useToast } from "./Toast.jsx";
import { api } from "../lib/api.js";
import { CRITERIA_INFO } from "../lib/constants.js";
import { titleCase } from "../lib/format.js";

/** Weights/cut-offs straight from the server defaults. */
function defaultsFrom(cfg) {
  const keys = cfg.criteria || Object.keys(CRITERIA_INFO);
  const weights = {};
  const cutoffs = {};
  for (const k of keys) {
    weights[k] = cfg.default_weights?.[k] ?? 20;
    cutoffs[k] = cfg.default_cutoffs?.[k] ?? 0;
  }
  return { keys, weights, cutoffs, threshold: cfg.default_threshold ?? 60 };
}

export default function ScreenTab({ cfg, run, onStarted, onRefreshLists }) {
  const toast = useToast();
  const initial = useMemo(() => defaultsFrom(cfg), [cfg]);

  const [jobTitle, setJobTitle] = useState("");
  const [jdText, setJdText] = useState("");
  const [files, setFiles] = useState([]);
  const [weights, setWeights] = useState(initial.weights);
  const [cutoffs, setCutoffs] = useState(initial.cutoffs);
  const [threshold, setThreshold] = useState(initial.threshold);
  const [submitting, setSubmitting] = useState(false);

  const total = useMemo(
    () => Object.values(weights).reduce((a, b) => a + (Number(b) || 0), 0),
    [weights],
  );

  const addFiles = useCallback(
    (incoming) => {
      setFiles((prev) => {
        const { files: next, skipped } = mergeFiles(prev, incoming);
        if (skipped) toast(`${skipped} unsupported file(s) skipped`, "err");
        return next;
      });
    },
    [toast],
  );

  const reset = () => {
    setWeights(initial.weights);
    setCutoffs(initial.cutoffs);
    setThreshold(initial.threshold);
  };

  const start = async () => {
    const jd = jdText.trim();
    if (!jd) return toast("Paste the Job Description first", "err");
    if (!files.length) return toast("Add at least one resume, folder or ZIP", "err");

    const fd = new FormData();
    // The server pairs `files` with `paths` positionally, so both lists must
    // be built in the same order.
    files.forEach((f) => fd.append("files", f.file, f.rel.split("/").pop()));
    fd.append("paths", JSON.stringify(files.map((f) => f.rel)));
    fd.append("jd_text", jd);
    fd.append("job_title", jobTitle.trim());
    fd.append("threshold", String(threshold));
    fd.append("weights", JSON.stringify(weights));
    fd.append("cutoffs", JSON.stringify(cutoffs));

    setSubmitting(true);
    run.show({ stage: "Uploading resumes…", processed: 0, total: files.length }, 4);

    try {
      const res = await api("/api/screen", { method: "POST", body: fd });
      if (res.duplicates) {
        toast(`${res.duplicates} duplicate resume(s) skipped — identical content`, "");
      }
      run.show({ stage: "Analysing job description", processed: 0, total: res.total_resumes }, 8);
      onStarted(res.session_id);
      onRefreshLists?.();
    } catch (err) {
      run.clear();
      toast(`Screening failed: ${err.message}`, "err");
    } finally {
      setSubmitting(false);
    }
  };

  const busy = submitting || run.running;
  const { progress } = run;

  return (
    <>
      <header className="page-head">
        <p className="crumb">Step 1 of 4</p>
        <h2>Screen candidates</h2>
        <p className="lede">
          Paste the job description and drop the resumes. The agent turns the JD into a fair
          rubric — must-haves, genuine equivalents, experience, projects — and scores every resume
          against it. Nobody is rejected on keywords alone.
        </p>
      </header>

      <div className="grid-2">
        <div className="card">
          <div className="card-title">
            <span className="card-ico" aria-hidden="true">
              📋
            </span>
            <h3>Job description</h3>
          </div>

          <label className="field">
            <span>
              Job title <em>(optional — the agent infers it from the JD)</em>
            </span>
            <input
              type="text"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="e.g. Senior Python Backend Engineer"
            />
          </label>

          <label className="field">
            <span>Full job description *</span>
            <textarea
              rows={13}
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              placeholder="Paste the complete JD here — responsibilities, must-have skills, experience, education, certifications…"
            />
          </label>
        </div>

        <div className="card">
          <div className="card-title">
            <span className="card-ico" aria-hidden="true">
              📄
            </span>
            <h3>Resumes</h3>
          </div>

          <Dropzone
            files={files}
            onAdd={addFiles}
            onRemove={(i) => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
            onClear={() => setFiles([])}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head-row">
          <div className="card-title">
            <span className="card-ico" aria-hidden="true">
              ⚖️
            </span>
            <h3>Evaluation criteria &amp; cut-offs</h3>
          </div>
          <button type="button" className="btn btn-link" onClick={reset}>
            Reset to defaults
          </button>
        </div>

        <div className="threshold-row">
          <label className="field">
            <span>ATS shortlisting threshold</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={threshold}
              style={{ "--_fill": `${threshold}%` }}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </label>
          <output className="threshold-out">{threshold}%</output>
          <p className="hint hint-inline">
            Candidates at or above this weighted score move to the next stage.
          </p>
        </div>

        <div className="table-scroll">
          <table className="criteria-table">
            <thead>
              <tr>
                <th>Criterion</th>
                <th>Weight (%)</th>
                <th>Minimum cut-off (%)</th>
                <th>What the agent looks at</th>
              </tr>
            </thead>
            <tbody>
              {initial.keys.map((key) => (
                <tr key={key}>
                  <td>
                    <strong>{titleCase(key)}</strong>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={weights[key] ?? 0}
                      onChange={(e) =>
                        setWeights((w) => ({ ...w, [key]: Number(e.target.value) || 0 }))
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={cutoffs[key] ?? 0}
                      onChange={(e) =>
                        setCutoffs((c) => ({ ...c, [key]: Number(e.target.value) || 0 }))
                      }
                    />
                  </td>
                  <td className="why">{CRITERIA_INFO[key] || ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td style={{ color: total === 100 ? "var(--ok)" : "var(--warn)" }}>{total}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="actions-row">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={start}
            disabled={busy}
          >
            {busy ? "Screening…" : "Analyse & shortlist →"}
          </button>
          <span className="hint">
            {total === 100 ? "" : `Weights total ${total}% — they will be normalised to 100%.`}
          </span>
        </div>

        {progress && (
          <div className="progress-wrap">
            <div className="progress-head">
              <strong>{progress.stage || "Working…"}</strong>
              <span>
                {progress.processed} / {progress.total}
              </span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
            </div>
            <p className="hint">
              {progress.errors
                ? `${progress.errors} resume(s) need manual review — unreadable file or AI fallback.`
                : ""}
            </p>
          </div>
        )}
      </div>
    </>
  );
}
