import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIXTURES = path.resolve("tests/fixtures/routes");

export const ROUTE_YAML = "title: X\nnumber: 1\nsummary: S\n";
export const PART_MD = "---\ntitle: A\ngoal: G\n---\n";
export const stopMd = (title = "B", body = "Text.\n") =>
  `---\ntitle: ${title}\n---\n${body}`;

/** Writes files under a fresh temp `routes` folder and returns that folder. */
export function writeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-"));
  const routes = path.join(root, "routes");
  fs.mkdirSync(routes);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(routes, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return routes;
}
