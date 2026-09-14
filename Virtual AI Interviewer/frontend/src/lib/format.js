/** Shared display helpers. */

export const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

export const titleise = (key) =>
  String(key || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bJd\b/g, "JD");

/**
 * Resumes are routinely headed with the name in block capitals and the
 * screening extractor keeps it verbatim, which is right for the sheet but
 * shouts on screen. Soften it for display only.
 */
export const properName = (raw) => {
  const name = String(raw || "").trim();
  if (!name) return "";
  const letters = [...name].filter((c) => /[a-z]/i.test(c));
  return letters.length && letters.every((c) => c === c.toUpperCase())
    ? name.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    : name;
};

export const band = (score) =>
  score == null ? "" : score >= 70 ? "hi" : score >= 50 ? "mid" : "lo";

/**
 * A score with one decimal unless it is whole.
 * Rounding to integers put "50%" next to a No Hire verdict, because the real
 * value was 49.67 and the verdict bands read the exact number.
 */
export const pct = (v) =>
  v == null ? "—" : `${Number.isInteger(v) ? v : Number(v).toFixed(1)}%`;

/**
 * Screening rows carry whole paragraphs in `experience`; a table cell is not
 * the place for them. The full text stays in the cell's title attribute.
 */
export const clip = (text, n) => {
  const s = String(text ?? "").trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

export const words = (text) =>
  (String(text || "").trim().match(/[\w'-]+/g) || []).length;

/** Screening rows carry "NA" for anything the extractor did not find. */
export const has = (v) => Boolean(v && String(v).trim() && String(v).trim() !== "NA");

/** Split into word/gap tokens so the caption can bold the word being spoken. */
export function tokenise(text) {
  const tokens = [];
  const re = /\S+|\s+/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      word: /\S/.test(match[0]),
    });
  }
  return tokens;
}
