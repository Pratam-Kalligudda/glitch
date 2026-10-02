import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(routesDir: string) {
  return spawnSync("npx tsx content/cli.ts", {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, ROADMAP_ROUTES_DIR: routesDir },
  });
}

describe("validate CLI", () => {
  it("exits 0 and reports counts for valid content", () => {
    const result = run("tests/fixtures/routes");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK: 1 route(s), 4 stop(s).");
  });

  it("exits 1 and prints each problem for invalid content", () => {
    const result = run("tests/fixtures/invalid-routes");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid-routes/bad/route.yaml: missing 'summary'");
    expect(result.stderr).toContain("invalid-routes/bad: route has no parts");
  });
});
