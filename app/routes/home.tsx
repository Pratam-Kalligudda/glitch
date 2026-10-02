import { Link } from "react-router";
import { BreachTerminal } from "../components/BreachTerminal";
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
    { title: "Glitch" },
    {
      name: "description",
      content: "Hands-on guides: short stops, one idea each, a project at the end.",
    },
  ];
}

/** How every route works. Says what the format is; the route cards say what there is. */
const HOW = [
  { title: "Pick a route", text: "Each one takes a single tool from nothing to something you use." },
  { title: "Run each stop", text: "One idea, one working example. Type it, run it, see it work." },
  { title: "Mark it done", text: "Tick the stop. Progress is saved in this browser." },
  { title: "Build the capstone", text: "Put the stops together into one real project." },
];

export default function Home({ loaderData }: Route.ComponentProps) {
  const { routes } = loaderData;
  const done = useProgress((s) => s.done);
  const first = routes[0];

  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <p className="strap">Hands-on guides</p>
          <div className="hero-grid">
            <div className="hero-copy">
              <h1 className="hero-title">
                System{" "}
                <span className="breach" data-text="breached.">
                  breached.
                </span>
              </h1>
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
            {first && <BreachTerminal routes={routes} />}
          </div>
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
        <section className="tile tile-brand tile-left" id="how">
          <div className="container">
            <h2 className="section-title">How it works</h2>
            <ol className="how-steps" aria-label="How it works">
              {HOW.map((step, i) => (
                <li key={step.title} className="how-step">
                  <span className="how-num" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="how-title">{step.title}</h3>
                  <p className="how-text">{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
    </>
  );
}
