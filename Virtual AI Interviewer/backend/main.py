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
               interview as engine, interview_link, storage)

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


@app.get("/i/{token}")
async def invite_page(token: str):
    """The candidate's door: the link from their invitation email lands here.

    Serves the candidate page, which is a different page from the recruiter
    console on purpose - it has no setup, no history, no other candidates and no
    scores anywhere in it. The token stays in the URL for the page to read.
    """
    page = config.FRONTEND_DIR / "candidate.html"
    if not page.exists():
        raise HTTPException(500, "frontend/candidate.html is missing")
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


# ------------------------------------------------------- invite links (candidate)
#
# The only two routes a candidate's browser ever calls that are not the ordinary
# interview loop. Everything here is deliberately stingy about what it returns:
# a name, a role, and an interview id. No scores, no other candidates, no plan.

# Pseudo-shortlist id under which links to a single prepared interview are
# recorded, so one-off links can be revoked and mailed by the same machinery as
# shortlist ones without pretending to belong to a shortlist.
ONE_OFF_KEY = "__one_off__"


def _resolve_invite(token: str) -> tuple[dict, dict]:
    """(claims, context) for a valid link, or raise the right HTTP error.

    Handles both kinds of link. A shortlist+candidate token resolves the person
    from the screening records and the interview is created on first use; an
    interview token points at an interview that already exists, which is how a
    candidate who was never on a shortlist gets a link at all.
    """
    if not interview_link.enabled():
        raise HTTPException(503, "Interview links are not configured on this server")

    claims = interview_link.parse_token(token)
    if not claims:
        # Deliberately not "bad signature" vs "malformed": a stranger poking at
        # the endpoint learns nothing from the difference.
        raise HTTPException(404, "This interview link is not valid")
    if claims.get("expired"):
        raise HTTPException(410, "This interview link has expired - please ask "
                                 "the recruiter for a new one")

    def check_revoked(key: tuple[str, str]) -> None:
        # The token is stateless and cannot be unsigned, so revocation is checked
        # here. A link minted by the screening app has no record and is honoured.
        invite = storage.get_invite(*key)
        if invite and invite.get("revoked"):
            raise HTTPException(403, "This interview link has been withdrawn. Please "
                                     "contact the recruiter who invited you.")

    if claims["kind"] == "interview":
        record = storage.load_interview(claims["interview_id"])
        if not record:
            raise HTTPException(404, "The interview this link refers to no longer exists")
        key = (ONE_OFF_KEY, claims["interview_id"])
        check_revoked(key)
        return claims, {
            "kind": "interview",
            "invite_key": key,
            "candidate": record.get("candidate", {}),
            "job_title": record.get("job_title", "NA"),
            "jd_text": record.get("jd_text", ""),
            "jd_analysis": record.get("jd_analysis", {}) or {},
            "existing": record,
        }

    key = (claims["shortlist_id"], claims["candidate_id"])
    check_revoked(key)
    resolved = candidates.find_for_invite(*key)
    if not resolved:
        raise HTTPException(404, "We could not find the candidate this link refers to")
    return claims, {
        "kind": "candidate",
        "invite_key": key,
        **resolved,
        "existing": storage.find_by_invite(*key),
    }


def _invite_state(record: dict | None) -> str:
    if not record:
        return "new"
    status = record.get("status")
    if status == engine.STATUS_COMPLETED:
        return "completed"
    if status == engine.STATUS_ABANDONED:
        return "abandoned"
    if status == engine.STATUS_PLANNING:
        return "preparing"
    return "resume"


@app.get("/api/invite/{token}")
async def invite_info(token: str):
    """What the candidate landing page needs before they press Begin."""
    claims, ctx = _resolve_invite(token)
    candidate = ctx["candidate"]
    existing = ctx["existing"]
    answered = len([t for t in (existing or {}).get("turns", [])
                    if (t.get("answer") or "").strip()])

    state = _invite_state(existing)
    # A prepared-but-untouched interview is a first visit, not a resumption. This
    # is always the case for a one-off link, whose interview exists from the
    # moment the recruiter prepared it.
    if state == "resume" and answered == 0:
        state = "new"

    return {
        "state": state,
        "greeting_name": candidates.display_name(candidate.get("candidate_name")),
        "job_title": ctx["job_title"],
        "company": config.COMPANY_NAME,
        "interviewer": {"name": config.INTERVIEWER_NAME, "role": config.INTERVIEWER_ROLE},
        # Only sent for a resumable interview, so a finished one cannot be reopened.
        "interview_id": existing["interview_id"] if state in ("resume", "preparing") else None,
        "answered": answered,
        "expires_at": claims.get("expires_at"),
    }


