"""The interviewer AI: question planning, live follow-ups, per-answer grading,
and the final multi-parameter evaluation.

Talks to Azure OpenAI over plain HTTP (httpx) so no vendor SDK version is pinned,
matching the screening app. Every AI call has a deterministic fallback, so an
interview already in progress never dies on one failed request - the worst case
is a plainer question or an ungraded turn flagged for the reviewer.
"""
from __future__ import annotations

import asyncio
import json
import re

import httpx

from . import candidates, config

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
    }
    headers = {"api-key": config.AZURE_OPENAI_API_KEY, "Content-Type": "application/json"}

    last_error = ""
    for attempt in range(retries + 1):
        try:
            resp = await client.post(_chat_url(), json=body, headers=headers)
        except httpx.HTTPError as exc:
            last_error = f"network error: {exc}"
            await asyncio.sleep(1.5 * (attempt + 1))
            continue

        if resp.status_code == 400:
            detail = resp.text
            # Older deployments want max_tokens; newer ones want max_completion_tokens.
            if "max_completion_tokens" in detail and "max_tokens" in detail:
                body.pop("max_completion_tokens", None)
                body["max_tokens"] = max_tokens
                continue
            if "response_format" in detail:
                body.pop("response_format", None)
                continue
            raise AIError(f"Azure OpenAI rejected the request: {detail[:400]}")

        if resp.status_code in (429, 500, 502, 503, 504):
            wait = float(resp.headers.get("retry-after", 2 * (attempt + 1)))
            last_error = f"HTTP {resp.status_code}"
            await asyncio.sleep(min(wait, 20))
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
JD_SYSTEM = """You are an expert technical recruiter analysing a job description
so that an interviewer knows what to probe for.
Respond with a single JSON object and nothing else."""

JD_USER_TEMPLATE = """Analyse this Job Description and return JSON with exactly these keys:

{{
  "role_title": string,
  "seniority": string,
  "domain": string,
  "must_have_skills": [string],
  "good_to_have_skills": [string],
  "key_responsibilities": [string],
  "typical_challenges": [string],
  "summary": string
}}

Rules:
- Use "NA" for text fields the JD does not state.
- must_have_skills: max 15 normalised names (e.g. "React", "Python", "AWS").
- typical_challenges: real situations somebody in this role would face - these
  become the scenario questions, so make them concrete and role-specific.

JOB DESCRIPTION:
\"\"\"
{jd}
\"\"\""""


async def analyze_jd(client: httpx.AsyncClient, jd_text: str) -> dict:
    """Only called when the JD arrives without a rubric.

    A shortlist imported from the screening app already carries `jd_analysis`,
    so this is skipped on that path.
    """
    data = await _chat_json(
        client, JD_SYSTEM, JD_USER_TEMPLATE.format(jd=jd_text[:12000]), max_tokens=2000
    )
    data.setdefault("role_title", "NA")
    data.setdefault("must_have_skills", [])
    data.setdefault("good_to_have_skills", [])
    data.setdefault("key_responsibilities", [])
    data.setdefault("typical_challenges", [])
    data.setdefault("domain", "NA")
    data.setdefault("summary", "NA")
    return data


# ----------------------------------------------------------------- question plan
PLAN_SYSTEM = """You are a senior interviewer preparing to interview one specific
candidate for one specific role. You write the question plan.

How a good human interviewer works, and therefore how you write:
- Every question is grounded in THIS candidate's resume or THIS job description.
  Name their actual project, their actual technology, their actual role. A
  question that could be asked of any candidate is a wasted question.
- You ask one thing at a time, in plain spoken English, 30 words or fewer. The
  question will be read aloud by a voice, so no bullet lists, no code blocks, no
  "a) b) c)", no markdown.
- You probe capability, not trivia. Never ask for a memorised definition when you
  could ask how they used the thing.
- You never ask about age, gender, marital or family status, religion, caste,
  nationality, health, disability, pregnancy, politics, salary history or
  personal life. If the resume mentions any of those, ignore it.
- You do not comment on which college or employer they came from.
- Difficulty is calibrated to the experience the resume shows. A fresher gets
  fundamentals and project questions; a senior gets design, trade-offs and
  ownership.

Respond with a single JSON object and nothing else."""

