import path from "node:path";
import { checkContent } from "../content/index";
import { formatProblem, type Route } from "../content/model";
import { toSummary, toView, type RouteSummary, type RouteView } from "../content/view";

function load(): Route[] {
  const dir = path.resolve(process.env.ROADMAP_ROUTES_DIR ?? "routes");
  const { routes, problems } = checkContent(dir);
  if (problems.length > 0) {
    throw new Error(`Content problems:\n${problems.map(formatProblem).join("\n")}`);
  }
  return routes;
}

export function getSummaries(): RouteSummary[] {
  const routes = load();
  return routes.map((route) => toSummary(route, routes));
}

export async function getRouteView(slug: string): Promise<RouteView | null> {
  const routes = load();
  const route = routes.find((r) => r.slug === slug);
  return route ? toView(route, routes, import.meta.env.BASE_URL) : null;
}