@app.post("/api/invite/{token}/start")
async def invite_start(token: str):
    """Create or resume this candidate's interview, and return its id.

    Idempotent by design: clicking the link twice, or reloading mid-interview,
    must never produce a second interview for the same person.
    """
    claims, ctx = _resolve_invite(token)
    existing = ctx["existing"]
    state = _invite_state(existing)

    if state == "completed":
        raise HTTPException(409, "You have already completed this interview. "
                                 "Thank you - the team has your responses.")

    if ctx["kind"] == "interview":
        # The interview was prepared before the link was issued, so there is
        # nothing to create. An abandoned one is not silently recreated: the
        # recruiter discarded it, and a link should not undo that.
        if state == "abandoned":
            raise HTTPException(409, "This interview was closed by the team. Please "
                                     "contact the recruiter who invited you.")
        return {"interview_id": existing["interview_id"],
                "status": existing["status"],
                "resumed": bool(existing.get("turns"))}

    if state in ("resume", "preparing"):
        return {"interview_id": existing["interview_id"],
                "status": existing["status"], "resumed": True}

    # Whatever the recruiter chose when they issued the link. Falls back to the
    # configured defaults for a link minted by the screening app, which has no
    # opinion about question counts.
    invite = storage.get_invite(*ctx["invite_key"]) or {}
    # The invite froze its shape when it was issued. A link minted by the
    # screening app froze nothing, so fall back to this candidate's own settings
    # and then to the configured defaults.
    options, _ = _effective_options(claims["shortlist_id"], claims["candidate_id"],
                                    invite.get("options"))

    # A recruiter-abandoned interview is not resumable, so a fresh one is made.
    record = engine.create_interview(
        ctx["candidate"],
        ctx["jd_text"],
        ctx["jd_analysis"],
        ctx["job_title"],
        options,
        {
            "kind": "invite",
            "shortlist_id": claims["shortlist_id"],
            "candidate_id": claims["candidate_id"],
            "screening_record": ctx.get("source_kind", ""),
            # The token itself is not stored - only a fingerprint of it, so the
            # record can be tied back to a link without holding the link.
            "token_fingerprint": interview_link.token_fingerprint(token),
            "started_by": "candidate",
        },
    )
    asyncio.create_task(engine.plan_interview(record["interview_id"]))
    return {"interview_id": record["interview_id"], "status": record["status"],
            "resumed": False}


# ------------------------------------------------------ dashboard (recruiter)
#
# NOTHING HERE SENDS EMAIL.
#
# There is no SMTP client or mail SDK in this codebase, the same as the screening
# app. The dashboard issues a link, hands the recruiter the text, and records that
# they sent it. "Mark as sent" is an audit note, not a transmission. The mail
# route returns a mailto: URL so the recruiter can send it from their own client,
# which is a real send - by them, not by us.

def _interview_summary(record: dict | None) -> dict | None:
    """The dashboard's view of one interview. Scores included: this is the
    recruiter's own screen, not the candidate's."""
    if not record:
        return None
    report = record.get("report") or {}
    answered = len([t for t in record.get("turns", []) if (t.get("answer") or "").strip()])
    return {
        "interview_id": record.get("interview_id"),
        "status": record.get("status"),
        "created_at": record.get("created_at"),
        "completed_at": record.get("completed_at"),
        "answered": answered,
        "planned_total": len((record.get("plan") or {}).get("questions", [])),
        "overall_score": report.get("overall_score"),
        "verdict": report.get("verdict"),
        "confidence": report.get("confidence"),
        "source": (record.get("source") or {}).get("kind", "manual"),
        "human_decision": (record.get("human_review") or {}).get("decision") or "",
        "human_review": record.get("human_review") or None,
    }


