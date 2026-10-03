import { resolveRef, type Part, type Route } from "./model";
import { renderMarkdown, type RenderContext } from "./render";

export interface StopView {
  id: string;
  title: string;
  html: string;
  doneWhenHtml: string | null;
  isStep: boolean;
}

export interface PartView {
  id: string;
  title: string;
  goal: string;
  kind: "part" | "capstone";
  number: number | null;
  introHtml: string;
  stops: StopView[];
}

export interface StopRef {
  id: string;
  title: string;
}

/** A part without its content: enough for the overview, the rail and progress. */
export interface PartOutline {
  id: string;
  title: string;
  goal: string;
  kind: "part" | "capstone";
  number: number | null;
  stops: StopRef[];
}

/** A route without any rendered content. Small enough to send with every page. */
export interface RouteOutline {
  slug: string;
  title: string;
  number: number;
  summary: string;
  hero: string;
  lede: string;
  checked: string | null;
  parts: PartOutline[];
}

/** One part page: the part rendered in full, the route's outline, and its neighbours. */
export interface PartPage {
  outline: RouteOutline;
  part: PartView;
  prev: StopRef | null;
  next: StopRef | null;
}

export interface RouteSummary {
  slug: string;
  title: string;
  number: number;
  summary: string;
  partCount: number;
  stops: (StopRef & { part: string })[];
  prerequisites: { slug: string; title: string }[];
}

/** In-app path of a part page, optionally to one stop on it. The router adds the base path. */
export function stopPath(slug: string, partId: string, stopId?: string): string {
  return `/${slug}/${partId}${stopId ? `#${stopId}` : ""}`;
}

/** Every stop of a route in reading order, with the part it is on. */
export function outlineStops(outline: RouteOutline): (StopRef & { part: string })[] {
  return outline.parts.flatMap((p) => p.stops.map((s) => ({ ...s, part: p.id })));
}

export function toSummary(route: Route, routes: Route[]): RouteSummary {
  return {
    slug: route.slug,
    title: route.title,
    number: route.number,
    summary: route.summary,
    partCount: route.parts.length,
    stops: route.parts.flatMap((p) => p.stops.map((s) => ({ id: s.id, title: s.title, part: p.id }))),
    prerequisites: route.prerequisites.flatMap((slug) => {
      const other = routes.find((r) => r.slug === slug);
      return other ? [{ slug, title: other.title }] : [];
    }),
  };
}

/** Capstone parts are not numbered; the others count up from 1. */
function partNumbers(route: Route): Map<string, number | null> {
  let n = 0;
  return new Map(route.parts.map((p) => [p.id, p.kind === "capstone" ? null : ++n]));
}

export function toOutline(route: Route): RouteOutline {
  const numbers = partNumbers(route);
  return {
    slug: route.slug,
    title: route.title,
    number: route.number,
    summary: route.summary,
    hero: route.hero,
    lede: route.lede,
    checked: route.checked ?? null,
    parts: route.parts.map((p) => ({
      id: p.id,
      title: p.title,
      goal: p.goal,
      kind: p.kind,
      number: numbers.get(p.id) ?? null,
      stops: p.stops.map((s) => ({ id: s.id, title: s.title })),
    })),
  };
}

function partOf(route: Route, stopId: string): Part | undefined {
  return route.parts.find((p) => p.stops.some((s) => s.id === stopId));
}

/** `base` is the site base path and must end with `/`. */
export async function toPartPage(
  route: Route,
  routes: Route[],
  base: string,
  partId: string,
): Promise<PartPage | null> {
  const index = route.parts.findIndex((p) => p.id === partId);
  if (index === -1) return null;
  const part = route.parts[index];

  const ctx: RenderContext = {
    resolveRef(target) {
      const hit = resolveRef(routes, route.slug, target);
      if (!hit) return null;
      const targetRoute = routes.find((r) => r.slug === hit.slug);
      const targetPart = targetRoute && partOf(targetRoute, hit.stop.id);
      if (!targetPart) return null;
      // On the same page an anchor is enough; otherwise link to the part page (with a
      // trailing slash, which is how a static host serves its index.html).
      const href =
        hit.slug === route.slug && targetPart.id === part.id
          ? `#${hit.stop.id}`
          : `${base}${hit.slug}/${targetPart.id}/#${hit.stop.id}`;
      return { href, title: hit.stop.title };
    },
    assetUrl: (file) => `${base}route-assets/${route.slug}/${file}`,
  };

  const stops = await Promise.all(
    part.stops.map(async (stop) => ({
      id: stop.id,
      title: stop.title,
      html: await renderMarkdown(stop.body, ctx),
      doneWhenHtml: stop.doneWhen ? await renderMarkdown(stop.doneWhen, ctx) : null,
      isStep: stop.isStep,
    })),
  );

  const neighbour = (p: Part | undefined): StopRef | null => (p ? { id: p.id, title: p.title } : null);
  return {
    outline: toOutline(route),
    part: {
      id: part.id,
      title: part.title,
      goal: part.goal,
      kind: part.kind,
      number: partNumbers(route).get(part.id) ?? null,
      introHtml: part.intro.trim() ? await renderMarkdown(part.intro, ctx) : "",
      stops,
    },
    prev: neighbour(route.parts[index - 1]),
    next: neighbour(route.parts[index + 1]),
  };
}
