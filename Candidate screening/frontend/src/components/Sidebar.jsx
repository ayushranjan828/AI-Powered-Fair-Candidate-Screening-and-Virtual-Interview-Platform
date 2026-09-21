import { TABS } from "../lib/constants.js";

/**
 * Workflow rail. The AI pill doubles as the "test the Azure OpenAI connection"
 * button, which is how the old UI surfaced /api/ai-check.
 */
export default function Sidebar({ tab, onTab, ai, onCheckAi, completed }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          🎯
        </span>
        <div className="brand-text">
          <h1>Fair Candidate Screening</h1>
          <p>AI screening · human verified</p>
        </div>
      </div>

      <nav className="tabs" aria-label="Workflow steps">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab ${tab === t.id ? "active" : ""} ${
              completed?.[t.id] && tab !== t.id ? "done" : ""
            }`}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => onTab(t.id)}
          >
            <span className="step-n">{t.n}</span>
            <span className="step-t">
              {t.label}
              <small>{t.hint}</small>
            </span>
          </button>
        ))}
      </nav>

      <div className="side-foot">
        <button
          type="button"
          className={`pill pill-btn ${ai.kind}`}
          onClick={onCheckAi}
          title="Click to test the Azure OpenAI connection"
        >
          {ai.label}
        </button>
      </div>
    </aside>
  );
}
