import assert from "node:assert/strict";
import test from "node:test";

import {
  JustHTML,
  type Node,
  SelectorError,
  matches,
  querySelectorAll,
} from "../src/index.ts";

function $<T extends Node>(root: T, selectorString: string): T[] {
  return Array.from(querySelectorAll(root, selectorString));
}

function getSimpleDoc() {
  const html = /* html */ `
    <html>
      <head><title>Test</title></head>
      <body>
        <div id="main" class="container">
          <h1>Title</h1>
          <p class="intro first">First paragraph</p>
          <p class="content">Second paragraph</p>
          <ul>
            <li>Item 1</li>
            <li class="special">Item 2</li>
            <li>Item 3</li>
          </ul>
        </div>
        <div id="sidebar" class="container secondary">
          <a href="http://example.com" data-id="123">Link</a>
        </div>
      </body>
    </html>
  `;
  return new JustHTML(html).root;
}

function getSiblingDoc() {
  const html = /* html */ `
    <html><body>
      <div>
        <h1>Heading</h1>
        <p class="first">First</p>
        <p class="second">Second</p>
        <p class="third">Third</p>
        <span>Not a p</span>
        <p class="fourth">Fourth</p>
      </div>
    </body></html>
  `;
  return new JustHTML(html).root;
}

function getEmptyDoc() {
  const html = /* html */ `
    <html><body>
      <div class="empty"></div>
      <div class="whitespace">   </div>
      <div class="text">content</div>
      <div class="nested"><span></span></div>
    </body></html>
  `;
  return new JustHTML(html).root;
}

test("tag selector", () => {
  const root = getSimpleDoc();
  const out = $(root, "p");
  assert.equal(out.length, 2);
  assert.ok(out.every(n => n.name === "p"));
});

test("tag selector is case-insensitive", () => {
  const root = getSimpleDoc();
  assert.equal($(root, "P").length, 2);
});

test("id selector", () => {
  const root = getSimpleDoc();
  const out = $(root, "#main");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.getAttribute("id"), "main");
});

test("class selector", () => {
  const root = getSimpleDoc();
  assert.equal($(root, ".container").length, 2);
});

test("compound selector (tag + classes)", () => {
  const root = getSimpleDoc();
  const out = $(root, "p.intro.first");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.getAttribute("class"), "intro first");
});

test("attribute presence", () => {
  const root = getSimpleDoc();
  const out = $(root, "[href]");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "a");
});

test("attribute exact match", () => {
  const root = getSimpleDoc();
  const out = $(root, '[data-id="123"]');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "a");
});

test("descendant combinator", () => {
  const root = getSimpleDoc();
  const out = $(root, "div#main p.content");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.getAttribute("class"), "content");
});

test("child combinator", () => {
  const root = getSimpleDoc();
  const out = $(root, "div#main > h1");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "h1");
});

test("adjacent sibling combinator", () => {
  const root = getSiblingDoc();
  const out = $(root, "p.first + p");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.getAttribute("class"), "second");
});

test("general sibling combinator", () => {
  const root = getSiblingDoc();
  const out = $(root, "p.first ~ p");
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map(n => n.getAttribute("class")),
    ["second", "third", "fourth"]
  );
});

test(":first-child / :last-child", () => {
  const root = getSimpleDoc();
  const first = $(root, "li:first-child");
  const last = $(root, "li:last-child");
  assert.equal(first.length, 1);
  assert.equal(last.length, 1);
  assert.equal(first[0]!.toText({ separator: "", strip: true }), "Item 1");
  assert.equal(last[0]!.toText({ separator: "", strip: true }), "Item 3");
});

test(":nth-child(2)", () => {
  const root = getSimpleDoc();
  const out = $(root, "li:nth-child(2)");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.getAttribute("class"), "special");
});

test(":not(.special)", () => {
  const root = getSimpleDoc();
  const out = $(root, "li:not(.special)");
  assert.equal(out.length, 2);
});

test(":empty matches whitespace-only text", () => {
  const root = getEmptyDoc();
  const out = $(root, "div:empty");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(n => n.getAttribute("class")).sort(), ["empty", "whitespace"]);
});

test(":root matches document element", () => {
  const root = getSimpleDoc();
  const out = $(root, ":root");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "html");
});

test("matches()", () => {
  const root = getSimpleDoc();
  const p = $(root, "p.intro")[0]!;
  assert.equal(matches(p, "p"), true);
  assert.equal(matches(p, ".intro"), true);
  assert.equal(matches(p, ".content"), false);
});

test("invalid selector throws SelectorError", () => {
  const root = getSimpleDoc();
  assert.throws(() => $(root, "#"), SelectorError);
  assert.throws(() => $(root, ""), SelectorError);
});

test("querySelector returns first match", () => {
  const root = getSimpleDoc();
  const firstP = root.querySelector("p");
  assert.ok(firstP);
  assert.equal(firstP.getAttribute("class"), "intro first");
});

test("querySelector returns null when no match", () => {
  const root = getSimpleDoc();
  assert.equal(root.querySelector(".does-not-exist"), null);
});
