import type { Node } from "./node.ts";
import { nodeToHTML } from "./serialize.ts";

function markdownEscapeText(s: string): string {
  if (!s) return "";
  const out: string[] = [];
  for (const ch of s) {
    if ("\\`*_[]".includes(ch)) out.push("\\");
    out.push(ch);
  }
  return out.join("");
}

function markdownCodeSpan(text = ""): string {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }

  const fence = "`".repeat(longest + 1);
  return text.startsWith("`") || text.endsWith("`")
    ? `${fence} ${text} ${fence}`
    : `${fence}${text}${fence}`;
}

class MarkdownBuilder {
  buffer: string[] = [];
  private newlineCount = 0;
  private pendingSpace = false;

  private rstripLastSegment(): void {
    if (!this.buffer.length) return;
    const last = this.buffer.at(-1)!;
    const stripped = last.replace(/[\t ]+$/, "");
    if (stripped !== last) {
      this.buffer[this.buffer.length - 1] = stripped;
    }
  }

  newline(count = 1): void {
    for (let i = 0; i < count; i += 1) {
      this.pendingSpace = false;
      this.rstripLastSegment();
      this.buffer.push("\n");
      if (this.newlineCount < 2) {
        this.newlineCount += 1;
      }
    }
  }

  ensureNewlines(count: number): void {
    while (this.newlineCount < count) {
      this.newline(1);
    }
  }

  raw(text: string): void {
    if (!text) return;

    if (this.pendingSpace) {
      const first = text[0]!;
      if (!" \t\n\r\f".includes(first) && this.buffer.length && this.newlineCount === 0) {
        this.buffer.push(" ");
      }
      this.pendingSpace = false;
    }

    this.buffer.push(text);

    if (text.includes("\n")) {
      let trailing = 0;
      for (let i = text.length - 1; i >= 0 && text[i] === "\n"; i -= 1) {
        trailing += 1;
      }
      this.newlineCount = Math.min(2, trailing);
      if (trailing) {
        this.pendingSpace = false;
      }
    } else {
      this.newlineCount = 0;
    }
  }

  text(text: string, preserveWhitespace = false): void {
    if (!text) return;

    if (preserveWhitespace) {
      this.raw(text);
      return;
    }

    for (const ch of text) {
      if (" \t\n\r\f".includes(ch)) {
        this.pendingSpace = true;
        continue;
      }

      if (this.pendingSpace) {
        if (this.buffer.length && this.newlineCount === 0) this.buffer.push(" ");
        this.pendingSpace = false;
      }

      this.buffer.push(ch);
      this.newlineCount = 0;
    }
  }

  finish(): string {
    return this.buffer
      .join("")
      .replace(/^[\t\n ]+/, "")
      .replace(/[\t\n ]+$/, "");
  }
}

const MARKDOWN_BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "li",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
]);

