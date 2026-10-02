// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import Home from "../../app/routes/home";
import type { RouteSummary } from "../../content/view";

afterEach(cleanup);

const summary = (over: Partial<RouteSummary>): RouteSummary => ({
  slug: "a",
  title: "Route A",
  number: 1,
  summary: "About A.",
  partCount: 1,
  stops: [{ id: "s", title: "S" }],
  prerequisites: [],
  ...over,
});

function show(routes: RouteSummary[]) {
  const props = { loaderData: { routes } } as unknown as Parameters<typeof Home>[0];
  return render(
    <MemoryRouter>
      <Home {...props} />
    </MemoryRouter>,
  );
}

describe("Home", () => {
  it("shows an empty state and no start section when there are no routes", () => {
    show([]);
    expect(screen.getByText(/No routes yet/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Where to start" })).toBeNull();
    expect(screen.queryByText(/Start route/)).toBeNull();
  });

  it("shows a card per route and a start action for the first", () => {
    show([summary({}), summary({ slug: "b", title: "Route B", number: 2 })]);
    expect(screen.getByRole("heading", { name: "Route A" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Route B" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start route 1" }).getAttribute("href")).toBe("/a");
  });

  it("explains reading order from prerequisites", () => {
    show([
      summary({}),
      summary({ slug: "b", title: "Route B", number: 2 }),
      summary({
        slug: "c",
        title: "Route C",
        number: 3,
        prerequisites: [
          { slug: "a", title: "Route A" },
          { slug: "b", title: "Route B" },
        ],
      }),
    ]);
    const list = screen.getByRole("list", { name: "Reading order" });
    const steps = within(list).getAllByRole("link");
    expect(steps.map((s) => s.getAttribute("href"))).toEqual(["/a", "/b", "/c"]);
    expect(steps[0].textContent).toContain("Step 01");
    expect(steps[0].textContent).toContain("No earlier route");
    expect(steps[2].textContent).toContain("Step 03");
    expect(steps[2].textContent).toContain("After Route A and Route B");
  });

  it("hides the continue tile when there is no saved progress", () => {
    show([summary({})]);
    expect(screen.queryByText("Continue")).toBeNull();
  });
});
