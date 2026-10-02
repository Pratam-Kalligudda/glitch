// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BreachTerminal, MAX_SKILLS } from "../../app/components/BreachTerminal";
import type { RouteSummary } from "../../content/view";

afterEach(cleanup);

const route = (n: number, stops: number): RouteSummary => ({
  slug: `route-${n}`,
  title: `Route ${n}`,
  number: n,
  summary: "",
  partCount: 1,
  stops: Array.from({ length: stops }, (_, i) => ({ id: `s${i}`, title: `Stop ${i}` })),
  prerequisites: [],
});

const text = (routes: RouteSummary[]) => render(<BreachTerminal routes={routes} />).container.textContent ?? "";

describe("BreachTerminal", () => {
  it("injects each route with its stop count and ends on the first route", () => {
    const out = text([route(1, 7), route(2, 8)]);
    expect(out).toMatch(/route-1\s+7 stops/);
    expect(out).toMatch(/route-2\s+8 stops/);
    expect(out).toContain("2 skills · 15 stops ready");
    expect(out).toMatch(/start route-1\s*$/);
    expect(out).not.toContain("more");
  });

  it(`lists at most ${MAX_SKILLS} routes and counts the rest`, () => {
    const routes = Array.from({ length: 10 }, (_, i) => route(i + 1, 2));
    const out = text(routes);
    expect(out).toContain("route-3");
    expect(out).not.toContain("route-4");
    expect(out).toContain("+ 7 more");
    expect(out).toContain("10 skills · 20 stops ready");
  });

  it("uses singular words for one route with one stop", () => {
    expect(text([route(1, 1)])).toContain("1 skill · 1 stop ready");
  });

  it("is hidden from screen readers, since the route list below says the same", () => {
    const { container } = render(<BreachTerminal routes={[route(1, 2)]} />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});
