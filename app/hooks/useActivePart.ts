import { useEffect, useState } from "react";

/** Id of the part currently near the top of the viewport. */
export function useActivePart(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join("|");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id.slice("part-".length));
        }
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const id of key.split("|")) {
      const el = document.getElementById(`part-${id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key]);

  return active;
}
