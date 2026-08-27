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

**1 · Dashboard** — pick an accepted screening shortlist and every candidate on it appears as a row: their resume score, where they have got to, their interview link, their interview score, and every action you can take on them. This is where the recruiter drives everything — see [The recruiter dashboard](#the-recruiter-dashboard).

**2 · Interview** — the 2D interviewer greets the candidate by name, then works through the plan. Each question is spoken aloud with a live caption; the candidate answers by voice (transcribed in the browser) or by typing. Between questions the interviewer acknowledges the answer and either moves on or follows up on it. **Repeat question**, **Mute voice** and **Skip** are always available.

**3 · Report** — opens on **Candidate reports**: every candidate on a shortlist, split by whether they actually sat the interview, filterable by attendance and by decision, and exportable as one Excel report. Open a row for the full individual write-up — overall score, verdict, per-parameter breakdown with the reasoning behind each number, strengths, gaps, standout moments, what the interview failed to cover, risk flags, a recommended next step, and the transcript with the grade given to every single answer. A human records the actual decision at the bottom. See [Candidate reports](#candidate-reports).

**4 · History** — every interview ever run. Filter by status, search, and tick rows for a bulk action: **Select all shown** then **Delete selected** clears a batch, or **Excel for selected** downloads a workbook per completed interview. The confirmation names who is going and says how many had a completed report, because this takes the transcripts with it.

A shortlist's dashboard can be bookmarked at `/?shortlist=HIS-XXXXXXXX`, and any interview reopened at `/?interview=INT-XXXXXXXX`.

---

## The recruiter dashboard

One row per shortlisted candidate, assembled by `GET /api/dashboard/{history_id}` in a single
call — the browser never fans out per candidate to work out who has an interview.

| Column | What it shows |
|---|---|
| Candidate | Name and email, from the screening record |
| Current role | Role and experience, clipped (full text on hover) |
| Resume ATS | The screening score, **for context only** |
| Stage | Where this candidate has got to |
| Interview | Score and verdict once evaluated, otherwise answers so far |
| Interview link | The issued link, shortened, with Copy |
| Actions | Everything below |

**Stage** is derived on every request, never stored — a stored status would drift out of step with
the interview records the moment anything happened elsewhere:

`Not invited` → `Link ready` → `Sent` → `Preparing` → `In progress` → `Completed`,
plus `Withdrawn` for a revoked link and `Discarded` for an interview the recruiter ended.

### Issuing links

Select any number of candidates and **Issue links**, or issue one from its row. Issuing is
**idempotent**: re-issuing keeps the link the candidate already has, so pressing the button twice
cannot quietly invalidate a link that is already sitting in somebody's inbox. `regenerate` mints a
fresh one deliberately.

A link **carries the settings it was issued with**. Change the question count in *Interview
settings*, issue a link, and that candidate's interview uses those numbers even though they start it
days later. Links issued by the screening app have no such record and fall back to the configured
defaults.

### Sending them

**This app does not send email**, and the dashboard says so on a banner. There is no SMTP client or
mail SDK here, the same as the screening app. What it gives you instead:

- **Invitation…** opens a drawer with the full invitation text and an **Open in my mail app**
  button — a `mailto:` URL pre-filled with the address, subject and body. That is a real send, by
  your own mail client, not by us.
- **Copy the text** / **Copy just the link** for any other channel.
- **Copy all links** copies every issued link in the current view as tab-separated
  `name⇥email⇥link`, ready to paste into a mail-merge or a spreadsheet.
- **Mark as sent** records that you sent it, with a timestamp and channel. It is an audit note, not
  a transmission, and it is what moves a row from `Link ready` to `Sent`.

For bulk, personalised, AI-written invitations, use the screening app's Invite tab instead — it
drafts one per candidate from their own resume and embeds the same kind of link.

### Withdrawing a link

**Withdraw** revokes a link. The token is stateless and cannot be un-signed, so revocation is
checked server-side on every use: both `/api/invite/{token}` and `/api/invite/{token}/start` then
return `403` with a message telling the candidate to contact the recruiter. **Restore** puts it
back. A completed interview cannot be withdrawn — there is nothing left to stop.

### Settings for one candidate

**⚙ Settings** on a row gives that candidate their own interview shape, overriding
the dashboard defaults. Everything about the interview can be set for one person:

| | |
|---|---|
| **Questions** | How many planned questions, and how hard to dig (follow-ups each) |
| **Categories** | Which of the nine areas to probe. Introduction and closing are always asked |
| **Voice** | Whether the interviewer speaks, which installed voice, and the speaking rate |
| **Evaluation weights** | How the seven parameters combine into the overall score |
| **Note** | Free text on why, shown on the row |

A row with bespoke settings carries a badge summarising them
(`⚙ 8Q · 1 follow-up · 4/9 categories · set voice`), so the board shows at a glance
who is being treated differently.

**The voice and rate follow the interview**, not the browser: they are frozen onto
the record, so a candidate opening their own link hears the voice the recruiter
chose. If that voice is not installed on the machine actually playing it, the best
available English voice is used instead. A stored voice missing from *your* machine
is still listed in the drawer, marked `not installed here`, so opening the settings
elsewhere cannot silently wipe the choice.

### Weights per candidate, and the catch

Weights were originally run-wide on purpose. Setting them per candidate is now
supported, because there are legitimate uses — interviewing a specialist and a
generalist for the same team, say — but it comes with a real cost:

> Two candidates scored on different weights do not have comparable overall scores.

That is handled by making it **visible**, never by hiding it:

- the weights actually used are frozen onto the interview record;
- `evaluation.build_report` sets `weights_are_custom` and lists the exact
  `weight_differences`;
- the report prints a banner above the summary — *"Scored on weights set for this
  candidate… not directly comparable"* — with every delta;
- the dashboard row carries a separate `⚖ custom weights` marker.

Whatever you type is scaled to 100 on save, so the ratios are what matter and a
report can never be weighted by numbers that do not add up.

Precedence, in order:

1. that candidate's own settings, if any;
2. otherwise whatever the dashboard has selected at the moment you act;
3. otherwise the `.env` defaults.

Saving also **updates a link that has already been issued but not yet used**, so the
change actually reaches the candidate rather than applying to nobody. An interview
already under way keeps the plan it started with, and the drawer says so instead of
pretending otherwise. **Use the defaults instead** drops the override.

Stored in `data/candidate_options.json`, separate from the invite record, because
settings are decided before (and independently of) any link — and are still wanted
for an interview conducted face to face with no link at all.

### Interviewing somebody off-shortlist

The *Interview somebody not on a shortlist* card carries **its own full copy of all
four sections** — questions, categories, voice, and evaluation weights — with its own
*Reset to defaults*. It reads none of them from the dashboard fold, so setting up a
one-off candidate cannot disturb the defaults the shortlist is using, and vice
versa. A one-off is usually being interviewed for a particular reason.

**Prepare interview** writes the plan and then hands you a **sendable link**, with
*Invitation…*, *Mark as sent*, *Interview now* and *Prepare another*. So an
off-shortlist candidate can either sit with you or take it in their own time, exactly
like a shortlisted one.

That needs a second kind of token. A shortlist link carries a shortlist id and a
candidate id, and the interview is created when the candidate first opens it — but a
one-off candidate exists in no shortlist, so there is nothing to resolve them from.
`make_interview_token()` therefore mints a token that points at the **already-prepared
interview**, which holds their details, the JD, the plan and the settings:

| Token | Payload | Interview |
|---|---|---|
| Shortlist | shortlist id + candidate id | created on first open |
| One-off | interview id | already exists; the link resumes it |

`parse_token` reports which kind it got. The one-off shape is tagged, and links
already sitting in candidates' inboxes have no tag — so **every link issued before
this change keeps working** (verified). One-off links are recorded under a
`__one_off__` pseudo-shortlist so they can be mailed, marked sent and withdrawn by
the same machinery, without appearing on any shortlist's board.

### Interviewing somebody yourself

**Interview now** on a row prepares that candidate's interview and drops you straight onto the
Interview tab, for when you are sitting with them rather than sending a link. The collapsible
*Interview somebody not on a shortlist* card does the same for a candidate who never went through
screening.

---

## Candidate reports

The Report tab opens on a table covering everybody, not just the person whose
write-up is on screen. It answers the two questions a recruiter has after sending
out a batch of links: **who actually turned up**, and **what did we decide**.

### Attendance

Derived on the server (`_attendance()` in [main.py](backend/main.py)) so the screen
and the exported report can never disagree:

| | Meaning |
|---|---|
| `Yes · completed` | Sat it and reached the end |
| `Yes · unfinished` | Started answering, did not finish |
| `No · never started` | Invited or prepared, never answered a question |
| `No · not invited` | Nothing exists for them at all |

A **completed** interview counts as attended even if every question was skipped:
they turned up, and "answered nothing" is a finding for the reviewer rather than an
absence.

### Filters

Two independent rows, combinable, plus a search box and **Clear filters**. Each chip
carries its own count, taken from the unfiltered set so a chip never reads zero just
because the other row is narrowing the view.

- **Attended** — All · Attended · Not attended · Completed · Unfinished · Never started · Not invited
- **Decision** — All · Proceed · Hold · Do not proceed · Not decided

The decision is the human verdict recorded at the bottom of an individual report;
saving one refreshes this table and the dashboard so the counts move immediately.

### Two scopes

The shortlist picker also offers **All interviews — every shortlist, plus one-offs**
(`GET /api/reports`). That scope exists because two kinds of interview a recruiter
still cares about cannot appear in a shortlist-scoped view:

- one-offs run from *Interview somebody not on a shortlist*, which never belonged to one;
- interviews whose shortlist has since been **deleted from the screening app** — the
  interview record is self-contained and survives that deletion.

In that scope "did not attend" is meaningless and the UI says so plainly: with no
candidate list there is nobody to be absent. The Excel report is disabled there too,
since it is built per shortlist.

### The Excel report

**⬇ Excel report** downloads the whole shortlist as one workbook
(`GET /api/dashboard/{history_id}/export`):

- **Candidates** — a row each with attendance, answers, interview score, AI verdict,
  report confidence, human decision, reviewer, overridden score, resume ATS, stage and
  link state. Auto-filtered, with the attendance and score cells colour-coded.
- **Summary** — the headline counts: attended vs not (broken down), the four decision
  tallies, and the average interview score.

This is the report to circulate. The per-interview workbook from the row's own
**Excel** button is the drill-down for one person.

---

## The candidate's link

A candidate never touches the recruiter console. The invitation email from the screening app carries a signed link:

```
http://<host>/i/<token>
```

which opens a **separate page** ([candidate.html](frontend/candidate.html) / [candidate.js](frontend/candidate.js)) with no tabs, no setup, no history, no other candidates and no scores anywhere in it. It shows the interviewer, explains what to expect, checks the browser, and starts the interview on one click.

- **`GET /i/{token}`** serves the candidate page.
- **`GET /api/invite/{token}`** returns only what the landing screen needs: a first name, the role, the interviewer, and whether this is a new, resumable or already-completed interview.
- **`POST /api/invite/{token}/start`** creates the interview, or returns the existing one. It is **idempotent**: clicking the link twice, or reloading mid-interview, resumes rather than producing a second interview for the same person. A completed interview returns `409` — the link cannot be used to take it again.

The token is verified by [interview_link.py](backend/interview_link.py) — **duplicated from the screening app, and the two copies must stay identical**. A tampered, truncated or unknown token gets a plain `404` with no hint as to which part was wrong; an expired one gets `410` and a message telling the candidate to ask for a new link.

The candidate's browser only ever reads the candidate-safe interview view, and the interview record notes where it came from:

```json
"source": {"kind": "invite", "shortlist_id": "HIS-…", "candidate_id": "CID-…",
           "token_fingerprint": "d87a0a95db0de2ac", "started_by": "candidate"}
```

The token itself is not stored — only a fingerprint of it, so a record can be tied back to a link without the link lying around in a JSON file.

When the interview ends, the candidate sees a thank-you. The evaluation runs for the recruiter; the candidate is never shown a score, a verdict or any part of the report.

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

The selected categories are a **closed list**, not a suggestion. The prompt used to
name the requested mix while still offering every category as a valid value, and the
model would cheerfully put a project question into a plan that excluded projects —
verified and fixed. Only the permitted categories now reach the prompt, and if one
still strays it is kept with its true category (so `evaluation.py` weights it
correctly) and reported on the record rather than silently relabelled.

Two further guards exist because the model reliably misbehaves without them:

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
| [backend/candidates.py](backend/candidates.py) | Reads accepted shortlists **and live sessions** from the screening app; candidate normalisation; invite resolution |
| [backend/interview_link.py](backend/interview_link.py) | Signed invite tokens — duplicated from the screening app, keep identical |
| [backend/storage.py](backend/storage.py) | Atomic JSON persistence (`data/interviews`, `data/invites.json`, `data/candidate_options.json`) |
| [backend/excel_export.py](backend/excel_export.py) | `.xlsx` — report, parameters, transcript |
| [backend/dnsfix.py](backend/dnsfix.py) | DNS fallback for blocked `getaddrinfo` (see Notes) |
| [frontend/avatar.js](frontend/avatar.js) | The 2D rig |
| [frontend/speech.js](frontend/speech.js) | TTS + viseme timeline, STT, mic meter |
| [frontend/app.js](frontend/app.js) | Recruiter console controller and the interview loop |
| [frontend/candidate.html](frontend/candidate.html) · [candidate.js](frontend/candidate.js) | The candidate's page, reached from their emailed link |

## API

| Method | Route |
|---|---|
| GET | `/api/config` · `/api/ai-check` |
| GET | `/api/shortlists` · `/api/shortlists/{history_id}` |
| GET | `/api/dashboard/{history_id}` — every row for one shortlist, in one call |
| GET | `/api/dashboard/{history_id}/export` — the shortlist as one Excel report |
| GET | `/api/reports` — every interview, any shortlist, including orphaned and one-off |
| POST | `/api/invites` — issue links; body: `history_id`, `candidate_ids?`, `options?`, `regenerate?` |
| POST | `/api/interviews/{id}/link` — issue a link to one prepared interview (off-shortlist) |
| GET | `/api/interviews/{id}/link` — that link, if issued |
| GET | `/api/candidate-options/{shortlist_id}/{candidate_id}` — effective shape + whether bespoke |
| PUT | `/api/candidate-options/{shortlist_id}/{candidate_id}` — set it · DELETE clears it |
| GET | `/api/invites/{shortlist_id}/{candidate_id}/mail` — invitation text + `mailto:` URL |
| POST | `/api/invites/{shortlist_id}/{candidate_id}/sent` · `.../revoke` |
| GET | `/i/{token}` — the candidate page · `/api/invite/{token}` — landing info |
| POST | `/api/invite/{token}/start` — create or resume that candidate's interview |
| POST | `/api/interviews` — body: `source`, `history_id`+`candidate_id` or `candidate`, `jd_text`, `options` |
| GET | `/api/interviews` · `/api/interviews/{id}` (`?full=true` for the reviewer view) · `/api/interviews/{id}/status` |
| POST | `/api/interviews/{id}/next` — what the interviewer says next |
| POST | `/api/interviews/{id}/answer` — body: `turn`, `answer`, `seconds`, `mode` |
| POST | `/api/interviews/{id}/finish` · `/api/interviews/{id}/regrade` · `/api/interviews/{id}/abandon` |
| GET | `/api/interviews/{id}/report` · `/api/interviews/{id}/export` |
| PUT | `/api/interviews/{id}/review` — the human decision |
| DELETE | `/api/interviews/{id}` |
| POST | `/api/interviews/bulk-delete` — body: `interview_ids` (non-empty, max 500) |

`GET /api/interviews/{id}` without `full=true` returns the **candidate-safe** view: no scores, no grades, no `expected_points`. That matters — the grading key for the question about to be asked must not be sitting in the candidate's console. There is a test for it.

---

## Notes

- **Port 8010**, so this and the screening app can run at once. `INTERVIEW_BASE_URL` must point at wherever this app is reachable **from the candidate's browser** — the `127.0.0.1` default only works for a demo on one machine.
- Both apps must agree on `INTERVIEW_LINK_SECRET` (or both fall back to deriving it from the shared Azure key). They read the same repo-root `.env`, so this is automatic unless you split them.
- The screening app's `data/history/` is opened **read-only**; the screening app owns those files. Both `data/history` and `backend/data/history` are searched, because that app has run from two working directories.
- `data/` is git-ignored by the repo-root `.gitignore`.
- Deleting an interview does **not** revoke that candidate's invite link. The link becomes usable again, which is what you want when clearing a bad run so somebody can retake it — withdraw the link from the dashboard if that is not what you meant.
- There is deliberately no route that deletes everything on an empty body. "Select all" sends every id explicitly, so a client-side bug cannot be read as "delete the lot".
- The interviewer's name, role and company are `.env` settings (`INTERVIEWER_NAME` and friends). The avatar is one fixed drawing and does not change with the name.
- **`backend/dnsfix.py`** is the same DNS fallback the screening app needs on this machine: the endpoint-security agent blocks `getaddrinfo` for Python processes started by file path, so every AI call fails with `[Errno 11001] getaddrinfo failed` even though the network is fine. It is installed on `import backend` and is a no-op elsewhere. `GET /api/ai-check` reports which resolution path is in use.

## Verified, and not

Checked against the live Azure deployment and in a real browser:

- the full server-side loop — plan → 9 turns including 3 live follow-ups → grading → blended report → Excel → history;
- the candidate-safe view really is free of grades and expected answers;
- the rig, measured rather than eyeballed: all 17 visemes, 6 postures, 5 expressions, and the ~4-frame viseme transition;
- the viseme timeline: 140 wpm at rate 1.0, monotonic char indices (the boundary re-sync depends on it), correct handling of `sh` / `th` / `ph` / `ck` / doubled consonants;
- all three tabs rendering with real data;
- the whole link hand-off, end to end: 16 invitations drafted in the screening app (the model left the placeholder correctly 16/16), the emailed token opening the candidate page, the interview starting from it, a second click resuming instead of duplicating, 11 turns with 7 follow-ups all graded, the report produced, and the spent link then refusing to start again (`409`);
- token rejection: tampered signature, truncated, garbage and expired tokens all refused;
- the candidate page's three other states — already completed, expired link, invalid link;
- the dashboard: stages derived correctly for candidates invited from either app, issuing
  (idempotent — second press kept the existing link), the invitation text and `mailto:` URL,
  mark-as-sent, withdraw (`403` on both candidate routes, row shows `Withdrawn`) and restore;
- that a link **keeps the settings it was issued with** — issued at 5 questions / 1 follow-up, and
  the interview the candidate started from it planned exactly 5;
- per-candidate settings, end to end against the live deployment: a bespoke shape
  (6 questions / 0 follow-ups / 4 categories) saved, shown on the row, applied to the
  already-issued link, and surviving a deliberate re-issue at the dashboard's 18/4 —
  then the interview the candidate actually started from that link planned exactly 6
  questions across exactly those 4 categories. Reset, double-delete (`404`) and
  unknown-candidate (`404`) all behave. Option clamping and junk input checked
  (`planned_count: 99 -> 20`, `"abc" -> 10`, `voice_rate: 5 -> 1.3`, `"fast" -> 0.98`,
  a 500-character voice name capped at 120, unknown category dropped);
- one-off interview links end to end: prepared an off-shortlist interview, issued its
  link, re-issued it (kept the same link), opened the landing page — which correctly
  said `new` rather than `resume` even though the interview already existed — started
  from the link and confirmed it **reused that interview rather than creating a
  second**, answered a question and saw the landing flip to `resume`. The invitation
  text and `mailto:` worked, marking sent worked, withdrawing returned `403` on both
  candidate routes, and an abandoned interview refused both `start` (`409`) and a
  re-issue (`409`). An existing shortlist link still resolved unchanged, and no one-off
  record leaked onto the dashboard. The result panel itself was rendered in a browser
  with all five actions present;
- the off-shortlist card owning its own controls, in a browser: 7 weight rows
  totalling 100 and updating live, 9 category chips, its own voice picker and rate,
  its own Reset — and proven independent (moving the dashboard's question slider to 4
  left the card on 10). A bespoke shape typed into the card (5 questions / 1 follow-up
  / 3 categories / a chosen voice at 1.16x / weights 5-55-10-10-5-10-5) came back on
  the created interview exactly as typed, with a plan of 5 questions across those 3
  categories;
- per-candidate voice and weights, in a browser: a voice not installed locally was
  preserved and marked `not installed here` rather than silently reset; the rate
  reached the record and the public interview view; weights of 10/40/25/5/10/5/5
  loaded into the drawer, totalled 100, updated live on edit, normalised to 100 on
  save, and raised both the `⚖ custom weights` row marker and the report's
  not-comparable banner with the correct per-parameter deltas;
- the Report tab's filters, driven through the real chips in a browser: attendance buckets
  (attended / not attended / completed / never started), all four decision states, both scopes,
  combined filters including an intersection that correctly comes back empty, search, and
  Clear filters. The Excel report was opened and its two sheets checked;
- History bulk delete, driven through the real buttons in a browser rather than the API: search
  narrowed to three throwaway records, select-all ticked all three, unticking one cleared the
  select-all box, the confirmation named them and flagged the one with a report, all three went, the
  controls reset, and the ten real interviews were untouched. The endpoint also de-duplicates ids,
  reports ones already gone, and rejects an empty or non-list `interview_ids` with `400`.

Not yet exercised: a **human clicking through a live voice interview** — microphone capture, `SpeechRecognition` transcription accuracy and the real `onboundary` cadence of your installed voices can only be judged by doing one. Everything they feed into is tested; start with a 4-question interview to check the voice and the mic before running a real candidate through it.
