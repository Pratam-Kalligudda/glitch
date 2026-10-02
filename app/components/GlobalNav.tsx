import { Link } from "react-router";
import { ThemeToggle } from "./ThemeToggle";

export function GlobalNav() {
  return (
    <header className="global-nav">
      <nav className="global-nav-inner" aria-label="Site">
        <Link className="global-nav-brand" to="/">
          Glitch
        </Link>
        <Link to="/#routes">Routes</Link>
        <Link to="/#start">Where to start</Link>
        <ThemeToggle />
      </nav>
    </header>
  );
}
