/* The candidate's side of the interview.
 *
 * Reached from the link in the invitation email: /i/<token>. Deliberately a
 * separate controller from app.js rather than a mode of it - this page must never
 * be able to show a score, a grading key, another candidate, or anything from the
 * recruiter console. The only endpoints it touches are the two invite routes and
 * the ordinary interview loop, and it reads the candidate-safe interview view.
 *
 * The avatar rig and all speech handling are shared modules (avatar.js,
 * speech.js); what is duplicated from app.js is the ~80-line turn loop, which is
 * cheaper to read twice than to abstract over two different pages.
 */
(() => {
  "use strict";

  const UI_BUILD = "1 · candidate";
  console.info(`%cCandidate UI ${UI_BUILD}`, "color:#2f5bd7;font-weight:700");

  const $ = (id) => document.getElementById(id);
  const api = (path, opts) => fetch(path, opts).then(async (r) => {
    const isJson = (r.headers.get("content-type") || "").includes("json");
    const body = isJson ? await r.json() : await r.text();
    if (!r.ok) throw new Error((body && body.detail) || r.statusText);
    return body;
  });
  const postJSON = (path) => api(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const words = (t) => (String(t || "").trim().match(/[\w'-]+/g) || []).length;

  // /i/<token>  — trailing slashes and any query string are tolerated.
  const TOKEN = decodeURIComponent(
    (location.pathname.match(/\/i\/([^/?#]+)/) || [])[1] || "");

  const state = {
    info: null, interviewId: null, prompt: null, turns: [], options: {},
    listening: null, answerStart: 0, muted: false, busy: false, finished: false,
  };

  let toastTimer;
  function toast(msg, kind = "") {
    const el = $("cToast");
    el.textContent = msg;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  const PANELS = ["cLoading", "cError", "cWelcome", "cPreparing", "cStage",
                  "cWrapping", "cDone"];
  function show(panel) {
    PANELS.forEach((id) => { $(id).hidden = id !== panel; });
  }

  function chip(text, cls) {
    $("cChip").textContent = text;
    $("cChip").className = `pill ${cls || "pill-muted"}`;
  }

  function stageChip(text, cls) {
    $("cStageChip").textContent = text;
    $("cStageChip").className = `pill ${cls || "pill-muted"}`;
  }

  function badge(text) {
    if (!text) { $("cBadge").hidden = true; return; }
    $("cBadgeText").textContent = text;
    $("cBadge").hidden = false;
  }

  function fail(title, body) {
    $("cErrorTitle").textContent = title;
    $("cErrorBody").textContent = body;
    chip("Cannot start", "pill-bad");
    show("cError");
  }

  /* ----------------------------------------------------------------- startup */
  async function init() {
    window.addEventListener("unhandledrejection", (e) =>
      toast(`Something went wrong: ${e.reason?.message || e.reason}`, "err"));

    if (!TOKEN) {
      return fail("This link is incomplete",
                  "The address is missing its invitation code. Please open the link "
                  + "from your email again, copying the whole of it.");
    }

    let info;
    try {
      info = await api(`/api/invite/${encodeURIComponent(TOKEN)}`);
    } catch (err) {
      const message = String(err.message || "");
      if (/expired/i.test(message)) {
        return fail("This interview link has expired", message);
      }
      return fail("This link cannot be opened",
                  message || "The invitation code was not recognised.");
    }
    state.info = info;

    $("cRole").textContent = info.job_title && info.job_title !== "NA"
      ? `Interview · ${info.job_title}` : "Your interview";
    $("cCompany").textContent = info.company || "";
    $("cInterviewerName").textContent = info.interviewer?.name || "Interviewer";
    $("cInterviewerRole").textContent = info.interviewer?.role || "";

    if (info.state === "completed") {
      chip("Completed", "pill-ok");
      $("cDoneLead").textContent =
        "You have already completed this interview. The team has your responses and "
        + "will be in touch about the next step.";
      return show("cDone");
    }

    // The rig is mounted on the welcome panel too, so the interviewer is already
    // present and breathing before the candidate presses Begin.
    Avatar.mount($("cAvatarWelcome"));

    const name = info.greeting_name && info.greeting_name !== "there"
      ? info.greeting_name : "there";
    $("cGreeting").textContent = `Hello ${name}`;
    $("cLead").textContent =
      `${info.interviewer?.name || "Your interviewer"} will be interviewing you`
      + `${info.job_title && info.job_title !== "NA" ? ` for the ${info.job_title} role` : ""}`
      + `${info.company ? ` at ${info.company}` : ""}.`;

    if (info.state === "resume" || info.state === "preparing") {
      $("cResumeNote").hidden = false;
      $("cResumeNote").textContent = info.answered
        ? `Welcome back — you have answered ${info.answered} question`
          + `${info.answered === 1 ? "" : "s"} so far. We will carry on from there.`
        : "Welcome back — we will pick up where you left off.";
      $("cBegin").textContent = "Continue my interview";
    }

    describeDevice();
    chip("Ready when you are", "pill-ok");
    show("cWelcome");
    $("cBegin").addEventListener("click", begin);
    wireStage();
  }

  function describeDevice() {
    const el = $("cDeviceNote");
    const problems = [];
    if (!Speech.canListen) {
      problems.push("This browser cannot turn speech into text, so you will need to "
                    + "type your answers. Chrome or Edge supports the microphone.");
    }
    if (!Speech.canSpeak) {
      problems.push("This browser has no voice, so the questions will appear on "
                    + "screen without being read aloud.");
    }
    if (problems.length) {
      el.className = "inline-note";
      el.textContent = problems.join(" ");
    } else {
      el.className = "inline-note inline-note-ok";
      el.textContent = "Your browser supports both the voice and the microphone. "
                     + "You will be asked for microphone access when you begin.";
    }
  }

  /* ------------------------------------------------------------------- begin */
  async function begin() {
    $("cBegin").disabled = true;
    show("cPreparing");
    chip("Preparing", "pill-muted");

    let started;
    try {
      started = await postJSON(`/api/invite/${encodeURIComponent(TOKEN)}/start`);
    } catch (err) {
      const message = String(err.message || "");
      if (/already completed/i.test(message)) {
        chip("Completed", "pill-ok");
        $("cDoneLead").textContent = message;
        return show("cDone");
      }
      $("cBegin").disabled = false;
      show("cWelcome");
      return toast(message || "Could not start the interview", "err");
    }
    state.interviewId = started.interview_id;

    // Started from the click that got us here, so the browser grants audio.
    if (Speech.canListen) {
      Speech.startMeter((level) => {
        $("cLevel").style.width = `${Math.round(level * 100)}%`;
        Avatar.pulse(level);
      });
    }

    await waitUntilReady();
  }

  function waitUntilReady() {
    return new Promise((resolve) => {
      const poll = setInterval(async () => {
        let status;
        try {
          status = await api(`/api/interviews/${state.interviewId}/status`);
        } catch (err) {
          clearInterval(poll);
          show("cWelcome");
          $("cBegin").disabled = false;
          toast(`Could not prepare the interview: ${err.message}`, "err");
          return resolve();
        }
        if (status.progress?.stage) $("cPrepStage").textContent = status.progress.stage;
        if (status.progress?.detail) $("cPrepDetail").textContent = status.progress.detail;
        if (status.status !== "planning") {
          clearInterval(poll);
          await openStage();
          resolve();
        }
      }, 1200);
    });
  }

  /* ------------------------------------------------------------------- stage */
  async function openStage() {
    let view;
    try {
      view = await api(`/api/interviews/${state.interviewId}`);
    } catch (err) {
      show("cWelcome");
      $("cBegin").disabled = false;
      return toast(err.message, "err");
    }
    state.turns = view.turns || [];
    state.options = view.options || {};
    if (state.options.voice === false) state.muted = true;

    show("cStage");
    chip("Interview in progress", "pill-live");
    // Re-mount onto the stage container; the welcome copy of the rig is gone now.
    Avatar.mount($("cAvatar"));
    renderLog();

    const last = state.turns[state.turns.length - 1];
    if (last && !(last.answer || "").trim()) {
      // Reload mid-question: re-present it rather than requesting a new one.
      state.prompt = {
        kind: "question", turn: last.turn, question: last.question,
        speech: last.question, category_label: last.category_label,
        question_source: last.question_source, expects_answer: true,
      };
      renderPrompt(state.prompt);
      updateProgress(view.progress || {});
      $("cQHint").textContent = "Picked up where you left off. Use “Repeat the "
                             + "question” to hear it again.";
      openAnswer();
      stageChip("Your turn", "pill-live");
      return;
    }
    await runNext();
  }

  function wireStage() {
    $("cMic").addEventListener("click", toggleMic);
    $("cSubmit").addEventListener("click", () => submit("voice"));
    $("cSkip").addEventListener("click", skip);
    $("cRepeat").addEventListener("click", repeat);
    $("cMute").addEventListener("click", () => {
      state.muted = !state.muted;
      $("cMute").textContent = state.muted ? "🔊 Unmute voice" : "🔈 Mute voice";
      if (state.muted) Speech.cancel();
    });
    $("cAnswer").addEventListener("input", () => {
      const n = words($("cAnswer").value);
      $("cStats").textContent = `${n} word${n === 1 ? "" : "s"}`;
      $("cSubmit").disabled = n < 1;
    });
    window.addEventListener("beforeunload", (e) => {
      if (state.interviewId && !state.finished) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  async function runNext() {
    if (state.busy) return;
    state.busy = true;
    try {
      const prompt = await postJSON(`/api/interviews/${state.interviewId}/next`);
      state.prompt = prompt;
      updateProgress(prompt.progress || {});

      if (prompt.kind === "opening") {
        $("cQTopic").textContent = "Welcome";
        $("cQuestion").textContent = "";
        await say(prompt.speech, prompt.emotion || "friendly");
        state.busy = false;
        return runNext();
      }
      if (prompt.kind === "question") {
        renderPrompt(prompt);
        await say(prompt.speech, prompt.emotion || "neutral");
        openAnswer();
        stageChip("Your turn", "pill-live");
        return;
      }
      // closing or done
      $("cAnswerBox").hidden = true;
      $("cQTopic").textContent = "Closing";
      $("cQuestion").textContent = prompt.speech || "";
      if (prompt.speech) await say(prompt.speech, "friendly");
      await wrapUp();
    } catch (err) {
      toast(`Something went wrong: ${err.message}. Your answers so far are saved — `
            + "reopening your link will resume.", "err");
      stageChip("Paused", "pill-bad");
    } finally {
      state.busy = false;
    }
  }

  function renderPrompt(prompt) {
    $("cQTopic").textContent = prompt.category_label || "Question";
    $("cQTopic").className = "pill pill-brand";
    $("cQFollowup").hidden = prompt.question_source !== "followup";
    $("cQuestion").textContent = prompt.question || "";
    $("cQHint").textContent = prompt.question_source === "followup"
      ? "A follow-up on what you just said." : "";
  }

  function updateProgress(progress) {
    const total = progress.planned_total || 0;
    const asked = progress.planned_asked || 0;
    $("cQCount").textContent = total ? `Question ${Math.min(asked, total)} of about ${total}` : "";
    $("cQFill").style.width = `${progress.percent || 0}%`;
    const answered = progress.answered ?? 0;
    $("cLogCount").textContent = `${answered} answered`;
  }

  /* ------------------------------------------------------------------ speech */
  async function say(text, emotion) {
    if (!text) return;
    Avatar.setEmotion(emotion || "neutral").setState("speaking");
    stageChip("Speaking", "pill-brand");
    badge(null);
    const caption = $("cCaption");
    const tokens = tokenise(text);
    caption.innerHTML = tokens.map((t) => esc(t.text)).join("");

    // The recruiter may have set this candidate's voice and speaking rate; the
    // public interview view carries them so their browser uses them.
    const vo = state.options || {};
    await Speech.speak(text, {
      mute: state.muted,
      rate: vo.voice_rate || 0.98,
      voiceName: vo.voice_name || "",
      onViseme: (name, intensity) => Avatar.setViseme(name, intensity),
      onWord: (charIndex) => {
        const active = tokens.findIndex((t) => t.word && t.end > charIndex);
        caption.innerHTML = tokens.map((t, i) =>
          i === active ? `<b>${esc(t.text)}</b>` : esc(t.text)).join("");
      },
    });

    Avatar.stopSpeaking();
    caption.innerHTML = esc(text);
  }

  function tokenise(text) {
    const tokens = [];
    const re = /\S+|\s+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length,
                    word: /\S/.test(m[0]) });
    }
    return tokens;
  }

  /* ------------------------------------------------------------------ answer */
  function openAnswer() {
    $("cAnswerBox").hidden = false;
    const box = $("cAnswer");
    box.value = "";
    box.disabled = false;
    $("cStats").textContent = "0 words";
    $("cSubmit").disabled = true;
    state.answerStart = performance.now();
    Avatar.setEmotion("encouraging").setState("listening");

    if (Speech.canListen && !state.listening) startMic();
    else if (!Speech.canListen) {
      $("cMic").disabled = true;
      $("cMic").textContent = "🎤 Not available";
      $("cAnswerLabel").textContent = "Your answer (please type it)";
      box.focus();
    }
  }

  function startMic() {
    if (state.listening) return;
    const box = $("cAnswer");
    state.listening = Speech.listen({
      onInterim: (text) => {
        box.value = text;
        const n = words(text);
        $("cStats").textContent = `${n} word${n === 1 ? "" : "s"}`;
        $("cSubmit").disabled = n < 1;
      },
      onError: (msg) => toast(msg, "err"),
    });
    if (!state.listening.supported) { state.listening = null; return; }
    $("cMic").textContent = "⏹ Stop the mic";
    $("cMic").className = "btn btn-rec";
    $("cAnswerLabel").textContent = "Your answer — listening, speak naturally";
    badge("Listening");
    Avatar.setState("noting");
  }

  async function stopMic() {
    if (!state.listening) return "";
    const handle = state.listening;
    state.listening = null;
    $("cMic").textContent = "🎤 Start answering";
    $("cMic").className = "btn btn-primary";
    $("cAnswerLabel").textContent = "Your answer";
    badge(null);
    $("cLevel").style.width = "0%";
    Avatar.setState("listening");
    return handle.stop();
  }

  async function toggleMic() {
    if (state.listening) {
      const text = await stopMic();
      if (text && !$("cAnswer").value.trim()) $("cAnswer").value = text;
      $("cAnswer").focus();
    } else {
      startMic();
    }
  }

  async function submit(mode) {
    if (state.busy) return;
    const seconds = state.answerStart ? (performance.now() - state.answerStart) / 1000 : 0;
    if (state.listening) await stopMic();
    const answer = $("cAnswer").value.trim();
    if (!answer && mode !== "skipped") return toast("Nothing to submit yet", "");

    ["cSubmit", "cMic", "cSkip"].forEach((id) => { $(id).disabled = true; });
    $("cAnswer").disabled = true;
    // The pause while the answer is graded is real work, so it is shown as
    // thought rather than as a spinner.
    Avatar.setEmotion("thinking").setState("thinking");
    stageChip("Considering your answer", "pill-muted");

    state.busy = true;
    try {
      const res = await api(`/api/interviews/${state.interviewId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turn: state.prompt.turn, answer, seconds,
                               mode: mode || "voice" }),
      });

      const record = {
        turn: state.prompt.turn,
        question: state.prompt.question,
        category_label: state.prompt.category_label,
        question_source: state.prompt.question_source,
        answer,
      };
      const local = state.turns.find((t) => t.turn === state.prompt.turn);
      if (local) Object.assign(local, record); else state.turns.push(record);

      renderLog();
      updateProgress(res.progress || {});
      Avatar.setEmotion(res.reaction?.emotion || "neutral");
      Avatar.nod(res.answer_type === "substantive" ? 2 : 1);
    } catch (err) {
      ["cSubmit", "cMic", "cSkip"].forEach((id) => { $(id).disabled = false; });
      $("cAnswer").disabled = false;
      state.busy = false;
      return toast(`Could not save that answer: ${err.message}`, "err");
    }

    ["cMic", "cSkip"].forEach((id) => { $(id).disabled = false; });
    $("cAnswerBox").hidden = true;
    state.busy = false;
    await runNext();
  }

  async function skip() {
    if (!confirm("Skip this question? It will be recorded as unanswered.")) return;
    $("cAnswer").value = "";
    await submit("skipped");
  }

  async function repeat() {
    if (!state.prompt?.question) return;
    const wasListening = Boolean(state.listening);
    if (wasListening) await stopMic();
    await say(state.prompt.question, "friendly");
    if (!$("cAnswerBox").hidden) {
      Avatar.setState("listening");
      stageChip("Your turn", "pill-live");
      if (wasListening) startMic();
    }
  }

  function renderLog() {
    const rows = state.turns.filter((t) => t.question);
    const log = $("cLog");
    if (!rows.length) { log.innerHTML = `<p class="sub">Nothing yet.</p>`; return; }
    log.innerHTML = rows.map((t) => `
      <div class="turn ${t.question_source === "followup" ? "followup" : ""}">
        <div class="turn-q">
          <span class="pill pill-muted">${esc(t.category_label || "")}</span>
          ${t.question_source === "followup" ? `<span class="pill pill-warn">follow-up</span>` : ""}
        </div>
        <p class="turn-question">${esc(t.question)}</p>
        <p class="turn-answer ${(t.answer || "").trim() ? "" : "empty"}">${
          esc((t.answer || "").trim() || "Skipped.")}</p>
      </div>`).reverse().join("");
  }

  /* ---------------------------------------------------------------- wrap up */
  async function wrapUp() {
    state.finished = true;
    Speech.cancel();
    Speech.stopMeter();
    if (state.listening) await stopMic();
    show("cWrapping");
    chip("Finishing", "pill-muted");

    // The evaluation is produced for the recruiter. The candidate is never shown
    // it, and never sees a score - they only need to know it saved.
    try {
      await postJSON(`/api/interviews/${state.interviewId}/finish`);
    } catch (err) {
      console.warn("finish failed:", err.message);
      // Their answers are already stored turn by turn, so this is not their
      // problem to solve - the recruiter can re-run the review.
    }

    const who = state.info?.interviewer?.name || "your interviewer";
    $("cDoneLead").textContent =
      `Thank you for talking with ${who} today. Your interview has been saved and `
      + "the team will review it and be in touch about the next step.";
    chip("Completed", "pill-ok");
    show("cDone");
  }

  init();
})();
