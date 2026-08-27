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
            rows.append({
                "interview_id": data.get("interview_id"),
                "candidate_name": candidate.get("candidate_name", "NA"),
                "job_title": data.get("job_title", "NA"),
                "status": data.get("status"),
                "created_at": data.get("created_at"),
                "completed_at": data.get("completed_at"),
                "turns": len([t for t in data.get("turns", []) if t.get("answer")]),
                "overall_score": report.get("overall_score"),
                "verdict": report.get("verdict"),
                "source": (data.get("source") or {}).get("kind", "manual"),
            })
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return rows[:limit]


def delete_interview(interview_id: str) -> bool:
    with _LOCK:
        path = interview_path(interview_id)
        if path.exists():
            path.unlink()
            return True
    return False