PLAN_USER_TEMPLATE = """Write the interview plan.

ROLE: {role_title}
JOB DESCRIPTION RUBRIC:
{rubric}

CANDIDATE BRIEFING (from their resume):
{resume}

Produce exactly {count} questions, in the order they will be asked, matching this
category mix as closely as the material allows:
{mix}

What each category means:
{category_help}

Return JSON with exactly these keys:
{{
  "opening_line": string,
  "questions": [
    {{
      "category": one of [{category_names}],
      "question": string,
      "intent": string,
      "focus": string,
      "difficulty": "easy" | "medium" | "hard",
      "expected_points": [string],
      "emotion": "friendly" | "neutral" | "curious"
    }}
  ],
  "closing_line": string,
  "notes_for_reviewer": string
}}

Rules:
- opening_line: what the interviewer says to greet the candidate and set the
  scene, 2-3 sentences, spoken aloud. Address them by first name, say broadly what
  ground you will cover, and invite them to think aloud and take their time. Do
  not ask a question in it. Do not state a duration or a number of questions -
  follow-up questions are added live, so any figure you give would be wrong.
- closing_line: how the interviewer wraps up, 1-2 sentences, spoken aloud. Thank
  them and say the team will follow up. Promise no decision, date or outcome.
- question: the exact words to be spoken. 30 words or fewer. One question only.
- intent: one line for the reviewer on what this question is testing.
- focus: the specific resume item, skill or JD requirement being probed, or "NA".
- expected_points: 2-4 things a strong answer would touch on. This is the grading
  key, not something the candidate is shown.
- The first question must be the introduction and the last must be the closing.
- Do not number the questions in their text.
- Use ONLY the categories listed above. They are what this interview is meant to
  cover and the list is closed - do not introduce any other category, however
  tempting the resume makes it look. If the material for one is thin, ask a
  broader question inside that category rather than reaching for another."""


def _category_help(keys=None) -> str:
    wanted = list(keys) if keys else list(config.CATEGORIES)
    return "\n".join(
        f"- {key}: {config.CATEGORIES[key]['about']}"
        for key in wanted if key in config.CATEGORIES
    )


def _mix_text(mix: dict) -> str:
    return "\n".join(f"- {key}: {count}" for key, count in mix.items() if count > 0)


async def build_question_plan(
    client: httpx.AsyncClient,
    candidate: dict,
    rubric: dict,
    mix: dict,
    count: int,
) -> dict:
    rubric_slim = {
        k: rubric.get(k)
        for k in ("role_title", "seniority", "domain", "must_have_skills",
                  "good_to_have_skills", "key_responsibilities", "typical_challenges")
        if rubric.get(k)
    }
    # Only the categories the recruiter asked for are offered. They used to all be
    # listed with the mix as a mere suggestion, and the model would cheerfully add
    # a project question to a plan that had excluded projects.
    allowed = [k for k in config.CATEGORIES if k in mix]
    prompt = PLAN_USER_TEMPLATE.format(
        role_title=rubric.get("role_title") or "NA",
        rubric=json.dumps(rubric_slim, ensure_ascii=False, indent=2) or "NA",
        resume=candidates.resume_context(candidate),
        count=count,
        mix=_mix_text(mix),
        category_help=_category_help(allowed),
        category_names=", ".join(f'"{k}"' for k in allowed),
    )
    data = await _chat_json(client, PLAN_SYSTEM, prompt, max_tokens=3500)

    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        raise AIError("the plan came back with no questions")

    cleaned = [_clean_question(q, allowed) for q in questions if isinstance(q, dict)]
    # A stray is kept with its true category rather than silently relabelled: a
    # question written to probe a project IS a project question whatever we call
    # it, and evaluation.py weights it by that. The recruiter is told instead.
    strays = sorted({q["category"] for q in cleaned if q["category"] not in allowed})

    return {
        "opening_line": str(data.get("opening_line") or "").strip(),
        "closing_line": str(data.get("closing_line") or "").strip(),
        "notes_for_reviewer": str(data.get("notes_for_reviewer") or "").strip(),
        "questions": cleaned,
        "requested_categories": allowed,
        "category_strays": strays,
    }


