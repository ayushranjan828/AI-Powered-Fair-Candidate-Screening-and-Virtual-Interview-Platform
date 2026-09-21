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
  - the closing question is always reached, even if the budget ran out;
  - a candidate who asks to stop is asked to confirm, and then it stops.

Not every utterance is an answer either, so submit_utterance() is the real entry
point from the client: it reads what was actually said (intent.py) and only
grades the things that were answers.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx

from . import ai_agent, candidates, config, evaluation, intent, storage

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
    # Only intro and closing selected: there is no body to pad, and the growth
    # loop below would spin forever with nothing to increment - blocking the
    # whole event loop, since this runs inside the async planning task.
    if not body_keys:
        return dict(fixed)

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
    try:
        time_limit = int(options.get("time_limit_minutes") or 0)
    except (TypeError, ValueError):
        time_limit = 0
    time_limit = 0 if time_limit <= 0 else max(5, min(180, time_limit))

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
            # 0 means no limit. A limit does not cut the candidate off mid-answer:
            # it stops new questions being asked and goes to the closing one.
            "time_limit_minutes": time_limit,
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
            # Set when the candidate asks to stop; the next utterance is read as
            # the answer to "are you sure", not as an answer to the question.
            "awaiting_end_confirm": False,
            "declines": 0,
            "time_called": False,
        },
        "turns": [],
        # Everything that happened around the answers: asking to stop, asking for
        # a repeat, leaving the tab. Kept so a reviewer can see how the interview
        # actually went, not just what was said into it.
        "events": [],
        "ended_early": False,
        "end_reason": "",
        "ended_by": "",
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
    # A surplus intro or closing question joins the body rather than vanishing,
    # so the plan keeps the question count it promised.
    return intro[:1] + intro[1:] + body + closing[1:] + closing[:1]


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
    return len(interview["turns"]) >= config.MAX_TOTAL_TURNS or _time_up(interview)


def _planned_remaining(interview: dict) -> int:
    plan = interview.get("plan") or {}
    return max(0, len(plan.get("questions", [])) - interview["cursor"]["plan_index"])


# ------------------------------------------------------------------ the clock
def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def elapsed_seconds(interview: dict) -> float:
    """Wall-clock seconds since the interviewer said hello.

    Wall clock, not the sum of answer timings: the candidate's experience of how
    long they have been sitting there includes the thinking and the questions.
    """
    started = _parse_iso(interview.get("started_at"))
    if not started:
        return 0.0
    end = _parse_iso(interview.get("completed_at") or interview.get("abandoned_at"))
    return max(0.0, ((end or datetime.now(timezone.utc)) - started).total_seconds())


def time_limit_seconds(interview: dict) -> int:
    return int((interview.get("options") or {}).get("time_limit_minutes") or 0) * 60


def _time_up(interview: dict) -> bool:
    limit = time_limit_seconds(interview)
    return bool(limit) and elapsed_seconds(interview) >= limit


def _is_answered(turn: dict) -> bool:
    """An answer that said something. "I do not know" is a turn, not an answer."""
    if not (turn.get("answer") or "").strip():
        return False
    return ((turn.get("assessment") or {}).get("answer_type") or "") != "no_answer"


