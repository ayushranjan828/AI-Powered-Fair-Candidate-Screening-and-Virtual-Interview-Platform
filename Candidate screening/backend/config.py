"""Application configuration. All secrets are read from .env - never hardcoded."""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent


def _find_env_file() -> Path | None:
    """Nearest .env at or above the app directory.

    The app can sit in a sub-folder of the repo (e.g. "Candidate screening/")
    while .env lives at the repo root, so walk upwards instead of assuming one
    fixed location.
    """
    for directory in (BASE_DIR, *BASE_DIR.parents):
        candidate = directory / ".env"
        if candidate.is_file():
            return candidate
    return None


ENV_FILE = _find_env_file()
if ENV_FILE:
    load_dotenv(ENV_FILE)

DATA_DIR = BASE_DIR / "data"
SESSIONS_DIR = DATA_DIR / "sessions"
HISTORY_DIR = DATA_DIR / "history"
FRONTEND_DIR = BASE_DIR / "frontend"

for _d in (DATA_DIR, SESSIONS_DIR, HISTORY_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def _env(*names: str, default: str = "") -> str:
    """First non-empty value among the given env var names."""
    for name in names:
        value = os.getenv(name)
        if value:
            return value.strip().strip('"').strip("'")
    return default


def _float_env(name: str, default: str) -> float:
    """A malformed number in .env falls back to the default instead of
    crashing the whole app at import time."""
    try:
        return float(_env(name, default=default))
    except ValueError:
        return float(default)


def _int_env(name: str, default: str) -> int:
    try:
        return int(_env(name, default=default))
    except ValueError:
        return int(default)


# --- Azure OpenAI (supports both plain and VITE_ prefixed names) --------------
AZURE_OPENAI_ENDPOINT = _env("AZURE_OPENAI_ENDPOINT", "VITE_AZURE_OPENAI_ENDPOINT").rstrip("/")
AZURE_OPENAI_API_KEY = _env("AZURE_OPENAI_API_KEY", "VITE_AZURE_OPENAI_API_KEY")
AZURE_OPENAI_API_VERSION = _env(
    "AZURE_OPENAI_API_VERSION", "VITE_AZURE_OPENAI_API_VERSION", default="2025-04-01-preview"
)
AZURE_OPENAI_DEPLOYMENT = _env("AZURE_OPENAI_DEPLOYMENT", "VITE_AZURE_OPENAI_DEPLOYMENT")

AI_CONFIGURED = bool(AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT)

# --- Screening tuning --------------------------------------------------------
SHORTLIST_THRESHOLD = _float_env("SHORTLIST_THRESHOLD", "60")

# Evaluation criteria weights (must sum to 100).
DEFAULT_WEIGHTS = {
    "education": _float_env("WEIGHT_EDUCATION", "15"),
    "skills": _float_env("WEIGHT_SKILLS", "35"),
    "experience": _float_env("WEIGHT_EXPERIENCE", "25"),
    "projects": _float_env("WEIGHT_PROJECTS", "15"),
    "certifications": _float_env("WEIGHT_CERTIFICATIONS", "10"),
}

# Per-criterion floors. A candidate below any of these is held back even if the
# weighted total clears the threshold. 0 disables the floor.
DEFAULT_CRITERIA_CUTOFFS = {
    "education": _float_env("CUTOFF_EDUCATION", "0"),
    "skills": _float_env("CUTOFF_SKILLS", "40"),
    "experience": _float_env("CUTOFF_EXPERIENCE", "0"),
    "projects": _float_env("CUTOFF_PROJECTS", "0"),
    "certifications": _float_env("CUTOFF_CERTIFICATIONS", "0"),
}

CRITERIA = ["education", "skills", "experience", "projects", "certifications"]

MAX_CONCURRENT_AI_CALLS = _int_env("MAX_CONCURRENT_AI_CALLS", "6")
MAX_RESUME_CHARS = _int_env("MAX_RESUME_CHARS", "18000")
REQUEST_TIMEOUT_SECONDS = _float_env("REQUEST_TIMEOUT_SECONDS", "180")

# --- Upload limits -------------------------------------------------------------
# Everything is processed in memory, so unbounded uploads (or a ZIP bomb) could
# take the whole server down. These caps bound the worst case; oversize items
# become per-file error rows rather than aborting the batch where possible.
MAX_UPLOAD_FILES = _int_env("MAX_UPLOAD_FILES", "500")
MAX_FILE_MB = _float_env("MAX_FILE_MB", "20")
MAX_TOTAL_UPLOAD_MB = _float_env("MAX_TOTAL_UPLOAD_MB", "300")
MAX_ZIP_ENTRIES = _int_env("MAX_ZIP_ENTRIES", "1000")

# --- Access control ------------------------------------------------------------
# Off by default (empty). When set, every /api/* request must carry the token in
# an X-Access-Token header or ?token= query parameter. The UI prompts for it on
# the first 401 and remembers it in localStorage. Set this before exposing the
# app beyond localhost - candidate PII is served by these endpoints.
APP_ACCESS_TOKEN = _env("APP_ACCESS_TOKEN")

# --- Interview outreach ------------------------------------------------------
# Identity used in the drafted invitation. Nothing here is ever transmitted:
# see EMAIL_SEND_MODE below.
COMPANY_NAME = _env("COMPANY_NAME", default="Our Company")
RECRUITER_NAME = _env("RECRUITER_NAME", default="Talent Acquisition Team")
RECRUITER_EMAIL = _env("RECRUITER_EMAIL", default="talent@example.com")

# "simulate" is the ONLY supported value. No SMTP client exists in this codebase;
# sending marks the draft as SENT locally and nothing leaves the machine.
EMAIL_SEND_MODE = "simulate"

# Statuses an outreach draft can hold.
OUTREACH_STATUSES = ("DRAFT", "SENT")

# --- interview links ---------------------------------------------------------
# Each drafted invitation carries a signed link that starts that one candidate's
# interview in the Virtual AI Interviewer app. See backend/interview_link.py for
# the token, and INTERVIEW_BASE_URL / INTERVIEW_LINK_SECRET / INTERVIEW_LINK_TTL_DAYS
# in .env.example. Set to "0" to go back to invitations with no link.
INCLUDE_INTERVIEW_LINK = _env("INCLUDE_INTERVIEW_LINK", default="1") not in ("0", "false", "no")

# Practicalities the candidate needs, stated by us rather than invented by the
# model - see ai_agent.link_block().
INTERVIEW_BROWSER_NOTE = _env(
    "INTERVIEW_BROWSER_NOTE",
    default="Use Chrome or Edge on a laptop or desktop, somewhere quiet, and allow "
            "microphone access when the page asks.",
)
