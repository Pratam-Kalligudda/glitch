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

  it.each([
    ["inline link", "[a](javascript:alert(1))"],
    ["reference definition", '[a][r]\n\n[r]: javascript:alert(1) "t"'],
    ["autolink", "<javascript:alert(1)>"],
    ["mixed case with spaces", "[a](  JaVaScRiPt:alert(1))"],
    ["data URL", "[a](data:text/html,<script>alert(1)</script>)"],
    ["image source", "![x](javascript:alert(1))"],
  ])("drops a dangerous URL in a %s", async (_name, md) => {
    const html = await render(md);
    expect(html).not.toMatch(/(?:href|src)="\s*(?:javascript|data):/i);
  });

  it("keeps safe link URLs", async () => {
    const html = await render(
      "[a](https://x.dev/) [b](mailto:me@x.dev) [c](#init) [d](./notes.md) [e](/abs)",
    );
    for (const url of ["https://x.dev/", "mailto:me@x.dev", "#init", "./notes.md", "/abs"]) {
      expect(html).toContain(`href="${url}"`);
    }
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
