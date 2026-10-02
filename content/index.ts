import { loadSite } from "./loader";
import type { Problem, Route } from "./model";
import { validateSite } from "./validate";

export function checkContent(routesDir: string): { routes: Route[]; problems: Problem[] } {
  const { routes, problems } = loadSite(routesDir);
  return { routes, problems: [...problems, ...validateSite(routes)] };
}
