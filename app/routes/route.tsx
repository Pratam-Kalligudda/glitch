import { stopPath } from "../../content/view";
import { Marquee } from "../components/Marquee";
import { PartList } from "../components/PartList";
import { PathGraphic } from "../components/PathGraphic";
import { SubNav } from "../components/SubNav";
import { getOutline } from "../content.server";
import { useRouteProgress } from "../hooks/useRouteProgress";
import { prerenderedOr404 } from "../prerendered";
import type { Route } from "./+types/route";

export function loader({ params }: Route.LoaderArgs) {
  const route = getOutline(params.slug);
  if (!route) throw new Response("Not found", { status: 404 });
  return { route };
}

export function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  return prerenderedOr404(serverLoader);
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Glitch" }];
  return [
    { title: `${loaderData.route.title} · Glitch` },
    { name: "description", content: loaderData.route.summary },
  ];
}

/** A route's overview: the hero, where you stand, and one card per part. */
export default function RouteOverview({ loaderData }: Route.ComponentProps) {
  const { route } = loaderData;
  const { stops, doneIds, next } = useRouteProgress(route);

  return (
    <>
      <SubNav
        title={route.title}
        titleTo={`/${route.slug}`}
        done={doneIds.size}
        total={stops.length}
        next={next ? stopPath(route.slug, next.part, next.id) : null}
      />

      <section className="route-hero">
        <div className="container route-hero-grid">
          <p className="strap">Route {route.number}</p>
          <div className="route-hero-main">
            <h1 className="hero-title">{route.hero || route.title}</h1>
            {route.lede && <p className="hero-lead">{route.lede}</p>}
            {/* One dot per part keeps the path readable however long the route is. */}
            <PathGraphic
              total={route.parts.length}
              done={route.parts.filter((p) => p.stops.every((s) => doneIds.has(s.id))).length}
              labels={route.parts.map((p) => p.title)}
              marks={route.parts.map((p) => p.stops.length > 0 && p.stops.every((s) => doneIds.has(s.id)))}
            />
          </div>
          <dl className="route-stats">
            <div>
              <dt>Stops</dt>
              <dd>{stops.length}</dd>
            </div>
            <div>
              <dt>Parts</dt>
              <dd>{route.parts.filter((p) => p.kind !== "capstone").length}</dd>
            </div>
            <div>
              <dt>Done</dt>
              <dd>{doneIds.size}</dd>
            </div>
          </dl>
        </div>
      </section>

      <Marquee items={route.parts.map((p) => p.title)} tone="dark" />

      <section className="route-parts">
        <div className="container">
          <h2 className="section-title">Parts</h2>
          <PartList slug={route.slug} parts={route.parts} doneIds={doneIds} />
          {route.checked && (
            <p className="fine route-checked">
              Library APIs and commands were checked against official documentation in {route.checked}.
              They change; pin versions in your own projects.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
