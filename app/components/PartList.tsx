import { Link } from "react-router";
import { stopPath, type PartOutline } from "../../content/view";
import { ProgressBar } from "./ProgressBar";

interface Props {
  slug: string;
  parts: PartOutline[];
  doneIds: ReadonlySet<string>;
}

/** The route overview: one card per part, each leading to that part's page. */
export function PartList({ slug, parts, doneIds }: Props) {
  return (
    <ol className="part-list">
      {parts.map((part) => {
        const done = part.stops.filter((s) => doneIds.has(s.id)).length;
        const total = part.stops.length;
        const classes = ["part-card", "reveal"];
        if (part.kind === "capstone") classes.push("is-capstone");
        if (total > 0 && done === total) classes.push("is-complete");
        return (
          <li key={part.id} className={classes.join(" ")}>
            <Link className="part-card-link" to={stopPath(slug, part.id)}>
              <span className="eyebrow">{part.number === null ? "Capstone" : `Part ${part.number}`}</span>
              <span className="part-card-title">{part.title}</span>
              <span className="part-card-goal">{part.goal}</span>
              <ProgressBar value={done} max={total} label={`${part.title} progress`} />
              <span className="part-card-meta">
                {done} of {total} stops done
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
