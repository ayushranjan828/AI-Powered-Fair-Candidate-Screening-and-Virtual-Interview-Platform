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
  const UI_BUILD = "1 · interviewer";
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
    source: "screening",
    shortlist: null,          // the loaded shortlist record
    candidate: null,          // the picked candidate row
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
    describeSpeechSupport();
    loadVoices();
    await loadShortlists();

    $("refreshHistory").addEventListener("click", loadHistory);

    // Mounting the rig here (not on first use) means the interviewer is already
    // breathing and blinking when the candidate first sees the stage.
    if (window.Avatar) Avatar.mount($("avatarStage"));

    // ?interview=INT-... reopens one directly, so a reviewer can bookmark or
    // share a link to a specific interview instead of hunting through History.
    const wanted = new URLSearchParams(location.search).get("interview");
    if (wanted) {
      try {
        const view = await api(`/api/interviews/${encodeURIComponent(wanted)}`);
        if (view.has_report) await openReport(wanted);
        else await openStage(wanted);
      } catch (err) {
        toast(`Could not open ${wanted}: ${err.message}`, "err");
      }
    }

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
    const select = $("voiceSelect");
    const fill = () => {
      const list = Speech.voices().filter((v) => (v.lang || "").toLowerCase().startsWith("en"));
      if (!list.length) return;
      const preferred = Speech.pickVoice();
      select.innerHTML = `<option value="">Recommended (${esc(preferred?.name || "system")})</option>` +
        list.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} · ${esc(v.lang)}</option>`).join("");
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
      chip.addEventListener("click", () => chip.classList.toggle("active"));
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
  function wireSetup() {
    $("sourceToggle").querySelectorAll("[data-source]").forEach((chip) =>
      chip.addEventListener("click", () => {
        state.source = chip.dataset.source;
        $("sourceToggle").querySelectorAll("[data-source]").forEach((c) =>
          c.classList.toggle("active", c === chip));
        $("screeningPane").hidden = state.source !== "screening";
        $("manualPane").hidden = state.source !== "manual";
      }));

    $("shortlistSelect").addEventListener("change", (e) => loadShortlist(e.target.value));

    const bindRange = (id, out, format) => {
      const input = $(id);
      const render = () => { $(out).textContent = format(input.value); };
      input.addEventListener("input", render);
      render();
    };
    bindRange("plannedCount", "plannedOut", (v) => v);
    bindRange("maxFollowups", "followupsOut", (v) => v);
    bindRange("voiceRate", "rateOut", (v) => `${Number(v).toFixed(2)}×`);

    $("resetSettings").addEventListener("click", () => {
      $("plannedCount").value = state.cfg.default_planned_count ?? 10;
      $("maxFollowups").value = state.cfg.default_max_followups ?? 2;
      $("voiceRate").value = 0.98;
      $("plannedOut").textContent = $("plannedCount").value;
      $("followupsOut").textContent = $("maxFollowups").value;
      $("rateOut").textContent = "0.98×";
      $("voiceOn").checked = true;
      renderCategories();
      renderWeights();
    });

    $("plannedCount").value = state.cfg.default_planned_count ?? 10;
    $("maxFollowups").value = state.cfg.default_max_followups ?? 2;
    $("plannedOut").textContent = $("plannedCount").value;
    $("followupsOut").textContent = $("maxFollowups").value;

    $("startBtn").addEventListener("click", prepareInterview);
  }

  async function loadShortlists() {
    const select = $("shortlistSelect");
    try {
      const data = await api("/api/shortlists");
      const rows = data.shortlists || [];
      if (!rows.length) {
        select.innerHTML = `<option value="">No shortlists found</option>`;
        const note = $("shortlistEmpty");
        note.hidden = false;
        note.textContent =
          "No accepted shortlist was found from the screening app. Accept one there " +
          "first, or switch to “Enter manually”. Looked in: " +
          (data.searched || []).join("  ·  ");
        return;
      }
      select.innerHTML = `<option value="">Choose a shortlist…</option>` +
        rows.map((r) => `<option value="${esc(r.history_id)}">
          ${esc(r.job_title)} — ${r.interviewable} to interview · accepted ${when(r.accepted_at)}
        </option>`).join("");
      if (rows.length === 1) {
        select.value = rows[0].history_id;
        await loadShortlist(rows[0].history_id);
      }
    } catch (err) {
      select.innerHTML = `<option value="">Could not load shortlists</option>`;
      toast(`Shortlists: ${err.message}`, "err");
    }
  }

  async function loadShortlist(historyId) {
    state.shortlist = null;
    state.candidate = null;
    $("candidateBody").innerHTML = "";
    if (!historyId) return;
    try {
      const data = await api(`/api/shortlists/${encodeURIComponent(historyId)}`);
      state.shortlist = data;
      $("jobTitle").value = data.job_title && data.job_title !== "NA" ? data.job_title : "";
      $("jdText").value = data.jd_text || "";
      const rubric = data.jd_analysis || {};
      const note = $("rubricState");
      if (rubric.must_have_skills?.length) {
        note.className = "inline-note inline-note-ok";
        note.textContent = `Rubric loaded from the screening run — ${rubric.must_have_skills.length} ` +
          `must-have skills, ${(rubric.key_responsibilities || []).length} responsibilities. ` +
          `The interviewer will use it directly.`;
      } else {
        note.className = "inline-note inline-note-quiet";
        note.textContent = "No rubric on this record — the interviewer will read the JD itself.";
      }
      renderCandidates(data.candidates || []);
    } catch (err) {
      toast(`Shortlist: ${err.message}`, "err");
    }
  }

  function renderCandidates(rows) {
    const body = $("candidateBody");
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6" class="sub" style="padding:16px">
        Nobody on this shortlist is marked shortlisted or under review.</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((c) => `
      <tr data-cid="${esc(c.candidate_id)}">
        <td><input type="radio" name="cand" value="${esc(c.candidate_id)}" /></td>
        <td><strong>${esc(properName(c.candidate_name))}</strong><br /><span class="sub">${esc(c.email_id)}</span></td>
        <td>${esc(c.current_role)}</td>
        <td>${esc(c.experience)}</td>
        <td><span class="score ${band(c.ats_score)}">${c.ats_score ?? "—"}%</span></td>
        <td><span class="pill ${c.status === "SHORTLISTED" ? "pill-ok" : "pill-warn"}">${esc(c.status)}</span></td>
      </tr>`).join("");

    body.querySelectorAll("tr[data-cid]").forEach((tr) => {
      tr.addEventListener("click", () => {
        const radio = tr.querySelector("input[type=radio]");
        radio.checked = true;
        body.querySelectorAll("tr").forEach((r) => r.classList.toggle("picked", r === tr));
        state.candidate = rows.find((c) => c.candidate_id === tr.dataset.cid) || null;
      });
    });
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

  async function prepareInterview() {
    const jd = $("jdText").value.trim();
    if (!jd) return toast("Paste the job description first", "err");

    const payload = {
      job_title: $("jobTitle").value.trim(),
      jd_text: jd,
      options: {
        planned_count: Number($("plannedCount").value),
        max_followups: Number($("maxFollowups").value),
        categories: selectedCategories(),
        voice: $("voiceOn").checked,
        weights: collectWeights(),
      },
    };

    if (state.source === "screening") {
      if (!state.shortlist || !state.candidate) {
        return toast("Pick a candidate from the shortlist", "err");
      }
      payload.source = "screening";
      payload.history_id = state.shortlist.history_id;
      payload.candidate_id = state.candidate.candidate_id;
      payload.jd_analysis = state.shortlist.jd_analysis || {};
    } else {
      const candidate = manualCandidate();
      if (!candidate.candidate_name) return toast("The candidate needs a name", "err");
      if (!candidate.resume_text && !candidate.skills && !candidate.projects) {
        return toast("Add the resume text, or at least skills and projects", "err");
      }
      payload.source = "manual";
      payload.candidate = candidate;
    }

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
      await waitForPlan();
    } catch (err) {
      toast(`Could not prepare the interview: ${err.message}`, "err");
      $("planProgress").hidden = true;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /** Poll until the question plan exists, then open the stage. */
  function waitForPlan() {
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
            await openStage(state.interviewId);
            resolve();
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

    await Speech.speak(text, {
      rate: Number($("voiceRate").value) || 0.98,
      voiceName: $("voiceSelect").value || "",
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
    $("repScore").textContent = score == null ? "—" : `${Math.round(score)}%`;

    const verdict = $("repVerdict");
    verdict.textContent = titleise(rep.verdict || "not assessed");
    verdict.className = "pill pill-lg " + (
      rep.verdict === "STRONG_HIRE" ? "pill-ok" :
      rep.verdict === "HIRE" ? "pill-ok" :
      rep.verdict === "BORDERLINE" ? "pill-warn" : "pill-bad");

    $("repConfidence").textContent = `${rep.confidence || "?"} confidence`;
    $("repSummary").textContent = rep.summary || "No written summary was produced.";

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
      [`${score == null ? "—" : Math.round(score)}%`, "Interview score",
       "how they performed today"],
      [ats == null ? "—" : `${Math.round(ats)}%`, "Resume ATS score",
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
    } catch (err) {
      toast(err.message, "err");
    }
  }

  /* ============================================================= HISTORY */
  async function loadHistory() {
    try {
      const rows = await api("/api/interviews");
      $("historyList").innerHTML = rows.length ? rows.map((r) => `
        <div class="hrow">
          <div>
            <div class="ht">${esc(properName(r.candidate_name))}
              <span class="sub">· ${esc(r.job_title)}</span>
              ${r.verdict ? `<span class="pill ${
                r.verdict === "STRONG_HIRE" || r.verdict === "HIRE" ? "pill-ok"
                : r.verdict === "BORDERLINE" ? "pill-warn" : "pill-bad"
              }">${esc(titleise(r.verdict))}${r.overall_score != null ? ` · ${Math.round(r.overall_score)}%` : ""}</span>`
                : `<span class="pill pill-muted">${esc(r.status)}</span>`}
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
        </div>`).join("") : `<p class="sub">No interviews yet.</p>`;

      const list = $("historyList");
      list.querySelectorAll("[data-rep]").forEach((b) =>
        b.addEventListener("click", () => openReport(b.dataset.rep)));
      list.querySelectorAll("[data-resume]").forEach((b) =>
        b.addEventListener("click", () => openStage(b.dataset.resume)));
      list.querySelectorAll("[data-xl]").forEach((b) =>
        b.addEventListener("click", () => {
          window.location.href = `/api/interviews/${b.dataset.xl}/export`;
        }));
      list.querySelectorAll("[data-del]").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm("Delete this interview and its transcript permanently?")) return;
          await api(`/api/interviews/${b.dataset.del}`, { method: "DELETE" });
          toast("Interview deleted");
          loadHistory();
        }));
    } catch (err) {
      toast(`History load failed: ${err.message}`, "err");
    }
  }

  init();
})();