def _clean_question(raw: dict, allowed: list[str] | None = None) -> dict:
    category = str(raw.get("category") or "").strip().lower()
    if category not in config.CATEGORIES:
        # An invented name falls back to a permitted BODY category - never intro
        # or closing, which are one-per-interview, and no longer always
        # "technical", which mislabelled plans that had excluded technical.
        pool = [k for k in (allowed or list(config.CATEGORIES))
                if k not in ("intro", "closing")]
        category = max(pool, key=lambda k: config.CATEGORIES[k]["weight"]) if pool \
            else (allowed or list(config.CATEGORIES))[0]
    difficulty = str(raw.get("difficulty") or "medium").strip().lower()
    if difficulty not in ("easy", "medium", "hard"):
        difficulty = "medium"
    emotion = str(raw.get("emotion") or "neutral").strip().lower()
    if emotion not in ("friendly", "neutral", "curious"):
        emotion = "neutral"
    points = raw.get("expected_points")
    if not isinstance(points, list):
        points = []
    return {
        "category": category,
        "question": str(raw.get("question") or "").strip(),
        "intent": str(raw.get("intent") or "").strip(),
        "focus": str(raw.get("focus") or "NA").strip(),
        "difficulty": difficulty,
        "expected_points": [str(p).strip() for p in points if str(p).strip()][:4],
        "emotion": emotion,
    }


# --------------------------------------------------- per-answer grade + follow-up
#
# One call does both jobs. Grading and "should I dig deeper here?" need exactly
# the same context, and the candidate is sitting there waiting - two round trips
# would double the silence between turns.

ASSESS_SYSTEM = """You are a senior interviewer, mid-interview. The candidate has
just answered. You do two things at once: grade that answer, and decide whether a
human interviewer would follow up on it.

Grading rules:
- Grade only what the answer demonstrates. Never grade the resume, and never let
  an earlier answer raise or lower this one.
- Score only the parameters this particular answer can speak to, and list those
  in "applicable". An introduction cannot show problem solving; say so by leaving
  it out rather than scoring it low.
- Reward specifics, ownership and honest uncertainty ("I have not used that, but
  here is how I would approach it" is a good answer, not a failure).
- Penalise vagueness, buzzword recitation, and claims the answer cannot support.
- Judge communication on clarity and structure ONLY. Accent, dialect, grammar
  slips, filler words and non-native phrasing must never lower the score. The
  answer arrives as speech-to-text, so expect transcription noise and missing
  punctuation, and never penalise it.
- If the answer is empty, "I do not know", or a request to skip, mark
  answer_type "no_answer", score nothing, and do not follow up.

Follow-up rules - follow up when a human would:
- The answer is interesting but shallow: ask for the mechanism or the trade-off.
- They claimed a result with no evidence: ask what their own part was.
- They said something questionable: ask about it neutrally, never combatively.
- Do NOT follow up to be thorough. If the answer was complete, move on.
- A follow-up is one spoken question, 25 words or fewer, referring to what they
  actually just said.

Reaction rules:
- "line" is the short human acknowledgement said before the next question. One
  sentence, 12 words or fewer. Natural: "Got it, thank you." / "That is a useful
  example." Never praise or judge the quality out loud, never say a score, and
  never say "correct" or "wrong".
- The line must NOT contain a question, and must not contain a question mark. The
  next question is asked separately and immediately after it; putting a question
  in here means the candidate is asked two things at once. If you want to ask
  something, that is what "followup" is for.

Respond with a single JSON object and nothing else."""

ASSESS_USER_TEMPLATE = """ROLE: {role_title}

QUESTION JUST ASKED ({category}, difficulty {difficulty}):
"{question}"

WHAT THIS QUESTION WAS TESTING: {intent}
WHAT A STRONG ANSWER WOULD TOUCH ON: {expected}

CANDIDATE'S ANSWER (speech-to-text, may be unpunctuated):
\"\"\"
{answer}
\"\"\"

ANSWER SIGNALS: {words} words, answered in {seconds} seconds, entered by {mode}.
FOLLOW-UPS ALREADY ASKED ON THIS QUESTION: {followups_used} of {followups_max}
QUESTIONS REMAINING AFTER THIS ONE: {remaining}

RELEVANT RESUME CONTEXT (for judging whether the answer is really theirs):
{resume_snippet}

Return JSON with exactly these keys:
{{
  "answer_type": "substantive" | "partial" | "evasive" | "off_topic" | "no_answer",
  "applicable": [parameter names you scored],
  "scores": {{ "<parameter>": number 0-100 }},
  "covered_points": [string],
  "missed_points": [string],
  "strengths": [string],
  "concerns": [string],
  "evidence": string,
  "followup": {{
    "needed": boolean,
    "question": string,
    "reason": string,
    "probe": "depth" | "clarify" | "example" | "challenge" | "none"
  }},
  "reaction": {{
    "line": string,
    "emotion": "encouraging" | "curious" | "thinking" | "neutral"
  }}
}}

Available parameters: {parameters}

- "scores" contains a key for every parameter in "applicable" and no others.
- evidence: a short paraphrase or quote from the answer that justifies the grade.
- If followup.needed is false, set question to "" and probe to "none".
- If followups_used has reached followups_max, or QUESTIONS REMAINING is 0,
  followup.needed must be false."""


