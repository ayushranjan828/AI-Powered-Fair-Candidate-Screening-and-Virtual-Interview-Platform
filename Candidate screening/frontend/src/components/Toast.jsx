import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

const ToastContext = createContext(() => {});

/** `const toast = useToast(); toast("Saved", "ok")` — kinds: "", "ok", "err". */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const seq = useRef(0);

  const dismiss = useCallback((id) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message, kind = "") => {
      const id = ++seq.current;
      setItems((prev) => [...prev, { id, message, kind }]);
      // Errors stay up longer — they usually need to be read, not glanced at.
      setTimeout(() => dismiss(id), kind === "err" ? 6500 : 3800);
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.message}</span>
            <button
              type="button"
              className="toast-x"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
