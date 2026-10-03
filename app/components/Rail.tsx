import { Link } from "react-router";
import { stopPath, type PartOutline } from "../../content/view";

interface Props {
  slug: string;
  parts: PartOutline[];
  /** The part whose page this is. */
  current: string;
  doneIds: ReadonlySet<string>;
  /** The first stop not yet done; drawn in the action red, like the Next stop button. */
  nextId: string | null;
  onNavigate?: () => void;
}

/**
 * Every part with its stops beneath it on a line; done stops fill their dot. Parts link to
 * their pages. A stop on this page is an anchor; a stop on another part links to that page.
 */
export function Rail({ slug, parts, current, doneIds, nextId, onNavigate }: Props) {
  return (
    <nav className="rail" aria-label="Parts">
      <ol>
        {parts.map((part) => {
          const count = part.stops.filter((s) => doneIds.has(s.id)).length;
          const here = part.id === current;
          return (
            <li key={part.id} className={part.kind === "capstone" ? "rail-part is-capstone" : "rail-part"}>
              <Link
                className={here ? "rail-link is-active" : "rail-link"}
                to={stopPath(slug, part.id)}
                aria-current={here ? "page" : undefined}
                onClick={onNavigate}
              >
                <span className="rail-badge" aria-hidden="true">
                  {part.number ?? "★"}
                </span>
                <span className="rail-title">{part.title}</span>
                <span className="rail-count">
                  {count}/{part.stops.length}
                </span>
              </Link>
              <ol className="rail-stops">
                {part.stops.map((stop) => {
                  const done = doneIds.has(stop.id);
                  const next = stop.id === nextId;
                  const className = `rail-stop${done ? " is-done" : next ? " is-next" : ""}`;
                  const label = (
                    <>
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
                    </>
                  );
                  return (
                    <li key={stop.id}>
                      {here ? (
                        <a className={className} href={`#${stop.id}`} onClick={onNavigate}>
                          {label}
                        </a>
                      ) : (
                        <Link className={className} to={stopPath(slug, part.id, stop.id)} onClick={onNavigate}>
                          {label}
                        </Link>
                      )}
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
