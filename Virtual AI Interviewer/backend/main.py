"""FastAPI application: virtual AI interviewer.

Shortlisted candidate in -> plan written from their resume and the JD -> spoken
interview with live follow-ups -> multi-parameter evaluation of how they actually
performed -> report + Excel export.
"""
from __future__ import annotations

import asyncio
from urllib.parse import quote

import httpx
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import (ai_agent, candidates, config, dnsfix, evaluation, excel_export,
               interview as engine, storage)

app = FastAPI(title="Virtual AI Interviewer", version="1.0.0")


# ------------------------------------------------------------------ static UI
@app.middleware("http")
async def _no_cache_frontend(request: Request, call_next):
    """Never let a browser cache the UI.

    Without this you get the worst kind of stale: a cached app.js paired with
    freshly-loaded HTML, so new buttons render but their handlers are missing
    and clicks silently do nothing.
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/static/") or path == "/":
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    return response


if config.FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=config.FRONTEND_DIR), name="static")


@app.get("/")
async def index():
    page = config.FRONTEND_DIR / "index.html"
    if not page.exists():
        raise HTTPException(500, "frontend/index.html is missing")
    return FileResponse(page)


@app.get("/api/config")
async def get_config():
    return {
        "ai_configured": config.AI_CONFIGURED,
        "deployment": config.AZURE_OPENAI_DEPLOYMENT if config.AI_CONFIGURED else "",
        "interviewer": {
            "name": config.INTERVIEWER_NAME,
            "role": config.INTERVIEWER_ROLE,
            "company": config.COMPANY_NAME,
        },
        "categories": {k: {"label": v["label"], "about": v["about"]}
                       for k, v in config.CATEGORIES.items()},
        "parameters": config.PARAMETERS,
        "default_weights": config.DEFAULT_PARAMETER_WEIGHTS,
        "default_planned_count": config.PLANNED_QUESTION_COUNT,
        "default_max_followups": config.MAX_FOLLOWUPS_PER_QUESTION,
        "max_total_turns": config.MAX_TOTAL_TURNS,
        "verdict_bands": config.VERDICT_BANDS,
        "screening_available": bool(candidates.list_shortlists()),
    }


@app.get("/api/ai-check")
async def ai_check():
    """Live round-trip to the configured Azure OpenAI deployment."""
    if not config.AI_CONFIGURED:
        return {"ok": False, "detail": "Azure OpenAI values are missing from .env"}
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            data = await ai_agent._chat_json(
                client,
                "You are a connectivity probe. Reply with JSON only.",
                'Reply exactly {"status":"ok"}',
                max_tokens=200,
                retries=0,
            )
        return {"ok": True, "deployment": config.AZURE_OPENAI_DEPLOYMENT, "reply": data}
    except Exception as exc:  # noqa: BLE001
        host = config.AZURE_OPENAI_ENDPOINT.split("//")[-1].split("/")[0]
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}",
                "dns": dnsfix.diagnose(host)}


# ------------------------------------------------------- screening hand-off
@app.get("/api/shortlists")
async def get_shortlists():
    """Accepted shortlists from the screening app, if it has produced any."""
    return {
        "shortlists": candidates.list_shortlists(),
        "searched": [str(p / "history") for p in config.SCREENING_DATA_DIRS],
    }


@app.get("/api/shortlists/{history_id}")
async def get_shortlist(history_id: str):
    data = candidates.shortlist_candidates(history_id)
    if not data:
        raise HTTPException(404, "That shortlist was not found")
    return data


# ------------------------------------------------------------------ interviews
def _require(interview_id: str) -> dict:
    record = storage.load_interview(interview_id)
    if not record:
        raise HTTPException(404, "Interview not found")
    return record


@app.post("/api/interviews")
async def create_interview(payload: dict = Body(...)):
    """Start an interview, either from a shortlisted candidate or a typed one.

    Returns as soon as the record exists; the question plan is written in the
    background so the client can show progress instead of a dead spinner.
    """
    source_kind = str(payload.get("source") or "manual").strip().lower()
    options = payload.get("options") or {}
    jd_text = str(payload.get("jd_text") or "").strip()
    jd_analysis = payload.get("jd_analysis") or {}
    job_title = str(payload.get("job_title") or "").strip()

    if source_kind == "screening":
        history_id = str(payload.get("history_id") or "").strip()
        candidate_id = str(payload.get("candidate_id") or "").strip()
        if not history_id or not candidate_id:
            raise HTTPException(400, "history_id and candidate_id are required")
        row = candidates.pick_candidate(history_id, candidate_id)
        if not row:
            raise HTTPException(404, "That candidate is not in that shortlist")
        shortlist = candidates.load_shortlist(history_id) or {}
        jd_text = jd_text or shortlist.get("jd_text", "")
        jd_analysis = jd_analysis or shortlist.get("jd_analysis", {}) or {}
        job_title = job_title or shortlist.get("job_title", "")
        source = {"kind": "screening", "history_id": history_id,
                  "candidate_id": candidate_id}
    else:
        row = payload.get("candidate") or {}
        if not str(row.get("candidate_name") or "").strip():
            raise HTTPException(400, "The candidate needs a name")
        has_resume = any(str(row.get(k) or "").strip() for k in
                         ("resume_text", "skills", "projects", "experience"))
        if not has_resume:
            raise HTTPException(
                400, "Paste the resume, or at least the skills and projects - the "
                     "questions are generated from them")
        source = {"kind": "manual"}

    if not jd_text and not jd_analysis:
        raise HTTPException(400, "The job description is required")

    record = engine.create_interview(row, jd_text, jd_analysis, job_title, options, source)
    asyncio.create_task(engine.plan_interview(record["interview_id"]))
    return {"interview_id": record["interview_id"], "status": record["status"]}


@app.get("/api/interviews")
async def list_interviews():
    return storage.list_interviews()


@app.get("/api/interviews/{interview_id}")
async def get_interview(interview_id: str, full: bool = False):
    """`full=true` is the reviewer's view - it includes grades and the plan.

    The default view is safe to hold open in front of the candidate: no scores,
    no expected answers. See interview.public_view().
    """
    record = _require(interview_id)
    return record if full else engine.public_view(record)


@app.get("/api/interviews/{interview_id}/status")
async def interview_status(interview_id: str):
    record = _require(interview_id)
    plan = record.get("plan") or {}
    return {
        "interview_id": interview_id,
        "status": record["status"],
        "progress": engine.PROGRESS.get(interview_id) or record.get("progress", {}),
        "planned_total": len(plan.get("questions", [])),
        "plan_source": plan.get("source"),
        "plan_error": record.get("plan_error", ""),
    }


@app.post("/api/interviews/{interview_id}/next")
async def next_prompt(interview_id: str):
    """What the interviewer says next."""
    record = _require(interview_id)
    if record["status"] == engine.STATUS_PLANNING:
        raise HTTPException(409, "The question plan is still being written")
    if record["status"] in (engine.STATUS_COMPLETED, engine.STATUS_ABANDONED):
        raise HTTPException(409, f"This interview is {record['status']}")
    if not record.get("plan"):
        raise HTTPException(409, "This interview has no question plan")
    return engine.next_prompt(record)


@app.post("/api/interviews/{interview_id}/answer")
async def submit_answer(interview_id: str, payload: dict = Body(...)):
    """Record one answer, grade it, and decide whether to follow up."""
    record = _require(interview_id)
    if record["status"] not in (engine.STATUS_READY, engine.STATUS_IN_PROGRESS):
        raise HTTPException(409, f"This interview is {record['status']}")

    try:
        turn_number = int(payload.get("turn"))
    except (TypeError, ValueError):
        raise HTTPException(400, "turn must be a number")

    answer = str(payload.get("answer") or "")
    mode = str(payload.get("mode") or "voice").strip().lower()
    if mode not in ("voice", "typed", "skipped"):
        mode = "voice"
    try:
        seconds = float(payload.get("seconds") or 0)
    except (TypeError, ValueError):
        seconds = 0.0

    try:
        return await engine.record_answer(record, turn_number, answer, seconds, mode)
    except KeyError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/interviews/{interview_id}/finish")
async def finish_interview(interview_id: str):
    """Close the interview and produce the report."""
    record = _require(interview_id)
    if record["status"] == engine.STATUS_COMPLETED and record.get("report"):
        return {"interview_id": interview_id, "report": record["report"],
                "detail": "Already evaluated - returning the existing report."}
    if record["status"] == engine.STATUS_PLANNING:
        raise HTTPException(409, "The question plan is still being written")
    report = await engine.finalize(record)
    return {"interview_id": interview_id, "report": report}


@app.post("/api/interviews/{interview_id}/regrade")
async def regrade_interview(interview_id: str):
    """Re-run the closing review over an existing transcript.

    For when the AI was unreachable at the end of a session. Answers keep the
    grades they were given on the day; only the write-up is rebuilt.
    """
    record = _require(interview_id)
    if not record.get("turns"):
        raise HTTPException(400, "There is no transcript to review")
    report = await engine.regrade(record)
    return {"interview_id": interview_id, "report": report}


@app.post("/api/interviews/{interview_id}/abandon")
async def abandon_interview(interview_id: str, payload: dict = Body(default={})):
    record = _require(interview_id)
    if record["status"] == engine.STATUS_COMPLETED:
        raise HTTPException(409, "This interview is already completed")
    engine.abandon(record, str(payload.get("reason") or ""))
    return {"ok": True, "status": record["status"]}


@app.get("/api/interviews/{interview_id}/report")
async def get_report(interview_id: str):
    record = _require(interview_id)
    if not record.get("report"):
        raise HTTPException(404, "This interview has not been evaluated yet")
    return {
        "interview_id": interview_id,
        "candidate": record.get("candidate", {}),
        "job_title": record.get("job_title"),
        "interviewer": record.get("interviewer", {}),
        "started_at": record.get("started_at"),
        "completed_at": record.get("completed_at"),
        "report": record["report"],
        "turns": record.get("turns", []),
        "plan": record.get("plan", {}),
        "plan_error": record.get("plan_error", ""),
    }


@app.put("/api/interviews/{interview_id}/review")
async def save_review(interview_id: str, payload: dict = Body(...)):
    """The human reviewer's own verdict on top of the AI report.

    The AI never gets the last word: this is where a person agrees, overrides or
    annotates it, and the override is stored beside the AI's figure rather than
    replacing it.
    """
    record = _require(interview_id)
    if not record.get("report"):
        raise HTTPException(409, "This interview has not been evaluated yet")

    decision = str(payload.get("decision") or "").strip().upper()
    allowed = ("", "PROCEED", "HOLD", "REJECT")
    if decision not in allowed:
        raise HTTPException(400, f"decision must be one of {allowed[1:]}")

    override = payload.get("override_score")
    if override not in (None, ""):
        try:
            override = max(0.0, min(100.0, float(override)))
        except (TypeError, ValueError):
            raise HTTPException(400, "override_score must be a number between 0 and 100")
    else:
        override = None

    record["human_review"] = {
        "decision": decision,
        "reviewer": str(payload.get("reviewer") or "NA").strip() or "NA",
        "notes": str(payload.get("notes") or "").strip(),
        "override_score": override,
        "override_verdict": evaluation.verdict_for(override) if override is not None else None,
        "reviewed_at": storage.now_iso(),
    }
    storage.save_interview(record)
    return {"ok": True, "human_review": record["human_review"]}


@app.delete("/api/interviews/{interview_id}")
async def delete_interview(interview_id: str):
    if not storage.delete_interview(interview_id):
        raise HTTPException(404, "Interview not found")
    engine.PROGRESS.pop(interview_id, None)
    return {"ok": True}


# --------------------------------------------------------------------- export
def _slug(value: str) -> str:
    import re
    value = re.sub(r"[^A-Za-z0-9]+", "-", value or "").strip("-")
    return (value[:40] or "interview").lower()


@app.get("/api/interviews/{interview_id}/export")
async def export_interview(interview_id: str):
    record = _require(interview_id)
    if not record.get("report"):
        raise HTTPException(409, "Evaluate the interview before exporting it")
    data = excel_export.build_workbook(record)
    name = record.get("candidate", {}).get("candidate_name", "candidate")
    filename = f"interview-{_slug(name)}-{interview_id}.xlsx"
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@app.exception_handler(Exception)
async def unhandled(_request, exc: Exception):
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})
