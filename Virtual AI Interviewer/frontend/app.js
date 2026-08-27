/* Virtual AI Interviewer - front-end controller.
 *
 * The interview loop lives in runNext(): ask the server what the interviewer says
 * next, have the interviewer say it aloud (the avatar's mouth is driven from that
 * same text), collect the answer, send it back, repeat. The server owns all the
 * state; this file owns the performance.
 */
(() => {
  "use strict";

  // Bump alongside the ?v= query in index.html. Logged so a stale cached copy is
  // obvious in the console instead of showing up as a dead button.
  const UI_BUILD = "7 · off-shortlist interviews get a sendable link";
  console.info(`%cUI build ${UI_BUILD}`, "color:#2f5bd7;font-weight:700");

  const $ = (id) => document.getElementById(id);
  const api = (path, opts) => fetch(path, opts).then(async (r) => {
    const isJson = (r.headers.get("content-type") || "").includes("json");
    const body = isJson ? await r.json() : await r.text();
    if (!r.ok) throw new Error((body && body.detail) || r.statusText);
    return body;
  });
  const postJSON = (path, payload) => api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });

  const state = {
    cfg: null,
    dash: null,               // the loaded dashboard payload for one shortlist
    historyId: null,          // which shortlist is on screen
    stageFilter: "ALL",
    dashQuery: "",
    interviewId: null,
    interview: null,          // public view of the interview
    prompt: null,             // what the interviewer is asking right now
    turns: [],                // local mirror, for the conversation log
    listening: null,          // active recogniser handle
    answerStart: 0,
    muted: false,
    busy: false,
    reportData: null,
    decision: "",
    poll: null,
    overview: null,           // dashboard payload backing the Report tab table
    ovHistoryId: null,
    ovAttend: "ALL",          // attendance filter
    ovDecision: "ALL",        // Proceed / Hold / Do not proceed / Not decided
    ovQuery: "",
    history: [],              // every interview, for the History tab
    histSelected: new Set(),  // interview ids ticked for a bulk action
    histFilter: "ALL",
    histQuery: "",
  };

  /* ------------------------------------------------------------- helpers */
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const when = (iso) => iso ? new Date(iso).toLocaleString() : "—";
  const titleise = (key) => String(key || "").replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bJd\b/g, "JD");

  /** Resumes are routinely headed with the name in block capitals and the
   *  screening extractor keeps it verbatim, which is right for the sheet but
   *  shouts on screen. Soften it for display only. */
  const properName = (raw) => {
    const name = String(raw || "").trim();
    if (!name) return "";
    const letters = [...name].filter((c) => /[a-z]/i.test(c));
    return letters.length && letters.every((c) => c === c.toUpperCase())
      ? name.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
      : name;
  };
  const band = (score) => score == null ? "" : score >= 70 ? "hi" : score >= 50 ? "mid" : "lo";

  /** A score with one decimal unless it is whole.
   *  Rounding to integers put "50%" next to a No Hire verdict, because the real
   *  value was 49.67 and the verdict bands read the exact number. */
  const pct = (v) => v == null ? "—"
    : `${Number.isInteger(v) ? v : Number(v).toFixed(1)}%`;
  /** Screening rows carry whole paragraphs in `experience`; a table cell is not
   *  the place for them. The full text stays in the cell's title attribute. */
  const clip = (text, n) => {
    const s = String(text ?? "").trim();
    return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
  };
  const words = (text) => (String(text || "").trim().match(/[\w'-]+/g) || []).length;

  let toastTimer;
  function toast(msg, kind = "") {
    const el = $("toast");
    el.textContent = msg; el.className = `toast ${kind}`; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.toggle("active", p.id === `tab-${name}`));
    if (name === "history") loadHistory();
    // Opening Reports with nothing chosen follows whatever the dashboard is on,
    // which is nearly always the shortlist the recruiter is working through.
    if (name === "report" && !state.overview && state.historyId) {
      loadOverview(state.historyId, true);
    }
  }

  /* --------------------------------------------------------------- setup */
  async function init() {
    // A thrown error used to abort init() silently, leaving buttons wired to
    // nothing and no clue why. Surface it instead.
    window.addEventListener("error", (e) =>
      toast(`UI error: ${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`, "err"));
    window.addEventListener("unhandledrejection", (e) =>
      toast(`Request failed: ${e.reason?.message || e.reason}`, "err"));

    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => showTab(t.dataset.tab)));

    try {
      state.cfg = await api("/api/config");
    } catch {
      state.cfg = { categories: {}, parameters: {}, default_weights: {},
                    default_planned_count: 10, default_max_followups: 2,
                    max_total_turns: 30, ai_configured: false, interviewer: {} };
    }

    const pill = $("aiStatus");
    pill.style.cursor = "pointer";
    pill.title = "Click to test the Azure OpenAI connection";
    pill.addEventListener("click", checkAI);
    if (state.cfg.ai_configured) {
      pill.textContent = `AI configured · ${state.cfg.deployment}`;
      pill.className = "pill pill-ok";
    } else {
      pill.textContent = "AI not configured — check .env";
      pill.className = "pill pill-bad";
    }

    $("capNote").textContent = state.cfg.max_total_turns ?? 30;
    renderCategories();
    renderWeights();
    wireSetup();
    wireStage();
    wireReport();
    wireOverview();
    describeSpeechSupport();
    loadVoices();
    await loadShortlists();

    wireHistory();
    $("closeDrawer").addEventListener("click", () => { $("drawer").hidden = true; });

    // Mounting the rig here (not on first use) means the interviewer is already
    // breathing and blinking when the candidate first sees the stage.
    if (window.Avatar) Avatar.mount($("avatarStage"));

    const params = new URLSearchParams(location.search);

    // ?shortlist=HIS-... opens that shortlist's dashboard straight away, so a
    // recruiter can bookmark the board for a role they are actively hiring for.
    const board = params.get("shortlist");
    if (board) {
      $("shortlistSelect").value = board;
      await loadDashboard(board);
    }

    // ?interview=INT-... reopens one directly, so a reviewer can bookmark or
    // share a link to a specific interview instead of hunting through History.
    const wanted = params.get("interview");
    if (wanted) {
      try {
        const view = await api(`/api/interviews/${encodeURIComponent(wanted)}`);
        if (view.has_report) await openReport(wanted);
        else await openStage(wanted);
      } catch (err) {
        toast(`Could not open ${wanted}: ${err.message}`, "err");
      }
    }

    // ?tab=history opens straight onto a tab, so any of these deep links can be
    // bookmarked at the view the recruiter actually wants.
    const tab = params.get("tab");
    if (tab && document.getElementById(`tab-${tab}`)) showTab(tab);

    window.addEventListener("beforeunload", (e) => {
      if (state.interviewId && state.interview?.status === "in_progress") {
        e.preventDefault(); e.returnValue = "";
      }
    });
  }

  async function checkAI() {
    const pill = $("aiStatus");
    pill.textContent = "testing…"; pill.className = "pill pill-muted";
    try {
      const r = await api("/api/ai-check");
      if (r.ok) {
        pill.textContent = `AI live · ${r.deployment}`; pill.className = "pill pill-ok";
        toast("Azure OpenAI reachable", "ok");
      } else {
        pill.textContent = "AI unreachable"; pill.className = "pill pill-bad";
        toast(r.detail, "err");
      }
    } catch (err) {
      pill.textContent = "AI unreachable"; pill.className = "pill pill-bad";
      toast(err.message, "err");
    }
  }

  function describeSpeechSupport() {
    const el = $("speechSupport");
    const bits = [];
    if (!Speech.canSpeak) {
      bits.push("This browser has no speech synthesiser, so the interviewer will " +
                "mime the questions silently — the mouth still follows the text.");
    }
    if (!Speech.canListen) {
      bits.push("This browser cannot transcribe speech, so answers must be typed. " +
                "Chrome or Edge supports the microphone.");
    }
    if (!bits.length) {
      el.className = "inline-note inline-note-ok";
      el.textContent = "Voice in and out are both available in this browser.";
    } else {
      el.className = "inline-note";
      el.textContent = bits.join(" ");
    }
  }

  function loadVoices() {
    const fill = () => {
      const list = Speech.voices().filter((v) => (v.lang || "").toLowerCase().startsWith("en"));
      if (!list.length) return;
      const preferred = Speech.pickVoice();
      const options = `<option value="">Recommended (${esc(preferred?.name || "system")})</option>` +
        list.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} · ${esc(v.lang)}</option>`).join("");
      // Both pickers: the dashboard defaults and the off-shortlist card's own.
      // Whatever was already chosen survives the refill.
      ["voiceSelect", "oVoiceName"].forEach((id) => {
        const el = $(id);
        if (!el) return;
        const keep = el.value;
        el.innerHTML = options;
        if (keep) el.value = keep;
      });
    };
    fill();
    // getVoices() is empty until the engine loads them, so try again shortly.
    window.speechSynthesis?.addEventListener?.("voiceschanged", fill);
    setTimeout(fill, 900);
  }

  function renderCategories() {
    const wrap = $("categoryChips");
    const cats = state.cfg.categories || {};
    wrap.innerHTML = Object.entries(cats).map(([key, meta]) => {
      const forced = key === "intro" || key === "closing";
      return `<button class="chip active" data-cat="${esc(key)}" title="${esc(meta.about)}"
        ${forced ? "disabled" : ""}>${esc(meta.label)}${forced ? " ·" : ""}</button>`;
    }).join("");
    wrap.querySelectorAll("[data-cat]").forEach((chip) => {
      if (chip.disabled) return;
      chip.addEventListener("click", () => {
        chip.classList.toggle("active");
        settingsSummary();
      });
    });
  }

  function renderWeights() {
    const body = $("weightsBody");
    const params = state.cfg.parameters || {};
    body.innerHTML = Object.entries(params).map(([key, meaning]) => `
      <tr>
        <td><strong>${esc(titleise(key))}</strong></td>
        <td><input type="number" min="0" max="100" step="1" data-weight="${esc(key)}"
             value="${state.cfg.default_weights?.[key] ?? 14}" /></td>
        <td class="why">${esc(meaning)}</td>
      </tr>`).join("");
    body.querySelectorAll("[data-weight]").forEach((i) =>
      i.addEventListener("input", sumWeights));
    sumWeights();
  }

  function collectWeights() {
    const out = {};
    document.querySelectorAll("[data-weight]").forEach((i) => {
      out[i.dataset.weight] = Number(i.value) || 0;
    });
    return out;
  }

  function sumWeights() {
    const total = Object.values(collectWeights()).reduce((a, b) => a + b, 0);
    const el = $("weightTotal");
    el.textContent = total;
    el.style.color = total === 100 ? "var(--ok)" : "var(--warn)";
  }

  function selectedCategories() {
    return [...document.querySelectorAll("[data-cat]")]
      .filter((c) => c.classList.contains("active"))
      .map((c) => c.dataset.cat);
  }

  /* ----------------------------------------------------------- setup wiring */
  /* =========================================================== dashboard */
  //
  // One row per shortlisted candidate: where they are, their link, and every
  // action the recruiter can take on them. The whole row set comes from
  // /api/dashboard/{id} in a single call - the browser never fans out per
  // candidate to find out who has an interview.

  const STAGES = {
    NOT_INVITED: { label: "Not invited", cls: "pill-muted" },
    DRAFTED:     { label: "Draft ready", cls: "pill-brand" },
    SENT:        { label: "Sent", cls: "pill-warn" },
    PREPARING:   { label: "Preparing", cls: "pill-muted" },
    IN_PROGRESS: { label: "In progress", cls: "pill-live" },
    COMPLETED:   { label: "Completed", cls: "pill-ok" },
    ABANDONED:   { label: "Discarded", cls: "pill-bad" },
    REVOKED:     { label: "Withdrawn", cls: "pill-bad" },
  };

  function wireSetup() {
    $("shortlistSelect").addEventListener("change", (e) => loadDashboard(e.target.value));
    $("dashRefresh").addEventListener("click", () => loadDashboard(state.historyId, true));

    $("dashSearch").addEventListener("input", (e) => {
      state.dashQuery = e.target.value.trim().toLowerCase();
      renderDashboard();
    });

    const bindRange = (id, out, format) => {
      const input = $(id);
      const render = () => { $(out).textContent = format(input.value); };
      input.addEventListener("input", render);
      render();
    };
    bindRange("plannedCount", "plannedOut", (v) => v);
    bindRange("maxFollowups", "followupsOut", (v) => v);
    bindRange("voiceRate", "rateOut", (v) => `${Number(v).toFixed(2)}×`);

    ["plannedCount", "maxFollowups"].forEach((id) =>
      $(id).addEventListener("input", settingsSummary));

    $("resetSettings").addEventListener("click", (e) => {
      e.preventDefault();
      $("plannedCount").value = state.cfg.default_planned_count ?? 10;
      $("maxFollowups").value = state.cfg.default_max_followups ?? 2;
      $("voiceRate").value = 0.98;
      $("plannedOut").textContent = $("plannedCount").value;
      $("followupsOut").textContent = $("maxFollowups").value;
      $("rateOut").textContent = "0.98×";
      $("voiceOn").checked = true;
      renderCategories();
      renderWeights();
      settingsSummary();
    });

    $("plannedCount").value = state.cfg.default_planned_count ?? 10;
    $("maxFollowups").value = state.cfg.default_max_followups ?? 2;
    $("plannedOut").textContent = $("plannedCount").value;
    $("followupsOut").textContent = $("maxFollowups").value;
    settingsSummary();

    renderManualCategories();
    renderManualWeights();
    const bindManual = (id, out, format) => {
      const input = $(id);
      if (!input) return;
      const render = () => { $(out).textContent = (format || ((v) => v))(input.value); };
      input.addEventListener("input", render);
      render();
    };
    bindManual("oCount", "oCountOut");
    bindManual("oFollow", "oFollowOut");
    bindManual("oRate", "oRateOut", (v) => `${Number(v).toFixed(2)}×`);
    $("oReset").addEventListener("click", (e) => {
      e.preventDefault();
      resetManualShape();
    });

    $("startBtn").addEventListener("click", prepareInterview);
  }

  function settingsSummary() {
    const cats = selectedCategories().length;
    $("settingsSummary").textContent =
      `${$("plannedCount").value} questions · up to ${$("maxFollowups").value} follow-ups each`
      + ` · ${cats} categor${cats === 1 ? "y" : "ies"}`;
  }

  /** The options every issued link and every locally-run interview inherits. */
  function currentOptions() {
    return {
      planned_count: Number($("plannedCount").value),
      max_followups: Number($("maxFollowups").value),
      categories: selectedCategories(),
      voice: $("voiceOn").checked,
      // Carried so a link the candidate opens later speaks in the voice and at
      // the speed the recruiter chose, not whatever their browser defaults to.
      voice_name: $("voiceSelect").value,
      voice_rate: Number($("voiceRate").value),
      weights: collectWeights(),
    };
  }

  async function loadShortlists() {
    const select = $("shortlistSelect");
    try {
      const data = await api("/api/shortlists");
      const rows = data.shortlists || [];
      if (!rows.length) {
        select.innerHTML = `<option value="">No shortlists found</option>`;
        fillOverviewShortlists([]);
        const note = $("shortlistEmpty");
        note.hidden = false;
        note.textContent =
          "No accepted shortlist was found from the screening app. Accept one there "
          + "first, or use “Interview somebody not on a shortlist” below. Looked in: "
          + (data.searched || []).join("  ·  ");
        return;
      }
      select.innerHTML = `<option value="">Choose a shortlist…</option>`
        + rows.map((r) => `<option value="${esc(r.history_id)}">`
          + `${esc(r.job_title)} — ${r.interviewable} to interview · accepted ${when(r.accepted_at)}`
          + `</option>`).join("");
      fillOverviewShortlists(rows);
      if (rows.length === 1) {
        select.value = rows[0].history_id;
        await loadDashboard(rows[0].history_id);
        await loadOverview(rows[0].history_id, true);
      }
    } catch (err) {
      select.innerHTML = `<option value="">Could not load shortlists</option>`;
      toast(`Shortlists: ${err.message}`, "err");
    }
  }

  async function loadDashboard(historyId, quiet) {
    if (!historyId) {
      state.dash = null;
      state.historyId = null;
      $("dashCard").hidden = true;
      $("dashStats").hidden = true;
      return;
    }
    state.historyId = historyId;
    try {
      state.dash = await api(`/api/dashboard/${encodeURIComponent(historyId)}`);
    } catch (err) {
      return toast(`Dashboard: ${err.message}`, "err");
    }

    // The manual fold shares the JD fields, so seed them from the shortlist.
    const d = state.dash;
    $("jobTitle").value = d.job_title && d.job_title !== "NA" ? d.job_title : "";
    $("jdText").value = d.jd_text || "";
    const rubric = d.jd_analysis || {};
    const note = $("rubricState");
    if (rubric.must_have_skills?.length) {
      note.className = "inline-note inline-note-ok";
      note.textContent = `Rubric loaded from the screening run — `
        + `${rubric.must_have_skills.length} must-have skills, `
        + `${(rubric.key_responsibilities || []).length} responsibilities.`;
    } else {
      note.className = "inline-note inline-note-quiet";
      note.textContent = "No rubric on this record — the interviewer will read the JD itself.";
    }

    if (!d.links_enabled) {
      // Still worth saying: without the shared secret this app cannot verify the
      // links the screening app sends, so no candidate can get in.
      const empty = $("shortlistEmpty");
      empty.hidden = false;
      empty.textContent = "Interview links are not configured on this server, so links sent "
        + "by the screening app cannot be opened. Set INTERVIEW_LINK_SECRET (or "
        + "AZURE_OPENAI_API_KEY) in .env - it must match the screening app's.";
    }

    renderDashboard();
    if (!quiet) $("dashCard").hidden = false;
  }

  function visibleRows() {
    const rows = state.dash?.rows || [];
    const q = state.dashQuery;
    return rows.filter((r) => {
      if (state.stageFilter !== "ALL" && r.stage !== state.stageFilter) return false;
      if (!q) return true;
      return [r.candidate_name, r.current_role, r.email_id, r.experience]
        .some((v) => String(v || "").toLowerCase().includes(q));
    });
  }

  function renderDashboard() {
    const d = state.dash;
    if (!d) return;

    $("dashSub").textContent = `${d.job_title} · ${d.stats.total} shortlisted · `
      + `accepted ${when(d.accepted_at)}`;

    const s = d.stats;
    const stats = [
      ["Shortlisted", s.total, ""],
      ["Not invited", s.counts.NOT_INVITED || 0, s.counts.NOT_INVITED ? "warn" : ""],
      // Named for what it means to the recruiter: invited, not started yet.
      // A candidate who has begun is counted under "In progress" instead.
      ["Awaiting start", (s.counts.DRAFTED || 0) + (s.counts.SENT || 0), ""],
      ["In progress", (s.counts.IN_PROGRESS || 0) + (s.counts.PREPARING || 0), ""],
      ["Completed", s.completed, s.completed ? "ok" : ""],
      ["Average score", s.average_score == null ? "—" : `${s.average_score}%`, ""],
    ];
    $("dashStats").innerHTML = stats.map(([label, val, cls]) =>
      `<div class="stat ${cls}"><div class="n">${esc(val)}</div>`
      + `<div class="l">${esc(label)}</div></div>`).join("");
    $("dashStats").hidden = false;

    const counts = { ALL: d.rows.length };
    d.rows.forEach((r) => { counts[r.stage] = (counts[r.stage] || 0) + 1; });
    const order = ["ALL", "NOT_INVITED", "DRAFTED", "SENT", "IN_PROGRESS",
                   "COMPLETED", "ABANDONED", "REVOKED"];
    $("stageFilters").innerHTML = order
      .filter((k) => k === "ALL" || counts[k])
      .map((k) => `<button class="chip ${state.stageFilter === k ? "active" : ""}"`
        + ` data-stage="${k}">${k === "ALL" ? "All" : STAGES[k].label} (${counts[k] || 0})</button>`)
      .join("");
    $("stageFilters").querySelectorAll("[data-stage]").forEach((b) =>
      b.addEventListener("click", () => {
        state.stageFilter = b.dataset.stage;
        renderDashboard();
      }));

    const rows = visibleRows();
    const body = $("dashBody");
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7" class="sub" style="padding:18px">`
        + `No candidates match this filter.</td></tr>`;
    } else {
      body.innerHTML = rows.map(dashRow).join("");
      wireDashRows();
    }

  }

  function dashRow(r) {
    const stage = STAGES[r.stage] || STAGES.NOT_INVITED;
    const iv = r.interview;
    const inv = r.invite;

    const score = iv && iv.overall_score != null
      ? `<span class="score ${band(iv.overall_score)}">${pct(iv.overall_score)}</span>`
        + `<br /><span class="sub">${esc(titleise(iv.verdict || ""))}</span>`
      : iv
        // "of ~N", not "n/N": live follow-ups take the real count past the plan.
        ? `<span class="sub">${iv.answered} of ~${iv.planned_total || "?"} answered</span>`
        : `<span class="sub">—</span>`;

    // Invitations are the screening app's doing; this column reports what it did.
    const out = r.outreach;
    const inviteCell = `
      <div class="link-cell">
        ${out
          ? out.sent
            ? `<span class="sub">sent ${when(out.sent_at)}</span>`
            : `<span class="pill pill-brand">draft ready</span>
               <span class="sub">not sent yet</span>`
          : `<span class="sub">not invited from screening</span>`}
        ${inv && inv.revoked ? `<span class="pill pill-bad">withdrawn</span>` : ""}
      </div>`;

    return `
    <tr data-cid="${esc(r.candidate_id)}">
      <td><strong>${esc(properName(r.candidate_name))}</strong><br />
          <span class="sub">${esc(r.email_id)}</span></td>
      <td class="cell-role">${esc(clip(r.current_role, 70))}
          <span class="sub" title="${esc(r.experience)}">${esc(clip(r.experience, 90))}</span></td>
      <td><span class="score ${band(r.ats_score)}">${r.ats_score ?? "—"}%</span></td>
      <td><span class="pill ${stage.cls}">${esc(stage.label)}</span></td>
      <td>${score}</td>
      <td>${inviteCell}</td>
      <td class="row-actions">${rowActions(r)}</td>
    </tr>`;
  }

  function rowActions(r) {
    const cid = esc(r.candidate_id);
    const inv = r.invite;
    const iv = r.interview;
    const out = [];

    const done = iv && iv.status === "completed";

    // Settings first: it is what you set before doing anything else with them.
    if (!done) {
      out.push(`<button class="btn btn-ghost btn-xs" data-cset="${cid}"
                  title="Set this candidate's own question count, depth and categories"
                  >⚙ Settings</button>`);
    }

    // Reading the invitation only makes sense once the screening app has written
    // one; withdrawing works whether or not this app ever saw the link.
    if (r.outreach) {
      out.push(`<button class="btn btn-ghost btn-xs" data-mail="${cid}"
                  title="Read the invitation the screening app sent"
                  >Invitation…</button>`);
    }
    if (inv && inv.revoked) {
      out.push(`<button class="btn btn-ghost btn-xs" data-unrevoke="${cid}">Restore link</button>`);
    } else if (!done && r.outreach) {
      out.push(`<button class="btn btn-ghost btn-xs" data-revoke="${cid}"
                  title="Stop this candidate's link from opening an interview"
                  >Deactivate link</button>`);
    }

    if (iv && iv.overall_score != null) {
      out.push(`<button class="btn btn-ghost btn-xs" data-report="${cid}">Report</button>`);
      out.push(`<button class="btn btn-ghost btn-xs" data-xl="${cid}">⬇</button>`);
    } else if (iv && iv.status !== "abandoned") {
      out.push(`<button class="btn btn-ghost btn-xs" data-resume="${cid}">Open</button>`);
    } else {
      out.push(`<button class="btn btn-ghost btn-xs" data-now="${cid}"
                  title="Conduct this interview yourself, here and now">Interview now</button>`);
    }
    const badge = optionsBadge(r);
    return out.join(" ") + (badge ? `<div class="row-badge">${badge}</div>` : "");
  }

  function wireDashRows() {
    const body = $("dashBody");
    const rowFor = (cid) => (state.dash.rows || []).find((r) => r.candidate_id === cid);

    body.querySelectorAll("[data-revoke]").forEach((b) =>
      b.addEventListener("click", () => setRevoked(b.dataset.revoke, true)));
    body.querySelectorAll("[data-unrevoke]").forEach((b) =>
      b.addEventListener("click", () => setRevoked(b.dataset.unrevoke, false)));
    body.querySelectorAll("[data-mail]").forEach((b) =>
      b.addEventListener("click", () => openMail(b.dataset.mail, state.historyId)));
    body.querySelectorAll("[data-report]").forEach((b) =>
      b.addEventListener("click", () => openReport(rowFor(b.dataset.report).interview.interview_id)));
    body.querySelectorAll("[data-resume]").forEach((b) =>
      b.addEventListener("click", () => openStage(rowFor(b.dataset.resume).interview.interview_id)));
    body.querySelectorAll("[data-xl]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = rowFor(b.dataset.xl).interview.interview_id;
        window.location.href = `/api/interviews/${id}/export`;
      }));
    body.querySelectorAll("[data-now]").forEach((b) =>
      b.addEventListener("click", () => interviewNow(rowFor(b.dataset.now))));
    body.querySelectorAll("[data-cset]").forEach((b) =>
      b.addEventListener("click", () => openCandidateSettings(b.dataset.cset)));
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg || "Copied", "ok");
    } catch {
      // Clipboard needs a secure context; a prompt still lets them copy manually.
      window.prompt("Copy this:", text);
    }
  }

  /** Record that a one-off invitation went out.

   *  Only the off-shortlist flow reaches this: shortlisted candidates are sent
   *  to by the screening app, which keeps its own record of what it sent.
   */
  async function markSent(ids, scope) {
    try {
      await Promise.all(ids.map((id) => postJSON(
        `/api/invites/${encodeURIComponent(scope)}/${encodeURIComponent(id)}/sent`,
        { channel: "manual", by: "recruiter" })));
      toast("Marked as sent", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  }

  async function setRevoked(cid, revoked) {
    if (revoked && !confirm("Withdraw this link? The candidate will not be able to "
                            + "start or resume their interview with it.")) return;
    try {
      await postJSON(`/api/invites/${encodeURIComponent(state.historyId)}`
                     + `/${encodeURIComponent(cid)}/revoke`, { revoked });
      await loadDashboard(state.historyId, true);
      toast(revoked ? "Link withdrawn" : "Link restored", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  }

  /** Show one candidate's invitation.
   *
   *  Two different things share this drawer. A shortlisted candidate's mail was
   *  written and sent by the screening app, so it is shown as a record - the
   *  frozen text, and when it went - with nothing to act on. A one-off candidate
   *  prepared in this app has no screening record, so that mail is a draft the
   *  recruiter still has to send, and keeps the buttons that help them do it.
   */
  async function openMail(cid, scopeId, displayName) {
    const scope = scopeId || state.historyId;
    let mail;
    try {
      mail = await api(`/api/invites/${encodeURIComponent(scope)}`
                       + `/${encodeURIComponent(cid)}/mail`);
    } catch (err) {
      return toast(err.message, "err");
    }
    const row = (state.dash?.rows || []).find((r) => r.candidate_id === cid);
    const who = displayName || row?.candidate_name || "";
    const fromScreening = mail.source === "screening";

    $("drawerTitle").textContent = `Invitation · ${properName(who)}`;
    $("drawerBody").innerHTML = `
      <div class="inline-note">${fromScreening
        ? (mail.sent
            ? `Sent by the screening app on ${esc(when(mail.sent_at))}. This is the exact
               text that went out— it is a record, and cannot be changed here.`
            : `The screening app has drafted this but has not sent it yet. Send it from
               there; this app does not send email.`)
        : `This app does not send email. Open it in your own mail client, or copy the
           text — then mark it as sent so the record shows it went out.`}</div>
      <h4>To</h4>
      <p>${mail.has_email ? esc(mail.to)
        : `<span class="warn-text">no email address on this row</span>`}</p>
      <h4>Subject</h4>
      <p>${esc(mail.subject)}</p>
      <h4>Body</h4>
      <pre class="mail-body">${esc(mail.body)}</pre>
      <div class="drawer-actions">
        ${!fromScreening && mail.has_email
          ? `<a class="btn btn-primary" href="${esc(mail.mailto)}">Open in my mail app</a>` : ""}
        <button class="btn btn-ghost" id="copyMailBody">Copy the text</button>
        ${fromScreening ? "" : `
          <button class="btn btn-ghost" id="copyMailLink">Copy just the link</button>
          <button class="btn btn-ghost" id="markMailSent">✓ Mark as sent</button>`}
      </div>`;
    $("drawer").hidden = false;

    $("copyMailBody").addEventListener("click", () =>
      copyText(`${mail.subject}

${mail.body}`, "Invitation copied"));
    $("copyMailLink")?.addEventListener("click", () => copyText(mail.link, "Link copied"));
    $("markMailSent")?.addEventListener("click", async () => {
      await markSent([cid], scope);
      $("drawer").hidden = true;
    });
  }

  /** Conduct this shortlisted candidate's interview here and now, no link. */
  async function interviewNow(row) {
    if (!row) return;
    if (!confirm(`Start ${properName(row.candidate_name)}'s interview in this browser now?\n\n`
                 + "Use this when you are sitting with the candidate. To let them take it "
                 + "in their own time, issue a link instead.")) return;
    $("planProgress").hidden = false;
    $("planStage").textContent = "Starting";
    $("planDetail").textContent = "";
    try {
      const res = await postJSON("/api/interviews", {
        source: "screening",
        history_id: state.historyId,
        candidate_id: row.candidate_id,
        job_title: state.dash.job_title,
        jd_text: state.dash.jd_text,
        jd_analysis: state.dash.jd_analysis || {},
        options: currentOptions(),
      });
      state.interviewId = res.interview_id;
      await waitForPlan();
      await loadDashboard(state.historyId, true);
    } catch (err) {
      toast(`Could not prepare the interview: ${err.message}`, "err");
      $("planProgress").hidden = true;
    }
  }

  function manualCandidate() {
    return {
      candidate_name: $("mName").value.trim(),
      email_id: $("mEmail").value.trim(),
      current_role: $("mRole").value.trim(),
      experience: $("mExp").value.trim(),
      highest_education: $("mEdu").value.trim(),
      certification: $("mCerts").value.trim(),
      skills: $("mSkills").value.trim(),
      projects: $("mProjects").value.trim(),
      resume_text: $("mResume").value.trim(),
    };
  }

  /** The off-shortlist form's own interview shape, independent of the dashboard
   *  defaults - a one-off candidate is usually being interviewed for a reason. */
  function manualOptions() {
    const weights = {};
    document.querySelectorAll("[data-ow]").forEach((i) => {
      weights[i.dataset.ow] = Number(i.value) || 0;
    });
    return {
      planned_count: Number($("oCount").value),
      max_followups: Number($("oFollow").value),
      categories: [...document.querySelectorAll("[data-ocat]")]
        .filter((c) => c.classList.contains("active"))
        .map((c) => c.dataset.ocat),
      voice: $("oVoiceOn").checked,
      voice_name: $("oVoiceName").value,
      voice_rate: Number($("oRate").value),
      weights,
    };
  }

  function renderManualWeights() {
    const body = $("oWeightsBody");
    if (!body) return;
    body.innerHTML = Object.entries(state.cfg.parameters || {}).map(([key, meaning]) => `
      <tr>
        <td><strong>${esc(titleise(key))}</strong></td>
        <td><input type="number" min="0" max="100" step="1" data-ow="${esc(key)}"
             value="${state.cfg.default_weights?.[key] ?? 14}" /></td>
        <td class="why">${esc(meaning)}</td>
      </tr>`).join("");
    body.querySelectorAll("[data-ow]").forEach((i) =>
      i.addEventListener("input", sumManualWeights));
    sumManualWeights();
  }

  function sumManualWeights() {
    const total = [...document.querySelectorAll("[data-ow]")]
      .reduce((a, i) => a + (Number(i.value) || 0), 0);
    const el = $("oWTotal");
    if (!el) return;
    el.textContent = total;
    el.style.color = total === 100 ? "var(--ok)" : "var(--warn)";
  }

  /** Put the card's shape controls back to the configured defaults. */
  function resetManualShape() {
    $("oCount").value = state.cfg.default_planned_count ?? 10;
    $("oFollow").value = state.cfg.default_max_followups ?? 2;
    $("oCountOut").textContent = $("oCount").value;
    $("oFollowOut").textContent = $("oFollow").value;
    $("oVoiceOn").checked = true;
    $("oRate").value = 0.98;
    $("oRateOut").textContent = "0.98×";
    $("oVoiceName").value = "";
    renderManualCategories();
    renderManualWeights();
  }

  function renderManualCategories() {
    const wrap = $("oCats");
    if (!wrap) return;
    wrap.innerHTML = Object.entries(state.cfg.categories || {}).map(([key, meta]) => {
      const forced = key === "intro" || key === "closing";
      return `<button class="chip active" data-ocat="${esc(key)}" title="${esc(meta.about)}"
        ${forced ? "disabled" : ""}>${esc(meta.label)}${forced ? " ·" : ""}</button>`;
    }).join("");
    wrap.querySelectorAll("[data-ocat]").forEach((chip) => {
      if (chip.disabled) return;
      chip.addEventListener("click", () => chip.classList.toggle("active"));
    });
  }

  /** The manual fold: a candidate who never went through screening. */
  async function prepareInterview() {
    const jd = $("jdText").value.trim();
    if (!jd) return toast("Paste the job description first", "err");

    const payload = {
      job_title: $("jobTitle").value.trim(),
      jd_text: jd,
      options: manualOptions(),
    };

    const candidate = manualCandidate();
    if (!candidate.candidate_name) return toast("The candidate needs a name", "err");
    if (!candidate.resume_text && !candidate.skills && !candidate.projects) {
      return toast("Add the resume text, or at least skills and projects", "err");
    }
    payload.source = "manual";
    payload.candidate = candidate;

    const btn = $("startBtn");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Preparing…";
    $("planProgress").hidden = false;
    $("planStage").textContent = "Starting";
    $("planDetail").textContent = "";

    try {
      const res = await postJSON("/api/interviews", payload);
      state.interviewId = res.interview_id;
      const status = await waitForPlan({ openStage: false });
      await showPreparedLink(res.interview_id, candidate, status);
    } catch (err) {
      toast(`Could not prepare the interview: ${err.message}`, "err");
      $("planProgress").hidden = true;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /**
   * The off-shortlist result: a link to send, or the option to sit down with them
   * now. The interview already exists at this point, so the link points straight
   * at it rather than at a shortlist entry that does not exist.
   */
  async function showPreparedLink(interviewId, candidate, status) {
    const panel = $("oResult");
    const name = properName(candidate.candidate_name) || "the candidate";
    const total = status?.planned_total || "";

    let invite = null;
    try {
      const res = await postJSON(`/api/interviews/${encodeURIComponent(interviewId)}/link`,
                                 { issued_by: "recruiter" });
      invite = res.invite;
    } catch (err) {
      console.warn("link:", err.message);
    }

    panel.innerHTML = `
      <div class="prepared-head">
        <span class="prepared-mark">✓</span>
        <div>
          <strong>Interview prepared for ${esc(name)}</strong>
          <span class="sub">${total ? `${total} questions · ` : ""}${esc(interviewId)}</span>
        </div>
      </div>

      ${invite ? `
        <div class="link-box">
          <span class="link-label">Interview link</span>
          <a href="${esc(invite.link)}" target="_blank" rel="noopener">${esc(invite.link)}</a>
          <button class="btn btn-ghost btn-xs" data-oc="${esc(invite.link)}">Copy</button>
        </div>
        <p class="hint">Unique to ${esc(name)}. Opening it starts this interview — there is
          nothing for them to schedule.</p>`
      : `<div class="inline-note">A link could not be issued. Check
           INTERVIEW_LINK_SECRET (or AZURE_OPENAI_API_KEY) in .env — you can still
           conduct the interview yourself below.</div>`}

      <div class="answer-actions">
        ${invite ? `<button class="btn btn-ghost" id="oMail">✉ Invitation…</button>
                    <button class="btn btn-ghost" id="oSent">✓ Mark as sent</button>` : ""}
        <button class="btn btn-primary" id="oNow">Interview now</button>
        <button class="btn btn-link" id="oAnother">Prepare another</button>
      </div>`;
    panel.hidden = false;
    panel.scrollIntoView({ behavior: "smooth", block: "center" });

    panel.querySelectorAll("[data-oc]").forEach((b) =>
      b.addEventListener("click", () => copyText(b.dataset.oc, "Link copied")));
    $("oMail")?.addEventListener("click", () =>
      openMail(interviewId, "__one_off__", candidate.candidate_name));
    $("oSent")?.addEventListener("click", () =>
      markSent([interviewId], "__one_off__"));
    $("oNow").addEventListener("click", () => openStage(interviewId));
    $("oAnother").addEventListener("click", () => {
      panel.hidden = true;
      ["mName", "mEmail", "mRole", "mExp", "mEdu", "mCerts", "mSkills",
       "mProjects", "mResume"].forEach((id) => { $(id).value = ""; });
      $("mName").focus();
    });

    toast(`Interview prepared for ${name}`, "ok");
  }

  /** Poll until the question plan exists, then open the stage. */
  /** Poll until the question plan exists. `opts.openStage` decides whether to
   *  jump straight onto the Interview tab, which the off-shortlist flow does not
   *  want - it offers a link first. */
  function waitForPlan(opts = {}) {
    const jump = opts.openStage !== false;
    return new Promise((resolve) => {
      clearInterval(state.poll);
      state.poll = setInterval(async () => {
        try {
          const s = await api(`/api/interviews/${state.interviewId}/status`);
          $("planStage").textContent = s.progress?.stage || s.status;
          $("planDetail").textContent = s.progress?.detail || "";
          if (s.status !== "planning") {
            clearInterval(state.poll);
            $("planProgress").hidden = true;
            if (s.plan_error) {
              toast(s.plan_error, "");
              console.warn("plan note:", s.plan_error);
            }
            if (jump) await openStage(state.interviewId);
            resolve(s);
          }
        } catch (err) {
          clearInterval(state.poll);
          $("planProgress").hidden = true;
          toast(`Planning failed: ${err.message}`, "err");
          resolve();
        }
      }, 1200);
    });
  }

  /* ============================================================== STAGE */
  function wireStage() {
    $("beginBtn").addEventListener("click", beginInterview);
    $("micBtn").addEventListener("click", toggleMic);
    $("submitBtn").addEventListener("click", () => submitAnswer("voice"));
    $("skipBtn").addEventListener("click", skipQuestion);
    $("repeatBtn").addEventListener("click", repeatQuestion);
    $("evaluateBtn").addEventListener("click", evaluateInterview);
    $("abandonBtn").addEventListener("click", abandonInterview);
    $("muteBtn").addEventListener("click", () => {
      state.muted = !state.muted;
      $("muteBtn").textContent = state.muted ? "🔊 Unmute voice" : "🔈 Mute voice";
      if (state.muted) Speech.cancel();
      toast(state.muted ? "Voice muted — the questions are still on screen" : "Voice on", "");
    });

    $("answerText").addEventListener("input", () => {
      const n = words($("answerText").value);
      $("answerStats").textContent = `${n} word${n === 1 ? "" : "s"}`;
      $("submitBtn").disabled = n < 1;
    });
  }

  async function openStage(interviewId) {
    state.interviewId = interviewId;
    try {
      state.interview = await api(`/api/interviews/${interviewId}`);
    } catch (err) {
      return toast(`Could not open the interview: ${err.message}`, "err");
    }
    state.turns = state.interview.turns || [];

    $("noStage").hidden = true;
    $("stageBody").hidden = false;
    showTab("stage");

    const who = state.interview.interviewer || {};
    $("interviewerName").textContent = who.name || "Interviewer";
    $("interviewerRole").textContent =
      `${who.role || "Interviewer"}${who.company ? ` · ${who.company}` : ""}` +
      ` — interviewing ${properName(state.interview.candidate?.candidate_name) || "the candidate"}` +
      ` for ${state.interview.job_title || "the role"}`;

    if (state.interview.options?.voice === false) {
      state.muted = true;
      $("muteBtn").textContent = "🔊 Unmute voice";
    }

    renderTurnLog();
    updateProgressUI(state.interview.progress || {});

    if (state.interview.status === "completed") {
      $("startGate").hidden = true;
      $("answerBox").hidden = true;
      $("finishGate").hidden = false;
      $("questionText").textContent = "This interview is finished.";
      setChip("Completed", "pill-ok");
      return;
    }

    // Mid-interview reload: pick the conversation back up where it stopped.
    const last = state.turns[state.turns.length - 1];
    if (last && !(last.answer || "").trim()) {
      $("startGate").hidden = true;
      state.prompt = {
        kind: "question", turn: last.turn, question_id: last.question_id,
        category: last.category, category_label: last.category_label,
        question: last.question, speech: last.question,
        question_source: last.question_source, emotion: "neutral",
        expects_answer: true, progress: state.interview.progress,
      };
      renderPrompt(state.prompt);
      $("questionHint").textContent =
        "Picked up where you left off. Use “Repeat question” to hear it again.";
      openAnswerBox();
      setChip("Your turn", "pill-live");
    } else if (state.turns.length) {
      // Answers all in, mid-interview: carry on with the next question.
      $("startGate").hidden = true;
      runNext();
    } else {
      $("startGate").hidden = false;
      $("answerBox").hidden = true;
      $("finishGate").hidden = true;
      setChip("Ready", "pill-muted");
    }
  }

  function setChip(text, cls) {
    const chip = $("stageChip");
    chip.textContent = text;
    chip.className = `pill ${cls || "pill-muted"}`;
  }

  function setBadge(text) {
    const badge = $("avatarBadge");
    if (!text) { badge.hidden = true; return; }
    $("avatarBadgeText").textContent = text;
    badge.hidden = false;
  }

  async function beginInterview() {
    $("startGate").hidden = true;
    // The mic meter needs the click that got us here: browsers only grant audio
    // access from inside a user gesture.
    if (Speech.canListen) {
      Speech.startMeter((level) => {
        $("levelFill").style.width = `${Math.round(level * 100)}%`;
        Avatar.pulse(level);
      });
    }
    await runNext();
  }

  /** One step of the interview: ask the server what comes next, then perform it. */
  async function runNext() {
    if (state.busy) return;
    state.busy = true;
    try {
      const prompt = await postJSON(`/api/interviews/${state.interviewId}/next`);
      state.prompt = prompt;
      updateProgressUI(prompt.progress || {});

      if (prompt.kind === "opening") {
        $("questionText").textContent = "…";
        $("qCategory").textContent = "Introduction";
        await say(prompt.speech, prompt.emotion || "friendly");
        state.busy = false;
        return runNext();
      }

      if (prompt.kind === "question") {
        renderPrompt(prompt);
        await say(prompt.speech, prompt.emotion || "neutral");
        openAnswerBox();
        setChip("Your turn", "pill-live");
        return;
      }

      if (prompt.kind === "closing" || prompt.kind === "done") {
        $("answerBox").hidden = true;
        $("qCategory").textContent = "Closing";
        $("questionText").textContent = prompt.speech || "The interview is complete.";
        if (prompt.speech) await say(prompt.speech, "friendly");
        $("finishGate").hidden = false;
        setChip("Interview complete", "pill-ok");
        return;
      }
    } catch (err) {
      toast(`Interview step failed: ${err.message}`, "err");
      setChip("Paused", "pill-bad");
    } finally {
      state.busy = false;
    }
  }

  function renderPrompt(prompt) {
    $("qCategory").textContent = prompt.category_label || "Question";
    $("qCategory").className = "pill pill-brand";
    const diff = $("qDifficulty");
    if (prompt.difficulty) {
      diff.hidden = false;
      diff.textContent = prompt.difficulty;
    } else diff.hidden = true;
    $("qFollowup").hidden = prompt.question_source !== "followup";
    $("questionText").textContent = prompt.question || "";
    $("questionHint").textContent = prompt.question_source === "followup"
      ? "The interviewer asked this because of what you just said."
      : "";
  }

  function updateProgressUI(progress) {
    const total = progress.planned_total || state.interview?.planned_total || 0;
    const asked = progress.planned_asked || 0;
    $("qCount").textContent = total
      ? `Question ${Math.min(asked, total)} of ${total}` +
        (progress.followups ? ` · ${progress.followups} follow-up${progress.followups === 1 ? "" : "s"}` : "")
      : "";
    $("qFill").style.width = `${progress.percent || 0}%`;
    const answered = progress.answered ?? 0;
    $("turnCount").textContent = `${answered} answer${answered === 1 ? "" : "s"} recorded`;
  }

  /** Speak a line, driving the avatar's mouth and the caption from the text. */
  async function say(text, emotion) {
    if (!text) return;
    Avatar.setEmotion(emotion || "neutral").setState("speaking");
    setChip("Speaking", "pill-brand");
    setBadge(null);
    const caption = $("caption");
    const tokens = tokenise(text);
    caption.innerHTML = tokens.map((t) => esc(t.text)).join("");

    // The interview's own settings win: it may have been configured for this one
    // candidate. The dashboard controls are the fallback.
    const vo = state.interview?.options || {};
    await Speech.speak(text, {
      rate: vo.voice_rate || Number($("voiceRate").value) || 0.98,
      voiceName: vo.voice_name || $("voiceSelect").value || "",
      mute: state.muted,
      onViseme: (name, intensity) => Avatar.setViseme(name, intensity),
      onWord: (charIndex) => highlight(caption, tokens, charIndex),
    });

    Avatar.stopSpeaking();
    caption.innerHTML = esc(text);
  }

  /** Split into word/gap tokens so the caption can bold the word being spoken. */
  function tokenise(text) {
    const tokens = [];
    const re = /\S+|\s+/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      tokens.push({ text: match[0], start: match.index,
                    end: match.index + match[0].length, word: /\S/.test(match[0]) });
    }
    return tokens;
  }

  function highlight(container, tokens, charIndex) {
    const active = tokens.findIndex((t) => t.word && t.end > charIndex);
    container.innerHTML = tokens.map((t, i) =>
      i === active ? `<b>${esc(t.text)}</b>` : esc(t.text)).join("");
  }

  /* --------------------------------------------------------- answer capture */
  function openAnswerBox() {
    $("answerBox").hidden = false;
    $("finishGate").hidden = true;
    const box = $("answerText");
    box.value = "";
    box.disabled = false;
    $("answerStats").textContent = "0 words";
    $("submitBtn").disabled = true;
    state.answerStart = performance.now();

    Avatar.setEmotion("encouraging").setState("listening");
    setBadge(null);

    // Auto-start the microphone: making the candidate press record for every
    // question turns a conversation into a form.
    if (Speech.canListen && !state.listening) startMic();
    else if (!Speech.canListen) {
      $("micBtn").disabled = true;
      $("micBtn").textContent = "🎤 Not available";
      $("answerLabel").textContent = "Your answer (type it)";
      box.focus();
    }
  }

  function startMic() {
    if (state.listening) return;
    const box = $("answerText");
    state.answerStart = state.answerStart || performance.now();
    state.listening = Speech.listen({
      onInterim: (text) => {
        box.value = text;
        const n = words(text);
        $("answerStats").textContent = `${n} word${n === 1 ? "" : "s"}`;
        $("submitBtn").disabled = n < 1;
      },
      onError: (msg) => toast(msg, "err"),
    });
    if (!state.listening.supported) {
      state.listening = null;
      return;
    }
    $("micBtn").textContent = "⏹ Stop the mic";
    $("micBtn").className = "btn btn-rec";
    $("answerLabel").textContent = "Your answer — listening, speak naturally";
    setBadge("Listening");
    // Taking notes while the candidate talks, which is what a human does.
    Avatar.setState("noting");
  }

  async function stopMic() {
    if (!state.listening) return "";
    const handle = state.listening;
    state.listening = null;
    $("micBtn").textContent = "🎤 Start answering";
    $("micBtn").className = "btn btn-primary";
    $("answerLabel").textContent = "Your answer";
    setBadge(null);
    $("levelFill").style.width = "0%";
    Avatar.setState("listening");
    return handle.stop();
  }

  async function toggleMic() {
    if (state.listening) {
      const text = await stopMic();
      if (text && !$("answerText").value.trim()) $("answerText").value = text;
      $("answerText").focus();
    } else {
      startMic();
    }
  }

  async function submitAnswer(mode) {
    if (state.busy) return;
    const seconds = state.answerStart ? (performance.now() - state.answerStart) / 1000 : 0;
    if (state.listening) await stopMic();
    const answer = $("answerText").value.trim();
    if (!answer && mode !== "skipped") return toast("Nothing to submit yet", "");

    state.busy = true;
    $("submitBtn").disabled = true;
    $("micBtn").disabled = true;
    $("skipBtn").disabled = true;
    $("answerText").disabled = true;

    // The interviewer considers the answer while the grading call is in flight - the
    // real work, so showing it as thought rather than a spinner is honest.
    Avatar.setEmotion("thinking").setState("thinking");
    setChip("Considering your answer", "pill-muted");

    try {
      const res = await postJSON(`/api/interviews/${state.interviewId}/answer`, {
        turn: state.prompt.turn,
        answer,
        seconds,
        mode: mode || "voice",
      });

      const local = state.turns.find((t) => t.turn === state.prompt.turn);
      const record = {
        turn: state.prompt.turn,
        question_id: state.prompt.question_id,
        category: state.prompt.category,
        category_label: state.prompt.category_label,
        question: state.prompt.question,
        question_source: state.prompt.question_source,
        answer,
      };
      if (local) Object.assign(local, record);
      else state.turns.push(record);

      renderTurnLog();
      updateProgressUI(res.progress || {});
      if (res.grading_error) console.warn("grading note:", res.grading_error);

      Avatar.setEmotion(res.reaction?.emotion || "neutral");
      if (res.answer_type === "substantive") Avatar.nod(2);
      else Avatar.nod(1);
      if (res.followup_queued) $("questionHint").textContent = "That is worth digging into…";
    } catch (err) {
      toast(`Could not submit that answer: ${err.message}`, "err");
      $("answerText").disabled = false;
      $("micBtn").disabled = false;
      $("skipBtn").disabled = false;
      $("submitBtn").disabled = false;
      state.busy = false;
      return;
    }

    $("micBtn").disabled = false;
    $("skipBtn").disabled = false;
    $("answerBox").hidden = true;
    state.busy = false;
    await runNext();
  }

  async function skipQuestion() {
    if (!confirm("Skip this question? It will be recorded as unanswered.")) return;
    $("answerText").value = "";
    await submitAnswer("skipped");
  }

  async function repeatQuestion() {
    if (!state.prompt?.question) return toast("Nothing to repeat yet", "");
    const wasListening = Boolean(state.listening);
    if (wasListening) await stopMic();
    await say(state.prompt.question, "friendly");
    if ($("answerBox").hidden === false) {
      Avatar.setState("listening");
      setChip("Your turn", "pill-live");
      if (wasListening) startMic();
    }
  }

  function renderTurnLog() {
    const answered = state.turns.filter((t) => t.question);
    const log = $("turnLog");
    if (!answered.length) {
      log.innerHTML = `<p class="sub">Nothing yet.</p>`;
      return;
    }
    log.innerHTML = answered.map((t) => `
      <div class="turn ${t.question_source === "followup" ? "followup" : ""}">
        <div class="turn-q">
          <span>${esc(t.question_id || `Q${t.turn}`)}</span>
          <span class="pill pill-muted">${esc(t.category_label || t.category || "")}</span>
          ${t.question_source === "followup" ? `<span class="pill pill-warn">follow-up</span>` : ""}
        </div>
        <p class="turn-question">${esc(t.question)}</p>
        <p class="turn-answer ${(t.answer || "").trim() ? "" : "empty"}">${
          esc((t.answer || "").trim() || "No answer given.")}</p>
      </div>`).reverse().join("");
  }

  async function abandonInterview() {
    if (!confirm("End this interview and discard it? The transcript so far is kept " +
                 "but it will not be evaluated.")) return;
    Speech.cancel();
    if (state.listening) await stopMic();
    Speech.stopMeter();
    try {
      await postJSON(`/api/interviews/${state.interviewId}/abandon`,
                     { reason: "Ended by the operator" });
      toast("Interview ended", "");
      $("stageBody").hidden = true;
      $("noStage").hidden = false;
      state.interviewId = null;
      state.interview = null;
      loadHistory();
    } catch (err) {
      toast(err.message, "err");
    }
  }

  /* ------------------------------------------- one candidate's interview shape */
  //
  // Overrides the dashboard defaults for a single named person. Question count,
  // depth of follow-up and which categories are probed are all fair game -
  // tailoring what you ask is ordinary interviewer judgement.
  //
  // Evaluation weights are deliberately NOT here. Scoring two people for the same
  // role on differently weighted criteria makes their scores incomparable, which
  // is the unfairness this project exists to avoid.

  async function openCandidateSettings(cid) {
    const row = (state.dash?.rows || []).find((r) => r.candidate_id === cid);
    if (!row) return;

    let info;
    try {
      info = await api(`/api/candidate-options/${encodeURIComponent(state.historyId)}`
                       + `/${encodeURIComponent(cid)}`);
    } catch (err) {
      return toast(err.message, "err");
    }

    const o = info.options;
    const cats = state.cfg.categories || {};
    const chosen = new Set(o.categories || []);

    $("drawerTitle").textContent = `Interview settings · ${properName(row.candidate_name)}`;
    $("drawerBody").innerHTML = `
      ${info.locked ? `<div class="inline-note">${esc(info.lock_reason)} Saving here will
        apply if you re-run this candidate, but it will not change the interview in
        progress.</div>` : ""}

      <div class="inline-note ${info.has_override ? "" : "inline-note-quiet"}">
        ${info.has_override
          ? `This candidate has settings of their own. They override the dashboard
             defaults${info.updated_at ? ` · set ${esc(when(info.updated_at))}` : ""}.`
          : `Following the dashboard defaults. Change anything below to give
             ${esc(properName(row.candidate_name))} their own shape.`}
      </div>

      <h4>Questions</h4>
      <div class="settings-row">
        <label class="field field-inline"><span>Planned questions</span>
          <input id="csCount" type="range" min="4" max="20" step="1"
                 value="${o.planned_count}" /></label>
        <output id="csCountOut" class="settings-out">${o.planned_count}</output>

        <label class="field field-inline"><span>Follow-ups each</span>
          <input id="csFollow" type="range" min="0" max="4" step="1"
                 value="${o.max_followups}" /></label>
        <output id="csFollowOut" class="settings-out">${o.max_followups}</output>
      </div>

      <h4>Categories to probe</h4>
      <div class="chipset chipset-wrap" id="csCats">
        ${Object.entries(cats).map(([key, meta]) => {
          const forced = key === "intro" || key === "closing";
          const on = forced || chosen.has(key);
          return `<button class="chip ${on ? "active" : ""}" data-cscat="${esc(key)}"
                    title="${esc(meta.about)}" ${forced ? "disabled" : ""}
                    >${esc(meta.label)}${forced ? " ·" : ""}</button>`;
        }).join("")}
      </div>
      <p class="hint">Introduction and closing are always asked. Narrowing the mix means
        fewer evaluation parameters get evidence — those are reported as
        <em>not tested</em> rather than scored low.</p>

      <h4>Voice</h4>
      <label class="check"><input id="csVoice" type="checkbox" ${o.voice ? "checked" : ""} />
        Interviewer speaks out loud</label>
      <label class="field"><span>Voice</span>
        <select id="csVoiceName">${voiceOptions(o.voice_name)}</select></label>
      <div class="settings-row">
        <label class="field field-inline"><span>Speaking rate</span>
          <input id="csRate" type="range" min="0.7" max="1.3" step="0.02"
                 value="${o.voice_rate}" /></label>
        <output id="csRateOut" class="settings-out">${Number(o.voice_rate).toFixed(2)}×</output>
      </div>
      <p class="hint">The voice and rate apply wherever this interview is taken —
        including in the candidate's own browser when they open their link. If the
        named voice is not installed there, the best available English voice is used.</p>

      <h4>Evaluation weights</h4>
      <div class="inline-note">Weights decide how the seven parameters combine into the
        overall score. Setting them for one candidate means their score is <strong>not
        directly comparable</strong> with anybody scored on the defaults. It is allowed,
        and it is recorded: the report and the row both say so.</div>
      <table class="criteria-table criteria-tight">
        <thead><tr><th>Parameter</th><th>Weight (%)</th></tr></thead>
        <tbody>
          ${Object.keys(state.cfg.parameters || {}).map((key) => `
            <tr><td>${esc(titleise(key))}</td>
                <td><input type="number" min="0" max="100" step="1" data-csw="${esc(key)}"
                      value="${(o.weights || info.default_weights || {})[key] ?? 0}" /></td></tr>
          `).join("")}
        </tbody>
        <tfoot><tr><td>Total</td><td id="csWTotal">100</td></tr></tfoot>
      </table>
      <p class="hint">Anything that does not add to 100 is scaled to 100 on save, so the
        ratios you type are what matter.</p>

      <h4>Why this candidate</h4>
      <input id="csNote" type="text" placeholder="optional — e.g. specialist hire, weight technical higher"
             value="${esc(info.note || "")}" />

      ${info.link_issued ? `<div class="inline-note inline-note-quiet">A link has already
        been issued. Saving updates it, so long as they have not started.</div>` : ""}

      <div class="drawer-actions">
        <button class="btn btn-primary" id="csSave">Save for this candidate</button>
        ${info.has_override
          ? `<button class="btn btn-ghost" id="csReset">Use the defaults instead</button>`
          : ""}
        <button class="btn btn-link" id="csCancel">Cancel</button>
      </div>`;
    $("drawer").hidden = false;

    const bind = (id, out) => {
      const input = $(id);
      input.addEventListener("input", () => { $(out).textContent = input.value; });
    };
    bind("csCount", "csCountOut");
    bind("csFollow", "csFollowOut");
    $("csRate").addEventListener("input", () => {
      $("csRateOut").textContent = `${Number($("csRate").value).toFixed(2)}×`;
    });
    $("drawerBody").querySelectorAll("[data-csw]").forEach((i) =>
      i.addEventListener("input", sumDrawerWeights));
    sumDrawerWeights();

    $("csCats").querySelectorAll("[data-cscat]").forEach((chip) => {
      if (chip.disabled) return;
      chip.addEventListener("click", () => chip.classList.toggle("active"));
    });

    $("csCancel").addEventListener("click", () => { $("drawer").hidden = true; });
    $("csSave").addEventListener("click", () => saveCandidateSettings(cid));
    $("csReset")?.addEventListener("click", () => resetCandidateSettings(cid));
  }

  /** The installed voices as <option>s, with `selected` on the stored one.
   *
   *  A stored voice that is not installed on THIS machine is still listed, marked
   *  as such. Without that, opening the drawer on a machine lacking the voice
   *  would show "Recommended" and a plain Save would silently wipe the recruiter's
   *  choice - and the voice may well exist on the candidate's machine.
   */
  function voiceOptions(selectedName) {
    const list = (window.Speech ? Speech.voices() : [])
      .filter((v) => (v.lang || "").toLowerCase().startsWith("en"));
    const preferred = window.Speech ? Speech.pickVoice() : null;
    const installed = list.some((v) => v.name === selectedName);

    let out = `<option value=""${selectedName ? "" : " selected"}>`
      + `Recommended (${esc(preferred?.name || "system")})</option>`;
    if (selectedName && !installed) {
      out += `<option value="${esc(selectedName)}" selected>${esc(selectedName)}`
        + ` · not installed here</option>`;
    }
    return out + list.map((v) =>
      `<option value="${esc(v.name)}"${v.name === selectedName ? " selected" : ""}>`
      + `${esc(v.name)} · ${esc(v.lang)}</option>`).join("");
  }

  function sumDrawerWeights() {
    const inputs = [...$("drawerBody").querySelectorAll("[data-csw]")];
    const total = inputs.reduce((a, i) => a + (Number(i.value) || 0), 0);
    const el = $("csWTotal");
    if (!el) return;
    el.textContent = total;
    el.style.color = total === 100 ? "var(--ok)" : "var(--warn)";
  }

  function drawerOptions() {
    const weights = {};
    $("drawerBody").querySelectorAll("[data-csw]").forEach((i) => {
      weights[i.dataset.csw] = Number(i.value) || 0;
    });
    return {
      planned_count: Number($("csCount").value),
      max_followups: Number($("csFollow").value),
      categories: [...$("csCats").querySelectorAll("[data-cscat]")]
        .filter((c) => c.classList.contains("active"))
        .map((c) => c.dataset.cscat),
      voice: $("csVoice").checked,
      voice_name: $("csVoiceName").value,
      voice_rate: Number($("csRate").value),
      weights,
    };
  }

  async function saveCandidateSettings(cid) {
    const btn = $("csSave");
    btn.disabled = true;
    try {
      const res = await api(
        `/api/candidate-options/${encodeURIComponent(state.historyId)}`
        + `/${encodeURIComponent(cid)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ options: drawerOptions(), note: $("csNote").value.trim(),
                                 set_by: "recruiter" }),
        });
      $("drawer").hidden = true;
      await loadDashboard(state.historyId, true);
      toast("Settings saved for this candidate"
            + (res.applied_to_existing_link ? " · their existing link now uses them" : "")
            + (res.interview_already_started
                ? " · their interview in progress keeps its original plan" : ""), "ok");
    } catch (err) {
      toast(`Could not save: ${err.message}`, "err");
    } finally {
      btn.disabled = false;
    }
  }

  async function resetCandidateSettings(cid) {
    if (!confirm("Drop this candidate's own settings and follow the dashboard "
                 + "defaults instead?")) return;
    try {
      await api(`/api/candidate-options/${encodeURIComponent(state.historyId)}`
                + `/${encodeURIComponent(cid)}`, { method: "DELETE" });
      $("drawer").hidden = true;
      await loadDashboard(state.historyId, true);
      toast("Back to the dashboard defaults", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  }

  /** A one-line summary of what a row will actually get, for the Actions column. */
  function optionsBadge(row) {
    if (!row.has_custom_options) return "";
    const o = row.options || {};
    const bits = [`${o.planned_count}Q`];
    if (o.max_followups !== undefined) bits.push(`${o.max_followups} follow-up`);
    const total = Object.keys(state.cfg.categories || {}).length;
    if (o.categories && total && o.categories.length < total) {
      bits.push(`${o.categories.length}/${total} categories`);
    }
    if (o.voice_name) bits.push("set voice");
    const badge = `<span class="pill pill-brand" title="${esc(row.options_note
      || "Settings set for this candidate")}">⚙ ${esc(bits.join(" · "))}</span>`;
    // Custom weights get their own marker: it is the one override that makes this
    // candidate's score not directly comparable with anybody else's.
    return badge + (row.has_custom_weights
      ? ` <span class="pill pill-warn" title="Scored on weights of their own, so this`
        + ` score is not directly comparable with one scored on the defaults."`
        + `>⚖ custom weights</span>`
      : "");
  }

  /* ================================================== report overview (tab 3) */
  //
  // Who attended, who did not, and what was decided about each of them - for one
  // shortlist, because "did not attend" only means anything against a known list
  // of people. Reuses /api/dashboard/{id}; attendance and the decision are
  // derived on the server so this table and the Excel report cannot disagree.

  const ATTEND = {
    COMPLETED:    { label: "Yes · completed", cls: "pill-ok" },
    PARTIAL:      { label: "Yes · unfinished", cls: "pill-warn" },
    NOT_STARTED:  { label: "No · never started", cls: "pill-bad" },
    NO_INTERVIEW: { label: "No · not invited", cls: "pill-muted" },
  };

  const DECISION = {
    PROCEED: { label: "Proceed", cls: "pill-ok" },
    HOLD:    { label: "Hold", cls: "pill-warn" },
    REJECT:  { label: "Do not proceed", cls: "pill-bad" },
    "":      { label: "Not decided", cls: "pill-muted" },
  };

  const ATTEND_FILTERS = [
    ["ALL", "All"],
    ["ATTENDED", "Attended"],
    ["NOT_ATTENDED", "Not attended"],
    ["COMPLETED", "Completed"],
    ["PARTIAL", "Unfinished"],
    ["NOT_STARTED", "Never started"],
    ["NO_INTERVIEW", "Not invited"],
  ];

  const DECISION_FILTERS = [
    ["ALL", "All"],
    ["PROCEED", "Proceed"],
    ["HOLD", "Hold"],
    ["REJECT", "Do not proceed"],
    ["NONE", "Not decided"],
  ];

  function wireOverview() {
    $("ovShortlist").addEventListener("change", (e) => loadOverview(e.target.value));
    $("ovRefresh").addEventListener("click", () => loadOverview(state.ovHistoryId, true));
    $("ovSearch").addEventListener("input", (e) => {
      state.ovQuery = e.target.value.trim().toLowerCase();
      renderOverview();
    });
    $("ovClear").addEventListener("click", () => {
      state.ovAttend = "ALL";
      state.ovDecision = "ALL";
      state.ovQuery = "";
      $("ovSearch").value = "";
      renderOverview();
    });
    $("ovExport").addEventListener("click", () => {
      if (state.ovHistoryId) {
        window.location.href =
          `/api/dashboard/${encodeURIComponent(state.ovHistoryId)}/export`;
      }
    });
  }

  /** The shortlist picker is shared in spirit with the dashboard's, so mirror it. */
  const ALL_SCOPE = "__ALL__";

  function fillOverviewShortlists(rows) {
    const select = $("ovShortlist");
    // "All interviews" is always offered: it is the only view that includes
    // one-off interviews and ones whose shortlist has since been deleted.
    const allOption = `<option value="${ALL_SCOPE}">All interviews — every shortlist, `
      + `plus one-offs</option>`;
    if (!rows.length) {
      select.innerHTML = `<option value="">No shortlists found</option>` + allOption;
      return;
    }
    select.innerHTML = `<option value="">Choose a shortlist…</option>` + allOption
      + rows.map((r) => `<option value="${esc(r.history_id)}">`
        + `${esc(r.job_title)} — ${r.interviewable} candidates · accepted ${when(r.accepted_at)}`
        + `</option>`).join("");
  }

  async function loadOverview(historyId, quiet) {
    if (!historyId) {
      state.overview = null;
      state.ovHistoryId = null;
      ["ovStats", "ovFilterBar", "ovTableWrap", "ovHint"].forEach((id) => { $(id).hidden = true; });
      $("ovExport").disabled = true;
      return;
    }
    state.ovHistoryId = historyId;
    $("ovShortlist").value = historyId;
    try {
      state.overview = historyId === ALL_SCOPE
        ? await api("/api/reports")
        : await api(`/api/dashboard/${encodeURIComponent(historyId)}`);
    } catch (err) {
      return toast(`Reports: ${err.message}`, "err");
    }
    renderOverview();
    if (!quiet) toast("Reports loaded", "");
  }

  function overviewRows() {
    const rows = state.overview?.rows || [];
    const q = state.ovQuery;
    return rows.filter((r) => {
      const a = state.ovAttend;
      if (a === "ATTENDED" && !r.attended) return false;
      if (a === "NOT_ATTENDED" && r.attended) return false;
      if (!["ALL", "ATTENDED", "NOT_ATTENDED"].includes(a) && r.attendance !== a) return false;

      const d = state.ovDecision;
      if (d === "NONE" && r.decision) return false;
      if (d !== "ALL" && d !== "NONE" && r.decision !== d) return false;

      if (!q) return true;
      return [r.candidate_name, r.current_role, r.email_id]
        .some((v) => String(v || "").toLowerCase().includes(q));
    });
  }

  function renderOverview() {
    const d = state.overview;
    if (!d) return;
    const s = d.stats;

    const allMode = d.scope === "all";
    $("ovSub").textContent = allMode
      ? `Every interview on record · ${s.total} in total · ${s.attended} answered something`
      : `${d.job_title} · ${s.total} shortlisted · ${s.attended} attended · `
        + `${s.not_attended} did not`;
    $("ovHint").innerHTML = allMode
      ? `This view lists every interview, including one-offs and any whose shortlist has been
         deleted. <strong>It cannot show who did not attend</strong> — with no candidate list there
         is nobody to be absent. Pick a shortlist above for that.`
      : `“Attended” means they answered at least one question. Somebody invited who never opened
         their link counts as not attended. Decisions are recorded on an individual report below —
         open one to set or change it.`;
    // The summary workbook is built per shortlist, so it has no meaning here.
    $("ovExport").disabled = allMode;
    $("ovExport").title = allMode
      ? "Pick a shortlist to export its report"
      : "Download this shortlist as one Excel report";

    $("ovStats").innerHTML = [
      [allMode ? "Interviews" : "Shortlisted", s.total, ""],
      [allMode ? "Answered something" : "Attended", s.attended, s.attended ? "ok" : ""],
      [allMode ? "Never started" : "Did not attend", s.not_attended, s.not_attended ? "bad" : ""],
      ["Proceed", s.decisions.PROCEED || 0, "ok"],
      ["Hold", s.decisions.HOLD || 0, "warn"],
      ["Do not proceed", s.decisions.REJECT || 0, "bad"],
      ["Not decided", s.decisions.NONE || 0, ""],
    ].map(([label, val, cls]) =>
      `<div class="stat ${cls}"><div class="n">${esc(val)}</div>`
      + `<div class="l">${esc(label)}</div></div>`).join("");

    // Counts come from the unfiltered set so a chip never reads zero just
    // because the other filter is narrowing the view.
    const rows = d.rows;
    const attendCount = (key) =>
      key === "ALL" ? rows.length
        : key === "ATTENDED" ? s.attended
          : key === "NOT_ATTENDED" ? s.not_attended
            : (s.attendance[key] || 0);
    $("ovAttendFilters").innerHTML = ATTEND_FILTERS
      .filter(([k]) => ["ALL", "ATTENDED", "NOT_ATTENDED"].includes(k) || attendCount(k))
      .map(([k, label]) => `<button class="chip ${state.ovAttend === k ? "active" : ""}"`
        + ` data-oa="${k}">${label} (${attendCount(k)})</button>`).join("");
    $("ovAttendFilters").querySelectorAll("[data-oa]").forEach((b) =>
      b.addEventListener("click", () => { state.ovAttend = b.dataset.oa; renderOverview(); }));

    $("ovDecisionFilters").innerHTML = DECISION_FILTERS
      .map(([k, label]) => {
        const n = k === "ALL" ? rows.length : (s.decisions[k] || 0);
        return `<button class="chip ${state.ovDecision === k ? "active" : ""}"`
          + ` data-od="${k}">${label} (${n})</button>`;
      }).join("");
    $("ovDecisionFilters").querySelectorAll("[data-od]").forEach((b) =>
      b.addEventListener("click", () => { state.ovDecision = b.dataset.od; renderOverview(); }));

    const shown = overviewRows();
    $("ovBody").innerHTML = shown.length
      ? shown.map(overviewRow).join("")
      : `<tr><td colspan="9" class="sub" style="padding:18px">`
        + `No candidates match these filters.</td></tr>`;
    wireOverviewRows();

    ["ovStats", "ovFilterBar", "ovTableWrap", "ovHint"].forEach((id) => { $(id).hidden = false; });
  }

  function overviewRow(r) {
    const att = ATTEND[r.attendance] || ATTEND.NO_INTERVIEW;
    const dec = DECISION[r.decision] || DECISION[""];
    const iv = r.interview;
    const review = iv?.human_review;

    const score = iv && iv.overall_score != null
      ? `<span class="score ${band(iv.overall_score)}">${pct(iv.overall_score)}</span>`
        + `<br /><span class="sub">${esc(titleise(iv.verdict || ""))}</span>`
      : `<span class="sub">—</span>`;

    return `
    <tr>
      <td><strong>${esc(properName(r.candidate_name))}</strong><br />
          <span class="sub">${esc(r.email_id)}</span></td>
      <td class="cell-role">${esc(clip(r.current_role, 60))}</td>
      <td><span class="pill ${att.cls}">${esc(att.label)}</span></td>
      <td>${!iv ? "—"
        : iv.status === "completed"
          // Follow-ups push the real count past the planned one, so "11 / 10"
          // would read like a bug. Once finished, the count stands alone.
          ? `${iv.answered}`
          : `${iv.answered}<span class="sub"> of ~${iv.planned_total || "?"}</span>`}</td>
      <td>${score}</td>
      <td><span class="pill ${dec.cls}">${esc(dec.label)}</span>${
        review?.override_score != null
          ? `<br /><span class="sub">override ${review.override_score}%</span>` : ""}</td>
      <td>${review?.reviewer && review.reviewer !== "NA"
            ? `${esc(review.reviewer)}<br /><span class="sub">${when(review.reviewed_at)}</span>`
            : `<span class="sub">—</span>`}</td>
      <td><span class="score ${band(r.ats_score)}">${r.ats_score ?? "—"}%</span></td>
      <td>${iv && iv.overall_score != null
            ? `<button class="btn btn-ghost btn-xs" data-ovrep="${esc(iv.interview_id)}">Open</button>`
            : ""}</td>
    </tr>`;
  }

  function wireOverviewRows() {
    $("ovBody").querySelectorAll("[data-ovrep]").forEach((b) =>
      b.addEventListener("click", () => openReport(b.dataset.ovrep)));
  }

  /* ============================================================== REPORT */
  async function evaluateInterview() {
    const btn = $("evaluateBtn");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Reviewing the whole conversation…";
    Speech.cancel();
    Speech.stopMeter();
    if (state.listening) await stopMic();
    Avatar.setEmotion("thinking").setState("thinking");
    setChip("Writing up the interview", "pill-muted");
    try {
      await postJSON(`/api/interviews/${state.interviewId}/finish`);
      await openReport(state.interviewId);
      toast("Evaluation complete", "ok");
    } catch (err) {
      toast(`Evaluation failed: ${err.message}`, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function wireReport() {
    $("exportBtn").addEventListener("click", () => {
      if (state.interviewId) {
        window.location.href = `/api/interviews/${state.interviewId}/export`;
      }
    });
    $("regradeBtn").addEventListener("click", async () => {
      const btn = $("regradeBtn");
      btn.disabled = true;
      try {
        await postJSON(`/api/interviews/${state.interviewId}/regrade`);
        await openReport(state.interviewId);
        toast("Re-reviewed", "ok");
      } catch (err) {
        toast(err.message, "err");
      } finally { btn.disabled = false; }
    });
    $("decisionChips").querySelectorAll("[data-decision]").forEach((chip) =>
      chip.addEventListener("click", () => {
        state.decision = chip.dataset.decision;
        $("decisionChips").querySelectorAll("[data-decision]").forEach((c) =>
          c.classList.toggle("active", c === chip));
      }));
    $("saveReviewBtn").addEventListener("click", saveReview);
  }

  async function openReport(interviewId) {
    state.interviewId = interviewId;
    let data;
    try {
      data = await api(`/api/interviews/${interviewId}/report`);
    } catch (err) {
      return toast(`Report: ${err.message}`, "err");
    }
    state.reportData = data;
    renderReport(data);
    $("noReport").hidden = true;
    $("reportBody").hidden = false;
    showTab("report");
  }

  function renderReport(data) {
    const rep = data.report || {};
    const cand = data.candidate || {};

    $("repCandidate").textContent = properName(cand.candidate_name) || "Candidate";
    $("repMeta").textContent =
      `${data.job_title || "Role"} · interviewed by ${data.interviewer?.name || "the AI interviewer"}` +
      ` · ${when(data.completed_at || data.started_at)} · ${data.interviewer?.company || ""}`;

    const score = rep.overall_score;
    const dial = $("scoreDial");
    dial.style.setProperty("--pct", score ?? 0);
    $("repScore").textContent = pct(score);

    const verdict = $("repVerdict");
    verdict.textContent = titleise(rep.verdict || "not assessed");
    verdict.className = "pill pill-lg " + (
      rep.verdict === "STRONG_HIRE" ? "pill-ok" :
      rep.verdict === "HIRE" ? "pill-ok" :
      rep.verdict === "BORDERLINE" ? "pill-warn" : "pill-bad");

    $("repConfidence").textContent = `${rep.confidence || "?"} confidence`;
    $("repSummary").textContent = rep.summary || "No written summary was produced.";

    // A score produced on bespoke weights must never look like a like-for-like
    // number. Say so above the summary, with the deltas.
    const wc = $("repWeightNote");
    if (rep.weights_are_custom) {
      const diffs = Object.entries(rep.weight_differences || {})
        .map(([k, d]) => `${titleise(k)} ${d.used}% (default ${d.default}%)`)
        .join(" · ");
      wc.hidden = false;
      wc.className = "inline-note";
      wc.innerHTML = `<strong>Scored on weights set for this candidate.</strong> `
        + `This overall score is not directly comparable with one produced on the `
        + `default weights. Differences: ${esc(diffs)}.`;
    } else {
      wc.hidden = true;
    }

    const why = $("repConfWhy");
    if ((rep.confidence_reasons || []).length) {
      why.hidden = false;
      why.textContent = `Confidence was limited because ${rep.confidence_reasons.join("; ")}.`;
    } else why.hidden = true;

    // The comparison a hiring manager actually wants: how the interview landed
    // against how the resume looked.
    const cov = rep.coverage || {};
    const ats = (rep.screening_reference || {}).ats_score;
    $("repCompare").innerHTML = [
      [pct(score), "Interview score",
       "how they performed today"],
      [pct(ats), "Resume ATS score",
       "screening stage · not part of the interview score"],
      [`${cov.answered || 0} / ${cov.asked || 0}`, "Questions answered",
       `${cov.followups || 0} follow-ups asked`],
      [`${cov.graded || 0}`, "Answers graded",
       cov.ungraded ? `${cov.ungraded} could not be graded` : "every answer graded"],
      [`${Math.round((cov.total_seconds || 0) / 60)} min`, "Speaking time",
       `${cov.total_words || 0} words`],
    ].map(([n, l, d]) => `<div class="compare"><div class="n">${esc(n)}</div>
        <div class="l">${esc(l)}</div><div class="d">${esc(d)}</div></div>`).join("");

    // parameters
    const params = rep.parameters || {};
    const weights = rep.parameter_weights || {};
    const notes = rep.parameter_notes || {};
    $("paramList").innerHTML = Object.keys(state.cfg.parameters || params).map((key) => {
      const p = params[key] || {};
      const value = p.score;
      const unevidenced = value == null;
      return `
      <div class="param ${unevidenced ? "unevidenced" : ""}">
        <div class="param-head">
          <span class="param-name">${esc(titleise(key))}
            <span class="param-weight">· weight ${weights[key] ?? "—"}%</span></span>
          <span class="param-score ${band(value)}">${
            unevidenced ? "not tested by this interview" : `${value}%`}</span>
        </div>
        ${unevidenced ? "" : `<div class="param-bar"><i class="${band(value)}"
          style="width:${Math.max(2, value)}%"></i></div>`}
        <div class="param-note">${esc(notes[key] || "")}</div>
        <div class="param-basis">${esc(p.basis || "")}${
          p.answers ? ` · from ${p.answers} answer${p.answers === 1 ? "" : "s"}` : ""}${
          p.turn_score != null && p.holistic_score != null
            ? ` · per-answer ${p.turn_score}% vs closing review ${p.holistic_score}%` : ""}</div>
      </div>`;
    }).join("");

    const bullets = (id, items, empty) => {
      $(id).innerHTML = (items || []).length
        ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
        : `<p class="sub">${esc(empty)}</p>`;
    };
    bullets("repStrengths", rep.strengths, "Nothing recorded.");
    bullets("repGaps", rep.gaps, "Nothing recorded.");
    bullets("repStandout", rep.standout_moments, "No single answer stood out.");
    bullets("repNotCovered", rep.not_covered, "Nothing flagged as untested.");
    bullets("repRisks", rep.risk_flags, "None.");

    $("repNextStep").textContent = rep.recommended_next_step ||
      "No next step was recommended — read the transcript and decide.";

    const review = data.human_review || state.reportData?.human_review;
    if (review) {
      $("revName").value = review.reviewer === "NA" ? "" : review.reviewer || "";
      $("revNotes").value = review.notes || "";
      $("revOverride").value = review.override_score ?? "";
      state.decision = review.decision || "";
      $("decisionChips").querySelectorAll("[data-decision]").forEach((c) =>
        c.classList.toggle("active", c.dataset.decision === state.decision));
      $("reviewSaved").textContent = `Last saved ${when(review.reviewed_at)}`;
    }

    $("repCoverage").textContent =
      `${cov.asked || 0} asked · ${cov.answered || 0} answered · ${cov.followups || 0} follow-ups`;
    renderTranscript(data.turns || []);
  }

  function renderTranscript(turns) {
    if (!turns.length) {
      $("repTranscript").innerHTML = `<p class="sub">No transcript.</p>`;
      return;
    }
    $("repTranscript").innerHTML = turns.map((t) => {
      const a = t.assessment || {};
      const scores = a.scores || {};
      const grades = Object.entries(scores).map(([k, v]) =>
        `<span class="tr-grade ${band(v)}">${esc(titleise(k))} ${v}</span>`).join("");
      const list = (items) => (items || []).length
        ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="sub">—</p>`;
      const answered = (t.answer || "").trim();
      return `
      <div class="tr-turn ${t.question_source === "followup" ? "followup" : ""}">
        <div class="tr-head">
          <span class="pill pill-muted">${esc(t.question_id || `Q${t.turn}`)}</span>
          <span class="pill pill-brand">${esc(t.category_label || t.category)}</span>
          ${t.difficulty ? `<span class="pill pill-muted">${esc(t.difficulty)}</span>` : ""}
          ${t.question_source === "followup" ? `<span class="pill pill-warn">follow-up</span>` : ""}
          ${a.answer_type ? `<span class="pill pill-muted">${esc(a.answer_type.replace(/_/g, " "))}</span>` : ""}
          ${a.source === "fallback" ? `<span class="pill pill-bad" title="${esc(a.error || "")}">not graded</span>` : ""}
          <span class="sub">${(t.metrics?.words) || 0} words · ${t.answer_seconds || 0}s</span>
        </div>
        <p class="tr-q">${esc(t.question)}</p>
        <div class="tr-a ${answered ? "" : "empty"}">${esc(answered || "No answer given.")}</div>
        ${grades ? `<div class="tr-grades">${grades}</div>` : ""}
        ${a.evidence ? `<p class="tr-evidence">Evidence: ${esc(a.evidence)}</p>` : ""}
        <div class="tr-notes">
          <div><h5>Strengths</h5>${list(a.strengths)}</div>
          <div><h5>Concerns</h5>${list(a.concerns)}</div>
        </div>
        ${t.intent ? `<p class="sub" style="margin-top:8px">Tested: ${esc(t.intent)}</p>` : ""}
      </div>`;
    }).join("");
  }

  async function saveReview() {
    const payload = {
      decision: state.decision,
      reviewer: $("revName").value.trim(),
      notes: $("revNotes").value.trim(),
      override_score: $("revOverride").value.trim(),
    };
    if (!payload.decision) return toast("Pick Proceed, Hold or Do not proceed", "err");
    try {
      const res = await api(`/api/interviews/${state.interviewId}/review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      $("reviewSaved").textContent = `Saved ${when(res.human_review.reviewed_at)}`;
      toast("Decision saved", "ok");
      loadHistory();
      if (state.ovHistoryId) loadOverview(state.ovHistoryId, true);
      if (state.historyId) loadDashboard(state.historyId, true);
    } catch (err) {
      toast(err.message, "err");
    }
  }

  /* ============================================================= HISTORY */
  //
  // Every interview ever run, selectable so an admin can clear out a batch. The
  // rows are held in state so filtering and selection do not need a round trip.

  const HIST_FILTERS = [
    ["ALL", "All"],
    ["completed", "Completed"],
    ["in_progress", "In progress"],
    ["ready", "Not started"],
    ["planning", "Preparing"],
    ["abandoned", "Discarded"],
  ];

  async function loadHistory() {
    try {
      state.history = await api("/api/interviews");
    } catch (err) {
      return toast(`History load failed: ${err.message}`, "err");
    }
    // Drop selections for rows that no longer exist.
    const ids = new Set(state.history.map((r) => r.interview_id));
    [...state.histSelected].forEach((id) => {
      if (!ids.has(id)) state.histSelected.delete(id);
    });
    renderHistory();
  }

  function visibleHistory() {
    const q = state.histQuery;
    return state.history.filter((r) => {
      if (state.histFilter !== "ALL" && r.status !== state.histFilter) return false;
      if (!q) return true;
      return [r.candidate_name, r.job_title, r.interview_id, r.source]
        .some((v) => String(v || "").toLowerCase().includes(q));
    });
  }

  function renderHistory() {
    const all = state.history;
    const rows = visibleHistory();

    $("histSub").textContent = all.length
      ? `${all.length} interview${all.length === 1 ? "" : "s"} on record`
      : "";

    const counts = { ALL: all.length };
    all.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    $("histFilters").innerHTML = HIST_FILTERS
      .filter(([key]) => key === "ALL" || counts[key])
      .map(([key, label]) => `<button class="chip ${state.histFilter === key ? "active" : ""}"`
        + ` data-hf="${key}">${label} (${counts[key] || 0})</button>`).join("");
    $("histFilters").querySelectorAll("[data-hf]").forEach((b) =>
      b.addEventListener("click", () => {
        state.histFilter = b.dataset.hf;
        renderHistory();
      }));

    $("historyList").innerHTML = rows.length
      ? rows.map(historyRow).join("")
      : `<p class="sub">${all.length ? "No interviews match this filter."
                                     : "No interviews yet."}</p>`;
    wireHistoryRows();
    updateHistorySelection();
  }

  function historyRow(r) {
    const picked = state.histSelected.has(r.interview_id);
    const badge = r.verdict
      ? `<span class="pill ${
          r.verdict === "STRONG_HIRE" || r.verdict === "HIRE" ? "pill-ok"
          : r.verdict === "BORDERLINE" ? "pill-warn" : "pill-bad"
        }">${esc(titleise(r.verdict))}${
          r.overall_score != null ? ` · ${pct(r.overall_score)}` : ""}</span>`
      : `<span class="pill pill-muted">${esc(titleise(r.status))}</span>`;

    return `
    <div class="hrow ${picked ? "picked" : ""}">
      <label class="hrow-pick">
        <input type="checkbox" data-hpick="${esc(r.interview_id)}" ${picked ? "checked" : ""} />
      </label>
      <div class="hrow-main">
        <div class="ht">${esc(properName(r.candidate_name))}
          <span class="sub">· ${esc(r.job_title)}</span>
          ${badge}
        </div>
        <div class="hm">${esc(r.interview_id)} · ${when(r.created_at)} · ${r.turns} answers
          · from ${esc(r.source)}</div>
      </div>
      <div class="ha">
        ${r.overall_score != null
          ? `<button class="btn btn-ghost" data-rep="${esc(r.interview_id)}">Open report</button>
             <button class="btn btn-ghost" data-xl="${esc(r.interview_id)}">⬇ Excel</button>`
          : `<button class="btn btn-ghost" data-resume="${esc(r.interview_id)}">${
               r.status === "planning" ? "Open" : "Resume"}</button>`}
        <button class="btn btn-ghost" data-del="${esc(r.interview_id)}">Delete</button>
      </div>
    </div>`;
  }

  function wireHistoryRows() {
    const list = $("historyList");
    list.querySelectorAll("[data-hpick]").forEach((box) =>
      box.addEventListener("change", () => {
        const id = box.dataset.hpick;
        if (box.checked) state.histSelected.add(id); else state.histSelected.delete(id);
        box.closest(".hrow").classList.toggle("picked", box.checked);
        updateHistorySelection();
      }));
    list.querySelectorAll("[data-rep]").forEach((b) =>
      b.addEventListener("click", () => openReport(b.dataset.rep)));
    list.querySelectorAll("[data-resume]").forEach((b) =>
      b.addEventListener("click", () => openStage(b.dataset.resume)));
    list.querySelectorAll("[data-xl]").forEach((b) =>
      b.addEventListener("click", () => {
        window.location.href = `/api/interviews/${b.dataset.xl}/export`;
      }));
    list.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", () => deleteInterviews([b.dataset.del])));

  }

  /** Keep the header controls in step with what is ticked. */
  function updateHistorySelection() {
    const n = state.histSelected.size;
    const shown = visibleHistory().map((r) => r.interview_id);
    $("histSelCount").textContent = n ? `${n} selected` : "none selected";
    $("histDelete").disabled = n === 0;
    $("histDelete").textContent = n > 1 ? `🗑 Delete ${n} selected` : "🗑 Delete selected";
    $("histSelectAll").checked = shown.length > 0 && shown.every((id) => state.histSelected.has(id));
    // Only interviews with a report can be exported.
    const exportable = state.history.filter((r) =>
      state.histSelected.has(r.interview_id) && r.overall_score != null);
    $("histExport").disabled = exportable.length === 0;
    $("histExport").textContent = exportable.length > 1
      ? `⬇ Excel for ${exportable.length}` : "⬇ Excel for selected";
  }

  function wireHistory() {
    $("refreshHistory").addEventListener("click", loadHistory);

    $("histSelectAll").addEventListener("change", (e) => {
      visibleHistory().forEach((r) => {
        if (e.target.checked) state.histSelected.add(r.interview_id);
        else state.histSelected.delete(r.interview_id);
      });
      renderHistory();
    });

    $("histSearch").addEventListener("input", (e) => {
      state.histQuery = e.target.value.trim().toLowerCase();
      renderHistory();
    });

    $("histDelete").addEventListener("click", () =>
      deleteInterviews([...state.histSelected]));

    $("histExport").addEventListener("click", () => {
      const ready = state.history.filter((r) =>
        state.histSelected.has(r.interview_id) && r.overall_score != null);
      if (!ready.length) return;
      // One workbook per interview; the browser blocks a burst of navigations, so
      // they are opened as staggered downloads instead.
      ready.forEach((r, i) => setTimeout(() => {
        const frame = document.createElement("iframe");
        frame.style.display = "none";
        frame.src = `/api/interviews/${r.interview_id}/export`;
        document.body.appendChild(frame);
        setTimeout(() => frame.remove(), 60000);
      }, i * 400));
      toast(`Downloading ${ready.length} workbook${ready.length === 1 ? "" : "s"}`, "ok");
    });
  }

  /** Same shape as the bulk route, one request per id. Used only as a fallback. */
  async function deleteOneByOne(ids) {
    const deleted = [];
    const missing = [];
    for (const id of ids) {
      try {
        await api(`/api/interviews/${encodeURIComponent(id)}`, { method: "DELETE" });
        deleted.push(id);
      } catch {
        missing.push(id);
      }
    }
    return { deleted: deleted.length, deleted_ids: deleted, missing };
  }

  /**
   * Delete one or many. Deleting is irreversible and takes the transcript with
   * it, so the confirmation names what is going and how many.
   */
  async function deleteInterviews(ids) {
    if (!ids.length) return;

    const rows = state.history.filter((r) => ids.includes(r.interview_id));
    const named = rows.slice(0, 5).map((r) => properName(r.candidate_name)).join(", ");
    const more = rows.length > 5 ? ` and ${rows.length - 5} more` : "";
    const completed = rows.filter((r) => r.overall_score != null).length;

    const message = ids.length === 1
      ? `Delete this interview and its transcript permanently?\n\n${named}`
      : `Delete ${ids.length} interviews and their transcripts permanently?\n\n`
        + `${named}${more}\n\n`
        + (completed ? `${completed} of them have a completed report. ` : "")
        + "This cannot be undone.";
    if (!confirm(message)) return;

    const btn = $("histDelete");
    btn.disabled = true;
    try {
      if (ids.length === 1) {
        await api(`/api/interviews/${encodeURIComponent(ids[0])}`, { method: "DELETE" });
        state.histSelected.delete(ids[0]);
        toast("Interview deleted", "ok");
      } else {
        let res;
        let stale = false;
        try {
          res = await postJSON("/api/interviews/bulk-delete", { interview_ids: ids });
        } catch (err) {
          // The browser always gets fresh JS (the UI is served no-store) but the
          // Python process only loads its code at startup, so a server that has
          // not been restarted has no bulk route. The path then falls through to
          // /api/interviews/{id}, which rejects POST - hence 405 rather than 404.
          // Delete one at a time instead so the action still works.
          if (!/method not allowed|not found/i.test(err.message)) throw err;
          stale = true;
          res = await deleteOneByOne(ids);
        }
        res.deleted_ids.forEach((id) => state.histSelected.delete(id));
        toast(`Deleted ${res.deleted} interview${res.deleted === 1 ? "" : "s"}`
              + (res.missing.length ? ` · ${res.missing.length} were already gone` : "")
              + (stale ? " · one at a time: restart the server to enable bulk delete" : ""),
              "ok");
      }
      // A deleted interview changes the dashboard stages, and may be the one on
      // the Report tab.
      if (ids.includes(state.interviewId)) {
        state.interviewId = null;
        state.reportData = null;
        $("reportBody").hidden = true;
        $("noReport").hidden = false;
      }
      await loadHistory();
      if (state.historyId) await loadDashboard(state.historyId, true);
    } catch (err) {
      toast(`Delete failed: ${err.message}`, "err");
    } finally {
      btn.disabled = state.histSelected.size === 0;
    }
  }

  init();
})();
