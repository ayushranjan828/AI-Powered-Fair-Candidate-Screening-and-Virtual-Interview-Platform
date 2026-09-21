import { useEffect } from "react";

/**
 * Centred overlay, in place of the browser's own confirm() which paints at the
 * top of the window - far from the button that raised it - and can only render
 * plain text. Escape and a backdrop click both dismiss it.
 */
export default function Modal({ open, onClose, children, labelledBy, role = "dialog" }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      // mousedown, not click: a drag that starts inside the card and ends on the
      // backdrop must not dismiss what the user was reading.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role={role} aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  );
}
