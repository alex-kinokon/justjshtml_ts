import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { normalizeEncodingLabel, sniffHTMLEncoding } from "../src/encoding.ts";

import {
  REPO_ROOT,
  listDatFilesRecursive,
  resolveHtml5libTestsDir,
} from "./html5lib-test-utils.ts";

interface EncodingFixture {
  readonly data: Buffer;
  readonly expectedLabel: string;
}

function splitLinesKeepEnds(buf: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < buf.length) lines.push(buf.subarray(start));
  return lines;
}

function rstripCRLF(buf: Uint8Array): Uint8Array {
  let end = buf.length;
  while (end > 0) {
    const b = buf[end - 1];
    if (b === 0x0a || b === 0x0d) end -= 1;
    else break;
  }
  return buf.subarray(0, end);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // eslint-disable-next-line unicorn/no-for-loop
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const BYTES_HASH_DATA = new Uint8Array([0x23, 0x64, 0x61, 0x74, 0x61]); // #data
const BYTES_HASH_ENCODING = new Uint8Array([
  0x23, 0x65, 0x6e, 0x63, 0x6f, 0x64, 0x69, 0x6e, 0x67,
]); // #encoding

function parseEncodingDatFile(buf: Uint8Array): EncodingFixture[] {
  const tests: EncodingFixture[] = [];
  let mode: "data" | "encoding" | undefined;
  let currentData: Buffer[] = [];
  let currentEncoding: string | undefined;

  const flush = () => {
    if (currentEncoding == null) return;
    tests.push({ data: Buffer.concat(currentData), expectedLabel: currentEncoding });
    currentData = [];
    currentEncoding = undefined;
  };

  for (const line of splitLinesKeepEnds(buf)) {
    const stripped = rstripCRLF(line);
    if (bytesEqual(stripped, BYTES_HASH_DATA)) {
      flush();
      mode = "data";
      continue;
    }
    if (bytesEqual(stripped, BYTES_HASH_ENCODING)) {
      mode = "encoding";
      continue;
    }

    if (mode === "data") currentData.push(Buffer.from(line));
    else if (mode === "encoding" && currentEncoding == null && stripped.length) {
      currentEncoding = Buffer.from(stripped).toString("ascii");
    }
  }

  flush();
  return tests;
}

test("html5lib encoding fixtures", async t => {
  const testsDir = resolveHtml5libTestsDir();
  const encodingDir = path.join(testsDir, "encoding");
  if (!existsSync(encodingDir)) t.skip(`Missing fixtures: ${encodingDir}`);

  const testFiles = await listDatFilesRecursive(encodingDir);
  assert.ok(testFiles.length > 0, `No encoding fixtures found under: ${encodingDir}`);
  const failures: string[] = [];

  for (const file of testFiles) {
    const isScripted = file.split(path.sep).includes("scripted");
    const buf = await readFile(file);
    const tests = parseEncodingDatFile(buf);
    const rel = path.relative(REPO_ROOT, file);

    for (const [i, { data, expectedLabel }] of tests.entries()) {
      const expected = normalizeEncodingLabel(expectedLabel);
      if (expected == null || isScripted) {
        continue;
      }
      try {
        const actual = sniffHTMLEncoding(new Uint8Array(data), undefined).encoding;
        assert.equal(
          actual,
          expected,
          `expected ${expected} (raw: ${expectedLabel}), got ${actual}`
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${rel}:${i} ${detail}`);
      }
    }
  }

  const verbose = process.env.HTML5LIB_VERBOSE === "1";
  const shown = verbose ? failures : failures.slice(0, 20);
  const omitted = failures.length - shown.length;
  assert.equal(
    failures.length,
    0,
    `encoding fixture failures (${failures.length}):\n${shown.join("\n")}${omitted > 0 ? `\n... ${omitted} more (set HTML5LIB_VERBOSE=1)` : ""}`
  );
});
