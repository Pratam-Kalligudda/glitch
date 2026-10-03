import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flattenBuild, moveEntry } from "../../content/flatten-build";

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glitch-build-"));
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

  it("refuses to overwrite build output with a same-named page and deletes nothing", () => {
    const dir = tree({
      "assets/app.js": "js",
      "sub/index.html": "home",
      "sub/assets/index.html": "route",
    });
    expect(() => flattenBuild(dir, "/sub/")).toThrow(/assets/);
    expect(read(dir, "assets/app.js")).toBe("js");
  });

  it("refuses a route whose slug equals the base path folder", () => {
    const dir = tree({ "guides/index.html": "home", "guides/guides/index.html": "route" });
    expect(() => flattenBuild(dir, "/guides/")).toThrow(/guides/);
    expect(read(dir, "guides/guides/index.html")).toBe("route");
  });

  it("does nothing for the root base path or when nothing was nested", () => {
    const dir = tree({ "index.html": "home" });
    flattenBuild(dir, "/");
    flattenBuild(dir, "/sub/");
    expect(read(dir, "index.html")).toBe("home");
  });
});

describe("moveEntry", () => {
  it("copies, then removes, when the rename is refused", () => {
    // On Windows a folder that another process watches (a dev server, antivirus) cannot
    // be renamed, but its contents can still be copied.
    const dir = tree({ "from/page/index.html": "route", "from/page/x/y.data": "data" });
    const refuse = () => {
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    };
    moveEntry(path.join(dir, "from/page"), path.join(dir, "page"), refuse);
    expect(read(dir, "page/index.html")).toBe("route");
    expect(read(dir, "page/x/y.data")).toBe("data");
    expect(fs.existsSync(path.join(dir, "from/page"))).toBe(false);
  });

  it("does not hide other errors", () => {
    const dir = tree({ "from/a.txt": "a" });
    const fail = () => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    };
    expect(() => moveEntry(path.join(dir, "from/a.txt"), path.join(dir, "a.txt"), fail)).toThrow(/ENOSPC/);
  });
});
