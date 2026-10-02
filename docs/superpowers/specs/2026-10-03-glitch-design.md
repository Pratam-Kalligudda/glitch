# Glitch: guide site — design

Date: 2026-10-03
Status: awaiting review

## 1. Purpose

A repository that turns structured Markdown into a site of hands-on learning
guides, modelled on <https://harsh07may.github.io/build-routes/>. Claude
writes the guide content; a React app renders it; GitHub Actions publishes it
to GitHub Pages so it can be read from any device.

**Success:** the owner asks Claude for a guide on a topic, reviews an outline,
and after a push the finished route is live at
`https://<username>.github.io/<repo>/`. The owner has said the UI quality
decides whether the project satisfies them, so visual design is a first-class
requirement, not a finish.

### Decisions made

| Topic | Decision |
|---|---|
| Authoring | Content files plus an app that renders them. Claude writes content only. |
| Scope | Reusable for any topic. One shared design, one landing page. |
| Content format | Plain Markdown, one file per stop, folders for parts. Not MDX. |
| App | React + TypeScript on Vite, React Router with static prerendering. |
| UI libraries | Radix UI primitives, Motion, Zustand, Zod. |
| Visual design | Apple-inspired, from `design-md/apple/DESIGN.md`. |
| Deploy | GitHub Actions builds on push and deploys to Pages. |
| Repo visibility | Public. |
| Progress tracking | Per device, in `localStorage`. No sync. |

### Out of scope for v1

Search, progress sync or export, Mermaid diagrams,
charts (Recharts is reserved for later), interactive stops such as quizzes,
browser automation tests, a custom domain, and migrating the three existing
build-routes guides.

## 2. Content model

```
Route   a guide on one topic                (folder under routes/)
 Part   a chapter with a goal line          (folder inside a route)
  Stop  one idea with one working example   (Markdown file inside a part)
```

A part may be a **capstone**: a project the reader builds, made of a spec,
ordered steps, and design hints. Capstone steps carry a "Done when" check.

## 3. Repository layout

```
glitch/
  routes/                        # content
    <route-slug>/
      route.yaml
      assets/                    # optional images
      01-<part-id>/
        part.md
        01-<stop-id>.md
  content/                       # build-time pipeline, no React
    model.ts                     # Route, Part, Stop types and Zod schemas
    loader.ts                    # files -> model
    validate.ts                  # model -> list of problems
    render.ts                    # Markdown -> HTML
    cli.ts                       # `npm run validate`
  app/
    root.tsx
    routes/
      home.tsx                   # landing page
      route.tsx                  # one guide
    components/                  # see 5.3
    state/progress.ts            # Zustand store
    styles/
      tokens.css                 # design tokens as CSS variables
      global.css
  tests/
    fixtures/routes/sample/      # small route used by tests
  docs/superpowers/specs/
  .claude/skills/new-route/SKILL.md
  .github/workflows/pages.yml
  CLAUDE.md
  README.md
  package.json  package-lock.json
  react-router.config.ts  vite.config.ts  tsconfig.json
  .gitignore                     # node_modules/, build/, design-md/
```

`design-md/` is local reference material and is not committed: the repository
is public and those files are third-party design analyses. The tokens the
site needs are restated in `app/styles/tokens.css` and section 5.

### 3.1 `route.yaml`

```yaml
title: Python to FastAPI
number: 1                 # order and label on the landing page; unique
summary: Python essentials, the FastAPI toolkit, Postgres, Redis.
hero: From Python basics to shipping APIs.
lede: The shortest path from knowing Python to running a URL shortener.
prerequisites: []         # route slugs that should be read first
checked: 2026-10          # when library APIs were last verified; shown in footer
draft: false              # true skips the route in the build
```

The route slug is the folder name. There is no `slug` field.

### 3.2 `part.md`

```markdown
---
title: The FastAPI toolkit
goal: Learn type hints, Pydantic and async on their own.
kind: part                # or: capstone
---
```

