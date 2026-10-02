import path from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin } from "vite";

function contentReload(): Plugin {
  const dir = path.resolve(process.env.ROADMAP_ROUTES_DIR ?? "routes");
  return {
    name: "roadmap-content-reload",
    configureServer(server) {
      server.watcher.add(dir);
      server.watcher.on("all", (_event, file) => {
        if (path.resolve(file).startsWith(dir)) server.ws.send({ type: "full-reload" });
      });
    },
  };
}

export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [reactRouter(), contentReload()],
});
