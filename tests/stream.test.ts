import assert from "node:assert/strict";
import test from "node:test";

import { stream } from "../src/index.ts";

function collect(gen: Iterable<unknown>) {
  return Array.from(gen);
}

test("basic stream", () => {
  const html = '<div class="container">Hello <b>World</b></div>';
  const events = collect(stream(html));
  const expected = [
    ["start", ["div", { class: "container" }]],
    ["text", "Hello "],
    ["start", ["b", {}]],
    ["text", "World"],
    ["end", "b"],
    ["end", "div"],
  ];
  assert.deepEqual(events, expected);
});

test("comments", () => {
  const events = collect(stream("<!-- comment -->"));
  assert.deepEqual(events, [["comment", " comment "]]);
});

test("doctype", () => {
  const events = collect(stream("<!DOCTYPE html>"));
  assert.deepEqual(events, [["doctype", ["html", undefined, undefined]]]);
});

test("void elements", () => {
  const events = collect(stream("<br><hr>"));
  assert.deepEqual(events, [
    ["start", ["br", {}]],
    ["start", ["hr", {}]],
  ]);
});

test("text coalescing", () => {
  const events = collect(stream("abc"));
  assert.deepEqual(events, [["text", "abc"]]);
});

test("script rawText", () => {
  const events = collect(stream("<script>console.log('<');</script>"));
  assert.deepEqual(events, [
    ["start", ["script", {}]],
    ["text", "console.log('<');"],
    ["end", "script"],
  ]);
});

test("unmatched end tag", () => {
  const events = collect(stream("</div>"));
  assert.deepEqual(events, [["end", "div"]]);
});
