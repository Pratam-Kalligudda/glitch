import { Link } from "react-router";
import { stopPath } from "../../content/view";
import { PartHeader } from "../components/PartHeader";
import { Rail } from "../components/Rail";
import { RailDrawer } from "../components/RailDrawer";
import { Stop } from "../components/Stop";
import { SubNav } from "../components/SubNav";
import { getPartPage } from "../content.server";
import { useRouteProgress } from "../hooks/useRouteProgress";
import { prerenderedOr404 } from "../prerendered";
import type { Route } from "./+types/part";

export async function loader({ params }: Route.LoaderArgs) {
  const page = await getPartPage(params.slug, params.part);
  if (!page) throw new Response("Not found", { status: 404 });
  return { page };
}

export function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  return prerenderedOr404(serverLoader);
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Glitch" }];
  const { outline, part } = loaderData.page;
  return [
    { title: `${part.title} · ${outline.title} · Glitch` },
    { name: "description", content: part.goal },
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

/** One part of a route: its stops in full, the rail for the whole route, and the way on. */
export default function PartPage({ loaderData }: Route.ComponentProps) {
  const { outline, part, prev, next: nextPart } = loaderData.page;
  const { stops, doneIds, next, toggle } = useRouteProgress(outline);

  const nextHref = next ? (next.part === part.id ? `#${next.id}` : stopPath(outline.slug, next.part, next.id)) : null;
  const rail = { slug: outline.slug, parts: outline.parts, current: part.id, doneIds, nextId: next?.id ?? null };

  return (
    <>
      <SubNav
        title={outline.title}
        titleTo={`/${outline.slug}`}
        done={doneIds.size}
        total={stops.length}
        next={nextHref}
      >
        <RailDrawer {...rail} />
      </SubNav>

      <div className="route-body" onClick={copyCode}>
        <aside className="route-rail">
          <Rail {...rail} />
        </aside>
        <div className="route-content">
          <section id={`part-${part.id}`} className="part">
            <PartHeader part={part} />
            {part.stops.map((stop) => (
              <Stop key={stop.id} stop={stop} done={doneIds.has(stop.id)} onToggle={toggle} />
            ))}
          </section>

          <nav className="part-pager" aria-label="Parts">
            {prev ? (
              <Link className="part-pager-link" to={stopPath(outline.slug, prev.id)}>
                <span className="eyebrow">Previous part</span>
                <span className="part-pager-title">{prev.title}</span>
              </Link>
            ) : (
              <Link className="part-pager-link" to={`/${outline.slug}`}>
                <span className="eyebrow">Route overview</span>
                <span className="part-pager-title">{outline.title}</span>
              </Link>
            )}
            {nextPart ? (
              <Link className="part-pager-link is-next" to={stopPath(outline.slug, nextPart.id)}>
                <span className="eyebrow">Next part</span>
                <span className="part-pager-title">{nextPart.title}</span>
              </Link>
            ) : (
              <Link className="part-pager-link is-next" to={`/${outline.slug}`}>
                <span className="eyebrow">Finished the route</span>
                <span className="part-pager-title">Back to {outline.title}</span>
              </Link>
            )}
          </nav>

          {outline.checked && (
            <p className="fine route-checked">
              Library APIs and commands were checked against official documentation in {outline.checked}.
              They change; pin versions in your own projects.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
