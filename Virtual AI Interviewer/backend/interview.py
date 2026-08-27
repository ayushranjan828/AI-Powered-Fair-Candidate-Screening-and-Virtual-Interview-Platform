"""The interview engine: the state machine that decides what the interviewer
says next, records what the candidate said, and closes the interview out.

A real interview is not a form. It is a plan the interviewer deviates from when
an answer is worth chasing, so the engine holds two things: the prepared plan,
and a slot for one follow-up generated live from the answer just given. That slot
is what makes the conversation feel like a conversation.

Rules that live here rather than in the prompt, because a model should not be
trusted to enforce them:
  - a planned question gets at most MAX_FOLLOWUPS_PER_QUESTION follow-ups;
  - the whole interview stops at MAX_TOTAL_TURNS turns, however interesting it is;
  - somebody who gave a non-answer is never followed up - that is badgering;
  - the closing question is always reached, even if the budget ran out.
"""
from __future__ import annotations

import asyncio

import httpx

from . import ai_agent, candidates, config, evaluation, storage

STATUS_PLANNING = "planning"
STATUS_READY = "ready"
STATUS_IN_PROGRESS = "in_progress"
STATUS_COMPLETED = "completed"
STATUS_ABANDONED = "abandoned"

# Live planning progress, mirrored into the record on every write so a reload
# during planning does not lose the stage. Same pattern as the screening app.
PROGRESS: dict[str, dict] = {}


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(config.REQUEST_TIMEOUT_SECONDS))


# --------------------------------------------------------------------- create
def build_mix(planned_count: int, categories: list[str] | None) -> dict:
    """Turn a requested question count and category selection into a plan shape.

    The intro and closing are always kept - an interview that opens cold or ends
    without giving the candidate the floor is not an interview.
    """
    allowed = [c for c in (categories or list(config.CATEGORIES)) if c in config.CATEGORIES]
    if not allowed:
        allowed = list(config.CATEGORIES)
    if "intro" not in allowed:
        allowed.insert(0, "intro")
    if "closing" not in allowed:
        allowed.append("closing")

    mix = {k: v for k, v in config.DEFAULT_CATEGORY_MIX.items() if k in allowed}
    for key in allowed:
        mix.setdefault(key, 1)

    fixed = {"intro": 1, "closing": 1}
    mix.update(fixed)
    body_keys = [k for k in mix if k not in fixed]

    target_body = max(1, planned_count - len(fixed))
    # Trim from the least-weighted categories first, grow the most-weighted.
    by_weight = sorted(body_keys,
                       key=lambda k: config.CATEGORIES[k]["weight"], reverse=True)

    def body_total() -> int:
        return sum(mix[k] for k in body_keys)

    while body_total() > target_body:
        for key in reversed(by_weight):
            if body_total() <= target_body:
                break
            if mix[key] > 0:
                mix[key] -= 1
    while body_total() < target_body:
        for key in by_weight:
            if body_total() >= target_body:
                break
            mix[key] += 1

    return {k: v for k, v in mix.items() if v > 0}


def _clamp_rate(value) -> float:
    """Speaking rate, held to the range the UI offers and the voices handle."""
    try:
        return round(max(0.7, min(1.3, float(value))), 2)
    except (TypeError, ValueError):
        return 0.98


def create_interview(candidate_raw: dict, jd_text: str, jd_analysis: dict,
                     job_title: str, options: dict, source: dict) -> dict:
    candidate = candidates.normalize_candidate(candidate_raw)
    planned_count = int(options.get("planned_count") or config.PLANNED_QUESTION_COUNT)
    planned_count = max(4, min(20, planned_count))
    max_followups = int(options.get("max_followups", config.MAX_FOLLOWUPS_PER_QUESTION))
    max_followups = max(0, min(4, max_followups))

    interview_id = storage.new_id("INT")
    interview = {
        "interview_id": interview_id,
        "created_at": storage.now_iso(),
        "status": STATUS_PLANNING,
        "job_title": (job_title or jd_analysis.get("role_title") or "NA").strip() or "NA",
        "jd_text": (jd_text or "").strip(),
        "jd_analysis": jd_analysis or {},
        "candidate": candidate,
        "source": source,
        "interviewer": {
            "name": config.INTERVIEWER_NAME,
            "role": config.INTERVIEWER_ROLE,
            "company": config.COMPANY_NAME,
        },
        "options": {
            "planned_count": planned_count,
            "max_followups": max_followups,
            "categories": [c for c in (options.get("categories") or list(config.CATEGORIES))
                           if c in config.CATEGORIES],
            "voice": bool(options.get("voice", True)),
            # Carried onto the record so the candidate's own browser speaks in the
            # voice and at the speed the recruiter chose, not its own defaults.
            "voice_name": str(options.get("voice_name") or "")[:120],
            "voice_rate": _clamp_rate(options.get("voice_rate")),
        },
        "weights": evaluation.normalize_weights(options.get("weights")),
        "plan": None,
        "plan_error": "",
        "cursor": {
            "greeted": False,
            "plan_index": 0,
            "followups_used": 0,
            "pending_followup": None,
            "closed": False,
        },
        "turns": [],
        "report": None,
        "progress": {"stage": "Queued", "detail": "Preparing the interview plan."},
    }
    storage.save_interview(interview)
    PROGRESS[interview_id] = dict(interview["progress"])
    return interview


