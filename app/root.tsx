import { useEffect } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse } from "react-router";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/components.css";
import { Footer } from "./components/Footer";
import { GlobalNav } from "./components/GlobalNav";
import { useProgress } from "./state/progress";
import type { Route } from "./+types/root";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  // Saved progress is loaded after hydration so server HTML and first render match.
  useEffect(() => {
    void useProgress.persist.rehydrate();
  }, []);

  return (
    <>
      <GlobalNav />
      <main>
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <>
      <GlobalNav />
      <main>
        <section className="tile tile-light">
          <h1 className="hero-title">{notFound ? "Page not found." : "Something went wrong."}</h1>
          <div className="actions">
            <a className="pill" href={import.meta.env.BASE_URL}>
              All routes
            </a>
          </div>
        </section>
      </main>
    </>
  );
}
