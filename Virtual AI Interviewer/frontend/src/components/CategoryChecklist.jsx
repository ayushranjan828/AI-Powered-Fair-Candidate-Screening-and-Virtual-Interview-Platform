import { FORCED_CATEGORIES } from "../lib/constants.js";

/**
 * Which kinds of question this interview will probe.
 *
 * Introduction and closing are ticked and disabled: every interview opens and
 * closes, so they are shown rather than hidden, to say what will be asked.
 */
export default function CategoryChecklist({ categories, chosen, onToggle }) {
  return (
    <div className="checklist">
      {Object.entries(categories || {}).map(([key, meta]) => {
        const forced = FORCED_CATEGORIES.has(key);
        const on = forced || !chosen || chosen.has(key);
        return (
          <label key={key} className={`check-item${forced ? " locked" : ""}`}>
            <input
              type="checkbox"
              checked={on}
              disabled={forced}
              onChange={(e) => onToggle(key, e.target.checked)}
            />
            <span className="check-text">
              <span className="check-label">
                {meta.label}
                {forced && <span className="check-note"> always</span>}
              </span>
              <span className="check-about">{meta.about}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Every category key, which is what "all of them" means on the wire. */
export const allCategories = (categories) => Object.keys(categories || {});
