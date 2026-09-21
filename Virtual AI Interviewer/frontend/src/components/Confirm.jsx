import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import Modal from "./Modal.jsx";

const ConfirmContext = createContext(async () => true);

/**
 * `const confirm = useConfirm(); if (await confirm({ title, body, ... })) {}`
 *
 * Options: title, body, detail (the name of what is about to change, given its
 * own weight), ok, cancel (pass "" to hide it), danger, and `copy` - which
 * swaps the question for a selectable box. That last one is the fallback when
 * the clipboard is unavailable, where window.prompt() used to truncate a link.
 */
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolver = useRef(null);
  const copyRef = useRef(null);
  const okRef = useRef(null);

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
        setDialog(typeof opts === "string" ? { title: opts } : opts || {});
      }),
    [],
  );

  // A copy box wants its text selected and ready; anything else wants the
  // action under the finger, so Enter answers it.
  useEffect(() => {
    if (!dialog) return;
    if (dialog.copy) {
      copyRef.current?.focus();
      copyRef.current?.select();
    } else {
      okRef.current?.focus();
    }
  }, [dialog]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={Boolean(dialog)}
        onClose={() => settle(false)}
        labelledBy="confirm-title"
        role="alertdialog"
      >
        {dialog && (
          <>
            <h3 id="confirm-title">{dialog.title}</h3>
            <div className="modal-body">
              {dialog.detail && <p className="modal-detail">{dialog.detail}</p>}
              {dialog.body && <p>{dialog.body}</p>}
              {dialog.copy && (
                <textarea className="modal-copy" readOnly ref={copyRef} value={dialog.copy} />
              )}
            </div>
            <div className="modal-actions">
              {dialog.cancel !== "" && (
                <button type="button" className="btn btn-ghost" onClick={() => settle(false)}>
                  {dialog.cancel || "Cancel"}
                </button>
              )}
              <button
                type="button"
                ref={okRef}
                className={`btn ${dialog.danger ? "btn-danger" : "btn-primary"}`}
                onClick={() => settle(true)}
              >
                {dialog.ok || "OK"}
              </button>
            </div>
          </>
        )}
      </Modal>
    </ConfirmContext.Provider>
  );
}
