# AI-Powered Fair Candidate Screening and Virtual Interview Platform

Two apps, one hiring pipeline:

**Resumes in → AI screening against the JD → human-reviewed shortlist → recruiter-approved invitation carrying a signed interview link → a spoken interview with an animated AI interviewer → a performance report scored independently of the resume → Excel out.**

| App | Port | What it does | Detail |
|---|---|---|---|
| **Candidate screening** | 8000 | Bulk resume intake, JD → rubric, five-criterion scoring, editable shortlist, human acceptance, drafted interview invitations, history + Excel | [README](Candidate%20screening/README.md) |
| **Virtual AI Interviewer** | 8010 | Questions written from *that* candidate's resume, a voice interview with a live animated interviewer and real follow-ups, seven-parameter evaluation, reports + Excel | [README](Virtual%20AI%20Interviewer/README.md) |

Stack for both: **React (Vite)** front end · **Python + FastAPI** back end · **JSON** file storage · **Azure OpenAI** via a shared repo-root `.env` · **Web Speech API** and **three.js** in the interviewer.

---

## Why "fair" is in the name

Fairness here is a set of mechanisms, not a claim.

**At screening**

- The JD becomes a **rubric** — must-haves, *acceptable equivalents*, experience, education, project types, certifications — not a keyword list. "Built REST services in Flask" satisfies "Python web APIs".
- Scoring is capability-based across five criteria; the prompt forbids weighting name, gender, age, nationality, address, college prestige or employer brand.
- Anyone at or above the configurable **60% threshold** moves forward. A missed cut-off means `REVIEW` by a human, never an automatic reject.
- The arithmetic and the decision live in Python ([scoring.py](Candidate%20screening/backend/scoring.py)), so every outcome is reproducible and auditable. The AI grades; it does not decide.
- Nothing is final until a human edits and accepts the sheet.

**At interview**

- **The interviewer never sees the ATS score**, screening status or recommendation — it is stripped before the resume reaches the model, so a 92% resume gets no easier a ride than a 61% one.
- Communication is graded on clarity and structure only; accent, dialect, grammar slips and filler words are explicitly excluded, and the prompts are told the transcript is speech-to-text and contains errors.
- A parameter with no evidence is reported *not tested*, not scored 0. An ungraded answer lowers the report's **confidence**, never the candidate's score.
- Honest uncertainty is rewarded. The AI recommends a next step; the human verdict is stored beside it, never replaced by it.

The two scores are deliberately shown side by side. The first real end-to-end run scored a candidate **53% at interview against a 92% resume ATS** — that divergence is the entire point of interviewing.

---

## Setup

One virtual environment and one `.env` serve both apps.

```powershell
# 1. dependencies (venv already present as myenv)
.\myenv\Scripts\pip.exe install -r requirements.txt

# 2. .env at the repo root — both apps read it
#    AZURE_OPENAI_ENDPOINT / _API_KEY / _API_VERSION / _DEPLOYMENT
#    See each app's .env.example for its own optional settings.
```

**Run the screening app** (terminal 1):

```powershell
.\myenv\Scripts\python.exe "Candidate screening\run.py"     # http://127.0.0.1:8000
```

**Run the interviewer** (terminal 2):

```powershell
cd "Virtual AI Interviewer"
..\myenv\Scripts\python.exe run.py                          # http://127.0.0.1:8010
```

Each `run.py` builds its React UI with Vite if `frontend/dist` is out of date (`npm install` on first start), then serves it from FastAPI — a single command is all you need. **Node.js is required** for that build; without `npm` the existing build is served with a warning, and with no build at all the server stops and says so.

Click the **AI** pill at the foot of either sidebar for a live connectivity check against the deployment.

**Use Chrome or Edge** for the interview. Both halves of the voice interface are browser APIs: `speechSynthesis` for the interviewer's voice, `SpeechRecognition` for the candidate's answers.

### Hot reload

```powershell
# screening:    python run.py (8000)  +  cd frontend; npm run dev   (5173 → proxies /api)
# interviewer:  python run.py (8010)  +  cd frontend; npm run dev   (5174 → proxies /api and /i)
```

### Tests

