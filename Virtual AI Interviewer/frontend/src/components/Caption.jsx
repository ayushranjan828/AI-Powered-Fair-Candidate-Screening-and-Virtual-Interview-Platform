/** The line being spoken, with the current word bolded as speech reaches it. */
export default function Caption({ tokens, active }) {
  return (
    <div className="caption" aria-live="polite">
      {tokens.map((t, i) =>
        i === active ? <b key={i}>{t.text}</b> : <span key={i}>{t.text}</span>,
      )}
    </div>
  );
}
