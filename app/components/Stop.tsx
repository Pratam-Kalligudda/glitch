import * as Checkbox from "@radix-ui/react-checkbox";
import { motion } from "motion/react";
import type { StopView } from "../../content/view";

interface Props {
  stop: StopView;
  done: boolean;
  onToggle: (id: string) => void;
}

export function Stop({ stop, done, onToggle }: Props) {
  return (
    <article className="stop" id={stop.id}>
      <header className="stop-head">
        <Checkbox.Root
          className="check"
          checked={done}
          onCheckedChange={() => onToggle(stop.id)}
          aria-label={`Mark ${stop.title} as done`}
        >
          <Checkbox.Indicator asChild>
            <motion.svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-hidden="true"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 26 }}
            >
              <path
                d="M3.5 8.5l3 3 6-7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </motion.svg>
          </Checkbox.Indicator>
        </Checkbox.Root>
        <h3 className="stop-title">
          <a href={`#${stop.id}`}>{stop.title}</a>
        </h3>
      </header>
      <div className="prose" dangerouslySetInnerHTML={{ __html: stop.html }} />
      {stop.doneWhenHtml && (
        <div className="callout callout-done">
          <strong className="callout-label">Done when</strong>
          <div className="callout-body" dangerouslySetInnerHTML={{ __html: stop.doneWhenHtml }} />
        </div>
      )}
    </article>
  );
}