def log_event(interview: dict, kind: str, detail: str = "", **extra) -> dict:
    """Record something that happened around the answers. Capped, oldest first."""
    event = {"kind": kind, "at": storage.now_iso(), "detail": str(detail)[:400]}
    event.update(extra)
    events = interview.setdefault("events", [])
    events.append(event)
    if len(events) > 200:
        del events[:-200]
    return event


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
    out_of_time = _time_up(interview)
    if _budget_exhausted(interview) and cursor["plan_index"] < len(questions):
        closing_index = next((i for i, q in enumerate(questions)
                              if q["category"] == "closing"
                              and i >= cursor["plan_index"]), None)
        cursor["plan_index"] = closing_index if closing_index is not None else len(questions)
        if out_of_time and not cursor.get("time_called"):
            log_event(interview, "time_limit",
                      f"Reached the {time_limit_seconds(interview) // 60} minute limit.")

    if cursor["plan_index"] < len(questions):
        question = questions[cursor["plan_index"]]
        cursor["plan_index"] += 1
        cursor["followups_used"] = 0
        reaction = _pending_reaction(interview)
        # Said out loud rather than shown: a candidate who is suddenly on the last
        # question deserves to know why, the way a human would tell them.
        if out_of_time and not cursor.get("time_called"):
            cursor["time_called"] = True
            reaction = (f"{reaction} We are coming up on time, so this will be my "
                        "last question.").strip()
        return _emit(interview, question, source="planned", reaction=reaction)

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
    answered = sum(1 for t in interview["turns"] if _is_answered(t))
    limit = time_limit_seconds(interview)
    elapsed = elapsed_seconds(interview)
    return {
        "planned_total": total,
        "planned_asked": cursor["plan_index"],
        "turns_asked": len(interview["turns"]),
        "answered": answered,
        "declined": sum(1 for t in interview["turns"]
                        if (t.get("answer") or "").strip() and not _is_answered(t)),
        "followups": sum(1 for t in interview["turns"]
                         if t.get("question_source") == "followup"),
        "percent": round(min(100.0, (cursor["plan_index"] / total) * 100), 1) if total else 0.0,
        # The candidate's page shows the clock and never the question count, so
        # the timing has to come from the server: a browser tab that was asleep
        # cannot be trusted to have counted the minutes correctly.
        "started_at": interview.get("started_at"),
        "elapsed_seconds": round(elapsed, 1),
        "time_limit_seconds": limit,
        "time_remaining_seconds": round(max(0.0, limit - elapsed), 1) if limit else None,
    }


# Said when somebody does not know. Rotated so a candidate having a hard run is
# not met with the same sentence four times, which reads as a machine.
_DECLINE_ACKS = (
    "No problem at all. Let us move to something else.",
    "That is fine - not everyone has touched everything. Let us try a different area.",
    "Understood, we will leave that one there.",
    "That is alright. Moving on.",
)
_SILENCE_ACKS = (
    "Let us move on to the next one.",
    "No problem, we will come back to that another time.",
)


def _nonanswer(reason: str = "brief", line: str = "") -> dict:
    """A decline or a near-empty answer. Recorded honestly, not graded, not chased.

    This is not a fallback - nothing failed. The candidate did not answer, which
    is information for the reviewer but not a score. It is decided here rather
    than by the model so that "I do not know" costs exactly nothing, every time.
    """
    return {
        "answer_type": "no_answer",
        "applicable": [], "scores": {},
        "covered_points": [], "missed_points": [], "strengths": [], "concerns": [],
        "evidence": "",
        "followup": {"needed": False, "question": "", "reason": "", "probe": "none"},
        "reaction": {"line": line or "No problem at all, let us move on.",
                     "emotion": "encouraging"},
        "source": reason,
        "error": "",
    }


def _rotate_plan_away(interview: dict, category: str) -> bool:
    """After a decline, do not walk straight into the same subject again.

    An interviewer who hears "I have not used Kubernetes" does not follow it with
    a second Kubernetes question - they change the subject. The next planned
    question is swapped for the nearest one in a different category, so the plan
    keeps every question it had; only the order changes.
    """
    plan = interview.get("plan") or {}
    questions = plan.get("questions", [])
    index = interview["cursor"]["plan_index"]
    if index >= len(questions) or questions[index].get("category") != category:
        return False
    swap = next((i for i in range(index + 1, len(questions))
                 if questions[i].get("category") not in (category, "closing")), None)
    if swap is None:
        return False
    questions[index], questions[swap] = questions[swap], questions[index]
    return True


