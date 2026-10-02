interface Props {
  total: number;
  done: number;
  /** Optional stop titles drawn under the dots. Used only when there is one per dot. */
  labels?: string[];
}

const R = 7;
const PAD = R + 2;

const shorten = (s: string) => (s.length > 20 ? `${s.slice(0, 19)}…` : s);

/** Stops joined by a line, filled as the reader progresses. At most eight dots. */
export function PathGraphic({ total, done, labels }: Props) {
  const dots = Math.min(Math.max(total, 2), 8);
  const filled = total > 0 ? Math.round((done / total) * dots) : 0;
  const named = labels && labels.length === dots ? labels : null;
  const gap = named ? 132 : 56;
  const height = named ? 56 : 24;
  const width = (dots - 1) * gap + PAD * 2 + (named ? 112 : 0);
  const x = (i: number) => PAD + (named ? 56 : 0) + i * gap;
  return (
    <svg
      className={named ? "path path-wide" : "path"}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`${done} of ${total} stops done`}
    >
      <line className="path-line" x1={x(0)} y1={12} x2={x(dots - 1)} y2={12} />
      {filled > 1 && (
        <line className="path-line path-line-done" x1={x(0)} y1={12} x2={x(filled - 1)} y2={12} />
      )}
      {Array.from({ length: dots }, (_, i) => (
        <circle
          key={i}
          className={i < filled ? "path-dot path-dot-done" : "path-dot"}
          cx={x(i)}
          cy={12}
          r={R}
        />
      ))}
      {named &&
        named.map((label, i) => (
          <text key={i} className="path-label" x={x(i)} y={44} textAnchor="middle">
            {shorten(label)}
          </text>
        ))}
    </svg>
  );
}