# Did this person actually sit the interview? Derived here rather than in the
# browser so the screen and the exported report can never disagree.
#   COMPLETED     - sat it and reached the end
#   PARTIAL       - started answering, did not finish
#   NOT_STARTED   - a link exists or the interview was prepared, never answered
#   NO_INTERVIEW  - nothing exists for them at all
ATTENDED = ("COMPLETED", "PARTIAL")


def _attendance(interview: dict | None) -> str:
    if not interview:
        return "NO_INTERVIEW"
    if interview["status"] == engine.STATUS_COMPLETED:
        # Completed counts as attended even if every question was skipped: they
        # turned up, and "answered nothing" is a finding for the reviewer.
        return "COMPLETED"
    if interview["answered"] > 0:
        return "PARTIAL"
    return "NOT_STARTED"


def _row_stage(invite: dict | None, interview: dict | None,
               outreach: dict | None) -> str:
    """The single word the dashboard sorts and filters on.

    Deliberately derived rather than stored: a stored status would drift out of
    step with the interview records the moment anything happened elsewhere.

    Inviting is the screening app's job, so everything before the interview comes
    from its outreach record. The only thing this app contributes is the
    withdrawal, which is the one lever it still has over a link it did not mint.
    """
    if interview:
        status = interview["status"]
        if status == engine.STATUS_COMPLETED:
            return "COMPLETED"
        if status == engine.STATUS_ABANDONED:
            return "ABANDONED"
        if status == engine.STATUS_PLANNING:
            return "PREPARING"
        return "IN_PROGRESS"
    if invite and invite.get("revoked"):
        return "REVOKED"
    if outreach and outreach.get("sent"):
        return "SENT"
    if outreach:
        return "DRAFTED"
    return "NOT_INVITED"


@app.get("/api/dashboard/{history_id}")
async def dashboard(history_id: str):
    """Everything the recruiter's dashboard needs for one shortlist, in one call.

    Assembled server-side on purpose: the browser would otherwise have to fan out
    one request per candidate to find out who has an interview.
    """
    data = candidates.shortlist_candidates(history_id)
    if not data:
        raise HTTPException(404, "That shortlist was not found")

    invites = storage.invites_for(history_id)
    overrides = storage.candidate_options_for(history_id)
    # Read once for the whole shortlist: the screening session is a single file.
    outreach = candidates.outreach_for(history_id)
    rows = []
    for cand in data["candidates"]:
        cid = cand["candidate_id"]
        invite = invites.get(cid)
        interview = _interview_summary(storage.find_by_invite(history_id, cid))
        attendance = _attendance(interview)
        override = overrides.get(cid)
        mail = outreach.get(cid)
        rows.append({
            **cand,
            # Only what this app still owns: whether the link is withdrawn.
            "invite": invite,
            # The invitation as the screening app has it. The body is left out
            # here - it is several hundred words per candidate, and the drawer
            # fetches it for the one row the recruiter opens.
            "outreach": None if not mail else {
                k: v for k, v in mail.items() if k != "body"
            },
            "interview": interview,
            "stage": _row_stage(invite, interview, mail),
            # The interview shape this candidate will actually get.
            "options": (override or {}).get("options") or None,
            "options_note": (override or {}).get("note", ""),
            "has_custom_options": bool(override),
            "has_custom_weights": weights_are_custom(
                ((override or {}).get("options") or {}).get("weights")),
            "attendance": attendance,
            "attended": attendance in ATTENDED,
            # "" when nobody has recorded a verdict yet, which the Report tab
            # filters on as "Not decided".
            "decision": (interview or {}).get("human_decision", ""),
        })

    counts: dict[str, int] = {}
    for row in rows:
        counts[row["stage"]] = counts.get(row["stage"], 0) + 1

    attendance_counts: dict[str, int] = {}
    decision_counts: dict[str, int] = {}
    for row in rows:
        attendance_counts[row["attendance"]] = attendance_counts.get(row["attendance"], 0) + 1
        key = row["decision"] or "NONE"
        decision_counts[key] = decision_counts.get(key, 0) + 1

    scored = [r["interview"]["overall_score"] for r in rows
              if r["interview"] and r["interview"].get("overall_score") is not None]

    return {
        "history_id": data["history_id"],
        "job_title": data["job_title"],
        "jd_text": data["jd_text"],
        "jd_analysis": data["jd_analysis"],
        "accepted_at": data["accepted_at"],
        "rows": rows,
        "stats": {
            "total": len(rows),
            "counts": counts,
            "completed": counts.get("COMPLETED", 0),
            "awaiting": counts.get("NOT_INVITED", 0),
            "average_score": round(sum(scored) / len(scored), 1) if scored else None,
            "attendance": attendance_counts,
            "attended": sum(1 for r in rows if r["attended"]),
            "not_attended": sum(1 for r in rows if not r["attended"]),
            "decisions": decision_counts,
        },
        "links_enabled": interview_link.enabled(),
        "base_url": interview_link.base_url(),
        "link_ttl_days": interview_link.ttl_days(),
        "send_mode": "manual",
    }


