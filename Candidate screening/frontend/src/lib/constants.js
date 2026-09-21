export const CRITERIA_INFO = {
  education: "Highest qualification vs the education the JD asks for.",
  skills: "Must-have skills and genuine equivalents found in the resume.",
  experience: "Relevant years and depth against the JD responsibilities.",
  projects: "Relevance, complexity and ownership of the projects shown.",
  certifications: "Relevant certifications explicitly named in the resume.",
};

/** Must stay in step with ROW_STATUSES in backend/main.py. */
export const STATUSES = [
  "SHORTLISTED",
  "REVIEW",
  "NOT_SHORTLISTED",
  "PARSE_FAILED",
];

/** Extensions the backend extractors understand. */
export const ALLOWED_EXT = /\.(pdf|docx?|docm|rtf|txt|zip)$/i;

export const TABS = [
  { id: "screen", n: 1, label: "Screen", hint: "JD, resumes & criteria" },
  { id: "results", n: 2, label: "Review", hint: "Verify the shortlist" },
  { id: "outreach", n: 3, label: "Invite", hint: "Interview invitations" },
  { id: "history", n: 4, label: "History", hint: "Accepted records" },
];
