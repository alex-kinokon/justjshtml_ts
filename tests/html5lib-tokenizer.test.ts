import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { TokenizerState, createTokenizer } from "../src/tokenizer.ts";
import {
  type AttrMap,
  type CharacterToken,
  type CommentToken,
  Doctype,
  type DoctypeToken,
  type EOFToken,
  TagKind,
  type TagToken,
  type Token,
  TokenKind,
  TokenSinkResult,
  createCharacterToken,
  createCommentToken,
  createDocTypeToken,
  eofToken,
  createTagToken,
} from "../src/tokens.ts";
import type { TokenizerSink } from "../src/treebuilder.ts";

import { REPO_ROOT, resolveHtml5libTestsDir } from "./html5lib-test-utils.ts";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface TokenizerFixture {
  readonly description?: string;
  readonly input: string;
  readonly output: JsonValue;
  readonly doubleEscaped?: boolean;
  readonly initialStates?: string[];
  readonly lastStartTag?: string;
  readonly discardBom?: boolean;
}

interface TokenizerFixtureFile {
  readonly tests?: TokenizerFixture[];
  readonly xmlViolationTests?: TokenizerFixture[];
}

type StartTag = ["StartTag", string, AttrMap, true?];

type TokenList =
  | ["DOCTYPE", string | null, string | null, string | null, boolean]
  | ["Comment", string]
  | ["Character", string]
  | StartTag
  | ["EndTag", string]
  | ["Unknown"];

type SinkToken = TagToken | CharacterToken | CommentToken | DoctypeToken | EOFToken;

