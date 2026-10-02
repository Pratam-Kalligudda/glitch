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
