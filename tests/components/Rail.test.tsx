// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rail } from "../../app/components/Rail";
import type { PartView, StopView } from "../../content/view";

afterEach(cleanup);

const stop = (id: string): StopView => ({ id, title: `Title ${id}`, html: "", doneWhenHtml: null, isStep: false });
const part = (id: string, title: string, ids: string[], number: number | null = 1): PartView => ({
  id,
  title,
  goal: "",
  kind: number === null ? "capstone" : "part",
  number,
  introHtml: "",
  stops: ids.map(stop),
});

const parts = [
  part("local", "Work locally", ["init", "commit"], 1),
  part("share", "Branch and share", ["branch"], 2),
  part("project", "Capstone", ["spec"], null),
];

const partLink = (name: RegExp) => screen.getByRole("link", { name });

describe("Rail", () => {
  it("lists every part, then each part's stops, in reading order", () => {
    render(<Rail parts={parts} doneIds={new Set()} active={null} />);
    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
      "#part-local",
      "#init",
      "#commit",
      "#part-share",
      "#branch",
      "#part-project",
      "#spec",
    ]);
    expect(partLink(/Title init/).textContent).toBe("Title init");
  });

  it("numbers parts, marks the capstone, and shows done counts", () => {
    render(<Rail parts={parts} doneIds={new Set(["init", "gone"])} active={null} />);
    expect(partLink(/Work locally/).textContent).toBe("1Work locally1/2");
    expect(partLink(/Branch and share/).textContent).toBe("2Branch and share0/1");
    expect(partLink(/Capstone/).closest("li")?.className).toContain("is-capstone");
  });

  it("marks done stops for sight and for screen readers", () => {
    render(<Rail parts={parts} doneIds={new Set(["init"])} active={null} />);
    const done = partLink(/Title init/);
    const open = partLink(/Title commit/);
    expect(done.className).toContain("is-done");
    expect(done.querySelector(".sr-only")?.textContent?.trim()).toBe("(done)");
    expect(open.className).not.toContain("is-done");
    expect(open.querySelector(".sr-only")).toBeNull();
  });

  it("marks the next stop, and only that one", () => {
    render(<Rail parts={parts} doneIds={new Set(["init"])} active={null} nextId="commit" />);
    const next = partLink(/Title commit/);
    expect(next.className).toContain("is-next");
    expect(next.querySelector(".rail-next")?.textContent).toBe("next");
    expect(document.querySelectorAll(".is-next")).toHaveLength(1);
  });

  it("marks no stop as next when every stop is done", () => {
    render(<Rail parts={parts} doneIds={new Set()} active={null} nextId={null} />);
    expect(document.querySelectorAll(".is-next")).toHaveLength(0);
  });

  it("marks the active part", () => {
    render(<Rail parts={parts} doneIds={new Set()} active="share" />);
    expect(partLink(/Work locally/).getAttribute("aria-current")).toBeNull();
    const current = partLink(/Branch and share/);
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.className).toContain("is-active");
  });

  it("calls onNavigate when a part or a stop is chosen", () => {
    const onNavigate = vi.fn();
    render(<Rail parts={parts} doneIds={new Set()} active={null} onNavigate={onNavigate} />);
    fireEvent.click(partLink(/Work locally/));
    fireEvent.click(partLink(/Title commit/));
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });
});
