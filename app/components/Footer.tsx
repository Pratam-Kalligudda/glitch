export function Footer() {
  const repo = import.meta.env.VITE_REPO_URL as string | undefined;
  return (
    <footer className="footer">
      <div className="container">
        <p className="fine">Progress is saved in this browser only.</p>
        {repo && (
          <p className="fine">
            <a href={repo}>View the repository</a>
          </p>
        )}
      </div>
    </footer>
  );
}
