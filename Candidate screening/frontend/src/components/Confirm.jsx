import { createContext, useCallback, useContext, useRef, useState } from "react";

import Modal from "./Modal.jsx";

const ConfirmContext = createContext(async () => true);

/**
 * `const confirm = useConfirm(); if (await confirm({...})) { ... }`
 *
 * Replaces window.confirm so destructive actions get a styled dialog that
 * matches the rest of the app instead of a browser chrome box.
 */
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolver = useRef(null);

  const settle = useCallback((answer) => {
    setDialog(null);
    const resolve = resolver.current;
    resolver.current = null;
    if (resolve) resolve(answer);
  }, []);

  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        // A second prompt while one is open would strand the first promise.
        if (resolver.current) resolver.current(false);
        resolver.current = resolve;
        setDialog(typeof opts === "string" ? { message: opts } : opts || {});
      }),
    [],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal open={Boolean(dialog)} onClose={() => settle(false)} labelledBy="confirm-title">
        {dialog && (
          <>
            <h3 id="confirm-title">{dialog.title || "Are you sure?"}</h3>
            <p className="sub">{dialog.message}</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => settle(false)}>
                {dialog.cancelLabel || "Cancel"}
              </button>
              <button
                type="button"
                className={`btn ${dialog.danger ? "btn-danger" : "btn-primary"}`}
                onClick={() => settle(true)}
                autoFocus
              >
                {dialog.confirmLabel || "Continue"}
              </button>
            </div>
          </>
        )}
      </Modal>
    </ConfirmContext.Provider>
  );
}
