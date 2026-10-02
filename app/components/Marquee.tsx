interface Props {
  items: string[];
  tone?: "light" | "dark";
}

function Star() {
  return (
    <svg className="marquee-star" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0l2.4 7.2L21.6 4.8 16.8 10.8 24 12l-7.2 1.2 4.8 6-7.2-2.4L12 24l-2.4-7.2-7.2 2.4 4.8-6L0 12l7.2-1.2-4.8-6 7.2 2.4z" />
    </svg>
  );
}

/** Decorative divider: one outlined and one solid band, scrolling in opposite directions. */
export function Marquee({ items, tone = "light" }: Props) {
  const row = (outline: boolean) => (
    <div className={outline ? "marquee-row is-outline" : "marquee-row"}>
      <div className="marquee-track">
        {[0, 1].map((copy) => (
          <span className="marquee-group" key={copy}>
            {items.map((item, i) => (
              <span className="marquee-item" key={i}>
                {item}
                <Star />
              </span>
            ))}
          </span>
        ))}
      </div>
    </div>
  );
  return (
    <div className={`marquee marquee-${tone}`} aria-hidden="true">
      {row(true)}
      {row(false)}
    </div>
  );
}
