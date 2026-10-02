interface Props {
  title: string;
  done: number;
  total: number;
  nextId: string | null;
  children?: React.ReactNode;
}

export function SubNav({ title, done, total, nextId, children }: Props) {
  return (
    <div className="subnav">
      <div className="subnav-inner">
        <span className="subnav-title">{title}</span>
        <div className="subnav-right">
          {children}
          <span className="subnav-count">
            {done} of {total} done
          </span>
          {nextId ? (
            <a className="pill pill-small" href={`#${nextId}`}>
              Next stop
            </a>
          ) : (
            <span className="subnav-complete">Complete</span>
          )}
        </div>
      </div>
    </div>
  );
}
