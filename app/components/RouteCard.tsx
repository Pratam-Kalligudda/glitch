import { Link } from "react-router";
import type { RouteSummary } from "../../content/view";
import { countDone } from "../state/progress";
import { PathGraphic } from "./PathGraphic";
import { ProgressBar } from "./ProgressBar";

interface Props {
  route: RouteSummary;
  done: string[] | undefined;
}

function list(titles: string[]): string {
  if (titles.length <= 1) return titles.join("");
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

/** Problem/solution split: what the route is on black, where you stand on white. */
export function RouteCard({ route, done }: Props) {
  const total = route.stops.length;
  const count = countDone(
    done,
    route.stops.map((s) => s.id),
  );
  const action = count === 0 ? "Start" : count === total ? "Review" : "Resume";
  return (
    <article className="route-card reveal">
      <div className="route-card-top">
        <div className="route-card-head">
          <p className="eyebrow">Route {route.number}</p>
          {/* Reading order: where this route sits among the others. */}
          <p className="route-card-order">
            {route.prerequisites.length === 0
              ? "Start here"
              : `After ${list(route.prerequisites.map((p) => p.title))}`}
          </p>
        </div>
        <h3 className="route-card-title">{route.title}</h3>
        <p className="route-card-summary">{route.summary}</p>
      </div>
      <div className="route-card-bottom">
        <PathGraphic
          total={total}
          done={count}
          marks={route.stops.map((s) => done?.includes(s.id) ?? false)}
        />
        <ProgressBar value={count} max={total} label={`${route.title} progress`} />
        <p className="fine">
          {count} of {total} stops · {route.partCount} parts
        </p>
        <Link className="pill" to={`/${route.slug}`}>
          {action}
        </Link>
      </div>
    </article>
  );
}
