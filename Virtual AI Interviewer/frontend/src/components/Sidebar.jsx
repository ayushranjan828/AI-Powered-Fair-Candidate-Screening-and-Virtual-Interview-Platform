import { useEffect, useRef } from "react";

import { TABS } from "../lib/constants.js";

export default function Sidebar({ tab, onTab, ai, onCheckAi }) {
  const activeRef = useRef(null);

  // Below 1040px the rail lies on its side and scrolls horizontally, so a tab
  // switched by code (a deep link, or finishing an interview) can land off
  // screen with the previous tab still the only one visible.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [tab]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          🎙️
        </span>
        <div className="brand-text">
          <h1>Virtual AI Interviewer</h1>
          <p>Live follow-ups · fair scoring</p>
        </div>
      </div>

      <nav className="tabs" aria-label="Workflow steps">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            ref={tab === t.id ? activeRef : undefined}
            className={`tab ${tab === t.id ? "active" : ""}`}
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
