/* AI-Powered Fair Candidate Screening — front-end controller */
(() => {
  "use strict";

  // Bump alongside the ?v= query in index.html. Logged so a stale cached copy
  // is obvious in the console instead of showing up as a dead button.
  const UI_BUILD = "4 · screening + invite + interview links";
  console.info(`%cUI build ${UI_BUILD}`, "color:#2f5bd7;font-weight:700");

  const $ = (id) => document.getElementById(id);
  const api = (path, opts) => fetch(path, opts).then(async (r) => {
    const isJson = (r.headers.get("content-type") || "").includes("json");
    const body = isJson ? await r.json() : await r.text();
    if (!r.ok) throw new Error((body && body.detail) || r.statusText);
    return body;
  });

  const CRITERIA_INFO = {
    education: "Highest qualification vs the education the JD asks for.",
    skills: "Must-have skills and genuine equivalents found in the resume.",
    experience: "Relevant years and depth against the JD responsibilities.",
    projects: "Relevance, complexity and ownership of the projects shown.",
    certifications: "Relevant certifications explicitly named in the resume.",
  };
  const EDITABLE = ["candidate_name", "phone_number", "email_id", "skills",
                    "certification", "experience", "highest_education"];
  const STATUSES = ["SHORTLISTED", "REVIEW", "NOT_SHORTLISTED", "PARSE_FAILED"];

  const state = {
    cfg: null, files: [], session: null, readOnly: false, dirty: false,
    filter: "ALL", query: "", page: 1, pageSize: 50, poll: null,
    outreach: null, outFilter: "ALL",
  };

  /* ------------------------------------------------------------- helpers */
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const bytes = (n) => n < 1024 ? `${n} B`
    : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const when = (iso) => iso ? new Date(iso).toLocaleString() : "—";

  let toastTimer;
  function toast(msg, kind = "") {
    const el = $("toast");
    el.textContent = msg; el.className = `toast ${kind}`; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
  }

  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
    if (name === "history") { loadHistory(); loadSessions(); }
    if (name === "outreach") loadOutreach();
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
      state.cfg = { default_threshold: 60, criteria: Object.keys(CRITERIA_INFO),
                    default_weights: {}, default_cutoffs: {}, ai_configured: false };
    }
    const pill = $("aiStatus");
    pill.style.cursor = "pointer";
    pill.title = "Click to test the Azure OpenAI connection";
    pill.addEventListener("click", checkAI);
    if (state.cfg.ai_configured) {
      pill.textContent = `AI configured · ${state.cfg.deployment}`; pill.className = "pill pill-ok";
    } else {
      pill.textContent = "AI not configured — check .env"; pill.className = "pill pill-bad";
    }

    renderCriteria();
    $("threshold").value = state.cfg.default_threshold ?? 60;
    $("thresholdOut").textContent = `${$("threshold").value}%`;
    $("threshold").addEventListener("input", (e) => {
      $("thresholdOut").textContent = `${e.target.value}%`;
    });
    $("resetCriteria").addEventListener("click", () => {
      renderCriteria();
      $("threshold").value = state.cfg.default_threshold ?? 60;
      $("thresholdOut").textContent = `${$("threshold").value}%`;
    });

    wireUploads();
    wireResults();
    wireOutreach();

    $("startBtn").addEventListener("click", startScreening);
    $("refreshHistory").addEventListener("click", loadHistory);
    $("refreshSessions").addEventListener("click", loadSessions);
    $("closeDrawer").addEventListener("click", () => { $("drawer").hidden = true; });

    // ?session=SES-...&tab=outreach opens a session straight on a given tab, so a
    // recruiter can bookmark or share "the invitations for this shortlist".
    const params = new URLSearchParams(location.search);
    const wanted = params.get("session");
    if (wanted) {
      try {
        await openSession(wanted);
        showTab(params.get("tab") || "results");
      } catch (err) {
        toast(`Could not open ${wanted}: ${err.message}`, "err");
      }
    }

    window.addEventListener("beforeunload", (e) => {
      if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
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

  /* ------------------------------------------------------------ criteria */
  function renderCriteria() {
    const body = $("criteriaBody");
    body.innerHTML = (state.cfg.criteria || Object.keys(CRITERIA_INFO)).map((key) => `
      <tr>
        <td><strong>${esc(key[0].toUpperCase() + key.slice(1))}</strong></td>
        <td><input type="number" min="0" max="100" step="1" data-weight="${key}"
             value="${state.cfg.default_weights?.[key] ?? 20}" /></td>
        <td><input type="number" min="0" max="100" step="1" data-cutoff="${key}"
             value="${state.cfg.default_cutoffs?.[key] ?? 0}" /></td>
        <td class="why">${esc(CRITERIA_INFO[key] || "")}</td>
      </tr>`).join("");
    body.querySelectorAll("[data-weight]").forEach((i) => i.addEventListener("input", sumWeights));
    sumWeights();
  }

  function collect(attr) {
    const out = {};
    document.querySelectorAll(`[data-${attr}]`).forEach((i) => {
      out[i.dataset[attr]] = Number(i.value) || 0;
    });
    return out;
  }

  function sumWeights() {
    const total = Object.values(collect("weight")).reduce((a, b) => a + b, 0);
    const el = $("weightTotal");
    el.textContent = total;
    el.style.color = total === 100 ? "var(--ok)" : "var(--warn)";
    $("startHint").textContent = total === 100 ? ""
      : `Weights total ${total}% — they will be normalised to 100%.`;
  }

  /* -------------------------------------------------------------- upload */
  function wireUploads() {
    $("pickFiles").addEventListener("click", () => $("fileInput").click());
    $("pickFolder").addEventListener("click", () => $("folderInput").click());
    $("pickZip").addEventListener("click", () => $("zipInput").click());
    ["fileInput", "folderInput", "zipInput"].forEach((id) =>
      $(id).addEventListener("change", (e) => {
        addFiles([...e.target.files]);
        e.target.value = "";
      }));
    $("clearFiles").addEventListener("click", () => { state.files = []; renderFiles(); });

    const dz = $("dropZone");
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.add("drag");
    }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.remove("drag");
    }));
    dz.addEventListener("drop", async (e) => {
      const items = [...(e.dataTransfer.items || [])];
      const entries = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
      if (entries.length) {
        const collected = [];
        for (const entry of entries) await walkEntry(entry, "", collected);
        addFiles(collected);
      } else {
        addFiles([...e.dataTransfer.files]);
      }
    });
  }

  function walkEntry(entry, prefix, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => { f._rel = prefix + entry.name; out.push(f); resolve(); }, resolve);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => reader.readEntries(async (batch) => {
          if (!batch.length) return resolve();
          for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
          readBatch();
        }, resolve);
        readBatch();
      } else resolve();
    });
  }

  const ALLOWED = /\.(pdf|docx?|docm|rtf|txt|zip)$/i;

  function addFiles(list) {
    let skipped = 0;
    for (const f of list) {
      const rel = f._rel || f.webkitRelativePath || f.name;
      if (!ALLOWED.test(rel)) { skipped++; continue; }
      if (state.files.some((x) => x.rel === rel && x.file.size === f.size)) continue;
      state.files.push({ file: f, rel });
    }
    renderFiles();
    if (skipped) toast(`${skipped} unsupported file(s) skipped`, "err");
  }

  function renderFiles() {
    $("fileCount").textContent = `${state.files.length} file${state.files.length === 1 ? "" : "s"} queued`;
    $("fileList").innerHTML = state.files.slice(0, 400).map((f, i) => `
      <li><span title="${esc(f.rel)}">${esc(f.rel)}</span>
      <span class="fsize">${bytes(f.file.size)} <button class="btn btn-link" data-rm="${i}">✕</button></span></li>`).join("")
      + (state.files.length > 400 ? `<li><em>…and ${state.files.length - 400} more</em></li>` : "");
    $("fileList").querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => { state.files.splice(Number(b.dataset.rm), 1); renderFiles(); }));
  }

  /* ----------------------------------------------------------- screening */
  async function startScreening() {
    const jd = $("jdText").value.trim();
    if (!jd) return toast("Paste the Job Description first", "err");
    if (!state.files.length) return toast("Add at least one resume, folder or ZIP", "err");

    const fd = new FormData();
    state.files.forEach((f) => fd.append("files", f.file, f.rel.split("/").pop()));
    fd.append("paths", JSON.stringify(state.files.map((f) => f.rel)));
    fd.append("jd_text", jd);
    fd.append("job_title", $("jobTitle").value.trim());
    fd.append("threshold", $("threshold").value);
    fd.append("weights", JSON.stringify(collect("weight")));
    fd.append("cutoffs", JSON.stringify(collect("cutoff")));

    $("startBtn").disabled = true;
    $("progressWrap").hidden = false;
    setProgress({ stage: "Uploading resumes…", processed: 0, total: state.files.length }, 4);

    try {
      const res = await api("/api/screen", { method: "POST", body: fd });
      setProgress({ stage: "Analysing job description", processed: 0, total: res.total_resumes }, 8);
      pollProgress(res.session_id);
    } catch (err) {
      $("startBtn").disabled = false;
      $("progressWrap").hidden = true;
      toast(`Screening failed: ${err.message}`, "err");
    }
  }

  function setProgress(p, forcePct) {
    $("progressStage").textContent = p.stage || "Working…";
    $("progressCount").textContent = `${p.processed || 0} / ${p.total || 0}`;
    const pct = forcePct ?? (p.total ? Math.round((p.processed / p.total) * 100) : 0);
    $("progressFill").style.width = `${Math.max(pct, 3)}%`;
    $("progressNote").textContent = p.errors
      ? `${p.errors} resume(s) need manual review — unreadable file or AI fallback.`
      : "";
  }

  function pollProgress(sessionId) {
    clearInterval(state.poll);
    state.poll = setInterval(async () => {
      try {
        const p = await api(`/api/sessions/${sessionId}/progress`);
        setProgress(p.progress || {});
        if (p.status === "completed" || p.status === "accepted") {
          clearInterval(state.poll);
          $("startBtn").disabled = false;
          setProgress({ ...(p.progress || {}), stage: "Completed" }, 100);
          await openSession(sessionId);
          toast(`Done — ${p.stats?.shortlisted ?? 0} shortlisted of ${p.stats?.total ?? 0}`, "ok");
          showTab("results");
        }
      } catch (err) {
        clearInterval(state.poll);
        $("startBtn").disabled = false;
        toast(`Lost track of the run: ${err.message}`, "err");
      }
    }, 1800);
  }

  /* ------------------------------------------------------------- results */
  function wireResults() {
    $("searchBox").addEventListener("input", (e) => {
      state.query = e.target.value.toLowerCase().trim(); state.page = 1; renderGrid();
    });
    $("pageSize").addEventListener("change", (e) => {
      state.pageSize = Number(e.target.value); state.page = 1; renderGrid();
    });
    $("prevPage").addEventListener("click", () => { state.page--; renderGrid(); });
    $("nextPage").addEventListener("click", () => { state.page++; renderGrid(); });
    $("addRowBtn").addEventListener("click", addRow);
    $("saveBtn").addEventListener("click", saveEdits);
    $("downloadBtn").addEventListener("click", downloadExcel);
    $("acceptBtn").addEventListener("click", () => {
      if (!state.session) return toast("Open or run a screening session first", "err");
      if (state.readOnly) return toast("This shortlist is already accepted", "err");
      $("modal").hidden = false;
    });
    $("cancelAccept").addEventListener("click", () => { $("modal").hidden = true; });
    $("confirmAccept").addEventListener("click", acceptShortlist);
    $("inviteBtn").addEventListener("click", () => {
      if (!state.session) return toast("Open or run a screening session first", "err");
      showTab("outreach");
    });
  }

  async function openSession(sessionId) {
    const s = await api(`/api/sessions/${sessionId}`);
    state.session = s;
    state.readOnly = Boolean(s.accepted_history_id);
    state.dirty = false; state.page = 1;
    renderResults();
  }

  async function openHistory(historyId) {
    const h = await api(`/api/history/${historyId}`);
    state.session = { ...h, session_id: h.session_id, is_history: true, history_id: h.history_id };
    state.readOnly = true; state.dirty = false; state.page = 1;
    renderResults();
    showTab("results");
  }

  function renderResults() {
    const s = state.session;
    if (!s) return;
    $("noResults").hidden = true;
    $("resultsBody").hidden = false;
    $("resJobTitle").textContent = s.job_title || "Shortlist";
    $("resMeta").textContent = s.is_history
      ? `History ${s.history_id} · accepted ${when(s.accepted_at)} by ${s.accepted_by} · threshold ${s.threshold}%`
      : `Session ${s.session_id} · ${when(s.created_at)} · threshold ${s.threshold}% · ${s.status}`;
    $("lockBadge").hidden = !state.readOnly;

    const st = s.stats || {};
    $("statsRow").innerHTML = [
      ["Resumes", st.total ?? 0, ""],
      ["Shortlisted", st.shortlisted ?? 0, "ok"],
      ["Needs review", st.review ?? 0, "warn"],
      ["Below threshold", st.not_shortlisted ?? 0, ""],
      ["Unreadable", st.failed ?? 0, "bad"],
    ].map(([l, n, k]) => `<div class="stat ${k}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");

    const r = s.jd_analysis || {};
    $("rubricBody").innerHTML = [
      ["Role", r.role_title], ["Seniority", r.seniority],
      ["Min experience", r.min_experience_years != null ? `${r.min_experience_years} yrs` : "NA"],
      ["Education", r.required_education],
      ["Must-have skills", (r.must_have_skills || []).join(", ")],
      ["Good to have", (r.good_to_have_skills || []).join(", ")],
      ["Project types", (r.expected_project_types || []).join(", ")],
      ["Certifications", (r.preferred_certifications || []).join(", ")],
    ].map(([k, v]) => `<div><span class="rk">${esc(k)}</span>${esc(v || "NA")}</div>`).join("")
      + (s.jd_error ? `<div style="color:var(--bad)"><span class="rk">JD analysis warning</span>${esc(s.jd_error)}</div>` : "");

    const counts = { ALL: (s.candidates || []).length };
    STATUSES.forEach((k) => { counts[k] = (s.candidates || []).filter((c) => c.status === k).length; });
    $("statusFilters").innerHTML = ["ALL", ...STATUSES].map((k) =>
      `<button class="chip ${state.filter === k ? "active" : ""}" data-f="${k}">
        ${esc(k === "ALL" ? "All" : k.replace(/_/g, " ").toLowerCase())} (${counts[k] || 0})</button>`).join("");
    $("statusFilters").querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => {
      state.filter = b.dataset.f; state.page = 1; renderResults();
    }));

    ["addRowBtn", "saveBtn", "acceptBtn"].forEach((id) => { $(id).disabled = state.readOnly; });
    renderGrid();
  }

  function visibleRows() {
    const all = state.session?.candidates || [];
    return all.filter((c) => {
      if (state.filter !== "ALL" && c.status !== state.filter) return false;
      if (!state.query) return true;
      return ["candidate_name", "email_id", "phone_number", "skills", "certification",
              "highest_education", "candidate_id", "source_file"]
        .some((k) => String(c[k] ?? "").toLowerCase().includes(state.query));
    });
  }

  function renderGrid() {
    const rows = visibleRows();
    const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    state.page = Math.min(Math.max(1, state.page), pages);
    const start = (state.page - 1) * state.pageSize;
    const slice = rows.slice(start, start + state.pageSize);

    $("pageInfo").textContent = rows.length
      ? `${start + 1}–${start + slice.length} of ${rows.length}` : "no rows";
    $("prevPage").disabled = state.page <= 1;
    $("nextPage").disabled = state.page >= pages;
    $("dirtyNote").hidden = !state.dirty;

    const ro = state.readOnly;
    $("gridBody").innerHTML = slice.map((c) => {
      const cls = c.ats_score >= 75 ? "hi" : c.ats_score >= (state.session.threshold ?? 60) ? "mid" : "lo";
      const cell = (key) => ro
        ? `<td class="ro" style="font-weight:400;white-space:normal">${esc(c[key])}</td>`
        : `<td><input value="${esc(c[key])}" data-cid="${esc(c.candidate_id)}" data-k="${key}" /></td>`;
      return `<tr class="${c.manually_added ? "added" : ""}">
        <td class="ro">${esc(c.candidate_id)}</td>
        ${EDITABLE.slice(0, 6).map(cell).join("")}
        ${cell("highest_education")}
        <td><span class="score ${cls}" data-info="${esc(c.candidate_id)}">${c.ats_score ?? 0}</span></td>
        <td>${ro ? `<span class="ro">${esc(c.status)}</span>` :
          `<select data-cid="${esc(c.candidate_id)}" data-k="status">
            ${STATUSES.map((s) => `<option ${c.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>`}</td>
        <td>
          <button class="row-info" data-info="${esc(c.candidate_id)}" title="Details">ⓘ</button>
          ${ro ? "" : `<button class="row-del" data-del="${esc(c.candidate_id)}" title="Delete row">🗑</button>`}
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="11" style="padding:26px;text-align:center;color:var(--muted)">No rows match this filter.</td></tr>`;

    $("gridBody").querySelectorAll("input[data-cid],select[data-cid]").forEach((el) =>
      el.addEventListener("change", () => {
        const row = state.session.candidates.find((c) => c.candidate_id === el.dataset.cid);
        if (!row) return;
        row[el.dataset.k] = el.value.trim() === "" ? "NA" : el.value;
        row.edited = true;
        state.dirty = true;
        $("dirtyNote").hidden = false;
      }));
    $("gridBody").querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", () => deleteRow(b.dataset.del)));
    $("gridBody").querySelectorAll("[data-info]").forEach((b) =>
      b.addEventListener("click", () => showDetail(b.dataset.info)));
  }

  function deleteRow(cid) {
    const row = state.session.candidates.find((c) => c.candidate_id === cid);
    if (!confirm(`Delete ${row?.candidate_name || cid} from the sheet?`)) return;
    state.session.candidates = state.session.candidates.filter((c) => c.candidate_id !== cid);
    state.dirty = true;
    renderResults();
  }

  async function addRow() {
    const blank = await api(`/api/sessions/${state.session.session_id}/blank-row`, { method: "POST" });
    state.session.candidates.unshift(blank);
    state.dirty = true; state.filter = "ALL"; state.page = 1;
    renderResults();
    toast("Blank row added — fill it in, then Save edits");
  }

  async function saveEdits() {
    try {
      const res = await api(`/api/sessions/${state.session.session_id}/candidates`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidates: state.session.candidates }),
      });
      state.session.stats = res.stats;
      state.dirty = false;
      renderResults();
      toast(`Saved ${res.count} rows`, "ok");
    } catch (err) { toast(`Save failed: ${err.message}`, "err"); }
  }

  async function acceptShortlist() {
    if (!state.session) { $("modal").hidden = true; return toast("No session to accept", "err"); }
    try {
      if (state.dirty) await saveEdits();
      const res = await api(`/api/sessions/${state.session.session_id}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accepted_by: $("acceptedBy").value.trim(),
          notes: $("acceptNotes").value.trim(),
          only_shortlisted: $("onlyShortlisted").checked,
        }),
      });
      $("modal").hidden = true;
      toast(`Saved to history (${res.count} candidates)`, "ok");
      await openHistory(res.history_id);
      loadHistory();
    } catch (err) { toast(`Accept failed: ${err.message}`, "err"); }
  }

  function downloadExcel() {
    const s = state.session;
    if (!s) return;
    const url = s.is_history
      ? `/api/history/${s.history_id}/export`
      : `/api/sessions/${s.session_id}/export?only_shortlisted=${state.filter === "SHORTLISTED"}`;
    window.location.href = url;
  }

  /* -------------------------------------------------------------- drawer */
  function showDetail(cid) {
    const c = (state.session.candidates || []).find((x) => x.candidate_id === cid);
    if (!c) return;
    const bar = (label, val) => `<div><strong>${esc(label)}</strong> — ${val}%
      <div class="bar"><i style="width:${Math.max(0, Math.min(100, val))}%"></i></div></div>`;
    $("drawerTitle").textContent = c.candidate_name || cid;
    $("drawerBody").innerHTML = `
      <p class="sub">${esc(c.candidate_id)} · ${esc(c.source_file || "manual entry")}</p>
      <h4>Decision</h4>
      <p><strong>${esc(c.status)}</strong> · ATS ${c.ats_score}% · AI verdict ${esc(c.recommendation)}</p>
      <p class="sub">${esc(c.decision_reason)}</p>
      <h4>Criterion scores</h4>
      ${bar("Education", c.score_education)}${bar("Skills", c.score_skills)}
      ${bar("Experience", c.score_experience)}${bar("Projects", c.score_projects)}
      ${bar("Certifications", c.score_certifications)}
      <h4>AI justification</h4><p>${esc(c.justification)}</p>
      <h4>Matched skills</h4><p>${esc(c.matched_skills)}</p>
      <h4>Missing skills</h4><p>${esc(c.missing_skills)}</p>
      <h4>Transferable strengths</h4><p>${esc(c.transferable_strengths)}</p>
      <h4>Projects</h4><p>${esc(c.projects)}</p>
      <h4>Education detail</h4><p>${esc(c.education_details)}</p>
      <h4>Current role / location</h4><p>${esc(c.current_role)} · ${esc(c.location)}</p>
      <h4>Flags</h4><p>${esc(c.red_flags)}</p>
      ${c.extraction_error ? `<h4>Processing note</h4><p style="color:var(--bad)">${esc(c.extraction_error)}</p>` : ""}`;
    $("drawer").hidden = false;
  }

  /* ------------------------------------------------------------ outreach */
  function wireOutreach() {
    $("redraftBtn").addEventListener("click", () => {
      if (!confirm("Re-drafting rewrites every unsent invitation, discarding your edits. Continue?")) return;
      draftMails(true);
    });
    $("sendAllBtn").addEventListener("click", sendAll);
  }

  async function loadOutreach(autoDraft = true) {
    if (!state.session || state.session.is_history) {
      await renderOutreachPicker();
      return;
    }
    try {
      state.outreach = await api(`/api/sessions/${state.session.session_id}/outreach`);
      $("noOutreach").hidden = true;
      $("outreachBody").hidden = false;

      // Landing on this tab should already have the mails written. Draft on
      // arrival rather than making the recruiter ask for it. autoDraft is false
      // on the reload that draftMails() itself triggers, so this cannot loop.
      const nothingDrafted = !(state.outreach.drafts || []).length;
      if (autoDraft && nothingDrafted && (state.outreach.eligible || []).length) {
        renderOutreach();
        await draftMails(false, true);
        return;
      }
      renderOutreach();
    } catch (err) { toast(`Could not load invitations: ${err.message}`, "err"); }
  }

  /* The Invite tab needs a screening session in memory, which a page reload
     clears. Rather than dead-ending, offer the sessions that can be invited from. */
  async function renderOutreachPicker() {
    $("noOutreach").hidden = false;
    $("outreachBody").hidden = true;
    const el = $("noOutreach");

    let rows = [];
    try {
      rows = (await api("/api/sessions")).filter((s) => s.shortlisted > 0);
    } catch { /* fall through to the plain message below */ }

    const fromHistory = state.session?.is_history
      ? `<p class="sim-inline">You have a <strong>history record</strong> open. Invitations are
         sent from the live screening session it came from — pick it below.</p>` : "";

    el.innerHTML = rows.length ? `
      <h2>Pick a screening to invite from</h2>
      <p class="sub">These completed screenings have shortlisted candidates.</p>
      ${fromHistory}
      <div class="history-list" style="text-align:left;max-width:760px;margin:18px auto 0">
        ${rows.map((s) => `
          <div class="hrow">
            <div>
              <div class="ht">${esc(s.job_title)}
                ${s.accepted ? '<span class="pill pill-locked">accepted</span>' : ""}</div>
              <div class="hm">${esc(s.session_id)} · ${when(s.created_at)}
                · <strong>${s.shortlisted}</strong> shortlisted of ${s.total_resumes}</div>
            </div>
            <div class="ha">
              <button class="btn btn-primary" data-openout="${esc(s.session_id)}">Open &amp; draft mails</button>
            </div>
          </div>`).join("")}
      </div>`
    : `<h2>No shortlist to invite from yet</h2>
       <p>Run a screening on the <strong>Screen</strong> tab first. Once candidates are
          shortlisted they appear here so you can invite them.</p>`;

    el.querySelectorAll("[data-openout]").forEach((b) =>
      b.addEventListener("click", async () => {
        await openSession(b.dataset.openout);
        await loadOutreach();
      }));
  }

  function renderOutreach() {
    const o = state.outreach;
    if (!o) return;
    const drafts = o.drafts || [];
    const sent = drafts.filter((d) => d.status === "SENT").length;
    const noEmail = drafts.filter((d) => !d.has_email).length;
    const undrafted = o.eligible.filter((e) => !drafts.some((d) => d.candidate_id === e.candidate_id)).length;

    $("outJobTitle").textContent = `Interview invitations — ${o.job_title || "Shortlist"}`;
    $("outMeta").textContent =
      `From ${o.recruiter_name} <${o.recruiter_email}> · ${o.company} · send mode: ${o.send_mode}`;

    $("outStats").innerHTML = [
      ["Eligible", o.eligible.length, ""],
      ["Drafted", drafts.length, ""],
      ["Sent", sent, "ok"],
      ["Not yet drafted", undrafted, undrafted ? "warn" : ""],
      ["Missing email", noEmail, noEmail ? "bad" : ""],
    ].map(([label, val, cls]) =>
      `<div class="stat ${cls}"><div class="n">${val}</div><div class="l">${label}</div></div>`).join("");

    const counts = { ALL: drafts.length, DRAFT: drafts.length - sent, SENT: sent };
    $("outFilters").innerHTML = ["ALL", "DRAFT", "SENT"].map((f) =>
      `<button class="chip ${state.outFilter === f ? "active" : ""}" data-of="${f}">
         ${f === "ALL" ? "All" : f === "DRAFT" ? "Awaiting review" : "Sent"} (${counts[f]})</button>`).join("");
    $("outFilters").querySelectorAll("[data-of]").forEach((b) =>
      b.addEventListener("click", () => { state.outFilter = b.dataset.of; renderOutreach(); }));

    const shown = drafts.filter((d) =>
      state.outFilter === "ALL" || (state.outFilter === "SENT" ? d.status === "SENT" : d.status !== "SENT"));

    $("draftList").innerHTML = shown.length ? shown.map((d) => draftCard(d)).join("") : `
      <p class="sub" style="padding:20px;text-align:center">
        ${drafts.length ? "No drafts match this filter."
                        : "No drafts yet — click <strong>Draft mails</strong> to have the agent write them."}</p>`;

    wireDraftCards();
    $("outSelCount").textContent = `${o.eligible.length} shortlisted · ${sent} sent`;
  }

  function draftCard(d) {
    const isSent = d.status === "SENT";
    const body = isSent ? (d.sent_body || d.body) : d.body;
    return `
    <article class="draft ${isSent ? "draft-sent" : ""}" data-card="${esc(d.candidate_id)}">
      <header class="draft-head">
        <div>
          <strong>${esc(d.candidate_name)}</strong>
          <span class="sub">${d.has_email ? esc(d.email_id)
            : `<span class="warn-text">no email on file — add it on the Review tab</span>`}</span>
        </div>
        <div class="draft-badges">
          ${d.draft_source === "fallback" ? `<span class="pill pill-warn" title="${esc(d.draft_error || "")}">template</span>` : ""}
          ${d.edited && !isSent ? `<span class="pill pill-muted">edited</span>` : ""}
          ${isSent ? `<span class="pill pill-sent">✓ Mail sent (simulated) · ${when(d.sent_at)}</span>`
                   : `<span class="pill pill-muted">awaiting your approval</span>`}
        </div>
      </header>

      <label class="field"><span>Subject</span>
        <input type="text" data-subj="${esc(d.candidate_id)}" value="${esc(d.subject)}" ${isSent ? "disabled" : ""} /></label>
      <label class="field"><span>Body</span>
        <textarea rows="12" data-body="${esc(d.candidate_id)}" ${isSent ? "disabled" : ""}>${esc(body)}</textarea></label>

      ${d.tone_note && !isSent ? `<p class="hint">Agent note: ${esc(d.tone_note)}</p>` : ""}

      ${d.interview_link ? `
        <div class="link-box">
          <span class="link-label">Interview link</span>
          <a href="${esc(d.interview_link)}" target="_blank" rel="noopener">${esc(d.interview_link)}</a>
          <button class="btn btn-ghost" data-copy="${esc(d.interview_link)}">Copy</button>
        </div>
        <p class="hint">Opening this link starts their interview straight away — it is unique to
          them. It is already in the body above; if you edit that text, keep the link.</p>`
      : `<p class="hint warn-text">No interview link on this draft — check INCLUDE_INTERVIEW_LINK
          and that the interviewer app is configured.</p>`}

      ${isSent ? `
        <div class="sent-box">
          <span>✓ Marked as sent ${when(d.sent_at)} — this is the exact text that would have gone out.</span>
        </div>
        ${d.sent_interview_link || d.interview_link ? `
          <div class="link-box">
            <span class="link-label">Their interview link</span>
            <a href="${esc(d.sent_interview_link || d.interview_link)}" target="_blank" rel="noopener">${
              esc(d.sent_interview_link || d.interview_link)}</a>
            <button class="btn btn-ghost" data-copy="${esc(d.sent_interview_link || d.interview_link)}">Copy</button>
          </div>` : ""}`
      : `
        <div class="draft-actions">
          <button class="btn btn-ghost" data-save="${esc(d.candidate_id)}">Save edits</button>
          <button class="btn btn-primary" data-send="${esc(d.candidate_id)}" ${d.has_email ? "" : "disabled"}>
            📨 Send this invitation</button>
        </div>`}
    </article>`;
  }

  function wireDraftCards() {
    const list = $("draftList");
    list.querySelectorAll("[data-save]").forEach((b) =>
      b.addEventListener("click", () => saveDraft(b.dataset.save)));
    list.querySelectorAll("[data-send]").forEach((b) =>
      b.addEventListener("click", () => sendMails([b.dataset.send])));
    list.querySelectorAll("[data-copy]").forEach((b) =>
      b.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy); toast("Link copied", "ok"); }
        catch { toast("Copy failed — select the link manually", "err"); }
      }));
  }

  async function draftMails(regenerate, auto) {
    const btn = $("redraftBtn");
    const label = btn.textContent;
    btn.disabled = true; $("sendAllBtn").disabled = true;
    btn.textContent = "Drafting…";
    const n = (state.outreach?.eligible || []).length;
    $("draftList").innerHTML = `
      <div class="drafting">
        <div class="spinner"></div>
        <p><strong>The agent is writing ${n} invitation${n === 1 ? "" : "s"}…</strong></p>
        <p class="sub">Each one is personalised from that candidate’s own resume. This takes a few seconds.</p>
      </div>`;
    try {
      const res = await api(`/api/sessions/${state.session.session_id}/outreach/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate }),
      });
      await loadOutreach(false);
      if (res.drafted === 0 && !auto) toast(res.detail || "Nothing to draft", "");
      else if (res.drafted) {
        toast(`Drafted ${res.drafted} invitation${res.drafted === 1 ? "" : "s"} — review and edit, then send` +
              (res.failures ? ` · ${res.failures} used the fallback template` : ""), "ok");
      }
    } catch (err) {
      toast(`Drafting failed: ${err.message}`, "err");
      await loadOutreach(false);
    } finally {
      btn.disabled = false; $("sendAllBtn").disabled = false;
      btn.textContent = label;
    }
  }

  async function saveDraft(cid, quiet) {
    const subject = document.querySelector(`[data-subj="${CSS.escape(cid)}"]`)?.value ?? "";
    const body = document.querySelector(`[data-body="${CSS.escape(cid)}"]`)?.value ?? "";
    try {
      await api(`/api/sessions/${state.session.session_id}/outreach/${encodeURIComponent(cid)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body }),
      });
      const draft = state.outreach.drafts.find((d) => d.candidate_id === cid);
      if (draft) { draft.subject = subject; draft.body = body; draft.edited = true; }
      if (!quiet) toast("Draft saved", "ok");
    } catch (err) {
      toast(`Save failed: ${err.message}`, "err");
      throw err;
    }
  }

  /** Send every unsent invitation in one go. */
  async function sendAll() {
    const pending = (state.outreach?.drafts || []).filter((d) => d.status !== "SENT");
    if (!pending.length) return toast("Every invitation has already been sent", "");
    const ready = pending.filter((d) => d.has_email);
    if (!ready.length) {
      return toast("None of these rows has an email address — add them on the Review tab", "err");
    }
    await sendMails(ready.map((d) => d.candidate_id));
  }

  async function sendMails(ids) {
    const btn = $("sendAllBtn");
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Sending…";
    // Persist any edits still sitting in the textareas before they go out.
    try {
      await Promise.all(ids
        .filter((cid) => document.querySelector(`[data-body="${CSS.escape(cid)}"]`))
        .map((cid) => saveDraft(cid, true).catch(() => {})));
    } catch { /* a failed save is reported by saveDraft; send what we have */ }

    try {
      const res = await api(`/api/sessions/${state.session.session_id}/outreach/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_ids: ids }),
      });
      await loadOutreach(false);
      showSentBanner(res);
    } catch (err) {
      toast(`Send failed: ${err.message}`, "err");
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  function showSentBanner(res) {
    const n = res.sent_count;
    const el = $("sentBanner");
    el.innerHTML = `
      <div class="sent-banner-mark">✓</div>
      <div class="sent-banner-text">
        <h2>Mail has been sent</h2>
        <p>${n} interview invitation${n === 1 ? "" : "s"} sent to shortlisted candidate${n === 1 ? "" : "s"}.</p>
        <p class="sent-banner-sim">Simulated — no email actually left this machine.
           Everything else behaved exactly as a real send would.</p>
        ${res.skipped?.length ? `
          <p class="sent-banner-skip"><strong>${res.skipped.length} skipped:</strong>
             ${res.skipped.map((s) => esc(s.candidate_name)).join(", ")} — ${esc(res.skipped[0].reason)}</p>` : ""}
        <div class="sent-banner-actions">
          <button class="btn btn-link" id="dismissSent">Dismiss</button>
        </div>
      </div>`;
    el.hidden = false;
    el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
    el.scrollIntoView({ behavior: "smooth", block: "center" });

    $("dismissSent").addEventListener("click", () => { el.hidden = true; });
    toast(`✓ Mail has been sent to ${n} candidate${n === 1 ? "" : "s"}`, "ok");
  }

  /* ------------------------------------------------------------- history */
  async function loadHistory() {
    try {
      const rows = await api("/api/history");
      $("historyList").innerHTML = rows.length ? rows.map((h) => `
        <div class="hrow">
          <div>
            <div class="ht">${esc(h.job_title)} <span class="sub">· ${h.final_count} candidates</span></div>
            <div class="hm">${esc(h.history_id)} · accepted ${when(h.accepted_at)} by ${esc(h.accepted_by)}
              · threshold ${h.threshold}% · evaluated ${h.total_evaluated}</div>
          </div>
          <div class="ha">
            <button class="btn btn-ghost" data-open="${esc(h.history_id)}">Open</button>
            <button class="btn btn-ghost" data-xl="${esc(h.history_id)}">⬇ Excel</button>
            <button class="btn btn-ghost" data-delh="${esc(h.history_id)}">Delete</button>
          </div>
        </div>`).join("") : `<p class="sub">No accepted shortlists yet.</p>`;

      $("historyList").querySelectorAll("[data-open]").forEach((b) =>
        b.addEventListener("click", () => openHistory(b.dataset.open)));
      $("historyList").querySelectorAll("[data-xl]").forEach((b) =>
        b.addEventListener("click", () => { window.location.href = `/api/history/${b.dataset.xl}/export`; }));
      $("historyList").querySelectorAll("[data-delh]").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm("Delete this history record permanently?")) return;
          await api(`/api/history/${b.dataset.delh}`, { method: "DELETE" });
          toast("History record deleted"); loadHistory();
        }));
    } catch (err) { toast(`History load failed: ${err.message}`, "err"); }
  }

  async function loadSessions() {
    try {
      const rows = await api("/api/sessions");
      $("sessionList").innerHTML = rows.length ? rows.map((s) => `
        <div class="hrow">
          <div>
            <div class="ht">${esc(s.job_title)} ${s.accepted ? '<span class="pill pill-locked">accepted</span>' : ""}</div>
            <div class="hm">${esc(s.session_id)} · ${when(s.created_at)} · ${s.status}
              · ${s.shortlisted}/${s.total_resumes} shortlisted</div>
          </div>
          <div class="ha">
            <button class="btn btn-ghost" data-opens="${esc(s.session_id)}">Open</button>
            <button class="btn btn-ghost" data-xls="${esc(s.session_id)}">⬇ Excel</button>
            <button class="btn btn-ghost" data-dels="${esc(s.session_id)}">Delete</button>
          </div>
        </div>`).join("") : `<p class="sub">No screening sessions yet.</p>`;

      $("sessionList").querySelectorAll("[data-opens]").forEach((b) =>
        b.addEventListener("click", async () => { await openSession(b.dataset.opens); showTab("results"); }));
      $("sessionList").querySelectorAll("[data-xls]").forEach((b) =>
        b.addEventListener("click", () => { window.location.href = `/api/sessions/${b.dataset.xls}/export`; }));
      $("sessionList").querySelectorAll("[data-dels]").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm("Delete this screening session?")) return;
          await api(`/api/sessions/${b.dataset.dels}`, { method: "DELETE" });
          toast("Session deleted"); loadSessions();
        }));
    } catch (err) { toast(`Sessions load failed: ${err.message}`, "err"); }
  }

  init();
})();
