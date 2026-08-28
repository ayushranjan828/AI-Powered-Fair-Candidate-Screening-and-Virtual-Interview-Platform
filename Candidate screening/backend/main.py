"""FastAPI application: bulk resume intake -> AI screening -> human review -> history."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import ai_agent, config, dnsfix, excel_export, interview_link, scoring, storage
from .extractors import SUPPORTED_DOC_EXTS, extract_upload

logger = logging.getLogger("screening")

app = FastAPI(title="AI-Powered Fair Candidate Screening", version="1.0.0")

# session_id -> live progress (mirrors what is flushed to disk)
PROGRESS: dict[str, dict] = {}

# Strong references to background screening tasks. asyncio only keeps a weak
# reference to tasks, so a fire-and-forget task can be garbage-collected mid-run.
_TASKS: set[asyncio.Task] = set()

# The statuses a reviewer may set on a row. Anything else would silently break
# the stats, the filters and the accept gate.
ROW_STATUSES = {"SHORTLISTED", "REVIEW", "NOT_SHORTLISTED", "PARSE_FAILED"}

_EMAIL_OK = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _valid_email(value) -> bool:
    return bool(_EMAIL_OK.match(str(value or "").strip()))


@app.on_event("startup")
async def _repair_stale_sessions() -> None:
    """A restart mid-run used to leave sessions stuck in "processing" forever,
    blocking accept and outreach with 409s while the UI polled indefinitely.
    Mark them failed (keeping any partial results) so they can move on."""
    for meta in storage.list_sessions(limit=1000):
        if meta.get("status") != "processing":
            continue
        session = storage.load_session(meta.get("session_id") or "")
        if not session:
            continue
        session["status"] = "failed"
        session["error"] = ("The server restarted while this screening was running. "
                            "Partial results were kept.")
        session["progress"] = {**session.get("progress", {}),
                               "stage": "Failed - server restarted mid-run"}
        storage.save_session(session)
        logger.warning("Marked stale session %s as failed", session.get("session_id"))


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


@app.middleware("http")
async def _access_guard(request: Request, call_next):
    """Optional shared-token gate for the API.

    Off unless APP_ACCESS_TOKEN is set in .env. The static UI stays reachable so
    the browser can load the page that then prompts for the token; every /api/*
    call must carry it. Query-param form exists for the Excel download links,
    which cannot set headers.
    """
    token = config.APP_ACCESS_TOKEN
    if token and request.url.path.startswith("/api/"):
        supplied = (request.headers.get("x-access-token")
                    or request.query_params.get("token") or "")
        if not hmac.compare_digest(supplied, token):
            return JSONResponse(status_code=401,
                                content={"detail": "Missing or wrong access token"})
    return await call_next(request)


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
    """Crash-safe wrapper: an unexpected error marks the session failed instead
    of silently dying and leaving it stuck in "processing" forever."""
    try:
        await _screen_pipeline(session_id, resumes, jd_text, weights, cutoffs, threshold)
    except Exception as exc:  # noqa: BLE001 - anything here would otherwise vanish
        logger.exception("Screening %s failed", session_id)
        session = storage.load_session(session_id) or {"session_id": session_id}
        session["status"] = "failed"
        session["error"] = f"{type(exc).__name__}: {exc}"
        session["progress"] = {**PROGRESS.get(session_id, {}),
                               "stage": f"Failed: {type(exc).__name__}"}
        storage.save_session(session)
    finally:
        # The final state is on disk now; dropping the mirror keeps PROGRESS
        # from growing forever (it used to leak one entry per session).
        PROGRESS.pop(session_id, None)


async def _screen_pipeline(session_id: str, resumes: list[dict], jd_text: str,
                           weights: dict, cutoffs: dict, threshold: float) -> None:
    """Background pipeline: analyse the JD once, then every resume concurrently."""
    session = storage.load_session(session_id) or {}
    progress = PROGRESS.setdefault(session_id, {})
    progress.update({"stage": "Analysing job description", "processed": 0,
                     "total": len(resumes), "errors": 0, "status": "processing"})

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
    progress.update({"stage": "Completed", "processed": len(resumes), "status": "completed",
                     "stats": session["stats"]})
    session["progress"] = {k: v for k, v in progress.items() if k != "stats"}
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
    if len(files) > config.MAX_UPLOAD_FILES:
        raise HTTPException(413, f"Too many files - the limit is {config.MAX_UPLOAD_FILES} per batch")

    try:
        weight_map = scoring.normalize_weights(json.loads(weights) if weights.strip() else None)
        cutoff_map = scoring.normalize_cutoffs(json.loads(cutoffs) if cutoffs.strip() else None)
    except json.JSONDecodeError:
        raise HTTPException(400, "weights/cutoffs must be valid JSON")
    threshold = max(0.0, min(100.0, float(threshold)))

    try:
        rel_paths = json.loads(paths) if paths.strip() else []
    except json.JSONDecodeError:
        rel_paths = []

    # Read the uploads (bounded), then extract in a worker thread: pypdf/XML
    # parsing is CPU work that would otherwise block the event loop - and with
    # it every progress poll - for the whole batch.
    file_cap = int(config.MAX_FILE_MB * 1048576)
    total_cap = int(config.MAX_TOTAL_UPLOAD_MB * 1048576)
    total_bytes = 0
    items: list[tuple[str, bytes | None]] = []
    for idx, upload in enumerate(files):
        raw = await upload.read()
        name = (rel_paths[idx] if idx < len(rel_paths) and rel_paths[idx] else upload.filename) or f"file-{idx}"
        if len(raw) > file_cap:
            items.append((name, None))  # oversize -> error row, not a dead batch
            continue
        total_bytes += len(raw)
        if total_bytes > total_cap:
            raise HTTPException(413, f"Upload exceeds the {config.MAX_TOTAL_UPLOAD_MB:g} MB total limit")
        items.append((name, raw))

    def _extract_all() -> list[dict]:
        out: list[dict] = []
        for name, raw in items:
            if raw is None:
                out.append({"file_name": name, "text": "",
                            "error": f"File exceeds the {config.MAX_FILE_MB:g} MB per-file limit"})
                continue
            for extracted in extract_upload(name, raw):
                out.append({"file_name": extracted.file_name, "text": extracted.text,
                            "error": extracted.error})
        return out

    resumes = await asyncio.to_thread(_extract_all)

    if not resumes:
        raise HTTPException(400, "No supported resume files were found in the upload")

    # Identical resume text screens (and bills) once: bulk uploads routinely
    # contain the same file twice under different names.
    seen_hash: dict[str, str] = {}
    unique: list[dict] = []
    duplicates: list[dict] = []
    for item in resumes:
        text = (item.get("text") or "").strip()
        if text and not item.get("error"):
            digest = hashlib.sha256(text.encode("utf-8", "ignore")).hexdigest()
            if digest in seen_hash:
                duplicates.append({"file_name": item["file_name"],
                                   "duplicate_of": seen_hash[digest]})
                continue
            seen_hash[digest] = item["file_name"]
        unique.append(item)
    resumes = unique

    session_id = storage.new_id("SES")
    session = {
        "session_id": session_id,
        "job_title": job_title.strip() or "NA",
        "jd_text": jd_text.strip(),
        "threshold": threshold,
        "weights": weight_map,
        "cutoffs": cutoff_map,
        "created_at": storage.now_iso(),
        "status": "processing",
        "candidates": [],
        "duplicates": duplicates,
        "stats": {"total": len(resumes), "parsed": 0, "failed": 0, "shortlisted": 0,
                  "duplicates": len(duplicates)},
        "progress": {"stage": "Queued", "processed": 0, "total": len(resumes), "errors": 0},
        "accepted_history_id": None,
    }
    storage.save_session(session)
    PROGRESS[session_id] = {**session["progress"], "status": "processing"}

    task = asyncio.create_task(
        _run_screening(session_id, resumes, jd_text.strip(), weight_map, cutoff_map, threshold)
    )
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return {"session_id": session_id, "total_resumes": len(resumes),
            "duplicates": len(duplicates), "status": "processing"}


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
    # Serve from the in-memory mirror while a run is live: the UI polls every
    # ~2s and re-reading the whole session JSON (all candidates) per poll was
    # pure write/read amplification.
    mem = PROGRESS.get(session_id)
    if mem:
        return {
            "session_id": session_id,
            "status": mem.get("status", "processing"),
            "progress": {k: v for k, v in mem.items() if k != "stats"},
            "stats": mem.get("stats", {}),
        }
    session = storage.load_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return {
        "session_id": session_id,
        "status": session.get("status"),
        "progress": session.get("progress", {}),
        "stats": session.get("stats", {}),
        "error": session.get("error", ""),
    }


@app.put("/api/sessions/{session_id}/candidates")
async def update_candidates(session_id: str, payload: dict = Body(...)):
    """Persist the reviewer's edits: added rows, edited cells, deleted rows."""
    session = storage.load_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    if session.get("accepted_history_id"):
        raise HTTPException(409, "This shortlist was already accepted and is locked")
    if session.get("status") == "processing":
        # The background run flushes the whole candidate list every few seconds;
        # edits accepted now would be silently overwritten by the next flush.
        raise HTTPException(409, "Screening is still running - wait for it to finish before editing")

    incoming = payload.get("candidates")
    if not isinstance(incoming, list):
        raise HTTPException(400, "candidates must be a list")

    existing = {c["candidate_id"]: c for c in session.get("candidates", [])}
    merged: list[dict] = []
    seen: set[str] = set()
    for row in incoming:
        if not isinstance(row, dict):
            continue
        requested = str(row.get("candidate_id") or "").strip()
        original = existing.get(requested)
        cid = requested or storage.new_id("CID")
        # A duplicate id in the payload gets a fresh id but keeps merging onto
        # the original row's data (the old code looked up the base by the NEW
        # id and merged onto a blank row instead).
        while cid in seen:
            cid = storage.new_id("CID")
        base = dict(original) if original else scoring.blank_candidate(cid)
        for key, value in row.items():
            if key in ("candidate_id",):
                continue
            base[key] = value
        base["candidate_id"] = cid
        if base.get("status") not in ROW_STATUSES:
            base["status"] = (original or {}).get("status") or "REVIEW"
        if original is not None and base != {**original, "candidate_id": cid}:
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
    # "failed" is acceptable too: a run the server lost mid-way still has
    # partial results the reviewer may want to freeze.
    if session.get("status") not in ("completed", "failed"):
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
# INTERVIEW LINKS
# Each draft carries a signed, per-candidate link that starts that candidate's
# interview in the Virtual AI Interviewer app (backend/interview_link.py). The
# link is minted at DRAFT time, not send time, so the recruiter reviews the exact
# mail the candidate will get. It is re-minted on send only if it is missing, and
# the sent copy freezes it.
# The model never writes the URL: it marks the spot with a placeholder and
# ai_agent.inject_link() substitutes the real address. A hallucinated interview
# link is not a defect a candidate should ever have to discover.

INVITE_ELIGIBLE = ("SHORTLISTED", "REVIEW")


def _interview_link(session: dict, candidate_id: str) -> str:
    """That candidate's interview link, or "" when links are switched off.

    Keyed on the accepted history id when the shortlist has been accepted, and
    on the session id otherwise, because the interviewer resolves candidates
    from both. Accepting a shortlist after sending does not invalidate a link
    that is already out.
    """
    if not config.INCLUDE_INTERVIEW_LINK or not interview_link.enabled():
        return ""
    key_id = session.get("accepted_history_id") or session.get("session_id")
    return interview_link.link_for(key_id, candidate_id) or ""


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
    # The status filter applies even to explicitly named ids: a NOT_SHORTLISTED
    # candidate must not be invitable through the raw API either.
    picked = [c for c in session.get("candidates", [])
              if c.get("status") in INVITE_ELIGIBLE]
    if candidate_ids:
        wanted = set(candidate_ids)
        picked = [c for c in picked if c.get("candidate_id") in wanted]
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
        "interview_links": config.INCLUDE_INTERVIEW_LINK and interview_link.enabled(),
        "interview_base_url": interview_link.base_url(),
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
    if session.get("status") not in ("completed", "accepted", "failed"):
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
        link = _interview_link(session, cid)
        async with semaphore:
            try:
                drafted = await ai_agent.draft_interview_email(client, cand, rubric,
                                                               ctx, link)
                source, note = "ai", ""
            except Exception as exc:  # noqa: BLE001
                drafted = ai_agent.fallback_email(cand, rubric, ctx, link)
                source, note = "fallback", f"AI draft failed: {exc}"
                async with lock:
                    failures += 1

        email = str(cand.get("email_id") or "NA").strip() or "NA"
        drafts[cid] = {
            "candidate_id": cid,
            "candidate_name": cand.get("candidate_name", "NA"),
            "email_id": email,
            "has_email": _valid_email(email),
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
            "interview_link": link,
            "link_placement": drafted.get("link_placement", "none"),
        }

    timeout = httpx.Timeout(config.REQUEST_TIMEOUT_SECONDS)
    limits = httpx.Limits(max_connections=config.MAX_CONCURRENT_AI_CALLS + 4)
    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        await asyncio.gather(*(one(client, c) for c in todo))

    # The AI calls above take seconds; reload before saving so a concurrent
    # edit/send is merged rather than clobbered by our stale copy. A draft that
    # went SENT in the meantime wins over the one we just generated.
    session = storage.load_session(session_id) or session
    merged = dict(session.get("outreach", {}))
    for cand in todo:
        cid = cand.get("candidate_id")
        if cid in drafts and merged.get(cid, {}).get("status") != "SENT":
            merged[cid] = drafts[cid]
    session["outreach"] = merged
    storage.save_session(session)
    return {"ok": True, "drafted": len(todo), "failures": failures,
            "skipped": len(targets) - len(todo), "drafts": list(merged.values())}


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
        "has_email": _valid_email(email),
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

        # A draft written before links were switched on has none; mint it now
        # rather than sending an invitation with no way in.
        if not draft.get("interview_link"):
            minted = _interview_link(session, cid)
            if minted:
                body, placement = ai_agent.inject_link(draft["body"], minted)
                draft.update({"body": body, "interview_link": minted,
                              "link_placement": placement})

        draft.update({
            "status": "SENT",
            "sent_at": storage.now_iso(),
            "send_mode": config.EMAIL_SEND_MODE,
            # Freeze the exact text that would have gone out, so a later edit to
            # the draft can never rewrite history.
            "sent_subject": draft["subject"],
            "sent_body": draft["body"],
            "sent_interview_link": draft.get("interview_link", ""),
        })
        drafts[cid] = draft
        sent.append({"candidate_id": cid,
                     "candidate_name": draft.get("candidate_name", "NA"),
                     "email_id": draft.get("email_id"),
                     "interview_link": draft.get("interview_link", "")})

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
async def export_session(session_id: str, only_shortlisted: bool = False, status: str = ""):
    """Export the sheet. `status` (comma-separated) exports exactly those rows,
    so what the reviewer filtered on screen is what lands in the file;
    `only_shortlisted` is kept for backwards compatibility (SHORTLISTED+REVIEW).
    """
    session = storage.load_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    record: dict[str, Any] = dict(session)
    wanted = {s.strip().upper() for s in status.split(",") if s.strip()}
    if wanted:
        record["candidates"] = [c for c in record.get("candidates", [])
                                if c.get("status") in wanted]
    elif only_shortlisted:
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
async def unhandled(request: Request, exc: Exception):
    # Full traceback to the server log; only the exception class to the client.
    # Raw error text can leak paths, hostnames and config to whoever calls the API.
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500,
                        content={"detail": f"Internal server error ({type(exc).__name__}) - "
                                           "see the server log for details"})
