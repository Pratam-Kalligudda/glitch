import fs from "node:fs";
import path from "node:path";

const routesDir = process.env.ROADMAP_ROUTES_DIR ?? "routes";
const out = path.resolve("public/route-assets");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

if (fs.existsSync(routesDir)) {
  for (const entry of fs.readdirSync(routesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(routesDir, entry.name, "assets");
    if (fs.existsSync(src)) fs.cpSync(src, path.join(out, entry.name), { recursive: true });
  }
}