async def assess_turn(client: httpx.AsyncClient, ctx: dict) -> dict:
    prompt = ASSESS_USER_TEMPLATE.format(
        role_title=ctx.get("role_title") or "NA",
        category=ctx.get("category"),
        difficulty=ctx.get("difficulty", "medium"),
        question=ctx.get("question"),
        intent=ctx.get("intent") or "NA",
        expected=", ".join(ctx.get("expected_points") or []) or "NA",
        answer=(ctx.get("answer") or "")[:6000],
        words=ctx.get("words", 0),
        seconds=ctx.get("seconds", 0),
        mode=ctx.get("mode", "voice"),
        followups_used=ctx.get("followups_used", 0),
        followups_max=ctx.get("followups_max", config.MAX_FOLLOWUPS_PER_QUESTION),
        remaining=ctx.get("remaining", 0),
        resume_snippet=(ctx.get("resume_snippet") or "NA")[:2000],
        parameters=", ".join(config.PARAMETERS),
    )
    data = await _chat_json(client, ASSESS_SYSTEM, prompt, max_tokens=1800)
    return clean_assessment(data)


def _str_list(value, limit: int = 6) -> list[str]:
    """The string-list fields the model returns, cleaned and capped."""
    if not isinstance(value, list):
        return []
    return [str(v).strip() for v in value if str(v).strip()][:limit]


# A question tacked onto the end of the acknowledgement, after a dash or comma:
#   "That is a clear plan - how did you measure the impact?"
# The prompt forbids it and the model still does it perhaps one time in five, so
# it gets removed here as well. Left in, it is spoken immediately before the next
# question and the candidate is asked two things at once.
_QUESTION_TAIL = re.compile(r"[—–\-.,;:]\s*[^—–\-.,;:]*\?.*$")


def _reaction_line(raw) -> str:
    line = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not line or "?" not in line:
        return line[:160]
    trimmed = _QUESTION_TAIL.sub("", line).strip(" —–-,;:")
    # If the acknowledgement was nothing but a question, there is nothing worth
    # keeping - the next question stands on its own. A bare "Thanks" is fine.
    if "?" in trimmed or not trimmed.split():
        return ""
    return trimmed[:160]


def clean_assessment(raw: dict) -> dict:
    """Normalise whatever the model returned into the stored turn shape."""
    answer_type = str(raw.get("answer_type") or "substantive").strip().lower()
    if answer_type not in ("substantive", "partial", "evasive", "off_topic", "no_answer"):
        answer_type = "substantive"

    applicable = [p for p in (raw.get("applicable") or []) if p in config.PARAMETERS]
    scores_raw = raw.get("scores") or {}
    scores: dict[str, float] = {}
    for key in applicable or list(scores_raw):
        if key not in config.PARAMETERS:
            continue
        try:
            scores[key] = max(0.0, min(100.0, float(scores_raw.get(key, 0))))
        except (TypeError, ValueError):
            continue
    if not applicable:
        applicable = list(scores)

    followup_raw = raw.get("followup") or {}
    probe = str(followup_raw.get("probe") or "none").strip().lower()
    if probe not in ("depth", "clarify", "example", "challenge", "none"):
        probe = "none"
    followup_question = str(followup_raw.get("question") or "").strip()
    followup_needed = bool(followup_raw.get("needed")) and bool(followup_question)

    reaction_raw = raw.get("reaction") or {}
    emotion = str(reaction_raw.get("emotion") or "neutral").strip().lower()
    if emotion not in ("encouraging", "curious", "thinking", "neutral"):
        emotion = "neutral"

    return {
        "answer_type": answer_type,
        "applicable": applicable,
        "scores": {k: round(v, 1) for k, v in scores.items()},
        "covered_points": _str_list(raw.get("covered_points")),
        "missed_points": _str_list(raw.get("missed_points")),
        "strengths": _str_list(raw.get("strengths")),
        "concerns": _str_list(raw.get("concerns")),
        "evidence": str(raw.get("evidence") or "").strip()[:600],
        "followup": {
            "needed": followup_needed,
            "question": followup_question,
            "reason": str(followup_raw.get("reason") or "").strip(),
            "probe": probe if followup_needed else "none",
        },
        "reaction": {
            "line": _reaction_line(reaction_raw.get("line")),
            "emotion": emotion,
        },
        "source": "ai",
        "error": "",
    }


