import type { PartView } from "../../content/view";

interface Props {
  parts: PartView[];
  doneIds: ReadonlySet<string>;
  active: string | null;
  onNavigate?: () => void;
}

/** Every part with its stops beneath it on a line; done stops fill their dot. */
export function Rail({ parts, doneIds, active, onNavigate }: Props) {
  return (
    <nav className="rail" aria-label="Parts">
      <ol>
        {parts.map((part) => {
          const count = part.stops.filter((s) => doneIds.has(s.id)).length;
          const current = part.id === active;
          return (
            <li key={part.id} className={part.kind === "capstone" ? "rail-part is-capstone" : "rail-part"}>
              <a
                className={current ? "rail-link is-active" : "rail-link"}
                href={`#part-${part.id}`}
                aria-current={current ? "true" : undefined}
                onClick={onNavigate}
              >
                <span className="rail-badge" aria-hidden="true">
                  {part.number ?? "★"}
                </span>
                <span className="rail-title">{part.title}</span>
                <span className="rail-count">
                  {count}/{part.stops.length}
                </span>
              </a>
              <ol className="rail-stops">
                {part.stops.map((stop) => {
                  const done = doneIds.has(stop.id);
                  return (
                    <li key={stop.id}>
                      <a className={done ? "rail-stop is-done" : "rail-stop"} href={`#${stop.id}`} onClick={onNavigate}>
                        {stop.title}
                        {done && <span className="sr-only"> (done)</span>}
                      </a>
                    </li>
                  );
                })}
              </ol>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
