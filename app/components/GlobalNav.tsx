import { Link } from "react-router";

export function GlobalNav() {
  return (
    <header className="global-nav">
      <nav className="global-nav-inner" aria-label="Site">
        <Link className="global-nav-brand" to="/">
          RoadMap
        </Link>
        <Link to="/#routes">Routes</Link>
        <Link to="/#start">Where to start</Link>
      </nav>
    </header>
  );
}