function toMarkdownWalk(
  node: Node,
  builder: MarkdownBuilder,
  preserveWhitespace: boolean,
  listDepth: number
): void {
  const { name } = node;

  switch (name) {
    case "#text": {
      const { data } = node;
      const text = typeof data === "string" ? data : "";
      if (preserveWhitespace) {
        builder.raw(text);
      } else {
        builder.text(markdownEscapeText(text), false);
      }
      return;
    }

    case "br":
      builder.newline(1);
      return;

    case "#comment":
    case "!doctype":
      return;
  }

  if (typeof name === "string" && name.startsWith("#")) {
    for (const child of node.childNodes) {
      toMarkdownWalk(child, builder, preserveWhitespace, listDepth);
    }
    return;
  }

  const tag = name.toLowerCase();
  switch (tag) {
    case "img":
      builder.raw(nodeToHTML(node, 0, 2, false));
      return;

    case "table":
      builder.ensureNewlines(builder.buffer.length ? 2 : 0);
      builder.raw(nodeToHTML(node, 0, 2, false));
      builder.ensureNewlines(2);
      return;

    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      builder.ensureNewlines(builder.buffer.length ? 2 : 0);
      const level = Number.parseInt(tag[1]!, 10);
      builder.raw("#".repeat(level));
      builder.raw(" ");
      for (const child of node.childNodes) {
        toMarkdownWalk(child, builder, false, listDepth);
      }
      builder.ensureNewlines(2);
      return;
    }

    case "hr":
      builder.ensureNewlines(builder.buffer.length ? 2 : 0);
      builder.raw("---");
      builder.ensureNewlines(2);
      return;

    case "pre": {
      builder.ensureNewlines(builder.buffer.length ? 2 : 0);
      const code = node.toText({ separator: "", strip: false });
      builder.raw("```");
      builder.newline(1);
      if (code) {
        builder.raw(code.replace(/\n+$/, ""));
        builder.newline(1);
      }
      builder.raw("```");
      builder.ensureNewlines(2);
      return;
    }
  }

  if (tag === "code" && !preserveWhitespace) {
    const code = node.toText({ separator: "", strip: false });
    builder.raw(markdownCodeSpan(code));
    return;
  }

  switch (tag) {
    case "p":
      builder.ensureNewlines(builder.buffer.length ? 2 : 0);
      for (const child of node.childNodes) {
        toMarkdownWalk(child, builder, false, listDepth);
      }
      builder.ensureNewlines(2);
      return;

    case "blockquote": {
      builder.ensureNewlines(builder.buffer.length ? 2 : 0);
      const inner = new MarkdownBuilder();
      for (const child of node.childNodes) {
        toMarkdownWalk(child, inner, false, listDepth);
      }
      const text = inner.finish();
      if (text) {
        const lines = text.split("\n");
        // eslint-disable-next-line unicorn/no-for-loop
        for (let i = 0; i < lines.length; i += 1) {
          if (i) builder.newline(1);
          builder.raw("> ");
          builder.raw(lines[i]!);
        }
      }
      builder.ensureNewlines(2);
      return;
    }

    case "ul":
    case "ol": {
      builder.ensureNewlines(builder.buffer.length ? 2 : 0);
      const ordered = tag === "ol";
      let idx = 1;
      for (const child of node.childNodes) {
        if (child.name.toLowerCase() !== "li") continue;
        if (idx > 1) builder.newline(1);
        const indent = "  ".repeat(listDepth);
        const marker = ordered ? `${idx}. ` : "- ";
        builder.raw(indent);
        builder.raw(marker);
        for (const liChild of child.childNodes) {
          toMarkdownWalk(liChild, builder, false, listDepth + 1);
        }
        idx += 1;
      }
      builder.ensureNewlines(2);
      return;
    }

    case "em":
    case "i":
      builder.raw("*");
      for (const child of node.childNodes) {
        toMarkdownWalk(child, builder, false, listDepth);
      }
      builder.raw("*");
      return;

    case "strong":
    case "b":
      builder.raw("**");
      for (const child of node.childNodes) {
        toMarkdownWalk(child, builder, false, listDepth);
      }
      builder.raw("**");
      return;

    case "a": {
      let href = "";
      const attrValue = node.attrs.get("href");
      if (attrValue != null) {
        href = attrValue;
      }
      builder.raw("[");
      for (const child of node.childNodes) {
        toMarkdownWalk(child, builder, false, listDepth);
      }
      builder.raw("]");
      if (href) {
        builder.raw("(");
        builder.raw(href);
        builder.raw(")");
      }
      return;
    }
  }

  const nextPreserve =
    preserveWhitespace || tag === "textarea" || tag === "script" || tag === "style";

  for (const child of node.childNodes) {
    toMarkdownWalk(child, builder, nextPreserve, listDepth);
  }

  const templateContent = node.templateContent ?? null;
  if (templateContent) {
    toMarkdownWalk(templateContent, builder, nextPreserve, listDepth);
  }

  if (MARKDOWN_BLOCK_ELEMENTS.has(tag)) {
    builder.ensureNewlines(2);
  }
}

/**
 * Converts a parsed node tree to Markdown.
 */
export function toMarkdown(node: Node): string {
  const builder = new MarkdownBuilder();
  toMarkdownWalk(node, builder, false, 0);
  return builder.finish();
}
