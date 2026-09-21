import { createContext, useCallback, useContext, useRef, useState } from "react";

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
      if (!message) return null;
      const id = ++seq.current;
      setItems((prev) => [...prev, { id, message: String(message), kind }]);
      // Errors stay up longer — they usually need reading, not glancing at.
      setTimeout(() => dismiss(id), kind === "err" ? 6500 : 4200);
      return id;
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
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