async def plan_interview(interview_id: str) -> None:
    """Background: analyse the JD if needed, then write the question plan."""
    interview = storage.load_interview(interview_id)
    if not interview:
        return
    progress = PROGRESS.setdefault(interview_id, {})

    def flush(stage: str, detail: str = "") -> None:
        progress.update({"stage": stage, "detail": detail})
        interview["progress"] = dict(progress)
        storage.save_interview(interview)

    async with _client() as client:
        rubric = interview.get("jd_analysis") or {}
        if not rubric.get("must_have_skills") and interview.get("jd_text"):
            flush("Reading the job description",
                  "Working out what this role actually needs.")
            try:
                rubric = await ai_agent.analyze_jd(client, interview["jd_text"])
                interview["jd_analysis"] = rubric
                if interview.get("job_title") in ("", "NA") and rubric.get("role_title"):
                    interview["job_title"] = rubric["role_title"]
            except Exception as exc:  # noqa: BLE001
                interview["plan_error"] = f"JD analysis failed: {exc}"

        flush("Writing your questions",
              "Reading the resume and preparing questions about it.")
        mix = build_mix(interview["options"]["planned_count"],
                        interview["options"]["categories"])
        try:
            plan = await ai_agent.build_question_plan(
                client, interview["candidate"], rubric, mix,
                interview["options"]["planned_count"],
            )
            plan["source"] = "ai"
        except Exception as exc:  # noqa: BLE001
            plan = ai_agent.fallback_plan(interview["candidate"], rubric,
                                          interview["options"]["planned_count"])
            interview["plan_error"] = (
                f"{interview.get('plan_error', '')} Question plan fell back to the "
                f"built-in set: {exc}"
            ).strip()

    # If the model reached outside the categories the recruiter selected, say so
    # rather than quietly delivering a different interview from the one asked for.
    strays = plan.get("category_strays") or []
    if strays:
        labels = ", ".join(_category_label(c) for c in strays)
        interview["plan_error"] = (
            f"{interview.get('plan_error', '')} The plan also included "
            f"{labels} question(s), which were not among the selected categories."
        ).strip()

    plan["questions"] = _order_plan([q for q in plan["questions"] if q.get("question")])
    if not plan["questions"]:
        plan = ai_agent.fallback_plan(interview["candidate"], interview.get("jd_analysis") or {},
                                      interview["options"]["planned_count"])
        plan["questions"] = _order_plan(plan["questions"])

    if not plan.get("opening_line"):
        plan["opening_line"] = _default_opening(interview)
    if not plan.get("closing_line"):
        plan["closing_line"] = _default_closing()

    interview["plan"] = plan
    interview["status"] = STATUS_READY
    interview["progress"] = {"stage": "Ready",
                             "detail": f"{len(plan['questions'])} questions prepared."}
    PROGRESS[interview_id] = dict(interview["progress"])
    storage.save_interview(interview)


def _order_plan(questions: list[dict]) -> list[dict]:
    """Intro first, closing last, everything else in the order given."""
    intro = [q for q in questions if q["category"] == "intro"]
    closing = [q for q in questions if q["category"] == "closing"]
    body = [q for q in questions if q["category"] not in ("intro", "closing")]
    return (intro[:1] or []) + body + (closing[:1] or [])


def _default_opening(interview: dict) -> str:
    name = candidates.display_name(interview["candidate"].get("candidate_name"))
    role = interview.get("job_title") or "this role"
    return (
        f"Hello {name}, thanks for joining me today. I am "
        f"{interview['interviewer']['name']}, and I will be interviewing you for the "
        f"{role} position. I will ask about your background, your projects and a few "
        "scenarios. Please think aloud as you answer, and take your time."
    )


