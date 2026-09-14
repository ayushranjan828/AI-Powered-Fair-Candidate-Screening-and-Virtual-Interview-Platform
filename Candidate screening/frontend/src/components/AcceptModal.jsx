import { useState } from "react";

import Modal from "./Modal.jsx";

export default function AcceptModal({ open, onClose, onConfirm, busy }) {
  const [acceptedBy, setAcceptedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [onlyShortlisted, setOnlyShortlisted] = useState(true);

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} labelledBy="accept-title">
      <h3 id="accept-title">Accept shortlist</h3>
      <p className="sub">
        This records the human-verified shortlist in history. The session becomes read-only.
      </p>

      <label className="field">
        <span>Verified by</span>
        <input
          type="text"
          value={acceptedBy}
          onChange={(e) => setAcceptedBy(e.target.value)}
          placeholder="Your name"
        />
      </label>

      <label className="field">
        <span>Notes (optional)</span>
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={onlyShortlisted}
          onChange={(e) => setOnlyShortlisted(e.target.checked)}
        />
        Save only Shortlisted + Review rows
      </label>

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            onConfirm({
              accepted_by: acceptedBy.trim(),
              notes: notes.trim(),
              only_shortlisted: onlyShortlisted,
            })
          }
        >
          {busy ? "Saving…" : "Accept & save"}
        </button>
      </div>
    </Modal>
  );
}
