import type { Config } from "@react-router/dev/config";
import { loadSite } from "./content/loader";

const routesDir = process.env.ROADMAP_ROUTES_DIR ?? "routes";

export default {
  ssr: false,
  basename: process.env.BASE_PATH ?? "/",
  async prerender() {
    const { routes } = loadSite(routesDir);
    return ["/", ...routes.map((route) => `/${route.slug}`)];
  },
} satisfies Config;
