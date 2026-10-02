import type { PartView } from "../../content/view";

interface Props {
  parts: PartView[];
  doneIds: ReadonlySet<string>;
  active: string | null;
  /** The first stop not yet done; drawn in the action red, like the Next stop button. */
  nextId?: string | null;
  onNavigate?: () => void;
}

/** Every part with its stops beneath it on a line; done stops fill their dot. */
export function Rail({ parts, doneIds, active, nextId = null, onNavigate }: Props) {
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
                  const next = stop.id === nextId;
                  const state = done ? " is-done" : next ? " is-next" : "";
                  return (
                    <li key={stop.id}>
                      <a className={`rail-stop${state}`} href={`#${stop.id}`} onClick={onNavigate}>
                        {stop.title}
                        {done && <span className="sr-only"> (done)</span>}
                        {next && (
                          <>
                            <span className="rail-next" aria-hidden="true">
                              next
                            </span>
                            <span className="sr-only"> (next stop)</span>
                          </>
                        )}
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
