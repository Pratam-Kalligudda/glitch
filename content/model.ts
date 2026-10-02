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
