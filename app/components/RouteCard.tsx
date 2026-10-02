import { Link } from "react-router";
import type { RouteSummary } from "../../content/view";
import { countDone } from "../state/progress";
import { ProgressBar } from "./ProgressBar";

interface Props {
  route: RouteSummary;
  done: string[] | undefined;
}

export function RouteCard({ route, done }: Props) {
  const total = route.stops.length;
  const count = countDone(
    done,
    route.stops.map((s) => s.id),
  );
  const action = count === 0 ? "Start" : count === total ? "Review" : "Resume";
  return (
    <article className="route-card reveal">
      <p className="eyebrow">Route {route.number}</p>
      <h3 className="route-card-title">{route.title}</h3>
      <p className="route-card-summary">{route.summary}</p>
      <ProgressBar value={count} max={total} label={`${route.title} progress`} />
      <p className="fine">
        {count} of {total} stops · {route.partCount} parts
      </p>
      <Link className="text-link" to={`/${route.slug}`}>
        {action} <span aria-hidden="true">›</span>
      </Link>
    </article>
  );
}