@app.get("/api/reports")
async def all_reports():
    """Every interview on record, whatever shortlist it came from.

    Needed because the shortlist-scoped view cannot show two kinds of interview
    a recruiter still cares about: one-offs that never belonged to a shortlist,
    and interviews whose shortlist has since been deleted from the screening app
    (the interview record is self-contained and survives that deletion).

    "Did not attend" is meaningless here and is reported as such: with no
    candidate list there is nobody to be absent. Pick a shortlist for that.
    """
    rows = []
    for row in storage.list_interviews(limit=1000):
        attendance = ("COMPLETED" if row["status"] == engine.STATUS_COMPLETED
                      else "PARTIAL" if row["turns"] > 0
                      else "NOT_STARTED")
        rows.append({
            "candidate_id": row["interview_id"],       # the row key in this mode
            "candidate_name": row["candidate_name"],
            "email_id": row["email_id"],
            "current_role": row["current_role"],
            "experience": "",
            "ats_score": row["screening_ats"],
            "status": row["status"],
            "invite": None,
            "attendance": attendance,
            "attended": attendance in ATTENDED,
            "decision": row["decision"],
            "interview": {
                "interview_id": row["interview_id"],
                "status": row["status"],
                "created_at": row["created_at"],
                "completed_at": row["completed_at"],
                "answered": row["turns"],
                "planned_total": row["planned_total"],
                "overall_score": row["overall_score"],
                "verdict": row["verdict"],
                "confidence": row["confidence"],
                "source": row["source"],
                "human_decision": row["decision"],
                "human_review": {
                    "decision": row["decision"],
                    "reviewer": row["reviewer"],
                    "reviewed_at": row["reviewed_at"],
                    "override_score": row["override_score"],
                } if row["decision"] or row["reviewer"] else None,
            },
            "job_title": row["job_title"],
            "shortlist_id": row["shortlist_id"],
        })

    attendance_counts: dict[str, int] = {}
    decision_counts: dict[str, int] = {}
    for row in rows:
        attendance_counts[row["attendance"]] = attendance_counts.get(row["attendance"], 0) + 1
        key = row["decision"] or "NONE"
        decision_counts[key] = decision_counts.get(key, 0) + 1
    scored = [r["interview"]["overall_score"] for r in rows
              if r["interview"]["overall_score"] is not None]

    return {
        "scope": "all",
        "history_id": "",
        "job_title": "All interviews",
        "accepted_at": None,
        "rows": rows,
        "stats": {
            "total": len(rows),
            "counts": {},
            "completed": attendance_counts.get("COMPLETED", 0),
            "awaiting": 0,
            "average_score": round(sum(scored) / len(scored), 1) if scored else None,
            "attendance": attendance_counts,
            "attended": sum(1 for r in rows if r["attended"]),
            "not_attended": sum(1 for r in rows if not r["attended"]),
            "decisions": decision_counts,
        },
        "links_enabled": interview_link.enabled(),
        "base_url": interview_link.base_url(),
    }


# ------------------------------------------------- per-candidate interview shape
#
# Everything about one interview can be set for one named candidate: how many
# questions, how hard to dig, which categories, the voice and its speed, and the
# evaluation weights.
#
# A NOTE ON PER-CANDIDATE WEIGHTS
#
# Weights here were originally run-wide on purpose, because scoring two people for
# the same role on differently weighted criteria makes their overall scores not
# directly comparable. They are per candidate now because that was asked for, and
# there are legitimate uses - interviewing a specialist and a generalist for the
# same team, say. The risk is handled by making it visible rather than by
# forbidding it: the weights actually used are frozen onto the interview record,
# `evaluation.build_report` flags a report whose weights are not the defaults, and
# the dashboard badges the row. Nobody should be able to compare two scores
# without seeing that they were weighted differently.

