import type { PartView } from "../../content/view";

interface Props {
  parts: PartView[];
  doneIds: ReadonlySet<string>;
  active: string | null;
  onNavigate?: () => void;
}

export function Rail({ parts, doneIds, active, onNavigate }: Props) {
  return (
    <nav className="rail" aria-label="Parts">
      <ol>
        {parts.map((part) => {
          const count = part.stops.filter((s) => doneIds.has(s.id)).length;
          const current = part.id === active;
          return (
            <li key={part.id}>
              <a
                className={current ? "rail-link is-active" : "rail-link"}
                href={`#part-${part.id}`}
                aria-current={current ? "true" : undefined}
                onClick={onNavigate}
              >
                <span>{part.title}</span>
                <span className="rail-count">
                  {count}/{part.stops.length}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
