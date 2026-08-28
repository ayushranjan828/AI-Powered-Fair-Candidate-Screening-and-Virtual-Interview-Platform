"""JSON file storage: one file per interview, under data/interviews/."""
from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import config

_LOCK = threading.RLock()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10].upper()}"


def _write_atomic(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _read(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def interview_path(interview_id: str) -> Path:
    return config.INTERVIEWS_DIR / f"{interview_id}.json"


def save_interview(interview: dict) -> dict:
    with _LOCK:
        interview["updated_at"] = now_iso()
        _write_atomic(interview_path(interview["interview_id"]), interview)
    return interview


def load_interview(interview_id: str) -> dict | None:
    with _LOCK:
        return _read(interview_path(interview_id))


def list_interviews(limit: int = 200) -> list[dict]:
    """Summary rows for the History tab - never the full transcript."""
    with _LOCK:
        rows = []
        for path in config.INTERVIEWS_DIR.glob("*.json"):
            data = _read(path)
            if not data:
                continue
            report = data.get("report") or {}
            candidate = data.get("candidate") or {}
            review = data.get("human_review") or {}
            source = data.get("source") or {}
            rows.append({
                "interview_id": data.get("interview_id"),
                "candidate_name": candidate.get("candidate_name", "NA"),
                "email_id": candidate.get("email_id", "NA"),
                "current_role": candidate.get("current_role", "NA"),
                "job_title": data.get("job_title", "NA"),
                "status": data.get("status"),
                "created_at": data.get("created_at"),
                "completed_at": data.get("completed_at"),
                "turns": len([t for t in data.get("turns", []) if t.get("answer")]),
                "planned_total": len((data.get("plan") or {}).get("questions", [])),
                "overall_score": report.get("overall_score"),
                "verdict": report.get("verdict"),
                "confidence": report.get("confidence"),
                "source": source.get("kind", "manual"),
                "shortlist_id": source.get("shortlist_id") or source.get("history_id") or "",
                # The reviewer's own verdict, so the Report tab can filter on it
                # without re-reading every file.
                "decision": review.get("decision") or "",
                "reviewer": review.get("reviewer") or "",
                "reviewed_at": review.get("reviewed_at"),
                "override_score": review.get("override_score"),
                "screening_ats": (candidate.get("screening") or {}).get("ats_score"),
            })
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return rows[:limit]


# ---------------------------------------------------------------------- invites
#
# One file for every link the recruiter has issued. This exists because the
# interview records alone cannot answer "who has been sent a link but not started
# yet?" - the most important column on the dashboard.
#
# Kept as a single small JSON object rather than a file per invite: a shortlist is
# tens of candidates, not thousands, and one atomic write is easier to reason
# about than a directory that can be half-written.

INVITES_PATH = config.DATA_DIR / "invites.json"


def _invite_key(shortlist_id: str, candidate_id: str) -> str:
    return f"{shortlist_id}|{candidate_id}"


def load_invites() -> dict:
    with _LOCK:
        return _read(INVITES_PATH) or {}


def get_invite(shortlist_id: str, candidate_id: str) -> dict | None:
    return load_invites().get(_invite_key(shortlist_id, candidate_id))


def put_invite(record: dict) -> dict:
    """Insert or replace one invite. Read-modify-write under the shared lock."""
    with _LOCK:
        invites = _read(INVITES_PATH) or {}
        record["updated_at"] = now_iso()
        invites[_invite_key(record["shortlist_id"], record["candidate_id"])] = record
        _write_atomic(INVITES_PATH, invites)
    return record


def invites_for(shortlist_id: str) -> dict:
    """Every invite on one shortlist, keyed by candidate id."""
    return {
        rec["candidate_id"]: rec
        for rec in load_invites().values()
        if rec.get("shortlist_id") == shortlist_id
    }


# ------------------------------------------------------- per-candidate settings
#
# An interview shape set for ONE named candidate, overriding the recruiter's
# defaults. Kept apart from the invite record because settings are decided before
# (and independently of) any link being issued, and are still wanted for an
# interview conducted face to face with no link at all.

CANDIDATE_OPTIONS_PATH = config.DATA_DIR / "candidate_options.json"


def load_candidate_options() -> dict:
    with _LOCK:
        return _read(CANDIDATE_OPTIONS_PATH) or {}


def get_candidate_options(shortlist_id: str, candidate_id: str) -> dict | None:
    return load_candidate_options().get(_invite_key(shortlist_id, candidate_id))


def put_candidate_options(record: dict) -> dict:
    with _LOCK:
        store = _read(CANDIDATE_OPTIONS_PATH) or {}
        record["updated_at"] = now_iso()
        store[_invite_key(record["shortlist_id"], record["candidate_id"])] = record
        _write_atomic(CANDIDATE_OPTIONS_PATH, store)
    return record


def clear_candidate_options(shortlist_id: str, candidate_id: str) -> bool:
    with _LOCK:
        store = _read(CANDIDATE_OPTIONS_PATH) or {}
        if store.pop(_invite_key(shortlist_id, candidate_id), None) is None:
            return False
        _write_atomic(CANDIDATE_OPTIONS_PATH, store)
    return True


def candidate_options_for(shortlist_id: str) -> dict:
    """Every override on one shortlist, keyed by candidate id."""
    return {
        rec["candidate_id"]: rec
        for rec in load_candidate_options().values()
        if rec.get("shortlist_id") == shortlist_id
    }


def find_by_invite(shortlist_id: str, candidate_id: str) -> dict | None:
    """The most recent interview started from a given invite link.

    Used so that a candidate who closes the tab and clicks the link again resumes
    instead of starting a second interview - and so that somebody who has already
    finished cannot quietly take it twice.
    """
    matches: list[dict] = []
    with _LOCK:
        for path in config.INTERVIEWS_DIR.glob("*.json"):
            data = _read(path)
            if not data:
                continue
            source = data.get("source") or {}
            if (source.get("kind") == "invite"
                    and source.get("shortlist_id") == shortlist_id
                    and source.get("candidate_id") == candidate_id):
                matches.append(data)
    matches.sort(key=lambda d: d.get("created_at") or "", reverse=True)
    return matches[0] if matches else None


def delete_interview(interview_id: str) -> bool:
    with _LOCK:
        path = interview_path(interview_id)
        if path.exists():
            path.unlink()
            return True
    return False
