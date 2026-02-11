#!/usr/bin/env node --experimental-transform-types
/* eslint-disable no-console */
import { JustHTML, stream } from "./src/index.ts";

const doc = new JustHTML("<p class='intro'>Hello <b>world</b></p>");

console.log(doc.toText()); // "Hello world"
console.log(doc.querySelector("p.intro")!.toHTML()); // pretty-printed HTML for the matching node

for (const [event, data] of stream("<div>Hi</div>")) {
  console.log(event, data);
}