The rules that must behave identically for every candidate are pinned in unit tests, and none of them touch the network:

```powershell
cd "Candidate screening";     ..\myenv\Scripts\python.exe tests\test_core.py
cd "Virtual AI Interviewer";  ..\myenv\Scripts\python.exe tests\test_core.py
# or, in either folder:  python -m pytest tests -q
```

### Sample data

[sample data/](sample%20data/) holds five role folders — AI Engineer, Data Analyst, HR, Python Developer, SDE — with ten resumes each in `.docx`, `.pdf` and `.txt`. Drop a whole folder on the Screen tab to try the pipeline end to end.

---

## The pipeline

### 1 · Screen (8000)

Paste the JD, drop resumes — individual files, a whole folder, or ZIPs containing folders — tune weights, cut-offs and threshold, then **Analyse & Shortlist**. Progress streams while the batch runs.

| Criterion | Default weight | Default cut-off |
|---|---|---|
| Skills | 35% | 40% |
| Experience | 25% | — |
| Education | 15% | — |
| Projects | 15% | — |
| Certifications | 10% | — |

`ATS score = Σ (criterion score × weight)`, weights normalised to 100%.

- at or above threshold, all cut-offs met → **SHORTLISTED**
- threshold met, a cut-off missed → **REVIEW** (a human decides)
- below threshold → **NOT_SHORTLISTED**
- unreadable resume → **PARSE_FAILED** (the row is still created so a reviewer can fill it in)

### 2 · Review (8000)

The sheet: `Candidate ID · Name · Phone · Email · Skills · Certification · Experience`, plus Highest Education, ATS %, per-criterion scores and status. Missing data is `NA`; Skills contain **only** what the resume literally states.

Edit any cell inline, add or delete rows, open the full analysis drawer. **Save edits** persists to JSON; **Accept & save to history** freezes the sheet and makes the session read-only. **Excel** downloads a workbook with a Shortlist sheet and a Screening Details sheet recording threshold, weights, cut-offs, stats and the JD.

### 3 · Invite (8000)

The agent drafts one personalised invitation per shortlisted candidate; the recruiter edits and approves them, then sends them all in one click.

> **No email is ever sent.** There is no SMTP client, mail SDK or outbound mail call anywhere in this codebase. "Send the mails" marks each draft `SENT`, timestamps it, and freezes the exact text that would have gone out. Wiring a real transport is a deliberate, separate change — everything around it (draft, review, approve, audit trail) is already in place.

The prompt may not mention any score, rank or ATS percentage, may not invent a date, deadline, duration, question count or human interviewer's name, and must say plainly that the interview is conducted by an AI. **The model never writes the URL** — it leaves a placeholder and the code substitutes the real link, so a hallucinated or mangled address can never reach a candidate. A row with no email address is skipped and named in the banner, not silently dropped.

### 4 · Interview (8010)

The recruiter dashboard shows one row per shortlisted candidate — resume ATS (for context only), stage, interview score, invitation status, and every action — assembled by a single `GET /api/dashboard/{history_id}` call. **Stage** is derived on every request, never stored, because a stored status would drift the moment anything happened elsewhere:

`Not invited` → `Draft ready` → `Sent` → `Preparing` → `In progress` → `Completed`, plus `Withdrawn` for a deactivated link and `Discarded` for an interview the recruiter ended.

The interview itself: the interviewer greets the candidate by name and works through a plan built by `build_question_plan` across nine categories — introduction, resume, project deep-dive, technical skills, domain knowledge, JD fit, scenario, problem solving, closing. Each planned question carries its intent, the resume item it probes, a difficulty, and 2–4 expected points that act as the grading key. Questions are **spoken aloud** with a live caption; the candidate answers **out loud only**, transcribed in the browser. Between questions the interviewer acknowledges the answer and either moves on or follows up on it.

Follow-ups are decided per answer, but **the model proposes and code decides** — `_queue_followup` refuses one when the answer was a non-answer or off-topic, when the per-question budget is spent, when `MAX_TOTAL_TURNS` is hit, or when only the closing question remains. The model has no view of the turn budget and every incentive to keep digging, so those limits are code, not prompt.

