import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyAssets } from "../../content/copy-assets";
import { ROUTE_YAML, writeTree } from "../helpers";

describe("copyAssets", () => {
  it("copies every route's assets under its slug and drops stale files", () => {
    const routes = writeTree({
      "a/route.yaml": ROUTE_YAML,
      "a/assets/one.svg": "<svg/>",
      "b/route.yaml": ROUTE_YAML,
      "b/assets/img/two.png": "png",
      "c/route.yaml": ROUTE_YAML,
    });
    const out = path.join(path.dirname(routes), "public", "route-assets");
    fs.mkdirSync(path.join(out, "gone"), { recursive: true });

    copyAssets(routes, out);

    expect(fs.existsSync(path.join(out, "a", "one.svg"))).toBe(true);
    expect(fs.existsSync(path.join(out, "b", "img", "two.png"))).toBe(true);
    expect(fs.existsSync(path.join(out, "c"))).toBe(false);
    expect(fs.existsSync(path.join(out, "gone"))).toBe(false);
  });

  it("leaves an empty folder when there are no routes", () => {
    const out = path.join(writeTree({}), "..", "out");
    copyAssets(path.join(out, "missing"), out);
    expect(fs.readdirSync(out)).toEqual([]);
  });
});
