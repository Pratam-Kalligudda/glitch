import { describe, expect, it } from "vitest";
import { loadSite } from "../../content/loader";
import { toSummary, toView } from "../../content/view";
import { FIXTURES, makePart, makeRoute, makeStop } from "../helpers";

describe("toSummary", () => {
  it("lists stops in order and counts parts", () => {
    const { routes } = loadSite(FIXTURES);
    const summary = toSummary(routes[0], routes);
    expect(summary.slug).toBe("sample");
    expect(summary.partCount).toBe(2);
    expect(summary.stops).toEqual([
      { id: "first-stop", title: "First stop" },
      { id: "second-stop", title: "Second stop" },
      { id: "spec", title: "The spec" },
      { id: "step-1", title: "Step 1: greet" },
    ]);
    expect(summary.prerequisites).toEqual([]);
  });

  it("resolves prerequisite titles", () => {
    const a = makeRoute("a", [makePart("p", [makeStop("s")])], { title: "Route A" });
    const b = makeRoute("b", [makePart("p", [makeStop("s")])], { number: 2, prerequisites: ["a"] });
    expect(toSummary(b, [a, b]).prerequisites).toEqual([{ slug: "a", title: "Route A" }]);
  });
});

describe("toView", () => {
  it("renders the fixture with part numbers, references and assets", async () => {
    const { routes } = loadSite(FIXTURES);
    const view = await toView(routes[0], routes, "/sub/");
    expect(view.checked).toBe("2026-10");
    expect(view.parts.map((p) => p.number)).toEqual([1, null]);
    const [first, second] = view.parts[0].stops;
    expect(first.html).toContain('<figure class="code">');
    expect(first.doneWhenHtml).toBeNull();
    expect(second.html).toContain('href="#first-stop"');
    expect(second.html).toContain('src="/sub/route-assets/sample/flow.svg"');
    const step = view.parts[1].stops[1];
    expect(step.isStep).toBe(true);
    expect(step.doneWhenHtml?.trim()).toBe("<p>The page shows the greeting.</p>");
  });

  it("links cross-route references through the base path", async () => {
    const other = makeRoute("other", [makePart("p", [makeStop("intro", { title: "Intro" })])], { number: 2 });
    const route = makeRoute("x", [makePart("a", [makeStop("b", { body: "See [[other/intro]].\n" })])]);
    const view = await toView(route, [route, other], "/sub/");
    expect(view.parts[0].stops[0].html).toContain('href="/sub/other/#intro"');
  });

  it("renders an empty intro as an empty string", async () => {
    const route = makeRoute("x", [makePart("a", [makeStop("b")], { intro: "\n" })]);
    expect((await toView(route, [route], "/")).parts[0].introHtml).toBe("");
  });
});
