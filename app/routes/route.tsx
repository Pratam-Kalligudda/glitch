import { useEffect, useMemo } from "react";
import { Marquee } from "../components/Marquee";
import { PartHeader } from "../components/PartHeader";
import { PathGraphic } from "../components/PathGraphic";
import { Rail } from "../components/Rail";
import { RailDrawer } from "../components/RailDrawer";
import { Stop } from "../components/Stop";
import { SubNav } from "../components/SubNav";
import { getRouteView } from "../content.server";
import { useActivePart } from "../hooks/useActivePart";
import { nextStop, useProgress, whenHydrated } from "../state/progress";
import type { Route } from "./+types/route";

export async function loader({ params }: Route.LoaderArgs) {
  const route = await getRouteView(params.slug);
  if (!route) throw new Response("Not found", { status: 404 });
  return { route };
}

/**
 * Client navigations read the prerendered data file. A slug that was never prerendered
 * has no data file, so report it as a 404 instead of a decoding error.
 */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  try {
    return await serverLoader();
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Not found", { status: 404 });
  }
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "RoadMap" }];
  return [
    { title: `${loaderData.route.title} · RoadMap` },
    { name: "description", content: loaderData.route.summary },
  ];
}

/** One delegated handler for every "Copy" button in the rendered Markdown. */
function copyCode(event: React.MouseEvent<HTMLElement>) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button.copy");
  const code = button?.parentElement?.querySelector("pre")?.textContent;
  if (!button || code == null || !navigator.clipboard) return;
  void navigator.clipboard.writeText(code).then(() => {
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 1500);
  });
}

export default function RoutePage({ loaderData }: Route.ComponentProps) {
  const { route } = loaderData;
  const done = useProgress((s) => s.done[route.slug]);
  const toggle = useProgress((s) => s.toggle);
  const visit = useProgress((s) => s.visit);

  const stops = useMemo(() => route.parts.flatMap((p) => p.stops), [route]);
  const doneIds = useMemo(() => {
    const valid = new Set(stops.map((s) => s.id));
    return new Set((done ?? []).filter((id) => valid.has(id)));
  }, [done, stops]);
  const next = nextStop([...doneIds], stops);
  const active = useActivePart(route.parts.map((p) => p.id));

  // Wait for saved progress before writing, or the empty state would overwrite it.
  useEffect(() => whenHydrated(() => visit(route.slug)), [route.slug, visit]);

  return (
    <>
      <SubNav title={route.title} done={doneIds.size} total={stops.length} nextId={next?.id ?? null}>
        <RailDrawer parts={route.parts} doneIds={doneIds} active={active} />
      </SubNav>

      <section className="route-hero">
        <div className="container route-hero-grid">
          <p className="strap">Route {route.number}</p>
          <div className="route-hero-main">
            <h1 className="hero-title">{route.hero || route.title}</h1>
            {route.lede && <p className="hero-lead">{route.lede}</p>}
            {/* Labelled on wide screens; the compact form keeps readable dots on phones. */}
            <div className="path-wide-only">
              <PathGraphic
                total={stops.length}
                done={doneIds.size}
                labels={stops.map((s) => s.title)}
                marks={stops.map((s) => doneIds.has(s.id))}
              />
            </div>
            <div className="path-narrow-only">
              <PathGraphic
                total={stops.length}
                done={doneIds.size}
                marks={stops.map((s) => doneIds.has(s.id))}
              />
            </div>
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

      <div className="route-body" onClick={copyCode}>
        <aside className="route-rail">
          <Rail parts={route.parts} doneIds={doneIds} active={active} />
        </aside>
        <div className="route-content">
          {route.parts.map((part) => (
            <section key={part.id} id={`part-${part.id}`} className="part">
              <PartHeader part={part} />
              {part.stops.map((stop) => (
                <Stop
                  key={stop.id}
                  stop={stop}
                  done={doneIds.has(stop.id)}
                  onToggle={(id) => toggle(route.slug, id)}
                />
              ))}
            </section>
          ))}
          {route.checked && (
            <p className="fine route-checked">
              Library APIs and commands were checked against official documentation in {route.checked}.
              They change; pin versions in your own projects.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
