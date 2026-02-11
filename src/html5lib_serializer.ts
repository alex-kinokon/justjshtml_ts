/* eslint-disable unicorn/string-content */
import { VOID_ELEMENTS } from "./constants.ts";
import type { AttrMap } from "./tokens.ts";
import { hasKey } from "./utils.ts";

export enum TokenType {
  DOCTYPE,
  Comment,
  Character,
  StartTag,
  EndTag,
  EmptyTag,
  Characters,
  Unknown,
}

type TokenList =
  | [
      TokenType.DOCTYPE,
      string | undefined,
      string | undefined,
      string | undefined,
      boolean,
    ]
  | [TokenType.Comment, string]
  | [TokenType.Character, string]
  | [TokenType.StartTag, string, string, true?]
  | [TokenType.EndTag, string, string]
  | [TokenType.EmptyTag, string, AttrMap]
  | [TokenType.Characters, string]
  | [TokenType.Unknown];

export interface SerializerOptions {
  readonly encoding?: string | undefined;
  readonly injectMetaCharset?: boolean;
  readonly stripWhitespace?: boolean;
  readonly quoteAttrValues?: boolean;
  readonly useTrailingSolidus?: boolean;
  readonly minimizeBooleanAttributes?: boolean;
  readonly quoteChar?: '"' | "'" | undefined;
  readonly escapeLtInAttrs?: boolean;
  readonly escapeRcdata?: boolean;
}

function attrListToDict(attrs: unknown): AttrMap {
  const out: AttrMap = Object.create(null);
  if (!attrs) {
    return out;
  } else if (!Array.isArray(attrs) && typeof attrs === "object") {
    return attrs as AttrMap;
  } else if (!Array.isArray(attrs)) {
    return out;
  }

  for (const entry of attrs) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name: string; value: string };
    const { name, value } = record;
    out[name] = Object.hasOwn(record, "value") ? value : null;
  }
  return out;
}

