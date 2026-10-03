import path from "node:path";
import { checkContent } from "../content/index";
import { formatProblem, type Route } from "../content/model";
import { toOutline, toPartPage, toSummary, type PartPage, type RouteOutline, type RouteSummary } from "../content/view";

function load(): Route[] {
  const dir = path.resolve(process.env.GLITCH_ROUTES_DIR ?? "routes");
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

export function getOutline(slug: string): RouteOutline | null {
  const route = load().find((r) => r.slug === slug);
  return route ? toOutline(route) : null;
}

export async function getPartPage(slug: string, partId: string): Promise<PartPage | null> {
  const routes = load();
  const route = routes.find((r) => r.slug === slug);
  return route ? toPartPage(route, routes, import.meta.env.BASE_URL, partId) : null;
}
