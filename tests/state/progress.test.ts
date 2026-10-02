// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "roadmap:progress:v1";

/** A fresh, not-yet-hydrated copy of the store module. */
async function fresh() {
  vi.resetModules();
  return await import("../../app/state/progress");
}

const stored = (state: unknown) => JSON.stringify({ state, version: 0 });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("progress store", () => {
  it("marks and unmarks a stop and records the last route", async () => {
    const { useProgress } = await fresh();
    await useProgress.persist.rehydrate();
    useProgress.getState().toggle("a", "s1");
    expect(useProgress.getState().done).toEqual({ a: ["s1"] });
    expect(useProgress.getState().lastRoute).toBe("a");
    useProgress.getState().toggle("a", "s1");
    expect(useProgress.getState().done).toEqual({ a: [] });
  });

  it("persists under the versioned key and restores on rehydrate", async () => {
    const first = await fresh();
    await first.useProgress.persist.rehydrate();
    first.useProgress.getState().toggle("a", "s1");
    expect(JSON.parse(localStorage.getItem(KEY)!).state.done).toEqual({ a: ["s1"] });

    const second = await fresh();
    expect(second.useProgress.getState().done).toEqual({});
    await second.useProgress.persist.rehydrate();
    expect(second.useProgress.getState().done).toEqual({ a: ["s1"] });
    expect(second.useProgress.getState().lastRoute).toBe("a");
  });

  it("survives corrupt JSON in storage", async () => {
    localStorage.setItem(KEY, "{not json");
    const { useProgress } = await fresh();
    await useProgress.persist.rehydrate();
    expect(useProgress.getState().done).toEqual({});
    useProgress.getState().toggle("a", "s1");
    expect(useProgress.getState().done).toEqual({ a: ["s1"] });
  });

  it("discards wrongly shaped stored data", async () => {
    localStorage.setItem(KEY, stored({ done: { a: "oops", b: ["s1", 7] }, lastRoute: 5 }));
    const { useProgress } = await fresh();
    await useProgress.persist.rehydrate();
    expect(useProgress.getState().done).toEqual({ b: ["s1"] });
    expect(useProgress.getState().lastRoute).toBeNull();

    localStorage.setItem(KEY, stored({ done: ["x"], lastRoute: "a" }));
    const again = await fresh();
    await again.useProgress.persist.rehydrate();
    expect(again.useProgress.getState().done).toEqual({});
    expect(again.useProgress.getState().lastRoute).toBe("a");
  });

  it("does not wipe saved progress when a change is requested before rehydration", async () => {
    localStorage.setItem(KEY, stored({ done: { a: ["s1"] }, lastRoute: "a" }));
    const { useProgress, whenHydrated } = await fresh();
    whenHydrated(() => useProgress.getState().visit("b"));
    expect(JSON.parse(localStorage.getItem(KEY)!).state.done).toEqual({ a: ["s1"] });

    await useProgress.persist.rehydrate();
    expect(useProgress.getState().done).toEqual({ a: ["s1"] });
    expect(useProgress.getState().lastRoute).toBe("b");
    expect(JSON.parse(localStorage.getItem(KEY)!).state.done).toEqual({ a: ["s1"] });
  });

  it("runs whenHydrated immediately once hydrated, and can be cancelled before", async () => {
    const { useProgress, whenHydrated } = await fresh();
    const early = vi.fn();
    const cancel = whenHydrated(early);
    cancel();
    await useProgress.persist.rehydrate();
    expect(early).not.toHaveBeenCalled();

    const late = vi.fn();
    whenHydrated(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("keeps working when storage refuses writes", async () => {
    const { useProgress } = await fresh();
    await useProgress.persist.rehydrate();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => useProgress.getState().toggle("a", "s1")).not.toThrow();
    expect(useProgress.getState().done).toEqual({ a: ["s1"] });
  });
});

describe("helpers", () => {
  it("countDone ignores ids that no longer exist", async () => {
    const { countDone } = await fresh();
    expect(countDone(["s1", "gone", "s3"], ["s1", "s2", "s3"])).toBe(2);
    expect(countDone(undefined, ["s1"])).toBe(0);
  });

  it("nextStop returns the first stop not done, or null", async () => {
    const { nextStop } = await fresh();
    const stops = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
    expect(nextStop(["s1", "s3"], stops)).toEqual({ id: "s2" });
    expect(nextStop(undefined, stops)).toEqual({ id: "s1" });
    expect(nextStop(["s1", "s2", "s3"], stops)).toBeNull();
  });
});
