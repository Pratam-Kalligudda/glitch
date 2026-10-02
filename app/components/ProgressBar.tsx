import { motion, useReducedMotion } from "motion/react";

interface Props {
  value: number;
  max: number;
  label: string;
}

export function ProgressBar({ value, max, label }: Props) {
  const reduce = useReducedMotion();
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <motion.div
        className="progress-fill"
        initial={false}
        animate={{ width: `${percent}%` }}
        transition={reduce ? { duration: 0 } : { duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}
