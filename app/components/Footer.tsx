export function Footer() {
  const repo = import.meta.env.VITE_REPO_URL as string | undefined;
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div className="footer-top">
          <div>
            <p className="footer-made">Made for learning by doing</p>
            <div className="footer-meta">
              <p className="fine">Progress is saved in this browser only.</p>
              {repo && (
                <p className="fine">
                  <a href={repo}>View the repository</a>
                </p>
              )}
            </div>
          </div>
          {/* The session signs off. Decorative, like the hero terminal. */}
          <div className="term footer-term" aria-hidden="true">
            <div className="term-bar">
              <i />
              <i />
              <i />
              <span>glitch@matrix: ~</span>
            </div>
            <pre className="term-body">
              <span className="t-alert">[breach]</span> <span className="t-dim">session still open</span>
              {"\n"}
              <span className="t-prompt">$</span> logout <span className="t-cursor" />
            </pre>
          </div>
        </div>
        {/* The wordmark runs the full width, like a signature under the page. */}
        <p className="footer-mark" aria-hidden="true">
          <span className="breach" data-text="Glitch">
            Glitch
          </span>
        </p>
      </div>
    </footer>
  );
}
