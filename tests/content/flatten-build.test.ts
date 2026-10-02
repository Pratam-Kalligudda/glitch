import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flattenBuild } from "../../content/flatten-build";

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-build-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");

describe("flattenBuild", () => {
  it("moves pages prerendered under the base path up to the artifact root", () => {
    const dir = tree({
      "index.html": "spa shell",
      "assets/app.js": "js",
      "sub/index.html": "home",
      "sub/_.data": "data",
      "sub/sample/index.html": "route",
    });
    flattenBuild(dir, "/sub/");
    expect(read(dir, "index.html")).toBe("home");
    expect(read(dir, "_.data")).toBe("data");
    expect(read(dir, "sample/index.html")).toBe("route");
    expect(read(dir, "assets/app.js")).toBe("js");
    expect(fs.existsSync(path.join(dir, "sub"))).toBe(false);
  });

  it("keeps the SPA shell it replaces as the not-found fallback", () => {
    const dir = tree({ "index.html": "spa shell", "sub/index.html": "home" });
    flattenBuild(dir, "/sub/");
    expect(read(dir, "__spa-fallback.html")).toBe("spa shell");
  });

  it("handles a nested base path", () => {
    const dir = tree({ "a/b/index.html": "home" });
    flattenBuild(dir, "/a/b/");
    expect(read(dir, "index.html")).toBe("home");
    expect(fs.existsSync(path.join(dir, "a"))).toBe(false);
  });

  it("does nothing for the root base path or when nothing was nested", () => {
    const dir = tree({ "index.html": "home" });
    flattenBuild(dir, "/");
    flattenBuild(dir, "/sub/");
    expect(read(dir, "index.html")).toBe("home");
  });
});
