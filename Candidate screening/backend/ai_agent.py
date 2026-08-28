"""The screening AI agent: JD understanding + deep resume analysis + decisioning.

Talks to Azure OpenAI over plain HTTP (httpx) so no vendor SDK version is pinned.
Every AI call degrades to a deterministic regex-based fallback, so the pipeline
never hard-fails on a single resume.
"""
from __future__ import annotations

import asyncio
import json
import re

import httpx

from . import config

_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


class AIError(RuntimeError):
    pass


# --------------------------------------------------------------- low level call
def _chat_url() -> str:
    return (
        f"{config.AZURE_OPENAI_ENDPOINT}/openai/deployments/"
        f"{config.AZURE_OPENAI_DEPLOYMENT}/chat/completions"
        f"?api-version={config.AZURE_OPENAI_API_VERSION}"
    )


async def _chat_json(
    client: httpx.AsyncClient,
    system: str,
    user: str,
    max_tokens: int = 2000,
    retries: int = 2,
) -> dict:
    """One chat completion that must return a JSON object."""
    if not config.AI_CONFIGURED:
        raise AIError("Azure OpenAI is not configured - check .env")

    body = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_completion_tokens": max_tokens,
        "response_format": {"type": "json_object"},
        # Scores must be reproducible for the screening to be auditable - the
        # same resume should not shortlist on Monday and fail on Tuesday.
        # Deployments that reject the parameter get it stripped below.
        "temperature": 0,
    }
    headers = {"api-key": config.AZURE_OPENAI_API_KEY, "Content-Type": "application/json"}

    last_error = ""
    attempt = 0
    param_fixes = 0
    while attempt <= retries:
        try:
            resp = await client.post(_chat_url(), json=body, headers=headers)
        except httpx.HTTPError as exc:
            last_error = f"network error: {exc}"
            attempt += 1
            if attempt <= retries:
                await asyncio.sleep(1.5 * attempt)
            continue

        if resp.status_code == 400:
            detail = resp.text
            # Parameter-compatibility fixes: older deployments want max_tokens,
            # newer ones want max_completion_tokens; some reject response_format
            # or temperature. These retries do NOT consume an attempt - the call
            # has not really been tried yet - but are bounded so a deployment
            # that 400s on everything still terminates.
            if param_fixes < 3:
                if "max_completion_tokens" in detail and "max_tokens" in detail:
                    body.pop("max_completion_tokens", None)
                    body["max_tokens"] = max_tokens
                    param_fixes += 1
                    continue
                if "response_format" in detail:
                    body.pop("response_format", None)
                    param_fixes += 1
                    continue
                if "temperature" in detail and "temperature" in body:
                    body.pop("temperature", None)
                    param_fixes += 1
                    continue
            raise AIError(f"Azure OpenAI rejected the request: {detail[:400]}")

        if resp.status_code in (429, 500, 502, 503, 504):
            last_error = f"HTTP {resp.status_code}"
            attempt += 1
            if attempt <= retries:
                # retry-after may be seconds or an HTTP date; only honour numbers.
                try:
                    wait = float(resp.headers.get("retry-after", ""))
                except ValueError:
                    wait = 2.0 * attempt
                await asyncio.sleep(min(max(wait, 0.5), 20))
            continue

        if resp.status_code >= 400:
            raise AIError(f"Azure OpenAI HTTP {resp.status_code}: {resp.text[:300]}")

        payload = resp.json()
        try:
            content = payload["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError):
            raise AIError("Unexpected Azure OpenAI response shape")
        parsed = _parse_json(content)
        if parsed is not None:
            return parsed
        last_error = "model did not return valid JSON"
        attempt += 1

    raise AIError(last_error or "AI call failed")


def _parse_json(content: str):
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*\n?", "", content)
        content = re.sub(r"```$", "", content).strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        match = _JSON_BLOCK.search(content)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                return None
    return None


# ------------------------------------------------------------------- JD analysis
JD_SYSTEM = """You are an expert technical recruiter and job-description analyst.
Read the job description and produce a structured hiring rubric.
Be fair and inclusive: capture the INTENT and transferable equivalents of each
requirement, not just literal keywords, so that strong candidates who phrase
things differently are still recognised.
Respond with a single JSON object and nothing else."""

JD_USER_TEMPLATE = """Analyse this Job Description and return JSON with exactly these keys:

{{
  "role_title": string,
  "seniority": string,
  "min_experience_years": number,
  "required_education": string,
  "must_have_skills": [string],
  "good_to_have_skills": [string],
  "equivalent_skills": {{ "<must_have_skill>": [acceptable alternatives / related tech] }},
  "expected_project_types": [string],
  "preferred_certifications": [string],
  "key_responsibilities": [string],
  "domain": string,
  "summary": string
}}

Rules:
- Use "NA" for text fields not stated in the JD, 0 for min_experience_years if unstated.
- must_have_skills: max 15 items, normalised names (e.g. "React", "Python", "AWS").
- equivalent_skills maps each must-have to genuinely transferable alternatives.

JOB DESCRIPTION:
\"\"\"
{jd}
\"\"\""""


async def analyze_jd(client: httpx.AsyncClient, jd_text: str) -> dict:
    data = await _chat_json(
        client, JD_SYSTEM, JD_USER_TEMPLATE.format(jd=jd_text[:12000]), max_tokens=2500
    )
    data.setdefault("role_title", "NA")
    data.setdefault("must_have_skills", [])
    data.setdefault("good_to_have_skills", [])
    data.setdefault("equivalent_skills", {})
    data.setdefault("preferred_certifications", [])
    data.setdefault("expected_project_types", [])
    data.setdefault("min_experience_years", 0)
    data.setdefault("required_education", "NA")
    data.setdefault("summary", "NA")
    return data


# -------------------------------------------------------------- resume analysis
RESUME_SYSTEM = """You are a fair, bias-aware resume screening agent.

You do TWO things:
1. EXTRACT facts that are literally present in the resume. Never invent data.
   Any field that is genuinely absent must be the exact string "NA".
2. EVALUATE the candidate against the job rubric on five criteria:
   education, skills, experience, projects, certifications - each scored 0-100.

Fairness rules (critical):
- Do NOT reward or penalise based on name, gender, age, nationality, photo,
  marital status, address, college prestige, or employer brand.
- Judge capability, not keyword overlap. A candidate who demonstrates the
  required capability with different wording or an equivalent technology gets
  full credit (e.g. "built REST services in Flask" satisfies "Python web APIs").
- Evidence from projects counts as real experience for junior roles.
- Only penalise a genuinely missing capability, never a missing buzzword.

Respond with a single JSON object and nothing else."""

RESUME_USER_TEMPLATE = """JOB RUBRIC (derived from the JD):
{rubric}

SCORING GUIDE (0-100 per criterion):
- education: highest qualification vs the required education. Meets/exceeds = 85-100,
  related field = 65-84, unrelated but degreed = 40-64, none stated = 0-30.
- skills: coverage of must-have skills (counting equivalents), then good-to-have.
- experience: relevant years and depth vs min_experience_years and responsibilities.
- projects: relevance, complexity and ownership of projects vs expected_project_types.
- certifications: relevant certifications held vs preferred_certifications.
  If the JD lists no certifications, score 70 when the candidate has any relevant
  certification and 50 when none - never let this criterion alone sink a candidate.

Return JSON with exactly these keys:
{{
  "candidate_name": string,
  "phone_number": string,
  "email_id": string,
  "location": string,
  "skills": [string],
  "certifications": [string],
  "experience_years": number,
  "experience_summary": string,
  "highest_education": string,
  "education_details": string,
  "projects": [string],
  "current_role": string,
  "scores": {{
    "education": number, "skills": number, "experience": number,
    "projects": number, "certifications": number
  }},
  "matched_skills": [string],
  "missing_skills": [string],
  "transferable_strengths": [string],
  "red_flags": [string],
  "recommendation": "STRONG_MATCH" | "MATCH" | "BORDERLINE" | "WEAK",
  "justification": string
}}

Rules:
- skills: ONLY skills explicitly written in the resume. Do not infer extras.
- certifications: only real certifications named in the resume; [] if none.
- phone_number / email_id / candidate_name / location / highest_education /
  current_role / experience_summary / education_details: use "NA" when absent.
- experience_years: total relevant professional years as a number (0 if fresher).
- justification: 2-3 sentences, capability-based, referencing evidence.

RESUME TEXT:
\"\"\"
{resume}
\"\"\""""


async def evaluate_resume(client: httpx.AsyncClient, resume_text: str, rubric: dict) -> dict:
    rubric_slim = {
        k: rubric.get(k)
        for k in (
            "role_title", "seniority", "min_experience_years", "required_education",
            "must_have_skills", "good_to_have_skills", "equivalent_skills",
            "expected_project_types", "preferred_certifications", "key_responsibilities",
        )
    }
    prompt = RESUME_USER_TEMPLATE.format(
        rubric=json.dumps(rubric_slim, ensure_ascii=False, indent=2),
        resume=resume_text[: config.MAX_RESUME_CHARS],
    )
    return await _chat_json(client, RESUME_SYSTEM, prompt, max_tokens=2500)


# ------------------------------------------------------------ outreach drafting
INVITE_SYSTEM = """You are a recruitment coordinator drafting an interview invitation.

The email tells a shortlisted candidate that they have moved to the interview
stage, and gives them a personal link that starts their interview when they open
it. The interview is with an AI interviewer, is taken in the browser, and can be
taken whenever suits them - there is nothing to schedule.

Write in a warm, professional, plain-spoken register. Rules:
- Address the candidate by name. Never mention their gender, age, nationality,
  address, college or previous employer's prestige.
- Never state or imply a score, rank, ATS percentage or how they compared with
  other applicants. The candidate must not learn any internal scoring.
- Be honest: this is an invitation to interview, NOT a job offer. Say plainly
  that the interview is conducted by an AI interviewer - never imply a human
  will be on the call, and never give the interviewer a human backstory.
- Mention 1-2 genuine strengths drawn from the evidence given, so the email
  reads as personal rather than mass-produced.
- Put the exact placeholder [INTERVIEW_LINK] on a line of its own where the
  link belongs, usually just before the sign-off. Write nothing else about the
  URL: the real link and the practical instructions are inserted there
  automatically. Never write out a URL yourself, and never invent one.
- Do NOT invent a date, time, deadline, duration, question count, location,
  salary, benefit, or the name of a human interviewer. None of those exist.
- Tell them to reply if they need an adjustment in order to take part, or if
  they cannot use the link.
- 130-190 words in the body, not counting the placeholder line. No markdown, no
  bullet characters, plain text paragraphs separated by blank lines.

Respond with a single JSON object and nothing else."""

INVITE_USER_TEMPLATE = """Draft the interview invitation.

ROLE: {role_title}
COMPANY: {company}
SENDER NAME: {recruiter_name}
SENDER EMAIL: {recruiter_email}

CANDIDATE
  name: {name}
  current role: {current_role}
  evidence of strengths (use 1-2, rephrase naturally): {strengths}

Return JSON with exactly these keys:
{{
  "subject": string,
  "body": string,
  "greeting_name": string,
  "tone_note": string
}}

- subject: under 80 characters, states the role and that it is an interview
  invitation. No emoji.
- body: the full plain-text email including greeting and sign-off, with the
  placeholder [INTERVIEW_LINK] on its own line. No real URL, no date, no
  time, no deadline.
- greeting_name: the name used in the greeting, or "Candidate" if the name is NA.
- tone_note: one short sentence for the recruiter explaining what you emphasised."""


# The model is told to leave a placeholder and never to write the URL itself.
# Anything it might plausibly leave behind is accepted here, because a draft that
# silently loses its link is worse than a slightly odd looking one.
_LINK_PLACEHOLDER = re.compile(
    r"^[ 	]*[\[{(<]{0,2}\s*INTERVIEW[_ -]?LINK\s*[\]})>]{0,2}[ 	]*:?[ 	]*$",
    re.IGNORECASE | re.MULTILINE,
)
# Fallback insertion point: the sign-off paragraph.
_SIGNOFF = re.compile(
    r"^[ 	]*(best regards|kind regards|warm regards|regards|sincerely|"
    r"best wishes|many thanks|thanks|thank you|yours sincerely|yours faithfully)"
    r"[ 	]*,?[ 	]*$",
    re.IGNORECASE | re.MULTILINE,
)


def link_block(link: str) -> str:
    """The link and its instructions, written by us and not by the model.

    Every factual claim in here is true of the interviewer that is actually
    built: the link opens one candidate's own interview, there is no schedule,
    answers can be typed, and closing the tab mid-way resumes rather than
    restarts. The model is not allowed to write this paragraph precisely because
    it would invent a duration, a deadline or a question count.
    """
    return (
        "Start your interview here:\n"
        f"{link}\n\n"
        "The link is unique to you, so please do not share it. Your interview is "
        "with an AI interviewer that will ask about your background, your "
        "projects and a few scenarios, and will follow up on your answers as a "
        "conversation would. You can speak your answers or type them, whichever "
        "you prefer.\n\n"
        "There is nothing to schedule and no deadline in this email - open the "
        f"link whenever suits you. {config.INTERVIEW_BROWSER_NOTE} If you close "
        "the page part way through, opening the link again picks up where you "
        "left off."
    )


def _tidy(text: str) -> str:
    """One blank line between paragraphs, whatever the model produced.

    Removing a placeholder line leaves a gap, and the model's own spacing is not
    reliable, so paragraph spacing is normalised on the way out rather than left
    to chance in something a candidate will read.
    """
    return re.sub(r"\n{3,}", "\n\n", (text or "")).strip()


def inject_link(body: str, link: str) -> tuple[str, str]:
    """Put the real link into a drafted body. Returns (body, how_it_landed).

    `how_it_landed` is recorded on the draft so the recruiter can see whether the
    model cooperated - useful when a draft reads oddly.
    """
    text = (body or "").rstrip()
    if not link:
        # No secret configured: strip the placeholder rather than mailing the
        # literal word "[INTERVIEW_LINK]" to a candidate.
        return _tidy(_LINK_PLACEHOLDER.sub("", text)), "none"

    # Padded, then tidied, so the block always sits in its own paragraph however
    # the surrounding whitespace arrived.
    padded = f"\n\n{link_block(link)}\n\n"

    if _LINK_PLACEHOLDER.search(text):
        return _tidy(_LINK_PLACEHOLDER.sub(lambda _m: padded, text, count=1)), "placeholder"

    # The model ignored the placeholder. Slot the block in above the sign-off so
    # the mail still reads correctly.
    match = _SIGNOFF.search(text)
    if match:
        head, tail = text[: match.start()].rstrip(), text[match.start():]
        return _tidy(f"{head}{padded}{tail}"), "before-signoff"

    return _tidy(f"{text}{padded}"), "appended"


def display_name(raw) -> str:
    """A name fit to greet someone by.

    Resumes are routinely headed with the name in block capitals. Extraction
    keeps it verbatim - correct for the sheet - but "Hi PRIYA SUNDARAM," reads
    like a summons, so soften it for the greeting only.
    """
    name = str(raw or "").strip()
    if not name or name == "NA":
        return "Candidate"
    letters = [c for c in name if c.isalpha()]
    if letters and all(c.isupper() for c in letters):
        return name.title()
    return name


async def draft_interview_email(
    client: httpx.AsyncClient, candidate: dict, rubric: dict, ctx: dict,
    link: str = "",
) -> dict:
    """Draft one invitation for the recruiter to review, edit and approve.

    `link` is that candidate's interview link. The model only marks where it
    goes; inject_link() puts the real URL in, so a mangled or hallucinated
    address can never reach a candidate.
    """
    strengths = candidate.get("matched_skills") or candidate.get("skills") or "NA"
    if isinstance(strengths, list):
        strengths = ", ".join(str(s) for s in strengths)
    transferable = candidate.get("transferable_strengths")
    if isinstance(transferable, list):
        transferable = ", ".join(str(s) for s in transferable)
    if transferable and transferable != "NA":
        strengths = f"{strengths}; {transferable}"

    prompt = INVITE_USER_TEMPLATE.format(
        role_title=rubric.get("role_title") or ctx.get("job_title") or "the role",
        company=ctx.get("company", config.COMPANY_NAME),
        recruiter_name=ctx.get("recruiter_name", config.RECRUITER_NAME),
        recruiter_email=ctx.get("recruiter_email", config.RECRUITER_EMAIL),
        name=display_name(candidate.get("candidate_name")),
        current_role=candidate.get("current_role") or "NA",
        strengths=str(strengths)[:600] or "NA",
    )
    data = await _chat_json(client, INVITE_SYSTEM, prompt, max_tokens=1200)

    subject = str(data.get("subject") or "").strip()
    body = str(data.get("body") or "").strip()
    if not subject or not body:
        raise AIError("draft is missing a subject or body")

    body, placement = inject_link(body, link)
    return {
        "subject": subject,
        "body": body,
        "greeting_name": str(data.get("greeting_name") or "Candidate").strip(),
        "tone_note": str(data.get("tone_note") or "").strip(),
        "link_placement": placement,
    }


def fallback_email(candidate: dict, rubric: dict, ctx: dict, link: str = "") -> dict:
    """Deterministic template used when the AI draft fails, so the recruiter
    always has something editable in front of them.

    Carries the interview link too - a candidate should not be left waiting for a
    call that is never coming just because one AI request failed.
    """
    name = display_name(candidate.get("candidate_name"))
    role = rubric.get("role_title") or ctx.get("job_title") or "the role"
    company = ctx.get("company", config.COMPANY_NAME)
    recruiter = ctx.get("recruiter_name", config.RECRUITER_NAME)
    body = (
        f"Hi {name},\n\n"
        f"Thank you for applying for the {role} position at {company}. We have "
        f"reviewed your application and would like to invite you to the interview "
        f"stage.\n\n"
        "[INTERVIEW_LINK]\n\n"
        "If you have any questions, or need an adjustment in order to take part, "
        "just reply to this email and we will be glad to help.\n\n"
        f"Best regards,\n{recruiter}\n{company}"
    )
    if not link:
        # No link to give, so fall back to promising a follow-up instead of
        # leaving a hole where the instructions should be.
        body = body.replace(
            "[INTERVIEW_LINK]",
            "A member of our team will be in touch shortly to arrange the details "
            "with you.",
        )
        placement = "none"
    else:
        body, placement = inject_link(body, link)

    return {
        "subject": f"Interview invitation - {role} at {company}",
        "body": body,
        "greeting_name": name,
        "tone_note": "Standard template - the AI draft was unavailable.",
        "link_placement": placement,
    }


# ---------------------------------------------------------- deterministic backup
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE_RE = re.compile(r"(?:(?:\+\d{1,3})[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?)?\d{3}[\s-]?\d{4}\b")
YEARS_RE = re.compile(r"(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)\b", re.I)

_DEGREES = [
    "ph.d", "phd", "doctorate", "m.tech", "mtech", "m.e.", "m.sc", "msc", "mca",
    "mba", "master", "b.tech", "btech", "b.e.", "be ", "b.sc", "bsc", "bca",
    "bachelor", "diploma", "12th", "high school",
]


def fallback_parse(text: str, file_name: str) -> dict:
    """Regex extraction used when the AI call fails, so a row is still produced."""
    email = EMAIL_RE.search(text)
    phone = ""
    for match in PHONE_RE.finditer(text):
        digits = re.sub(r"\D", "", match.group(0))
        if 10 <= len(digits) <= 15:
            phone = match.group(0).strip()
            break

    name = "NA"
    for line in text.split("\n")[:8]:
        candidate = line.strip()
        if 3 <= len(candidate) <= 45 and not EMAIL_RE.search(candidate) and not any(
            ch.isdigit() for ch in candidate
        ):
            words = candidate.split()
            if 1 < len(words) <= 5 and all(w[:1].isalpha() for w in words):
                name = candidate.title()
                break
    if name == "NA":
        stem = file_name.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        stem = re.sub(r"[_\-]+", " ", stem)
        stem = re.sub(r"(?i)\b(resume|cv|final|updated|profile)\b", "", stem).strip()
        if stem:
            name = stem.title()

    lower = text.lower()
    education = "NA"
    for degree in _DEGREES:
        if degree in lower:
            education = degree.upper().strip()
            break

    years = 0.0
    matches = YEARS_RE.findall(text)
    if matches:
        try:
            years = max(float(m) for m in matches)
        except ValueError:
            years = 0.0

    return {
        "candidate_name": name,
        "phone_number": phone or "NA",
        "email_id": email.group(0) if email else "NA",
        "location": "NA",
        "skills": [],
        "certifications": [],
        "experience_years": years,
        "experience_summary": "NA",
        "highest_education": education,
        "education_details": "NA",
        "projects": [],
        "current_role": "NA",
        "scores": {k: 0 for k in config.CRITERIA},
        "matched_skills": [],
        "missing_skills": [],
        "transferable_strengths": [],
        "red_flags": ["AI evaluation unavailable - fields extracted heuristically"],
        "recommendation": "WEAK",
        "justification": "AI evaluation unavailable; manual review required.",
    }
