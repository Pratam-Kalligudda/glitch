import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSite } from "../../content/loader";
import { formatProblem } from "../../content/model";
import { FIXTURES, PART_MD, ROUTE_YAML, stopMd, writeTree } from "../helpers";

describe("loadSite", () => {
  it("loads the fixture into a route, part, stop tree", () => {
    const { routes, problems } = loadSite(FIXTURES);
    expect(problems).toEqual([]);
    expect(routes.map((r) => r.slug)).toEqual(["sample"]);
    const route = routes[0];
    expect(route.title).toBe("Sample route");
    expect(route.number).toBe(1);
    expect(route.checked).toBe("2026-10");
    expect(route.dir).toBe("routes/sample");
    expect(route.assets).toEqual(["flow.svg"]);
    expect(route.parts.map((p) => [p.id, p.kind])).toEqual([
      ["basics", "part"],
      ["capstone", "capstone"],
    ]);
    expect(route.parts[0].stops.map((s) => s.id)).toEqual(["first-stop", "second-stop"]);
    expect(route.parts[1].stops.map((s) => [s.id, s.isStep])).toEqual([
      ["spec", false],
      ["step-1", true],
    ]);
    expect(route.parts[1].stops[1].doneWhen).toBe("The page shows the greeting.");
    expect(route.parts[0].stops[0].file).toBe("routes/sample/01-basics/01-first-stop.md");
    expect(route.parts[0].stops[0].bodyOffset).toBe(3);
  });

  it("orders by numeric prefix, not alphabetically", () => {
    const dir = writeTree({
      "x/route.yaml": ROUTE_YAML,
      "x/01-a/part.md": PART_MD,
      "x/01-a/2-two.md": stopMd("Two"),
      "x/01-a/10-ten.md": stopMd("Ten"),
    });
    const { routes } = loadSite(dir);
    expect(routes[0].parts[0].stops.map((s) => s.id)).toEqual(["two", "ten"]);
  });

  it("sorts routes by number", () => {
    const dir = writeTree({
      "b/route.yaml": "title: B\nnumber: 1\nsummary: S\n",
      "b/01-a/part.md": PART_MD,
      "b/01-a/01-s.md": stopMd(),
      "a/route.yaml": "title: A\nnumber: 2\nsummary: S\n",
      "a/01-a/part.md": PART_MD,
      "a/01-a/01-s.md": stopMd(),
    });
    expect(loadSite(dir).routes.map((r) => r.slug)).toEqual(["b", "a"]);
  });

  it("reports missing fields with the file path", () => {
    const dir = writeTree({
      "x/route.yaml": "title: X\nnumber: 1\n",
      "x/01-a/part.md": "---\ntitle: A\n---\n",
      "x/01-a/01-b.md": "---\n---\nText.\n",
    });
    const messages = loadSite(dir).problems.map(formatProblem);
    expect(messages).toContain("routes/x/route.yaml: missing 'summary'");
    expect(messages).toContain("routes/x/01-a/part.md: missing 'goal'");
    expect(messages).toContain("routes/x/01-a/01-b.md: missing 'title'");
  });

  it("reports a route without route.yaml and a part without part.md", () => {
    const dir = writeTree({
      "x/01-a/01-b.md": stopMd(),
      "y/route.yaml": ROUTE_YAML,
      "y/01-a/01-b.md": stopMd(),
    });
    const messages = loadSite(dir).problems.map(formatProblem);
    expect(messages).toContain("routes/x: missing route.yaml");
    expect(messages).toContain("routes/y/01-a: missing part.md");
  });

  it("handles CRLF line endings and keeps line offsets right", () => {
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    const dir = writeTree({
      "x/route.yaml": crlf(ROUTE_YAML),
      "x/01-a/part.md": crlf(PART_MD),
      "x/01-a/01-b.md": crlf(stopMd("B", "Line one.\nLine two.\n")),
    });
    const { routes, problems } = loadSite(dir);
    expect(problems).toEqual([]);
    const stop = routes[0].parts[0].stops[0];
    expect(stop.title).toBe("B");
    expect(stop.body).toBe("Line one.\nLine two.\n");
    expect(stop.bodyOffset).toBe(3);
  });

  it("ignores stray files and tolerates folders without a numeric prefix", () => {
    const dir = writeTree({
      "notes.txt": "not a route",
      "x/route.yaml": ROUTE_YAML,
      "x/README.txt": "stray",
      "x/intro/part.md": PART_MD,
      "x/intro/01-b.md": stopMd(),
      "x/intro/Thumbs.db": "binary",
      "x/intro/.DS_Store": "binary",
    });
    fs.mkdirSync(path.join(dir, ".git"));
    const { routes, problems } = loadSite(dir);
    expect(problems).toEqual([]);
    expect(routes[0].parts[0].id).toBe("intro");
    expect(routes[0].parts[0].stops.map((s) => s.id)).toEqual(["b"]);
  });

  it("returns no routes for a missing or empty directory", () => {
    expect(loadSite(path.join(writeTree({}), "nope"))).toEqual({ routes: [], problems: [] });
    expect(loadSite(writeTree({}))).toEqual({ routes: [], problems: [] });
  });

  it("reports invalid YAML instead of throwing", () => {
    const dir = writeTree({ "x/route.yaml": "title: [unclosed\n" });
    const messages = loadSite(dir).problems.map(formatProblem);
    expect(messages[0]).toMatch(/^routes\/x\/route\.yaml: invalid YAML/);
  });
});
