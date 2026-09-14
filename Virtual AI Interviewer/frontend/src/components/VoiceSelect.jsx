/**
 * The installed voices, with the stored one selected.
 *
 * A stored voice that is not installed on THIS machine is still listed, marked
 * as such. Without that, opening the picker on a machine lacking the voice
 * would show "Recommended" and a plain Save would silently wipe the recruiter's
 * choice — and the voice may well exist on the candidate's machine.
 */
export default function VoiceSelect({ voices, preferred, value, onChange }) {
  const installed = voices.some((v) => v.name === value);

  return (
    <select value={value || ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">Recommended ({preferred?.name || "system"})</option>
      {value && !installed && (
        <option value={value}>{value} · not installed here</option>
      )}
      {voices.map((v) => (
        <option key={v.name} value={v.name}>
          {v.name} · {v.lang}
        </option>
      ))}
    </select>
  );
}
