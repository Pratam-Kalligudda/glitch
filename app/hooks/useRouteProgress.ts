import { useEffect, useMemo } from "react";
import { outlineStops, type RouteOutline } from "../../content/view";
import { nextStop, useProgress, whenHydrated } from "../state/progress";

/** Saved progress for one route: which stops are done, the next one, and a toggle. */
export function useRouteProgress(outline: RouteOutline) {
  const done = useProgress((s) => s.done[outline.slug]);
  const toggle = useProgress((s) => s.toggle);
  const visit = useProgress((s) => s.visit);

  const stops = useMemo(() => outlineStops(outline), [outline]);
  const doneIds = useMemo(() => {
    const valid = new Set(stops.map((s) => s.id));
    return new Set((done ?? []).filter((id) => valid.has(id)));
  }, [done, stops]);
  const next = nextStop([...doneIds], stops);

  // Wait for saved progress before writing, or the empty state would overwrite it.
  useEffect(() => whenHydrated(() => visit(outline.slug)), [outline.slug, visit]);

  return { stops, doneIds, next, toggle: (id: string) => toggle(outline.slug, id) };
}