The body is optional introductory prose. The part id is the folder name with
its numeric prefix removed (`03-toolkit` gives `toolkit`).

### 3.3 Stop file

````markdown
---
title: Pydantic v2
done_when: A bad URL gives 422.     # optional; required for capstone steps
---
Prose paragraphs.

```python title="app/schemas.py"
class LinkCreate(BaseModel):
    url: HttpUrl
```

> [!NOTE]
> Callout text.

See [[type-hints]] and [[ai-foundations/embeddings]].
````

Rules:

- The stop id is the filename without its numeric prefix and extension
  (`02-pydantic.md` gives `pydantic`). It is the HTML anchor and the progress
  key. Ids are unique within a route.
- Numeric prefixes only set order. Renumbering does not change ids.
- Renaming a file changes its id. Saved progress for the old id is ignored.
  This is accepted.
- Code fences must name a language. An optional `title="..."` renders as a
  filename strip above the block.
- `> [!NOTE]` and `> [!WARNING]` render as callouts.
- `done_when` renders as a "Done when" callout at the end of the stop.
- In a capstone part, a stop whose id starts with `step-` is a step and must
  have `done_when`. Other capstone stops (spec, hints) need not.
- `[[stop-id]]` links to a stop in the same route. `[[route-slug/stop-id]]`
  links to a stop in another route. Link text is the target stop's title.
- Markdown tables and images are allowed. Image paths are relative to the
  route's `assets/` folder. Raw HTML in Markdown is not rendered.

## 4. Build pipeline

The `content/` modules run at build time only. They have no React dependency
and are tested on their own.

1. **Load** (`loader.ts`). Walk `routes/*/`, read `route.yaml`, each part
   folder in prefix order, each stop file in prefix order. Parse front matter.
   Skip routes with `draft: true`.
2. **Validate** (`validate.ts`). Zod schemas check shapes; further rules check
   cross-file consistency. Every problem is returned, not just the first.
3. **Render** (`render.ts`). A unified pipeline (remark to rehype) turns each
   stop's Markdown into HTML: GitHub-flavoured tables, callouts, fence titles,
   `[[...]]` references, and Shiki syntax highlighting. Highlighting happens
   at build time; no highlighter ships to the browser.
4. **Prerender.** React Router loaders call the pipeline and pass the model to
   the page components. The build prerenders `/` and `/<route-slug>/` to
   static HTML, so direct links and stop anchors work on GitHub Pages and the
   content is readable before JavaScript loads.

`npm run validate` runs steps 1 and 2 and prints problems. The build runs the
same validation and fails on any problem.

React Router's prerender configuration and base-path handling must be checked
against its current documentation when the implementation plan is written.

### 4.1 Validation rules

| Rule | Example message |
|---|---|
| `route.yaml` has `title`, `number`, `summary` | `routes/x/route.yaml: missing 'summary'` |
| Route numbers are unique | `routes/x/route.yaml: number 1 also used by 'y'` |
| `prerequisites` name existing, non-draft routes | `routes/x/route.yaml: unknown prerequisite 'z'` |
| A route has at least one part; a part at least one stop | `routes/x/02-empty: part has no stops` |
| `part.md` has `title` and `goal` | `routes/x/01-a/part.md: missing 'goal'` |
| Stops have `title` | `routes/x/01-a/01-b.md: missing 'title'` |
| Part ids and stop ids are unique within a route | `routes/x/02-a/03-b.md: stop id 'b' also used by 01-a/01-b.md` |
| Capstone steps have `done_when` | `routes/x/06-capstone/03-step-1.md: capstone step needs 'done_when'` |
| Code fences name a language | `routes/x/01-a/01-b.md:12: code fence has no language` |
| `[[...]]` references resolve | `routes/x/01-a/01-b.md:20: unknown reference 'pydantc'` |
| Image paths exist | `routes/x/01-a/01-b.md:8: missing asset 'flow.svg'` |

