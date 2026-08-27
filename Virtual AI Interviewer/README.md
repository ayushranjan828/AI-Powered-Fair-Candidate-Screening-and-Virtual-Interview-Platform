# Virtual AI Interviewer

Shortlisted candidate in → questions written from **their** resume and **this** JD → a spoken interview with an animated 2D interviewer that asks live follow-ups → a multi-parameter evaluation of how they actually performed → report + Excel export.

The companion to [Candidate screening](../Candidate%20screening/README.md). The screening stage judges a resume; this stage judges the person, and the two scores are deliberately shown side by side.

Stack: **HTML / CSS / JS** front end (no framework, no build step), **Python + FastAPI** back end, **JSON** file storage, **Azure OpenAI** via `.env`, **Web Speech API** for voice.

---

## Why performance, not paper

A resume tells you what somebody wrote about themselves. This stage asks them about it.

- Questions are generated from the candidate's own projects, skills and role, plus the JD's responsibilities — never from a fixed question bank.
- The interviewer **does not know the ATS score**. `resume_context()` in [candidates.py](backend/candidates.py) deliberately strips the score, screening status and recommendation before the resume ever reaches the model, so a 92% resume gets no easier a ride than a 61% one.
- Follow-ups are written live from the answer just given, so depth is tested rather than recall.
- The final score comes from the transcript. A strong resume with weak answers scores low, and vice versa — that divergence is the entire value of interviewing.

The first real run scored a candidate **53% at interview against a 92% resume ATS**, with the write-up quoting the two questions they had not actually answered. That is the mechanism working.

---

## Setup

```powershell
# 1. dependencies (same venv as the screening app)
.\myenv\Scripts\pip.exe install -r requirements.txt

# 2. .env — nothing extra needed. Config walks up from this folder to the
#    repo-root .env that the screening app already uses. See .env.example
#    for interviewer-specific overrides (name, question count, weights).

# 3. run  (port 8010, so it coexists with the screening app on 8000)
cd "Virtual AI Interviewer"
..\myenv\Scripts\python.exe run.py
```

Open <http://127.0.0.1:8010>. Click the **AI** pill in the header for a live connectivity check.