def _default_closing() -> str:
    return ("Thank you, that is everything from my side. The team will review our "
            "conversation and be in touch about the next step.")


# ----------------------------------------------------------------- turn engine
def _category_label(category: str) -> str:
    return config.CATEGORIES.get(category, {}).get("label", category.title())


def _budget_exhausted(interview: dict) -> bool:
    return len(interview["turns"]) >= config.MAX_TOTAL_TURNS


def _planned_remaining(interview: dict) -> int:
    plan = interview.get("plan") or {}
    return max(0, len(plan.get("questions", [])) - interview["cursor"]["plan_index"])


def next_prompt(interview: dict) -> dict:
    """What the interviewer says next - and whether it wants an answer back.

    Called by the client between turns. Appends the turn it is about to ask so
    the answer has somewhere to land, then persists.
    """
    cursor = interview["cursor"]
    plan = interview.get("plan") or {}
    questions = plan.get("questions", [])

    if not cursor["greeted"]:
        cursor["greeted"] = True
        interview["status"] = STATUS_IN_PROGRESS
        interview["started_at"] = interview.get("started_at") or storage.now_iso()
        storage.save_interview(interview)
        return {
            "kind": "opening",
            "speech": plan.get("opening_line") or _default_opening(interview),
            "emotion": "friendly",
            "expects_answer": False,
            "progress": _progress(interview),
        }

    pending = cursor.get("pending_followup")
    if pending and not _budget_exhausted(interview):
        cursor["pending_followup"] = None
        cursor["followups_used"] += 1
        return _emit(interview, {
            "category": pending["category"],
            "question": pending["question"],
            "intent": pending.get("reason") or "Follow-up on the previous answer.",
            "focus": pending.get("focus", "NA"),
            "difficulty": pending.get("difficulty", "medium"),
            "expected_points": [],
            "emotion": pending.get("emotion", "curious"),
        }, source="followup", parent_turn=pending.get("parent_turn"),
            reaction=pending.get("reaction", ""))
    cursor["pending_followup"] = None

    # Out of budget: jump to the closing question if it has not been asked, so the
    # candidate always gets the floor before we wrap up.
    if _budget_exhausted(interview) and cursor["plan_index"] < len(questions):
        closing_index = next((i for i, q in enumerate(questions)
                              if q["category"] == "closing"
                              and i >= cursor["plan_index"]), None)
        cursor["plan_index"] = closing_index if closing_index is not None else len(questions)

    if cursor["plan_index"] < len(questions):
        question = questions[cursor["plan_index"]]
        cursor["plan_index"] += 1
        cursor["followups_used"] = 0
        return _emit(interview, question, source="planned",
                     reaction=_pending_reaction(interview))

    if not cursor["closed"]:
        cursor["closed"] = True
        # The acknowledgement for the very last answer has nowhere else to go, so
        # it rides along with the closing line rather than being dropped.
        closing = plan.get("closing_line") or _default_closing()
        reaction = _pending_reaction(interview)
        storage.save_interview(interview)
        return {
            "kind": "closing",
            "speech": f"{reaction} {closing}".strip() if reaction else closing,
            "emotion": "friendly",
            "expects_answer": False,
            "progress": _progress(interview),
        }

    return {"kind": "done", "speech": "", "emotion": "neutral",
            "expects_answer": False, "progress": _progress(interview)}


def _pending_reaction(interview: dict) -> str:
    """The acknowledgement the last assessment produced, said before moving on."""
    for turn in reversed(interview["turns"]):
        if turn.get("answer"):
            reaction = ((turn.get("assessment") or {}).get("reaction") or {}).get("line", "")
            if turn.get("reaction_spoken"):
                return ""
            turn["reaction_spoken"] = True
            return reaction
    return ""


