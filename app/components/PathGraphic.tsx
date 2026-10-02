interface Props {
  total: number;
  done: number;
}

const GAP = 56;
const R = 7;
const PAD = R + 2;

/** Stops joined by a line, filled as the reader progresses. At most eight dots. */
export function PathGraphic({ total, done }: Props) {
  const dots = Math.min(Math.max(total, 2), 8);
  const filled = total > 0 ? Math.round((done / total) * dots) : 0;
  const width = (dots - 1) * GAP + PAD * 2;
  const x = (i: number) => PAD + i * GAP;
  return (
    <svg
      className="path"
      viewBox={`0 0 ${width} 24`}
      width={width}
      height={24}
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
    </svg>
  );
}
