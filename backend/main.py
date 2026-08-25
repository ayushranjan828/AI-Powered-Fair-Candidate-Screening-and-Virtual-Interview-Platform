"""FastAPI application: bulk resume intake -> AI screening -> human review -> history."""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import ai_agent, config, dnsfix, excel_export, scoring, storage
from .extractors import SUPPORTED_DOC_EXTS, extract_upload

app = FastAPI(title="AI-Powered Fair Candidate Screening", version="1.0.0")

# session_id -> live progress (mirrors what is flushed to disk)
PROGRESS: dict[str, dict] = {}


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
        "default_threshold": config.SHORTLIST_THRESHOLD,
        "default_weights": config.DEFAULT_WEIGHTS,
        "default_cutoffs": config.DEFAULT_CRITERIA_CUTOFFS,
        "criteria": config.CRITERIA,
        "supported_types": sorted(SUPPORTED_DOC_EXTS | {".zip"}),
        "email_send_mode": config.EMAIL_SEND_MODE,
        "company": config.COMPANY_NAME,
        "recruiter_name": config.RECRUITER_NAME,
        "recruiter_email": config.RECRUITER_EMAIL,
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


# --------------------------------------------------------------- screening job
def _slug(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9]+", "-", value or "").strip("-")
    return (value[:40] or "shortlist").lower()


def _stats(candidates: list[dict], failed: int) -> dict:
    return {
        "total": len(candidates),
        "parsed": sum(1 for c in candidates if c.get("status") != "PARSE_FAILED"),
        "failed": failed,
        "shortlisted": sum(1 for c in candidates if c.get("status") == "SHORTLISTED"),
        "review": sum(1 for c in candidates if c.get("status") == "REVIEW"),
        "not_shortlisted": sum(1 for c in candidates if c.get("status") == "NOT_SHORTLISTED"),
    }


async def _run_screening(session_id: str, resumes: list[dict], jd_text: str,
                         weights: dict, cutoffs: dict, threshold: float) -> None:
    """Background pipeline: analyse the JD once, then every resume concurrently."""
    session = storage.load_session(session_id) or {}
    progress = PROGRESS.setdefault(session_id, {})
    progress.update({"stage": "Analysing job description", "processed": 0,
                     "total": len(resumes), "errors": 0})

    limits = httpx.Limits(max_connections=config.MAX_CONCURRENT_AI_CALLS + 4)
    timeout = httpx.Timeout(config.REQUEST_TIMEOUT_SECONDS)

    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        rubric: dict = {}
        jd_error = ""
        try:
            rubric = await ai_agent.analyze_jd(client, jd_text)
        except Exception as exc:  # noqa: BLE001
            jd_error = str(exc)
            rubric = {"role_title": session.get("job_title", "NA"), "summary": "NA",
                      "must_have_skills": [], "good_to_have_skills": [],
                      "equivalent_skills": {}, "expected_project_types": [],
                      "preferred_certifications": [], "min_experience_years": 0,
                      "required_education": "NA"}

        session["jd_analysis"] = rubric
        session["jd_error"] = jd_error
        if session.get("job_title") in (None, "", "NA") and rubric.get("role_title"):
            session["job_title"] = rubric["role_title"]
        storage.save_session(session)

        progress["stage"] = "Evaluating resumes"
        semaphore = asyncio.Semaphore(config.MAX_CONCURRENT_AI_CALLS)
        results: list[dict | None] = [None] * len(resumes)
        errors = 0
        lock = asyncio.Lock()

        async def worker(index: int, item: dict) -> None:
            nonlocal errors
            cid = f"CID-{session_id.split('-')[-1][:6]}-{index + 1:04d}"

            if item.get("error") and not item.get("text"):
                row = scoring.build_candidate(cid, item["file_name"], {}, weights, cutoffs,
                                              threshold, extraction_error=item["error"])
                row["status"] = "PARSE_FAILED"
                row["decision_reason"] = f"Resume could not be read: {item['error']}"
                results[index] = row
                async with lock:
                    errors += 1
                    progress["processed"] += 1
                    progress["errors"] = errors
                return

            async with semaphore:
                try:
                    analysis = await ai_agent.evaluate_resume(client, item["text"], rubric)
                    note = ""
                except Exception as exc:  # noqa: BLE001
                    analysis = ai_agent.fallback_parse(item["text"], item["file_name"])
                    note = f"AI evaluation failed: {exc}"

            row = scoring.build_candidate(cid, item["file_name"], analysis, weights,
                                          cutoffs, threshold, extraction_error=note)
            if note:
                row["status"] = "REVIEW"
                row["decision_reason"] = note
            row["resume_preview"] = (item.get("text") or "")[:1200]
            results[index] = row
            async with lock:
                progress["processed"] += 1
                if note:
                    errors += 1
                    progress["errors"] = errors

        tasks = [asyncio.create_task(worker(i, item)) for i, item in enumerate(resumes)]
        pending = set(tasks)
        while pending:
            _done, pending = await asyncio.wait(pending, timeout=4)
            session["candidates"] = [r for r in results if r]
            session["stats"] = _stats(session["candidates"], errors)
            session["progress"] = dict(progress)
            storage.save_session(session)

    candidates = [r for r in results if r]
    candidates.sort(key=lambda c: (-float(c.get("ats_score") or 0), c.get("candidate_name", "")))
    session["candidates"] = candidates
    session["stats"] = _stats(candidates, errors)
    session["status"] = "completed"
    progress.update({"stage": "Completed", "processed": len(resumes)})
    session["progress"] = dict(progress)
    storage.save_session(session)


