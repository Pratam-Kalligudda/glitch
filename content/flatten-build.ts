import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * React Router prerenders pages under `<clientDir>/<basePath>/`, while hashed assets
 * stay in `<clientDir>/assets/`. GitHub Pages serves the artifact root at the base
 * path, so the pages move up to the root, replacing the SPA shell left there.
 */
export function flattenBuild(clientDir: string, basePath: string): void {
  const segments = basePath.split("/").filter(Boolean);
  if (segments.length === 0) return;
  const nested = path.join(clientDir, ...segments);
  if (!fs.existsSync(nested)) return;
  // With a base path the SPA shell is written as the root index.html; keep it for 404s.
  const shell = path.join(clientDir, "index.html");
  const fallback = path.join(clientDir, "__spa-fallback.html");
  const entries = fs.readdirSync(nested);
  // A page named like existing build output (assets/, route-assets/, or the base folder
  // itself) would overwrite it; fail the build before moving anything.
  const clashes = entries.filter(
    (entry) => entry !== "index.html" && fs.existsSync(path.join(clientDir, entry)),
  );
  if (clashes.length > 0) {
    throw new Error(
      `Cannot flatten ${basePath}: ${clashes.join(", ")} already exist in ${clientDir}. ` +
        "Rename the route folder so it does not match a build output name or the base path.",
    );
  }
  if (fs.existsSync(shell) && !fs.existsSync(fallback)) fs.renameSync(shell, fallback);
  for (const entry of entries) {
    fs.rmSync(path.join(clientDir, entry), { recursive: true, force: true });
    fs.renameSync(path.join(nested, entry), path.join(clientDir, entry));
  }
  fs.rmSync(path.join(clientDir, segments[0]), { recursive: true, force: true });
}

// Runs after `react-router build` as part of `npm run build`.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  flattenBuild(path.resolve("build/client"), process.env.BASE_PATH ?? "/");
}