MAX_VOICE_NAME = 120


def normalise_options(raw: dict | None, base: dict | None = None) -> dict:
    """The canonical interview-shape dict. `base` supplies anything omitted."""
    raw = raw or {}
    base = base or {}

    def pick(key, default):
        for source in (raw, base):
            if source.get(key) is not None:
                return source[key]
        return default

    try:
        planned = int(pick("planned_count", config.PLANNED_QUESTION_COUNT))
    except (TypeError, ValueError):
        planned = config.PLANNED_QUESTION_COUNT
    try:
        followups = int(pick("max_followups", config.MAX_FOLLOWUPS_PER_QUESTION))
    except (TypeError, ValueError):
        followups = config.MAX_FOLLOWUPS_PER_QUESTION

    categories = [c for c in (pick("categories", None) or list(config.CATEGORIES))
                  if c in config.CATEGORIES]
    if not categories:
        categories = list(config.CATEGORIES)

    # Rate is clamped to the same range the UI slider offers. A browser voice name
    # cannot be validated here - the list is whatever the viewer's OS provides - so
    # it is only length-capped, and speech.js falls back to its preferred voice if
    # the name is not present on the machine actually playing it.
    try:
        rate = float(pick("voice_rate", 0.98))
    except (TypeError, ValueError):
        rate = 0.98
    voice_name = str(pick("voice_name", "") or "").strip()[:MAX_VOICE_NAME]

    weights_raw = pick("weights", None)
    weights = evaluation.normalize_weights(weights_raw) if weights_raw else None

    return {
        # Clamped the same way engine.create_interview does, so what the recruiter
        # is shown back is what will actually happen.
        "planned_count": max(4, min(20, planned)),
        "max_followups": max(0, min(4, followups)),
        "categories": categories,
        "voice": bool(pick("voice", True)),
        "voice_name": voice_name,
        "voice_rate": round(max(0.7, min(1.3, rate)), 2),
        # Normalised to 100 on the way in, so a report can never be weighted by
        # numbers that do not add up. None means "use the run defaults".
        "weights": weights,
    }


def weights_are_custom(weights: dict | None) -> bool:
    """True when these weights differ from the configured defaults."""
    if not weights:
        return False
    default = evaluation.normalize_weights(None)
    return any(abs(float(weights.get(k, 0)) - default[k]) > 0.01 for k in default)


def _effective_options(shortlist_id: str, candidate_id: str,
                       fallback: dict | None) -> tuple[dict, str]:
    """(options, where they came from) for one candidate.

    A saved override wins over whatever the dashboard currently has selected,
    which is the whole point of setting one.
    """
    override = storage.get_candidate_options(shortlist_id, candidate_id)
    if override and override.get("options"):
        return normalise_options(override["options"], fallback), "candidate"
    return normalise_options(fallback), "default"


@app.get("/api/candidate-options/{shortlist_id}/{candidate_id}")
async def get_candidate_settings(shortlist_id: str, candidate_id: str):
    """The interview shape this candidate will get, and whether it is bespoke."""
    override = storage.get_candidate_options(shortlist_id, candidate_id)
    options, source = _effective_options(shortlist_id, candidate_id, None)
    invite = storage.get_invite(shortlist_id, candidate_id)
    interview = storage.find_by_invite(shortlist_id, candidate_id)

    return {
        "shortlist_id": shortlist_id,
        "candidate_id": candidate_id,
        "options": options,
        "source": source,
        "has_override": bool(override),
        "note": (override or {}).get("note", ""),
        "updated_at": (override or {}).get("updated_at"),
        "defaults": normalise_options(None),
        "default_weights": evaluation.normalize_weights(None),
        "weights_are_custom": weights_are_custom(options.get("weights")),
        "parameters": config.PARAMETERS,
        # Whether a change can still take effect, and why not if it cannot.
        "locked": bool(interview and interview.get("status") not in
                       (engine.STATUS_READY, engine.STATUS_PLANNING)),
        "lock_reason": ("This interview has already started, so its question plan "
                        "is fixed." if interview and interview.get("status") not in
                        (engine.STATUS_READY, engine.STATUS_PLANNING) else ""),
        "link_issued": bool(invite),
    }