function escapeText(text: string): string {
  if (!text) return "";
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttrValue(
  value: string | undefined,
  quoteChar: '"' | "'",
  escapeLtInAttrs: boolean
): string {
  if (value == null) return "";
  let out = value.replaceAll("&", "&amp;");
  if (escapeLtInAttrs) out = out.replaceAll("<", "&lt;");
  if (quoteChar === '"') return out.replaceAll('"', "&quot;");
  return out.replaceAll("'", "&#39;");
}

function chooseAttrQuote(
  value: string | undefined,
  forcedQuoteChar: '"' | "'" | undefined
): '"' | "'" {
  if (forcedQuoteChar === '"' || forcedQuoteChar === "'") return forcedQuoteChar;
  if (value == null) return '"';
  const s = value;
  if (s.includes('"') && !s.includes("'")) return "'";
  return '"';
}

function canUnquoteAttrValue(value: string | undefined): boolean {
  if (value == null) return false;
  const s = value;
  for (const ch of s) {
    if (
      ch === ">" ||
      ch === '"' ||
      ch === "'" ||
      ch === "=" ||
      ch === " " ||
      ch === "\t" ||
      ch === "\n" ||
      ch === "\f" ||
      ch === "\r"
    ) {
      return false;
    }
  }
  return true;
}

function shouldMinimizeAttrValue(
  name: string,
  value: string | undefined,
  minimizeBooleanAttributes: boolean
): boolean {
  if (!minimizeBooleanAttributes) return false;
  if (value == null || value === "") return true;
  return value.toLowerCase() === name.toLowerCase();
}

function serializeStartTag(
  name: string,
  attrs: AttrMap,
  options: SerializerOptions,
  isVoid: boolean
): string {
  const {
    quoteAttrValues,
    minimizeBooleanAttributes = true,
    quoteChar: forcedQuote,
    useTrailingSolidus,
    escapeLtInAttrs,
  } = options;
  const parts = ["<", name];

  if (hasKey(attrs)) {
    const keys = Object.keys(attrs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const key of keys) {
      const value = attrs[key] ?? undefined;

      if (shouldMinimizeAttrValue(key, value, minimizeBooleanAttributes)) {
        parts.push(" ", key);
        continue;
      }

      if (value == null) {
        parts.push(" ", key, '=""');
        continue;
      }

      if (value === "") {
        if (minimizeBooleanAttributes) parts.push(" ", key);
        else parts.push(" ", key, '=""');
        continue;
      }

      if (!quoteAttrValues && canUnquoteAttrValue(value)) {
        let escaped = value.replaceAll("&", "&amp;");
        if (escapeLtInAttrs) escaped = escaped.replaceAll("<", "&lt;");
        parts.push(" ", key, "=", escaped);
        continue;
      }

      const quote = chooseAttrQuote(value, forcedQuote);
      const escaped = escapeAttrValue(value, quote, escapeLtInAttrs ?? false);
      parts.push(" ", key, "=", quote, escaped, quote);
    }
  }

  if (useTrailingSolidus && isVoid) parts.push(" />");
  else parts.push(">");

  return parts.join("");
}

function stripWhitespace(text: string): string {
  if (!text) return "";
  const out: string[] = [];
  let lastSpace = false;
  for (const ch of text) {
    const mapped = ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" ? " " : ch;
    if (mapped === " ") {
      if (lastSpace) continue;
      lastSpace = true;
      out.push(" ");
    } else {
      lastSpace = false;
      out.push(mapped);
    }
  }
  return out.join("");
}

function updateMetaContentTypeCharset(
  content: string | undefined,
  encoding: string | undefined
): string | undefined {
  if (content == null) return;
  if (!encoding) return content;
  const s = content;
  const lower = s.toLowerCase();
  const idx = lower.indexOf("charset=");
  if (idx === -1) return s;

  const start = idx + "charset=".length;
  let end = start;
  while (end < s.length) {
    const ch = s[end];
    if (
      ch === ";" ||
      ch === " " ||
      ch === "\t" ||
      ch === "\r" ||
      ch === "\n" ||
      ch === "\f"
    ) {
      break;
    }
    end += 1;
  }
  return s.slice(0, start) + encoding + s.slice(end);
}

function applyInjectMetaCharset(
  tokens: TokenList[],
  encoding: string | undefined
): TokenList[] {
  if (!encoding) return [];

  let sawHead = false;
  let inHead = false;
  let contentTokens: TokenList[] = [];

  for (const tok of tokens) {
    const kind = tok[0];
    if (!inHead) {
      if (kind === TokenType.StartTag && tok[2] === "head") {
        sawHead = true;
        inHead = true;
      }
      continue;
    }
    if (kind === TokenType.EndTag && tok[2] === "head") break;
    contentTokens.push(tok);
  }

  if (!sawHead) contentTokens = [...tokens];

  const processed: TokenList[] = [];
  let foundCharset = false;

  for (const tok of contentTokens) {
    if (tok[0] === TokenType.EmptyTag && tok[1] === "meta") {
      const attrs = attrListToDict(tok[2]);
      if (Object.hasOwn(attrs, "charset")) {
        attrs.charset = encoding;
        foundCharset = true;
      } else if (
        (attrs["http-equiv"] || "").toLowerCase() === "content-type" &&
        "content" in attrs
      ) {
        attrs.content =
          updateMetaContentTypeCharset(attrs.content ?? undefined, encoding) ?? null;
        foundCharset = true;
      }
      processed.push([TokenType.EmptyTag, "meta", attrs]);
    } else {
      processed.push(tok);
    }
  }

  if (!foundCharset)
    processed.unshift([TokenType.EmptyTag, "meta", { charset: encoding }]);
  return processed;
}

function tokName(tok: TokenList | undefined): string | undefined {
  if (!tok) return;
  const kind = tok[0];
  if (kind === TokenType.StartTag) return tok[2];
  if (kind === TokenType.EndTag) return tok[2];
  if (kind === TokenType.EmptyTag) return tok[1];
}

function tokIsSpaceChars(tok: TokenList | undefined): boolean {
  return tok != null && tok[0] === TokenType.Characters && tok[1].startsWith(" ");
}

function shouldOmitStartTag(
  name: string,
  attrs: AttrMap,
  prevTok: TokenList | undefined,
  nextTok: TokenList | undefined
): boolean {
  if (hasKey(attrs)) return false;

  switch (name) {
    case "html":
      return (
        nextTok == null ||
        (!(nextTok[0] === TokenType.Comment || tokIsSpaceChars(nextTok)) &&
          !(nextTok[0] === TokenType.Characters && nextTok[1] === ""))
      );

    case "head":
      return (
        nextTok == null ||
        (!(nextTok[0] === TokenType.Comment || nextTok[0] === TokenType.Characters) &&
          ((nextTok[0] === TokenType.EndTag && tokName(nextTok) === "head") ||
            nextTok[0] === TokenType.StartTag ||
            nextTok[0] === TokenType.EmptyTag ||
            nextTok[0] === TokenType.EndTag))
      );

    case "body":
      return (
        nextTok == null || !(nextTok[0] === TokenType.Comment || tokIsSpaceChars(nextTok))
      );

    case "colgroup":
      return (
        prevTok?.[0] === TokenType.StartTag &&
        tokName(prevTok) === "table" &&
        nextTok != null &&
        (nextTok[0] === TokenType.StartTag || nextTok[0] === TokenType.EmptyTag) &&
        tokName(nextTok) === "col"
      );

    case "tbody":
      return (
        prevTok?.[0] === TokenType.StartTag &&
        tokName(prevTok) === "table" &&
        nextTok?.[0] === TokenType.StartTag &&
        tokName(nextTok) === "tr"
      );

    default:
      return false;
  }
}

function shouldOmitEndTag(name: string, nextTok: TokenList | undefined): boolean {
  switch (name) {
    case "html":
    case "head":
    case "body":
    case "colgroup":
      return (
        nextTok == null ||
        (!(nextTok[0] === TokenType.Comment || tokIsSpaceChars(nextTok)) &&
          (nextTok[0] === TokenType.StartTag ||
            nextTok[0] === TokenType.EmptyTag ||
            nextTok[0] === TokenType.EndTag ||
            (nextTok[0] === TokenType.Characters ? !nextTok[1].startsWith(" ") : true)))
      );

    case "li":
      return (
        nextTok == null ||
        (nextTok[0] === TokenType.StartTag && tokName(nextTok) === "li") ||
        nextTok[0] === TokenType.EndTag
      );

    case "dt":
      return (
        nextTok != null &&
        nextTok[0] === TokenType.StartTag &&
        isTokenName(nextTok, "dt", "dd")
      );

    case "dd":
      return (
        nextTok == null ||
        (nextTok[0] === TokenType.StartTag && isTokenName(nextTok, "dd", "dt")) ||
        nextTok[0] === TokenType.EndTag
      );

    case "p": {
      const pFollowers = new Set([
        "address",
        "article",
        "aside",
        "blockquote",
        "datagrid",
        "dialog",
        "dir",
        "div",
        "dl",
        "fieldset",
        "footer",
        "form",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "menu",
        "nav",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "ul",
      ]);
      return (
        nextTok == null ||
        nextTok[0] === TokenType.EndTag ||
        ((nextTok[0] === TokenType.StartTag || nextTok[0] === TokenType.EmptyTag) &&
          pFollowers.has(tokName(nextTok) ?? ""))
      );
    }

    case "optgroup":
      return (
        nextTok == null ||
        (nextTok[0] === TokenType.StartTag && tokName(nextTok) === "optgroup") ||
        nextTok[0] === TokenType.EndTag
      );

    case "option":
      return (
        nextTok == null ||
        (nextTok[0] === TokenType.StartTag &&
          isTokenName(nextTok, "option", "optgroup")) ||
        nextTok[0] === TokenType.EndTag
      );

    case "tbody":
      return (
        nextTok == null ||
        (nextTok[0] === TokenType.StartTag && isTokenName(nextTok, "tbody", "tfoot")) ||
        nextTok[0] === TokenType.EndTag
      );

    case "tfoot":
      return (
        nextTok == null ||
        (nextTok[0] === TokenType.StartTag && tokName(nextTok) === "tbody") ||
        nextTok[0] === TokenType.EndTag
      );

    case "thead":
      return (
        nextTok?.[0] === TokenType.StartTag && isTokenName(nextTok, "tbody", "tfoot")
      );

    case "tr":
      return (
        nextTok == null ||
        (nextTok[0] === TokenType.StartTag && tokName(nextTok) === "tr") ||
        nextTok[0] === TokenType.EndTag
      );

    case "td":
    case "th":
      return (
        nextTok == null ||
        (nextTok[0] === TokenType.StartTag && isTokenName(nextTok, "td", "th")) ||
        nextTok[0] === TokenType.EndTag
      );

    default:
      return false;
  }
}

function isTokenName(token: TokenList, name: string, altName: string) {
  const n = tokName(token);
  return n === name || n === altName;
}

export function serializeSerializerTokenStream(
  tokens: unknown,
  options: SerializerOptions = {}
): string | undefined {
  if (!Array.isArray(tokens)) return;

  let tokenStream = tokens as TokenList[];
  if (options.injectMetaCharset) {
    const { encoding } = options;
    if (!encoding) return "";
    tokenStream = applyInjectMetaCharset(tokenStream, encoding);
  }

  const parts: string[] = [];
  let rawText: string | undefined;

  const openElements: string[] = [];
  const { stripWhitespace: stripWs, escapeRcdata } = options;
  const wsPreserve = new Set(["pre", "textarea", "script", "style"]);

  for (let i = 0; i < tokenStream.length; i += 1) {
    const t = tokenStream[i]!;
    const prevTok = i ? tokenStream[i - 1] : undefined;
    const nextTok = i + 1 < tokenStream.length ? tokenStream[i + 1] : undefined;

    const kind = t[0];
    switch (kind) {
      case TokenType.StartTag: {
        const name = t[2];
        const attrs = attrListToDict(t.length > 3 ? t[3] : {});
        openElements.push(name);

        if (shouldOmitStartTag(name, attrs, prevTok, nextTok)) {
          continue;
        }

        parts.push(serializeStartTag(name, attrs, options, VOID_ELEMENTS.has(name)));

        if ((name === "script" || name === "style") && !escapeRcdata) {
          rawText = name;
        }
        continue;
      }

      case TokenType.EndTag: {
        const name = t[2];

        if (openElements.length) {
          if (openElements.at(-1) === name) {
            openElements.pop();
          } else {
            for (let j = openElements.length - 1; j >= 0; j -= 1) {
              if (openElements[j] === name) {
                openElements.splice(j);
                break;
              }
            }
          }
        }

        if (shouldOmitEndTag(name, nextTok)) continue;

        parts.push(`</${name}>`);
        if (rawText === name) {
          rawText = undefined;
        }
        continue;
      }

      case TokenType.EmptyTag: {
        const name = t[1];
        const attrs = t[2];
        parts.push(serializeStartTag(name, attrListToDict(attrs), options, true));
        continue;
      }

      case TokenType.Characters: {
        if (rawText != null) {
          parts.push(t[1]);
          continue;
        }

        let text = t[1];
        if (stripWs && !openElements.some(n => wsPreserve.has(n))) {
          text = stripWhitespace(text);
        }
        parts.push(escapeText(text));
        continue;
      }

      case TokenType.Comment: {
        parts.push(`<!--${t[1]}-->`);
        continue;
      }

      case TokenType.DOCTYPE: {
        const [, name, publicId, systemId] = t;
        if (publicId == null && systemId == null) {
          parts.push(`<!DOCTYPE ${name}>`);
        } else {
          const hasPublic = publicId != null && publicId !== "";
          const hasSystem = systemId != null && systemId !== "";
          if (hasPublic) {
            if (hasSystem) {
              parts.push(`<!DOCTYPE ${name} PUBLIC "${publicId}" "${systemId}">`);
            } else {
              parts.push(`<!DOCTYPE ${name} PUBLIC "${publicId}">`);
            }
          } else if (hasSystem) {
            parts.push(`<!DOCTYPE ${name} SYSTEM "${systemId}">`);
          } else {
            parts.push(`<!DOCTYPE ${name}>`);
          }
        }
        continue;
      }
    }

    return;
  }

  return parts.join("");
}
