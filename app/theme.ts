export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_KEY = "glitch:theme";
export const THEME_ORDER: ThemePref[] = ["system", "light", "dark"];
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

export function readPref(): ThemePref {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function savePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // The choice simply does not persist.
  }
}

export function systemQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
}

export function applyTheme(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolveTheme(pref, systemQuery()?.matches ?? false);
}

/**
 * Inlined in <head> so the saved theme is applied before first paint; the same rules as
 * readPref and applyTheme, written without imports.
 */
export const THEME_SCRIPT = `(function(){var p="system";try{var v=localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)});if(v==="light"||v==="dark")p=v;}catch(e){}var d=p==="dark"||(p==="system"&&typeof matchMedia==="function"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);document.documentElement.dataset.theme=d?"dark":"light";})();`;