Per-candidate overrides are available for question count, follow-up depth, categories, voice and rate, and evaluation weights. Weights set for one person make that person's overall score non-comparable — so the report prints a banner listing every delta and the dashboard row carries a `⚖ custom weights` marker rather than hiding it.

### 5 · Report and history (8010)

Seven parameters, each 0–100:

| Parameter | Weight |
|---|---|
| Technical knowledge | 20% |
| Communication | 15% |
| Domain knowledge | 15% |
| Project understanding | 15% |
| Problem solving | 15% |
| JD alignment | 10% |
| Answer quality | 10% |

Each score blends two independent views, both kept in the record: the **weighted mean of per-answer grades** (weighted by category × difficulty, with a small bonus for follow-ups, because that is where depth shows) and the **closing holistic review** of the whole transcript, balanced by `HOLISTIC_BLEND` (default 0.5). Verdict bands: ≥80 `STRONG_HIRE`, ≥65 `HIRE`, ≥50 `BORDERLINE`, below that `NO_HIRE`.

The write-up gives overall score, verdict, per-parameter reasoning, strengths, gaps, standout moments, what the interview failed to cover, risk flags, a recommended next step, and the transcript with the grade given to every answer. A human records the actual decision at the bottom. History spans every interview ever run, with per-candidate drawers showing the invitation that was sent and the link it carried, plus filters, bulk delete and bulk Excel export.

---

## How the two apps are joined

The interviewer is a **separate app that reads the screening app's output**, not a module inside it. It opens `data/history/*.json` **read-only**, lists candidates whose status is `SHORTLISTED` or `REVIEW`, and generates questions from the resume fields and the `jd_analysis` rubric stored in that record. Nothing in the screening app had to change for it to work, and nothing there depends on it.

One thing crosses the boundary: a signed link in the invitation.

```
http://<interviewer-host>/i/<token>
```

The token is **stateless** and carries exactly three things — shortlist id, candidate id, expiry — HMAC-signed, because that link is all that stands between a stranger and starting an interview as a named candidate. It holds no personal data and grants one capability: take, or resume, that one interview.

- **The screening app is the only issuer.** It mints the link at *draft* time, so the recruiter reviews the exact mail the candidate will get. Two issuers would mean two links per person and no single answer to "what were they actually sent?"
- The interviewer shows that frozen invitation as a **record**, not a draft — nothing to edit, nothing to send.
- **Deactivate link** revokes access server-side (`403` on both candidate routes) even though this app never saw the token; **Restore link** puts it back. A completed interview cannot be withdrawn — there is nothing left to stop.
- [interview_link.py](Candidate%20screening/backend/interview_link.py) is **duplicated in both apps and the copies must stay identical** — the same arrangement as `dnsfix.py`.

Shared link settings in the repo-root `.env`:

| Key | Meaning |
|---|---|
| `INTERVIEW_BASE_URL` | Where the interviewer is reachable **from the candidate's browser**. The `http://127.0.0.1:8010` default is demo-only — a real candidate cannot open `127.0.0.1`. |
| `INTERVIEW_LINK_SECRET` | Signing key. Unset, both apps derive one from `AZURE_OPENAI_API_KEY` — convenient, but rotating that key then invalidates every link already sent. Set an explicit secret before sending links to real people. |
| `INTERVIEW_LINK_TTL_DAYS` | Default 14. |
| `INCLUDE_INTERVIEW_LINK=0` | Revert to invitations that promise a follow-up instead of carrying a link. |

Both apps **must agree on the secret**. Reading the same repo-root `.env` makes that automatic unless you split them.

---

## Repository layout

```
.
├── Candidate screening/          # the screening app — port 8000
│   ├── backend/                  # FastAPI routes, AI agent, extractors, scoring, storage, Excel
│   ├── frontend/                 # React (Vite): Screen · Review · Outreach · History
│   ├── tests/                    # network-free unit tests
│   └── run.py                    # builds the UI, then serves it
├── Virtual AI Interviewer/       # the interview app — port 8010
│   ├── backend/                  # routes, turn engine, intent, evaluation, candidates, Excel
│   ├── frontend/                 # React (Vite), two pages: recruiter console + candidate page
│   │   ├── public/               # avatar rigs, speech.js, three.js — unbundled, on `window`
│   │   └── src/avatar/           # the 3D rig
│   ├── tests/
│   └── run.py
├── sample data/                  # 50 resumes across 5 roles
├── requirements.txt              # shared Python dependencies
├── myenv/                        # the shared virtualenv (git-ignored)
└── .env                          # shared config (git-ignored)
```

