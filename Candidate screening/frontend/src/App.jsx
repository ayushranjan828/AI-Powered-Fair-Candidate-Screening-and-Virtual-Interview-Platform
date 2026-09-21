import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import HistoryTab from "./components/HistoryTab.jsx";
import OutreachTab from "./components/OutreachTab.jsx";
import ReviewTab from "./components/ReviewTab.jsx";
import ScreenTab from "./components/ScreenTab.jsx";
import Sidebar from "./components/Sidebar.jsx";
import { useConfirm } from "./components/Confirm.jsx";
import { useToast } from "./components/Toast.jsx";
import useScreeningRun from "./hooks/useScreeningRun.js";
import { getJson } from "./lib/api.js";
import { CRITERIA_INFO } from "./lib/constants.js";

/** Used when /api/config cannot be reached, so the UI still renders. */
const FALLBACK_CFG = {
  default_threshold: 60,
  criteria: Object.keys(CRITERIA_INFO),
  default_weights: {},
  default_cutoffs: {},
  ai_configured: false,
};

export default function App() {
  const toast = useToast();
  const confirm = useConfirm();

  const [cfg, setCfg] = useState(null);
  const [tab, setTab] = useState("screen");
  const [session, setSession] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [ai, setAi] = useState({ label: "checking AI…", kind: "pill-muted" });
  // Bumped to make the history and sessions lists refetch.
  const [historyNonce, setHistoryNonce] = useState(0);

  const readOnly = Boolean(session?.accepted_history_id || session?.is_history);

  // Read inside callbacks that must not be re-created when `dirty` changes.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  /* ------------------------------------------------------------- session */
  const loadSession = useCallback(async (sessionId) => {
    const s = await getJson(`/api/sessions/${sessionId}`);
    setSession(s);
    setDirty(false);
    return s;
  }, []);

  const run = useScreeningRun({
    onFinished: useCallback(
      async (sessionId, payload, outcome) => {
        try {
          await loadSession(sessionId);
        } catch (err) {
          toast(`Could not load the finished session: ${err.message}`, "err");
          return;
        }
        setTab("results");
        if (outcome === "failed") {
          toast(
            `Screening failed: ${
              payload.error || payload.progress?.stage || "see the server log"
            }. Partial results kept.`,
            "err",
          );
        } else {
          toast(
            `Done — ${payload.stats?.shortlisted ?? 0} shortlisted of ${payload.stats?.total ?? 0}`,
            "ok",
          );
        }
      },
      [loadSession, toast],
    ),
    onLost: useCallback(
      (err) =>
        toast(
          `Lost track of the run: ${err.message}. Reopen it from History › Screening sessions.`,
          "err",
        ),
      [toast],
    ),
  });

  const confirmDiscardEdits = useCallback(
    () =>
      !dirtyRef.current ||
      confirm({
        title: "Discard unsaved edits?",
        message:
          "You have edits on the Review tab that have not been saved. Opening another record will lose them.",
        confirmLabel: "Discard and open",
        danger: true,
      }),
    [confirm],
  );

  const openSession = useCallback(
    async (sessionId, { switchTab = false } = {}) => {
      if (session?.session_id !== sessionId && !(await confirmDiscardEdits())) return null;
      const s = await loadSession(sessionId);
      if (switchTab) setTab("results");
      // A page reload used to lose track of a running screening entirely.
      if (s.status === "processing") {
        run.show(s.progress || {});
        toast("This screening is still running — progress resumes on the Screen tab", "");
        run.poll(sessionId);
      }
      return s;
    },
    [session?.session_id, confirmDiscardEdits, loadSession, run, toast],
  );

  const openHistory = useCallback(
    async (historyId, { switchTab = true, skipDiscardCheck = false } = {}) => {
      // Straight after accepting there is nothing to discard: the rows were
      // just saved. Asking anyway would be wrong, and `dirty` may not have
      // re-rendered yet, so the check would fire on a stale value.
      if (!skipDiscardCheck && !(await confirmDiscardEdits())) return null;
      const h = await getJson(`/api/history/${historyId}`);
      setSession({ ...h, is_history: true });
      setDirty(false);
      if (switchTab) setTab("results");
      return h;
    },
    [confirmDiscardEdits],
  );

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
      setAi(
        loaded.ai_configured
          ? { label: `AI configured · ${loaded.deployment}`, kind: "pill-ok" }
          : { label: "AI not configured — check .env", kind: "pill-bad" },
      );

      // ?session=SES-...&tab=outreach opens a session straight on a given tab,
      // so a recruiter can bookmark "the invitations for this shortlist".
      const params = new URLSearchParams(window.location.search);
      const wanted = params.get("session");
      if (!wanted) return;
      try {
        const s = await getJson(`/api/sessions/${wanted}`);
        if (cancelled) return;
        setSession(s);
        setTab(params.get("tab") || "results");
        if (s.status === "processing") run.poll(wanted);
      } catch (err) {
        if (!cancelled) toast(`Could not open ${wanted}: ${err.message}`, "err");
      }
    })();

    return () => {
      cancelled = true;
    };
    // Boot once. `run` and `toast` are stable enough for this single pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Unsaved grid edits should survive a stray tab close. */
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  /* The old UI swallowed init errors silently; surface them instead. */
  useEffect(() => {
    const onError = (e) =>
      toast(`UI error: ${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`, "err");
    const onRejection = (e) =>
      toast(`Request failed: ${e.reason?.message || e.reason}`, "err");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [toast]);

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

  const completed = useMemo(
    () => ({
      screen: Boolean(session),
      results: Boolean(session?.accepted_history_id || session?.is_history),
    }),
    [session],
  );

  const refreshLists = useCallback(() => setHistoryNonce((n) => n + 1), []);

  if (!cfg) {
    return (
      <div className="empty" style={{ margin: "18vh auto", maxWidth: 420 }}>
        <div className="spinner" />
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <Sidebar tab={tab} onTab={setTab} ai={ai} onCheckAi={checkAi} completed={completed} />

      <main>
        {tab === "screen" && (
          <ScreenTab
            cfg={cfg}
            run={run}
            onStarted={(sessionId) => run.poll(sessionId)}
            onRefreshLists={refreshLists}
          />
        )}

        {tab === "results" && (
          <ReviewTab
            session={session}
            setSession={setSession}
            readOnly={readOnly}
            dirty={dirty}
            setDirty={setDirty}
            onGoToOutreach={() => setTab("outreach")}
            onAccepted={async (historyId) => {
              setDirty(false);
              await openHistory(historyId, { switchTab: false, skipDiscardCheck: true });
              refreshLists();
            }}
          />
        )}

        {tab === "outreach" && (
          <OutreachTab session={session} onOpenSession={(id) => openSession(id)} />
        )}

        {tab === "history" && (
          <HistoryTab
            nonce={historyNonce}
            onOpenHistory={openHistory}
            onOpenSession={(id) => openSession(id, { switchTab: true })}
            onChanged={refreshLists}
          />
        )}
      </main>
    </div>
  );
}
