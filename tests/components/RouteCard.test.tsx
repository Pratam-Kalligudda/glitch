// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { RouteCard } from "../../app/components/RouteCard";
import type { RouteSummary } from "../../content/view";

afterEach(cleanup);

const route: RouteSummary = {
  slug: "git-basics",
  title: "Git basics",
  number: 1,
  summary: "Track changes.",
  partCount: 3,
  stops: [
    { id: "init", title: "Create a repository", part: "local" },
    { id: "commit", title: "Stage and commit", part: "local" },
    { id: "history", title: "Read history", part: "local" },
  ],
  prerequisites: [],
};

const show = (done?: string[]) =>
  render(
    <MemoryRouter>
      <RouteCard route={route} done={done} />
    </MemoryRouter>,
  );

describe("RouteCard", () => {
  it("shows the label, title, summary and counts", () => {
    show();
    expect(screen.getByText("Route 1")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Git basics" })).toBeTruthy();
    expect(screen.getByText("Track changes.")).toBeTruthy();
    expect(screen.getByText("0 of 3 stops · 3 parts")).toBeTruthy();
  });

  it("links to the route with an action that matches progress", () => {
    show();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/git-basics");
    expect(screen.getByRole("link").textContent).toContain("Start");
    cleanup();
    show(["init"]);
    expect(screen.getByRole("link").textContent).toContain("Resume");
    cleanup();
    show(["init", "commit", "history"]);
    expect(screen.getByRole("link").textContent).toContain("Review");
  });

  it("fills the path dot of each done stop, not the first ones", () => {
    const { container } = show(["history"]);
    const states = [...container.querySelectorAll(".path-dot")].map((d) =>
      d.classList.contains("path-dot-done"),
    );
    expect(states).toEqual([false, false, true]);
  });

  it("ignores done ids that are not in the route", () => {
    show(["init", "gone"]);
    expect(screen.getByText("1 of 3 stops · 3 parts")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  });
});
