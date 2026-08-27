"""Deterministic evaluation layer.

The AI grades each answer and writes the closing review; this module does all the
arithmetic - weighting, blending, the overall score and the verdict band. Keeping
the numbers out of the model makes every outcome reproducible and auditable, the
same split the screening app uses in scoring.py.

Two rules drive the design:

1. A parameter is scored only where the interview produced evidence for it. An
   introduction question cannot demonstrate problem solving, so it does not drag
   that score down - it simply is not counted.
2. An ungraded answer (the AI call failed) is missing, not zero. It lowers the
   confidence of the report instead of the candidate's score.
"""
from __future__ import annotations

import re

from . import config

# Difficulty multiplies a turn's weight: a hard question that went well says more
# about the candidate than an easy one.
DIFFICULTY_WEIGHT = {"easy": 0.8, "medium": 1.0, "hard": 1.25}

# A follow-up is where the real depth shows, so it carries its parent's weight.
FOLLOWUP_BONUS = 1.1

FILLERS = ("um", "uh", "erm", "like", "you know", "basically", "actually",
           "sort of", "kind of", "i mean")


def normalize_weights(weights: dict | None) -> dict:
    base = dict(config.DEFAULT_PARAMETER_WEIGHTS)
    if weights:
        for key in config.PARAMETERS:
            if key in weights:
                try:
                    base[key] = max(0.0, min(100.0, float(weights[key])))
                except (TypeError, ValueError):
                    continue
    total = sum(base.values())
    if total <= 0:
        return dict(config.DEFAULT_PARAMETER_WEIGHTS)
    return {k: round(v * 100.0 / total, 4) for k, v in base.items()}


# ----------------------------------------------------------------- answer stats
def answer_metrics(answer: str, seconds: float, mode: str = "voice") -> dict:
    """Descriptive statistics about one answer.

    Informational only - nothing here feeds a score. Filler counts and speaking
    rate are the kind of signal that punishes nervous or non-native speakers if
    you grade on them, so they are shown to the reviewer and never scored.
    """
    text = (answer or "").strip()
    words = re.findall(r"[\w'-]+", text)
    word_count = len(words)
    lowered = " " + text.lower() + " "
    fillers = sum(lowered.count(f" {f} ") for f in FILLERS)
    seconds = max(0.0, float(seconds or 0))
    return {
        "words": word_count,
        "seconds": round(seconds, 1),
        "words_per_minute": round(word_count / (seconds / 60.0), 1) if seconds >= 5 else None,
        "filler_count": fillers,
        "mode": mode,
        "sentences": max(1, len(re.findall(r"[.!?]+", text))) if text else 0,
    }


def _turn_weight(turn: dict) -> float:
    category = turn.get("category", "technical")
    weight = config.CATEGORIES.get(category, {}).get("weight", 1.0)
    weight *= DIFFICULTY_WEIGHT.get(turn.get("difficulty", "medium"), 1.0)
    if turn.get("question_source") == "followup":
        weight *= FOLLOWUP_BONUS
    return float(weight)


def per_turn_scores(turns: list[dict]) -> dict:
    """Weighted mean of the per-answer grades, parameter by parameter.

    Returns the mean, how many answers contributed, and the total weight behind
    it, so the report can show how well-supported each number is.
    """
    totals: dict[str, float] = {}
    weights: dict[str, float] = {}
    counts: dict[str, int] = {}

    for turn in turns:
        assessment = turn.get("assessment") or {}
        scores = assessment.get("scores") or {}
        if not scores:
            continue
        weight = _turn_weight(turn)
        for key, value in scores.items():
            if key not in config.PARAMETERS:
                continue
            try:
                score = float(value)
            except (TypeError, ValueError):
                continue
            totals[key] = totals.get(key, 0.0) + score * weight
            weights[key] = weights.get(key, 0.0) + weight
            counts[key] = counts.get(key, 0) + 1

    return {
        key: {
            "score": round(totals[key] / weights[key], 1),
            "answers": counts[key],
            "weight": round(weights[key], 2),
        }
        for key in totals if weights.get(key)
    }


def blend_scores(turn_view: dict, holistic: dict) -> dict:
    """Combine the per-answer mean with the closing holistic review.

    Both halves are kept in the record: the per-answer mean is the audit trail,
    the holistic score is the one that read the transcript as a whole.
    """
    blend = max(0.0, min(1.0, config.HOLISTIC_BLEND))
    out: dict[str, dict] = {}

    for key in config.PARAMETERS:
        turn_entry = turn_view.get(key)
        turn_score = turn_entry["score"] if turn_entry else None
        holistic_score = holistic.get(key)
        try:
            holistic_score = float(holistic_score) if holistic_score is not None else None
        except (TypeError, ValueError):
            holistic_score = None

        if turn_score is not None and holistic_score is not None:
            score = turn_score * (1 - blend) + holistic_score * blend
            basis = "per-answer grades blended with the closing review"
        elif turn_score is not None:
            score, basis = turn_score, "per-answer grades only"
        elif holistic_score is not None:
            score, basis = holistic_score, "closing review only"
        else:
            out[key] = {
                "score": None, "evidenced": False, "answers": 0,
                "turn_score": None, "holistic_score": None,
                "basis": "no evidence - this parameter was not tested",
            }
            continue

        out[key] = {
            "score": round(score, 1),
            "evidenced": True,
            "answers": turn_entry["answers"] if turn_entry else 0,
            "turn_score": turn_score,
            "holistic_score": holistic_score,
            "basis": basis,
        }
    return out


