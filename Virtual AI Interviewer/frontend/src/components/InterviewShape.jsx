import CategoryChecklist, { allCategories } from "./CategoryChecklist.jsx";
import VoiceSelect from "./VoiceSelect.jsx";
import WeightsTable from "./WeightsTable.jsx";
import { DEFAULT_VOICE_RATE, FORCED_CATEGORIES } from "../lib/constants.js";

/**
 * What an interview will actually look like: how many questions, how deep the
 * follow-ups go, which categories get probed, the voice, and the evaluation
 * weights.
 *
 * The same control set appears in three places — the dashboard defaults, the
 * off-shortlist card, and one named candidate's own settings — so they share
 * this component rather than three near-identical blocks of markup.
 */
export default function InterviewShape({
  cfg,
  options,
  onChange,
  voices,
  preferred,
  showWeights = true,
  tightWeights = false,
  showVoice = true,
  capNote = true,
}) {
  const set = (patch) => onChange({ ...options, ...patch });

  const chosen = new Set(options.categories || allCategories(cfg.categories));

  const toggleCategory = (key, on) => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    // Intro and closing are never optional, whatever the checkbox says.
    FORCED_CATEGORIES.forEach((k) => {
      if (cfg.categories?.[k]) next.add(k);
    });
    set({ categories: [...next] });
  };

  return (
    <>
      <div className="settings-row">
        <label className="field field-inline">
          <span>Planned questions</span>
          <input
            type="range"
            min="4"
            max="20"
            step="1"
            value={options.planned_count}
            style={{ "--_fill": `${((options.planned_count - 4) / 16) * 100}%` }}
            onChange={(e) => set({ planned_count: Number(e.target.value) })}
          />
        </label>
        <output className="settings-out">{options.planned_count}</output>

        <label className="field field-inline">
          <span>Follow-ups each</span>
          <input
            type="range"
            min="0"
            max="4"
            step="1"
            value={options.max_followups}
            style={{ "--_fill": `${(options.max_followups / 4) * 100}%` }}
            onChange={(e) => set({ max_followups: Number(e.target.value) })}
          />
        </label>
        <output className="settings-out">{options.max_followups}</output>
      </div>

      {capNote && (
        <p className="hint">
          Follow-ups are generated live from what the candidate actually says, so the real number
          of questions is higher than the planned count. The whole interview is capped at{" "}
          <strong>{cfg.max_total_turns ?? 30}</strong> turns.
        </p>
      )}

      <h3 className="mini-head">Question categories</h3>
      <CategoryChecklist
        categories={cfg.categories}
        chosen={chosen}
        onToggle={toggleCategory}
      />
      <p className="hint">
        Introduction and closing are always included. Narrowing the mix means fewer evaluation
        parameters get evidence — those are reported as <em>not tested</em> rather than scored low.
      </p>

      {showVoice && (
        <>
          <h3 className="mini-head">Voice</h3>
          <div className="settings-row">
            <label className="check">
              <input
                type="checkbox"
                checked={options.voice !== false}
                onChange={(e) => set({ voice: e.target.checked })}
              />
              Interviewer speaks out loud
            </label>

            <label className="field field-inline">
              <span>Voice</span>
              <VoiceSelect
                voices={voices}
                preferred={preferred}
                value={options.voice_name}
                onChange={(voice_name) => set({ voice_name })}
              />
            </label>

            <label className="field field-inline">
              <span>Speaking rate</span>
              <input
                type="range"
                min="0.7"
                max="1.3"
                step="0.02"
                value={options.voice_rate ?? DEFAULT_VOICE_RATE}
                onChange={(e) => set({ voice_rate: Number(e.target.value) })}
              />
            </label>
            <output className="settings-out">
              {Number(options.voice_rate ?? DEFAULT_VOICE_RATE).toFixed(2)}×
            </output>
          </div>
        </>
      )}

      {showWeights && (
        <>
          <h3 className="mini-head">Evaluation weights</h3>
          <WeightsTable
            parameters={cfg.parameters}
            weights={options.weights || {}}
            tight={tightWeights}
            onChange={(key, value) =>
              set({ weights: { ...(options.weights || {}), [key]: value } })
            }
          />
          <p className="hint">
            Anything that does not add to 100 is scaled to 100 when the interview is prepared, so
            the ratios you type are what matter.
          </p>
        </>
      )}
    </>
  );
}

/** The configured defaults, as an options object. */
export function defaultOptions(cfg) {
  return {
    planned_count: cfg.default_planned_count ?? 10,
    max_followups: cfg.default_max_followups ?? 2,
    categories: allCategories(cfg.categories),
    voice: true,
    voice_name: "",
    voice_rate: DEFAULT_VOICE_RATE,
    weights: { ...(cfg.default_weights || {}) },
  };
}
