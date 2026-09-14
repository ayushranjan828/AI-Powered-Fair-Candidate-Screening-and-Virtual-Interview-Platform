import { useCallback, useEffect, useRef, useState } from "react";

import CandidateSettingsDrawer from "./components/CandidateSettingsDrawer.jsx";
import DashboardTab from "./components/DashboardTab.jsx";
import HistoryTab from "./components/HistoryTab.jsx";
import InterviewDetailsDrawer from "./components/InterviewDetailsDrawer.jsx";
import InvitationDrawer from "./components/InvitationDrawer.jsx";
import ReportTab from "./components/ReportTab.jsx";
import Sidebar from "./components/Sidebar.jsx";
import StageTab from "./components/StageTab.jsx";
import { defaultOptions } from "./components/InterviewShape.jsx";
import { useToast } from "./components/Toast.jsx";
import useVoices from "./hooks/useVoices.js";
import { download, getJson, seg } from "./lib/api.js";
import { ALL_SCOPE, FALLBACK_CFG } from "./lib/constants.js";

const PLAN_POLL_MS = 1200;

export default function App() {
  const toast = useToast();
  const { voices, preferred } = useVoices();

  const [cfg, setCfg] = useState(null);
  const [tab, setTab] = useState("setup");
  const [ai, setAi] = useState({ label: "checking AI…", kind: "pill-muted" });

  /* Dashboard ------------------------------------------------------------ */
  const [shortlists, setShortlists] = useState([]);
  const [shortlistsMeta, setShortlistsMeta] = useState(null);
  const [historyId, setHistoryId] = useState("");
  const [dash, setDash] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [planProgress, setPlanProgress] = useState(null);

  /* Stage / report / history --------------------------------------------- */
  const [interviewId, setInterviewId] = useState(null);
  const [reportScope, setReportScope] = useState("");
  const [overview, setOverview] = useState(null);
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState([]);

  /* Drawers -------------------------------------------------------------- */
  const [mailTarget, setMailTarget] = useState(null);
  const [settingsFor, setSettingsFor] = useState(null);
  const [detailsFor, setDetailsFor] = useState(null);

  const planTimer = useRef(null);

  /* ---------------------------------------------------------------- data */
  const loadDashboard = useCallback(
    async (id) => {
      if (!id) {
        setDash(null);
        return null;
      }
      try {
        const data = await getJson(`/api/dashboard/${seg(id)}`);
        setDash(data);
        return data;
      } catch (err) {
        toast(`Dashboard: ${err.message}`, "err");
        return null;
      }
    },
    [toast],
  );

  const loadOverview = useCallback(
    async (scope, quiet = true) => {
      if (!scope) {
        setOverview(null);
        return;
      }
      try {
        setOverview(
          scope === ALL_SCOPE
            ? await getJson("/api/reports")
            : await getJson(`/api/dashboard/${seg(scope)}`),
        );
        if (!quiet) toast("Reports loaded", "");
      } catch (err) {
        toast(`Reports: ${err.message}`, "err");
      }
    },
    [toast],
  );

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await getJson("/api/interviews"));
    } catch (err) {
      toast(`History load failed: ${err.message}`, "err");
    }
  }, [toast]);

  const openReport = useCallback(
    async (id) => {
      try {
        const data = await getJson(`/api/interviews/${seg(id)}/report`);
        setReport({ ...data, interview_id: id });
        setInterviewId(id);
        setTab("report");
      } catch (err) {
        toast(`Report: ${err.message}`, "err");
      }
    },
    [toast],
  );

  const openStage = useCallback((id) => {
    setInterviewId(id);
    setTab("stage");
  }, []);

  /** Poll until the question plan exists. */
  const waitForPlan = useCallback(
    (id, { openStage: jump = true } = {}) =>
      new Promise((resolve) => {
        clearInterval(planTimer.current);
        planTimer.current = setInterval(async () => {
          let status;
          try {
            status = await getJson(`/api/interviews/${seg(id)}/status`);
          } catch (err) {
            clearInterval(planTimer.current);
            setPlanProgress(null);
            toast(`Planning failed: ${err.message}`, "err");
            resolve(null);
            return;
          }
          setPlanProgress({
            stage: status.progress?.stage || status.status,
            detail: status.progress?.detail || "",
          });
          if (status.status !== "planning") {
            clearInterval(planTimer.current);
            setPlanProgress(null);
            if (status.plan_error) {
              toast(status.plan_error, "");
              console.warn("plan note:", status.plan_error);
            }
            if (jump) openStage(id);
            resolve(status);
          }
        }, PLAN_POLL_MS);
      }),
    [openStage, toast],
  );

  useEffect(() => () => clearInterval(planTimer.current), []);

  /* ---------------------------------------------------------------- boot */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      let loaded;
      try {
        loaded = await getJson("/api/config");
      } catch {
        loaded = FALLBACK_CFG;
      }
      if (cancelled) return;

      setCfg(loaded);
      setDefaults(defaultOptions(loaded));
      setAi(
        loaded.ai_configured
          ? { label: `AI configured · ${loaded.deployment}`, kind: "pill-ok" }
          : { label: "AI not configured — check .env", kind: "pill-bad" },
      );

      let rows = [];
      try {
        const data = await getJson("/api/shortlists");
        rows = data.shortlists || [];
        if (!cancelled) {
          setShortlists(rows);
          setShortlistsMeta(data);
        }
      } catch (err) {
        if (!cancelled) toast(`Shortlists: ${err.message}`, "err");
      }
      if (cancelled) return;

      const params = new URLSearchParams(window.location.search);

      // ?shortlist=HIS-... opens that shortlist's dashboard straight away, so a
      // recruiter can bookmark the board for a role they are actively hiring for.
      const board = params.get("shortlist");
      if (board) {
        setHistoryId(board);
        await loadDashboard(board);
      } else if (rows.length === 1) {
        setHistoryId(rows[0].history_id);
        await loadDashboard(rows[0].history_id);
        setReportScope(rows[0].history_id);
        await loadOverview(rows[0].history_id);
      }
      if (cancelled) return;

      // ?interview=INT-... reopens one directly, so a reviewer can bookmark or
      // share a link to a specific interview instead of hunting through History.
      const wanted = params.get("interview");
      if (wanted) {
        try {
          const view = await getJson(`/api/interviews/${seg(wanted)}`);
          if (cancelled) return;
          if (view.has_report) await openReport(wanted);
          else openStage(wanted);
        } catch (err) {
          if (!cancelled) toast(`Could not open ${wanted}: ${err.message}`, "err");
        }
      }

      // ?tab=history opens straight onto a tab, so any of these deep links can
      // be bookmarked at the view the recruiter actually wants.
      const wantedTab = params.get("tab");
      if (wantedTab && ["setup", "stage", "report", "history"].includes(wantedTab)) {
        setTab(wantedTab);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Boot once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* The old UI swallowed init errors silently; surface them instead. */
  useEffect(() => {
    const onError = (e) =>
      toast(`UI error: ${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`, "err");
    const onRejection = (e) => toast(`Request failed: ${e.reason?.message || e.reason}`, "err");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [toast]);

  /* Lazy loads when a tab is first opened. */
  useEffect(() => {
    if (tab === "history") loadHistory();
    // Opening Reports with nothing chosen follows whatever the dashboard is on,
    // which is nearly always the shortlist the recruiter is working through.
    if (tab === "report" && !overview && historyId) {
      setReportScope(historyId);
      loadOverview(historyId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /* ------------------------------------------------------------ ai check */
  const checkAi = useCallback(async () => {
    setAi({ label: "testing…", kind: "pill-muted" });
    try {
      const r = await getJson("/api/ai-check");
      if (r.ok) {
        setAi({ label: `AI live · ${r.deployment}`, kind: "pill-ok" });
        toast("Azure OpenAI reachable", "ok");
      } else {
        setAi({ label: "AI unreachable", kind: "pill-bad" });
        toast(r.detail, "err");
      }
    } catch (err) {
      setAi({ label: "AI unreachable", kind: "pill-bad" });
      toast(err.message, "err");
    }
  }, [toast]);

  /** A saved decision or a deleted row changes several lists at once. */
  const refreshAll = useCallback(async () => {
    await Promise.all([
      historyId ? loadDashboard(historyId) : Promise.resolve(),
      reportScope ? loadOverview(reportScope) : Promise.resolve(),
      loadHistory(),
    ]);
  }, [historyId, reportScope, loadDashboard, loadOverview, loadHistory]);

  if (!cfg || !defaults) {
    return (
      <div className="empty" style={{ margin: "18vh auto", maxWidth: 420 }}>
        <div className="spinner" />
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <Sidebar tab={tab} onTab={setTab} ai={ai} onCheckAi={checkAi} />

      <main>
        {tab === "setup" && (
          <DashboardTab
            cfg={cfg}
            shortlists={shortlists}
            shortlistsMeta={shortlistsMeta}
            historyId={historyId}
            onPickShortlist={async (id) => {
              setHistoryId(id);
              await loadDashboard(id);
            }}
            dash={dash}
            onRefresh={() => loadDashboard(historyId)}
            defaults={defaults}
            setDefaults={setDefaults}
            voices={voices}
            preferred={preferred}
            onOpenStage={openStage}
            onOpenReport={openReport}
            onOpenMail={(cid, scope, name) =>
              setMailTarget({
                candidateId: cid,
                scope: scope || historyId,
                displayName:
                  name ||
                  (dash?.rows || []).find((r) => r.candidate_id === cid)?.candidate_name ||
                  "",
              })
            }
            onOpenSettings={setSettingsFor}
            onExportInterview={(id) => download(`/api/interviews/${seg(id)}/export`)}
            planProgress={planProgress}
            setPlanProgress={setPlanProgress}
            waitForPlan={waitForPlan}
          />
        )}

        {tab === "stage" && (
          <StageTab
            interviewId={interviewId}
            onEvaluated={async (id) => {
              await openReport(id);
              await refreshAll();
            }}
            onAbandoned={async () => {
              setInterviewId(null);
              await refreshAll();
            }}
          />
        )}

        {tab === "report" && (
          <ReportTab
            cfg={cfg}
            shortlists={shortlists}
            scope={reportScope}
            onScope={async (scope) => {
              setReportScope(scope);
              await loadOverview(scope);
            }}
            overview={overview}
            onRefreshOverview={() => loadOverview(reportScope, false)}
            report={report}
            onOpenReport={openReport}
            onChanged={refreshAll}
          />
        )}

        {tab === "history" && (
          <HistoryTab
            rows={history}
            onRefresh={async (deletedIds) => {
              // A deleted interview may be the one open on the Report tab.
              if (deletedIds?.includes(interviewId)) {
                setInterviewId(null);
                setReport(null);
              }
              await loadHistory();
              if (historyId) await loadDashboard(historyId);
            }}
            onOpenReport={openReport}
            onOpenStage={openStage}
            onOpenDetails={setDetailsFor}
          />
        )}
      </main>

      <InvitationDrawer
        target={mailTarget}
        onClose={() => setMailTarget(null)}
        onSent={refreshAll}
      />

      <CandidateSettingsDrawer
        cfg={cfg}
        historyId={historyId}
        candidateId={settingsFor}
        candidateName={
          (dash?.rows || []).find((r) => r.candidate_id === settingsFor)?.candidate_name
        }
        voices={voices}
        preferred={preferred}
        onClose={() => setSettingsFor(null)}
        onSaved={() => loadDashboard(historyId)}
      />

      <InterviewDetailsDrawer
        interviewId={detailsFor}
        onClose={() => setDetailsFor(null)}
        onOpenReport={openReport}
      />
    </div>
  );
}
