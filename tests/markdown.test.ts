/* eslint-disable unicorn/prefer-string-raw */
import assert from "node:assert/strict";
import test from "node:test";

import { JustHTML, Node } from "../src/index.ts";
import { toMarkdown } from "../src/markdown.ts";

test("headings + paragraphs + inline", () => {
  const doc = new JustHTML(
    "<h1>Title</h1><p>Hello <b>world</b> <em>ok</em> <a href='https://e.com'>link</a> a*b</p>"
  );
  const md = toMarkdown(doc.root);
  assert.ok(md.startsWith("# Title\n\n"));
  assert.ok(md.includes("Hello **world** *ok* [link](https://e.com) a\\*b"));
});

test("code inline + block", () => {
  const doc = new JustHTML("<pre>code`here\n</pre><p>inline <code>a`b</code></p>");
  const md = toMarkdown(doc.root);
  assert.ok(md.includes("```\ncode`here\n```"));
  assert.ok(md.includes("inline ``a`b``"));
});

test("blockquote + br", () => {
  const doc = new JustHTML("<blockquote><p>Q<br>R</p></blockquote>");
  assert.equal(toMarkdown(doc.root), "> Q\n> R");
});

test("lists", () => {
  const doc = new JustHTML(
    "<ul><li>One</li><li>Two</li></ul><ol><li>A</li><li>B</li></ol>"
  );
  const md = toMarkdown(doc.root);
  assert.ok(md.includes("- One\n- Two"));
  assert.ok(md.includes("1. A\n2. B"));
});

test("tables + images preserved as HTML", () => {
  const doc = new JustHTML(
    "<p>Hi<img src=x alt=y>there</p><table><tr><td>A</td></tr></table>"
  );
  const md = toMarkdown(doc.root);
  assert.ok(md.includes("<img src=x alt=y>"));
  assert.ok(md.includes("<table"));
  assert.ok(md.includes("<td>A</td>"));
  assert.ok(md.includes("</table>"));
});

test("ignores comment + doctype", () => {
  const root = new Node("div");
  root.appendChild(new Node("#comment", "nope"));
  root.appendChild(new Node("!doctype", undefined, "html"));
  root.appendChild(new Node("#text", "ok"));
  assert.equal(toMarkdown(root), "ok");
});

test("preserves script/style whitespace", () => {
  const root = new Node("div");
  const script = new Node("script");
  script.appendChild(new Node("#text", "var x = 1;\nvar y = 2;\n"));
  root.appendChild(script);
  assert.equal(toMarkdown(root), "var x = 1;\nvar y = 2;");
});

test("text node escaping", () => {
  const t = new Node("#text", "a*b");
  assert.equal(toMarkdown(t), "a\\*b");
});

test("empty text node", () => {
  const t = new Node("#text", "");
  assert.equal(toMarkdown(t), "");
});

test("br on empty buffer", () => {
  const doc = new JustHTML("<br><br><br>");
  assert.equal(toMarkdown(doc.root), "");
});

test("empty blocks + hr", () => {
  const doc = new JustHTML("<hr><h2></h2><p></p><pre></pre><blockquote></blockquote>");
  const md = toMarkdown(doc.root);
  assert.ok(md.includes("---"));
  assert.ok(md.includes("##"));
  assert.ok(md.includes("```\n```"));
});

test("list skips non-li children", () => {
  const doc = new JustHTML("<ul>\n<li>One</li>\n</ul>");
  assert.equal(toMarkdown(doc.root), "- One");
});

test("link without href", () => {
  const doc = new JustHTML("<p><a>text</a></p>");
  assert.equal(toMarkdown(doc.root), "[text]");
});

test("template includes templateContent", () => {
  const doc = new JustHTML("<template>T</template>");
  const html = doc.root.childNodes[0]!;
  const head = html.childNodes[0]!;
  const template = head.childNodes[0]!;
  assert.equal(toMarkdown(template), "T");
});

test("document container direct", () => {
  const doc = new Node("#document");
  doc.appendChild(new Node("p"));
  assert.equal(toMarkdown(doc), "");
});
