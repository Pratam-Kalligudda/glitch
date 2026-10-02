import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export const STORAGE_KEY = "roadmap:progress:v1";

interface ProgressData {
  /** Done stop ids per route slug. */
  done: Record<string, string[]>;
  /** Slug of the route the reader opened or changed most recently. */
  lastRoute: string | null;
}

interface ProgressState extends ProgressData {
  toggle: (slug: string, stopId: string) => void;
  visit: (slug: string) => void;
}

/** localStorage that never throws: missing, blocked, full or corrupt all read as empty. */
const safeStorage: StateStorage = {
  getItem(name) {
    try {
      const value = localStorage.getItem(name);
      if (value !== null) JSON.parse(value);
      return value;
    } catch {
      return null;
    }
  },
  setItem(name, value) {
    try {
      localStorage.setItem(name, value);
    } catch {
      // Progress simply does not persist.
    }
  },
  removeItem(name) {
    try {
      localStorage.removeItem(name);
    } catch {
      // Nothing to do.
    }
  },
};

/** Keeps only correctly shaped data from whatever was stored. */
function clean(persisted: unknown): ProgressData {
  const p = (persisted && typeof persisted === "object" ? persisted : {}) as Record<string, unknown>;
  const done: Record<string, string[]> = {};
  if (p.done && typeof p.done === "object" && !Array.isArray(p.done)) {
    for (const [slug, ids] of Object.entries(p.done)) {
      if (Array.isArray(ids)) done[slug] = ids.filter((id): id is string => typeof id === "string");
    }
  }
  return { done, lastRoute: typeof p.lastRoute === "string" ? p.lastRoute : null };
}

export const useProgress = create<ProgressState>()(
  persist(
    (set) => ({
      done: {},
      lastRoute: null,
      toggle: (slug, stopId) =>
        set((state) => {
          const current = state.done[slug] ?? [];
          const next = current.includes(stopId)
            ? current.filter((id) => id !== stopId)
            : [...current, stopId];
          return { done: { ...state.done, [slug]: next }, lastRoute: slug };
        }),
      visit: (slug) => set({ lastRoute: slug }),
    }),
    {
      name: STORAGE_KEY,
      version: 0,
      storage: createJSONStorage(() => safeStorage),
      skipHydration: true,
      partialize: (state) => ({ done: state.done, lastRoute: state.lastRoute }),
      merge: (persisted, current) => ({ ...current, ...clean(persisted) }),
    },
  ),
);

/** Runs `fn` once saved progress has been loaded. Returns a cancel function. */
export function whenHydrated(fn: () => void): () => void {
  if (useProgress.persist.hasHydrated()) {
    fn();
    return () => {};
  }
  let cancelled = false;
  const stop = useProgress.persist.onFinishHydration(() => {
    stop();
    if (!cancelled) fn();
  });
  return () => {
    cancelled = true;
    stop();
  };
}

export function countDone(done: string[] | undefined, stopIds: string[]): number {
  if (!done) return 0;
  const set = new Set(done);
  return stopIds.filter((id) => set.has(id)).length;
}

export function nextStop<T extends { id: string }>(done: string[] | undefined, stops: T[]): T | null {
  const set = new Set(done ?? []);
  return stops.find((stop) => !set.has(stop.id)) ?? null;
}
