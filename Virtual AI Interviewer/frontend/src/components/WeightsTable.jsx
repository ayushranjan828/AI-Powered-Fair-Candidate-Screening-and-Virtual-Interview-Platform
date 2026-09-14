import { titleise } from "../lib/format.js";

/** Evaluation weights, with a total that turns amber when it is not 100. */
export default function WeightsTable({ parameters, weights, onChange, tight = false }) {
  const keys = Object.keys(parameters || {});
  const total = keys.reduce((a, k) => a + (Number(weights[k]) || 0), 0);

  return (
    <table className={`criteria-table ${tight ? "criteria-tight" : ""}`}>
      <thead>
        <tr>
          <th>Parameter</th>
          <th>Weight (%)</th>
          {!tight && <th>What it measures</th>}
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => (
          <tr key={key}>
            <td>{tight ? titleise(key) : <strong>{titleise(key)}</strong>}</td>
            <td>
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={weights[key] ?? 0}
                onChange={(e) => onChange(key, Number(e.target.value) || 0)}
              />
            </td>
            {!tight && <td className="why">{parameters[key]}</td>}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td style={{ color: total === 100 ? "var(--ok)" : "var(--warn)" }}>{total}</td>
          {!tight && <td />}
        </tr>
      </tfoot>
    </table>
  );
}
