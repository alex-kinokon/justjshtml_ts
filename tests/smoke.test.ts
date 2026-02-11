import assert from "node:assert/strict";
import test from "node:test";

import { JustHTML } from "../src/index.ts";
import { createTokenizer } from "../src/tokenizer.ts";
import { TokenSinkResult } from "../src/tokens.ts";

test("smoke", () => {
  const html = "<html><head></head><body><p>Hello</p></body></html>";
  const doc = new JustHTML(html);

  assert.equal(doc.errors.length, 0);
  assert.equal(doc.toText(), "Hello");

  assert.equal(doc.root.name, "#document");
  assert.equal(doc.root.childNodes.length, 1);

  const htmlNode = doc.root.childNodes[0]!;
  assert.equal(htmlNode.name, "html");
  assert.equal(htmlNode.parentNode, doc.root);

  assert.equal(htmlNode.childNodes.length, 2);
  const head = htmlNode.childNodes[0]!;
  const body = htmlNode.childNodes[1]!;

  assert.equal(head.name, "head");
  assert.equal(head.parentNode, htmlNode);
  assert.equal(head.childNodes.length, 0);

  assert.equal(body.name, "body");
  assert.equal(body.parentNode, htmlNode);
  assert.equal(body.childNodes.length, 1);

  const p = body.childNodes[0]!;
  assert.equal(p.name, "p");
  assert.equal(p.parentNode, body);
  assert.equal(p.childNodes.length, 1);

  const text = p.childNodes[0]!;
  assert.equal(text.name, "#text");
  assert.equal(text.parentNode, p);
  assert.equal(text.data, "Hello");
});

test("tokenizer collects parse errors", () => {
  const tokenizer = createTokenizer({
    processToken() {
      return TokenSinkResult.Continue;
    },
    processCharacters() {
      // No-op.
    },
  });

  tokenizer.run('<div a="1" a="2"></div>');
  assert.ok(tokenizer.errors.length > 0);
  assert.equal(typeof tokenizer.errors[0]?.code, "number");
  assert.equal(typeof tokenizer.errors[0]?.offset, "number");
});
