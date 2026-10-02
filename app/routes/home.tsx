import { Link } from "react-router";
import { ContinueTile } from "../components/ContinueTile";
import { Marquee } from "../components/Marquee";
import { PathGraphic } from "../components/PathGraphic";
import { RouteCard } from "../components/RouteCard";
import { getSummaries } from "../content.server";
import { useProgress } from "../state/progress";
import type { Route } from "./+types/home";

export function loader() {
  return { routes: getSummaries() };
}

export function meta() {
  return [
    { title: "RoadMap" },
    {
      name: "description",
      content: "Hands-on guides: short stops, one idea each, a project at the end.",
    },
  ];
}

function list(titles: string[]): string {
  if (titles.length <= 1) return titles.join("");
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { routes } = loaderData;
  const done = useProgress((s) => s.done);
  const first = routes[0];

  return (
    <>
      <section className="hero">
        {/* The giant letters sit behind the headline only; smaller text gets a clean ground. */}
        <div className="hero-stage">
          <span className="hero-ghost" aria-hidden="true">
            Routes
          </span>
          <div className="hero-inner">
            <p className="strap">Hands-on guides</p>
            <h1 className="hero-title">Learn by building.</h1>
          </div>
        </div>
        <div className="hero-inner hero-after">
          <p className="hero-lead">Short stops. One idea each. A project at the end.</p>
          {first && (
            <div className="actions">
              <Link className="pill" to={`/${first.slug}`}>
                Start route {first.number}
              </Link>
              <a className="pill pill-ghost" href="#routes">
                See all routes
              </a>
            </div>
          )}
        </div>
      </section>

      <Marquee items={["Short stops", "One idea each", "Working examples", "Build the capstone"]} />

      <ContinueTile routes={routes} />

      <section className="tile tile-parchment" id="routes">
        <div className="container">
          <h2 className="section-title">All routes</h2>
          {routes.length === 0 ? (
            <div className="empty">
              <PathGraphic total={5} done={0} />
              <p>No routes yet. Add a folder under routes/ and push.</p>
            </div>
          ) : (
            <div className="card-grid">
              {routes.map((route) => (
                <RouteCard key={route.slug} route={route} done={done[route.slug]} />
              ))}
            </div>
          )}
        </div>
      </section>

      {routes.length > 0 && (
        <section className="tile tile-orange tile-left" id="start">
          <div className="container">
            <h2 className="section-title">Where to start</h2>
            <ul className="start-list" aria-label="Reading order">
              {routes.map((route) => (
                <li key={route.slug}>
                  {route.prerequisites.length === 0 ? (
                    <>
                      <Link to={`/${route.slug}`}>{route.title}</Link> needs no earlier route.
                    </>
                  ) : (
                    <>
                      Read {list(route.prerequisites.map((p) => p.title))} before{" "}
                      <Link to={`/${route.slug}`}>{route.title}</Link>.
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}