def _emit(interview: dict, question: dict, source: str,
          parent_turn: int | None = None, reaction: str = "") -> dict:
    turn_number = len(interview["turns"]) + 1
    turn = {
        "turn": turn_number,
        "question_id": (f"Q{turn_number}" if source == "planned"
                        else f"Q{parent_turn or turn_number}.f{turn_number}"),
        "category": question["category"],
        "category_label": _category_label(question["category"]),
        "difficulty": question.get("difficulty", "medium"),
        "intent": question.get("intent", ""),
        "focus": question.get("focus", "NA"),
        "expected_points": question.get("expected_points", []),
        "question": question["question"],
        "question_source": source,
        "parent_turn": parent_turn,
        "emotion": question.get("emotion", "neutral"),
        "reaction": reaction,
        "asked_at": storage.now_iso(),
        "answer": "",
        "answer_seconds": 0,
        "answered_at": None,
        "mode": "",
        "metrics": {},
        "assessment": {},
    }
    interview["turns"].append(turn)
    storage.save_interview(interview)

    speech = f"{reaction} {question['question']}".strip() if reaction else question["question"]
    return {
        "kind": "question",
        "turn": turn_number,
        "question_id": turn["question_id"],
        "category": turn["category"],
        "category_label": turn["category_label"],
        "difficulty": turn["difficulty"],
        "question": turn["question"],
        "reaction": reaction,
        "speech": speech,
        "question_source": source,
        "emotion": turn["emotion"],
        "expects_answer": True,
        "progress": _progress(interview),
    }


def _progress(interview: dict) -> dict:
    plan = interview.get("plan") or {}
    total = len(plan.get("questions", []))
    cursor = interview["cursor"]
    answered = sum(1 for t in interview["turns"] if (t.get("answer") or "").strip())
    return {
        "planned_total": total,
        "planned_asked": cursor["plan_index"],
        "turns_asked": len(interview["turns"]),
        "answered": answered,
        "followups": sum(1 for t in interview["turns"]
                         if t.get("question_source") == "followup"),
        "percent": round(min(100.0, (cursor["plan_index"] / total) * 100), 1) if total else 0.0,
    }


def _nonanswer(words: int) -> dict:
    """A skip or a near-empty answer. Recorded honestly, not graded, not chased.

    This is not a fallback - nothing failed. The candidate declined to answer,
    which is information for the reviewer but not a score.
    """
    return {
        "answer_type": "no_answer",
        "applicable": [], "scores": {},
        "covered_points": [], "missed_points": [], "strengths": [], "concerns": [],
        "evidence": "",
        "followup": {"needed": False, "question": "", "reason": "", "probe": "none"},
        "reaction": {"line": "No problem at all, let us move on.", "emotion": "encouraging"},
        "source": "skipped",
        "error": "",
    }


async def record_answer(interview: dict, turn_number: int, answer: str,
                        seconds: float, mode: str) -> dict:
    """Store one answer, grade it, and decide whether to follow up on it."""
    turn = next((t for t in interview["turns"] if t["turn"] == turn_number), None)
    if turn is None:
        raise KeyError(f"turn {turn_number} was never asked")

    metrics = evaluation.answer_metrics(answer, seconds, mode)
    turn.update({
        "answer": (answer or "").strip(),
        "answer_seconds": round(float(seconds or 0), 1),
        "answered_at": storage.now_iso(),
        "mode": mode or "voice",
        "metrics": metrics,
    })

    words = metrics["words"]
    if words < 3:
        turn["assessment"] = _nonanswer(words)
    else:
        cursor = interview["cursor"]
        ctx = {
            "role_title": (interview.get("jd_analysis") or {}).get("role_title")
                          or interview.get("job_title"),
            "category": turn["category"],
            "difficulty": turn["difficulty"],
            "question": turn["question"],
            "intent": turn["intent"],
            "expected_points": turn["expected_points"],
            "answer": turn["answer"],
            "words": words,
            "seconds": turn["answer_seconds"],
            "mode": turn["mode"],
            "followups_used": cursor["followups_used"],
            "followups_max": interview["options"]["max_followups"],
            "remaining": _planned_remaining(interview),
            "resume_snippet": candidates.resume_context(interview["candidate"]),
        }
        try:
            async with _client() as client:
                turn["assessment"] = await ai_agent.assess_turn(client, ctx)
        except Exception as exc:  # noqa: BLE001
            turn["assessment"] = ai_agent.fallback_assessment(
                turn["answer"], words, f"grading failed: {exc}")

    _queue_followup(interview, turn)
    storage.save_interview(interview)

    assessment = turn["assessment"]
    return {
        "turn": turn_number,
        "answer_type": assessment["answer_type"],
        "graded": bool(assessment["scores"]),
        "grading_source": assessment["source"],
        "grading_error": assessment.get("error", ""),
        "reaction": assessment["reaction"],
        "followup_queued": bool(interview["cursor"].get("pending_followup")),
        "metrics": metrics,
        "progress": _progress(interview),
    }


