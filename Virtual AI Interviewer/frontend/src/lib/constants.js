export const TABS = [
  { id: "setup", n: 1, label: "Dashboard", hint: "Shortlist, links & settings" },
  { id: "stage", n: 2, label: "Interview", hint: "Live interview stage" },
  { id: "report", n: 3, label: "Report", hint: "Scores & decisions" },
  { id: "history", n: 4, label: "History", hint: "All interviews" },
];

/** Where a shortlisted candidate has got to. Mirrors _row_stage() in main.py. */
export const STAGES = {
  NOT_INVITED: { label: "Not invited", cls: "pill-muted" },
  DRAFTED: { label: "Draft ready", cls: "pill-brand" },
  SENT: { label: "Sent", cls: "pill-warn" },
  PREPARING: { label: "Preparing", cls: "pill-muted" },
  IN_PROGRESS: { label: "In progress", cls: "pill-live" },
  COMPLETED: { label: "Completed", cls: "pill-ok" },
  ABANDONED: { label: "Discarded", cls: "pill-bad" },
  REVOKED: { label: "Withdrawn", cls: "pill-bad" },
};

export const STAGE_ORDER = [
  "ALL",
  "NOT_INVITED",
  "DRAFTED",
  "SENT",
  "IN_PROGRESS",
  "COMPLETED",
  "ABANDONED",
  "REVOKED",
];

export const ATTEND = {
  COMPLETED: { label: "Yes · completed", cls: "pill-ok" },
  PARTIAL: { label: "Yes · unfinished", cls: "pill-warn" },
  NOT_STARTED: { label: "No · never started", cls: "pill-bad" },
  NO_INTERVIEW: { label: "No · not invited", cls: "pill-muted" },
};

export const DECISION = {
  PROCEED: { label: "Proceed", cls: "pill-ok" },
  HOLD: { label: "Hold", cls: "pill-warn" },
  REJECT: { label: "Do not proceed", cls: "pill-bad" },
  "": { label: "Not decided", cls: "pill-muted" },
};

export const ATTEND_FILTERS = [
  ["ALL", "All"],
  ["ATTENDED", "Attended"],
  ["NOT_ATTENDED", "Not attended"],
  ["COMPLETED", "Completed"],
  ["PARTIAL", "Unfinished"],
  ["NOT_STARTED", "Never started"],
  ["NO_INTERVIEW", "Not invited"],
];

export const DECISION_FILTERS = [
  ["ALL", "All"],
  ["PROCEED", "Proceed"],
  ["HOLD", "Hold"],
  ["REJECT", "Do not proceed"],
  ["NONE", "Not decided"],
];

export const HIST_FILTERS = [
  ["ALL", "All"],
  ["completed", "Completed"],
  ["in_progress", "In progress"],
  ["ready", "Not started"],
  ["planning", "Preparing"],
  ["abandoned", "Discarded"],
];

/**
 * The Report tab can span every shortlist at once, which is the only view that
 * includes one-off interviews and ones whose shortlist has been deleted.
 */
export const ALL_SCOPE = "__ALL__";

/** Scope used for the invite routes of a candidate who was never shortlisted. */
export const ONE_OFF_SCOPE = "__one_off__";

export const DEFAULT_VOICE_RATE = 0.98;

/** Every interview opens and closes; these two are never optional. */
export const FORCED_CATEGORIES = new Set(["intro", "closing"]);

export const VERDICT_CLS = {
  STRONG_HIRE: "pill-ok",
  HIRE: "pill-ok",
  BORDERLINE: "pill-warn",
};

export const FALLBACK_CFG = {
  categories: {},
  parameters: {},
  default_weights: {},
  default_planned_count: 10,
  default_max_followups: 2,
  max_total_turns: 30,
  ai_configured: false,
  interviewer: {},
};