# ---------------------------------------------------------- final evaluation
FINAL_SYSTEM = """You are a senior interviewer writing up an interview you have
just finished. You have the full transcript.

Rules:
- Judge the INTERVIEW, not the resume. A strong resume with weak answers scores
  low; a modest resume with excellent answers scores high. That is the point of
  this stage.
- Score every parameter 0-100 using the whole transcript. Where the interview
  produced no evidence for a parameter, say so in its note and score it 50
  rather than 0 - absence of evidence is not evidence of weakness.
- Communication is clarity, structure and listening ONLY. Accent, dialect,
  grammar and non-native phrasing must never count against the candidate. The
  transcript came from speech-to-text and contains transcription errors.
- Ignore name, gender, age, nationality, caste, religion, address, college
  prestige and employer brand entirely.
- Be specific and quote the transcript. A reviewer must be able to check every
  claim you make against what was actually said.
- Be honest about weakness, and equally honest about what the interview simply
  did not cover.
- Recommend a next step, never a final decision. A human makes the decision.

Respond with a single JSON object and nothing else."""

FINAL_USER_TEMPLATE = """Write up this interview.

ROLE: {role_title}
JOB REQUIREMENTS: {requirements}

CANDIDATE BRIEFING (resume - context only, do NOT grade it):
{resume}

TRANSCRIPT ({turn_count} answered questions):
{transcript}

INTERVIEW SIGNALS: {answered} of {asked} questions answered, {skipped} skipped or
unanswered, {followups} follow-up questions asked, total speaking time about
{minutes} minutes.

Return JSON with exactly these keys:
{{
  "scores": {{ "<parameter>": number 0-100 }},
  "parameter_notes": {{ "<parameter>": string }},
  "strengths": [string],
  "gaps": [string],
  "standout_moments": [string],
  "not_covered": [string],
  "risk_flags": [string],
  "summary": string,
  "recommended_next_step": string,
  "confidence": "high" | "medium" | "low"
}}

Parameters (score every one): {parameters}

- parameter_notes: one or two sentences per parameter, referencing the transcript.
- strengths / gaps: 2-5 each, drawn from what was said, not from the resume.
- standout_moments: specific answers worth a reviewer's attention, with a short
  quote. [] if there were none.
- not_covered: capabilities the role needs that this interview did not test.
- risk_flags: only real concerns from the transcript - contradictions, claimed
  work they could not explain, refusal to engage. [] if none. Never a flag for
  nervousness, accent or short answers alone.
- summary: 3-5 sentences a hiring manager can read on its own.
- recommended_next_step: what should happen next and why, one or two sentences.
  Suggest a next step, never "hire" or "reject".
- confidence: how much the transcript actually supports this write-up. Say "low"
  when the interview was short or thin."""


def _transcript_text(turns: list[dict], limit: int = 22000) -> str:
    blocks = []
    for turn in turns:
        if not (turn.get("answer") or "").strip():
            continue
        tag = "FOLLOW-UP" if turn.get("question_source") == "followup" else turn.get("category", "")
        blocks.append(
            f"[Q{turn.get('turn')} · {tag}] Interviewer: {turn.get('question')}\n"
            f"Candidate: {turn.get('answer')}"
        )
    text = "\n\n".join(blocks)
    return text[:limit] if len(text) > limit else text


async def final_evaluation(client: httpx.AsyncClient, interview: dict) -> dict:
    turns = interview.get("turns", [])
    answered = [t for t in turns if (t.get("answer") or "").strip()]
    rubric = interview.get("jd_analysis") or {}
    requirements = ", ".join(rubric.get("must_have_skills") or []) or "NA"
    total_seconds = sum(float(t.get("answer_seconds") or 0) for t in turns)

    prompt = FINAL_USER_TEMPLATE.format(
        role_title=rubric.get("role_title") or interview.get("job_title") or "NA",
        requirements=requirements,
        resume=candidates.resume_context(interview.get("candidate", {}))[:3000],
        turn_count=len(answered),
        transcript=_transcript_text(turns) or "The candidate did not answer any questions.",
        answered=len(answered),
        asked=len(turns),
        skipped=len(turns) - len(answered),
        followups=sum(1 for t in turns if t.get("question_source") == "followup"),
        minutes=round(total_seconds / 60.0, 1),
        parameters=", ".join(config.PARAMETERS),
    )
    data = await _chat_json(client, FINAL_SYSTEM, prompt, max_tokens=3000)
    return clean_final(data)


