import { Link } from "react-router";
import type { RouteSummary } from "../../content/view";
import { countDone } from "../state/progress";
import { PathGraphic } from "./PathGraphic";
import { ProgressBar } from "./ProgressBar";

interface Props {
  route: RouteSummary;
  done: string[] | undefined;
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
        <p className="eyebrow">Route {route.number}</p>
        <h3 className="route-card-title">{route.title}</h3>
        <p className="route-card-summary">{route.summary}</p>
      </div>
      <div className="route-card-bottom">
        <PathGraphic total={total} done={count} />
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
