import { type RouteConfig, index, route } from "@react-router/dev/routes";
import { loadSite } from "../content/loader";

// With `ssr: false`, a build refuses a page that has a loader but no prerendered path.
// Before the first route exists nothing matches `/:slug`, so the build leaves the page out.
// Dev and typegen always keep it, so types and the dev server do not depend on content.
const building = process.argv.includes("build");
const empty = building && loadSite(process.env.GLITCH_ROUTES_DIR ?? "routes").routes.length === 0;

export default [
  index("routes/home.tsx"),
  ...(empty ? [] : [route(":slug", "routes/route.tsx")]),
] satisfies RouteConfig;