@app.put("/api/candidate-options/{shortlist_id}/{candidate_id}")
async def set_candidate_settings(shortlist_id: str, candidate_id: str,
                                 payload: dict = Body(...)):
    """Save this candidate's own interview shape.

    A link that has been issued but not yet used is updated in place, so the
    change actually reaches the candidate instead of silently applying to nobody.
    An interview already under way keeps the plan it started with.
    """
    if not candidates.find_for_invite(shortlist_id, candidate_id):
        raise HTTPException(404, "That candidate is not on that shortlist")

    options = normalise_options(payload.get("options"))
    record = storage.put_candidate_options({
        "shortlist_id": shortlist_id,
        "candidate_id": candidate_id,
        "options": options,
        "note": str(payload.get("note") or "").strip(),
        "set_by": str(payload.get("set_by") or "NA").strip() or "NA",
    })

    applied_to_link = False
    invite = storage.get_invite(shortlist_id, candidate_id)
    interview = storage.find_by_invite(shortlist_id, candidate_id)
    started = bool(interview and interview.get("status") not in
                   (engine.STATUS_READY, engine.STATUS_PLANNING))
    if invite and not started:
        invite["options"] = options
        storage.put_invite(invite)
        applied_to_link = True

    return {"ok": True, "options": options, "record": record,
            "applied_to_existing_link": applied_to_link,
            "interview_already_started": started}


@app.delete("/api/candidate-options/{shortlist_id}/{candidate_id}")
async def clear_candidate_settings(shortlist_id: str, candidate_id: str):
    """Drop the override so this candidate follows the recruiter's defaults."""
    removed = storage.clear_candidate_options(shortlist_id, candidate_id)
    if not removed:
        raise HTTPException(404, "That candidate has no settings of their own")
    return {"ok": True, "options": normalise_options(None)}


# Shortlisted candidates are invited by the screening app, which drafts the mail,
# mints the link and records what it sent. This app used to issue links too; it no
# longer does, so that there is exactly one place a candidate can be invited from.
# What remains here is what only this app can do: withdraw a link, and read back
# the invitation that went out.


@app.post("/api/interviews/{interview_id}/link")
async def issue_interview_link(interview_id: str, payload: dict = Body(default={})):
    """Issue a link to one already-prepared interview.

    This is how a candidate who was never on a shortlist gets a link: the
    interview holds their details, the JD and the plan, so the link points at it
    directly. Idempotent - re-issuing returns the same link unless `regenerate`.
    """
    if not interview_link.enabled():
        raise HTTPException(503, "Interview links are not configured - set "
                                 "INTERVIEW_LINK_SECRET or AZURE_OPENAI_API_KEY")
    record = _require(interview_id)
    if record["status"] == engine.STATUS_COMPLETED:
        raise HTTPException(409, "That interview is already complete")
    if record["status"] == engine.STATUS_ABANDONED:
        raise HTTPException(409, "That interview was discarded")

    key = (ONE_OFF_KEY, interview_id)
    existing = storage.get_invite(*key)
    if existing and not existing.get("revoked") and not payload.get("regenerate"):
        return {"ok": True, "issued": 0, "kept": 1, "invite": existing}

    link = interview_link.link_for_interview(interview_id)
    if not link:
        raise HTTPException(500, "Could not mint a link")
    candidate = record.get("candidate", {})
    invite = {
        "shortlist_id": ONE_OFF_KEY,
        "candidate_id": interview_id,
        "candidate_name": candidate.get("candidate_name", "NA"),
        "email_id": candidate.get("email_id", "NA"),
        "job_title": record.get("job_title", "NA"),
        "link": link,
        "token_fingerprint": interview_link.token_fingerprint(link.rsplit("/i/", 1)[-1]),
        "kind": "interview",
        "interview_id": interview_id,
        # The shape is already fixed on the interview itself; recorded here too so
        # the row reads the same as a shortlist one.
        "options": record.get("options", {}),
        "issued_at": storage.now_iso(),
        "issued_by": str(payload.get("issued_by") or "NA").strip() or "NA",
        "sent_at": None, "sent_channel": "", "sent_by": "", "note": "",
        "revoked": False, "revoked_at": None,
    }
    storage.put_invite(invite)
    return {"ok": True, "issued": 1, "kept": 0, "invite": invite}


