import { checkContent } from "./index";
import { formatProblem } from "./model";

const dir = process.env.GLITCH_ROUTES_DIR ?? "routes";
const { routes, problems } = checkContent(dir);

if (problems.length > 0) {
  for (const problem of problems) console.error(formatProblem(problem));
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}

const stops = routes.reduce(
  (n, route) => n + route.parts.reduce((m, part) => m + part.stops.length, 0),
  0,
);
console.log(`OK: ${routes.length} route(s), ${stops} stop(s).`);
