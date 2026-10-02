export function Footer() {
  const repo = import.meta.env.VITE_REPO_URL as string | undefined;
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <p className="footer-made">Made for learning by doing</p>
        <p className="footer-mark" aria-hidden="true">
          Glitch
        </p>
        <div className="footer-meta">
          <p className="fine">Progress is saved in this browser only.</p>
          {repo && (
            <p className="fine">
              <a href={repo}>View the repository</a>
            </p>
          )}
        </div>
      </div>
    </footer>
  );
}