@app.get("/api/interviews/{interview_id}/link")
async def get_interview_link(interview_id: str):
    """The one-off link for this interview, if one has been issued."""
    _require(interview_id)
    invite = storage.get_invite(ONE_OFF_KEY, interview_id)
    if not invite:
        raise HTTPException(404, "No link has been issued for that interview")
    return invite


def _require_invite(shortlist_id: str, candidate_id: str) -> dict:
    invite = storage.get_invite(shortlist_id, candidate_id)
    if not invite:
        raise HTTPException(404, "No link has been issued for that candidate")
    return invite


def _invite_or_stub(shortlist_id: str, candidate_id: str) -> dict:
    """The local invite record, invented if the link was minted elsewhere.

    A link the screening app sent leaves nothing behind here, so withdrawing one
    means writing the record that records the withdrawal. The stub holds no link
    - this app never saw that token - only the fact, which is exactly what
    _resolve_invite() checks when the candidate opens their link.
    """
    invite = storage.get_invite(shortlist_id, candidate_id)
    if invite:
        return invite

    resolved = candidates.find_for_invite(shortlist_id, candidate_id) or {}
    row = resolved.get("candidate", {})
    return {
        "shortlist_id": shortlist_id,
        "candidate_id": candidate_id,
        "candidate_name": row.get("candidate_name", "NA"),
        "email_id": row.get("email_id", "NA"),
        "job_title": resolved.get("job_title", "NA"),
        "link": "",
        "issued_by": "screening",
        "issued_at": None,
        "sent_at": None, "sent_channel": "", "sent_by": "", "note": "",
        "revoked": False, "revoked_at": None,
    }


@app.get("/api/invites/{shortlist_id}/{candidate_id}/mail")
async def invite_mail(shortlist_id: str, candidate_id: str):
    """The invitation for one candidate. Two sources, and the difference matters.

    For anybody on a shortlist this returns what the screening app actually
    drafted and sent - the real, model-personalised text, frozen at send time -
    so the recruiter reads the mail the candidate received rather than a
    reconstruction of it. Nothing here is editable; it is a record.

    For a one-off interview prepared in this app the screening app has never
    heard of the candidate, so the plain deterministic invitation is built
    instead, with a mailto: for the recruiter's own client.
    """
    if shortlist_id != ONE_OFF_KEY:
        mail = candidates.sent_mail(shortlist_id, candidate_id)
        if not mail:
            raise HTTPException(404, "The screening app has not drafted an "
                                     "invitation for that candidate")
        address = str(mail["email_id"] or "")
        return {
            "source": "screening",
            "subject": mail["subject"],
            "body": mail["body"],
            "link": mail["link"],
            "to": address if "@" in address else "",
            "has_email": mail["has_email"],
            "sent": mail["sent"],
            "sent_at": mail["sent_at"],
            "send_mode": mail["send_mode"],
            "edited": mail["edited"],
            "mailto": "",
        }

    invite = _require_invite(shortlist_id, candidate_id)
    name = candidates.display_name(invite.get("candidate_name"))
    role = invite.get("job_title") or "the role"
    subject = f"Interview invitation - {role} at {config.COMPANY_NAME}"
    body = (
        f"Hi {name},\n\n"
        f"Thank you for your interest in the {role} position at "
        f"{config.COMPANY_NAME}. We would like to invite you to the interview "
        f"stage.\n\n"
        f"Your interview is with an AI interviewer and is taken in your browser. "
        f"There is nothing to schedule - open the link below whenever suits you.\n\n"
        f"Start your interview here:\n{invite['link']}\n\n"
        f"The link is unique to you, so please do not share it. You will be asked "
        f"about your background, your projects and a few scenarios, and can speak "
        f"your answers or type them. {config.INTERVIEW_BROWSER_NOTE} If you close "
        f"the page part way through, opening the link again picks up where you "
        f"left off.\n\n"
        f"If you need an adjustment in order to take part, or cannot use the link, "
        f"just reply to this email.\n\n"
        f"Best regards,\n{config.COMPANY_NAME}"
    )
    email = invite.get("email_id") or ""
    to = email if "@" in email else ""
    mailto = (f"mailto:{quote(to)}?subject={quote(subject)}&body={quote(body)}")
    return {"source": "local", "subject": subject, "body": body, "mailto": mailto,
            "to": to, "has_email": bool(to), "link": invite["link"],
            "sent": bool(invite.get("sent_at")), "sent_at": invite.get("sent_at")}


