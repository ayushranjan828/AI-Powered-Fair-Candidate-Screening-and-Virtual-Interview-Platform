/** A row of headline numbers. `cells` is [label, value, kind][]. */
export default function Stats({ cells }) {
  return (
    <div className="stats">
      {cells.map(([label, value, kind]) => (
        <div key={label} className={`stat ${kind || ""}`}>
          <div className="n">{value}</div>
          <div className="l">{label}</div>
        </div>
      ))}
    </div>
  );
}
