import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  type SerializerOptions,
  serializeSerializerTokenStream,
} from "../src/html5lib_serializer.ts";

import { REPO_ROOT, resolveHtml5libTestsDir } from "./html5lib-test-utils.ts";

test("html5lib serializer fixtures", async t => {
  const testsDir = resolveHtml5libTestsDir();
  const serializerDir = path.join(testsDir, "serializer");
  if (!existsSync(serializerDir)) t.skip(`Missing fixtures: ${serializerDir}`);

  const entries = await readdir(serializerDir, { withFileTypes: true });
  const testFiles = entries
    .filter(e => e.isFile() && e.name.endsWith(".test"))
    .map(e => path.join(serializerDir, e.name))
    .sort();

  assert.ok(testFiles.length > 0, `No serializer fixtures found under: ${serializerDir}`);
  const failures: string[] = [];

  for (const file of testFiles) {
    const text = await readFile(file, "utf8");
    const data = JSON.parse(text);
    const tests: Array<{
      description: string;
      options?: SerializerOptions;
      input: string[];
      expected: string[];
    }> = Array.isArray(data?.tests) ? data.tests : [];

    const fileRel = path.relative(REPO_ROOT, file);

    for (const [idx, test] of tests.entries()) {
      const testName = `${fileRel}:${idx} ${test.description}`.trim();
      try {
        const { input, options, expected: expectedList } = test;
        const actual = serializeSerializerTokenStream(input, {
          ...Object.fromEntries(
            Object.entries(options ?? {}).map(([key, value]) => [
              key.replace(/_([a-z])/g, (_, a: string) => a.toUpperCase()),
              value,
            ])
          ),
          ...options,
        });
        if (actual == null) continue;

        const ok = Array.isArray(expectedList) && expectedList.includes(actual);
        assert.ok(
          ok,
          `expected one of ${JSON.stringify(expectedList)}, got ${JSON.stringify(actual)}`
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${testName} ${detail}`);
      }
    }
  }

  const verbose = process.env.HTML5LIB_VERBOSE === "1";
  const shown = verbose ? failures : failures.slice(0, 20);
  const omitted = failures.length - shown.length;
  assert.equal(
    failures.length,
    0,
    `serializer fixture failures (${failures.length}):\n${shown.join("\n")}${omitted > 0 ? `\n... ${omitted} more (set HTML5LIB_VERBOSE=1)` : ""}`
  );
});
