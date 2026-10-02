import { resolveRef, type Route } from "./model";
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

export interface RouteView {
  slug: string;
  title: string;
  number: number;
  summary: string;
  hero: string;
  lede: string;
  checked: string | null;
  parts: PartView[];
}

export interface RouteSummary {
  slug: string;
  title: string;
  number: number;
  summary: string;
  partCount: number;
  stops: { id: string; title: string }[];
  prerequisites: { slug: string; title: string }[];
}

export function toSummary(route: Route, routes: Route[]): RouteSummary {
  return {
    slug: route.slug,
    title: route.title,
    number: route.number,
    summary: route.summary,
    partCount: route.parts.length,
    stops: route.parts.flatMap((p) => p.stops.map((s) => ({ id: s.id, title: s.title }))),
    prerequisites: route.prerequisites.flatMap((slug) => {
      const other = routes.find((r) => r.slug === slug);
      return other ? [{ slug, title: other.title }] : [];
    }),
  };
}

/** `base` is the site base path and must end with `/`. */
export async function toView(route: Route, routes: Route[], base: string): Promise<RouteView> {
  const ctx: RenderContext = {
    resolveRef(target) {
      const hit = resolveRef(routes, route.slug, target);
      if (!hit) return null;
      const anchor = `#${hit.stop.id}`;
      const href = hit.slug === route.slug ? anchor : `${base}${hit.slug}/${anchor}`;
      return { href, title: hit.stop.title };
    },
    assetUrl: (file) => `${base}route-assets/${route.slug}/${file}`,
  };

  let number = 0;
  const parts: PartView[] = [];
  for (const part of route.parts) {
    const stops = await Promise.all(
      part.stops.map(async (stop) => ({
        id: stop.id,
        title: stop.title,
        html: await renderMarkdown(stop.body, ctx),
        doneWhenHtml: stop.doneWhen ? await renderMarkdown(stop.doneWhen, ctx) : null,
        isStep: stop.isStep,
      })),
    );
    parts.push({
      id: part.id,
      title: part.title,
      goal: part.goal,
      kind: part.kind,
      number: part.kind === "capstone" ? null : ++number,
      introHtml: part.intro.trim() ? await renderMarkdown(part.intro, ctx) : "",
      stops,
    });
  }

  return {
    slug: route.slug,
    title: route.title,
    number: route.number,
    summary: route.summary,
    hero: route.hero,
    lede: route.lede,
    checked: route.checked ?? null,
    parts,
  };
}