def _queue_followup(interview: dict, turn: dict) -> None:
    """Decide whether the follow-up the AI suggested actually gets asked.

    The model proposes; these limits decide. It has no view of the turn budget
    and every incentive to keep digging.
    """
    cursor = interview["cursor"]
    cursor["pending_followup"] = None

    assessment = turn.get("assessment") or {}
    followup = assessment.get("followup") or {}
    if not followup.get("needed") or not followup.get("question"):
        return
    if assessment.get("answer_type") in ("no_answer", "off_topic"):
        return
    if (turn.get("metrics") or {}).get("words", 0) < config.MIN_ANSWER_WORDS_FOR_FOLLOWUP:
        return
    if cursor["followups_used"] >= interview["options"]["max_followups"]:
        return
    if len(interview["turns"]) >= config.MAX_TOTAL_TURNS:
        return
    # Never spend the last question on a follow-up: the closing question - the one
    # that hands the candidate the floor - has to survive.
    if _planned_remaining(interview) <= 1:
        return

    cursor["pending_followup"] = {
        "category": turn["category"],
        "question": followup["question"],
        "reason": followup.get("reason", ""),
        "focus": turn.get("focus", "NA"),
        "difficulty": turn.get("difficulty", "medium"),
        "emotion": "curious",
        "parent_turn": turn["turn"],
        "reaction": (assessment.get("reaction") or {}).get("line", ""),
    }
    turn["reaction_spoken"] = True


# -------------------------------------------------------------------- finalise
async def finalize(interview: dict) -> dict:
    """Close the interview out and produce the report."""
    interview["progress"] = {"stage": "Evaluating", "detail": "Reviewing the transcript."}
    storage.save_interview(interview)

    try:
        async with _client() as client:
            holistic = await ai_agent.final_evaluation(client, interview)
    except Exception as exc:  # noqa: BLE001
        holistic = ai_agent.fallback_final(interview, f"final evaluation failed: {exc}")

    interview["report"] = evaluation.build_report(interview, holistic, interview.get("weights"))
    interview["status"] = STATUS_COMPLETED
    interview["completed_at"] = storage.now_iso()
    interview["progress"] = {"stage": "Completed", "detail": "Report ready."}
    interview["cursor"]["closed"] = True
    storage.save_interview(interview)
    return interview["report"]


async def regrade(interview: dict) -> dict:
    """Re-run the closing review over an existing transcript.

    Useful after the AI was unreachable at the end of a session: the transcript
    is intact, only the write-up is missing. Answers are never re-graded, so the
    per-answer audit trail stays exactly as it was on the day.
    """
    return await finalize(interview)


def abandon(interview: dict, reason: str = "") -> dict:
    interview["status"] = STATUS_ABANDONED
    interview["abandoned_at"] = storage.now_iso()
    interview["abandon_reason"] = reason.strip()
    interview["progress"] = {"stage": "Abandoned", "detail": reason.strip()}
    storage.save_interview(interview)
    return interview


def public_view(interview: dict) -> dict:
    """The interview as the candidate's browser may see it.

    Strips the grading key and every score. If expected_points or an assessment
    reached the candidate's console mid-interview, they would be able to read the
    marking scheme for the question they are about to answer.
    """
    turns = []
    for turn in interview.get("turns", []):
        turns.append({
            "turn": turn["turn"],
            "question_id": turn["question_id"],
            "category": turn["category"],
            "category_label": turn["category_label"],
            "question": turn["question"],
            "question_source": turn["question_source"],
            "reaction": turn.get("reaction", ""),
            "answer": turn.get("answer", ""),
            "answer_seconds": turn.get("answer_seconds", 0),
            "asked_at": turn.get("asked_at"),
            "answered_at": turn.get("answered_at"),
        })
    plan = interview.get("plan") or {}
    return {
        "interview_id": interview["interview_id"],
        "status": interview["status"],
        "job_title": interview.get("job_title"),
        "candidate": {
            "candidate_name": interview["candidate"].get("candidate_name"),
            "current_role": interview["candidate"].get("current_role"),
        },
        "interviewer": interview.get("interviewer", {}),
        "options": interview.get("options", {}),
        "planned_total": len(plan.get("questions", [])),
        "plan_source": plan.get("source", "ai"),
        "progress": _progress(interview) if interview.get("plan") else interview.get("progress", {}),
        "turns": turns,
        "has_report": bool(interview.get("report")),
    }
