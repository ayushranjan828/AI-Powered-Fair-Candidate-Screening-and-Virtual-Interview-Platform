import { useEffect } from "react";

/**
 * Centred overlay. Escape and a backdrop click both close it, matching the
 * behaviour the old vanilla UI had.
 */
export default function Modal({ open, onClose, children, labelledBy }) {
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
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      onMouseDown={(e) => {
        // mousedown, not click: a drag that starts inside the card and ends on
        // the backdrop should not count as "clicked outside".
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card">{children}</div>
    </div>
  );
}
