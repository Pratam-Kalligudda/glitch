import { motion, useReducedMotion } from "motion/react";
import { Link } from "react-router";
import type { RouteSummary } from "../../content/view";
import { countDone, nextStop, useProgress } from "../state/progress";
import { PathGraphic } from "./PathGraphic";

export function ContinueTile({ routes }: { routes: RouteSummary[] }) {
  const lastRoute = useProgress((s) => s.lastRoute);
  const done = useProgress((s) => s.done);
  const reduce = useReducedMotion();

  const route = routes.find((r) => r.slug === lastRoute);
  if (!route) return null;

  const ids = route.stops.map((s) => s.id);
  const count = countDone(done[route.slug], ids);
  const next = nextStop(done[route.slug], route.stops);

  return (
    <motion.section
      className="tile tile-dark"
      aria-label="Continue"
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
    >
      <p className="eyebrow eyebrow-accent">Continue</p>
      <h2 className="tile-title">{route.title}</h2>
      <p className="tile-lead">{next ? `Next stop: ${next.title}` : "Every stop is done."}</p>
      <div className="actions">
        <Link className="pill" to={next ? `/${route.slug}#${next.id}` : `/${route.slug}`}>
          {next ? "Resume" : "Review"}
        </Link>
      </div>
      <PathGraphic total={ids.length} done={count} />
    </motion.section>
  );
}