async def record_answer(interview: dict, turn_number: int, answer: str,
                        seconds: float, mode: str, declined: bool = False) -> dict:
    """Store one answer, grade it, and decide whether to follow up on it."""
    turn = next((t for t in interview["turns"] if t["turn"] == turn_number), None)
    if turn is None:
        raise KeyError(f"turn {turn_number} was never asked")

    if turn.get("answered_at"):
        # A replayed submit (double-click, client retry after a network blip)
        # must not overwrite the stored answer or queue a second follow-up.
        # Answer it with the same shape the first submit got.
        assessment = turn.get("assessment") or {}
        return {
            "turn": turn_number,
            "answer_type": assessment.get("answer_type", "no_answer"),
            "graded": bool(assessment.get("scores")),
            "grading_source": assessment.get("source", ""),
            "grading_error": assessment.get("error", ""),
            "reaction": assessment.get("reaction") or {"line": "", "emotion": "neutral"},
            "followup_queued": bool(interview["cursor"].get("pending_followup")),
            "metrics": turn.get("metrics") or {},
            "progress": _progress(interview),
        }

    metrics = evaluation.answer_metrics(answer, seconds, mode)
    turn.update({
        "answer": (answer or "").strip(),
        "answer_seconds": round(float(seconds or 0), 1),
        "answered_at": storage.now_iso(),
        "mode": mode or "voice",
        "metrics": metrics,
    })

    words = metrics["words"]
    if declined or words < 3:
        cursor = interview["cursor"]
        cursor["declines"] = int(cursor.get("declines") or 0) + 1
        pool = _SILENCE_ACKS if words < 1 else _DECLINE_ACKS
        turn["assessment"] = _nonanswer(
            "declined" if declined else "brief",
            pool[(cursor["declines"] - 1) % len(pool)],
        )
        # Change the subject rather than asking the same thing twice over.
        _rotate_plan_away(interview, turn["category"])
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


# --------------------------------------------------------- what was said, really
_REPEAT_ACKS = (
    "Of course.",
    "No problem, here it is again.",
    "Sure, let me say that again.",
)
# After this many repeats of one question, the interviewer says out loud that
# moving on is allowed. Asking again is never refused - that would be hostile -
# but a candidate stuck on a question should be told they can leave it.
_REPEATS_BEFORE_OFFERING_TO_MOVE_ON = 3


def _note_interjection(turn: dict, kind: str, text: str) -> None:
    """Something said at this question that was not an answer to it."""
    turn.setdefault("interjections", []).append({
        "kind": kind, "text": (text or "").strip()[:400], "at": storage.now_iso(),
    })


def _repeat_envelope(interview: dict, turn: dict, lead: str, tail: str = "") -> dict:
    """The same question again. The turn is not consumed and nothing is graded."""
    return {
        "action": "repeat",
        "turn": turn["turn"],
        "question": turn["question"],
        "speech": " ".join(p for p in (lead, turn["question"], tail) if p),
        "emotion": "friendly",
        "progress": _progress(interview),
    }


def mark_ended(interview: dict, reason: str, by: str = "candidate") -> dict:
    """Stop the conversation. Writing the report is a separate, slower step.

    Deliberately not the same thing as finalize(): the candidate has just asked
    to leave and should not be held on the page for an AI evaluation. The record
    is closed here, and whoever is driving calls /finish afterwards.
    """
    cursor = interview["cursor"]
    cursor["awaiting_end_confirm"] = False
    cursor["pending_followup"] = None
    cursor["closed"] = True
    interview["ended_early"] = True
    interview["end_reason"] = (reason or "").strip()
    interview["ended_by"] = by
    interview["ended_at"] = storage.now_iso()
    log_event(interview, "ended_early", reason, by=by)

    answered = any(_is_answered(t) for t in interview["turns"])
    if not answered:
        # Nothing was said that could be reviewed. Calling that "completed" would
        # put an empty report in front of a recruiter as though it meant something.
        interview["status"] = STATUS_ABANDONED
        interview["abandoned_at"] = storage.now_iso()
        interview["abandon_reason"] = reason
        interview["progress"] = {"stage": "Ended", "detail": reason}
    storage.save_interview(interview)
    return {"status": interview["status"], "evaluate": answered}


def _ended_envelope(interview: dict, reason: str, by: str = "candidate",
                    speech: str = "") -> dict:
    outcome = mark_ended(interview, reason, by)
    return {
        "action": "ended",
        "speech": speech or (
            "Understood - I will stop the interview here. Thank you for your time "
            "today, and the team will be in touch."
        ),
        "emotion": "friendly",
        "status": outcome["status"],
        "evaluate": outcome["evaluate"],
        "progress": _progress(interview),
    }


