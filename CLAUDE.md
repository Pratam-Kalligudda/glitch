# RoadMap

A site of hands-on learning guides. Content is Markdown under `routes/`; a React Router app prerenders it to static HTML; GitHub Actions deploys it to GitHub Pages.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Local preview with live reload; route images are re-copied when an `assets/` folder changes |
| `npm run validate` | Check everything under `routes/` |
| `npm test` | All tests, including a full build of the fixture site and a check of every real route |
| `npm run build` | Validate, then build the static site into `build/client/` |
| `npm run typecheck` | Generate route types and run TypeScript |

Node 24.15 or newer is required.

## Layout

- `routes/` content. One folder per route.
- `content/` build-time pipeline: load, validate, render, copy assets, flatten the build. No React.
- `app/` the React app. `app/styles/tokens.css` holds the design tokens.
- `tests/` Vitest tests and fixture routes.
- `docs/superpowers/specs/` the design spec; `docs/superpowers/plans/` the implementation plan.

## Content rules

```
routes/<route-slug>/
  route.yaml
  assets/                 optional images
  01-<part-id>/
    part.md
    01-<stop-id>.md
```

- The folder name is the route slug: lowercase letters, digits and single hyphens. `assets` and `route-assets` are reserved, and a slug must not equal the repository name (the base path folder). Numeric prefixes set order and are not part of an id.
- A stop id is the filename without prefix and extension. It is the page anchor and the progress key, so renaming a stop file loses readers' saved progress for it. Ids are unique within a route.
- `route.yaml`: `title`, `number` (unique), `summary` are required. Optional: `hero`, `lede`, `prerequisites` (route slugs, each with a lower `number`), `checked` (`YYYY-MM`), `draft` (`true` hides the route). Quote any value that contains `: `.
- `part.md` front matter: `title`, `goal`, and `kind: capstone` for a capstone. The body is an optional intro.
- Stop front matter: `title`, and `done_when` for a checkable finish line.
- In a capstone part, a stop whose id starts with `step-` is a step and must have `done_when`.
- Every code fence names a language. Add `title="path/to/file"` to show a filename. To show a fence inside a fence, use four backticks outside.
- Callouts: `> [!NOTE]` and `> [!WARNING]`.
- References: `[[stop-id]]` in the same route, `[[route-slug/stop-id]]` in another. The link text is the target's title.
- Images live in the route's `assets/` folder and are referenced by filename: `![Alt](flow.svg)`.
- Raw HTML in Markdown is shown as text, never rendered. Links and images may use `http:`, `https:`, `mailto:`, relative paths or `#` anchors; any other scheme (`javascript:`, `data:`) fails validation and is stripped from the page.

Adding a route is only a new folder: the landing page, prerendering, links and the reading order pick it up. `tests/content/routes.test.ts` fails if any route under `routes/` stops validating or rendering.

## Writing stops

One idea per stop: one to three short paragraphs, one working example, an optional note. Check commands and library APIs against official documentation, pin versions, and set `checked` to the current month.

A capstone has a spec stop, then steps. Each step lists what to do, refers back to earlier stops with `[[...]]`, shows the result, and ends with `done_when`.

To write a new route, use the `new-route` skill.

## Design rules

The look follows the Knockout system in `design-md/knockout/DESIGN.md` (local reference, not committed; spec section 5 restates it). Keep to it when changing UI:

- Type: Anton in uppercase for display, Roboto Slab for leads and labels, Roboto 400 body at 18px, IBM Plex Mono for code.
- Colour: black, paper and orange carry the brand. Blue is reserved for actions. Green only marks done and "Done when".
- Large fills carry the paper-grain texture tokens (`--grain-light`, `--grain-dark`).
- Buttons are near-square (2px radius) with a trailing arrow and shrink to 0.95 when pressed. Cards and code blocks have a 1.6px black border and 8px radius.
- No shadows, no gradients.
- Use the tokens in `app/styles/tokens.css`; do not hard-code colours in components. Use `--surface` for card backgrounds and `--on-orange` for text on orange so the dark theme works.
- Dark mode is `:root[data-theme="dark"]` in `tokens.css`. The nav switch (System / Light / Dark) saves to `localStorage` and `app/theme.ts` inlines a `<head>` script that sets `data-theme` before paint. Style new UI with tokens and it works in both themes.
- Motion respects `prefers-reduced-motion`; touch targets are at least 44px.

## Base path

The site is served under `/<repo>/` on GitHub Pages (`BASE_PATH`). Links use React Router's `Link` or `import.meta.env.BASE_URL`, never a hard-coded `/`. The build smoke test checks every URL in the prerendered HTML.

## Git

Commit freely. Do not push unless asked.
