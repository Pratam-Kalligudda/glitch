interface Props {
  total: number;
  done: number;
  /** Optional stop titles drawn under the dots. Used only when there is one per dot. */
  labels?: string[];
  /** Optional done state per stop. When there is one per dot, exactly those dots fill. */
  marks?: boolean[];
}

const R = 7;
const PAD = R + 2;

const shorten = (s: string) => (s.length > 20 ? `${s.slice(0, 19)}…` : s);

/**
 * Stops joined by a line, filled as the reader progresses. At most eight dots; with more
 * stops than dots the fill is proportional, otherwise each dot is one stop.
 */
export function PathGraphic({ total, done, labels, marks }: Props) {
  const dots = Math.min(Math.max(total, 2), 8);
  const filledCount = total > 0 ? Math.round((done / total) * dots) : 0;
  const isDone =
    marks && marks.length === dots ? (i: number) => marks[i] : (i: number) => i < filledCount;
  const named = labels && labels.length === dots ? labels : null;
  const gap = named ? 132 : 56;
  const height = named ? 56 : 24;
  const width = (dots - 1) * gap + PAD * 2 + (named ? 112 : 0);
  const x = (i: number) => PAD + (named ? 56 : 0) + i * gap;
  const segments = Array.from({ length: dots - 1 }, (_, i) => i).filter(
    (i) => isDone(i) && isDone(i + 1),
  );
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
      {segments.map((i) => (
        <line key={i} className="path-line path-line-done" x1={x(i)} y1={12} x2={x(i + 1)} y2={12} />
      ))}
      {Array.from({ length: dots }, (_, i) => (
        <circle
          key={i}
          className={isDone(i) ? "path-dot path-dot-done" : "path-dot"}
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
