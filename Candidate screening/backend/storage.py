"""JSON file storage: one file per screening session, one per accepted history record."""
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


# ------------------------------------------------------------------- sessions
def session_path(session_id: str) -> Path:
    return config.SESSIONS_DIR / f"{session_id}.json"


def save_session(session: dict) -> dict:
    with _LOCK:
        session["updated_at"] = now_iso()
        _write_atomic(session_path(session["session_id"]), session)
    return session


def load_session(session_id: str) -> dict | None:
    with _LOCK:
        return _read(session_path(session_id))


def list_sessions(limit: int = 50) -> list[dict]:
    with _LOCK:
        rows = []
        for path in config.SESSIONS_DIR.glob("*.json"):
            data = _read(path)
            if not data:
                continue
            rows.append({
                "session_id": data.get("session_id"),
                "job_title": data.get("job_title", "NA"),
                "created_at": data.get("created_at"),
                "status": data.get("status"),
                "total_resumes": data.get("stats", {}).get("total", 0),
                "shortlisted": data.get("stats", {}).get("shortlisted", 0),
                "accepted": bool(data.get("accepted_history_id")),
            })
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return rows[:limit]


def delete_session(session_id: str) -> bool:
    with _LOCK:
        path = session_path(session_id)
        if path.exists():
            path.unlink()
            return True
    return False


# -------------------------------------------------------------------- history
def history_path(history_id: str) -> Path:
    return config.HISTORY_DIR / f"{history_id}.json"


def save_history(record: dict) -> dict:
    with _LOCK:
        _write_atomic(history_path(record["history_id"]), record)
    return record


def load_history(history_id: str) -> dict | None:
    with _LOCK:
        return _read(history_path(history_id))


def list_history(limit: int = 200) -> list[dict]:
    with _LOCK:
        rows = []
        for path in config.HISTORY_DIR.glob("*.json"):
            data = _read(path)
            if not data:
                continue
            rows.append({
                "history_id": data.get("history_id"),
                "session_id": data.get("session_id"),
                "job_title": data.get("job_title", "NA"),
                "accepted_at": data.get("accepted_at"),
                "accepted_by": data.get("accepted_by", "NA"),
                "total_evaluated": data.get("stats", {}).get("total", 0),
                "final_count": len(data.get("candidates", [])),
                "threshold": data.get("threshold"),
                "notes": data.get("notes", ""),
            })
    rows.sort(key=lambda r: r.get("accepted_at") or "", reverse=True)
    return rows[:limit]


def delete_history(history_id: str) -> bool:
    with _LOCK:
        path = history_path(history_id)
        if path.exists():
            path.unlink()
            return True
    return False
