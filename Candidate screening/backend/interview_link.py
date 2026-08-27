"""Signed one-candidate interview links.

The screening app mints a link; the Virtual AI Interviewer verifies it and starts
that candidate's interview. The two are separate apps with separate packages, so
THIS FILE IS DUPLICATED in both backends and the two copies must stay identical -
the same arrangement as dnsfix.py. Change one, copy it over.

Why the token is signed: the link is the only thing standing between a stranger
and starting an interview as a named candidate. An unsigned token is just base64
of two ids, so anybody could mint one for any candidate. The HMAC means forging a
link needs the shared secret.

The token is stateless: it carries the shortlist id, the candidate id and an
expiry, and nothing else. It is not a password, it holds no personal data, and it
grants exactly one capability - take (or resume) this one interview.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

# Bumped if the payload shape ever changes, so old links fail cleanly.
VERSION = "1"
_INFO = b"interview-link-v1"
_SIG_BYTES = 16


def _env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value:
            return value.strip().strip('"').strip("'")
    return default


def secret() -> bytes | None:
    """The HMAC key shared by both apps.

    `INTERVIEW_LINK_SECRET` if set. Otherwise it is derived from the Azure key,
    which both apps already read from the same repo-root .env - that way links
    work with no extra configuration, and the derived key never leaves the
    machine. Setting an explicit secret is still better: it survives an Azure
    key rotation, which would otherwise invalidate every link already sent.
    """
    explicit = _env("INTERVIEW_LINK_SECRET")
    if explicit:
        return explicit.encode("utf-8")
    fallback = _env("AZURE_OPENAI_API_KEY", "VITE_AZURE_OPENAI_API_KEY")
    if fallback:
        return hmac.new(fallback.encode("utf-8"), _INFO, hashlib.sha256).digest()
    return None


def enabled() -> bool:
    return secret() is not None


def base_url() -> str:
    """Where the interviewer app is reachable from the candidate's browser.

    The default is fine for a demo on this machine. Sending a real candidate a
    127.0.0.1 link would obviously not work, so set INTERVIEW_BASE_URL to
    whatever host the interviewer is actually served on.
    """
    return _env("INTERVIEW_BASE_URL", default="http://127.0.0.1:8010").rstrip("/")


def ttl_days() -> int:
    try:
        return max(1, int(_env("INTERVIEW_LINK_TTL_DAYS", default="14")))
    except ValueError:
        return 14


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def _sign(payload: dict) -> str | None:
    key = secret()
    if not key:
        return None
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = _b64(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest()[:_SIG_BYTES])
    return f"{body}.{signature}"


def _expiry(days: int | None) -> int:
    return int(time.time()) + (days if days is not None else ttl_days()) * 86400


def make_token(shortlist_id: str, candidate_id: str, days: int | None = None) -> str | None:
    """A token for one candidate on one shortlist.

    The original and still the common case: the candidate exists in the screening
    app's records, and the interview is created when they first open the link.
    """
    if not shortlist_id or not candidate_id:
        return None
    return _sign({
        "v": VERSION,
        "s": str(shortlist_id),
        "c": str(candidate_id),
        "x": _expiry(days),
    })


def make_interview_token(interview_id: str, days: int | None = None) -> str | None:
    """A token for one already-prepared interview.

    Needed for a candidate who is not on any shortlist: there is no screening
    record to resolve them from, but the interview itself already holds their
    details, the JD and the question plan. The link points straight at it.
    """
    if not interview_id:
        return None
    return _sign({
        "v": VERSION,
        "t": "i",
        "i": str(interview_id),
        "x": _expiry(days),
    })


def parse_token(token: str) -> dict | None:
    """Verify and decode a token. None means "do not honour this link".

    Never raises: a malformed link is a normal event (a truncated paste, an old
    mail), not an exception.
    """
    key = secret()
    if not key or not token or "." not in token:
        return None
    body, _, signature = str(token).strip().partition(".")
    if not body or not signature:
        return None

    expected = _b64(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest()[:_SIG_BYTES])
    if not hmac.compare_digest(signature, expected):
        return None

    try:
        payload = json.loads(_unb64(body))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("v") != VERSION:
        return None

    try:
        expiry = int(payload.get("x", 0))
    except (TypeError, ValueError):
        return None
    expired = bool(expiry and expiry < time.time())

    # Two kinds of link. `t` is absent on the original shortlist+candidate tokens,
    # so links already in candidates' inboxes keep working unchanged.
    if payload.get("t") == "i":
        if not payload.get("i"):
            return None
        return {
            "kind": "interview",
            "interview_id": str(payload["i"]),
            "shortlist_id": "",
            "candidate_id": "",
            "expires_at": expiry,
            "expired": expired,
        }

    if not payload.get("s") or not payload.get("c"):
        return None

    # One shape either way, so a caller that forgets to check `expired` - or
    # `kind` - still gets the fields it expects rather than a KeyError.
    return {
        "kind": "candidate",
        "interview_id": "",
        "shortlist_id": str(payload["s"]),
        "candidate_id": str(payload["c"]),
        "expires_at": expiry,
        "expired": expired,
    }


def link_for(shortlist_id: str, candidate_id: str, days: int | None = None) -> str | None:
    token = make_token(shortlist_id, candidate_id, days)
    return f"{base_url()}/i/{token}" if token else None


def link_for_interview(interview_id: str, days: int | None = None) -> str | None:
    token = make_interview_token(interview_id, days)
    return f"{base_url()}/i/{token}" if token else None


def token_fingerprint(token: str) -> str:
    """A short non-reversible id for a token, safe to store in a record.

    Lets the interviewer tie an interview back to the link that started it
    without keeping the token itself lying around in a JSON file.
    """
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()[:16]
