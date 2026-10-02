import { describe, expect, it } from "vitest";
import { checkContent } from "../../content/index";
import { formatProblem } from "../../content/model";
import { validateSite } from "../../content/validate";
import { FIXTURES, makePart, makeRoute, makeStop } from "../helpers";

const messages = (...routes: Parameters<typeof validateSite>[0]) =>
  validateSite(routes).map(formatProblem);

describe("validateSite", () => {
  it("accepts the fixture route", () => {
    expect(checkContent(FIXTURES).problems).toEqual([]);
  });

  it("rejects duplicate route numbers", () => {
    const a = makeRoute("a", [makePart("p", [makeStop("s")])]);
    const b = makeRoute("b", [makePart("p", [makeStop("s")])]);
    expect(messages(a, b)).toContain("routes/b/route.yaml: number 1 also used by 'a'");
  });

  it("rejects unknown prerequisites", () => {
    const a = makeRoute("a", [makePart("p", [makeStop("s")])], { prerequisites: ["z"] });
    expect(messages(a)).toContain("routes/a/route.yaml: unknown prerequisite 'z'");
  });

  it("requires prerequisites to come earlier in the route order", () => {
    const a = makeRoute("a", [makePart("p", [makeStop("s")])], { number: 2 });
    const b = makeRoute("b", [makePart("p", [makeStop("s")])], { prerequisites: ["a"] });
    expect(messages(a, b)).toContain(
      "routes/b/route.yaml: prerequisite 'a' must have a lower number than 1",
    );
    const self = makeRoute("c", [makePart("p", [makeStop("s")])], { prerequisites: ["c"] });
    expect(messages(self)).toContain("routes/c/route.yaml: route cannot be its own prerequisite");
  });

  it("rejects a route without parts and a part without stops", () => {
    expect(messages(makeRoute("a", []))).toContain("routes/a: route has no parts");
    const empty = makeRoute("x", [makePart("a", [])]);
    expect(messages(empty)).toContain("routes/x/01-a: part has no stops");
  });

  it("rejects duplicate part ids", () => {
    const route = makeRoute("x", [
      makePart("a", [makeStop("s")], { dir: "routes/x/01-a" }),
      makePart("a", [makeStop("t")], { dir: "routes/x/02-a" }),
    ]);
    expect(messages(route)).toContain("routes/x/02-a: part id 'a' also used by 01-a");
  });

  it("rejects duplicate stop ids within a route", () => {
    const route = makeRoute("x", [
      makePart("a", [makeStop("b", { file: "routes/x/01-a/01-b.md" })]),
      makePart("c", [makeStop("b", { file: "routes/x/02-c/03-b.md" })]),
    ]);
    expect(messages(route)).toContain(
      "routes/x/02-c/03-b.md: stop id 'b' also used by 01-a/01-b.md",
    );
  });

  it("requires done_when on capstone steps only", () => {
    const route = makeRoute("x", [
      makePart(
        "cap",
        [
          makeStop("spec", { file: "routes/x/06-cap/01-spec.md" }),
          makeStop("step-1", { isStep: true, file: "routes/x/06-cap/03-step-1.md" }),
          makeStop("step-2", {
            isStep: true,
            doneWhen: "It works.",
            file: "routes/x/06-cap/04-step-2.md",
          }),
        ],
        { kind: "capstone" },
      ),
    ]);
    expect(messages(route)).toEqual([
      "routes/x/06-cap/03-step-1.md: capstone step needs 'done_when'",
    ]);
  });

  it("reports code fences without a language at the file line", () => {
    const body = "Intro.\n\n```\nx = 1\n```\n";
    const route = makeRoute("x", [makePart("a", [makeStop("b", { body, bodyOffset: 3 })])]);
    expect(messages(route)).toContain("routes/x/01-a/01-b.md:6: code fence has no language");
  });

  it("reports unknown references at the file line", () => {
    const body = "One.\n\nSee [[pydantc]] and [[b]].\n";
    const route = makeRoute("x", [makePart("a", [makeStop("b", { body, bodyOffset: 3 })])]);
    expect(messages(route)).toEqual(["routes/x/01-a/01-b.md:6: unknown reference 'pydantc'"]);
  });

  it("resolves cross-route references", () => {
    const other = makeRoute("other", [makePart("p", [makeStop("intro")])], { number: 2 });
    const ok = makeRoute("x", [makePart("a", [makeStop("b", { body: "See [[other/intro]].\n" })])]);
    expect(messages(ok, other)).toEqual([]);
    const bad = makeRoute("x", [makePart("a", [makeStop("b", { body: "See [[other/nope]].\n" })])]);
    expect(messages(bad, other)).toEqual([
      "routes/x/01-a/01-b.md:4: unknown reference 'other/nope'",
    ]);
  });

  it("ignores references inside code", () => {
    const body = "Use `[[not-a-ref]]`.\n\n```text\n[[also-not]]\n```\n";
    const route = makeRoute("x", [makePart("a", [makeStop("b", { body })])]);
    expect(messages(route)).toEqual([]);
  });

  it("reports missing assets and ignores external images", () => {
    const body = "![A](flow.svg)\n\n![B](gone.png)\n\n![C](https://example.com/c.png)\n";
    const route = makeRoute(
      "x",
      [makePart("a", [makeStop("b", { body, bodyOffset: 3 })])],
      { assets: ["flow.svg"] },
    );
    expect(messages(route)).toEqual(["routes/x/01-a/01-b.md:6: missing asset 'gone.png'"]);
  });

  it("checks part intros too", () => {
    const route = makeRoute("x", [
      makePart("a", [makeStop("b")], { intro: "See [[nope]].\n", introOffset: 4 }),
    ]);
    expect(messages(route)).toEqual(["routes/x/01-a/part.md:5: unknown reference 'nope'"]);
  });

  it("reports every problem, not just the first", () => {
    const route = makeRoute(
      "x",
      [makePart("a", [makeStop("b", { body: "```\nx\n```\n\n[[nope]]\n" })])],
      { prerequisites: ["z"] },
    );
    expect(messages(route)).toHaveLength(3);
  });
});
