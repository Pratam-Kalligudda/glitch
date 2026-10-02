# RoadMap Guide Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a React site that renders Markdown learning guides (route → part → stop) with an Apple-inspired design, per-device progress tracking, and automatic deployment to GitHub Pages.

**Architecture:** A build-time content pipeline in `content/` (plain TypeScript, no React) loads `routes/`, validates it, and renders Markdown to HTML. A React Router app in `app/` calls that pipeline from route loaders and is prerendered to static HTML, one page per guide. Progress lives in a Zustand store persisted to `localStorage`.

**Tech Stack:** Node 24, TypeScript, Vite, React 19, React Router 8 (framework mode, `ssr: false` + `prerender`), Radix UI, Motion, Zustand, Zod, unified/remark/rehype, Shiki, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-03-roadmap-generator-design.md`

## Prerequisite (owner action)

The machine's active Node is 20.20.2. React Router 8 needs Node ≥ 22.22, and jsdom 30 needs Node ≥ 24.15. Before Task 1, the owner runs:

```bash
nvm install 24
```

```bash
nvm use 24
```

Then `node -v` must print `v24.15.0` or newer. nvm-windows switches Node for the whole machine, which is why this is the owner's step.

## Global Constraints

- Node ≥ 24.15.0 (`.nvmrc` contains `24`; `package.json` `engines.node` is `>=24.15.0`).
- Install the current versions of every dependency (`npm install <name>`, no version suffix). Several are newer than this plan's author has used (React Router 8, Vite 8, Vitest 5, TypeScript 7, Zod 4, Shiki 4, Motion 14). If an API named in this plan does not exist in the installed version, read that package's current documentation and adapt the call; do not downgrade the package.
- Content is plain Markdown. Raw HTML in Markdown must never reach the page as HTML.
- One accent colour: Action Blue `#0066cc` (`#2997ff` on dark surfaces). The only other chromatic colour allowed is the amber warning label.
- No box shadows on cards, buttons or text. No gradients.
- Body text is 17px at line-height 1.47. Headings are weight 600. Font weight 500 is never used.
- Radii: 8px utility, 18px cards and code blocks, full pill for actions.
- Every button press state is `transform: scale(0.95)`.
- All motion respects `prefers-reduced-motion`.
- Touch targets are at least 44px.
- Problem message format: `<path>[:<line>]: <problem>`, paths with forward slashes, starting at the routes folder name (`routes/x/01-a/01-b.md`).
- Commit messages carry no `Co-Authored-By` line and no mention of Claude.
- Never push. Pushing is the owner's decision.
- All links and asset URLs must work when the site is served under `/<repo>/`.

## Deliberate deviations from the spec

1. **Font stack.** The spec lists `system-ui, -apple-system, Inter, sans-serif`. On Windows `system-ui` resolves to Segoe UI, so Inter would never load. The stack used is `-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", sans-serif`, which gives SF Pro on Apple devices and Inter elsewhere, as the spec intends.
2. **Last visited.** The spec stores the last visited route and stop. The store keeps only the last route; the next stop is derived as the first stop not yet done.
3. **Global nav menu.** The nav has three short links that fit at 320px, so it does not collapse to a menu on phones.
4. **"Checked" date.** It is shown at the end of each route page, not in the site footer, because it differs per route.

## Review Focus

Inputs the spec implies but does not list as tests. Each has a test in the task named.

1. A stop file saved with Windows CRLF line endings loads correctly and reports correct line numbers (the owner works on Windows). Task 1.
2. Stray files in content folders (`Thumbs.db`, `.DS_Store`, a notes file, a part folder without a numeric prefix) do not break loading. Task 1.
3. A code fence naming a language Shiki does not know renders as plain text instead of failing the build. Task 3.
4. Corrupt or wrongly shaped data under the progress key in `localStorage` does not crash the site, and a state change made before rehydration does not wipe saved progress. Task 4.
5. The built site works under a sub-path: every asset URL and link in the prerendered HTML starts with the base path. Task 10.

## File map

| Path | Responsibility |
|---|---|
| `content/model.ts` | Types, Zod schemas, problem formatting, id and reference helpers |
| `content/loader.ts` | Read `routes/` from disk into `Route[]`, report shape problems |
| `content/markdown.ts` | Parse Markdown, scan it for fences, references, images |
| `content/validate.ts` | Cross-file rules |
| `content/index.ts` | `checkContent`: load + validate |
| `content/cli.ts` | `npm run validate` |
| `content/theme.ts` | Shiki colour theme |
| `content/render.ts` | Markdown → HTML |
| `content/view.ts` | `Route` → serialisable view models for pages |
| `content/copy-assets.ts` | Copy route images into `public/route-assets/` |
| `app/content.server.ts` | Server-only bridge from loaders to `content/` |
| `app/state/progress.ts` | Zustand progress store and pure helpers |
| `app/root.tsx`, `app/routes.ts` | App shell and route table |
| `app/routes/home.tsx` | Landing page |
| `app/routes/route.tsx` | Guide page |
| `app/components/*.tsx` | One component per file |
| `app/hooks/useActivePart.ts` | Scroll spy for the rail |
| `app/styles/*.css` | `tokens.css`, `global.css`, `components.css`, `prose.css`, `responsive.css` |
| `routes/git-basics/` | The real sample route |
| `tests/` | Vitest tests and fixtures |

---

### Task 1: Toolchain, content model and loader

**Files:**
- Create: `package.json`, `.nvmrc`, `.gitattributes`, `tsconfig.json`, `vitest.config.ts`
- Modify: `.gitignore`
- Create: `content/model.ts`, `content/loader.ts`
- Create: `tests/helpers.ts`, `tests/content/loader.test.ts`
- Create: fixture files under `tests/fixtures/routes/`

**Interfaces:**
- Consumes: nothing.
- Produces (from `content/model.ts`):
  - `interface Stop { id: string; title: string; doneWhen?: string; body: string; bodyOffset: number; isStep: boolean; file: string }`
  - `interface Part { id: string; title: string; goal: string; kind: "part" | "capstone"; intro: string; introOffset: number; dir: string; stops: Stop[] }`
  - `interface Route { slug: string; title: string; number: number; summary: string; hero: string; lede: string; prerequisites: string[]; checked?: string; dir: string; assets: string[]; parts: Part[] }`
  - `interface Problem { file: string; line?: number; message: string }`
  - `formatProblem(p: Problem): string`
  - `stripPrefix(name: string): string`
  - `resolveRef(routes: Route[], fromSlug: string, target: string): { slug: string; stop: Stop } | null`
- Produces (from `content/loader.ts`): `loadSite(routesDir: string): { routes: Route[]; problems: Problem[] }`
- Produces (from `tests/helpers.ts`): `writeTree(files: Record<string, string>): string`, `FIXTURES`, `ROUTE_YAML`, `PART_MD`, `stopMd(title?, body?)`

`file` and `dir` are display paths with forward slashes that start at the routes folder name. `bodyOffset` is the number of lines before the Markdown body in the source file, so `file line = body line + bodyOffset`.

- [ ] **Step 1: Confirm Node**

Run: `node -v`
Expected: `v24.15.0` or newer. If not, stop and ask the owner to complete the prerequisite.

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "roadmap",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.15.0" },
  "scripts": {
    "assets": "tsx content/copy-assets.ts",
    "dev": "npm run assets && react-router dev",
    "validate": "tsx content/cli.ts",
    "build": "npm run validate && npm run assets && react-router build",
    "typecheck": "react-router typegen && tsc",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: Create `.nvmrc` and `.gitattributes`**

`.nvmrc`:

```
24
```

`.gitattributes`:

```
* text=auto eol=lf
```

- [ ] **Step 4: Replace `.gitignore`**

```
node_modules/
build/
.react-router/
public/route-assets/
design-md/
```

- [ ] **Step 5: Install dependencies**

Run:

```bash
npm install react react-dom react-router @react-router/node isbot zustand motion @radix-ui/react-checkbox @radix-ui/react-dialog @fontsource-variable/inter @fontsource/ibm-plex-mono
```

Run:

```bash
npm install -D @react-router/dev vite typescript tsx vitest jsdom @testing-library/react @types/react @types/react-dom @types/node @types/mdast zod yaml gray-matter unified remark-parse remark-gfm remark-rehype rehype-stringify unist-util-visit shiki
```

Expected: both finish without `EBADENGINE` warnings. An `EBADENGINE` warning means Node is too old.

- [ ] **Step 6: Create `tsconfig.json`**

```json
{
  "include": ["app", "content", "tests", "*.ts", ".react-router/types/**/*"],
  "compilerOptions": {
    "lib": ["DOM", "DOM.Iterable", "ES2023"],
    "types": ["node", "vite/client"],
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "rootDirs": [".", "./.react-router/types"],
    "esModuleInterop": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true
  }
}
```

- [ ] **Step 7: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    testTimeout: 20000,
  },
});
```

- [ ] **Step 8: Create the fixture route**

`tests/fixtures/routes/sample/route.yaml`:

```yaml
title: Sample route
number: 1
summary: A small route used by the tests.
hero: A sample hero line.
lede: A sample lede.
prerequisites: []
checked: 2026-10
```

`tests/fixtures/routes/sample/assets/flow.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 24" width="120" height="24"><circle cx="12" cy="12" r="6" fill="#0066cc"/><line x1="18" y1="12" x2="102" y2="12" stroke="#7a7a7a" stroke-width="2"/><circle cx="108" cy="12" r="6" fill="none" stroke="#7a7a7a" stroke-width="2"/></svg>
```

`tests/fixtures/routes/sample/01-basics/part.md`:

```markdown
---
title: Basics
goal: Learn the two basic ideas.
---
```

`tests/fixtures/routes/sample/01-basics/01-first-stop.md`:

````markdown
---
title: First stop
---
A stop is one idea with one working example.

```python title="app/main.py"
def greet(name: str) -> str:
    return f"Hello, {name}"
```

> [!NOTE]
> Notes look like this.

| Call | Result |
|---|---|
| `greet("Ada")` | `Hello, Ada` |
````

`tests/fixtures/routes/sample/01-basics/02-second-stop.md`:

```markdown
---
title: Second stop
---
This builds on [[first-stop]].

![Flow](flow.svg)
```

`tests/fixtures/routes/sample/02-capstone/part.md`:

```markdown
---
title: Capstone
goal: Build the greeter.
kind: capstone
---
```

`tests/fixtures/routes/sample/02-capstone/01-spec.md`:

```markdown
---
title: The spec
---
Build a page that greets a visitor by name.
```

`tests/fixtures/routes/sample/02-capstone/02-step-1.md`:

```markdown
---
title: "Step 1: greet"
done_when: The page shows the greeting.
---
Use the function from [[first-stop]].
```

`tests/fixtures/routes/hidden/route.yaml` (a draft route that must be skipped):

```yaml
title: Hidden route
number: 2
summary: Not ready.
draft: true
```

- [ ] **Step 9: Create `tests/helpers.ts`**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIXTURES = path.resolve("tests/fixtures/routes");

export const ROUTE_YAML = "title: X\nnumber: 1\nsummary: S\n";
export const PART_MD = "---\ntitle: A\ngoal: G\n---\n";
export const stopMd = (title = "B", body = "Text.\n") =>
  `---\ntitle: ${title}\n---\n${body}`;

/** Writes files under a fresh temp `routes` folder and returns that folder. */
export function writeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-"));
  const routes = path.join(root, "routes");
  fs.mkdirSync(routes);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(routes, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return routes;
}
```

- [ ] **Step 10: Write the failing loader tests**

`tests/content/loader.test.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSite } from "../../content/loader";
import { formatProblem } from "../../content/model";
import { FIXTURES, PART_MD, ROUTE_YAML, stopMd, writeTree } from "../helpers";

describe("loadSite", () => {
  it("loads the fixture into a route, part, stop tree", () => {
    const { routes, problems } = loadSite(FIXTURES);
    expect(problems).toEqual([]);
    expect(routes.map((r) => r.slug)).toEqual(["sample"]);
    const route = routes[0];
    expect(route.title).toBe("Sample route");
    expect(route.number).toBe(1);
    expect(route.checked).toBe("2026-10");
    expect(route.dir).toBe("routes/sample");
    expect(route.assets).toEqual(["flow.svg"]);
    expect(route.parts.map((p) => [p.id, p.kind])).toEqual([
      ["basics", "part"],
      ["capstone", "capstone"],
    ]);
    expect(route.parts[0].stops.map((s) => s.id)).toEqual(["first-stop", "second-stop"]);
    expect(route.parts[1].stops.map((s) => [s.id, s.isStep])).toEqual([
      ["spec", false],
      ["step-1", true],
    ]);
    expect(route.parts[1].stops[1].doneWhen).toBe("The page shows the greeting.");
    expect(route.parts[0].stops[0].file).toBe("routes/sample/01-basics/01-first-stop.md");
    expect(route.parts[0].stops[0].bodyOffset).toBe(3);
  });

  it("orders by numeric prefix, not alphabetically", () => {
    const dir = writeTree({
      "x/route.yaml": ROUTE_YAML,
      "x/01-a/part.md": PART_MD,
      "x/01-a/2-two.md": stopMd("Two"),
      "x/01-a/10-ten.md": stopMd("Ten"),
    });
    const { routes } = loadSite(dir);
    expect(routes[0].parts[0].stops.map((s) => s.id)).toEqual(["two", "ten"]);
  });

  it("sorts routes by number", () => {
    const dir = writeTree({
      "b/route.yaml": "title: B\nnumber: 1\nsummary: S\n",
      "b/01-a/part.md": PART_MD,
      "b/01-a/01-s.md": stopMd(),
      "a/route.yaml": "title: A\nnumber: 2\nsummary: S\n",
      "a/01-a/part.md": PART_MD,
      "a/01-a/01-s.md": stopMd(),
    });
    expect(loadSite(dir).routes.map((r) => r.slug)).toEqual(["b", "a"]);
  });

  it("reports missing fields with the file path", () => {
    const dir = writeTree({
      "x/route.yaml": "title: X\nnumber: 1\n",
      "x/01-a/part.md": "---\ntitle: A\n---\n",
      "x/01-a/01-b.md": "---\n---\nText.\n",
    });
    const messages = loadSite(dir).problems.map(formatProblem);
    expect(messages).toContain("routes/x/route.yaml: missing 'summary'");
    expect(messages).toContain("routes/x/01-a/part.md: missing 'goal'");
    expect(messages).toContain("routes/x/01-a/01-b.md: missing 'title'");
  });

  it("reports a route without route.yaml and a part without part.md", () => {
    const dir = writeTree({
      "x/01-a/01-b.md": stopMd(),
      "y/route.yaml": ROUTE_YAML,
      "y/01-a/01-b.md": stopMd(),
    });
    const messages = loadSite(dir).problems.map(formatProblem);
    expect(messages).toContain("routes/x: missing route.yaml");
    expect(messages).toContain("routes/y/01-a: missing part.md");
  });

  it("handles CRLF line endings and keeps line offsets right", () => {
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    const dir = writeTree({
      "x/route.yaml": crlf(ROUTE_YAML),
      "x/01-a/part.md": crlf(PART_MD),
      "x/01-a/01-b.md": crlf(stopMd("B", "Line one.\nLine two.\n")),
    });
    const { routes, problems } = loadSite(dir);
    expect(problems).toEqual([]);
    const stop = routes[0].parts[0].stops[0];
    expect(stop.title).toBe("B");
    expect(stop.body).toBe("Line one.\nLine two.\n");
    expect(stop.bodyOffset).toBe(3);
  });

  it("ignores stray files and tolerates folders without a numeric prefix", () => {
    const dir = writeTree({
      "notes.txt": "not a route",
      "x/route.yaml": ROUTE_YAML,
      "x/README.txt": "stray",
      "x/intro/part.md": PART_MD,
      "x/intro/01-b.md": stopMd(),
      "x/intro/Thumbs.db": "binary",
      "x/intro/.DS_Store": "binary",
    });
    fs.mkdirSync(path.join(dir, ".git"));
    const { routes, problems } = loadSite(dir);
    expect(problems).toEqual([]);
    expect(routes[0].parts[0].id).toBe("intro");
    expect(routes[0].parts[0].stops.map((s) => s.id)).toEqual(["b"]);
  });

  it("returns no routes for a missing or empty directory", () => {
    expect(loadSite(path.join(writeTree({}), "nope"))).toEqual({ routes: [], problems: [] });
    expect(loadSite(writeTree({}))).toEqual({ routes: [], problems: [] });
  });

  it("reports invalid YAML instead of throwing", () => {
    const dir = writeTree({ "x/route.yaml": "title: [unclosed\n" });
    const messages = loadSite(dir).problems.map(formatProblem);
    expect(messages[0]).toMatch(/^routes\/x\/route\.yaml: invalid YAML/);
  });
});
```

- [ ] **Step 11: Run the tests to verify they fail**

Run: `npm test -- tests/content/loader.test.ts`
Expected: FAIL, cannot resolve `../../content/loader`.

- [ ] **Step 12: Create `content/model.ts`**

