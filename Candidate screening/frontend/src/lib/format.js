/** Shared display helpers. */

export const bytes = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

export const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

export const titleCase = (s) =>
  String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);

/** "NOT_SHORTLISTED" -> "not shortlisted" */
export const humanStatus = (s) => String(s || "").replace(/_/g, " ").toLowerCase();

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