@app.post("/api/invites/{shortlist_id}/{candidate_id}/sent")
async def mark_invite_sent(shortlist_id: str, candidate_id: str,
                           payload: dict = Body(default={})):
    """Record that the recruiter sent the link. An audit note, not a send."""
    invite = _require_invite(shortlist_id, candidate_id)
    channel = str(payload.get("channel") or "manual").strip().lower()
    if channel not in ("manual", "email", "mail-client", "copied", "other"):
        channel = "manual"
    invite.update({
        "sent_at": storage.now_iso(),
        "sent_channel": channel,
        "sent_by": str(payload.get("by") or "NA").strip() or "NA",
        "note": str(payload.get("note") or invite.get("note") or "").strip(),
    })
    storage.put_invite(invite)
    return {"ok": True, "invite": invite}


@app.post("/api/invites/{shortlist_id}/{candidate_id}/revoke")
async def revoke_invite(shortlist_id: str, candidate_id: str,
                        payload: dict = Body(default={})):
    """Withdraw a link, or put a withdrawn one back.

    Works on a link this app issued and on one the screening app sent, which is
    the common case now - see _invite_or_stub().
    """
    invite = _invite_or_stub(shortlist_id, candidate_id)
    revoke = bool(payload.get("revoked", True))

    existing = storage.find_by_invite(shortlist_id, candidate_id)
    if revoke and existing and existing.get("status") == engine.STATUS_COMPLETED:
        raise HTTPException(409, "That interview is already complete - there is "
                                 "nothing left to withdraw")

    invite.update({
        "revoked": revoke,
        "revoked_at": storage.now_iso() if revoke else None,
        "note": str(payload.get("note") or invite.get("note") or "").strip(),
    })
    storage.put_invite(invite)
    return {"ok": True, "invite": invite}


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
        # A candidate configured individually keeps that shape even when the
        # recruiter runs the interview themselves.
        options, options_source = _effective_options(history_id, candidate_id, options)
        source["options_source"] = options_source
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


@app.post("/api/interviews/bulk-delete")
async def bulk_delete_interviews(payload: dict = Body(...)):
    """Delete several interviews at once, including their transcripts.

    The ids are always listed explicitly, even when the operator picked "select
    all" - there is deliberately no route that wipes everything on an empty body,
    because a client-side bug must not be able to mean "delete the lot".

    Note the deliberate consequence: deleting an interview does NOT revoke that
    candidate's invite link. The link becomes usable again, which is what you
    want when you are clearing a bad run so somebody can retake it. Withdraw the
    link from the dashboard if that is not what you meant.
    """
    ids = payload.get("interview_ids")
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "interview_ids must be a non-empty list")

    wanted = [str(i).strip() for i in ids if str(i).strip()]
    if not wanted:
        raise HTTPException(400, "interview_ids must be a non-empty list")
    if len(wanted) > 500:
        raise HTTPException(400, "Too many ids in one request (max 500)")

    deleted, missing = [], []
    for interview_id in dict.fromkeys(wanted):      # de-duplicate, keep order
        if storage.delete_interview(interview_id):
            engine.PROGRESS.pop(interview_id, None)
            deleted.append(interview_id)
        else:
            missing.append(interview_id)

    return {"ok": True, "deleted": len(deleted), "deleted_ids": deleted,
            "missing": missing}


# --------------------------------------------------------------------- export
def _slug(value: str) -> str:
    import re
    value = re.sub(r"[^A-Za-z0-9]+", "-", value or "").strip("-")
    return (value[:40] or "interview").lower()


@app.get("/api/dashboard/{history_id}/export")
async def export_summary(history_id: str):
    """The whole shortlist as one report: who attended, scores, decisions."""
    board = await dashboard(history_id)
    data = excel_export.build_summary_workbook(board)
    filename = f"interview-report-{_slug(board.get('job_title') or history_id)}.xlsx"
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


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
