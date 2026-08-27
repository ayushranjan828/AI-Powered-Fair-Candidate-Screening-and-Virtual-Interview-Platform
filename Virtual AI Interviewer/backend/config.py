"""Application configuration. All secrets are read from .env - never hardcoded."""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent


def _find_env_file() -> Path | None:
    """Nearest .env at or above the app directory.

    This app sits in a sub-folder of the repo while .env lives at the repo root
    (shared with the screening app), so walk upwards instead of assuming one
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
INTERVIEWS_DIR = DATA_DIR / "interviews"
FRONTEND_DIR = BASE_DIR / "frontend"

for _d in (DATA_DIR, INTERVIEWS_DIR):
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

REQUEST_TIMEOUT_SECONDS = float(_env("REQUEST_TIMEOUT_SECONDS", default="180"))
MAX_RESUME_CHARS = int(_env("MAX_RESUME_CHARS", default="12000"))

# --- Interviewer identity ----------------------------------------------------
COMPANY_NAME = _env("COMPANY_NAME", default="Our Company")
INTERVIEWER_NAME = _env("INTERVIEWER_NAME", default="Alex")
INTERVIEWER_ROLE = _env("INTERVIEWER_ROLE", default="Technical Interviewer")

# --- Interview shape ---------------------------------------------------------
# Planned questions asked to every candidate. Follow-ups are generated on top of
# these from the candidate's own answers, so the real turn count is higher.
PLANNED_QUESTION_COUNT = int(_env("PLANNED_QUESTION_COUNT", default="10"))
MAX_FOLLOWUPS_PER_QUESTION = int(_env("MAX_FOLLOWUPS_PER_QUESTION", default="2"))
MAX_TOTAL_TURNS = int(_env("MAX_TOTAL_TURNS", default="30"))

# An answer shorter than this is treated as a non-answer ("skip", "I don't know")
# and never earns a follow-up - pressing someone who has nothing to say is noise.
MIN_ANSWER_WORDS_FOR_FOLLOWUP = int(_env("MIN_ANSWER_WORDS_FOR_FOLLOWUP", default="12"))

# Question categories the plan draws from. The weight is how much that category's
# per-answer grades count toward the parameter averages.
CATEGORIES = {
    "intro": {"label": "Introduction", "weight": 0.5,
              "about": "warm opener - background, current work, motivation"},
    "resume": {"label": "Resume & experience", "weight": 1.0,
               "about": "specific claims on the resume: roles, ownership, tenure"},
    "project": {"label": "Project deep-dive", "weight": 1.4,
                "about": "a project the candidate listed - design, trade-offs, their own part"},
    "technical": {"label": "Technical skills", "weight": 1.4,
                  "about": "a technical skill named in the resume, probed for depth"},
    "domain": {"label": "Domain knowledge", "weight": 1.1,
               "about": "how their field works beyond the tools - concepts, practices"},
    "jd": {"label": "Job description fit", "weight": 1.2,
           "about": "a responsibility or requirement from the JD"},
    "scenario": {"label": "Scenario-based", "weight": 1.3,
                 "about": "a realistic situation from the role; asks what they would do"},
    "problem_solving": {"label": "Problem solving", "weight": 1.3,
                        "about": "an open problem judged on reasoning, not the final answer"},
    "closing": {"label": "Closing", "weight": 0.4,
                "about": "questions for us, anything they want to add"},
}

# Default plan shape: category -> how many planned questions. Trimmed or padded
# to PLANNED_QUESTION_COUNT by interview.py.
DEFAULT_CATEGORY_MIX = {
    "intro": 1,
    "resume": 1,
    "project": 2,
    "technical": 2,
    "domain": 1,
    "jd": 1,
    "scenario": 1,
    "problem_solving": 1,
    "closing": 1,
}

# --- Evaluation parameters ---------------------------------------------------
# The candidate is judged on interview performance, not on the resume. Weights
# must sum to 100; they are normalised anyway.
PARAMETERS = {
    "communication": "Clarity, structure and listening. Fluency in any accent or "
                     "dialect is never a factor.",
    "technical_knowledge": "Depth and correctness on the technologies discussed.",
    "domain_knowledge": "Understanding of the field beyond the specific tools.",
    "project_understanding": "Genuine grasp of the projects they claim - decisions, "
                             "trade-offs, their own contribution.",
    "jd_alignment": "Evidence of the capabilities this specific role needs.",
    "problem_solving": "Reasoning, structure and handling of unfamiliar problems.",
    "answer_quality": "Relevance, specificity and evidence in the answers given.",
}

DEFAULT_PARAMETER_WEIGHTS = {
    "communication": float(_env("WEIGHT_COMMUNICATION", default="15")),
    "technical_knowledge": float(_env("WEIGHT_TECHNICAL", default="20")),
    "domain_knowledge": float(_env("WEIGHT_DOMAIN", default="15")),
    "project_understanding": float(_env("WEIGHT_PROJECTS", default="15")),
    "jd_alignment": float(_env("WEIGHT_JD_ALIGNMENT", default="10")),
    "problem_solving": float(_env("WEIGHT_PROBLEM_SOLVING", default="15")),
    "answer_quality": float(_env("WEIGHT_ANSWER_QUALITY", default="10")),
}

# Verdict bands on the overall interview score.
VERDICT_BANDS = [
    (float(_env("BAND_STRONG", default="80")), "STRONG_HIRE"),
    (float(_env("BAND_HIRE", default="65")), "HIRE"),
    (float(_env("BAND_BORDERLINE", default="50")), "BORDERLINE"),
]
VERDICT_FLOOR = "NO_HIRE"

# How much the holistic final AI review counts against the mean of the
# per-answer grades. 0.5 = equal say. The per-answer half is the audit trail.
HOLISTIC_BLEND = float(_env("HOLISTIC_BLEND", default="0.5"))

# --- Screening hand-off ------------------------------------------------------
# Where to look for shortlists accepted in the screening app. The first existing
# directory wins for writes; all of them are read.
SCREENING_APP_DIR = BASE_DIR.parent / "Candidate screening"
SCREENING_DATA_DIRS = [
    SCREENING_APP_DIR / "data",
    SCREENING_APP_DIR / "backend" / "data",
]
_extra = _env("SCREENING_DATA_DIR")
if _extra:
    SCREENING_DATA_DIRS.insert(0, Path(_extra))
