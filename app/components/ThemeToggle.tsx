import { useEffect, useState } from "react";
import { THEME_ORDER, applyTheme, readPref, savePref, systemQuery, type ThemePref } from "../theme";

const LABELS: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" };
const ICONS: Record<ThemePref, string> = { system: "◐", light: "☀", dark: "☾" };

/** One button that cycles System → Light → Dark. The head script applies it before paint. */
export function ThemeToggle() {
  // null until the saved choice is read, so server HTML and the first client render match
  // and nothing overrides the theme the head script already applied.
  const [pref, setPref] = useState<ThemePref | null>(null);
  const shown = pref ?? "system";

  useEffect(() => setPref(readPref()), []);

  useEffect(() => {
    if (pref === null) return;
    applyTheme(pref);
    if (pref !== "system") return;
    const query = systemQuery();
    const follow = () => applyTheme("system");
    query?.addEventListener("change", follow);
    return () => query?.removeEventListener("change", follow);
  }, [pref]);

  function next() {
    const value = THEME_ORDER[(THEME_ORDER.indexOf(shown) + 1) % THEME_ORDER.length];
    savePref(value);
    setPref(value);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={next}
      aria-label={`Theme: ${LABELS[shown]}. Change theme`}
      title={`Theme: ${LABELS[shown]}`}
    >
      <span aria-hidden="true">{ICONS[shown]}</span>
      <span className="theme-toggle-label" aria-hidden="true">
        {LABELS[shown]}
      </span>
    </button>
  );
}