@app.post("/api/screen")
async def start_screening(
    files: list[UploadFile] = File(default=[]),
    jd_text: str = Form(...),
    job_title: str = Form(default=""),
    threshold: float = Form(default=config.SHORTLIST_THRESHOLD),
    weights: str = Form(default=""),
    cutoffs: str = Form(default=""),
    paths: str = Form(default=""),
):
    if not jd_text.strip():
        raise HTTPException(400, "Job description is required")
    if not files:
        raise HTTPException(400, "Upload at least one resume, folder or ZIP")

    try:
        weight_map = scoring.normalize_weights(json.loads(weights) if weights.strip() else None)
        cutoff_map = scoring.normalize_cutoffs(json.loads(cutoffs) if cutoffs.strip() else None)
    except json.JSONDecodeError:
        raise HTTPException(400, "weights/cutoffs must be valid JSON")

    try:
        rel_paths = json.loads(paths) if paths.strip() else []
    except json.JSONDecodeError:
        rel_paths = []

    # Read + extract before responding so the client learns about unreadable files early.
    resumes: list[dict] = []
    for idx, upload in enumerate(files):
        raw = await upload.read()
        name = (rel_paths[idx] if idx < len(rel_paths) and rel_paths[idx] else upload.filename) or f"file-{idx}"
        for extracted in extract_upload(name, raw):
            resumes.append({"file_name": extracted.file_name, "text": extracted.text,
                            "error": extracted.error})

    if not resumes:
        raise HTTPException(400, "No supported resume files were found in the upload")

    session_id = storage.new_id("SES")
    session = {
        "session_id": session_id,
        "job_title": job_title.strip() or "NA",
        "jd_text": jd_text.strip(),
        "threshold": float(threshold),
        "weights": weight_map,
        "cutoffs": cutoff_map,
        "created_at": storage.now_iso(),
        "status": "processing",
        "candidates": [],
        "stats": {"total": len(resumes), "parsed": 0, "failed": 0, "shortlisted": 0},
        "progress": {"stage": "Queued", "processed": 0, "total": len(resumes), "errors": 0},
        "accepted_history_id": None,
    }
    storage.save_session(session)
    PROGRESS[session_id] = dict(session["progress"])

    asyncio.create_task(
        _run_screening(session_id, resumes, jd_text.strip(), weight_map, cutoff_map, float(threshold))
    )
    return {"session_id": session_id, "total_resumes": len(resumes), "status": "processing"}


# ------------------------------------------------------------------- sessions
@app.get("/api/sessions")
async def get_sessions():
    return storage.list_sessions()


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    session = storage.load_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return session


@app.get("/api/sessions/{session_id}/progress")
async def get_progress(session_id: str):
    session = storage.load_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return {
        "session_id": session_id,
        "status": session.get("status"),
        "progress": PROGRESS.get(session_id) or session.get("progress", {}),
        "stats": session.get("stats", {}),
    }