def clean_final(raw: dict) -> dict:
    scores_raw = raw.get("scores") or {}
    scores: dict[str, float] = {}
    for key in config.PARAMETERS:
        try:
            scores[key] = max(0.0, min(100.0, float(scores_raw.get(key, 50))))
        except (TypeError, ValueError):
            scores[key] = 50.0

    notes_raw = raw.get("parameter_notes") or {}
    notes = {k: str(notes_raw.get(k) or "").strip() for k in config.PARAMETERS}

    confidence = str(raw.get("confidence") or "medium").strip().lower()
    if confidence not in ("high", "medium", "low"):
        confidence = "medium"

    return {
        "scores": {k: round(v, 1) for k, v in scores.items()},
        "parameter_notes": notes,
        "strengths": _str_list(raw.get("strengths")),
        "gaps": _str_list(raw.get("gaps")),
        "standout_moments": _str_list(raw.get("standout_moments")),
        "not_covered": _str_list(raw.get("not_covered")),
        "risk_flags": _str_list(raw.get("risk_flags")),
        "summary": str(raw.get("summary") or "").strip(),
        "recommended_next_step": str(raw.get("recommended_next_step") or "").strip(),
        "confidence": confidence,
        "source": "ai",
    }


# ------------------------------------------------------------------- fallbacks
#
# Used when a call fails. They keep the interview running - a plainer question is
# far better than a dead session - and every fallback is labelled in the record so
# a reviewer can see the AI was not involved.

def _split_list(value) -> list[str]:
    if isinstance(value, (list, tuple)):
        items = [str(v).strip() for v in value]
    elif isinstance(value, str) and value.strip() and value.strip() != "NA":
        items = [p.strip() for p in re.split(r"[,;·]|\.\s", value)]
    else:
        items = []
    return [i for i in items if i and i != "NA"][:12]


