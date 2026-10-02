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