@app.put("/api/sessions/{session_id}/candidates")
async def update_candidates(session_id: str, payload: dict = Body(...)):
    """Persist the reviewer's edits: added rows, edited cells, deleted rows."""
    session = storage.load_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    if session.get("accepted_history_id"):
        raise HTTPException(409, "This shortlist was already accepted and is locked")

    incoming = payload.get("candidates")
    if not isinstance(incoming, list):
        raise HTTPException(400, "candidates must be a list")

    existing = {c["candidate_id"]: c for c in session.get("candidates", [])}
    merged: list[dict] = []
    seen: set[str] = set()
    for row in incoming:
        if not isinstance(row, dict):
            continue
        cid = str(row.get("candidate_id") or "").strip() or storage.new_id("CID")
        while cid in seen:
            cid = storage.new_id("CID")
        base = dict(existing.get(cid) or scoring.blank_candidate(cid))
        for key, value in row.items():
            if key in ("candidate_id",):
                continue
            base[key] = value
        base["candidate_id"] = cid
        if cid in existing and base != existing[cid]:
            base["edited"] = True
        for field in ("candidate_name", "phone_number", "email_id", "skills",
                      "certification", "experience"):
            if not str(base.get(field, "")).strip():
                base[field] = "NA"
        merged.append(base)
        seen.add(cid)

    session["candidates"] = merged
    session["stats"] = _stats(merged, session.get("stats", {}).get("failed", 0))
    session["reviewed"] = True
    storage.save_session(session)
    return {"ok": True, "count": len(merged), "stats": session["stats"]}


@app.post("/api/sessions/{session_id}/blank-row")
async def blank_row(session_id: str):
    if not storage.load_session(session_id):
        raise HTTPException(404, "Session not found")
    return scoring.blank_candidate(storage.new_id("CID"))


@app.delete("/api/sessions/{session_id}")
async def remove_session(session_id: str):
    if not storage.delete_session(session_id):
        raise HTTPException(404, "Session not found")
    PROGRESS.pop(session_id, None)
    return {"ok": True}


# -------------------------------------------------------------------- history
@app.post("/api/sessions/{session_id}/accept")
async def accept_shortlist(session_id: str, payload: dict = Body(default={})):
    """Human verification gate: freeze the reviewed sheet into a history record."""
    session = storage.load_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    if session.get("status") != "completed":
        raise HTTPException(409, "Screening is still running")

    candidates: list[dict] = session.get("candidates", [])
    if payload.get("only_shortlisted", True):
        candidates = [c for c in candidates if c.get("status") in ("SHORTLISTED", "REVIEW")]
    if not candidates:
        raise HTTPException(400, "There are no candidates to save")

    history_id = storage.new_id("HIS")
    record = {
        "history_id": history_id,
        "session_id": session_id,
        "job_title": session.get("job_title", "NA"),
        "jd_text": session.get("jd_text", ""),
        "jd_analysis": session.get("jd_analysis", {}),
        "threshold": session.get("threshold"),
        "weights": session.get("weights"),
        "cutoffs": session.get("cutoffs"),
        "stats": session.get("stats", {}),
        "candidates": candidates,
        "accepted_at": storage.now_iso(),
        "accepted_by": str(payload.get("accepted_by") or "NA").strip() or "NA",
        "notes": str(payload.get("notes") or "").strip(),
    }
    storage.save_history(record)
    session["accepted_history_id"] = history_id
    session["status"] = "accepted"
    storage.save_session(session)
    return {"history_id": history_id, "count": len(candidates)}


@app.get("/api/history")
async def get_history_list():
    return storage.list_history()


@app.get("/api/history/{history_id}")
async def get_history(history_id: str):
    record = storage.load_history(history_id)
    if not record:
        raise HTTPException(404, "History record not found")
    return record


@app.delete("/api/history/{history_id}")
async def remove_history(history_id: str):
    if not storage.delete_history(history_id):
        raise HTTPException(404, "History record not found")
    return {"ok": True}


# ------------------------------------------------------------------- outreach
#
# NOTHING IN THIS SECTION SENDS EMAIL.
#
# There is no SMTP client, no mail provider SDK and no outbound mail call
# anywhere in this codebase. "Sending" records the draft as SENT locally.
# The recruiter is shown the same thing in the UI.
#
# EXTENSION POINT - interview scheduling
# The invitation deliberately does not promise a mechanism or a link, because
# no interview stage exists yet. When you plug in your own AI interviewer:
#   1. give each sent draft whatever handle your interviewer needs, in
#      send_outreach() where the SENT fields are written;
#   2. add that handle to the mail body - ai_agent.INVITE_SYSTEM tells the
#      model what it may and may not promise the candidate;
#   3. surface the results wherever you want them reviewed.
# Wiring a real mail transport is a separate change again - see README.

INVITE_ELIGIBLE = ("SHORTLISTED", "REVIEW")


def _outreach_ctx(session: dict) -> dict:
    return {
        "job_title": session.get("job_title", "NA"),
        "company": config.COMPANY_NAME,
        "recruiter_name": config.RECRUITER_NAME,
        "recruiter_email": config.RECRUITER_EMAIL,
    }


