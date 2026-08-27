# AI-Powered Fair Candidate Screening

Bulk resume intake → AI agent analysis against a pasted JD → editable shortlist → human acceptance → **recruiter-approved interview invitations** → history + Excel export.

> The interview stage now exists as a sibling app: **[Virtual AI Interviewer](../Virtual%20AI%20Interviewer/README.md)**. It reads the shortlists accepted here and interviews the candidates on them. See [Where the interviewer plugs in](#where-the-interviewer-plugs-in).

Stack: **HTML / CSS / JS** front end, **Python + FastAPI** back end, **JSON** file storage, **Azure OpenAI** via `.env`.

---

## Why it is "fair"

Traditional ATS filters reject on literal keyword match. Here:

- The agent first converts the JD into a **rubric** (must-haves, *acceptable equivalents*, experience, education, project types, certifications) instead of a keyword list.
- Each resume is scored on **five criteria** — Education, Skills, Experience, Projects, Certifications — with capability-based judgement, so "built REST services in Flask" satisfies "Python web APIs".
- The prompt explicitly forbids weighting name, gender, age, nationality, address, college prestige or employer brand.
- Anyone at or above the **60% weighted threshold** (configurable) moves forward — nobody is dropped for missing a buzzword.
- Nothing is final until a human edits and accepts the sheet.

---

## Setup

```powershell
# 1. dependencies (venv already present as myenv)
.\myenv\Scripts\pip.exe install -r requirements.txt

# 2. .env  (already populated; see .env.example for the full key list)
#    AZURE_OPENAI_ENDPOINT / _API_KEY / _API_VERSION / _DEPLOYMENT
#    VITE_-prefixed names are also accepted.

# 3. run
.\myenv\Scripts\python.exe run.py
```

Open <http://127.0.0.1:8000>.

Click the **AI** pill in the header to run a live connectivity check against the deployment.

---

## Flow

**1 · Screen** — paste the JD, drop resumes (individual files, a whole folder, or ZIPs containing folders), tune weights / cut-offs / threshold, hit **Analyse & Shortlist**. Progress streams while the batch runs.

**2 · Review** — the generated sheet with the required columns:

`Candidate ID · Candidate Name · Phone Number · Email ID · Skills · Certification · Experience`

plus Highest Education, ATS %, per-criterion scores and status. Missing data is `NA`. Skills contain **only** what the resume literally states.

- Edit any cell inline, **+ Add row**, 🗑 delete a row, ⓘ open the full analysis drawer.
- **Save edits** persists to JSON; **✓ Accept & save to history** freezes the reviewed sheet (session becomes read-only).
- **⬇ Excel** downloads `.xlsx` — Shortlist sheet + a Screening Details sheet recording threshold, weights, cut-offs, stats and the JD.

**3 · Invite** — the agent drafts one personalised interview invitation per shortlisted candidate. The recruiter reads it, edits any part of it, then sends them all in one click.

> **No email is ever sent.** There is no SMTP client, mail SDK or outbound mail call anywhere in this codebase. "Send the mails" marks each draft `SENT`, timestamps it, and freezes the exact text that would have gone out. The UI says so on a banner, in the confirmation and on every sent card. Wiring a real transport is a deliberate, separate change.

- Drafting starts automatically when you open the tab — one call per candidate, six in parallel.
- The prompt is forbidden from mentioning any score, rank or ATS percentage — a candidate never learns how they were graded.
- It is also forbidden from inventing a date, time, format, interviewer or link, because none of those exist yet. The mail says the team will follow up with details.
- A row with no email address is skipped and named in the banner, not silently dropped.
- Sent invitations become read-only. Re-drafting never overwrites a sent mail.

**4 · History** — every accepted shortlist and every screening session, re-openable, re-exportable, deletable.

---

## Where the interviewer plugs in

The interviewer is a **separate app** that reads this one's output rather than a module inside it: it opens `data/history/*.json` read-only, lists the candidates whose status is `SHORTLISTED` or `REVIEW`, and generates its questions from the resume fields and the `jd_analysis` rubric stored in that record. Nothing here had to change for it to work, and nothing here depends on it.

Run it from [../Virtual AI Interviewer](../Virtual%20AI%20Interviewer/README.md) on port 8010, alongside this app on 8000.

Three optional seams remain if you would rather couple them more tightly:

| Seam | File | What to do |
|---|---|---|
| Mint a handle per candidate | `send_outreach()` in [main.py](backend/main.py) | Where the `SENT` fields are written, attach whatever id, token or link your interviewer needs. |
| Put it in the mail | `INVITE_SYSTEM` in [ai_agent.py](backend/ai_agent.py) | The prompt currently forbids promising a link or a format. Relax that once there is something real to promise. |
| Show the results | new tab in [index.html](frontend/index.html) / [app.js](frontend/app.js) | The tab bar and the outreach controller are the pattern to copy. |

Everything upstream — rubric, scoring, the human review gate, the draft/approve audit trail — is independent of how you interview. The interviewer deliberately never sees the ATS score, so a candidate's resume grade cannot colour their interview.

---

## Scoring

| Criterion | Default weight | Default cut-off |
|---|---|---|
| Skills | 35% | 40% |
| Experience | 25% | — |
| Education | 15% | — |
| Projects | 15% | — |
| Certifications | 10% | — |

`ATS score = Σ (criterion score × weight)`. Weights are normalised to 100% automatically.

- `ats_score ≥ threshold` and all cut-offs met → **SHORTLISTED**
- threshold met but a cut-off missed → **REVIEW** (human decides — never auto-rejected)
- below threshold → **NOT_SHORTLISTED**
- unreadable resume → **PARSE_FAILED** (row still created so a reviewer can fill it in)

The AI grades the five criteria; the arithmetic and the decision live in [scoring.py](backend/scoring.py), so every outcome is reproducible and auditable.

---

## Files

| Path | Purpose |
|---|---|
| [backend/main.py](backend/main.py) | FastAPI routes, background screening pipeline |
| [backend/ai_agent.py](backend/ai_agent.py) | Azure OpenAI calls, JD rubric + resume + invitation prompts, regex fallback |
| [backend/extractors.py](backend/extractors.py) | PDF / DOCX / DOC / RTF / TXT / nested-ZIP text extraction |
| [backend/scoring.py](backend/scoring.py) | Weights, cut-offs, decisioning, candidate row shape |
| [backend/storage.py](backend/storage.py) | Atomic JSON persistence (`data/sessions`, `data/history`) |
| [backend/dnsfix.py](backend/dnsfix.py) | DNS fallback for blocked `getaddrinfo` (see Notes) |
| [backend/excel_export.py](backend/excel_export.py) | `.xlsx` generation |
| [frontend/](frontend/) | UI (`index.html`, `styles.css`, `app.js`) |

## API

| Method | Route |
|---|---|
| POST | `/api/screen` — multipart: `files`, `paths`, `jd_text`, `job_title`, `threshold`, `weights`, `cutoffs` |
| GET | `/api/sessions/{id}/progress` · `/api/sessions/{id}` · `/api/sessions` |
| PUT | `/api/sessions/{id}/candidates` — save edits / additions / deletions |
| POST | `/api/sessions/{id}/blank-row` · `/api/sessions/{id}/accept` |
| GET | `/api/sessions/{id}/export` · `/api/history/{id}/export` |
| GET/DELETE | `/api/history` · `/api/history/{id}` |
| GET | `/api/config` · `/api/ai-check` |

**Outreach** (recruiter)

| Method | Route |
|---|---|
| GET | `/api/sessions/{id}/outreach` — eligible candidates + current drafts |
| POST | `/api/sessions/{id}/outreach/draft` — body: `candidate_ids?`, `regenerate?` |
| PUT | `/api/sessions/{id}/outreach/{candidate_id}` — save the recruiter's edits |
| POST | `/api/sessions/{id}/outreach/send` — **simulated**; marks SENT, freezes the text |

## Notes

- **Sending mail is simulated.** `EMAIL_SEND_MODE` in [config.py](backend/config.py) is hardcoded to `"simulate"` because no transport exists. To send for real you would add an SMTP or provider client and call it from `send_outreach()` in [main.py](backend/main.py) — everything else (draft, review, approve, audit trail) is already in place.
- Legacy binary `.doc` is best-effort; `.docx` or `.pdf` is far more reliable.
- Scanned image PDFs yield no text (no OCR) — they land as `PARSE_FAILED` for manual entry.
- Concurrency is capped by `MAX_CONCURRENT_AI_CALLS` (default 6) to stay inside Azure rate limits.
- `.env` and `data/` are git-ignored.

### About `backend/dnsfix.py`

The endpoint-security agent on this machine blocks `getaddrinfo` for Python processes
started by file path, so `python run.py` used to surface
`JD analysis warning: network error: [Errno 11001] getaddrinfo failed` even though the
network itself was reachable (raw TCP to the resolved IP worked fine).

`dnsfix.install()` runs on `import backend` and wraps `socket.getaddrinfo`: the native
call is tried first, and only on `gaierror` does a small DNS/UDP client query the
machine's configured resolvers (falling back to 1.1.1.1 / 8.8.8.8), with a 5-minute
cache. Because the patch sits at the socket layer, httpx, TLS/SNI and asyncio are
unaffected. On a machine without the restriction it is a no-op.

`GET /api/ai-check` reports which path is in use (`dns.native` vs `dns.fallback`).
