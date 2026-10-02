import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkContent } from "../../content/index";
import { formatProblem } from "../../content/model";
import { toSummary, toView } from "../../content/view";

/** Guards the real content: adding or editing a route must keep every route valid. */
const { routes, problems } = checkContent(path.resolve("routes"));

describe("routes folder", () => {
  it("has no content problems", () => {
    expect(problems.map(formatProblem)).toEqual([]);
  });

  it("lists routes in number order", () => {
    const numbers = routes.map((r) => r.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  // Skipped while routes/ is empty; each route gets its own test once it exists.
  it.skipIf(routes.length === 0).each(routes.map((r) => [r.slug, r] as const))(
    "%s renders with every reference and asset resolved",
    async (_slug, route) => {
      const view = await toView(route, routes, "/base/");
      const html = view.parts.flatMap((p) => [p.introHtml, ...p.stops.map((s) => s.html)]).join("");
      expect(html).not.toMatch(/\[\[[a-z0-9/-]+\]\]/);
      for (const asset of route.assets) {
        if (html.includes(asset)) expect(html).toContain(`/base/route-assets/${route.slug}/${asset}`);
      }
      const summary = toSummary(route, routes);
      expect(summary.stops.length).toBeGreaterThan(0);
    },
  );
});