def _require_open_session(session_id: str) -> dict:
    session = storage.load_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return session


def _eligible_candidates(session: dict, candidate_ids: list[str] | None) -> list[dict]:
    rows = session.get("candidates", [])
    if candidate_ids:
        wanted = set(candidate_ids)
        picked = [c for c in rows if c.get("candidate_id") in wanted]
    else:
        picked = [c for c in rows if c.get("status") in INVITE_ELIGIBLE]
    return picked


@app.get("/api/sessions/{session_id}/outreach")
async def get_outreach(session_id: str):
    session = _require_open_session(session_id)
    drafts = session.get("outreach", {})
    eligible = _eligible_candidates(session, None)
    return {
        "session_id": session_id,
        "job_title": session.get("job_title", "NA"),
        "send_mode": config.EMAIL_SEND_MODE,
        "company": config.COMPANY_NAME,
        "recruiter_name": config.RECRUITER_NAME,
        "recruiter_email": config.RECRUITER_EMAIL,
        "eligible": [
            {"candidate_id": c.get("candidate_id"),
             "candidate_name": c.get("candidate_name", "NA"),
             "email_id": c.get("email_id", "NA"),
             "status": c.get("status"),
             "ats_score": c.get("ats_score")}
            for c in eligible
        ],
        "drafts": list(drafts.values()),
    }


@app.post("/api/sessions/{session_id}/outreach/draft")
async def draft_outreach(session_id: str, payload: dict = Body(default={})):
    """Ask the agent to draft an invitation for each selected candidate.

    Existing drafts are left alone unless regenerate is true, so a recruiter
    never loses edits by clicking the button twice. A SENT draft is never
    overwritten.
    """
    session = _require_open_session(session_id)
    if session.get("status") not in ("completed", "accepted"):
        raise HTTPException(409, "Screening is still running")

    candidate_ids = payload.get("candidate_ids")
    if candidate_ids is not None and not isinstance(candidate_ids, list):
        raise HTTPException(400, "candidate_ids must be a list")
    regenerate = bool(payload.get("regenerate"))

    targets = _eligible_candidates(session, candidate_ids)
    if not targets:
        raise HTTPException(400, "No eligible candidates to draft for")

    drafts: dict = dict(session.get("outreach", {}))
    rubric = session.get("jd_analysis", {}) or {}
    ctx = _outreach_ctx(session)

    todo = []
    for cand in targets:
        cid = cand.get("candidate_id")
        existing = drafts.get(cid)
        if existing and existing.get("status") == "SENT":
            continue
        if existing and not regenerate:
            continue
        todo.append(cand)

    if not todo:
        return {"ok": True, "drafted": 0, "skipped": len(targets),
                "drafts": list(drafts.values()),
                "detail": "Nothing to draft - existing drafts kept. "
                          "Use regenerate to overwrite them."}

    semaphore = asyncio.Semaphore(config.MAX_CONCURRENT_AI_CALLS)
    failures = 0
    lock = asyncio.Lock()

    async def one(client: httpx.AsyncClient, cand: dict) -> None:
        nonlocal failures
        cid = cand.get("candidate_id")
        async with semaphore:
            try:
                drafted = await ai_agent.draft_interview_email(client, cand, rubric, ctx)
                source, note = "ai", ""
            except Exception as exc:  # noqa: BLE001
                drafted = ai_agent.fallback_email(cand, rubric, ctx)
                source, note = "fallback", f"AI draft failed: {exc}"
                async with lock:
                    failures += 1

        email = str(cand.get("email_id") or "NA").strip() or "NA"
        drafts[cid] = {
            "candidate_id": cid,
            "candidate_name": cand.get("candidate_name", "NA"),
            "email_id": email,
            "has_email": email != "NA" and "@" in email,
            "status": "DRAFT",
            "subject": drafted["subject"],
            "body": drafted["body"],
            "tone_note": drafted.get("tone_note", ""),
            "draft_source": source,
            "draft_error": note,
            "drafted_at": storage.now_iso(),
            "edited": False,
            "edited_at": None,
            "sent_at": None,
            "send_mode": config.EMAIL_SEND_MODE,
        }

    timeout = httpx.Timeout(config.REQUEST_TIMEOUT_SECONDS)
    limits = httpx.Limits(max_connections=config.MAX_CONCURRENT_AI_CALLS + 4)
    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        await asyncio.gather(*(one(client, c) for c in todo))

    session["outreach"] = drafts
    storage.save_session(session)
    return {"ok": True, "drafted": len(todo), "failures": failures,
            "skipped": len(targets) - len(todo), "drafts": list(drafts.values())}