Format: `<path>[:<line>]: <problem>`, one per line.

### 4.2 Commands

| Command | Does |
|---|---|
| `npm run dev` | Local preview with live reload on content and code changes |
| `npm run validate` | Load and validate `routes/` |
| `npm test` | Vitest |
| `npm run build` | Validate, then prerender the static site |

## 5. Visual design

> **Revision, 2026-10-03 (Glitch rebrand).** At the owner's request the site
> is renamed **Glitch**, after the "glitch in the Matrix". The Knockout
> structure below stays; these points supersede it where they conflict:
>
> - Colour: crystal cyan `#3ee0ff` replaces orange as the brand fill, with
>   `#00779c` for brand text and lines on light paper. Crystal red `#ff2e43`
>   replaces blue for actions (buttons) and warnings. Links use the brand
>   colour. Green still marks done and "Done when" only.
> - Big headlines (home hero, route hero, footer wordmark) carry a cyan and
>   red split edge, sized in em. This is the one exception to "no shadows".
> - Home hero: headline "System breached." with the second word torn (a
>   slipped band that flickers once on load), beside a terminal card that
>   "injects" the real routes as skills: at most three by name, the rest
>   counted, then a `[breach] complete` summary and `start <first route>`.
>   The card is decorative and hidden from screen readers. A faint crystal
>   grid (SVG) sits behind the hero.
> - The tear flickers for about half a second every 2.5 seconds; reduced
>   motion keeps it still.
> - Footer: black with the crystal grid in both themes, the torn GLITCH
>   wordmark on the left and a small terminal signing off on the right
>   (`[breach] session still open`, `$ logout`).
> - Rail: the next stop (the first not done) gets a red dot and a `next` tag,
>   the same red as the Next stop button.
> - Reading order is a chip on each route card ("Start here" or "After …").
>   The cyan band no longer repeats the routes: it is "How it works", four
>   numbered steps describing the format.
> - Storage keys use the `glitch:` prefix (`glitch:theme`,
>   `glitch:progress:v1`); nothing was published under the old name.

> **Revision, 2026-10-03 (design checkpoint).** The owner reviewed the
> Apple-inspired build and asked to switch to the Knockout style captured in
> `design-md/knockout/DESIGN.md` (from madewithknockout.com). That system
> supersedes sections 5.1 to 5.3 where they conflict:
>
> - Type: Anton (uppercase display), Roboto Slab (leads, labels), Roboto 400
>   body at 18px / 1.6, IBM Plex Mono for code. Weights 400, 500, 700.
> - Colour: black, paper `#f2f2f0` and orange `#f25f24` carry the brand.
>   Blue `#1169fe` is reserved for actions. Green `#46b887` marks done and
>   "Done when" only. Blush `#ffdede` for inline code.
> - Fills carry a locally generated paper-grain texture (SVG noise).
> - Buttons are near-square (2px radius) with a trailing arrow; cards and code
>   blocks have a 1.6px black border and 8px radius. No shadows, no gradients.
> - Section dividers are marquee bands of outlined and solid words.
> - Route cards and part headers use the black/white problem-solution split;
>   the capstone header is orange.
>
> Unchanged: no raw HTML, motion respects `prefers-reduced-motion`, touch
> targets of at least 44px, press state `scale(0.95)`, light/dark and
> breakpoints from 5.5, the route-path graphic.

The design follows the Apple-inspired system in `design-md/apple/DESIGN.md`.
The owner reviewed a rough mockup and approved the direction on the
understanding that the real pages will be considerably richer.

### 5.1 Tokens

