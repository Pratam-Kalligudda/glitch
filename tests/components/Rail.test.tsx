// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rail } from "../../app/components/Rail";
import type { PartOutline } from "../../content/view";

afterEach(cleanup);

const part = (id: string, title: string, ids: string[], number: number | null = 1): PartOutline => ({
  id,
  title,
  goal: "",
  kind: number === null ? "capstone" : "part",
  number,
  stops: ids.map((s) => ({ id: s, title: `Title ${s}` })),
});

const parts = [
  part("local", "Work locally", ["init", "commit"], 1),
  part("share", "Branch and share", ["branch"], 2),
  part("project", "Capstone", ["spec"], null),
];

type Props = Partial<Parameters<typeof Rail>[0]>;
function show(props: Props = {}) {
  return render(
    <MemoryRouter>
      <Rail slug="git" parts={parts} current="local" doneIds={new Set()} nextId={null} {...props} />
    </MemoryRouter>,
  );
}

const link = (name: RegExp) => screen.getByRole("link", { name });

describe("Rail", () => {
  it("links each part to its page, stops on this page by anchor and others by page", () => {
    show();
    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
      "/git/local",
      "#init",
      "#commit",
      "/git/share",
      "/git/share#branch",
      "/git/project",
      "/git/project#spec",
    ]);
    expect(link(/Title init/).textContent).toBe("Title init");
  });

  it("numbers parts, marks the capstone, and shows done counts", () => {
    show({ doneIds: new Set(["init", "gone"]) });
    expect(link(/Work locally/).textContent).toBe("1Work locally1/2");
    expect(link(/Branch and share/).textContent).toBe("2Branch and share0/1");
    expect(link(/Capstone/).closest("li")?.className).toContain("is-capstone");
  });

  it("marks done stops for sight and for screen readers", () => {
    show({ doneIds: new Set(["init"]) });
    const done = link(/Title init/);
    expect(done.className).toContain("is-done");
    expect(done.querySelector(".sr-only")?.textContent?.trim()).toBe("(done)");
    expect(link(/Title commit/).className).not.toContain("is-done");
  });

  it("marks the next stop, and only that one", () => {
    show({ doneIds: new Set(["init"]), nextId: "commit" });
    const next = link(/Title commit/);
    expect(next.className).toContain("is-next");
    expect(next.querySelector(".rail-next")?.textContent).toBe("next");
    expect(document.querySelectorAll(".is-next")).toHaveLength(1);
  });

  it("marks the part whose page this is", () => {
    show({ current: "share" });
    expect(link(/Work locally/).getAttribute("aria-current")).toBeNull();
    const current = link(/Branch and share/);
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.className).toContain("is-active");
  });

  it("calls onNavigate when a part or a stop is chosen", () => {
    const onNavigate = vi.fn();
    show({ onNavigate });
    fireEvent.click(link(/Work locally/));
    fireEvent.click(link(/Title commit/));
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });
});