**Use Chrome or Edge.** Both halves of the voice interface are browser APIs: `speechSynthesis` for the interviewer's voice and `SpeechRecognition` for the candidate's answers. Both degrade rather than break — see [Voice](#voice).

---

## Flow

**1 · Set up** — pick a candidate from an accepted screening shortlist (read straight out of the screening app's `data/history/`), or type one in by hand. The JD and the rubric the screening agent already extracted are filled in automatically. Choose how many planned questions, how hard to dig, which categories, the voice, and the evaluation weights. **Prepare the interview** writes the plan in the background.

**2 · Interview** — the 2D interviewer greets the candidate by name, then works through the plan. Each question is spoken aloud with a live caption; the candidate answers by voice (transcribed in the browser) or by typing. Between questions the interviewer acknowledges the answer and either moves on or follows up on it. **Repeat question**, **Mute voice** and **Skip** are always available.

**3 · Report** — overall score, verdict, per-parameter breakdown with the reasoning behind each number, strengths, gaps, standout moments, what the interview failed to cover, risk flags, and a recommended next step. Then the transcript with the grade given to every single answer. A human records the actual decision at the bottom.

**4 · History** — every interview, resumable if it was interrupted, re-reviewable, exportable, deletable.

Any interview can be reopened directly at `/?interview=INT-XXXXXXXX`.

---

## The 2D interviewer

[avatar.js](frontend/avatar.js) is an SVG rig driven by one `requestAnimationFrame` loop. It is not a video, a GIF or a sprite sheet — every part is a shape whose numbers are recomputed each frame, which is what lets the mouth follow real speech instead of looping a canned animation.

**Eyes.** Sclera, iris that tracks a gaze target, pupil, catch-light, and an eyelid that scales down from the top to blink. Blinks fire at randomised intervals and cluster into occasional double-blinks, because a fixed interval reads as a metronome. Gaze makes small saccades, looks away while thinking, and drops to the notepad while taking notes.

**Mouth.** 17 visemes, defined as *parameters* (`open`, `wide`, `round`, `tongue`, `teeth`, `bite`) rather than fixed paths, so any two shapes blend cleanly on the way past each other. The lens path, lip line, teeth and tongue are regenerated from those numbers every frame. Measured openings: `AA` 42 units tall, `MBP` 5; `EE` 65 wide, `OO` 28.

**Hands.** Two arms, each a shoulder → elbow → wrist chain of nested rotations, drawn in front of the torso so the sleeves read as arms. At rest both hands sit on the desk with a pen. While speaking, the free hand keeps time with the voice — beat gestures land on loud syllables, which is what makes speech look intentional — and cycles between postures so it never freezes in one gesture. While listening it writes on the notepad; while thinking it comes up to the face.

**The rest.** Torso breathing, idle head sway from two out-of-phase sines, head tilt per emotion, acknowledging nods, and brows and lids that carry five expressions (neutral, friendly, curious, encouraging, thinking).

Everything eases toward a target rather than being set directly, so state changes read as movement instead of a jump cut. `prefers-reduced-motion` damps the idle motion but keeps lip sync, which is informative rather than decorative.

### How the mouth stays in time

[speech.js](frontend/speech.js) builds a viseme timeline from the same text the synthesiser is given: graphemes are mapped to visemes (two-letter clusters first, so `sh` is not read as `s` + `h`), vowels get longer durations than consonants, punctuation becomes a pause, and the whole thing is scaled by the speaking rate. At rate 1.0 this lands on **140 wpm**, inside the natural range.

There is no way to read the synthesiser's audio from a page, so the timeline drives the mouth — but `onboundary` events snap the playhead to the word actually being spoken, so drift never accumulates over a long question. On voices that fire no boundary events, the estimate carries the whole utterance.

---

## Questions and follow-ups

The plan is written once, up front, by [`build_question_plan`](backend/ai_agent.py) across nine categories — introduction, resume, project deep-dive, technical skills, domain knowledge, JD fit, scenario, problem solving, closing. Each planned question carries its intent, the specific resume item it probes, a difficulty, and 2–4 `expected_points` that act as the grading key.

Follow-ups are decided per answer. Grading and "would a human dig here?" need identical context and the candidate is sitting there waiting, so [`assess_turn`](backend/ai_agent.py) does both in **one** call and returns the acknowledgement line as well.

The model proposes; [`_queue_followup`](backend/interview.py) decides. It refuses a follow-up when the answer was a non-answer or off-topic, when the per-question budget is spent, when the interview has hit `MAX_TOTAL_TURNS`, or when only the closing question remains — the question that hands the candidate the floor always survives. The model has no view of the turn budget and every incentive to keep digging, so those limits are code, not prompt.

Two guards exist because the model reliably misbehaves without them:

- The acknowledgement line is stripped of any trailing question (`_reaction_line`). Left in, it is spoken immediately before the next question and the candidate is asked two things at once.
- The opening line may not state a duration or a question count, because follow-ups make any figure wrong.

---

## Evaluation

Seven parameters, each 0–100:

| Parameter | Weight | What it measures |
|---|---|---|
| Technical knowledge | 20% | Depth and correctness on the technologies discussed |
| Communication | 15% | Clarity, structure, listening |
| Domain knowledge | 15% | The field beyond the specific tools |
| Project understanding | 15% | Real grasp of their own projects — decisions, trade-offs, their part |
| Problem solving | 15% | Reasoning and structure on unfamiliar problems |
| JD alignment | 10% | Evidence of what this specific role needs |
| Answer quality | 10% | Relevance, specificity, evidence |

Each score is a blend of two independent views, both kept in the record:

1. the **weighted mean of the per-answer grades**, where each turn's weight is its category weight × difficulty (`hard` 1.25, `easy` 0.8) and follow-ups carry a small bonus, because that is where depth shows;
2. the **closing holistic review** of the whole transcript.

`HOLISTIC_BLEND` (default 0.5) sets the balance. Overall score is the weighted sum across parameters, and the verdict falls out of bands: ≥80 `STRONG_HIRE`, ≥65 `HIRE`, ≥50 `BORDERLINE`, below that `NO_HIRE`.

Two rules matter more than the arithmetic, and both live in [evaluation.py](backend/evaluation.py):

- **A parameter is scored only where the interview produced evidence.** An introduction cannot demonstrate problem solving, so it is not counted rather than counted as bad. A parameter with no evidence at all is reported as *not tested* and excluded from the overall, not scored 0.
- **An ungraded answer is missing, not zero.** If an AI call fails mid-interview, that turn lowers the report's *confidence*, never the candidate's score. `fallback_assessment` deliberately returns no numbers — inventing a score from a word count would put fake evidence in front of a reviewer.

Report confidence starts from the model's own read and is only ever downgraded — for a short interview, ungraded answers, unanswered questions or very brief answers — with the reasons listed. A confident write-up cannot rescue a thin interview.

### Fairness

- The interviewer never sees the ATS score, screening status or recommendation.
- Prompts forbid weighting name, gender, age, marital or family status, religion, caste, nationality, health, disability, address, college prestige or employer brand, and forbid asking about any of them.
- Communication is graded on clarity and structure **only**. Accent, dialect, grammar slips, filler words and non-native phrasing are explicitly excluded, and the prompts are told the transcript is speech-to-text and contains errors.
- Filler counts and speaking rate are computed and shown to the reviewer but never scored — grading them punishes nervous and non-native speakers.
- Honest uncertainty is rewarded, not penalised.
- The AI recommends a next step; it never decides. The human verdict is stored beside the AI's figure rather than replacing it.

---

## Voice

| Missing capability | What happens |
|---|---|
| No `speechSynthesis` | Questions are mimed silently — the mouth still follows the text, so it stays watchable. Captions carry the question. |
| No `SpeechRecognition` | The mic button disables itself and answers are typed. Everything else is unchanged. |
| Mic permission denied | Reported once, then typing. The level meter stays quiet. |
| Voice drops an utterance | A watchdog sized from the timeline ends the turn rather than hanging. |

The microphone is used only for in-browser transcription. No audio is uploaded, stored or sent anywhere — only the resulting text reaches the server.

---

## Files

| Path | Purpose |
|---|---|
| [backend/main.py](backend/main.py) | FastAPI routes |
| [backend/interview.py](backend/interview.py) | The turn engine — what is said next, follow-up limits, finalisation |
| [backend/ai_agent.py](backend/ai_agent.py) | Azure OpenAI calls: plan, per-answer assess + follow-up, closing review, fallbacks |
| [backend/evaluation.py](backend/evaluation.py) | Weighting, blending, overall score, verdict, confidence |
| [backend/candidates.py](backend/candidates.py) | Reads accepted shortlists from the screening app; candidate normalisation |
| [backend/storage.py](backend/storage.py) | Atomic JSON persistence (`data/interviews`) |
| [backend/excel_export.py](backend/excel_export.py) | `.xlsx` — report, parameters, transcript |
| [backend/dnsfix.py](backend/dnsfix.py) | DNS fallback for blocked `getaddrinfo` (see Notes) |
| [frontend/avatar.js](frontend/avatar.js) | The 2D rig |
| [frontend/speech.js](frontend/speech.js) | TTS + viseme timeline, STT, mic meter |
| [frontend/app.js](frontend/app.js) | Controller and the interview loop |

## API

| Method | Route |
|---|---|
| GET | `/api/config` · `/api/ai-check` |
| GET | `/api/shortlists` · `/api/shortlists/{history_id}` |
| POST | `/api/interviews` — body: `source`, `history_id`+`candidate_id` or `candidate`, `jd_text`, `options` |
| GET | `/api/interviews` · `/api/interviews/{id}` (`?full=true` for the reviewer view) · `/api/interviews/{id}/status` |
| POST | `/api/interviews/{id}/next` — what the interviewer says next |
| POST | `/api/interviews/{id}/answer` — body: `turn`, `answer`, `seconds`, `mode` |
| POST | `/api/interviews/{id}/finish` · `/api/interviews/{id}/regrade` · `/api/interviews/{id}/abandon` |
| GET | `/api/interviews/{id}/report` · `/api/interviews/{id}/export` |
| PUT | `/api/interviews/{id}/review` — the human decision |
| DELETE | `/api/interviews/{id}` |

`GET /api/interviews/{id}` without `full=true` returns the **candidate-safe** view: no scores, no grades, no `expected_points`. That matters — the grading key for the question about to be asked must not be sitting in the candidate's console. There is a test for it.

---

## Notes

- **Port 8010**, so this and the screening app can run at once.
- The screening app's `data/history/` is opened **read-only**; the screening app owns those files. Both `data/history` and `backend/data/history` are searched, because that app has run from two working directories.
- `data/` is git-ignored by the repo-root `.gitignore`.
- The interviewer's name, role and company are `.env` settings (`INTERVIEWER_NAME` and friends). The avatar is one fixed drawing and does not change with the name.
- **`backend/dnsfix.py`** is the same DNS fallback the screening app needs on this machine: the endpoint-security agent blocks `getaddrinfo` for Python processes started by file path, so every AI call fails with `[Errno 11001] getaddrinfo failed` even though the network is fine. It is installed on `import backend` and is a no-op elsewhere. `GET /api/ai-check` reports which resolution path is in use.

## Verified, and not

Checked against the live Azure deployment and in a real browser:

- the full server-side loop — plan → 9 turns including 3 live follow-ups → grading → blended report → Excel → history;
- the candidate-safe view really is free of grades and expected answers;
- the rig, measured rather than eyeballed: all 17 visemes, 6 postures, 5 expressions, and the ~4-frame viseme transition;
- the viseme timeline: 140 wpm at rate 1.0, monotonic char indices (the boundary re-sync depends on it), correct handling of `sh` / `th` / `ph` / `ck` / doubled consonants;
- all three tabs rendering with real data.

Not yet exercised: a **human clicking through a live voice interview** — microphone capture, `SpeechRecognition` transcription accuracy and the real `onboundary` cadence of your installed voices can only be judged by doing one. Everything they feed into is tested; start with a 4-question interview to check the voice and the mic before running a real candidate through it.
