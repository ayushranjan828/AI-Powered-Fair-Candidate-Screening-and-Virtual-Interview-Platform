import { useCallback, useEffect, useRef, useState } from "react";

import { getJson } from "../lib/api.js";

const POLL_MS = 1800;

/** A single blip (laptop sleep, dev reload) must not kill the poll. */
const MAX_MISSES = 5;

/**
 * Tracks one running screening job.
 *
 * Owned above the Screen tab because a run has to survive tab switches, and
 * because re-opening a session that is still "processing" has to be able to
 * pick the poll back up.
 */
export default function useScreeningRun({ onFinished, onLost }) {
  const [progress, setProgress] = useState(null);
  const [running, setRunning] = useState(false);
  const timer = useRef(null);
  // Keep the callbacks fresh without restarting the interval on every render.
  const handlers = useRef({ onFinished, onLost });
  handlers.current = { onFinished, onLost };

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setRunning(false);
  }, []);

  useEffect(() => stop, [stop]);

  /** forcePct pins the bar while the server has not reported real counts yet. */
  const show = useCallback((p, forcePct) => {
    const total = p?.total || 0;
    const processed = p?.processed || 0;
    const pct = forcePct ?? (total ? Math.round((processed / total) * 100) : 0);
    setProgress({ ...p, processed, total, pct: Math.max(pct, 3) });
  }, []);

  const clear = useCallback(() => setProgress(null), []);

  const poll = useCallback(
    (sessionId) => {
      if (timer.current) clearInterval(timer.current);
      setRunning(true);
      let misses = 0;

      timer.current = setInterval(async () => {
        try {
          const p = await getJson(`/api/sessions/${sessionId}/progress`);
          misses = 0;
          show(p.progress || {});

          if (p.status === "failed") {
            stop();
            handlers.current.onFinished?.(sessionId, p, "failed");
          } else if (p.status === "completed" || p.status === "accepted") {
            stop();
            show({ ...(p.progress || {}), stage: "Completed" }, 100);
            handlers.current.onFinished?.(sessionId, p, "completed");
          }
        } catch (err) {
          if (++misses < MAX_MISSES) return;
          stop();
          handlers.current.onLost?.(err);
        }
      }, POLL_MS);
    },
    [show, stop],
  );

  return { progress, running, poll, stop, show, clear };
}