@app.put("/api/sessions/{session_id}/outreach/{candidate_id}")
async def edit_draft(session_id: str, candidate_id: str, payload: dict = Body(...)):
    """The recruiter's edits to the drafted mail, before they approve it."""
    session = _require_open_session(session_id)
    drafts = dict(session.get("outreach", {}))
    draft = drafts.get(candidate_id)
    if not draft:
        raise HTTPException(404, "No draft for that candidate")
    if draft.get("status") == "SENT":
        raise HTTPException(409, "This invitation was already sent and is locked")

    subject = str(payload.get("subject", draft["subject"])).strip()
    body = str(payload.get("body", draft["body"]))
    if not subject:
        raise HTTPException(400, "Subject cannot be empty")
    if not body.strip():
        raise HTTPException(400, "Body cannot be empty")

    email = str(payload.get("email_id", draft.get("email_id", "NA"))).strip() or "NA"
    draft.update({
        "subject": subject,
        "body": body,
        "email_id": email,
        "has_email": email != "NA" and "@" in email,
        "edited": True,
        "edited_at": storage.now_iso(),
    })
    drafts[candidate_id] = draft
    session["outreach"] = drafts
    storage.save_session(session)
    return {"ok": True, "draft": draft}


@app.post("/api/sessions/{session_id}/outreach/send")
async def send_outreach(session_id: str, payload: dict = Body(default={})):
    """Recruiter approval step. SIMULATED - see the banner at the top of this section.

    Marks each selected draft SENT and freezes the exact text that would have
    gone out. See the extension point above for where interview handles attach.
    """
    session = _require_open_session(session_id)
    drafts = dict(session.get("outreach", {}))
    if not drafts:
        raise HTTPException(400, "There are no drafts to send")

    ids = payload.get("candidate_ids")
    if ids is not None and not isinstance(ids, list):
        raise HTTPException(400, "candidate_ids must be a list")
    targets = [d for d in drafts.values()
               if (ids is None or d["candidate_id"] in set(ids)) and d.get("status") != "SENT"]
    if not targets:
        raise HTTPException(400, "Nothing to send - those drafts are already marked sent")

    sent, skipped = [], []

    for draft in targets:
        cid = draft["candidate_id"]
        if not draft.get("has_email"):
            skipped.append({"candidate_id": cid,
                            "candidate_name": draft.get("candidate_name", "NA"),
                            "reason": "No email address on the row - fill it in on the "
                                      "Review tab first."})
            continue

        draft.update({
            "status": "SENT",
            "sent_at": storage.now_iso(),
            "send_mode": config.EMAIL_SEND_MODE,
            # Freeze the exact text that would have gone out, so a later edit to
            # the draft can never rewrite history.
            "sent_subject": draft["subject"],
            "sent_body": draft["body"],
        })
        drafts[cid] = draft
        sent.append({"candidate_id": cid,
                     "candidate_name": draft.get("candidate_name", "NA"),
                     "email_id": draft.get("email_id")})

    session["outreach"] = drafts
    storage.save_session(session)
    return {
        "ok": True,
        "simulated": True,
        "send_mode": config.EMAIL_SEND_MODE,
        "notice": "Simulated send. No email was transmitted - the drafts are "
                  "marked SENT locally.",
        "sent": sent,
        "sent_count": len(sent),
        "skipped": skipped,
        "drafts": list(drafts.values()),
    }


# --------------------------------------------------------------------- export
def _xlsx_response(record: dict, name: str) -> Response:
    data = excel_export.build_workbook(record)
    filename = f"{_slug(name)}.xlsx"
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@app.get("/api/sessions/{session_id}/export")
async def export_session(session_id: str, only_shortlisted: bool = False):
    session = storage.load_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    record: dict[str, Any] = dict(session)
    if only_shortlisted:
        record["candidates"] = [c for c in record.get("candidates", [])
                                if c.get("status") in ("SHORTLISTED", "REVIEW")]
    return _xlsx_response(record, f"{session.get('job_title', 'shortlist')}-{session_id}")


@app.get("/api/history/{history_id}/export")
async def export_history(history_id: str):
    record = storage.load_history(history_id)
    if not record:
        raise HTTPException(404, "History record not found")
    return _xlsx_response(record, f"{record.get('job_title', 'shortlist')}-{history_id}")


@app.exception_handler(Exception)
async def unhandled(_request, exc: Exception):
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})
