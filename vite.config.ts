import path from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin } from "vite";
import { copyAssets } from "./content/copy-assets";

/** Live preview while writing content: re-copies route images and reloads the page. */
function contentReload(): Plugin {
  const dir = path.resolve(process.env.GLITCH_ROUTES_DIR ?? "routes");
  const out = path.resolve("public/route-assets");
  return {
    name: "glitch-content-reload",
    configureServer(server) {
      server.watcher.add(dir);
      server.watcher.on("all", (_event, file) => {
        const full = path.resolve(file);
        if (!full.startsWith(dir)) return;
        if (full.split(path.sep).includes("assets")) copyAssets(dir, out);
        server.ws.send({ type: "full-reload" });
      });
    },
  };
}

export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [reactRouter(), contentReload()],
});
