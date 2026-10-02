import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Copies each route's `assets/` folder to `<outDir>/<slug>/`, replacing what was there. */
export function copyAssets(routesDir: string, outDir: string): void {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(routesDir)) return;
  for (const entry of fs.readdirSync(routesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(routesDir, entry.name, "assets");
    if (fs.existsSync(src)) fs.cpSync(src, path.join(outDir, entry.name), { recursive: true });
  }
}

// `npm run assets`: Vite serves `public/` in dev and copies it into the build.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  copyAssets(process.env.ROADMAP_ROUTES_DIR ?? "routes", path.resolve("public/route-assets"));
}