async def submit_utterance(interview: dict, turn_number: int, text: str,
                           seconds: float, mode: str) -> dict:
    """One thing the candidate said, whatever it turns out to have been.

    The client posts every utterance here; this decides whether it was an answer,
    a request for the question again, a decline, or a request to stop - and only
    answers reach the grader. Anything that is not an answer leaves the turn open,
    so nothing is recorded as answered that was not.
    """
    turn = next((t for t in interview["turns"] if t["turn"] == turn_number), None)
    if turn is None:
        raise KeyError(f"turn {turn_number} was never asked")

    cursor = interview["cursor"]
    confirming = bool(cursor.get("awaiting_end_confirm"))
    read = intent.classify(text, confirming=confirming)
    kind = read["intent"]

    if confirming:
        if kind == intent.YES:
            _note_interjection(turn, "end_confirmed", text)
            return _ended_envelope(
                interview, "The candidate asked to end the interview.", "candidate")
        # Anything that is not a clear yes is read as "carry on". Ending is the
        # irreversible direction, so ambiguity resolves the other way.
        cursor["awaiting_end_confirm"] = False
        _note_interjection(turn, "end_cancelled", text)
        log_event(interview, "end_cancelled", text[:200])
        storage.save_interview(interview)
        return _repeat_envelope(
            interview, turn, "No problem, we will carry on where we were.")

    if kind == intent.END:
        cursor["awaiting_end_confirm"] = True
        _note_interjection(turn, "end_requested", text)
        log_event(interview, "end_requested", text[:200], matched=read["matched"])
        storage.save_interview(interview)
        return {
            "action": "confirm_end",
            "turn": turn_number,
            "speech": ("Of course - let me just check before I stop. Would you like "
                       "to end the interview now? Say yes to end it, or no to carry on."),
            "emotion": "neutral",
            "progress": _progress(interview),
        }

    if kind == intent.REPEAT:
        repeats = int(turn.get("repeats") or 0) + 1
        turn["repeats"] = repeats
        _note_interjection(turn, "repeat", text)
        log_event(interview, "repeat_requested", text[:200], turn=turn_number)
        storage.save_interview(interview)
        tail = ("" if repeats < _REPEATS_BEFORE_OFFERING_TO_MOVE_ON else
                "If you would rather leave this one, just say so and we will move on.")
        return _repeat_envelope(
            interview, turn, _REPEAT_ACKS[(repeats - 1) % len(_REPEAT_ACKS)], tail)

    result = await record_answer(interview, turn_number, text, seconds, mode,
                                 declined=kind in (intent.DECLINE, intent.SILENCE))
    result["action"] = "recorded"
    result["intent"] = kind
    return result


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
    # Frozen before the status changes: elapsed_seconds() stops counting once the
    # record says completed, so reading it afterwards gives a different number.
    interview["elapsed_seconds"] = round(elapsed_seconds(interview), 1)
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
    interview["elapsed_seconds"] = round(elapsed_seconds(interview), 1)
    interview["status"] = STATUS_ABANDONED
    interview["abandoned_at"] = storage.now_iso()
    interview["abandon_reason"] = reason.strip()
    interview["progress"] = {"stage": "Abandoned", "detail": reason.strip()}
    interview["cursor"]["awaiting_end_confirm"] = False
    log_event(interview, "abandoned", reason.strip())
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
            # Whether it counted as an answer, and nothing about how good it was.
            # The full answer_type carries a judgement ("evasive"), which the
            # candidate's own page must never be able to show them.
            "declined": bool((turn.get("answer") or "").strip()) and not _is_answered(turn),
            "answer_seconds": turn.get("answer_seconds", 0),
            "asked_at": turn.get("asked_at"),
            "answered_at": turn.get("answered_at"),
        })
    plan = interview.get("plan") or {}
    return {
        "interview_id": interview["interview_id"],
        "status": interview["status"],
        "started_at": interview.get("started_at"),
        "ended_early": bool(interview.get("ended_early")),
        "awaiting_end_confirm": bool(interview["cursor"].get("awaiting_end_confirm")),
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