function unescapeUnicode(text: string): string {
  return text.replaceAll(/\\u([\dA-Fa-f]{4})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

function deepUnescape(val: JsonValue): JsonValue {
  if (typeof val === "string") return unescapeUnicode(val);
  if (Array.isArray(val)) return val.map(deepUnescape);
  if (val != null && typeof val === "object") {
    const out: { [key: string]: JsonValue } = Object.create(null);
    for (const [k, v] of Object.entries(val)) {
      out[k] = deepUnescape(v);
    }
    return out;
  }
  return val;
}

function tokenToList(token: Token): TokenList | undefined {
  switch (token.type) {
    case TokenKind.Doctype: {
      const d = token.doctype;
      return [
        "DOCTYPE",
        d.name ?? null,
        d.publicId ?? null,
        d.systemId ?? null,
        !d.forceQuirks,
      ];
    }
    case TokenKind.Comment:
      return ["Comment", token.data];

    case TokenKind.Character:
      return ["Character", token.data];

    case TokenKind.Tag:
      if (token.kind === TagKind.Start) {
        const attrs = Object.fromEntries(token.attrs);
        const arr: StartTag = ["StartTag", token.name, attrs];
        if (token.selfClosing) arr.push(true);
        return arr;
      }
      return ["EndTag", token.name];

    case TokenKind.EOF:
      return;

    default:
      return ["Unknown"];
  }
}

function collapseCharacters(tokens: TokenList[]): TokenList[] {
  const out: TokenList[] = [];
  for (const t of tokens) {
    if (t[0] === "Character" && out.length && out.at(-1)![0] === "Character") {
      out.at(-1)![1] += t[1];
    } else {
      out.push(t);
    }
  }
  return out;
}

function canonicalize(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(canonicalize);
  if (val != null && typeof val === "object") {
    const out: { [key: string]: unknown } = Object.create(null);
    const keys = Object.keys(val).sort();
    for (const k of keys) {
      out[k] = canonicalize((val as { [key: string]: JsonValue })[k]);
    }
    return out;
  }
  return val;
}

const mapping = new Map<string, [TokenizerState, string | undefined]>([
  ["Data state", [TokenizerState.Data, undefined]],
  ["PLAINTEXT state", [TokenizerState.PlainText, undefined]],
  ["RCDATA state", [TokenizerState.RCDATA, undefined]],
  // html5lib fixtures use "RAWTEXT state" (no underscore)
  ["RAWTEXT state", [TokenizerState.RawText, undefined]],
  ["Script data state", [TokenizerState.RawText, "script"]],
  ["CDATA section state", [TokenizerState.CDATASection, undefined]],
]);

const createRecordingSink = (tokens: SinkToken[]): TokenizerSink => ({
  processToken(token) {
    switch (token.type) {
      case TokenKind.Tag:
        tokens.push(
          createTagToken(token.kind, token.name, new Map(token.attrs), token.selfClosing)
        );
        break;

      case TokenKind.Character:
        tokens.push(createCharacterToken(token.data));
        break;

      case TokenKind.Comment:
        tokens.push(createCommentToken(token.data));
        break;

      case TokenKind.Doctype: {
        const d = token.doctype;
        tokens.push(
          createDocTypeToken(
            new Doctype({
              name: d.name,
              publicId: d.publicId,
              systemId: d.systemId,
              forceQuirks: d.forceQuirks,
            })
          )
        );
        break;
      }

      case TokenKind.EOF:
        tokens.push(eofToken());
        break;

      default:
        tokens.push(token as SinkToken);
    }
    return TokenSinkResult.Continue;
  },

  processCharacters(data) {
    tokens.push(createCharacterToken(data));
  },
});

test("html5lib tokenizer fixtures", async t => {
  const testsDir = resolveHtml5libTestsDir();
  const tokenizerDir = path.join(testsDir, "tokenizer");
  if (!existsSync(tokenizerDir)) t.skip(`Missing fixtures: ${tokenizerDir}`);

  const entries = await readdir(tokenizerDir, { withFileTypes: true });
  const testFiles = entries
    .filter(e => e.isFile() && e.name.endsWith(".test"))
    .map(e => path.join(tokenizerDir, e.name))
    .sort();

  assert.ok(testFiles.length > 0, `No tokenizer fixtures found under: ${tokenizerDir}`);
  const failures: string[] = [];

  for (const file of testFiles) {
    const buf = await readFile(file, "utf8");
    const data = JSON.parse(buf) as TokenizerFixtureFile;
    const key = data.tests ? "tests" : "xmlViolationTests";
    const tests = data[key] as TokenizerFixture[];
    const xmlCoercion = key === "xmlViolationTests";
    const fileRel = path.relative(REPO_ROOT, file);

    for (const [idx, test] of tests.entries()) {
      const testName = `${fileRel} ${idx} ${test.description ?? ""}`.trim();
      let { input, output, doubleEscaped, discardBom } = test;
      if (doubleEscaped) {
        input = unescapeUnicode(input);
        output = deepUnescape(output);
      }

      const initialStates = test.initialStates ?? ["Data state"];
      const lastStartTag = test.lastStartTag || null;

      for (const stateName of initialStates) {
        try {
          const mapped = mapping.get(stateName);
          assert.ok(mapped, `unsupported initial state: ${stateName}`);
          let [initialState, rawTag] = mapped;
          if (lastStartTag) rawTag = lastStartTag;

          const tokens: SinkToken[] = [];
          const sink = createRecordingSink(tokens);
          const tokenizer = createTokenizer(sink, {
            initialState,
            initialRawTextTag: rawTag,
            discardBom,
            xmlCoercion,
          });
          tokenizer.setLastStartTagName(lastStartTag ?? undefined);
          tokenizer.run(input);

          const actual = collapseCharacters(
            tokens.map(tokenToList).filter((tok): tok is TokenList => tok != null)
          );
          assert.deepEqual(
            canonicalize(actual),
            canonicalize(output),
            `state: ${stateName}`
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failures.push(`${testName} [${stateName}] ${detail}`);
        }
      }
    }
  }

  const verbose = process.env.HTML5LIB_VERBOSE === "1";
  const shown = verbose ? failures : failures.slice(0, 20);
  const omitted = failures.length - shown.length;
  assert.equal(
    failures.length,
    0,
    `tokenizer fixture failures (${failures.length}):\n${shown.join("\n")}${omitted > 0 ? `\n... ${omitted} more (set HTML5LIB_VERBOSE=1)` : ""}`
  );
});