```ts
import { z } from "zod";

export interface Stop {
  id: string;
  title: string;
  doneWhen?: string;
  body: string;
  bodyOffset: number;
  isStep: boolean;
  file: string;
}

export interface Part {
  id: string;
  title: string;
  goal: string;
  kind: "part" | "capstone";
  intro: string;
  introOffset: number;
  dir: string;
  stops: Stop[];
}

export interface Route {
  slug: string;
  title: string;
  number: number;
  summary: string;
  hero: string;
  lede: string;
  prerequisites: string[];
  checked?: string;
  dir: string;
  assets: string[];
  parts: Part[];
}

export interface Problem {
  file: string;
  line?: number;
  message: string;
}

export const RouteMetaSchema = z.object({
  title: z.string().min(1),
  number: z.number().int().positive(),
  summary: z.string().min(1),
  hero: z.string().default(""),
  lede: z.string().default(""),
  prerequisites: z.array(z.string()).default([]),
  checked: z.union([z.string(), z.number()]).transform(String).optional(),
  draft: z.boolean().default(false),
});

export const PartMetaSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  kind: z.enum(["part", "capstone"]).default("part"),
});

export const StopMetaSchema = z.object({
  title: z.string().min(1),
  done_when: z.string().min(1).optional(),
});

export function formatProblem(p: Problem): string {
  return `${p.file}${p.line === undefined ? "" : `:${p.line}`}: ${p.message}`;
}

/** `02-pydantic.md` -> `pydantic`, `03-toolkit` -> `toolkit`. */
export function stripPrefix(name: string): string {
  return name.replace(/\.md$/, "").replace(/^\d+-/, "");
}

/** One problem per failed field: `missing 'x'` when absent, else `invalid 'x': why`. */
export function metaProblems(
  file: string,
  schema: z.ZodType,
  data: Record<string, unknown>,
): Problem[] {
  const result = schema.safeParse(data);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const key = String(issue.path[0] ?? "");
    const value = data[key];
    const absent = value === undefined || value === null || value === "";
    return {
      file,
      message: absent ? `missing '${key}'` : `invalid '${key}': ${issue.message}`,
    };
  });
}

/** Resolves `stop-id` (same route) or `route-slug/stop-id`. */
export function resolveRef(
  routes: Route[],
  fromSlug: string,
  target: string,
): { slug: string; stop: Stop } | null {
  const [first, second] = target.split("/");
  const slug = second === undefined ? fromSlug : first;
  const id = second === undefined ? first : second;
  const route = routes.find((r) => r.slug === slug);
  const stop = route?.parts.flatMap((p) => p.stops).find((s) => s.id === id);
  return stop ? { slug, stop } : null;
}
```

- [ ] **Step 13: Create `content/loader.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import {
  PartMetaSchema,
  RouteMetaSchema,
  StopMetaSchema,
  metaProblems,
  stripPrefix,
  type Part,
  type Problem,
  type Route,
  type Stop,
} from "./model";

const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
const text = (v: unknown) => (typeof v === "string" ? v : "");

function subdirs(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort(byName);
}

function files(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort(byName);
}

interface Markdown {
  data: Record<string, unknown>;
  body: string;
  offset: number;
  error?: string;
}

function readMarkdown(file: string): Markdown {
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  try {
    const parsed = matter(raw);
    const offset = raw.split("\n").length - parsed.content.split("\n").length;
    return { data: parsed.data as Record<string, unknown>, body: parsed.content, offset };
  } catch (e) {
    return { data: {}, body: "", offset: 0, error: (e as Error).message.split("\n")[0] };
  }
}

export function loadSite(routesDir: string): { routes: Route[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const routes: Route[] = [];
  if (!fs.existsSync(routesDir)) return { routes, problems };
  const label = path.basename(routesDir);

  for (const slug of subdirs(routesDir)) {
    const dir = path.join(routesDir, slug);
    const rel = `${label}/${slug}`;
    const metaFile = path.join(dir, "route.yaml");
    if (!fs.existsSync(metaFile)) {
      problems.push({ file: rel, message: "missing route.yaml" });
      continue;
    }
    let raw: unknown;
    try {
      raw = parseYaml(fs.readFileSync(metaFile, "utf8"));
    } catch (e) {
      const why = (e as Error).message.split("\n")[0];
      problems.push({ file: `${rel}/route.yaml`, message: `invalid YAML: ${why}` });
      continue;
    }
    const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (data.draft === true) continue;

    problems.push(...metaProblems(`${rel}/route.yaml`, RouteMetaSchema, data));
    const meta = RouteMetaSchema.safeParse(data);
    const assetsDir = path.join(dir, "assets");

    const route: Route = {
      slug,
      title: meta.success ? meta.data.title : text(data.title),
      number: meta.success ? meta.data.number : typeof data.number === "number" ? data.number : 0,
      summary: meta.success ? meta.data.summary : text(data.summary),
      hero: meta.success ? meta.data.hero : text(data.hero),
      lede: meta.success ? meta.data.lede : text(data.lede),
      prerequisites: meta.success ? meta.data.prerequisites : [],
      checked: meta.success ? meta.data.checked : undefined,
      dir: rel,
      assets: fs.existsSync(assetsDir) ? files(assetsDir) : [],
      parts: [],
    };

    for (const partName of subdirs(dir)) {
      if (partName === "assets") continue;
      const part = loadPart(path.join(dir, partName), `${rel}/${partName}`, partName, problems);
      if (part) route.parts.push(part);
    }
    routes.push(route);
  }

  routes.sort((a, b) => a.number - b.number || byName(a.slug, b.slug));
  return { routes, problems };
}

function loadPart(dir: string, rel: string, name: string, problems: Problem[]): Part | null {
  const partFile = path.join(dir, "part.md");
  if (!fs.existsSync(partFile)) {
    problems.push({ file: rel, message: "missing part.md" });
    return null;
  }
  const md = readMarkdown(partFile);
  if (md.error) problems.push({ file: `${rel}/part.md`, message: `invalid front matter: ${md.error}` });
  else problems.push(...metaProblems(`${rel}/part.md`, PartMetaSchema, md.data));
  const meta = PartMetaSchema.safeParse(md.data);

  const part: Part = {
    id: stripPrefix(name),
    title: meta.success ? meta.data.title : text(md.data.title),
    goal: meta.success ? meta.data.goal : text(md.data.goal),
    kind: meta.success ? meta.data.kind : "part",
    intro: md.body,
    introOffset: md.offset,
    dir: rel,
    stops: [],
  };

  for (const fileName of files(dir)) {
    if (fileName === "part.md" || !fileName.endsWith(".md")) continue;
    part.stops.push(loadStop(path.join(dir, fileName), `${rel}/${fileName}`, fileName, part.kind, problems));
  }
  return part;
}

function loadStop(
  file: string,
  rel: string,
  name: string,
  kind: Part["kind"],
  problems: Problem[],
): Stop {
  const md = readMarkdown(file);
  if (md.error) problems.push({ file: rel, message: `invalid front matter: ${md.error}` });
  else problems.push(...metaProblems(rel, StopMetaSchema, md.data));
  const meta = StopMetaSchema.safeParse(md.data);
  const id = stripPrefix(name);
  return {
    id,
    title: meta.success ? meta.data.title : text(md.data.title),
    doneWhen: meta.success ? meta.data.done_when : undefined,
    body: md.body,
    bodyOffset: md.offset,
    isStep: kind === "capstone" && id.startsWith("step-"),
    file: rel,
  };
}
```

- [ ] **Step 14: Run the tests to verify they pass**

Run: `npm test -- tests/content/loader.test.ts`
Expected: PASS, 9 tests.

If the `bodyOffset` assertion fails, print `JSON.stringify(matter(raw).content)` for the first fixture stop to see whether gray-matter keeps a leading newline, and adjust only the offset arithmetic in `readMarkdown` so that `file line = body line + offset` holds.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "Add toolchain, content model and loader"
```

---

### Task 2: Validator and CLI

**Files:**
- Create: `content/markdown.ts`, `content/validate.ts`, `content/index.ts`, `content/cli.ts`
- Modify: `tests/helpers.ts` (append model builders)
- Create: `tests/content/validate.test.ts`, `tests/content/cli.test.ts`
- Create: `tests/fixtures/invalid-routes/bad/route.yaml`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  - `content/markdown.ts`: `REF: RegExp`, `parseMarkdown(md: string): Root`, `scanMarkdown(md: string): { fencesWithoutLang: number[]; refs: { target: string; line: number }[]; images: { url: string; line: number }[] }`, `isLocalUrl(url: string): boolean`
  - `content/validate.ts`: `validateSite(routes: Route[]): Problem[]`
  - `content/index.ts`: `checkContent(routesDir: string): { routes: Route[]; problems: Problem[] }`
  - `tests/helpers.ts`: `makeStop(id, over?)`, `makePart(id, stops, over?)`, `makeRoute(slug, parts, over?)`
- The CLI reads the routes folder from the `ROADMAP_ROUTES_DIR` environment variable, default `routes`.

- [ ] **Step 1: Append model builders to `tests/helpers.ts`**

```ts
import type { Part, Route, Stop } from "../content/model";

export function makeStop(id: string, over: Partial<Stop> = {}): Stop {
  return {
    id,
    title: id,
    body: "Text.\n",
    bodyOffset: 3,
    isStep: false,
    file: `routes/x/01-a/01-${id}.md`,
    ...over,
  };
}

export function makePart(id: string, stops: Stop[], over: Partial<Part> = {}): Part {
  return {
    id,
    title: id,
    goal: "g",
    kind: "part",
    intro: "",
    introOffset: 4,
    dir: `routes/x/01-${id}`,
    stops,
    ...over,
  };
}

export function makeRoute(slug: string, parts: Part[], over: Partial<Route> = {}): Route {
  return {
    slug,
    title: slug,
    number: 1,
    summary: "s",
    hero: "",
    lede: "",
    prerequisites: [],
    dir: `routes/${slug}`,
    assets: [],
    parts,
    ...over,
  };
}
```

Move the `import type` line to the top of the file with the other imports.

- [ ] **Step 2: Create the invalid fixture**

`tests/fixtures/invalid-routes/bad/route.yaml`:

```yaml
title: Bad route
number: 1
```

- [ ] **Step 3: Write the failing validator tests**

`tests/content/validate.test.ts`:

````ts
import { describe, expect, it } from "vitest";
import { checkContent } from "../../content/index";
import { formatProblem } from "../../content/model";
import { validateSite } from "../../content/validate";
import { FIXTURES, makePart, makeRoute, makeStop } from "../helpers";

const messages = (...routes: Parameters<typeof validateSite>[0]) =>
  validateSite(routes).map(formatProblem);

describe("validateSite", () => {
  it("accepts the fixture route", () => {
    expect(checkContent(FIXTURES).problems).toEqual([]);
  });

  it("rejects duplicate route numbers", () => {
    const a = makeRoute("a", [makePart("p", [makeStop("s")])]);
    const b = makeRoute("b", [makePart("p", [makeStop("s")])]);
    expect(messages(a, b)).toContain("routes/b/route.yaml: number 1 also used by 'a'");
  });

  it("rejects unknown prerequisites", () => {
    const a = makeRoute("a", [makePart("p", [makeStop("s")])], { prerequisites: ["z"] });
    expect(messages(a)).toContain("routes/a/route.yaml: unknown prerequisite 'z'");
  });

  it("rejects a route without parts and a part without stops", () => {
    expect(messages(makeRoute("a", []))).toContain("routes/a: route has no parts");
    const empty = makeRoute("x", [makePart("a", [])]);
    expect(messages(empty)).toContain("routes/x/01-a: part has no stops");
  });

  it("rejects duplicate part ids", () => {
    const route = makeRoute("x", [
      makePart("a", [makeStop("s")], { dir: "routes/x/01-a" }),
      makePart("a", [makeStop("t")], { dir: "routes/x/02-a" }),
    ]);
    expect(messages(route)).toContain("routes/x/02-a: part id 'a' also used by 01-a");
  });

  it("rejects duplicate stop ids within a route", () => {
    const route = makeRoute("x", [
      makePart("a", [makeStop("b", { file: "routes/x/01-a/01-b.md" })]),
      makePart("c", [makeStop("b", { file: "routes/x/02-c/03-b.md" })]),
    ]);
    expect(messages(route)).toContain(
      "routes/x/02-c/03-b.md: stop id 'b' also used by 01-a/01-b.md",
    );
  });

  it("requires done_when on capstone steps only", () => {
    const route = makeRoute("x", [
      makePart("cap", [
        makeStop("spec", { file: "routes/x/06-cap/01-spec.md" }),
        makeStop("step-1", { isStep: true, file: "routes/x/06-cap/03-step-1.md" }),
        makeStop("step-2", { isStep: true, doneWhen: "It works.", file: "routes/x/06-cap/04-step-2.md" }),
      ], { kind: "capstone" }),
    ]);
    expect(messages(route)).toEqual([
      "routes/x/06-cap/03-step-1.md: capstone step needs 'done_when'",
    ]);
  });

  it("reports code fences without a language at the file line", () => {
    const body = "Intro.\n\n```\nx = 1\n```\n";
    const route = makeRoute("x", [makePart("a", [makeStop("b", { body, bodyOffset: 3 })])]);
    expect(messages(route)).toContain("routes/x/01-a/01-b.md:6: code fence has no language");
  });

  it("reports unknown references at the file line", () => {
    const body = "One.\n\nSee [[pydantc]] and [[b]].\n";
    const route = makeRoute("x", [makePart("a", [makeStop("b", { body, bodyOffset: 3 })])]);
    expect(messages(route)).toEqual(["routes/x/01-a/01-b.md:6: unknown reference 'pydantc'"]);
  });

  it("resolves cross-route references", () => {
    const other = makeRoute("other", [makePart("p", [makeStop("intro")])], { number: 2 });
    const ok = makeRoute("x", [makePart("a", [makeStop("b", { body: "See [[other/intro]].\n" })])]);
    expect(messages(ok, other)).toEqual([]);
    const bad = makeRoute("x", [makePart("a", [makeStop("b", { body: "See [[other/nope]].\n" })])]);
    expect(messages(bad, other)).toEqual([
      "routes/x/01-a/01-b.md:4: unknown reference 'other/nope'",
    ]);
  });

  it("ignores references inside code", () => {
    const body = "Use `[[not-a-ref]]`.\n\n```text\n[[also-not]]\n```\n";
    const route = makeRoute("x", [makePart("a", [makeStop("b", { body })])]);
    expect(messages(route)).toEqual([]);
  });

  it("reports missing assets and ignores external images", () => {
    const body = "![A](flow.svg)\n\n![B](gone.png)\n\n![C](https://example.com/c.png)\n";
    const route = makeRoute(
      "x",
      [makePart("a", [makeStop("b", { body, bodyOffset: 3 })])],
      { assets: ["flow.svg"] },
    );
    expect(messages(route)).toEqual(["routes/x/01-a/01-b.md:6: missing asset 'gone.png'"]);
  });

  it("checks part intros too", () => {
    const route = makeRoute("x", [
      makePart("a", [makeStop("b")], { intro: "See [[nope]].\n", introOffset: 4 }),
    ]);
    expect(messages(route)).toEqual(["routes/x/01-a/part.md:5: unknown reference 'nope'"]);
  });

  it("reports every problem, not just the first", () => {
    const route = makeRoute(
      "x",
      [makePart("a", [makeStop("b", { body: "```\nx\n```\n\n[[nope]]\n" })])],
      { prerequisites: ["z"] },
    );
    expect(messages(route)).toHaveLength(3);
  });
});
````

- [ ] **Step 4: Write the failing CLI tests**

`tests/content/cli.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(routesDir: string) {
  return spawnSync("npx tsx content/cli.ts", {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, ROADMAP_ROUTES_DIR: routesDir },
  });
}

