import { Link } from "react-router";

interface Props {
  title: string;
  /** Where the title leads: the route overview. */
  titleTo: string;
  done: number;
  total: number;
  /** `#stop-id` when the next stop is on this page, an in-app path when it is on another. */
  next: string | null;
  children?: React.ReactNode;
}

export function SubNav({ title, titleTo, done, total, next, children }: Props) {
  return (
    <div className="subnav">
      <div className="subnav-inner">
        <Link className="subnav-title" to={titleTo}>
          {title}
        </Link>
        <div className="subnav-right">
          {children}
          <span className="subnav-count">
            {done} of {total} done
          </span>
          {next === null ? (
            <span className="subnav-complete">Complete</span>
          ) : next.startsWith("#") ? (
            <a className="pill pill-small" href={next}>
              Next stop
            </a>
          ) : (
            <Link className="pill pill-small" to={next}>
              Next stop
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
