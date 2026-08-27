"""Deterministic scoring layer.

The AI grades each criterion; this module applies the weights, the per-criterion
cutoffs and the overall shortlist threshold. Keeping the arithmetic out of the
model makes every decision reproducible and auditable.
"""
from __future__ import annotations

from . import config

NA = "NA"


def _clamp(value, low=0.0, high=100.0) -> float:
    try:
        return max(low, min(high, float(value)))
    except (TypeError, ValueError):
        return 0.0


def normalize_weights(weights: dict | None) -> dict:
    base = dict(config.DEFAULT_WEIGHTS)
    if weights:
        for key in config.CRITERIA:
            if key in weights:
                base[key] = _clamp(weights[key], 0, 100)
    total = sum(base.values())
    if total <= 0:
        return dict(config.DEFAULT_WEIGHTS)
    return {k: round(v * 100.0 / total, 4) for k, v in base.items()}


def normalize_cutoffs(cutoffs: dict | None) -> dict:
    base = dict(config.DEFAULT_CRITERIA_CUTOFFS)
    if cutoffs:
        for key in config.CRITERIA:
            if key in cutoffs:
                base[key] = _clamp(cutoffs[key])
    return base


def _text(value) -> str:
    if value is None:
        return NA
    if isinstance(value, (list, tuple)):
        items = [str(v).strip() for v in value if str(v).strip()]
        return ", ".join(items) if items else NA
    text = str(value).strip()
    return text if text and text.lower() not in ("none", "null", "n/a", "-") else NA


def _list(value) -> list[str]:
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip() and value.strip().upper() != NA:
        return [p.strip() for p in value.split(",") if p.strip()]
    return []


def compute(analysis: dict, weights: dict, cutoffs: dict, threshold: float) -> dict:
    """Turn a raw AI analysis into scores + a shortlist decision."""
    raw = analysis.get("scores") or {}
    scores = {k: round(_clamp(raw.get(k, 0)), 1) for k in config.CRITERIA}

    ats_score = round(sum(scores[k] * weights[k] / 100.0 for k in config.CRITERIA), 2)

    failed = [k for k in config.CRITERIA if cutoffs.get(k, 0) > 0 and scores[k] < cutoffs[k]]
    meets_threshold = ats_score >= threshold

    if meets_threshold and not failed:
        status, reason = "SHORTLISTED", f"ATS score {ats_score}% meets the {threshold}% threshold."
    elif meets_threshold and failed:
        status = "REVIEW"
        names = ", ".join(f"{k} {scores[k]}% < {cutoffs[k]}%" for k in failed)
        reason = f"ATS score {ats_score}% clears the threshold but criterion cutoff not met ({names})."
    else:
        status = "NOT_SHORTLISTED"
        reason = f"ATS score {ats_score}% is below the {threshold}% threshold."

    return {
        "scores": scores,
        "ats_score": ats_score,
        "status": status,
        "decision_reason": reason,
        "failed_cutoffs": failed,
    }


def build_candidate(
    candidate_id: str,
    file_name: str,
    analysis: dict,
    weights: dict,
    cutoffs: dict,
    threshold: float,
    extraction_error: str = "",
) -> dict:
    """The canonical candidate row shared by the API, the UI grid and Excel."""
    verdict = compute(analysis, weights, cutoffs, threshold)
    skills = _list(analysis.get("skills"))
    certs = _list(analysis.get("certifications"))

    try:
        years = round(float(analysis.get("experience_years") or 0), 1)
    except (TypeError, ValueError):
        years = 0.0

    experience_summary = _text(analysis.get("experience_summary"))
    experience_display = f"{years} yrs" if years else ("Fresher" if experience_summary != NA else NA)
    if experience_summary != NA:
        experience_display = f"{experience_display} - {experience_summary}"

    return {
        "candidate_id": candidate_id,
        "candidate_name": _text(analysis.get("candidate_name")),
        "phone_number": _text(analysis.get("phone_number")),
        "email_id": _text(analysis.get("email_id")),
        "skills": ", ".join(skills) if skills else NA,
        "certification": ", ".join(certs) if certs else NA,
        "experience": experience_display,
        "experience_years": years,
        "highest_education": _text(analysis.get("highest_education")),
        "education_details": _text(analysis.get("education_details")),
        "projects": _text(analysis.get("projects")),
        "current_role": _text(analysis.get("current_role")),
        "location": _text(analysis.get("location")),
        "matched_skills": _text(analysis.get("matched_skills")),
        "missing_skills": _text(analysis.get("missing_skills")),
        "transferable_strengths": _text(analysis.get("transferable_strengths")),
        "red_flags": _text(analysis.get("red_flags")),
        "recommendation": _text(analysis.get("recommendation")),
        "justification": _text(analysis.get("justification")),
        "score_education": verdict["scores"]["education"],
        "score_skills": verdict["scores"]["skills"],
        "score_experience": verdict["scores"]["experience"],
        "score_projects": verdict["scores"]["projects"],
        "score_certifications": verdict["scores"]["certifications"],
        "ats_score": verdict["ats_score"],
        "status": verdict["status"],
        "decision_reason": verdict["decision_reason"],
        "failed_cutoffs": verdict["failed_cutoffs"],
        "source_file": file_name,
        "extraction_error": extraction_error,
        "manually_added": False,
        "edited": False,
    }


def blank_candidate(candidate_id: str) -> dict:
    row = build_candidate(candidate_id, "manual entry", {}, normalize_weights(None),
                          normalize_cutoffs(None), config.SHORTLIST_THRESHOLD)
    row.update({"manually_added": True, "status": "SHORTLISTED",
                "decision_reason": "Added manually by reviewer.",
                "justification": NA, "recommendation": NA})
    return row
