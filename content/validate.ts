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