describe("validate CLI", () => {
  it("exits 0 and reports counts for valid content", () => {
    const result = run("tests/fixtures/routes");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK: 1 route(s), 4 stop(s).");
  });

  it("exits 1 and prints each problem for invalid content", () => {
    const result = run("tests/fixtures/invalid-routes");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid-routes/bad/route.yaml: missing 'summary'");
    expect(result.stderr).toContain("invalid-routes/bad: route has no parts");
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test -- tests/content/validate.test.ts tests/content/cli.test.ts`
Expected: FAIL, cannot resolve `../../content/index`.

- [ ] **Step 6: Create `content/markdown.ts`**

```ts
import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/** `[[stop-id]]` or `[[route-slug/stop-id]]`. */
export const REF = /\[\[([a-z0-9-]+(?:\/[a-z0-9-]+)?)\]\]/g;

/** True for image paths that point into the route's assets folder. */
export function isLocalUrl(url: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(url);
}

export function parseMarkdown(md: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(md) as Root;
}

export interface Scan {
  fencesWithoutLang: number[];
  refs: { target: string; line: number }[];
  images: { url: string; line: number }[];
}

/** Line numbers are 1-based within `md`. */
export function scanMarkdown(md: string): Scan {
  const scan: Scan = { fencesWithoutLang: [], refs: [], images: [] };
  visit(parseMarkdown(md), (node) => {
    const line = node.position?.start.line ?? 1;
    if (node.type === "code" && !node.lang) scan.fencesWithoutLang.push(line);
    if (node.type === "image" && isLocalUrl(node.url)) scan.images.push({ url: node.url, line });
    if (node.type === "text") {
      for (const match of node.value.matchAll(REF)) {
        const before = node.value.slice(0, match.index).split("\n").length - 1;
        scan.refs.push({ target: match[1], line: line + before });
      }
    }
  });
  return scan;
}
```

- [ ] **Step 7: Create `content/validate.ts`**

```ts
import { scanMarkdown } from "./markdown";
import { resolveRef, type Problem, type Route } from "./model";

export function validateSite(routes: Route[]): Problem[] {
  const out: Problem[] = [];
  const slugs = new Set(routes.map((r) => r.slug));
  const numbers = new Map<number, string>();

  for (const route of routes) {
    const metaFile = `${route.dir}/route.yaml`;
    const within = (p: string) => p.slice(route.dir.length + 1);

    if (route.number > 0) {
      const other = numbers.get(route.number);
      if (other) out.push({ file: metaFile, message: `number ${route.number} also used by '${other}'` });
      else numbers.set(route.number, route.slug);
    }
    for (const pre of route.prerequisites) {
      if (!slugs.has(pre)) out.push({ file: metaFile, message: `unknown prerequisite '${pre}'` });
    }
    if (route.parts.length === 0) out.push({ file: route.dir, message: "route has no parts" });

    const scan = (file: string, md: string, offset: number) => {
      const found = scanMarkdown(md);
      for (const line of found.fencesWithoutLang) {
        out.push({ file, line: line + offset, message: "code fence has no language" });
      }
      for (const ref of found.refs) {
        if (!resolveRef(routes, route.slug, ref.target)) {
          out.push({ file, line: ref.line + offset, message: `unknown reference '${ref.target}'` });
        }
      }
      for (const image of found.images) {
        if (!route.assets.includes(image.url)) {
          out.push({ file, line: image.line + offset, message: `missing asset '${image.url}'` });
        }
      }
    };

    const partIds = new Map<string, string>();
    const stopIds = new Map<string, string>();
    for (const part of route.parts) {
      const seenPart = partIds.get(part.id);
      if (seenPart) out.push({ file: part.dir, message: `part id '${part.id}' also used by ${seenPart}` });
      else partIds.set(part.id, within(part.dir));

      if (part.stops.length === 0) out.push({ file: part.dir, message: "part has no stops" });
      if (part.intro.trim()) scan(`${part.dir}/part.md`, part.intro, part.introOffset);

      for (const stop of part.stops) {
        const seenStop = stopIds.get(stop.id);
        if (seenStop) out.push({ file: stop.file, message: `stop id '${stop.id}' also used by ${seenStop}` });
        else stopIds.set(stop.id, within(stop.file));

        if (stop.isStep && !stop.doneWhen) {
          out.push({ file: stop.file, message: "capstone step needs 'done_when'" });
        }
        scan(stop.file, stop.body, stop.bodyOffset);
      }
    }
  }
  return out;
}
```

- [ ] **Step 8: Create `content/index.ts`**

```ts
import { loadSite } from "./loader";
import type { Problem, Route } from "./model";
import { validateSite } from "./validate";

export function checkContent(routesDir: string): { routes: Route[]; problems: Problem[] } {
  const { routes, problems } = loadSite(routesDir);
  return { routes, problems: [...problems, ...validateSite(routes)] };
}
```

- [ ] **Step 9: Create `content/cli.ts`**

```ts
import { checkContent } from "./index";
import { formatProblem } from "./model";

const dir = process.env.ROADMAP_ROUTES_DIR ?? "routes";
const { routes, problems } = checkContent(dir);

if (problems.length > 0) {
  for (const problem of problems) console.error(formatProblem(problem));
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}

const stops = routes.reduce(
  (n, route) => n + route.parts.reduce((m, part) => m + part.stops.length, 0),
  0,
);
console.log(`OK: ${routes.length} route(s), ${stops} stop(s).`);
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npm test -- tests/content`
Expected: PASS, all loader, validator and CLI tests.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "Add content validator and validate command"
```

---

### Task 3: Markdown renderer and view models

**Files:**
- Create: `content/theme.ts`, `content/render.ts`, `content/view.ts`, `content/copy-assets.ts`
- Create: `tests/content/render.test.ts`, `tests/content/view.test.ts`

**Interfaces:**
- Consumes: `Route`, `resolveRef` from `content/model.ts`; `REF`, `isLocalUrl` from `content/markdown.ts`; `loadSite` from `content/loader.ts`.
- Produces (from `content/render.ts`):
  - `interface RenderContext { resolveRef(target: string): { href: string; title: string } | null; assetUrl(file: string): string }`
  - `renderMarkdown(md: string, ctx: RenderContext): Promise<string>`
- Produces (from `content/view.ts`):
  - `interface StopView { id: string; title: string; html: string; doneWhenHtml: string | null; isStep: boolean }`
  - `interface PartView { id: string; title: string; goal: string; kind: "part" | "capstone"; number: number | null; introHtml: string; stops: StopView[] }`
  - `interface RouteView { slug: string; title: string; number: number; summary: string; hero: string; lede: string; checked: string | null; parts: PartView[] }`
  - `interface RouteSummary { slug: string; title: string; number: number; summary: string; partCount: number; stops: { id: string; title: string }[]; prerequisites: { slug: string; title: string }[] }`
  - `toSummary(route: Route, routes: Route[]): RouteSummary`
  - `toView(route: Route, routes: Route[], base: string): Promise<RouteView>` where `base` ends with `/`
- HTML contract that the CSS in Task 7 relies on:
  - code block: `<figure class="code"><figcaption>title</figcaption><button class="copy" type="button">Copy</button><pre class="shiki ...">...</pre></figure>` (no `figcaption` when the fence has no title)
  - callout: `<div class="callout callout-note"><p><strong class="callout-label">Note</strong> text</p></div>`, and `callout-warning` with label `Warning`
  - reference: `<a href="..." class="ref">Target title</a>`
- `PartView.number` counts only non-capstone parts, starting at 1. Capstone parts have `number: null`.

- [ ] **Step 1: Write the failing renderer tests**

`tests/content/render.test.ts`:

````ts
import { describe, expect, it } from "vitest";
import { renderMarkdown, type RenderContext } from "../../content/render";

const ctx: RenderContext = {
  resolveRef(target) {
    if (target === "first-stop") return { href: "#first-stop", title: "First stop" };
    if (target === "other/intro") return { href: "/other/#intro", title: "Intro" };
    return null;
  },
  assetUrl: (file) => `/route-assets/sample/${file}`,
};

const render = async (md: string) => (await renderMarkdown(md, ctx)).trim();

describe("renderMarkdown", () => {
  it("renders paragraphs and inline code", async () => {
    expect(await render("Use `HttpUrl` here.")).toBe("<p>Use <code>HttpUrl</code> here.</p>");
  });

  it("renders a note callout without the marker", async () => {
    const html = await render("> [!NOTE]\n> Notes look like this.");
    expect(html).toContain('<div class="callout callout-note">');
    expect(html).toContain('<strong class="callout-label">Note</strong> Notes look like this.');
    expect(html).not.toContain("[!NOTE]");
    expect(html).not.toContain("<blockquote>");
  });

  it("renders a warning callout", async () => {
    const html = await render("> [!WARNING]\n> Careful.");
    expect(html).toContain('<div class="callout callout-warning">');
    expect(html).toContain('<strong class="callout-label">Warning</strong> Careful.');
  });

  it("leaves an ordinary blockquote alone", async () => {
    expect(await render("> Just a quote.")).toContain("<blockquote>");
  });

  it("renders a highlighted code block with a title and copy button", async () => {
    const html = await render('```python title="app/main.py"\ndef greet():\n    return 1\n```');
    expect(html).toContain('<figure class="code"><figcaption>app/main.py</figcaption>');
    expect(html).toContain('<button class="copy" type="button">Copy</button>');
    expect(html).toMatch(/<pre class="shiki/);
    expect(html).toMatch(/<span style="color:/);
    expect(html).toContain("greet");
  });

  it("omits the caption when the fence has no title", async () => {
    const html = await render("```bash\nls\n```");
    expect(html).toContain('<figure class="code"><button class="copy"');
    expect(html).not.toContain("<figcaption>");
  });

  it("falls back to plain text for an unknown language", async () => {
    const html = await render("```nosuchlang\nx = 1 < 2\n```");
    expect(html).toContain('<figure class="code">');
    expect(html).toContain("x = 1");
    expect(html).not.toContain("< 2");
  });

  it("renders tables", async () => {
    const html = await render("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  it("turns references into links titled after the target", async () => {
    const html = await render("See [[first-stop]] and [[other/intro]].");
    expect(html).toContain('href="#first-stop"');
    expect(html).toContain(">First stop</a>");
    expect(html).toContain('href="/other/#intro"');
    expect(html).toContain(">Intro</a>");
    expect(html).toContain('class="ref"');
    expect(html).not.toContain("[[");
  });

  it("leaves unknown references as text", async () => {
    expect(await render("See [[nope]].")).toBe("<p>See [[nope]].</p>");
  });

  it("does not turn references inside code into links", async () => {
    expect(await render("Write `[[first-stop]]`.")).toContain("<code>[[first-stop]]</code>");
  });

  it("rewrites local image paths and keeps external ones", async () => {
    const html = await render("![Flow](flow.svg)\n\n![X](https://example.com/x.png)");
    expect(html).toContain('src="/route-assets/sample/flow.svg"');
    expect(html).toContain('src="https://example.com/x.png"');
  });

  it("never emits raw HTML from the source", async () => {
    const html = await render('<script>alert(1)</script>\n\nHi <b onclick="x()">there</b>.');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b");
    expect(html).toContain("alert(1)");
    expect(html).toContain("there");
  });
});
````

- [ ] **Step 2: Write the failing view tests**

`tests/content/view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadSite } from "../../content/loader";
import { toSummary, toView } from "../../content/view";
import { FIXTURES, makePart, makeRoute, makeStop } from "../helpers";

describe("toSummary", () => {
  it("lists stops in order and counts parts", () => {
    const { routes } = loadSite(FIXTURES);
    const summary = toSummary(routes[0], routes);
    expect(summary.slug).toBe("sample");
    expect(summary.partCount).toBe(2);
    expect(summary.stops).toEqual([
      { id: "first-stop", title: "First stop" },
      { id: "second-stop", title: "Second stop" },
      { id: "spec", title: "The spec" },
      { id: "step-1", title: "Step 1: greet" },
    ]);
    expect(summary.prerequisites).toEqual([]);
  });

  it("resolves prerequisite titles", () => {
    const a = makeRoute("a", [makePart("p", [makeStop("s")])], { title: "Route A" });
    const b = makeRoute("b", [makePart("p", [makeStop("s")])], { number: 2, prerequisites: ["a"] });
    expect(toSummary(b, [a, b]).prerequisites).toEqual([{ slug: "a", title: "Route A" }]);
  });
});

describe("toView", () => {
  it("renders the fixture with part numbers, references and assets", async () => {
    const { routes } = loadSite(FIXTURES);
    const view = await toView(routes[0], routes, "/sub/");
    expect(view.checked).toBe("2026-10");
    expect(view.parts.map((p) => p.number)).toEqual([1, null]);
    const [first, second] = view.parts[0].stops;
    expect(first.html).toContain('<figure class="code">');
    expect(first.doneWhenHtml).toBeNull();
    expect(second.html).toContain('href="#first-stop"');
    expect(second.html).toContain('src="/sub/route-assets/sample/flow.svg"');
    const step = view.parts[1].stops[1];
    expect(step.isStep).toBe(true);
    expect(step.doneWhenHtml?.trim()).toBe("<p>The page shows the greeting.</p>");
  });

  it("links cross-route references through the base path", async () => {
    const other = makeRoute("other", [makePart("p", [makeStop("intro", { title: "Intro" })])], { number: 2 });
    const route = makeRoute("x", [makePart("a", [makeStop("b", { body: "See [[other/intro]].\n" })])]);
    const view = await toView(route, [route, other], "/sub/");
    expect(view.parts[0].stops[0].html).toContain('href="/sub/other/#intro"');
  });

  it("renders an empty intro as an empty string", async () => {
    const route = makeRoute("x", [makePart("a", [makeStop("b")], { intro: "\n" })]);
    expect((await toView(route, [route], "/")).parts[0].introHtml).toBe("");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- tests/content/render.test.ts tests/content/view.test.ts`
Expected: FAIL, cannot resolve `../../content/render`.

- [ ] **Step 4: Create `content/theme.ts`**

Blue plus greys only, to stay within the one-accent rule.

```ts
export const codeTheme = {
  name: "roadmap-dark",
  type: "dark" as const,
  colors: {
    "editor.background": "#1d1d1f",
    "editor.foreground": "#f5f5f7",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#86868b", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "storage", "storage.type", "keyword.control", "constant.language"],
      settings: { foreground: "#2997ff" },
    },
    {
      scope: ["string", "string.quoted", "constant.numeric"],
      settings: { foreground: "#a1c9f7" },
    },
    {
      scope: ["entity.name.function", "entity.name.type", "entity.name.class", "support.function"],
      settings: { foreground: "#ffffff" },
    },
    {
      scope: ["variable.parameter", "punctuation", "meta.brace"],
      settings: { foreground: "#d2d2d7" },
    },
  ],
};
```

- [ ] **Step 5: Create `content/render.ts`**

Raw HTML nodes from the source are converted to text first. The code plugin then inserts its own trusted HTML, which is why `allowDangerousHtml` is safe to enable afterwards. Keep the plugin order exactly as written.

```ts
import type { Blockquote, Code, Html, Image, Paragraph, PhrasingContent, Root, Text } from "mdast";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { codeToHtml } from "shiki";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { REF, isLocalUrl } from "./markdown";
import { codeTheme } from "./theme";

export interface RenderContext {
  resolveRef(target: string): { href: string; title: string } | null;
  assetUrl(file: string): string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FLOW_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

function remarkEscapeHtml() {
  return (tree: Root) => {
    visit(tree, "html", (node: Html, index, parent) => {
      if (!parent || index === undefined) return;
      const text: Text = { type: "text", value: node.value };
      const replacement = FLOW_PARENTS.has(parent.type)
        ? ({ type: "paragraph", children: [text] } satisfies Paragraph)
        : text;
      (parent.children as unknown[])[index] = replacement;
    });
  };
}

const CALLOUT = /^\[!(NOTE|WARNING)\]\s*/;

function remarkCallouts() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const first = node.children[0];
      if (first?.type !== "paragraph") return;
      const head = first.children[0];
      if (head?.type !== "text") return;
      const match = CALLOUT.exec(head.value);
      if (!match) return;
      head.value = head.value.slice(match[0].length);
      const kind = match[1].toLowerCase();
      first.children.unshift(
        {
          type: "strong",
          data: { hProperties: { className: ["callout-label"] } },
          children: [{ type: "text", value: kind === "note" ? "Note" : "Warning" }],
        },
        { type: "text", value: " " },
      );
      node.data = { hName: "div", hProperties: { className: ["callout", `callout-${kind}`] } };
    });
  };
}

function remarkRefs(ctx: RenderContext) {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined || parent.type === "link") return;
      const pieces: PhrasingContent[] = [];
      let last = 0;
      for (const match of node.value.matchAll(REF)) {
        const hit = ctx.resolveRef(match[1]);
        if (!hit) continue;
        if (match.index > last) pieces.push({ type: "text", value: node.value.slice(last, match.index) });
        pieces.push({
          type: "link",
          url: hit.href,
          data: { hProperties: { className: ["ref"] } },
          children: [{ type: "text", value: hit.title }],
        });
        last = match.index + match[0].length;
      }
      if (pieces.length === 0) return;
      if (last < node.value.length) pieces.push({ type: "text", value: node.value.slice(last) });
      (parent.children as PhrasingContent[]).splice(index, 1, ...pieces);
      return [SKIP, index + pieces.length];
    });
  };
}

function remarkImages(ctx: RenderContext) {
  return (tree: Root) => {
    visit(tree, "image", (node: Image) => {
      if (isLocalUrl(node.url)) node.url = ctx.assetUrl(node.url);
    });
  };
}

async function highlight(code: string, lang: string): Promise<string> {
  try {
    return await codeToHtml(code, { lang, theme: codeTheme });
  } catch {
    return await codeToHtml(code, { lang: "text", theme: codeTheme });
  }
}

function remarkCode() {
  return async (tree: Root) => {
    const jobs: Promise<void>[] = [];
    visit(tree, "code", (node: Code, index, parent) => {
      if (!parent || index === undefined) return;
      jobs.push(
        (async () => {
          const title = /title="([^"]*)"/.exec(node.meta ?? "")?.[1];
          const pre = await highlight(node.value, node.lang ?? "text");
          const caption = title ? `<figcaption>${escapeHtml(title)}</figcaption>` : "";
          const html: Html = {
            type: "html",
            value: `<figure class="code">${caption}<button class="copy" type="button">Copy</button>${pre}</figure>`,
          };
          (parent.children as unknown[])[index] = html;
        })(),
      );
    });
    await Promise.all(jobs);
  };
}

export async function renderMarkdown(md: string, ctx: RenderContext): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkEscapeHtml)
    .use(remarkCallouts)
    .use(remarkRefs, ctx)
    .use(remarkImages, ctx)
    .use(remarkCode)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(md);
  return String(file);
}
```

- [ ] **Step 6: Create `content/view.ts`**

```ts
import { resolveRef, type Route } from "./model";
import { renderMarkdown, type RenderContext } from "./render";

export interface StopView {
  id: string;
  title: string;
  html: string;
  doneWhenHtml: string | null;
  isStep: boolean;
}

export interface PartView {
  id: string;
  title: string;
  goal: string;
  kind: "part" | "capstone";
  number: number | null;
  introHtml: string;
  stops: StopView[];
}

export interface RouteView {
  slug: string;
  title: string;
  number: number;
  summary: string;
  hero: string;
  lede: string;
  checked: string | null;
  parts: PartView[];
}

export interface RouteSummary {
  slug: string;
  title: string;
  number: number;
  summary: string;
  partCount: number;
  stops: { id: string; title: string }[];
  prerequisites: { slug: string; title: string }[];
}

export function toSummary(route: Route, routes: Route[]): RouteSummary {
  return {
    slug: route.slug,
    title: route.title,
    number: route.number,
    summary: route.summary,
    partCount: route.parts.length,
    stops: route.parts.flatMap((p) => p.stops.map((s) => ({ id: s.id, title: s.title }))),
    prerequisites: route.prerequisites.flatMap((slug) => {
      const other = routes.find((r) => r.slug === slug);
      return other ? [{ slug, title: other.title }] : [];
    }),
  };
}

/** `base` is the site base path and must end with `/`. */
export async function toView(route: Route, routes: Route[], base: string): Promise<RouteView> {
  const ctx: RenderContext = {
    resolveRef(target) {
      const hit = resolveRef(routes, route.slug, target);
      if (!hit) return null;
      const anchor = `#${hit.stop.id}`;
      const href = hit.slug === route.slug ? anchor : `${base}${hit.slug}/${anchor}`;
      return { href, title: hit.stop.title };
    },
    assetUrl: (file) => `${base}route-assets/${route.slug}/${file}`,
  };

  let number = 0;
  const parts: PartView[] = [];
  for (const part of route.parts) {
    const stops = await Promise.all(
      part.stops.map(async (stop) => ({
        id: stop.id,
        title: stop.title,
        html: await renderMarkdown(stop.body, ctx),
        doneWhenHtml: stop.doneWhen ? await renderMarkdown(stop.doneWhen, ctx) : null,
        isStep: stop.isStep,
      })),
    );
    parts.push({
      id: part.id,
      title: part.title,
      goal: part.goal,
      kind: part.kind,
      number: part.kind === "capstone" ? null : ++number,
      introHtml: part.intro.trim() ? await renderMarkdown(part.intro, ctx) : "",
      stops,
    });
  }

  return {
    slug: route.slug,
    title: route.title,
    number: route.number,
    summary: route.summary,
    hero: route.hero,
    lede: route.lede,
    checked: route.checked ?? null,
    parts,
  };
}
```

- [ ] **Step 7: Create `content/copy-assets.ts`**

Copies each route's `assets/` folder to `public/route-assets/<slug>/`, which Vite serves in dev and copies into the build.

```ts
import fs from "node:fs";
import path from "node:path";

const routesDir = process.env.ROADMAP_ROUTES_DIR ?? "routes";
const out = path.resolve("public/route-assets");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

if (fs.existsSync(routesDir)) {
  for (const entry of fs.readdirSync(routesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(routesDir, entry.name, "assets");
    if (fs.existsSync(src)) fs.cpSync(src, path.join(out, entry.name), { recursive: true });
  }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- tests/content`
Expected: PASS.

If the raw-HTML test fails, the plugin order in `renderMarkdown` has been changed; restore it. If Shiki rejects the theme object, read the "custom themes" page of the installed Shiki version and adjust only `content/theme.ts`.

- [ ] **Step 9: Verify the asset copy**

Run (Git Bash): `ROADMAP_ROUTES_DIR=tests/fixtures/routes npm run assets && ls public/route-assets/sample`
Expected: `flow.svg`

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Add Markdown renderer and view models"
```

---

### Task 4: Progress store

**Files:**
- Create: `app/state/progress.ts`
- Create: `tests/state/progress.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (from `app/state/progress.ts`):
  - `STORAGE_KEY = "roadmap:progress:v1"`
  - `useProgress`: Zustand hook with state `{ done: Record<string, string[]>; lastRoute: string | null; toggle(slug: string, stopId: string): void; visit(slug: string): void }`
  - `whenHydrated(fn: () => void): () => void` runs `fn` once the store has been rehydrated from storage, and returns a cancel function
  - `countDone(done: string[] | undefined, stopIds: string[]): number`
  - `nextStop<T extends { id: string }>(done: string[] | undefined, stops: T[]): T | null`
- The store is created with `skipHydration: true`. The app calls `useProgress.persist.rehydrate()` once in an effect (Task 6), so server HTML and the first client render match.
- **Rule for all later tasks:** any state change that is not a direct user click must go through `whenHydrated`. A change made before rehydration would write the empty default state over the saved progress.

- [ ] **Step 1: Write the failing tests**

`tests/state/progress.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "roadmap:progress:v1";

/** A fresh, not-yet-hydrated copy of the store module. */
async function fresh() {
  vi.resetModules();
  return await import("../../app/state/progress");
}

const stored = (state: unknown) => JSON.stringify({ state, version: 0 });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("progress store", () => {
  it("marks and unmarks a stop and records the last route", async () => {
    const { useProgress } = await fresh();
    await useProgress.persist.rehydrate();
    useProgress.getState().toggle("a", "s1");
    expect(useProgress.getState().done).toEqual({ a: ["s1"] });
    expect(useProgress.getState().lastRoute).toBe("a");
    useProgress.getState().toggle("a", "s1");
    expect(useProgress.getState().done).toEqual({ a: [] });
  });

  it("persists under the versioned key and restores on rehydrate", async () => {
    const first = await fresh();
    await first.useProgress.persist.rehydrate();
    first.useProgress.getState().toggle("a", "s1");
    expect(JSON.parse(localStorage.getItem(KEY)!).state.done).toEqual({ a: ["s1"] });

    const second = await fresh();
    expect(second.useProgress.getState().done).toEqual({});
    await second.useProgress.persist.rehydrate();
    expect(second.useProgress.getState().done).toEqual({ a: ["s1"] });
    expect(second.useProgress.getState().lastRoute).toBe("a");
  });

  it("survives corrupt JSON in storage", async () => {
    localStorage.setItem(KEY, "{not json");
    const { useProgress } = await fresh();
    await useProgress.persist.rehydrate();
    expect(useProgress.getState().done).toEqual({});
    useProgress.getState().toggle("a", "s1");
    expect(useProgress.getState().done).toEqual({ a: ["s1"] });
  });

  it("discards wrongly shaped stored data", async () => {
    localStorage.setItem(KEY, stored({ done: { a: "oops", b: ["s1", 7] }, lastRoute: 5 }));
    const { useProgress } = await fresh();
    await useProgress.persist.rehydrate();
    expect(useProgress.getState().done).toEqual({ b: ["s1"] });
    expect(useProgress.getState().lastRoute).toBeNull();

    localStorage.setItem(KEY, stored({ done: ["x"], lastRoute: "a" }));
    const again = await fresh();
    await again.useProgress.persist.rehydrate();
    expect(again.useProgress.getState().done).toEqual({});
    expect(again.useProgress.getState().lastRoute).toBe("a");
  });

  it("does not wipe saved progress when a change is requested before rehydration", async () => {
    localStorage.setItem(KEY, stored({ done: { a: ["s1"] }, lastRoute: "a" }));
    const { useProgress, whenHydrated } = await fresh();
    whenHydrated(() => useProgress.getState().visit("b"));
    expect(JSON.parse(localStorage.getItem(KEY)!).state.done).toEqual({ a: ["s1"] });

    await useProgress.persist.rehydrate();
    expect(useProgress.getState().done).toEqual({ a: ["s1"] });
    expect(useProgress.getState().lastRoute).toBe("b");
    expect(JSON.parse(localStorage.getItem(KEY)!).state.done).toEqual({ a: ["s1"] });
  });

  it("runs whenHydrated immediately once hydrated, and can be cancelled before", async () => {
    const { useProgress, whenHydrated } = await fresh();
    const early = vi.fn();
    const cancel = whenHydrated(early);
    cancel();
    await useProgress.persist.rehydrate();
    expect(early).not.toHaveBeenCalled();

    const late = vi.fn();
    whenHydrated(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("keeps working when storage refuses writes", async () => {
    const { useProgress } = await fresh();
    await useProgress.persist.rehydrate();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => useProgress.getState().toggle("a", "s1")).not.toThrow();
    expect(useProgress.getState().done).toEqual({ a: ["s1"] });
  });
});

describe("helpers", () => {
  it("countDone ignores ids that no longer exist", async () => {
    const { countDone } = await fresh();
    expect(countDone(["s1", "gone", "s3"], ["s1", "s2", "s3"])).toBe(2);
    expect(countDone(undefined, ["s1"])).toBe(0);
  });

  it("nextStop returns the first stop not done, or null", async () => {
    const { nextStop } = await fresh();
    const stops = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
    expect(nextStop(["s1", "s3"], stops)).toEqual({ id: "s2" });
    expect(nextStop(undefined, stops)).toEqual({ id: "s1" });
    expect(nextStop(["s1", "s2", "s3"], stops)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/state/progress.test.ts`
Expected: FAIL, cannot resolve `../../app/state/progress`.

- [ ] **Step 3: Create `app/state/progress.ts`**

```ts
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export const STORAGE_KEY = "roadmap:progress:v1";

interface ProgressData {
  /** Done stop ids per route slug. */
  done: Record<string, string[]>;
  /** Slug of the route the reader opened or changed most recently. */
  lastRoute: string | null;
}

interface ProgressState extends ProgressData {
  toggle: (slug: string, stopId: string) => void;
  visit: (slug: string) => void;
}

/** localStorage that never throws: missing, blocked, full or corrupt all read as empty. */
const safeStorage: StateStorage = {
  getItem(name) {
    try {
      const value = localStorage.getItem(name);
      if (value !== null) JSON.parse(value);
      return value;
    } catch {
      return null;
    }
  },
  setItem(name, value) {
    try {
      localStorage.setItem(name, value);
    } catch {
      // Progress simply does not persist.
    }
  },
  removeItem(name) {
    try {
      localStorage.removeItem(name);
    } catch {
      // Nothing to do.
    }
  },
};

/** Keeps only correctly shaped data from whatever was stored. */
function clean(persisted: unknown): ProgressData {
  const p = (persisted && typeof persisted === "object" ? persisted : {}) as Record<string, unknown>;
  const done: Record<string, string[]> = {};
  if (p.done && typeof p.done === "object" && !Array.isArray(p.done)) {
    for (const [slug, ids] of Object.entries(p.done)) {
      if (Array.isArray(ids)) done[slug] = ids.filter((id): id is string => typeof id === "string");
    }
  }
  return { done, lastRoute: typeof p.lastRoute === "string" ? p.lastRoute : null };
}

export const useProgress = create<ProgressState>()(
  persist(
    (set) => ({
      done: {},
      lastRoute: null,
      toggle: (slug, stopId) =>
        set((state) => {
          const current = state.done[slug] ?? [];
          const next = current.includes(stopId)
            ? current.filter((id) => id !== stopId)
            : [...current, stopId];
          return { done: { ...state.done, [slug]: next }, lastRoute: slug };
        }),
      visit: (slug) => set({ lastRoute: slug }),
    }),
    {
      name: STORAGE_KEY,
      version: 0,
      storage: createJSONStorage(() => safeStorage),
      skipHydration: true,
      partialize: (state) => ({ done: state.done, lastRoute: state.lastRoute }),
      merge: (persisted, current) => ({ ...current, ...clean(persisted) }),
    },
  ),
);

/** Runs `fn` once saved progress has been loaded. Returns a cancel function. */
export function whenHydrated(fn: () => void): () => void {
  if (useProgress.persist.hasHydrated()) {
    fn();
    return () => {};
  }
  let cancelled = false;
  const stop = useProgress.persist.onFinishHydration(() => {
    stop();
    if (!cancelled) fn();
  });
  return () => {
    cancelled = true;
    stop();
  };
}

export function countDone(done: string[] | undefined, stopIds: string[]): number {
  if (!done) return 0;
  const set = new Set(done);
  return stopIds.filter((id) => set.has(id)).length;
}

export function nextStop<T extends { id: string }>(done: string[] | undefined, stops: T[]): T | null {
  const set = new Set(done ?? []);
  return stops.find((stop) => !set.has(stop.id)) ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/state/progress.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add progress store with safe persistence"
```

---

### Task 5: Sample route

**Files:**
- Create: `routes/git-basics/route.yaml` and the eight Markdown files below

**Interfaces:**
- Consumes: the content conventions enforced by Tasks 1 and 2.
- Produces: a real route with slug `git-basics`, 2 parts plus a capstone, 7 stops. Later tasks use it for the pages and the design checkpoint. Stop ids: `init`, `commit`, `history`, `branch`, `remote`, `spec`, `step-1`.

- [ ] **Step 1: Create `routes/git-basics/route.yaml`**

```yaml
title: Git basics
number: 1
summary: "Track changes, branch, and publish a project to GitHub. Capstone: put a project of your own online."
hero: From a folder to a repository on GitHub.
lede: Seven short stops. Each one is one idea with commands you can run.
prerequisites: []
checked: 2026-10
```

- [ ] **Step 2: Create part 1**

`routes/git-basics/01-local/part.md`:

```markdown
---
title: Work locally
goal: Turn a folder into a repository and record changes in it.
---
```

`routes/git-basics/01-local/01-init.md`:

````markdown
---
title: Create a repository
---
A repository is a folder whose history Git records. `git init` creates the hidden `.git` folder that holds that history. Nothing leaves your machine.

```bash
mkdir notes
cd notes
git init -b main
git status
```

`git status` is the command to run whenever you are unsure what state things are in.

> [!NOTE]
> Tell Git who you are once per machine: `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`. Every commit records both.
````

`routes/git-basics/01-local/02-commit.md`:

````markdown
---
title: Stage and commit
---
A commit is a snapshot of the files you chose. Choosing is called staging: `git add` puts changes in the staging area, and `git commit` records exactly what is staged.

```bash
echo "# Notes" > README.md
git add README.md
git commit -m "Add README"
```

Staging lets one commit hold one idea even when you changed several things. Use `git add .` to stage everything in the current folder.

| Command | Does |
|---|---|
| `git add <file>` | Stage one file |
| `git add .` | Stage every change under the current folder |
| `git restore --staged <file>` | Unstage, keeping your edits |
| `git commit -m "message"` | Record what is staged |
````

`routes/git-basics/01-local/03-history.md`:

````markdown
---
title: Read history
---
Three commands answer most questions about what happened.

```bash
git log --oneline        # one line per commit, newest first
git diff                 # changes you have not staged yet
git diff --staged        # changes staged for the next commit
git show <hash>          # one commit in full
```

Each commit has a hash such as `4a6b16f`. The first seven characters are enough to name it.
````

- [ ] **Step 3: Create part 2**

`routes/git-basics/02-share/part.md`:

```markdown
---
title: Branch and share
goal: Work on a branch, merge it, and push the result to GitHub.
---
```

`routes/git-basics/02-share/01-branch.md`:

````markdown
---
title: Branches
---
A branch is a movable name for a line of commits. Work on a branch so that `main` always holds something that works.

```bash
git switch -c add-license      # create a branch and move to it
echo "MIT" > LICENSE
git add LICENSE
git commit -m "Add license"
git switch main
git merge add-license
git branch -d add-license      # delete the merged branch
```

Commits on the branch are made exactly as in [[commit]]. Merging brings them into `main`.
````

`routes/git-basics/02-share/02-remote.md`:

````markdown
---
title: Remotes and push
---
A remote is a copy of the repository somewhere else. By convention the main one is called `origin`. Create an empty repository on GitHub first, then connect and push.

```bash
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

`-u` links your local `main` to `origin/main`, so later a plain `git push` or `git pull` is enough.

```bash
git pull        # fetch new commits from the remote and merge them
git push        # send your new commits
```

> [!WARNING]
> Do not force-push a branch other people use. It rewrites history they already have.
````

- [ ] **Step 4: Create the capstone**

`routes/git-basics/03-capstone/part.md`:

```markdown
---
title: "Capstone: publish a project"
goal: Put a project of your own on GitHub, with a history you can read.
kind: capstone
---
```

`routes/git-basics/03-capstone/01-spec.md`:

```markdown
---
title: The spec
---
Take any small project folder on your machine and publish it.

| Requirement | Check |
|---|---|
| The folder is a repository on a branch named `main` | `git status` |
| At least three commits, each with a message that says what changed | `git log --oneline` |
| A `.gitignore` keeps build output and secrets out of the repository | The files are absent on GitHub |
| The repository is on GitHub | The page loads in a browser |
```

`routes/git-basics/03-capstone/02-step-1.md`:

````markdown
---
title: "Step 1: put it online"
done_when: "`git status` says your branch is up to date with `origin/main`, and the files are visible on GitHub."
---
Do this yourself first, then compare with the commands below.

1. Create the repository as in [[init]].
2. Add a `.gitignore` before the first commit, so unwanted files never enter the history.
3. Make at least three commits, staging deliberately as in [[commit]].
4. Create an empty repository on GitHub, then connect and push as in [[remote]].

One possible run:

```bash
git init -b main
printf "node_modules/\n.env\n" > .gitignore
git add .gitignore
git commit -m "Add gitignore"
git add .
git commit -m "Add project files"
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```
````

- [ ] **Step 5: Validate**

Run: `npm run validate`
Expected: `OK: 1 route(s), 7 stop(s).`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add Git basics sample route"
```

---

### Task 6: App shell and landing page

**Files:**
- Create: `react-router.config.ts`, `vite.config.ts`
- Create: `app/routes.ts`, `app/root.tsx`, `app/content.server.ts`
- Create: `app/routes/home.tsx`, `app/routes/route.tsx` (stub, replaced in Task 7)
- Create: `app/components/GlobalNav.tsx`, `Footer.tsx`, `ProgressBar.tsx`, `PathGraphic.tsx`, `RouteCard.tsx`, `ContinueTile.tsx`
- Create: `app/styles/tokens.css`, `app/styles/global.css`, `app/styles/components.css`
- Create: `tests/components/RouteCard.test.tsx`, `tests/components/Home.test.tsx`, `tests/components/PathGraphic.test.tsx`

**Interfaces:**
- Consumes: `checkContent`, `formatProblem`, `toSummary`, `toView`, `RouteSummary`, `RouteView`, `loadSite`; `useProgress`, `countDone`, `nextStop`.
- Produces (from `app/content.server.ts`): `getSummaries(): RouteSummary[]`, `getRouteView(slug: string): Promise<RouteView | null>`. Both throw an `Error` listing every problem when the content is invalid.
- Produces components:
  - `GlobalNav()`, `Footer()`
  - `ProgressBar({ value: number; max: number; label: string })`
  - `PathGraphic({ total: number; done: number })`
  - `RouteCard({ route: RouteSummary; done: string[] | undefined })`
  - `ContinueTile({ routes: RouteSummary[] })`
- Environment variables: `ROADMAP_ROUTES_DIR` (default `routes`), `BASE_PATH` (default `/`, must start and end with `/`), `VITE_REPO_URL` (optional link shown in the footer).
- CSS class names defined here and reused by Task 7: `tile`, `tile-light`, `tile-parchment`, `tile-dark`, `hero-title`, `tile-title`, `tile-lead`, `section-title`, `eyebrow`, `eyebrow-accent`, `fine`, `pill`, `pill-ghost`, `pill-small`, `text-link`, `container`, `container-narrow`, `reveal`, `progress`, `path`.

React Router requires `basename` to begin with Vite's `base`, so both are set to the same `BASE_PATH` value.

- [ ] **Step 1: Create `react-router.config.ts`**

```ts
import type { Config } from "@react-router/dev/config";
import { loadSite } from "./content/loader";

const routesDir = process.env.ROADMAP_ROUTES_DIR ?? "routes";

export default {
  ssr: false,
  basename: process.env.BASE_PATH ?? "/",
  async prerender() {
    const { routes } = loadSite(routesDir);
    return ["/", ...routes.map((route) => `/${route.slug}`)];
  },
} satisfies Config;
```

- [ ] **Step 2: Create `vite.config.ts`**

The small plugin reloads the browser when a file under the routes folder changes, which gives live preview while writing content.

```ts
import path from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin } from "vite";

function contentReload(): Plugin {
  const dir = path.resolve(process.env.ROADMAP_ROUTES_DIR ?? "routes");
  return {
    name: "roadmap-content-reload",
    configureServer(server) {
      server.watcher.add(dir);
      server.watcher.on("all", (_event, file) => {
        if (path.resolve(file).startsWith(dir)) server.ws.send({ type: "full-reload" });
      });
    },
  };
}

export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [reactRouter(), contentReload()],
});
```

- [ ] **Step 3: Create `app/routes.ts`**

```ts
import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route(":slug", "routes/route.tsx"),
] satisfies RouteConfig;
```

- [ ] **Step 4: Create `app/content.server.ts`**

```ts
import path from "node:path";
import { checkContent } from "../content/index";
import { formatProblem, type Route } from "../content/model";
import { toSummary, toView, type RouteSummary, type RouteView } from "../content/view";

function load(): Route[] {
  const dir = path.resolve(process.env.ROADMAP_ROUTES_DIR ?? "routes");
  const { routes, problems } = checkContent(dir);
  if (problems.length > 0) {
    throw new Error(`Content problems:\n${problems.map(formatProblem).join("\n")}`);
  }
  return routes;
}

export function getSummaries(): RouteSummary[] {
  const routes = load();
  return routes.map((route) => toSummary(route, routes));
}

export async function getRouteView(slug: string): Promise<RouteView | null> {
  const routes = load();
  const route = routes.find((r) => r.slug === slug);
  return route ? toView(route, routes, import.meta.env.BASE_URL) : null;
}
```

- [ ] **Step 5: Create `app/styles/tokens.css`**

```css
:root {
  color-scheme: light;

  --accent: #0066cc;
  --accent-fill: #0066cc;
  --accent-focus: #0071e3;
  --accent-on-dark: #2997ff;
  --on-accent: #ffffff;

  --ink: #1d1d1f;
  --ink-muted: #333333;
  --ink-faint: #7a7a7a;

  --canvas: #ffffff;
  --parchment: #f5f5f7;
  --card: #ffffff;
  --tile-dark: #272729;
  --black: #000000;
  --on-dark: #ffffff;
  --on-dark-muted: #cccccc;

  --hairline: #e0e0e0;
  --divider: #f0f0f0;
  --nav-frost: rgba(245, 245, 247, 0.8);
  --nav-line: rgba(0, 0, 0, 0.08);

  --code-bg: #1d1d1f;
  --code-ink: #f5f5f7;
  --code-faint: #a1a1a6;
  --warning: #b25000;

  --r-sm: 8px;
  --r-lg: 18px;
  --r-pill: 9999px;

  --s-xxs: 4px;
  --s-xs: 8px;
  --s-sm: 12px;
  --s-md: 17px;
  --s-lg: 24px;
  --s-xl: 32px;
  --s-xxl: 48px;
  --s-section: 80px;

  --nav-h: 44px;
  --subnav-h: 52px;

  --font-sans: -apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}
```

- [ ] **Step 6: Create `app/styles/global.css`**

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
  scroll-padding-top: calc(var(--nav-h) + var(--subnav-h) + 20px);
  -webkit-text-size-adjust: 100%;
}

body {
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 17px;
  font-weight: 400;
  line-height: 1.47;
  letter-spacing: -0.022em;
  -webkit-font-smoothing: antialiased;
}

h1,
h2,
h3,
h4,
p,
ul,
ol,
figure {
  margin: 0;
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

button {
  font: inherit;
  letter-spacing: inherit;
}

:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: 2px;
}

.container {
  width: min(100% - 48px, 1440px);
  margin-inline: auto;
}

.container-narrow {
  width: min(100% - 48px, 980px);
}

.eyebrow {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.016em;
  color: var(--ink-faint);
}

.fine {
  font-size: 12px;
  letter-spacing: -0.01em;
  color: var(--ink-faint);
}

/* Tiles: full-bleed sections. The colour change is the divider. */
.tile {
  padding: var(--s-section) 24px;
  text-align: center;
}

.tile-light {
  background: var(--canvas);
}

.tile-parchment {
  background: var(--parchment);
  text-align: left;
}

.tile-dark {
  background: var(--tile-dark);
  color: var(--on-dark);
}

.tile-dark .tile-lead {
  color: var(--on-dark-muted);
}

.tile-dark .eyebrow-accent {
  color: var(--accent-on-dark);
}

.hero-title {
  font-size: 56px;
  font-weight: 600;
  line-height: 1.07;
  letter-spacing: -0.005em;
  max-width: 18ch;
  margin-inline: auto;
}

.tile-title {
  font-size: 40px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: 0;
}

.section-title {
  font-size: 34px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.011em;
  margin-bottom: var(--s-xl);
}

.tile-lead {
  font-size: 28px;
  line-height: 1.14;
  letter-spacing: 0.007em;
  margin-top: var(--s-sm);
  max-width: 32ch;
  margin-inline: auto;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--s-md);
  margin-top: var(--s-xl);
}

.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 11px 22px;
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  background: var(--accent-fill);
  color: var(--on-accent);
  font-size: 17px;
  cursor: pointer;
  transition: transform 0.15s ease;
}

.pill:hover {
  text-decoration: none;
}

.pill:active {
  transform: scale(0.95);
}

.pill-ghost {
  background: transparent;
  border-color: var(--accent);
  color: var(--accent);
}

.tile-dark .pill-ghost {
  border-color: var(--accent-on-dark);
  color: var(--accent-on-dark);
}

.pill-small {
  min-height: 32px;
  padding: 6px 14px;
  font-size: 14px;
}

.text-link {
  font-size: 17px;
}

/* Scroll reveal: pure CSS, so content stays visible without JavaScript
   and in browsers without scroll-driven animations. */
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(24px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .reveal {
      animation: rise linear both;
      animation-timeline: view();
      animation-range: entry 0% entry 40%;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }

  * {
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 7: Create `app/styles/components.css`**

```css
/* Global nav */
.global-nav {
  position: sticky;
  top: 0;
  z-index: 30;
  height: var(--nav-h);
  background: var(--black);
}

.global-nav-inner {
  display: flex;
  align-items: center;
  gap: 28px;
  height: 100%;
  width: min(100% - 48px, 1440px);
  margin-inline: auto;
  font-size: 12px;
  letter-spacing: -0.01em;
}

.global-nav a {
  color: var(--on-dark);
  opacity: 0.8;
  padding-block: 14px;
}

.global-nav a:hover {
  opacity: 1;
  text-decoration: none;
}

.global-nav .global-nav-brand {
  opacity: 1;
  font-size: 14px;
  font-weight: 600;
}

/* Route cards */
.card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
}

.route-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-xs);
  padding: var(--s-lg);
  background: var(--card);
  border: 1px solid var(--hairline);
  border-radius: var(--r-lg);
}

.route-card-title {
  font-size: 21px;
  font-weight: 600;
  line-height: 1.19;
  letter-spacing: 0.011em;
}

.route-card-summary {
  flex: 1;
  color: var(--ink-muted);
  margin-bottom: var(--s-sm);
}

.route-card .path {
  margin: 0 0 var(--s-sm);
}

/* Progress bar */
.progress {
  height: 4px;
  border-radius: 2px;
  background: var(--hairline);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
}

/* Route-path graphic */
.path {
  display: block;
  max-width: 100%;
  height: auto;
  margin: var(--s-xl) auto 0;
}

.path-line {
  stroke: var(--ink-faint);
  stroke-width: 2;
}

.path-dot {
  fill: var(--canvas);
  stroke: var(--ink-faint);
  stroke-width: 2;
}

.path-line-done {
  stroke: var(--accent);
}

.path-dot-done {
  fill: var(--accent);
  stroke: var(--accent);
}

.route-card .path-dot {
  fill: var(--card);
}

.route-card .path-dot-done {
  fill: var(--accent);
}

.tile-dark .path-dot {
  fill: var(--tile-dark);
}

.tile-dark .path-line-done {
  stroke: var(--accent-on-dark);
}

.tile-dark .path-dot-done {
  fill: var(--accent-on-dark);
  stroke: var(--accent-on-dark);
}

/* Where to start, empty state */
.start-list {
  display: grid;
  gap: var(--s-sm);
  padding: 0;
  list-style: none;
  font-size: 21px;
  line-height: 1.38;
  text-align: left;
}

.empty {
  padding: var(--s-xxl) 0;
  text-align: center;
  color: var(--ink-muted);
}

/* Footer */
.footer {
  padding: 64px 0;
  background: var(--parchment);
}

.footer .fine + .fine {
  margin-top: var(--s-xs);
}
```

- [ ] **Step 8: Write the failing component tests**

`tests/components/PathGraphic.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PathGraphic } from "../../app/components/PathGraphic";

afterEach(cleanup);

const dots = (c: HTMLElement) => c.querySelectorAll(".path-dot").length;
const filled = (c: HTMLElement) => c.querySelectorAll(".path-dot-done").length;

describe("PathGraphic", () => {
  it("draws one dot per stop up to eight, and at least two", () => {
    expect(dots(render(<PathGraphic total={5} done={0} />).container)).toBe(5);
    expect(dots(render(<PathGraphic total={40} done={0} />).container)).toBe(8);
    expect(dots(render(<PathGraphic total={1} done={0} />).container)).toBe(2);
  });

  it("fills nothing at zero and everything when complete", () => {
    expect(filled(render(<PathGraphic total={4} done={0} />).container)).toBe(0);
    expect(filled(render(<PathGraphic total={4} done={4} />).container)).toBe(4);
  });

  it("fills in proportion and labels itself", () => {
    const { container, getByRole } = render(<PathGraphic total={44} done={22} />);
    expect(filled(container)).toBe(4);
    expect(getByRole("img").getAttribute("aria-label")).toBe("22 of 44 stops done");
  });
});
```

`tests/components/RouteCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { RouteCard } from "../../app/components/RouteCard";
import type { RouteSummary } from "../../content/view";

afterEach(cleanup);

const route: RouteSummary = {
  slug: "git-basics",
  title: "Git basics",
  number: 1,
  summary: "Track changes.",
  partCount: 3,
  stops: [
    { id: "init", title: "Create a repository" },
    { id: "commit", title: "Stage and commit" },
    { id: "history", title: "Read history" },
  ],
  prerequisites: [],
};

const show = (done?: string[]) =>
  render(
    <MemoryRouter>
      <RouteCard route={route} done={done} />
    </MemoryRouter>,
  );

describe("RouteCard", () => {
  it("shows the label, title, summary and counts", () => {
    show();
    expect(screen.getByText("Route 1")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Git basics" })).toBeTruthy();
    expect(screen.getByText("Track changes.")).toBeTruthy();
    expect(screen.getByText("0 of 3 stops · 3 parts")).toBeTruthy();
  });

  it("links to the route with an action that matches progress", () => {
    show();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/git-basics");
    expect(screen.getByRole("link").textContent).toContain("Start");
    cleanup();
    show(["init"]);
    expect(screen.getByRole("link").textContent).toContain("Resume");
    cleanup();
    show(["init", "commit", "history"]);
    expect(screen.getByRole("link").textContent).toContain("Review");
  });

  it("ignores done ids that are not in the route", () => {
    show(["init", "gone"]);
    expect(screen.getByText("1 of 3 stops · 3 parts")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  });
});
```

`tests/components/Home.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import Home from "../../app/routes/home";
import type { RouteSummary } from "../../content/view";

afterEach(cleanup);

const summary = (over: Partial<RouteSummary>): RouteSummary => ({
  slug: "a",
  title: "Route A",
  number: 1,
  summary: "About A.",
  partCount: 1,
  stops: [{ id: "s", title: "S" }],
  prerequisites: [],
  ...over,
});

function show(routes: RouteSummary[]) {
  const props = { loaderData: { routes } } as unknown as Parameters<typeof Home>[0];
  return render(
    <MemoryRouter>
      <Home {...props} />
    </MemoryRouter>,
  );
}

describe("Home", () => {
  it("shows an empty state and no start section when there are no routes", () => {
    show([]);
    expect(screen.getByText(/No routes yet/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Where to start" })).toBeNull();
    expect(screen.queryByText(/Start route/)).toBeNull();
  });

  it("shows a card per route and a start action for the first", () => {
    show([summary({}), summary({ slug: "b", title: "Route B", number: 2 })]);
    expect(screen.getByRole("heading", { name: "Route A" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Route B" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start route 1" }).getAttribute("href")).toBe("/a");
  });

  it("explains reading order from prerequisites", () => {
    show([
      summary({}),
      summary({ slug: "b", title: "Route B", number: 2 }),
      summary({
        slug: "c",
        title: "Route C",
        number: 3,
        prerequisites: [
          { slug: "a", title: "Route A" },
          { slug: "b", title: "Route B" },
        ],
      }),
    ]);
    const list = screen.getByRole("list", { name: "Reading order" });
    expect(list.textContent).toContain("Route A needs no earlier route.");
    expect(list.textContent).toContain("Read Route A and Route B before Route C.");
  });

  it("hides the continue tile when there is no saved progress", () => {
    show([summary({})]);
    expect(screen.queryByText("Continue")).toBeNull();
  });
});
```

- [ ] **Step 9: Run the tests to verify they fail**

Run: `npm test -- tests/components`
Expected: FAIL, cannot resolve the component modules.

- [ ] **Step 10: Create the small components**

`app/components/GlobalNav.tsx`:

```tsx
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
```

`app/components/Footer.tsx`:

```tsx
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
```

`app/components/ProgressBar.tsx`:

```tsx
import { motion, useReducedMotion } from "motion/react";

interface Props {
  value: number;
  max: number;
  label: string;
}

export function ProgressBar({ value, max, label }: Props) {
  const reduce = useReducedMotion();
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <motion.div
        className="progress-fill"
        initial={false}
        animate={{ width: `${percent}%` }}
        transition={reduce ? { duration: 0 } : { duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}
```

`app/components/PathGraphic.tsx`:

```tsx
interface Props {
  total: number;
  done: number;
}

const GAP = 56;
const R = 7;
const PAD = R + 2;

/** Stops joined by a line, filled as the reader progresses. At most eight dots. */
export function PathGraphic({ total, done }: Props) {
  const dots = Math.min(Math.max(total, 2), 8);
  const filled = total > 0 ? Math.round((done / total) * dots) : 0;
  const width = (dots - 1) * GAP + PAD * 2;
  const x = (i: number) => PAD + i * GAP;
  return (
    <svg
      className="path"
      viewBox={`0 0 ${width} 24`}
      width={width}
      height={24}
      role="img"
      aria-label={`${done} of ${total} stops done`}
    >
      <line className="path-line" x1={x(0)} y1={12} x2={x(dots - 1)} y2={12} />
      {filled > 1 && (
        <line className="path-line path-line-done" x1={x(0)} y1={12} x2={x(filled - 1)} y2={12} />
      )}
      {Array.from({ length: dots }, (_, i) => (
        <circle
          key={i}
          className={i < filled ? "path-dot path-dot-done" : "path-dot"}
          cx={x(i)}
          cy={12}
          r={R}
        />
      ))}
    </svg>
  );
}
```

- [ ] **Step 11: Create `app/components/RouteCard.tsx`**

```tsx
import { Link } from "react-router";
import type { RouteSummary } from "../../content/view";
import { countDone } from "../state/progress";
import { ProgressBar } from "./ProgressBar";

interface Props {
  route: RouteSummary;
  done: string[] | undefined;
}

export function RouteCard({ route, done }: Props) {
  const total = route.stops.length;
  const count = countDone(
    done,
    route.stops.map((s) => s.id),
  );
  const action = count === 0 ? "Start" : count === total ? "Review" : "Resume";
  return (
    <article className="route-card reveal">
      <p className="eyebrow">Route {route.number}</p>
      <h3 className="route-card-title">{route.title}</h3>
      <p className="route-card-summary">{route.summary}</p>
      <ProgressBar value={count} max={total} label={`${route.title} progress`} />
      <p className="fine">
        {count} of {total} stops · {route.partCount} parts
      </p>
      <Link className="text-link" to={`/${route.slug}`}>
        {action} <span aria-hidden="true">›</span>
      </Link>
    </article>
  );
}
```

- [ ] **Step 12: Create `app/components/ContinueTile.tsx`**

It reads the store, so it renders nothing on the server and on first paint, then appears after rehydration.

```tsx
import { motion, useReducedMotion } from "motion/react";
import { Link } from "react-router";
import type { RouteSummary } from "../../content/view";
import { countDone, nextStop, useProgress } from "../state/progress";
import { PathGraphic } from "./PathGraphic";

export function ContinueTile({ routes }: { routes: RouteSummary[] }) {
  const lastRoute = useProgress((s) => s.lastRoute);
  const done = useProgress((s) => s.done);
  const reduce = useReducedMotion();

  const route = routes.find((r) => r.slug === lastRoute);
  if (!route) return null;

  const ids = route.stops.map((s) => s.id);
  const count = countDone(done[route.slug], ids);
  const next = nextStop(done[route.slug], route.stops);

  return (
    <motion.section
      className="tile tile-dark"
      aria-label="Continue"
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
    >
      <p className="eyebrow eyebrow-accent">Continue</p>
      <h2 className="tile-title">{route.title}</h2>
      <p className="tile-lead">{next ? `Next stop: ${next.title}` : "Every stop is done."}</p>
      <div className="actions">
        <Link className="pill" to={next ? `/${route.slug}#${next.id}` : `/${route.slug}`}>
          {next ? "Resume" : "Review"}
        </Link>
      </div>
      <PathGraphic total={ids.length} done={count} />
    </motion.section>
  );
}
```

- [ ] **Step 13: Create `app/routes/home.tsx`**

```tsx
import { Link } from "react-router";
import { ContinueTile } from "../components/ContinueTile";
import { PathGraphic } from "../components/PathGraphic";
import { RouteCard } from "../components/RouteCard";
import { getSummaries } from "../content.server";
import { useProgress } from "../state/progress";
import type { Route } from "./+types/home";

export function loader() {
  return { routes: getSummaries() };
}

export function meta() {
  return [
    { title: "RoadMap" },
    {
      name: "description",
      content: "Hands-on guides: short stops, one idea each, a project at the end.",
    },
  ];
}

function list(titles: string[]): string {
  if (titles.length <= 1) return titles.join("");
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { routes } = loaderData;
  const done = useProgress((s) => s.done);
  const first = routes[0];

  return (
    <>
      <section className="tile tile-light">
        <h1 className="hero-title">Learn by building.</h1>
        <p className="tile-lead">Short stops. One idea each. A project at the end.</p>
        {first && (
          <div className="actions">
            <Link className="pill" to={`/${first.slug}`}>
              Start route {first.number}
            </Link>
            <a className="pill pill-ghost" href="#routes">
              See all routes
            </a>
          </div>
        )}
      </section>

      <ContinueTile routes={routes} />

      <section className="tile tile-parchment" id="routes">
        <div className="container">
          <h2 className="section-title">All routes</h2>
          {routes.length === 0 ? (
            <div className="empty">
              <PathGraphic total={5} done={0} />
              <p>No routes yet. Add a folder under routes/ and push.</p>
            </div>
          ) : (
            <div className="card-grid">
              {routes.map((route) => (
                <RouteCard key={route.slug} route={route} done={done[route.slug]} />
              ))}
            </div>
          )}
        </div>
      </section>

      {routes.length > 0 && (
        <section className="tile tile-light" id="start">
          <div className="container container-narrow">
            <h2 className="section-title">Where to start</h2>
            <ul className="start-list" aria-label="Reading order">
              {routes.map((route) => (
                <li key={route.slug}>
                  {route.prerequisites.length === 0 ? (
                    <>
                      <Link to={`/${route.slug}`}>{route.title}</Link> needs no earlier route.
                    </>
                  ) : (
                    <>
                      Read {list(route.prerequisites.map((p) => p.title))} before{" "}
                      <Link to={`/${route.slug}`}>{route.title}</Link>.
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}
```

- [ ] **Step 14: Create the stub `app/routes/route.tsx`**

Task 7 replaces this file. It exists now so the route table and prerender resolve.

```tsx
import { getRouteView } from "../content.server";
import type { Route } from "./+types/route";

export async function loader({ params }: Route.LoaderArgs) {
  const route = await getRouteView(params.slug);
  if (!route) throw new Response("Not found", { status: 404 });
  return { route };
}

export default function RoutePage({ loaderData }: Route.ComponentProps) {
  return (
    <section className="tile tile-light">
      <h1 className="hero-title">{loaderData.route.title}</h1>
    </section>
  );
}
```

- [ ] **Step 15: Create `app/root.tsx`**

```tsx
import { useEffect } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse } from "react-router";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/components.css";
import { Footer } from "./components/Footer";
import { GlobalNav } from "./components/GlobalNav";
import { useProgress } from "./state/progress";
import type { Route } from "./+types/root";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  // Saved progress is loaded after hydration so server HTML and first render match.
  useEffect(() => {
    void useProgress.persist.rehydrate();
  }, []);

  return (
    <>
      <GlobalNav />
      <main>
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <>
      <GlobalNav />
      <main>
        <section className="tile tile-light">
          <h1 className="hero-title">{notFound ? "Page not found." : "Something went wrong."}</h1>
          <div className="actions">
            <a className="pill" href={import.meta.env.BASE_URL}>
              All routes
            </a>
          </div>
        </section>
      </main>
    </>
  );
}
```

- [ ] **Step 16: Run the tests to verify they pass**

Run: `npm test -- tests/components`
Expected: PASS, 10 tests.

- [ ] **Step 17: Type-check and build**

Run: `npm run typecheck`
Expected: no errors. If `Route.ErrorBoundaryProps`, `Route.LoaderArgs` or `Route.ComponentProps` are reported missing, read the "Route Module" and "Type Safety" pages of the installed React Router version and use the names it documents.

Run: `npm run build`
Expected: the validate line `OK: 1 route(s), 7 stop(s).`, then prerender lines for `build/client/index.html` and `build/client/git-basics/index.html`.

Run: `grep -c "Learn by building" build/client/index.html`
Expected: `1` or more.

If the build reports a missing package for the default server entry, install the package it names and rebuild.

- [ ] **Step 18: Commit**

```bash
git add -A
git commit -m "Add app shell and landing page"
```

---

### Task 7: Route page

**Files:**
- Replace: `app/routes/route.tsx`
- Create: `app/components/SubNav.tsx`, `Rail.tsx`, `PartHeader.tsx`, `Stop.tsx`
- Create: `app/hooks/useActivePart.ts`
- Create: `app/styles/prose.css`
- Modify: `app/styles/components.css` (append), `app/root.tsx` (one import)
- Create: `tests/components/Stop.test.tsx`, `tests/components/Rail.test.tsx`, `tests/components/SubNav.test.tsx`

**Interfaces:**
- Consumes: `RouteView`, `PartView`, `StopView`; `useProgress`, `whenHydrated`, `nextStop`; `ProgressBar`, `PathGraphic`; the HTML contract from Task 3.
- Produces components:
  - `SubNav({ title: string; done: number; total: number; nextId: string | null; children?: React.ReactNode })`. `children` is a slot at the start of the right-hand cluster; Task 9 puts the drawer trigger there.
  - `Rail({ parts: PartView[]; doneIds: ReadonlySet<string>; active: string | null; onNavigate?: () => void })`
  - `PartHeader({ part: PartView })`
  - `Stop({ stop: StopView; done: boolean; onToggle: (id: string) => void })`
  - `useActivePart(ids: string[]): string | null`
- DOM ids: each part section has id `part-<part id>`; each stop article has id `<stop id>` (the anchor promised by the spec).

- [ ] **Step 1: Write the failing component tests**

`tests/components/Stop.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Stop } from "../../app/components/Stop";
import type { StopView } from "../../content/view";

afterEach(cleanup);

const stop: StopView = {
  id: "init",
  title: "Create a repository",
  html: "<p>Body text.</p>",
  doneWhenHtml: null,
  isStep: false,
};

describe("Stop", () => {
  it("renders an anchored article with a self-linking title and the body", () => {
    const { container } = render(<Stop stop={stop} done={false} onToggle={() => {}} />);
    expect(container.querySelector("article#init")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create a repository" }).getAttribute("href")).toBe("#init");
    expect(screen.getByText("Body text.")).toBeTruthy();
  });

  it("calls onToggle with the stop id when the checkbox is clicked", () => {
    const onToggle = vi.fn();
    render(<Stop stop={stop} done={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith("init");
  });

  it("reflects the done state and names the checkbox after the stop", () => {
    render(<Stop stop={stop} done onToggle={() => {}} />);
    const box = screen.getByRole("checkbox", { name: "Mark Create a repository as done" });
    expect(box.getAttribute("aria-checked")).toBe("true");
  });

  it("shows the Done when callout only when the stop has one", () => {
    render(<Stop stop={stop} done={false} onToggle={() => {}} />);
    expect(screen.queryByText("Done when")).toBeNull();
    cleanup();
    render(
      <Stop stop={{ ...stop, doneWhenHtml: "<p>It works.</p>" }} done={false} onToggle={() => {}} />,
    );
    expect(screen.getByText("Done when")).toBeTruthy();
    expect(screen.getByText("It works.")).toBeTruthy();
  });
});
```

`tests/components/Rail.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rail } from "../../app/components/Rail";
import type { PartView, StopView } from "../../content/view";

afterEach(cleanup);

const stop = (id: string): StopView => ({ id, title: id, html: "", doneWhenHtml: null, isStep: false });
const part = (id: string, title: string, ids: string[]): PartView => ({
  id,
  title,
  goal: "",
  kind: "part",
  number: 1,
  introHtml: "",
  stops: ids.map(stop),
});

const parts = [part("local", "Work locally", ["init", "commit"]), part("share", "Branch and share", ["branch"])];

describe("Rail", () => {
  it("lists parts with done counts and links to each part", () => {
    render(<Rail parts={parts} doneIds={new Set(["init", "gone"])} active={null} />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["#part-local", "#part-share"]);
    expect(links[0].textContent).toBe("Work locally1/2");
    expect(links[1].textContent).toBe("Branch and share0/1");
  });

  it("marks the active part", () => {
    render(<Rail parts={parts} doneIds={new Set()} active="share" />);
    const [first, second] = screen.getAllByRole("link");
    expect(first.getAttribute("aria-current")).toBeNull();
    expect(second.getAttribute("aria-current")).toBe("true");
    expect(second.className).toContain("is-active");
  });

  it("calls onNavigate when a part is chosen", () => {
    const onNavigate = vi.fn();
    render(<Rail parts={parts} doneIds={new Set()} active={null} onNavigate={onNavigate} />);
    fireEvent.click(screen.getAllByRole("link")[0]);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
```

`tests/components/SubNav.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SubNav } from "../../app/components/SubNav";

afterEach(cleanup);

describe("SubNav", () => {
  it("shows the title, the count and a link to the next stop", () => {
    render(<SubNav title="Git basics" done={2} total={7} nextId="history" />);
    expect(screen.getByText("Git basics")).toBeTruthy();
    expect(screen.getByText("2 of 7 done")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Next stop" }).getAttribute("href")).toBe("#history");
  });

  it("shows Complete instead of the link when nothing is left", () => {
    render(<SubNav title="Git basics" done={7} total={7} nextId={null} />);
    expect(screen.queryByRole("link", { name: "Next stop" })).toBeNull();
    expect(screen.getByText("Complete")).toBeTruthy();
  });

  it("renders children in the right-hand cluster", () => {
    render(
      <SubNav title="T" done={0} total={1} nextId="a">
        <button type="button">Parts</button>
      </SubNav>,
    );
    expect(screen.getByRole("button", { name: "Parts" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/components/Stop.test.tsx tests/components/Rail.test.tsx tests/components/SubNav.test.tsx`
Expected: FAIL, cannot resolve the component modules.

- [ ] **Step 3: Create `app/components/Stop.tsx`**

```tsx
import * as Checkbox from "@radix-ui/react-checkbox";
import { motion } from "motion/react";
import type { StopView } from "../../content/view";

interface Props {
  stop: StopView;
  done: boolean;
  onToggle: (id: string) => void;
}

export function Stop({ stop, done, onToggle }: Props) {
  return (
    <article className="stop" id={stop.id}>
      <header className="stop-head">
        <Checkbox.Root
          className="check"
          checked={done}
          onCheckedChange={() => onToggle(stop.id)}
          aria-label={`Mark ${stop.title} as done`}
        >
          <Checkbox.Indicator asChild>
            <motion.svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-hidden="true"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 26 }}
            >
              <path
                d="M3.5 8.5l3 3 6-7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </motion.svg>
          </Checkbox.Indicator>
        </Checkbox.Root>
        <h3 className="stop-title">
          <a href={`#${stop.id}`}>{stop.title}</a>
        </h3>
      </header>
      <div className="prose" dangerouslySetInnerHTML={{ __html: stop.html }} />
      {stop.doneWhenHtml && (
        <div className="callout callout-done">
          <strong className="callout-label">Done when</strong>
          <div className="callout-body" dangerouslySetInnerHTML={{ __html: stop.doneWhenHtml }} />
        </div>
      )}
    </article>
  );
}
```

- [ ] **Step 4: Create `app/components/Rail.tsx`**

```tsx
import type { PartView } from "../../content/view";

interface Props {
  parts: PartView[];
  doneIds: ReadonlySet<string>;
  active: string | null;
  onNavigate?: () => void;
}

export function Rail({ parts, doneIds, active, onNavigate }: Props) {
  return (
    <nav className="rail" aria-label="Parts">
      <ol>
        {parts.map((part) => {
          const count = part.stops.filter((s) => doneIds.has(s.id)).length;
          const current = part.id === active;
          return (
            <li key={part.id}>
              <a
                className={current ? "rail-link is-active" : "rail-link"}
                href={`#part-${part.id}`}
                aria-current={current ? "true" : undefined}
                onClick={onNavigate}
              >
                <span>{part.title}</span>
                <span className="rail-count">
                  {count}/{part.stops.length}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
```

- [ ] **Step 5: Create `app/components/SubNav.tsx`**

```tsx
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
```

- [ ] **Step 6: Create `app/components/PartHeader.tsx`**

```tsx
import type { PartView } from "../../content/view";

export function PartHeader({ part }: { part: PartView }) {
  const capstone = part.kind === "capstone";
  return (
    <header className={capstone ? "part-head part-head-capstone reveal" : "part-head reveal"}>
      <p className="eyebrow">{capstone ? "Capstone" : `Part ${part.number}`}</p>
      <h2 className="part-title">{part.title}</h2>
      <p className="part-goal">{part.goal}</p>
      {part.introHtml && (
        <div className="prose part-intro" dangerouslySetInnerHTML={{ __html: part.introHtml }} />
      )}
    </header>
  );
}
```

- [ ] **Step 7: Create `app/hooks/useActivePart.ts`**

```ts
import { useEffect, useState } from "react";

/** Id of the part currently near the top of the viewport. */
export function useActivePart(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join("|");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id.slice("part-".length));
        }
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const id of key.split("|")) {
      const el = document.getElementById(`part-${id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key]);

  return active;
}
```

- [ ] **Step 8: Replace `app/routes/route.tsx`**

```tsx
import { useEffect, useMemo } from "react";
import { PartHeader } from "../components/PartHeader";
import { PathGraphic } from "../components/PathGraphic";
import { Rail } from "../components/Rail";
import { Stop } from "../components/Stop";
import { SubNav } from "../components/SubNav";
import { getRouteView } from "../content.server";
import { useActivePart } from "../hooks/useActivePart";
import { nextStop, useProgress, whenHydrated } from "../state/progress";
import type { Route } from "./+types/route";

export async function loader({ params }: Route.LoaderArgs) {
  const route = await getRouteView(params.slug);
  if (!route) throw new Response("Not found", { status: 404 });
  return { route };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "RoadMap" }];
  return [
    { title: `${loaderData.route.title} · RoadMap` },
    { name: "description", content: loaderData.route.summary },
  ];
}

/** One delegated handler for every "Copy" button in the rendered Markdown. */
function copyCode(event: React.MouseEvent<HTMLElement>) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button.copy");
  const code = button?.parentElement?.querySelector("pre")?.textContent;
  if (!button || code == null || !navigator.clipboard) return;
  void navigator.clipboard.writeText(code).then(() => {
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 1500);
  });
}

export default function RoutePage({ loaderData }: Route.ComponentProps) {
  const { route } = loaderData;
  const done = useProgress((s) => s.done[route.slug]);
  const toggle = useProgress((s) => s.toggle);
  const visit = useProgress((s) => s.visit);

  const stops = useMemo(() => route.parts.flatMap((p) => p.stops), [route]);
  const doneIds = useMemo(() => {
    const valid = new Set(stops.map((s) => s.id));
    return new Set((done ?? []).filter((id) => valid.has(id)));
  }, [done, stops]);
  const next = nextStop([...doneIds], stops);
  const active = useActivePart(route.parts.map((p) => p.id));

  // Wait for saved progress before writing, or the empty state would overwrite it.
  useEffect(() => whenHydrated(() => visit(route.slug)), [route.slug, visit]);

  return (
    <>
      <SubNav title={route.title} done={doneIds.size} total={stops.length} nextId={next?.id ?? null} />

      <section className="tile tile-light route-hero">
        <p className="eyebrow">Route {route.number}</p>
        <h1 className="hero-title">{route.hero || route.title}</h1>
        {route.lede && <p className="tile-lead">{route.lede}</p>}
        <PathGraphic total={stops.length} done={doneIds.size} />
      </section>

      <div className="route-body" onClick={copyCode}>
        <aside className="route-rail">
          <Rail parts={route.parts} doneIds={doneIds} active={active} />
        </aside>
        <div className="route-content">
          {route.parts.map((part) => (
            <section key={part.id} id={`part-${part.id}`} className="part">
              <PartHeader part={part} />
              {part.stops.map((stop) => (
                <Stop
                  key={stop.id}
                  stop={stop}
                  done={doneIds.has(stop.id)}
                  onToggle={(id) => toggle(route.slug, id)}
                />
              ))}
            </section>
          ))}
          {route.checked && (
            <p className="fine route-checked">
              Library APIs and commands were checked against official documentation in {route.checked}.
              They change; pin versions in your own projects.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 9: Create `app/styles/prose.css`**

```css
/* Rendered Markdown. Class names come from content/render.ts. */
.prose > * + * {
  margin-top: var(--s-md);
}

.prose ul,
.prose ol {
  padding-left: 1.3em;
}

.prose li + li {
  margin-top: 6px;
}

.prose strong {
  font-weight: 600;
}

.prose blockquote {
  margin: 0;
  padding-left: var(--s-md);
  border-left: 2px solid var(--hairline);
  color: var(--ink-muted);
}

.prose :not(pre) > code,
.callout :not(pre) > code {
  font-family: var(--font-mono);
  font-size: 0.88em;
  letter-spacing: 0;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--parchment);
}

.callout :not(pre) > code {
  background: var(--card);
}

.prose table {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: 15px;
}

.prose th,
.prose td {
  padding: 10px 16px 10px 0;
  border-bottom: 1px solid var(--hairline);
  text-align: left;
  vertical-align: top;
}

.prose th {
  font-weight: 600;
}

.prose img {
  max-width: 100%;
  height: auto;
  border-radius: var(--r-sm);
}

/* Code blocks: dark in both themes. */
.code {
  position: relative;
  overflow: hidden;
  border-radius: var(--r-lg);
  background: var(--code-bg);
  color: var(--code-ink);
}

.code figcaption {
  padding: 12px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0;
  color: var(--code-faint);
}

.code pre {
  margin: 0;
  padding: 18px 20px;
  overflow-x: auto;
  background: transparent !important;
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1.6;
  letter-spacing: 0;
}

.code code {
  font-family: inherit;
}

.copy {
  position: absolute;
  top: 8px;
  right: 10px;
  padding: 4px 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: rgba(255, 255, 255, 0.12);
  color: var(--code-ink);
  font-size: 12px;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.code:hover .copy,
.copy:focus-visible {
  opacity: 1;
}

.copy:active {
  transform: scale(0.95);
}

@media (hover: none) {
  .copy {
    opacity: 1;
  }
}

/* Callouts */
.callout {
  padding: var(--s-md) var(--s-lg);
  border-radius: var(--r-lg);
  background: var(--parchment);
  font-size: 15px;
}

.callout > * + * {
  margin-top: var(--s-xs);
}

.callout-label {
  font-weight: 600;
  margin-right: 4px;
}

.callout-warning .callout-label {
  color: var(--warning);
}

.callout-done {
  margin-top: var(--s-md);
}

.callout-done .callout-label {
  color: var(--accent);
}

.callout-done .callout-body,
.callout-done .callout-body p {
  display: inline;
}
```

- [ ] **Step 10: Append route page styles to `app/styles/components.css`**

```css
/* Frosted sub-nav */
.subnav {
  position: sticky;
  top: var(--nav-h);
  z-index: 20;
  height: var(--subnav-h);
  background: var(--nav-frost);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 1px solid var(--nav-line);
}

.subnav-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-md);
  height: 100%;
  width: min(100% - 48px, 1200px);
  margin-inline: auto;
}

.subnav-title {
  overflow: hidden;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: 0.011em;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.subnav-right {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--s-md);
}

.subnav-count,
.subnav-complete {
  font-size: 14px;
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}

/* Route page layout */
.route-hero {
  padding-bottom: 64px;
}

.route-body {
  display: grid;
  grid-template-columns: 240px minmax(0, 760px);
  justify-content: center;
  gap: 48px;
  width: min(100% - 48px, 1200px);
  margin-inline: auto;
  padding-block: var(--s-xxl) var(--s-section);
}

.route-rail {
  position: sticky;
  top: calc(var(--nav-h) + var(--subnav-h) + 24px);
  align-self: start;
}

.rail ol {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rail-link {
  display: flex;
  justify-content: space-between;
  gap: var(--s-sm);
  padding: 8px 12px;
  border-radius: var(--r-sm);
  font-size: 14px;
  color: var(--ink-muted);
}

.rail-link:hover {
  background: var(--parchment);
  text-decoration: none;
}

.rail-link.is-active {
  background: var(--parchment);
  color: var(--ink);
  font-weight: 600;
}

.rail-count {
  color: var(--ink-faint);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

/* Parts */
.part + .part {
  margin-top: var(--s-section);
}

.part-head {
  margin-bottom: var(--s-lg);
}

.part-title {
  margin-top: var(--s-xxs);
  font-size: 40px;
  font-weight: 600;
  line-height: 1.1;
}

.part-goal {
  margin-top: var(--s-xs);
  font-size: 21px;
  line-height: 1.38;
  color: var(--ink-muted);
}

.part-intro {
  margin-top: var(--s-md);
}

.part-head-capstone {
  padding: var(--s-xxl) var(--s-xl);
  border-radius: var(--r-lg);
  background: var(--tile-dark);
  color: var(--on-dark);
}

.part-head-capstone .eyebrow {
  color: var(--accent-on-dark);
}

.part-head-capstone .part-goal {
  color: var(--on-dark-muted);
}

/* Stops */
.stop {
  padding-block: var(--s-xl);
  border-top: 1px solid var(--divider);
}

.part-head + .stop {
  border-top: 0;
  padding-top: var(--s-xs);
}

.stop-head {
  display: flex;
  align-items: center;
  gap: var(--s-sm);
  margin-bottom: var(--s-sm);
}

.stop-title {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.17;
  letter-spacing: 0.009em;
}

.stop-title a {
  color: inherit;
}

.check {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1.5px solid var(--ink-faint);
  border-radius: 50%;
  background: transparent;
  color: var(--on-accent);
  cursor: pointer;
  transition:
    transform 0.15s ease,
    background-color 0.2s ease,
    border-color 0.2s ease;
}

/* Extends the hit area to 44px without changing the visible size. */
.check::after {
  content: "";
  position: absolute;
  inset: -8px;
}

.check:active {
  transform: scale(0.95);
}

.check[data-state="checked"] {
  border-color: var(--accent-fill);
  background: var(--accent-fill);
}

.route-checked {
  margin-top: var(--s-xxl);
  line-height: 1.5;
}
```

- [ ] **Step 11: Import the prose styles in `app/root.tsx`**

Add after the `components.css` import:

```tsx
import "./styles/prose.css";
```

- [ ] **Step 12: Run all tests**

Run: `npm test`
Expected: PASS, every test file.

- [ ] **Step 13: Type-check and build**

Run: `npm run typecheck`
Expected: no errors. If `Route.MetaArgs` has no `loaderData`, use the property name the installed React Router version documents for route data in `meta`.

Run: `npm run build`
Expected: prerender lines for `/` and `/git-basics`.

Run: `grep -c 'id="init"' build/client/git-basics/index.html`
Expected: `1`

Run: `grep -o '<figure class="code">' build/client/git-basics/index.html | wc -l`
Expected: `7` (seven code blocks in the sample route)

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "Add route page with rail, stops and progress"
```

---

### Task 8: Design checkpoint

**Files:** none created. Changes, if any, are limited to `app/styles/*.css` and component markup.

**Interfaces:**
- Consumes: the running site from Tasks 6 and 7.
- Produces: the owner's explicit approval of the look. Tasks 9 to 11 do not start without it.

This is a gate from the spec (section 5.6). The owner has said the UI decides whether the project satisfies them.

- [ ] **Step 1: Start the preview**

Run: `npm run dev`
Expected: a local URL, normally `http://localhost:5173/`.

- [ ] **Step 2: Self-review against the design rules before showing the owner**

Open `/` and `/git-basics` at 1440px wide. Mark three stops done so the progress states are visible. Check every item and fix what fails:

- Black 44px global nav; frosted sub-nav on the route page that blurs content scrolling under it.
- Tiles alternate white, dark and parchment with no borders or radius between them.
- Hero headline is 56px, weight 600, tight tracking. Body text is 17px.
- Exactly one accent colour is visible, apart from the amber Warning label.
- No shadows and no gradients anywhere.
- Cards and code blocks have 18px radius; actions are pills; pressing a pill or the checkbox shrinks it.
- Checking a stop animates the check mark, updates the sub-nav count, the rail count and the route-path graphic.
- Returning to `/` shows the dark Continue tile with the correct next stop.
- Code blocks show the filename strip where a title is given, and the copy button copies.
- The capstone header is a dark card; Note, Warning and Done when callouts are distinguishable.
- Nothing overflows horizontally.

- [ ] **Step 3: Show the owner**

Give the owner the two URLs and screenshots of both pages. Ask: "Does this look right, or is it too plain?"

- [ ] **Step 4: Iterate until approved**

If the owner finds it too plain, apply the levers the spec agreed, in this order, and show again after each:

1. More dark tiles: make the "Where to start" section a dark tile, and give every part header the dark card treatment used by the capstone.
2. Illustration: enlarge the route-path graphic in the hero to span the content width and add stop labels under the dots.
3. A per-route accent colour: add an optional `accent` field to `route.yaml` (hex string), pass it through `RouteSummary` and `RouteView`, and set `--accent`, `--accent-fill` and `--accent-on-dark` as inline custom properties on the card and on the route page wrapper. This changes Tasks 1, 3, 6 and 7 code and needs tests for the new field.

Any other change the owner asks for is made here as well.

- [ ] **Step 5: Record the approval and commit**

Only after the owner says the look is approved:

```bash
git add -A
git commit -m "Apply design checkpoint feedback" --allow-empty
```

---

### Task 9: Dark theme, responsive layout and phone drawer

**Files:**
- Modify: `app/styles/tokens.css` (append), `app/styles/components.css` (append)
- Create: `app/styles/responsive.css`
- Create: `app/components/RailDrawer.tsx`
- Modify: `app/routes/route.tsx`, `app/root.tsx`
- Create: `tests/components/RailDrawer.test.tsx`

**Interfaces:**
- Consumes: `Rail`, `SubNav` (its `children` slot), `PartView`.
- Produces: `RailDrawer({ parts: PartView[]; doneIds: ReadonlySet<string>; active: string | null })`. It renders a "Parts" trigger button (class `parts-trigger`, hidden above 833px by CSS) and a Radix dialog containing the `Rail`.
- Breakpoints (max-width): 1068px, 833px, 640px, 419px.

- [ ] **Step 1: Write the failing drawer test**

`tests/components/RailDrawer.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RailDrawer } from "../../app/components/RailDrawer";
import type { PartView } from "../../content/view";

afterEach(cleanup);

const parts: PartView[] = [
  {
    id: "local",
    title: "Work locally",
    goal: "",
    kind: "part",
    number: 1,
    introHtml: "",
    stops: [{ id: "init", title: "Init", html: "", doneWhenHtml: null, isStep: false }],
  },
];

describe("RailDrawer", () => {
  it("is closed until the Parts button is pressed", () => {
    render(<RailDrawer parts={parts} doneIds={new Set()} active={null} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Work locally/ }).getAttribute("href")).toBe("#part-local");
  });

  it("closes when a part is chosen", () => {
    render(<RailDrawer parts={parts} doneIds={new Set()} active={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    fireEvent.click(screen.getByRole("link", { name: /Work locally/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes with the close button", () => {
    render(<RailDrawer parts={parts} doneIds={new Set()} active={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/components/RailDrawer.test.tsx`
Expected: FAIL, cannot resolve `../../app/components/RailDrawer`.

- [ ] **Step 3: Create `app/components/RailDrawer.tsx`**

```tsx
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { PartView } from "../../content/view";
import { Rail } from "./Rail";

interface Props {
  parts: PartView[];
  doneIds: ReadonlySet<string>;
  active: string | null;
}

/** The rail as a slide-in drawer for narrow screens. */
export function RailDrawer({ parts, doneIds, active }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="parts-trigger">Parts</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay" />
        <Dialog.Content className="drawer" aria-describedby={undefined}>
          <Dialog.Title className="drawer-title">Parts</Dialog.Title>
          <Rail parts={parts} doneIds={doneIds} active={active} onNavigate={() => setOpen(false)} />
          <Dialog.Close className="drawer-close" aria-label="Close">
            <span aria-hidden="true">×</span>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/components/RailDrawer.test.tsx`
Expected: PASS, 3 tests.

If the closing assertions fail because Radix keeps the dialog mounted while an exit animation runs, assert `screen.getByRole("button", { name: "Parts" }).getAttribute("aria-expanded")` equals `"false"` instead.

- [ ] **Step 5: Use the drawer in `app/routes/route.tsx`**

Add the import:

```tsx
import { RailDrawer } from "../components/RailDrawer";
```

Replace the self-closing `<SubNav ... />` element with:

```tsx
      <SubNav title={route.title} done={doneIds.size} total={stops.length} nextId={next?.id ?? null}>
        <RailDrawer parts={route.parts} doneIds={doneIds} active={active} />
      </SubNav>
```

- [ ] **Step 6: Append drawer styles to `app/styles/components.css`**

```css
/* Phone drawer */
.parts-trigger {
  display: none;
  align-items: center;
  min-height: 32px;
  padding: 6px 14px;
  border: 1px solid var(--hairline);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink);
  font-size: 14px;
  cursor: pointer;
  transition: transform 0.15s ease;
}

.parts-trigger:active {
  transform: scale(0.95);
}

.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.4);
}

.drawer {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 50;
  width: min(86vw, 340px);
  padding: 20px 16px;
  overflow-y: auto;
  background: var(--canvas);
}

.drawer-title {
  margin: 6px 12px 16px;
  font-size: 21px;
  font-weight: 600;
}

.drawer-close {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 50%;
  background: var(--parchment);
  color: var(--ink);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  transition: transform 0.15s ease;
}

.drawer-close:active {
  transform: scale(0.95);
}

.drawer .rail-link {
  padding: 12px;
  font-size: 17px;
}

@keyframes drawer-in {
  from {
    transform: translateX(-100%);
  }
}

@keyframes drawer-out {
  to {
    transform: translateX(-100%);
  }
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
}

@keyframes fade-out {
  to {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .drawer[data-state="open"] {
    animation: drawer-in 0.35s var(--ease);
  }

  .drawer[data-state="closed"] {
    animation: drawer-out 0.2s ease-in;
  }

  .drawer-overlay[data-state="open"] {
    animation: fade-in 0.2s ease;
  }

  .drawer-overlay[data-state="closed"] {
    animation: fade-out 0.2s ease;
  }
}
```

- [ ] **Step 7: Create `app/styles/responsive.css`**

```css
@media (max-width: 1068px) {
  .hero-title {
    font-size: 40px;
  }

  .tile-title {
    font-size: 34px;
  }

  .tile-lead {
    font-size: 24px;
  }

  .route-body {
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 32px;
  }
}

@media (max-width: 833px) {
  .card-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .route-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .route-rail {
    display: none;
  }

  .parts-trigger {
    display: inline-flex;
  }

  .subnav-count {
    display: none;
  }

  .part-title {
    font-size: 34px;
  }
}

@media (max-width: 640px) {
  .tile {
    padding: 48px 20px;
  }

  .container,
  .container-narrow,
  .subnav-inner,
  .global-nav-inner,
  .route-body {
    width: min(100% - 32px, 1440px);
  }

  .card-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .hero-title {
    font-size: 34px;
  }

  .section-title {
    font-size: 28px;
  }

  .tile-lead {
    font-size: 21px;
  }

  .start-list {
    font-size: 17px;
  }

  .part-title {
    font-size: 28px;
  }

  .part-goal {
    font-size: 19px;
  }

  .part-head-capstone {
    padding: var(--s-xl) 20px;
  }

  .stop-title {
    font-size: 21px;
  }

  .global-nav-inner {
    gap: 20px;
  }
}

@media (max-width: 419px) {
  .hero-title {
    font-size: 28px;
  }

  .subnav-title {
    font-size: 17px;
  }
}
```

- [ ] **Step 8: Import the responsive styles in `app/root.tsx`**

Add after the `prose.css` import, so it is the last stylesheet:

```tsx
import "./styles/responsive.css";
```

- [ ] **Step 9: Append the dark theme to `app/styles/tokens.css`**

The source design documents light only. This set is derived from its dark-tile surfaces. Code blocks stay dark in both themes.

```css
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;

    --accent: #2997ff;
    --accent-fill: #0071e3;
    --accent-focus: #2997ff;

    --ink: #f5f5f7;
    --ink-muted: #d2d2d7;
    --ink-faint: #86868b;

    --canvas: #000000;
    --parchment: #161617;
    --card: #1d1d1f;
    --tile-dark: #1d1d1f;

    --hairline: #424245;
    --divider: #2a2a2c;
    --nav-frost: rgba(22, 22, 23, 0.8);
    --nav-line: rgba(255, 255, 255, 0.12);

    --code-bg: #161617;
    --warning: #ff9f0a;
  }

  .global-nav {
    border-bottom: 1px solid var(--nav-line);
  }
}
```

- [ ] **Step 10: Run all tests and type-check**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 11: Check the layouts by hand**

Run `npm run dev` and check `/` and `/git-basics` at each size, in light and dark:

| Width | Expect |
|---|---|
| 1440px | Three-column card grid; rail visible beside the content |
| 1000px | Hero at 40px; rail still visible, narrower |
| 800px | Two-column card grid; rail hidden; "Parts" button in the sub-nav opens the drawer |
| 375px | One-column grid; hero at 28–34px; no horizontal scrolling; code blocks scroll inside themselves |

In the drawer at 375px, choose a part: the drawer must close and the page must scroll to that part. If the page does not scroll, add `modal={false}` to `Dialog.Root` in `RailDrawer.tsx`, which turns off Radix's scroll lock, and check again.

In dark mode confirm: black canvas, readable text everywhere, the frosted sub-nav still blurs, the done check is visible, callouts are distinguishable from the canvas.

Show the owner the phone and dark views. Apply any changes they ask for.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "Add dark theme, responsive layout and phone drawer"
```

---

### Task 10: Build smoke test and deployment workflow

**Files:**
- Create: `tests/build/smoke.test.ts`
- Create: `.github/workflows/pages.yml`

**Interfaces:**
- Consumes: `npm run build`, `ROADMAP_ROUTES_DIR`, `BASE_PATH`, `VITE_REPO_URL`.
- Produces: a static site in `build/client/`, and a workflow that validates, tests, builds and deploys it.
- The smoke test builds the fixture routes into `build/`. Anyone who wants the real site locally afterwards runs `npm run build` again.

- [ ] **Step 1: Write the smoke test**

`tests/build/smoke.test.ts`:

```ts
import { execSync } from "node:child_process";
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const env = (routesDir: string) => ({
  ...process.env,
  ROADMAP_ROUTES_DIR: routesDir,
  BASE_PATH: "/sub/",
});

/** React separates adjacent text nodes with comments; drop them before matching text. */
const read = (file: string) =>
  fs.readFileSync(`build/client/${file}`, "utf8").replace(/<!--.*?-->/g, "");

describe("static build under a sub-path", () => {
  beforeAll(() => {
    execSync("npm run build", { stdio: "pipe", env: env("tests/fixtures/routes") });
  }, 240_000);

  it("prerenders the landing page and one page per published route", () => {
    expect(fs.existsSync("build/client/index.html")).toBe(true);
    expect(fs.existsSync("build/client/sample/index.html")).toBe(true);
    expect(fs.existsSync("build/client/hidden/index.html")).toBe(false);
  });

  it("lists the route with its counts on the landing page", () => {
    const html = read("index.html");
    expect(html).toContain("Sample route");
    expect(html).toContain("0 of 4 stops · 2 parts");
    expect(html).toContain("Learn by building.");
  });

  it("renders stops with anchors, highlighted code and callouts", () => {
    const html = read("sample/index.html");
    for (const id of ["first-stop", "second-stop", "spec", "step-1"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('id="part-basics"');
    expect(html).toContain('<figure class="code">');
    expect(html).toContain("callout-note");
    expect(html).toContain("Done when");
    expect(html).toContain("0 of 4 done");
  });

  it("prefixes every root-relative URL with the base path", () => {
    for (const file of ["index.html", "sample/index.html"]) {
      const urls = [...read(file).matchAll(/\s(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.filter((url) => !url.startsWith("/sub/"))).toEqual([]);
    }
  });

  it("copies route assets and links them through the base path", () => {
    expect(fs.existsSync("build/client/route-assets/sample/flow.svg")).toBe(true);
    expect(read("sample/index.html")).toContain('src="/sub/route-assets/sample/flow.svg"');
  });
});

describe("build with invalid content", () => {
  it("fails", () => {
    expect(() =>
      execSync("npm run build", { stdio: "pipe", env: env("tests/fixtures/invalid-routes") }),
    ).toThrow();
  }, 120_000);
});
```

- [ ] **Step 2: Run the smoke test**

Run: `npm test -- tests/build/smoke.test.ts`
Expected: PASS, 6 tests. This is the first time the site is built under a sub-path, so failures here are real findings:

- If files land under `build/client/sub/` instead of `build/client/`, the workflow's upload path in Step 4 must become `build/client/sub`, and the paths in this test must change to match. Read the installed React Router version's notes on `basename` with pre-rendering before changing anything else.
- If a URL lacks the `/sub/` prefix, find where it is produced. Links must use React Router's `Link` or `import.meta.env.BASE_URL`, never a hard-coded `/`.

- [ ] **Step 3: Find the current major versions of the actions**

Run:

```bash
for a in checkout setup-node upload-pages-artifact deploy-pages; do printf "%s " "$a"; git ls-remote --tags --refs "https://github.com/actions/$a" 'v*' | sed 's|.*refs/tags/||' | sort -V | tail -1; done
```

Expected: four lines such as `checkout v5.0.0`. Note the major version of each.

- [ ] **Step 4: Create `.github/workflows/pages.yml`**

Replace each `@vN` below with the major version found in Step 3.

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@vN
      - uses: actions/setup-node@vN
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run validate
      - run: npm test
      - name: Build
        run: npm run build
        env:
          BASE_PATH: /${{ github.event.repository.name }}/
          VITE_REPO_URL: ${{ github.server_url }}/${{ github.repository }}
      - name: Serve the app's not-found page for unknown URLs
        run: |
          if [ -f build/client/__spa-fallback.html ]; then
            cp build/client/__spa-fallback.html build/client/404.html
          fi
      - uses: actions/upload-pages-artifact@vN
        with:
          path: build/client

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@vN
```

The workflow runs `npm test` before `npm run build`. The smoke test leaves a fixture build in `build/`, and the real build then replaces it.

- [ ] **Step 5: Check the workflow file**

Run: `grep -c "@vN" .github/workflows/pages.yml`
Expected: `0` (every placeholder replaced).

Run: `node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/pages.yml','utf8')); console.log('valid yaml')"`
Expected: `valid yaml`

- [ ] **Step 6: Rebuild the real site and run everything**

Run: `npm test`
Expected: PASS, all files.

Run: `npm run build`
Expected: `OK: 1 route(s), 7 stop(s).` and prerender lines for `/` and `/git-basics`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add build smoke test and Pages workflow"
```

---

### Task 11: Authoring docs

**Files:**
- Create: `CLAUDE.md`, `.claude/skills/new-route/SKILL.md`, `README.md`

**Interfaces:**
- Consumes: the content rules from Tasks 1 to 3 and the commands from `package.json`.
- Produces: the instructions any later Claude session follows to write a valid route.

- [ ] **Step 1: Create `CLAUDE.md`**

````markdown
# RoadMap

A site of hands-on learning guides. Content is Markdown under `routes/`; a React Router app prerenders it to static HTML; GitHub Actions deploys it to GitHub Pages.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Local preview with live reload |
| `npm run validate` | Check everything under `routes/` |
| `npm test` | All tests, including a full build of the fixture site |
| `npm run build` | Validate, then build the static site into `build/client/` |

Node 24.15 or newer is required.

## Layout

- `routes/` content. One folder per route.
- `content/` build-time pipeline: load, validate, render. No React.
- `app/` the React app. `app/styles/tokens.css` holds the design tokens.
- `tests/` Vitest tests and fixture routes.
- `docs/superpowers/specs/` the design spec.

## Content rules

```
routes/<route-slug>/
  route.yaml
  assets/                 optional images
  01-<part-id>/
    part.md
    01-<stop-id>.md
```

- The folder name is the route slug. Numeric prefixes set order and are not part of an id.
- A stop id is the filename without prefix and extension. It is the page anchor and the progress key, so renaming a stop file loses readers' saved progress for it. Ids are unique within a route.
- `route.yaml`: `title`, `number` (unique), `summary` are required. Optional: `hero`, `lede`, `prerequisites` (route slugs), `checked` (`YYYY-MM`), `draft` (`true` hides the route). Quote any value that contains `: `.
- `part.md` front matter: `title`, `goal`, and `kind: capstone` for a capstone. The body is an optional intro.
- Stop front matter: `title`, and `done_when` for a checkable finish line.
- In a capstone part, a stop whose id starts with `step-` is a step and must have `done_when`.
- Every code fence names a language. Add `title="path/to/file"` to show a filename.
- Callouts: `> [!NOTE]` and `> [!WARNING]`.
- References: `[[stop-id]]` in the same route, `[[route-slug/stop-id]]` in another. The link text is the target's title.
- Images live in the route's `assets/` folder and are referenced by filename: `![Alt](flow.svg)`.
- Raw HTML in Markdown is shown as text, never rendered.

## Writing stops

One idea per stop: one to three short paragraphs, one working example, an optional note. Check commands and library APIs against official documentation, pin versions, and set `checked` to the current month.

A capstone has a spec stop, then steps. Each step lists what to do, refers back to earlier stops with `[[...]]`, shows the result, and ends with `done_when`.

To write a new route, use the `new-route` skill.

## Design rules

The look follows an Apple-inspired system. Keep to it when changing UI:

- One accent colour, Action Blue. The only other colour is the amber Warning label.
- No shadows, no gradients.
- Full-bleed tiles alternate white, parchment and dark; the colour change is the divider.
- Body text 17px; headings weight 600; weight 500 is never used.
- Radii: 8px utility, 18px cards and code, pills for actions. Buttons shrink to 0.95 when pressed.
- Use the tokens in `app/styles/tokens.css`; do not hard-code colours in components.

## Git

Commit freely. Do not push unless asked.
````

- [ ] **Step 2: Create `.claude/skills/new-route/SKILL.md`**

```markdown
---
name: new-route
description: Write a new learning route (guide) for the RoadMap site. Use when asked to add, create or write a route, guide or course on a topic.
---

# New route

Follow the content rules in `CLAUDE.md`. Work through these steps in order.

## 1. Ask

Ask the owner, one question at a time:

1. What is the topic, and what should the reader be able to do at the end?
2. What does the reader already know?
3. What should the capstone project be? Offer a suggestion.

## 2. Outline and wait

Propose an outline and wait for the owner's approval before writing any stop:

- the route slug, title, number (next free number) and summary;
- parts in order, each with its goal line;
- the stops in each part, by title;
- the capstone: its spec and its steps, each with a draft `done_when`;
- prerequisites, if another route should be read first.

Order parts from foundations to application. Each non-capstone part should teach something the capstone uses.

## 3. Write

Create `routes/<slug>/route.yaml` with `draft: true`, then the parts and stops.

- One idea per stop: one to three short paragraphs, one working example, an optional note.
- Check every command and API against official documentation. Pin versions. Do not write from memory alone.
- Capstone steps list tasks, refer back to earlier stops with `[[stop-id]]`, show the code as it stands at the end of the step, and end with `done_when`.
- Set `checked` to the current month as `YYYY-MM`.

## 4. Validate

Run `npm run validate`. Fix every problem it reports and run it again until it prints `OK`.

A draft route is skipped by validation, so set `draft: false` before this step.

## 5. Preview

Run `npm run dev`, open the route in the browser, and read it top to bottom. Check that code blocks, callouts, tables and references render as intended. Give the owner the preview URL.

## 6. Commit

Commit the route. Push only when the owner asks; a push to `main` publishes the site.
```

- [ ] **Step 3: Create `README.md`**

```markdown
# RoadMap

Hands-on learning guides. Each guide is a route: short stops, one idea each, and a project at the end.

## Run it

Needs Node 24.15 or newer.

    npm install
    npm run dev

## Add a route

Content lives in `routes/`. The rules are in `CLAUDE.md`. In Claude Code, ask for a new route and the `new-route` skill takes it from outline to preview.

Check content with `npm run validate`.

## Publish

Pushing to `main` runs the workflow in `.github/workflows/pages.yml`, which validates, tests, builds and deploys to GitHub Pages.

One-time setup:

1. Create a public repository on GitHub and add it as `origin`.
2. In the repository's Settings → Pages, set Source to "GitHub Actions".
3. Push `main`.

The site appears at `https://<username>.github.io/<repository>/`.

## How it works

- `content/` loads `routes/`, validates it and renders Markdown to HTML at build time.
- `app/` is a React Router app, prerendered to one static page per route.
- Progress is stored in the browser's `localStorage` and is not synced between devices.
```

- [ ] **Step 4: Final verification**

Run: `npm run validate`
Expected: `OK: 1 route(s), 7 stop(s).`

Run: `npm test`
Expected: PASS, all files.

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: prerender lines for `/` and `/git-basics`.

Run: `git status --short`
Expected: only the three new documentation files.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add authoring docs and new-route skill"
```

---

## After the plan: owner steps

These are the owner's actions and are not performed by the implementer:

1. Create a public repository on GitHub.
2. `git remote add origin <url>`
3. In the repository's Settings → Pages, set Source to "GitHub Actions".
4. `git push -u origin main`
5. Open the Actions tab, wait for the workflow, then open `https://<username>.github.io/<repository>/`.

## Spec coverage

| Spec section | Task |
|---|---|
| 2 Content model, 3 Layout and file formats | 1, 5, 11 |
| 4 Build pipeline: load | 1 |
| 4 validate, 4.1 rules, CLI | 2 |
| 4 render, Shiki, references, callouts, no raw HTML | 3 |
| 4 prerender, 4.2 commands | 6, 10 |
| 5.1 Tokens, 5.2 rules | 6 |
| 5.3 Components | 6, 7, 9 |
| 5.4 Richness: dark tiles, path graphic, motion | 6, 7 |
| 5.5 Themes and responsiveness | 9 |
| 5.6 Design checkpoint | 8 |
| 6 Progress | 4, wired in 6 and 7 |
| 7 Authoring workflow | 11 |
| 8 Deployment | 10 |
| 9 Testing | every task; smoke test in 10 |
| 10 First milestone order | Tasks follow it, except that the progress store (4) comes before the pages so the checkpoint shows working progress |