| Group | Values |
|---|---|
| Accent | Action Blue `#0066cc`; focus ring `#0071e3`; on dark surfaces `#2997ff`. One accent only. |
| Text | Ink `#1d1d1f`; muted `#333333`; faint `#7a7a7a`; on dark `#ffffff`, muted on dark `#cccccc` |
| Surfaces | White `#ffffff`; parchment `#f5f5f7`; dark tiles `#272729`, `#2a2a2c`, `#252527`; black `#000000` |
| Lines | Hairline `#e0e0e0`; soft divider `#f0f0f0` |
| Radius | 8px utility, 18px cards and code blocks, full pill for actions |
| Spacing | 4, 8, 12, 17, 24, 32, 48, and 80px for sections |
| Type | `system-ui, -apple-system, Inter, sans-serif`. Hero 56/600, tile heading 40/600, section 34/600, tagline 21/600, body 17/400 at 1.47 line height, caption 14, fine print 12. Negative letter-spacing on headings. Weights 300, 400, 600, 700; no 500. |
| Mono | A self-hosted monospace face for code |

SF Pro renders only on Apple devices. Elsewhere the stack falls back to
Inter, self-hosted so the site has no font CDN dependency.

### 5.2 Rules carried over

- Full-bleed tiles alternate white, parchment and near-black. The colour
  change is the section divider; tiles have no border and no radius.
- Every interactive element is Action Blue. No second accent colour.
- Primary actions are pills. Pressing any button scales it to 0.95.
- No shadows on cards, buttons or text. No decorative gradients.
- Body text is 17px. Headings are weight 600 with tight tracking.
- A black 44px global nav sits above a frosted sub-nav (parchment at 80%
  opacity with backdrop blur).

### 5.3 Components

| Component | Design |
|---|---|
| `GlobalNav` | Black bar: site name, Routes, Where to start. Collapses to a menu on phones. |
| `SubNav` | Frosted bar on route pages: route title, "X of M done", "Next stop" pill. |
| `HeroTile` | Light tile: hero headline, lede, one or two pills. |
| `ContinueTile` | Dark tile on the landing page for the most recently read route: title, next stop, Resume pill, route-path graphic. Hidden when there is no progress. |
| `RouteCard` | White card, hairline border, 18px radius: route label, title, summary, progress bar, counts, text link. |
| `Rail` | Part list with per-part counts; current part highlighted while scrolling. A Radix dialog drawer on phones. |
| `PartHeader` | Eyebrow ("Part 3" or "Capstone"), heading, goal line. Capstone parts open on a dark tile. |
| `Stop` | Heading with a round done checkbox (Radix checkbox, fills blue), then rendered content. |
| `CodeBlock` | Dark `#1d1d1f` card, 18px radius, optional filename strip, copy button. |
| `Callout` | Parchment card, 18px radius. Note, Warning, and "Done when" with a blue label. |
| `ProgressBar` | Thin track, blue fill, animated. |
| `Footer` | Parchment: "checked" date, repository link. |

Items the Apple file does not specify, and which this design defines: code
blocks, callouts, the done checkbox, syntax colours (blue plus greys, within
the one-accent rule), and the route-path graphic that stands in for product
photography. Warning callouts use an amber label; this is the single
permitted exception to the one-accent rule, because a warning must not look
like a link.

### 5.4 Richness without photography

Apple's pages lean on product photography, which this site does not have.
Visual weight comes instead from:

- large display type and generous tile spacing;
- alternating dark tiles, including every capstone and the continue tile;
- a route-path illustration motif (stops joined by a line, filled as the
  reader progresses) used on tiles, cards and empty states;
- motion: tiles fade and rise on first scroll into view, the progress bar and
  check mark animate, the phone drawer slides. All motion respects
  `prefers-reduced-motion`.

### 5.5 Themes and responsiveness

Light and dark themes follow the system setting. *Added 2026-10-03 at the owner's request:* a System / Light / Dark switch in the global nav, saved in `localStorage` under `glitch:theme` and applied by an inline `<head>` script before first paint. The source file documents
light only; the dark theme is derived from its dark-tile surfaces and
reviewed at the design checkpoint.

Breakpoints: content locks at 1440px; the rail becomes a drawer below 834px;
card grids go from three columns to two at 834px and one at 640px; hero type
steps from 56px to 40px, 34px and 28px. Touch targets are at least 44px.

