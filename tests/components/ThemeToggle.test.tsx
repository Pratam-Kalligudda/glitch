// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "../../app/components/ThemeToggle";
import { THEME_KEY, THEME_SCRIPT, resolveTheme } from "../../app/theme";

/** A controllable stand-in for matchMedia("(prefers-color-scheme: dark)"). */
function mockSystem(dark: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
  };
  window.matchMedia = vi.fn(() => query) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      query.matches = next;
      for (const fn of listeners) fn({ matches: next });
    },
  };
}

const theme = () => document.documentElement.dataset.theme;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(cleanup);

describe("resolveTheme", () => {
  it("uses the explicit choice, or the system setting for system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("head script", () => {
  const run = () => new Function(THEME_SCRIPT)();

  it("applies the saved choice before the app loads", () => {
    mockSystem(false);
    localStorage.setItem(THEME_KEY, "dark");
    run();
    expect(theme()).toBe("dark");
  });

  it("follows the system when nothing valid is saved", () => {
    mockSystem(true);
    localStorage.setItem(THEME_KEY, "purple");
    run();
    expect(theme()).toBe("dark");
  });

  it("falls back to light when storage throws", () => {
    mockSystem(false);
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    run();
    expect(theme()).toBe("light");
    spy.mockRestore();
  });
});

describe("ThemeToggle", () => {
  it("cycles system, light, dark and saves each choice", () => {
    mockSystem(false);
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: /Theme: System/ });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: /Theme: Light/ })).toBeTruthy();
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    expect(theme()).toBe("light");
    fireEvent.click(button);
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(theme()).toBe("dark");
    fireEvent.click(button);
    expect(localStorage.getItem(THEME_KEY)).toBe("system");
    expect(screen.getByRole("button", { name: /Theme: System/ })).toBeTruthy();
  });

  it("shows the saved choice after mounting", () => {
    mockSystem(false);
    localStorage.setItem(THEME_KEY, "dark");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: /Theme: Dark/ })).toBeTruthy();
  });

  it("never flips away from the head script's theme while mounting", () => {
    mockSystem(false);
    localStorage.setItem(THEME_KEY, "dark");
    document.documentElement.dataset.theme = "dark";
    const observer = new MutationObserver(() => {});
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
      attributeOldValue: true,
    });
    render(<ThemeToggle />);
    // Every value the attribute held during mount: each change's old value, then the final one.
    const held = [...observer.takeRecords().map((r) => r.oldValue), theme()];
    observer.disconnect();
    expect(held.every((value) => value === "dark")).toBe(true);
  });

  it("follows system changes only while set to system", () => {
    const system = mockSystem(false);
    render(<ThemeToggle />);
    act(() => system.set(true));
    expect(theme()).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: /Theme: System/ }));
    act(() => system.set(true));
    expect(theme()).toBe("light");
  });
});
