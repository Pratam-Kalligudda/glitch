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