### 5.6 Design checkpoint

The landing page and one route page are built first, with the sample route,
and reviewed by the owner in the local preview. No further work proceeds
until the owner approves how they look. If the result reads as too plain, the
agreed levers are more dark tiles, illustration, and a per-route accent
colour.

## 6. Progress

`app/state/progress.ts` is a Zustand store persisted to `localStorage` under
`glitch:progress:v1`, holding done stop ids per route slug and the last
visited route and stop. Counts use only ids that exist in the current
content, so stale ids are harmless. The store is read after hydration, so
prerendered HTML and the first client render match. If `localStorage` is
unavailable the site still works and progress simply does not persist.

## 7. Authoring workflow

`CLAUDE.md` records the content conventions from section 3 so any Claude
session writes valid routes.

`.claude/skills/new-route/SKILL.md` defines the workflow:

1. Ask for the topic, the reader's starting level, and the capstone project.
2. Propose an outline: parts with goals, stops per part, capstone steps.
   Wait for the owner's approval.
3. Write `route.yaml`, then parts and stops, one idea per stop with a working
   example. Check library APIs against official documentation and pin
   versions. Set `checked` to the current month.
4. Run `npm run validate`; fix every problem.
5. Run `npm run dev` and report the preview URL.
6. Commit. Push only when the owner asks.

Stops follow the build-routes shape: one to three short paragraphs, one code
block (more in capstone steps), an optional note. Capstone steps list tasks
that refer back to earlier stops with `[[...]]`, show the code as it stands at
the end of the step, and end with a `done_when` check.

## 8. Deployment

`.github/workflows/pages.yml`:

- Triggers: push to `main`, and `workflow_dispatch`.
- `build` job: checkout, set up Node (version pinned in `.nvmrc`), `npm ci`,
  `npm run validate`, `npm test`, `npm run build` with the base path set to
  `/<repository name>/`, upload the static output with
  `actions/upload-pages-artifact`.
- `deploy` job: `actions/deploy-pages`, environment `github-pages`.
- Permissions: `contents: read`, `pages: write`, `id-token: write`.
- Action versions pinned. No secrets required.

A validation problem or failing test stops the workflow before deploy, so a
broken route never goes live.

One-time manual setup by the owner: create the public GitHub repository, add
it as `origin`, set Settings → Pages → Source to "GitHub Actions", push
`main`.

## 9. Testing

Vitest, using the fixture route in `tests/fixtures/routes/sample/`.

- **Loader:** the fixture loads into the expected tree; prefixes set order;
  ids drop the prefix; draft routes are skipped.
- **Validator:** one test per rule in 4.1, each asserting the path and
  message; a valid route yields no problems; multiple problems are all
  reported.
- **Renderer:** note and warning callouts, fence title, highlighted code,
  table, same-route and cross-route references, raw HTML not rendered.
- **Progress store:** marking and unmarking stops, counts ignoring stale ids,
  last-visited tracking.
- **Components:** `RouteCard` shows correct counts; `Stop` toggles done state;
  `Rail` lists parts with counts.
- **Build smoke test:** building the fixture produces `index.html` and
  `<slug>/index.html` containing the stop headings and anchors; the build
  fails on an invalid route.

Visual quality is judged by the owner at the design checkpoint, not by
automated tests. The accuracy of guide content is covered by the authoring
workflow.

## 10. First milestone

Build order:

1. Project scaffold, tokens, fonts.
2. Content model, loader, validator, renderer, with tests.
3. Sample route (two parts plus a one-step capstone, about seven stops).
4. Landing page and route page with all components and motion.
5. **Design checkpoint** (5.6).
6. Progress store wired through the pages.
7. Dark theme and responsive pass.
8. Actions workflow.
9. `CLAUDE.md`, the `new-route` skill, `README.md`.

Further routes are written afterwards through the `new-route` workflow.
