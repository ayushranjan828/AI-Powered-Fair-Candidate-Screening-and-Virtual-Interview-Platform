"""Hand-off from the screening app.

The screening app freezes each human-accepted shortlist as a JSON record under
its own `data/history/`. This module reads those records (read-only - the
screening app owns those files) so a shortlisted candidate can be pulled
straight into an interview instead of being re-typed.

A candidate can also be entered by hand, so nothing here is required for the
interviewer to work standalone.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import config

# Statuses the screening app considers shortlisted enough to interview.
INTERVIEWABLE = ("SHORTLISTED", "REVIEW")

NA = "NA"


def _read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _history_files() -> list[Path]:
    """Every accepted-shortlist file, de-duplicated by file name.

    The screening app has been run from two working directories over its life, so
    its history can sit in either `data/history` or `backend/data/history`. Both
    are read; the same record in both places is counted once.
    """
    seen: set[str] = set()
    found: list[Path] = []
    for base in config.SCREENING_DATA_DIRS:
        directory = base / "history"
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.json")):
            if path.name in seen:
                continue
            seen.add(path.name)
            found.append(path)
    return found


def list_shortlists() -> list[dict]:
    """Summary of every accepted shortlist available to interview from."""
    rows = []
    for path in _history_files():
        record = _read(path)
        if not record:
            continue
        candidates = record.get("candidates", [])
        rows.append({
            "history_id": record.get("history_id") or path.stem,
            "job_title": record.get("job_title", NA),
            "accepted_at": record.get("accepted_at"),
            "accepted_by": record.get("accepted_by", NA),
            "candidate_count": len(candidates),
            "interviewable": sum(1 for c in candidates if c.get("status") in INTERVIEWABLE),
            "has_jd": bool(record.get("jd_text")),
        })
    rows.sort(key=lambda r: r.get("accepted_at") or "", reverse=True)
    return rows


def load_shortlist(history_id: str) -> dict | None:
    for path in _history_files():
        record = _read(path)
        if record and (record.get("history_id") == history_id or path.stem == history_id):
            return record
    return None


def shortlist_candidates(history_id: str) -> dict | None:
    """One shortlist, reduced to what the interview setup screen needs."""
    record = load_shortlist(history_id)
    if not record:
        return None
    rows = [c for c in record.get("candidates", []) if c.get("status") in INTERVIEWABLE]
    return {
        "history_id": record.get("history_id") or history_id,
        "job_title": record.get("job_title", NA),
        "jd_text": record.get("jd_text", ""),
        "jd_analysis": record.get("jd_analysis", {}) or {},
        "accepted_at": record.get("accepted_at"),
        "candidates": [
            {
                "candidate_id": c.get("candidate_id"),
                "candidate_name": c.get("candidate_name", NA),
                "email_id": c.get("email_id", NA),
                "current_role": c.get("current_role", NA),
                "experience": c.get("experience", NA),
                "ats_score": c.get("ats_score"),
                "status": c.get("status"),
            }
            for c in rows
        ],
    }


def pick_candidate(history_id: str, candidate_id: str) -> dict | None:
    """The full screening row for one candidate, as stored by the screening app."""
    record = load_shortlist(history_id)
    if not record:
        return None
    for row in record.get("candidates", []):
        if row.get("candidate_id") == candidate_id:
            return dict(row)
    return None


# ------------------------------------------------------------- invite resolution
def _session_files() -> list[Path]:
    """Screening sessions, de-duplicated by file name. Same two-location story
    as _history_files()."""
    seen: set[str] = set()
    found: list[Path] = []
    for base in config.SCREENING_DATA_DIRS:
        directory = base / "sessions"
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.json")):
            if path.name in seen:
                continue
            seen.add(path.name)
            found.append(path)
    return found


def find_for_invite(key_id: str, candidate_id: str) -> dict | None:
    """Resolve an interview link's ids to a candidate and their role.

    An invitation can be sent before the recruiter accepts the shortlist into
    history, so the link's key is whichever id existed at the time - a history id
    or a session id. Both are searched, history first because an accepted record
    is the reviewed one.

    Returns the candidate row plus the JD context needed to plan an interview, or
    None if the link does not point at anybody we can find.
    """
    for loader, key_field in ((_history_files, "history_id"), (_session_files, "session_id")):
        for path in loader():
            record = _read(path)
            if not record:
                continue
            if record.get(key_field) != key_id and path.stem != key_id:
                continue
            for row in record.get("candidates", []):
                if row.get("candidate_id") != candidate_id:
                    continue
                return {
                    "candidate": dict(row),
                    "job_title": record.get("job_title", NA),
                    "jd_text": record.get("jd_text", ""),
                    "jd_analysis": record.get("jd_analysis", {}) or {},
                    "source_kind": key_field,
                    "source_id": key_id,
                }
    return None


# --------------------------------------------------------------- normalisation
def _text(value) -> str:
    if value is None:
        return NA
    if isinstance(value, (list, tuple)):
        items = [str(v).strip() for v in value if str(v).strip()]
        return ", ".join(items) if items else NA
    text = str(value).strip()
    return text if text and text.lower() not in ("none", "null", "n/a", "-") else NA


def normalize_candidate(raw: dict) -> dict:
    """The candidate shape the interviewer works with.

    Accepts either a screening row or a hand-typed form payload, so the rest of
    the app never has to care which door the candidate came in through.
    """
    return {
        "candidate_id": _text(raw.get("candidate_id")),
        "candidate_name": _text(raw.get("candidate_name")),
        "email_id": _text(raw.get("email_id")),
        "phone_number": _text(raw.get("phone_number")),
        "current_role": _text(raw.get("current_role")),
        "location": _text(raw.get("location")),
        "skills": _text(raw.get("skills")),
        "certification": _text(raw.get("certification") or raw.get("certifications")),
        "experience": _text(raw.get("experience")),
        "experience_years": raw.get("experience_years") or 0,
        "highest_education": _text(raw.get("highest_education")),
        "education_details": _text(raw.get("education_details")),
        "projects": _text(raw.get("projects")),
        "matched_skills": _text(raw.get("matched_skills")),
        "missing_skills": _text(raw.get("missing_skills")),
        "transferable_strengths": _text(raw.get("transferable_strengths")),
        # Free-text resume, if one was pasted. A screening row carries only a
        # preview, which is still useful grounding for question generation.
        "resume_text": str(raw.get("resume_text") or raw.get("resume_preview") or "").strip(),
        # Screening figures are carried for the record only. The interviewer is
        # never shown them - see resume_context().
        "screening": {
            "ats_score": raw.get("ats_score"),
            "status": raw.get("status"),
            "recommendation": raw.get("recommendation"),
        },
    }


def display_name(raw) -> str:
    """A first name fit to greet someone by, out loud.

    Resumes are routinely headed with the name in block capitals and the
    screening extractor keeps it verbatim, but a text-to-speech voice reads
    "PRIYA SUNDARAM" as an initialism, letter by letter.
    """
    name = str(raw or "").strip()
    if not name or name == NA:
        return "there"
    letters = [c for c in name if c.isalpha()]
    if letters and all(c.isupper() for c in letters):
        name = name.title()
    parts = name.split()
    return parts[0] if parts else "there"


def resume_context(candidate: dict) -> str:
    """The candidate briefing handed to the question-writing model.

    Deliberately excludes the ATS score, screening status and recommendation:
    the interview judges performance on the day, so the interviewer must not
    know how the resume was graded.
    """
    fields = [
        ("Name", candidate.get("candidate_name")),
        ("Current role", candidate.get("current_role")),
        ("Total experience", candidate.get("experience")),
        ("Highest education", candidate.get("highest_education")),
        ("Education details", candidate.get("education_details")),
        ("Skills listed on the resume", candidate.get("skills")),
        ("Certifications", candidate.get("certification")),
        ("Projects listed on the resume", candidate.get("projects")),
    ]
    lines = [f"{label}: {value}" for label, value in fields if value and str(value) != NA]
    resume_text = (candidate.get("resume_text") or "").strip()
    if resume_text:
        lines.append("")
        lines.append("Resume text (may be truncated):")
        lines.append(resume_text[: config.MAX_RESUME_CHARS])
    return "\n".join(lines) or "No resume details were provided."
