import type { CSSProperties, ReactNode } from "react";
import type { RouteSummary } from "../../content/view";

/** Routes listed by name; the rest are counted, so the card keeps its height as routes grow. */
export const MAX_SKILLS = 3;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The home hero's terminal: a breach sequence that "injects" the real routes as skills.
 * Decorative, so hidden from screen readers; the route list below carries the same facts.
 * Lines type in one after another unless the reader prefers reduced motion.
 */
export function BreachTerminal({ routes }: { routes: RouteSummary[] }) {
  const shown = routes.slice(0, MAX_SKILLS);
  const rest = routes.length - shown.length;
  const stops = routes.reduce((sum, r) => sum + r.stops.length, 0);
  const width = Math.max(...shown.map((r) => r.slug.length));

  const lines: ReactNode[] = [
    <>
      <span className="t-prompt">$</span> ssh you@glitch
    </>,
    <>
      <span className="t-dim">› tracing route ............</span> <span className="t-ok">ok</span>
    </>,
    <>
      <span className="t-dim">› bypassing firewall .......</span> <span className="t-ok">ok</span>
    </>,
    <span className="t-dim">› injecting skills</span>,
    ...shown.map((r) => (
      <>
        {"  "}
        <span className="t-ok">+</span> <span className="t-name">{r.slug.padEnd(width)}</span>
        {"  "}
        <span className="t-dim">{plural(r.stops.length, "stop")}</span>
      </>
    )),
    ...(rest > 0
      ? [
          <>
            {"  "}
            <span className="t-ok">+</span> <span className="t-dim">{rest} more</span>
          </>,
        ]
      : []),
    "",
    <>
      <span className="t-alert">[breach]</span> <span className="t-name">complete</span>{" "}
      <span className="t-dim">
        · {plural(routes.length, "skill")} · {plural(stops, "stop")} ready
      </span>
    </>,
    <>
      <span className="t-prompt">$</span> start {routes[0]?.slug}{" "}
      <span className="t-cursor" />
    </>,
  ];

  return (
    <div className="term" aria-hidden="true">
      <div className="term-bar">
        <i />
        <i />
        <i />
        <span>glitch@matrix: ~</span>
      </div>
      <pre className="term-body">
        {lines.map((line, i) => (
          <span key={i} className="term-line" style={{ "--i": i } as CSSProperties}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}
