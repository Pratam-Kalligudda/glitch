// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rail } from "../../app/components/Rail";
import type { PartView, StopView } from "../../content/view";

afterEach(cleanup);

const stop = (id: string): StopView => ({ id, title: id, html: "", doneWhenHtml: null, isStep: false });
const part = (id: string, title: string, ids: string[]): PartView => ({
  id,
  title,
  goal: "",
  kind: "part",
  number: 1,
  introHtml: "",
  stops: ids.map(stop),
});

const parts = [part("local", "Work locally", ["init", "commit"]), part("share", "Branch and share", ["branch"])];

describe("Rail", () => {
  it("lists parts with done counts and links to each part", () => {
    render(<Rail parts={parts} doneIds={new Set(["init", "gone"])} active={null} />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["#part-local", "#part-share"]);
    expect(links[0].textContent).toBe("Work locally1/2");
    expect(links[1].textContent).toBe("Branch and share0/1");
  });

  it("marks the active part", () => {
    render(<Rail parts={parts} doneIds={new Set()} active="share" />);
    const [first, second] = screen.getAllByRole("link");
    expect(first.getAttribute("aria-current")).toBeNull();
    expect(second.getAttribute("aria-current")).toBe("true");
    expect(second.className).toContain("is-active");
  });

  it("calls onNavigate when a part is chosen", () => {
    const onNavigate = vi.fn();
    render(<Rail parts={parts} doneIds={new Set()} active={null} onNavigate={onNavigate} />);
    fireEvent.click(screen.getAllByRole("link")[0]);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
