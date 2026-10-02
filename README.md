# Glitch

Hands-on learning guides. Each guide is a route: short stops, one idea each, and a project at the end.

## Run it

Needs Node 24.15 or newer.

    npm install
    npm run dev

## Add a route

Content lives in `routes/`, one folder per route. How to write one, in depth, is in `docs/writing-a-route.md`; the short rules are in `CLAUDE.md`. In Claude Code, ask for a new route and the `new-route` skill takes it from outline to preview.

Check content with `npm run validate`, then `npm test`.

## Publish

Pushing to `main` runs the workflow in `.github/workflows/pages.yml`, which validates, tests, builds and deploys to GitHub Pages. A validation problem or failing test stops it before deploy.

One-time setup:

1. Create a public repository on GitHub and add it as `origin`.
2. In the repository's Settings → Pages, set Source to "GitHub Actions".
3. Push `main`.

The site appears at `https://<username>.github.io/<repository>/`.

## How it works

- `content/` loads `routes/`, validates it and renders Markdown to HTML at build time.
- `app/` is a React Router app, prerendered to one static page per route.
- `content/flatten-build.ts` moves pages prerendered under the base path to the root of `build/client/`, which is what GitHub Pages serves.
- Progress is stored in the browser's `localStorage` and is not synced between devices.
