import type { Config } from "@react-router/dev/config";
import { loadSite } from "./content/loader";

const routesDir = process.env.GLITCH_ROUTES_DIR ?? "routes";

export default {
  ssr: false,
  basename: process.env.BASE_PATH ?? "/",
  async prerender() {
    const { routes } = loadSite(routesDir);
    // The route overview, then one page per part.
    return [
      "/",
      ...routes.flatMap((route) => [
        `/${route.slug}`,
        ...route.parts.map((part) => `/${route.slug}/${part.id}`),
      ]),
    ];
  },
} satisfies Config;