def fallback_plan(candidate: dict, rubric: dict, count: int) -> dict:
    """A grounded question plan built from the resume fields, no AI involved.

    Still candidate-specific - it names their real skills and projects - just
    less imaginative than the model's.
    """
    name = candidates.display_name(candidate.get("candidate_name"))
    role = rubric.get("role_title") or "this role"
    skills = _split_list(candidate.get("matched_skills")) or _split_list(candidate.get("skills"))
    projects = _split_list(candidate.get("projects"))
    must_have = _split_list(rubric.get("must_have_skills"))
    responsibilities = _split_list(rubric.get("key_responsibilities"))
    domain = rubric.get("domain") or "your field"

    def q(category, question, intent, focus="NA", difficulty="medium", points=None):
        return _clean_question({
            "category": category, "question": question, "intent": intent,
            "focus": focus, "difficulty": difficulty,
            "expected_points": points or [], "emotion": "neutral",
        })

    questions = [q(
        "intro",
        "To start, tell me a little about yourself and the work you are doing at the moment.",
        "Opens the conversation and checks they can summarise their own background.",
        difficulty="easy",
        points=["current role and scope", "relevant background", "why this role"],
    )]

    if candidate.get("experience") and str(candidate.get("experience")) != "NA":
        questions.append(q(
            "resume",
            "Walk me through your most recent role and what you owned there day to day.",
            "Tests whether the experience on the resume holds up when described.",
            focus=str(candidate.get("current_role") or "NA"),
            points=["their own responsibilities", "scale or context", "concrete outcome"],
        ))

    for project in projects[:2]:
        short = project.split(":")[0][:70]
        questions.append(q(
            "project",
            f"Tell me about {short}. What was the problem, and what did you build?",
            "Checks genuine understanding of a project they listed.",
            focus=short,
            points=["the problem", "their design decisions", "their own contribution",
                    "what they would change"],
        ))

    for skill in skills[:2]:
        questions.append(q(
            "technical",
            f"You have listed {skill}. Tell me about a time it did not behave as you "
            "expected, and how you worked it out.",
            f"Probes real depth in {skill} rather than familiarity with the word.",
            focus=skill,
            points=["a specific situation", "how they diagnosed it", "what they learned"],
        ))

    questions.append(q(
        "domain",
        f"What do you think separates good work from average work in {domain}?",
        "Tests understanding of the field beyond the tooling.",
        focus=str(domain),
        points=["a considered opinion", "practical reasoning", "an example"],
    ))

    if must_have or responsibilities:
        target = (responsibilities or must_have)[0]
        questions.append(q(
            "jd",
            f"This role involves {str(target)[:90]}. What experience do you have that "
            "prepares you for that?",
            "Maps their experience onto a stated requirement of the role.",
            focus=str(target)[:90],
            points=["relevant evidence", "honest gaps", "transferable experience"],
        ))

    questions.append(q(
        "scenario",
        "Imagine you inherit a system you did not build, it is failing in production, "
        "and the person who wrote it has left. What are your first steps?",
        "Scenario question on judgement under pressure and prioritisation.",
        difficulty="hard",
        points=["stabilise first", "gather information", "communicate", "then fix properly"],
    ))
    questions.append(q(
        "problem_solving",
        "Tell me about the hardest problem you have solved recently. I am more "
        "interested in how you approached it than in the answer.",
        "Judged on reasoning and structure, not on the outcome.",
        difficulty="hard",
        points=["how they framed it", "what they tried", "how they decided",
                "what they learned"],
    ))
    questions.append(q(
        "closing",
        "That is everything from me. Is there anything you would like to add, or "
        "anything you would like to ask?",
        "Gives them the floor and shows what they are curious about.",
        difficulty="easy",
        points=["a considered question", "anything they want on the record"],
    ))

    questions = questions[:max(count, 4)]
    return {
        "opening_line": (
            f"Hello {name}, thank you for making the time today. I am "
            f"{config.INTERVIEWER_NAME}, and I will be talking with you about the "
            f"{role} position. This should take about twenty minutes. Please think "
            "aloud as you answer, and take your time."
        ),
        "closing_line": (
            "Thank you, that is everything from my side. The team will review our "
            "conversation and be in touch with you about the next step."
        ),
        "notes_for_reviewer": "Fallback plan - generated without AI from the resume fields.",
        "questions": questions,
        "source": "fallback",
    }


def fallback_assessment(answer: str, words: int, error: str = "") -> dict:
    """No grades - just an honest record that this turn was not graded.

    Deliberately scores nothing. Inventing numbers from a word count would put
    fake evidence in front of a reviewer, which is worse than a visible gap;
    evaluation.py treats an ungraded turn as missing, not as zero.
    """
    text = (answer or "").strip()
    if not text or words < 3:
        answer_type, line = "no_answer", "That is alright, let us move on."
    elif words < config.MIN_ANSWER_WORDS_FOR_FOLLOWUP:
        answer_type, line = "partial", "Thank you."
    else:
        answer_type, line = "substantive", "Got it, thank you."
    return {
        "answer_type": answer_type,
        "applicable": [],
        "scores": {},
        "covered_points": [],
        "missed_points": [],
        "strengths": [],
        "concerns": [],
        "evidence": "",
        "followup": {"needed": False, "question": "", "reason": "", "probe": "none"},
        "reaction": {"line": line, "emotion": "neutral"},
        "source": "fallback",
        "error": error or "This answer was not graded - the AI call failed.",
    }


def fallback_final(interview: dict, error: str = "") -> dict:
    """A write-up shell when the holistic call fails.

    The per-answer grades that did succeed are still aggregated by
    evaluation.py, so the report is thin but not empty or invented.
    """
    turns = interview.get("turns", [])
    answered = [t for t in turns if (t.get("answer") or "").strip()]
    ungraded = [t for t in answered if not (t.get("assessment", {}).get("scores"))]
    return {
        "scores": {},
        "parameter_notes": {k: "" for k in config.PARAMETERS},
        "strengths": [],
        "gaps": [],
        "standout_moments": [],
        "not_covered": [],
        "risk_flags": [],
        "summary": (
            f"The closing AI review could not be produced, so this report is built "
            f"only from the per-answer grades that succeeded during the interview "
            f"({len(answered) - len(ungraded)} of {len(answered)} answers graded). "
            "The transcript is complete and needs a human read."
        ),
        "recommended_next_step": "A human reviewer should read the transcript in full.",
        "confidence": "low",
        "source": "fallback",
        "error": error,
    }
