import { useEffect, useState } from "react";

import InterviewShape, { defaultOptions } from "./InterviewShape.jsx";
import { useConfirm } from "./Confirm.jsx";
import { useToast } from "./Toast.jsx";
import { postJson, seg } from "../lib/api.js";
import { ONE_OFF_SCOPE } from "../lib/constants.js";
import { properName } from "../lib/format.js";

const BLANK_CANDIDATE = {
  candidate_name: "",
  email_id: "",
  current_role: "",
  experience: "",
  highest_education: "",
  certification: "",
  skills: "",
  projects: "",
  resume_text: "",
};

/** A candidate who never went through screening. */
export default function ManualFold({
  cfg,
  dash,
  rubric,
  voices,
  preferred,
  onOpenStage,
  onOpenMail,
  setPlanProgress,
  waitForPlan,
}) {
  const toast = useToast();
  const confirm = useConfirm();

  const [candidate, setCandidate] = useState(BLANK_CANDIDATE);
  const [jobTitle, setJobTitle] = useState("");
  const [jdText, setJdText] = useState("");
  // Set independently of the dashboard defaults — a one-off candidate is
  // usually being interviewed for a particular reason.
  const [options, setOptions] = useState(() => defaultOptions(cfg));
  const [preparing, setPreparing] = useState(false);
  const [result, setResult] = useState(null);

  /* The fold shares the JD fields with the dashboard, so seed them from
     whichever shortlist is loaded. */
  useEffect(() => {
    if (!dash) return;
    setJobTitle(dash.job_title && dash.job_title !== "NA" ? dash.job_title : "");
    setJdText(dash.jd_text || "");
  }, [dash]);

  const field = (key, label, placeholder, extra) => (
    <label className="field">
      <span>
        {label} {extra && <em>{extra}</em>}
      </span>
      <input
        type="text"
        value={candidate[key]}
        placeholder={placeholder}
        onChange={(e) => setCandidate((c) => ({ ...c, [key]: e.target.value }))}
      />
    </label>
  );

  const copyLink = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Link copied", "ok");
    } catch {
      // The clipboard needs a secure context. Hand the text over to be copied
      // by hand instead — a link is far too long for window.prompt() to show.
      await confirm({
        title: "Copy this",
        body: "The clipboard is not available here. Select the text below and copy it.",
        copy: text,
        ok: "Done",
        cancel: "",
      });
    }
  };

  const prepare = async () => {
    const jd = jdText.trim();
    if (!jd) return toast("Paste the job description first", "err");
    if (!candidate.candidate_name.trim()) return toast("The candidate needs a name", "err");
    if (!candidate.resume_text.trim() && !candidate.skills.trim() && !candidate.projects.trim()) {
      return toast("Add the resume text, or at least skills and projects", "err");
    }

    setPreparing(true);
    setPlanProgress({ stage: "Starting", detail: "" });

    try {
      const res = await postJson("/api/interviews", {
        source: "manual",
        job_title: jobTitle.trim(),
        jd_text: jd,
        candidate: Object.fromEntries(
          Object.entries(candidate).map(([k, v]) => [k, v.trim()]),
        ),
        options,
      });

      // The off-shortlist flow offers a link first, so it does not jump to the
      // stage the way "Interview now" does.
      const status = await waitForPlan(res.interview_id, { openStage: false });

      let invite = null;
      try {
        const link = await postJson(`/api/interviews/${seg(res.interview_id)}/link`, {
          issued_by: "recruiter",
        });
        invite = link.invite;
      } catch (err) {
        console.warn("link:", err.message);
      }

      setResult({
        interviewId: res.interview_id,
        name: properName(candidate.candidate_name) || "the candidate",
        total: status?.planned_total || "",
        invite,
      });
      toast(`Interview prepared for ${properName(candidate.candidate_name)}`, "ok");
    } catch (err) {
      toast(`Could not prepare the interview: ${err.message}`, "err");
      setPlanProgress(null);
    } finally {
      setPreparing(false);
    }
  };

  const markSent = async (interviewId) => {
    try {
      await postJson(`/api/invites/${seg(ONE_OFF_SCOPE)}/${seg(interviewId)}/sent`, {
        channel: "manual",
        by: "recruiter",
      });
      toast("Marked as sent", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  };

  return (
    <details className="card fold">
      <summary>
        <span className="fold-title">Interview somebody not on a shortlist</span>
        <span className="fold-sub">For a candidate who never went through screening</span>
      </summary>

      <div className="fold-body">
        <div className="grid-2">
          {field("candidate_name", "Candidate name *", "e.g. Priya Sundaram")}
          {field("email_id", "Email", "optional")}
          {field("current_role", "Current role", "e.g. Backend Engineer at Acme")}
          {field("experience", "Total experience", "e.g. 4 years")}
          {field("highest_education", "Highest education", "e.g. B.Tech, Computer Science")}
          {field("certification", "Certifications", "comma separated")}
        </div>

        {field(
          "skills",
          "Skills",
          "Python, FastAPI, PostgreSQL, Docker…",
          "(comma separated — questions are generated from these)",
        )}

        <label className="field">
          <span>
            Projects <em>(one per line, or comma separated)</em>
          </span>
          <textarea
            rows={3}
            value={candidate.projects}
            placeholder="Rate limiter library: distributed token bucket on Redis…"
            onChange={(e) => setCandidate((c) => ({ ...c, projects: e.target.value }))}
          />
        </label>

        <label className="field">
          <span>
            Full resume text <em>(optional, but the best grounding for good questions)</em>
          </span>
          <textarea
            rows={6}
            value={candidate.resume_text}
            placeholder="Paste the whole resume here…"
            onChange={(e) => setCandidate((c) => ({ ...c, resume_text: e.target.value }))}
          />
        </label>

        <div className="grid-2">
          <label className="field">
            <span>Job title</span>
            <input
              type="text"
              value={jobTitle}
              placeholder="e.g. Software Development Engineer"
              onChange={(e) => setJobTitle(e.target.value)}
            />
          </label>
          <div className="field">
            <span>Job description rubric</span>
            {rubric?.must_have_skills?.length ? (
              <div className="inline-note inline-note-ok">
                Rubric loaded from the screening run — {rubric.must_have_skills.length} must-have
                skills, {(rubric.key_responsibilities || []).length} responsibilities.
              </div>
            ) : (
              <div className="inline-note inline-note-quiet">
                No rubric on this record — the interviewer will read the JD itself.
              </div>
            )}
          </div>
        </div>

        <label className="field">
          <span>Job description *</span>
          <textarea
            rows={6}
            value={jdText}
            placeholder="Paste the complete JD — responsibilities, must-have skills, experience…"
            onChange={(e) => setJdText(e.target.value)}
          />
        </label>

        <div className="card-head-row" style={{ marginTop: 8 }}>
          <h3 className="mini-head" style={{ margin: 0 }}>
            This interview&apos;s shape
          </h3>
          <button
            type="button"
            className="btn btn-link"
            onClick={() => setOptions(defaultOptions(cfg))}
          >
            Reset to defaults
          </button>
        </div>

        <InterviewShape
          cfg={cfg}
          options={options}
          onChange={setOptions}
          voices={voices}
          preferred={preferred}
          capNote={false}
        />

        <div className="actions-row">
          <button type="button" className="btn btn-primary" onClick={prepare} disabled={preparing}>
            {preparing ? "Preparing…" : "Prepare interview"}
          </button>
          <span className="hint">
            Prepares the questions and gives you a link to send — or you can conduct it yourself
            straight away.
          </span>
        </div>

        {result && (
          <div className="prepared">
            <div className="prepared-head">
              <span className="prepared-mark">✓</span>
              <div>
                <strong>Interview prepared for {result.name}</strong>
                <span className="sub">
                  {result.total ? `${result.total} questions · ` : ""}
                  {result.interviewId}
                </span>
              </div>
            </div>

            {result.invite ? (
              <>
                <div className="link-box">
                  <span className="link-label">Interview link</span>
                  <a href={result.invite.link} target="_blank" rel="noopener noreferrer">
                    {result.invite.link}
                  </a>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => copyLink(result.invite.link)}
                  >
                    Copy
                  </button>
                </div>
                <p className="hint">
                  Unique to {result.name}. Opening it starts this interview — there is nothing for
                  them to schedule.
                </p>
              </>
            ) : (
              <div className="inline-note">
                A link could not be issued. Check INTERVIEW_LINK_SECRET (or AZURE_OPENAI_API_KEY)
                in .env — you can still conduct the interview yourself below.
              </div>
            )}

            <div className="answer-actions">
              {result.invite && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() =>
                      onOpenMail(result.interviewId, ONE_OFF_SCOPE, candidate.candidate_name)
                    }
                  >
                    ✉ Invitation…
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => markSent(result.interviewId)}
                  >
                    ✓ Mark as sent
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onOpenStage(result.interviewId)}
              >
                Interview now
              </button>
              <button
                type="button"
                className="btn btn-link"
                onClick={() => {
                  setResult(null);
                  setCandidate(BLANK_CANDIDATE);
                }}
              >
                Prepare another
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
