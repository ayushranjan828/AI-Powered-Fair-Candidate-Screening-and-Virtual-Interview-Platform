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


# --- Azure OpenAI (supports both plain and VITE_ prefixed names) --------------
AZURE_OPENAI_ENDPOINT = _env("AZURE_OPENAI_ENDPOINT", "VITE_AZURE_OPENAI_ENDPOINT").rstrip("/")
AZURE_OPENAI_API_KEY = _env("AZURE_OPENAI_API_KEY", "VITE_AZURE_OPENAI_API_KEY")
AZURE_OPENAI_API_VERSION = _env(
    "AZURE_OPENAI_API_VERSION", "VITE_AZURE_OPENAI_API_VERSION", default="2025-04-01-preview"
)
AZURE_OPENAI_DEPLOYMENT = _env("AZURE_OPENAI_DEPLOYMENT", "VITE_AZURE_OPENAI_DEPLOYMENT")

AI_CONFIGURED = bool(AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT)

# --- Screening tuning --------------------------------------------------------
SHORTLIST_THRESHOLD = float(_env("SHORTLIST_THRESHOLD", default="60"))

# Evaluation criteria weights (must sum to 100).
DEFAULT_WEIGHTS = {
    "education": float(_env("WEIGHT_EDUCATION", default="15")),
    "skills": float(_env("WEIGHT_SKILLS", default="35")),
    "experience": float(_env("WEIGHT_EXPERIENCE", default="25")),
    "projects": float(_env("WEIGHT_PROJECTS", default="15")),
    "certifications": float(_env("WEIGHT_CERTIFICATIONS", default="10")),
}

# Per-criterion floors. A candidate below any of these is held back even if the
# weighted total clears the threshold. 0 disables the floor.
DEFAULT_CRITERIA_CUTOFFS = {
    "education": float(_env("CUTOFF_EDUCATION", default="0")),
    "skills": float(_env("CUTOFF_SKILLS", default="40")),
    "experience": float(_env("CUTOFF_EXPERIENCE", default="0")),
    "projects": float(_env("CUTOFF_PROJECTS", default="0")),
    "certifications": float(_env("CUTOFF_CERTIFICATIONS", default="0")),
}

CRITERIA = ["education", "skills", "experience", "projects", "certifications"]

MAX_CONCURRENT_AI_CALLS = int(_env("MAX_CONCURRENT_AI_CALLS", default="6"))
MAX_RESUME_CHARS = int(_env("MAX_RESUME_CHARS", default="18000"))
REQUEST_TIMEOUT_SECONDS = float(_env("REQUEST_TIMEOUT_SECONDS", default="180"))

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