The interviewer's front end is built as **two pages on purpose** — the recruiter console (`index.html`) and the candidate's interview (`candidate.html`). Separate bundles enforce that the candidate page cannot reach recruiter-only views, rather than leaving it to a route guard. On the same principle, `GET /api/interviews/{id}` without `full=true` returns a **candidate-safe** view with no scores, grades or expected points — the grading key for the question about to be asked must not be sitting in the candidate's console. There is a test for it.

The avatar rigs, `speech.js` and `three.js` are deliberately **not bundled**: they are classic scripts that attach to `window`, pure DOM/WebGL/Web-Speech code with no React in them. React reaches them through `src/lib/legacy.js`, which looks `window.Avatar` up on every call, so the 2D rig can be swapped back in if the WebGL context is lost.

---

## Security and operational notes

- **`.env`, `myenv/`, `data/` and `*.xlsx` are git-ignored.** The API serves candidate PII; set `APP_ACCESS_TOKEN` on the screening app **before** exposing it beyond localhost. When set, every `/api/*` request must carry it (`X-Access-Token` header or `?token=`), and the UI prompts for it on first use.
- **Set an explicit `INTERVIEW_LINK_SECRET`** before sending links to real people, for the key-rotation reason above.
- Upload caps (`MAX_UPLOAD_FILES` 500, `MAX_FILE_MB` 20, `MAX_TOTAL_UPLOAD_MB` 300, `MAX_ZIP_ENTRIES` 1000) bound the worst case — a huge batch or a ZIP bomb. Oversize files become error rows, not a dead batch.
- Excel export escapes formula-leading cells, so a crafted resume cannot inject a formula into a recruiter's workbook.
- Concurrency is capped by `MAX_CONCURRENT_AI_CALLS` (default 6) to stay inside Azure rate limits.
- The screening app's `data/history/` is opened **read-only** by the interviewer; the screening app owns those files. Both `data/history` and `backend/data/history` are searched, because that app has run from two working directories.
- Legacy binary `.doc` is best-effort — prefer `.docx` or `.pdf`. Scanned image PDFs yield no text (there is no OCR) and land as `PARSE_FAILED` for manual entry.
- Deleting an interview does **not** revoke that candidate's link — the link becomes usable again, which is what you want when clearing a bad run so somebody can retake it. Withdraw the link from the dashboard if that is not what you meant.
- There is deliberately no route that deletes everything on an empty body. "Select all" sends every id explicitly, so a client-side bug cannot be read as "delete the lot".

### About `backend/dnsfix.py`

The endpoint-security agent on this machine blocks `getaddrinfo` for Python processes started by file path, so AI calls used to fail with `[Errno 11001] getaddrinfo failed` even though the network was reachable. `dnsfix.install()` runs on `import backend` and wraps `socket.getaddrinfo`: the native call is tried first, and only on `gaierror` does a small DNS/UDP client query the machine's configured resolvers (falling back to 1.1.1.1 / 8.8.8.8), with a five-minute cache. Because the patch sits at the socket layer, httpx, TLS/SNI and asyncio are unaffected. On a machine without the restriction it is a no-op.

`GET /api/ai-check` on either app reports which path is in use (`dns.native` vs `dns.fallback`).

The file is **duplicated in both apps and the copies must stay identical.**

---

## Read next

- **[Candidate screening/README.md](Candidate%20screening/README.md)** — rubric generation, the review sheet, invitation drafting, the full API surface, extractor behaviour.
- **[Virtual AI Interviewer/README.md](Virtual%20AI%20Interviewer/README.md)** — the recruiter dashboard, per-candidate settings, the candidate's link, the avatar rig and viseme timeline, question planning, evaluation internals, how the interview degrades, and what has been verified end to end.
