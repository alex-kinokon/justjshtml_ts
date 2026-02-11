import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { FragmentContext } from "../src/context.ts";
import { JustHTML } from "../src/justhtml.ts";
import { toTestFormat } from "../src/serialize.ts";

import { listDatFilesRecursive, resolveHtml5libTestsDir } from "./html5lib-test-utils.ts";

interface TreeConstructionFixture {
  readonly input: string;
  readonly expected: string;
  readonly errors: string[];
  readonly fragmentContext: FragmentContext | undefined;
  readonly scriptDirective: "script-on" | "script-off" | undefined;
  readonly xmlCoercion: boolean;
  readonly iframeSrcdoc: boolean;
}

function decodeEscapes(text: string): string {
  // eslint-disable-next-line unicorn/prefer-string-raw
  if (!text.includes("\\x") && !text.includes("\\u")) return text;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "x" && i + 3 < text.length) {
        const hex = text.slice(i + 2, i + 4);
        const code = Number.parseInt(hex, 16);
        if (!Number.isNaN(code)) {
          out += String.fromCharCode(code);
          i += 3;
          continue;
        }
      }
      if (next === "u" && i + 5 < text.length) {
        const hex = text.slice(i + 2, i + 6);
        const code = Number.parseInt(hex, 16);
        if (!Number.isNaN(code)) {
          out += String.fromCharCode(code);
          i += 5;
          continue;
        }
      }
    }
    out += ch;
  }
  return out;
}

const normalize = (s: string) =>
  s
    .trim()
    .split("\n")
    .map(line => line.replace(/\s+$/, ""))
    .join("\n");

function compareOutputs(expected: string, actual: string): boolean {
  return normalize(expected) === normalize(actual);
}

function parseDatFile(content: string): TreeConstructionFixture[] {
  const lines = content.split("\n");

  const tests: TreeConstructionFixture[] = [];
  let current: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    current.push(lines[i]!);
    const nextIsNewTest = i + 1 >= lines.length || lines[i + 1] === "#data";
    if (!nextIsNewTest) continue;

    if (current.some(l => l.trim())) {
      const test = parseSingleTest(current);
      if (test) tests.push(test);
    }
    current = [];
  }

  return tests;
}

type Mode = "data" | "errors" | "new-errors" | "document" | "document-fragment";

function parseSingleTest(lines: string[]): TreeConstructionFixture | undefined {
  let mode: Mode | undefined;
  const data: string[] = [];
  const errors: string[] = [];
  const document: string[] = [];

  let fragmentContext: FragmentContext | undefined;
  let scriptDirective: "script-on" | "script-off" | undefined;
  let xmlCoercion = false;
  let iframeSrcdoc = false;

  for (const line of lines) {
    if (line.startsWith("#")) {
      const directive = line.slice(1);
      if (directive === "script-on" || directive === "script-off") {
        scriptDirective = directive;
        continue;
      }
      if (directive === "xml-coercion") {
        xmlCoercion = true;
        continue;
      }
      if (directive === "iframe-srcdoc") {
        iframeSrcdoc = true;
        continue;
      }
      mode = directive as Mode;
      continue;
    }

    switch (mode) {
      case "data":
        data.push(line);
        break;

      case "errors":
      case "new-errors":
        errors.push(line);
        break;

      case "document":
        document.push(line);
        break;

      case "document-fragment": {
        const frag = line.trim();
        if (!frag) continue;
        if (frag.includes(" ")) {
          const [namespace, tagName] = frag.split(" ", 2);
          fragmentContext = new FragmentContext(tagName!, namespace);
        } else {
          fragmentContext = new FragmentContext(frag, undefined);
        }
        break;
      }
    }
  }

  if (!data.length && !document.length) {
    return;
  }

  return {
    input: decodeEscapes(data.join("\n")),
    expected: document.join("\n"),
    errors,
    fragmentContext,
    scriptDirective,
    xmlCoercion,
    iframeSrcdoc,
  };
}

test("html5lib tree-construction fixtures", async t => {
  const testsDir = resolveHtml5libTestsDir();
  const dir = path.join(testsDir, "tree-construction");
  if (!existsSync(dir)) {
    t.skip(`Missing fixtures: ${dir}`);
  }

  const datFiles = await listDatFilesRecursive(dir);
  assert.ok(datFiles.length > 0, `No tree-construction fixtures found under: ${dir}`);
  const failures: string[] = [];

  for (const filePath of datFiles) {
    const fileRel = path.relative(testsDir, filePath);
    const content = await readFile(filePath, "utf8");
    const tests = parseDatFile(content);

    for (const [idx, fixture] of tests.entries()) {
      // Skip script-on until scripting flag is implemented.
      if (fixture.scriptDirective === "script-on") {
        continue;
      }
      try {
        const doc = new JustHTML(fixture.input, {
          fragmentContext: fixture.fragmentContext,
          iframeSrcdoc: fixture.iframeSrcdoc,
          tokenizerOpts: { xmlCoercion: fixture.xmlCoercion },
        });

        const actual = toTestFormat(doc.root);
        const ok = compareOutputs(fixture.expected, actual);
        const msg = `mismatch for ${fileRel}:${idx}`;
        assert.ok(ok, msg);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${fileRel}:${idx} ${detail}`);
      }
    }
  }

  const verbose = process.env.HTML5LIB_VERBOSE === "1";
  const shown = verbose ? failures : failures.slice(0, 20);
  const omitted = failures.length - shown.length;
  assert.equal(
    failures.length,
    0,
    `tree-construction fixture failures (${failures.length}):\n${shown.join("\n")}${omitted > 0 ? `\n... ${omitted} more (set HTML5LIB_VERBOSE=1)` : ""}`
  );
});