def verdict_for(score: float) -> str:
    for floor, label in config.VERDICT_BANDS:
        if score >= floor:
            return label
    return config.VERDICT_FLOOR


def coverage(turns: list[dict]) -> dict:
    """What the interview actually managed to cover."""
    answered = [t for t in turns if (t.get("answer") or "").strip()]
    graded = [t for t in answered if (t.get("assessment") or {}).get("scores")]
    categories: dict[str, int] = {}
    for turn in answered:
        key = turn.get("category", "technical")
        categories[key] = categories.get(key, 0) + 1
    return {
        "asked": len(turns),
        "answered": len(answered),
        "unanswered": len(turns) - len(answered),
        "graded": len(graded),
        "ungraded": len(answered) - len(graded),
        "followups": sum(1 for t in turns if t.get("question_source") == "followup"),
        "categories": categories,
        "categories_missing": [k for k in config.CATEGORIES if k not in categories],
        "total_words": sum(int((t.get("metrics") or {}).get("words") or 0) for t in answered),
        "total_seconds": round(sum(float(t.get("answer_seconds") or 0) for t in turns), 1),
    }


def _confidence(cov: dict, ai_confidence: str) -> tuple[str, list[str]]:
    """How much this report can be trusted, and why.

    Starts from the model's own read and only ever downgrades it - a thin
    interview cannot be rescued by a confident write-up.
    """
    reasons: list[str] = []
    level = ai_confidence if ai_confidence in ("high", "medium", "low") else "medium"
    order = ["low", "medium", "high"]

    def cap(limit: str, reason: str) -> None:
        nonlocal level
        reasons.append(reason)
        if order.index(level) > order.index(limit):
            level = limit

    if cov["answered"] < 4:
        cap("low", f"only {cov['answered']} questions were answered")
    elif cov["answered"] < 7:
        cap("medium", f"{cov['answered']} questions answered - a short interview")
    if cov["ungraded"]:
        cap("medium", f"{cov['ungraded']} answers could not be graded by the AI")
    if cov["unanswered"] >= 3:
        cap("medium", f"{cov['unanswered']} questions went unanswered")
    if cov["total_words"] < 150 and cov["answered"]:
        cap("low", "the answers were very brief in total")
    return level, reasons


def build_report(interview: dict, holistic: dict, weights: dict | None = None) -> dict:
    """The final report: weighted parameter scores, overall score, verdict.

    The AI supplies judgement; every number below is computed here.
    """
    turns = interview.get("turns", [])
    weight_map = normalize_weights(weights or interview.get("weights"))
    turn_view = per_turn_scores(turns)
    parameters = blend_scores(turn_view, holistic.get("scores") or {})

    scored = {k: v for k, v in parameters.items() if v["score"] is not None}
    weight_sum = sum(weight_map[k] for k in scored)
    if weight_sum > 0:
        overall = sum(parameters[k]["score"] * weight_map[k] for k in scored) / weight_sum
        overall = round(overall, 2)
    else:
        overall = None

    cov = coverage(turns)
    confidence, confidence_reasons = _confidence(cov, holistic.get("confidence", "medium"))

    # Which parameters carry the most and least support, for the reviewer's eye.
    unevidenced = [k for k, v in parameters.items() if v["score"] is None]

    return {
        "overall_score": overall,
        "verdict": verdict_for(overall) if overall is not None else "NOT_ASSESSED",
        "parameters": parameters,
        "parameter_weights": weight_map,
        "parameter_notes": holistic.get("parameter_notes") or {},
        "unevidenced_parameters": unevidenced,
        "coverage": cov,
        "confidence": confidence,
        "confidence_reasons": confidence_reasons,
        "ai_confidence": holistic.get("confidence", "medium"),
        "strengths": holistic.get("strengths") or [],
        "gaps": holistic.get("gaps") or [],
        "standout_moments": holistic.get("standout_moments") or [],
        "not_covered": holistic.get("not_covered") or [],
        "risk_flags": holistic.get("risk_flags") or [],
        "summary": holistic.get("summary") or "",
        "recommended_next_step": holistic.get("recommended_next_step") or "",
        "review_source": holistic.get("source", "ai"),
        "review_error": holistic.get("error", ""),
        # Screening never enters the interview score. It is carried alongside so a
        # reviewer can see resume and performance side by side - and see when they
        # disagree, which is the whole point of interviewing.
        "screening_reference": (interview.get("candidate") or {}).get("screening") or {},
    }
