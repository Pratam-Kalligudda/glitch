import { describe, expect, it } from "vitest";
import { loadSite } from "../../content/loader";
import { stopPath, toOutline, toPartPage, toSummary } from "../../content/view";
import { FIXTURES, makePart, makeRoute, makeStop } from "../helpers";

describe("toSummary", () => {
  it("lists stops in order, with the part each one is on, and counts parts", () => {
    const { routes } = loadSite(FIXTURES);
    const summary = toSummary(routes[0], routes);
    expect(summary.slug).toBe("sample");
    expect(summary.partCount).toBe(2);
    expect(summary.stops).toEqual([
      { id: "first-stop", title: "First stop", part: "basics" },
      { id: "second-stop", title: "Second stop", part: "basics" },
      { id: "spec", title: "The spec", part: "capstone" },
      { id: "step-1", title: "Step 1: greet", part: "capstone" },
    ]);
    expect(summary.prerequisites).toEqual([]);
  });

  it("resolves prerequisite titles", () => {
    const a = makeRoute("a", [makePart("p", [makeStop("s")])], { title: "Route A" });
    const b = makeRoute("b", [makePart("p", [makeStop("s")])], { number: 2, prerequisites: ["a"] });
    expect(toSummary(b, [a, b]).prerequisites).toEqual([{ slug: "a", title: "Route A" }]);
  });
});

describe("toOutline", () => {
  it("lists every part and its stops without rendering any content", () => {
    const { routes } = loadSite(FIXTURES);
    const outline = toOutline(routes[0]);
    expect(outline.checked).toBe("2026-10");
    expect(outline.parts.map((p) => [p.id, p.number, p.kind])).toEqual([
      ["basics", 1, "part"],
      ["capstone", null, "capstone"],
    ]);
    expect(outline.parts[0].stops).toEqual([
      { id: "first-stop", title: "First stop" },
      { id: "second-stop", title: "Second stop" },
    ]);
    expect(JSON.stringify(outline)).not.toContain("<");
  });
});

describe("toPartPage", () => {
  it("renders one part, with the outline and its neighbours", async () => {
    const { routes } = loadSite(FIXTURES);
    const page = await toPartPage(routes[0], routes, "/sub/", "basics");
    expect(page?.part.id).toBe("basics");
    expect(page?.prev).toBeNull();
    expect(page?.next).toEqual({ id: "capstone", title: "Capstone" });
    const [first, second] = page!.part.stops;
    expect(first.html).toContain('<figure class="code">');
    expect(first.doneWhenHtml).toBeNull();
    expect(second.html).toContain('src="/sub/route-assets/sample/flow.svg"');
    expect(page?.outline.parts).toHaveLength(2);
  });

  it("renders the capstone with steps and their finish lines", async () => {
    const { routes } = loadSite(FIXTURES);
    const page = await toPartPage(routes[0], routes, "/sub/", "capstone");
    expect(page?.prev).toEqual({ id: "basics", title: "Basics" });
    expect(page?.next).toBeNull();
    const step = page!.part.stops[1];
    expect(step.isStep).toBe(true);
    expect(step.doneWhenHtml?.trim()).toBe("<p>The page shows the greeting.</p>");
  });

  it("returns null for a part that does not exist", async () => {
    const { routes } = loadSite(FIXTURES);
    expect(await toPartPage(routes[0], routes, "/", "nope")).toBeNull();
  });

  it("links a reference on the same part page by anchor alone", async () => {
    const route = makeRoute("x", [
      makePart("a", [makeStop("b"), makeStop("c", { body: "See [[b]].\n" })]),
    ]);
    const page = await toPartPage(route, [route], "/sub/", "a");
    expect(page!.part.stops[1].html).toContain('href="#b"');
  });

  it("links a reference in another part to that part's page", async () => {
    const route = makeRoute("x", [
      makePart("a", [makeStop("b", { title: "B" })]),
      makePart("d", [makeStop("e", { body: "See [[b]].\n" })]),
    ]);
    const page = await toPartPage(route, [route], "/sub/", "d");
    expect(page!.part.stops[0].html).toContain('href="/sub/x/a/#b"');
  });

  it("links a cross-route reference to the other route's part page", async () => {
    const other = makeRoute("other", [makePart("p", [makeStop("intro", { title: "Intro" })])], { number: 2 });
    const route = makeRoute("x", [makePart("a", [makeStop("b", { body: "See [[other/intro]].\n" })])]);
    const page = await toPartPage(route, [route, other], "/sub/", "a");
    expect(page!.part.stops[0].html).toContain('href="/sub/other/p/#intro"');
  });

  it("renders an empty intro as an empty string", async () => {
    const route = makeRoute("x", [makePart("a", [makeStop("b")], { intro: "\n" })]);
    expect((await toPartPage(route, [route], "/", "a"))!.part.introHtml).toBe("");
  });
});

describe("stopPath", () => {
  it("builds the in-app path of a part page, with an optional stop anchor", () => {
    expect(stopPath("go", "types")).toBe("/go/types");
    expect(stopPath("go", "types", "maps")).toBe("/go/types#maps");
  });
});
