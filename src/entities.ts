import { NAMED_ENTITIES } from "./entities-data.ts";

// spellchecker:disable
/**
 * Named character references that HTML allows to be parsed in legacy contexts.
 */
export const LEGACY_ENTITIES = new Set([
  "gt",
  "lt",
  "amp",
  "quot",
  "nbsp",
  "AMP",
  "QUOT",
  "GT",
  "LT",
  "COPY",
  "REG",
  "AElig",
  "Aacute",
  "Acirc",
  "Agrave",
  "Aring",
  "Atilde",
  "Auml",
  "Ccedil",
  "ETH",
  "Eacute",
  "Ecirc",
  "Egrave",
  "Euml",
  "Iacute",
  "Icirc",
  "Igrave",
  "Iuml",
  "Ntilde",
  "Oacute",
  "Ocirc",
  "Ograve",
  "Oslash",
  "Otilde",
  "Ouml",
  "THORN",
  "Uacute",
  "Ucirc",
  "Ugrave",
  "Uuml",
  "Yacute",
  "aacute",
  "acirc",
  "acute",
  "aelig",
  "agrave",
  "aring",
  "atilde",
  "auml",
  "brvbar",
  "ccedil",
  "cedil",
  "cent",
  "copy",
  "curren",
  "deg",
  "divide",
  "eacute",
  "ecirc",
  "egrave",
  "eth",
  "euml",
  "frac12",
  "frac14",
  "frac34",
  "iacute",
  "icirc",
  "iexcl",
  "igrave",
  "iquest",
  "iuml",
  "laquo",
  "macr",
  "micro",
  "middot",
  "not",
  "ntilde",
  "oacute",
  "ocirc",
  "ograve",
  "ordf",
  "ordm",
  "oslash",
  "otilde",
  "ouml",
  "para",
  "plusmn",
  "pound",
  "raquo",
  "reg",
  "sect",
  "shy",
  "sup1",
  "sup2",
  "sup3",
  "szlig",
  "thorn",
  "times",
  "uacute",
  "ucirc",
  "ugrave",
  "uml",
  "uuml",
  "yacute",
  "yen",
  "yuml",
]);
// spellchecker:enable

// HTML5 numeric character reference replacements (§13.2.5.73)
const NUMERIC_REPLACEMENTS = new Map<number, string>([
  [0x00, "\uFFFD"],
  [0x80, "\u20AC"],
  [0x82, "\u201A"],
  [0x83, "\u0192"],
  [0x84, "\u201E"],
  [0x85, "\u2026"],
  [0x86, "\u2020"],
  [0x87, "\u2021"],
  [0x88, "\u02C6"],
  [0x89, "\u2030"],
  [0x8a, "\u0160"],
  [0x8b, "\u2039"],
  [0x8c, "\u0152"],
  [0x8e, "\u017D"],
  [0x91, "\u2018"],
  [0x92, "\u2019"],
  [0x93, "\u201C"],
  [0x94, "\u201D"],
  [0x95, "\u2022"],
  [0x96, "\u2013"],
  [0x97, "\u2014"],
  [0x98, "\u02DC"],
  [0x99, "\u2122"],
  [0x9a, "\u0161"],
  [0x9b, "\u203A"],
  [0x9c, "\u0153"],
  [0x9e, "\u017E"],
  [0x9f, "\u0178"],
]);

/**
 * Decodes a numeric character reference body (without `&#` / trailing `;`).
 *
 * @param text Numeric code point text in decimal or hex.
 * @param options Use hexadecimal parsing when `isHex` is true.
 */
export function decodeNumericEntity(text: string, isHex: boolean): string {
  const base = isHex ? 16 : 10;
  const codepoint = Number.parseInt(text, base);

  const replacement = NUMERIC_REPLACEMENTS.get(codepoint);
  if (replacement) return replacement;

  if (codepoint > 0x10ffff) return "\uFFFD";
  if (codepoint >= 0xd800 && codepoint <= 0xdfff) return "\uFFFD";

  return String.fromCodePoint(codepoint);
}

function isAsciiAlpha(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isAsciiDigit(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 0x30 && c <= 0x39;
}

function isAsciiAlphanumeric(ch: string): boolean {
  return isAsciiAlpha(ch) || isAsciiDigit(ch);
}

/**
 * Decodes HTML character references in text.
 *
 * Supports numeric (`&#...;`, `&#x...;`) and named references, including
 * legacy no-semicolon behavior when allowed by context.
 */
export function decodeEntitiesInText(text: string, inAttribute = false): string {
  const entities = NAMED_ENTITIES;
  const result: string[] = [];
  let i = 0;
  const { length } = text;

  while (i < length) {
    const nextAmp = text.indexOf("&", i);
    if (nextAmp === -1) {
      result.push(text.slice(i));
      break;
    }

    if (nextAmp > i) result.push(text.slice(i, nextAmp));

    i = nextAmp;
    let j = i + 1;

    // Numeric entity
    if (j < length && text[j] === "#") {
      j += 1;
      let isHex = false;

      if (j < length && (text[j] === "x" || text[j] === "X")) {
        isHex = true;
        j += 1;
      }

      const digitStart = j;
      if (isHex) {
        while (j < length && "0123456789abcdefABCDEF".includes(text[j]!)) j += 1;
      } else {
        while (j < length && isAsciiDigit(text[j]!)) j += 1;
      }

      const hasSemicolon = j < length && text[j] === ";";
      const digitText = text.slice(digitStart, j);

      if (digitText) {
        result.push(decodeNumericEntity(digitText, isHex));
        i = hasSemicolon ? j + 1 : j;
        continue;
      }

      result.push(text.slice(i, hasSemicolon ? j + 1 : j));
      i = hasSemicolon ? j + 1 : j;
      continue;
    }

    // Named entity (ASCII letters/digits).
    while (j < length && (isAsciiAlpha(text[j]!) || isAsciiDigit(text[j]!))) j += 1;

    const entityName = text.slice(i + 1, j);
    const hasSemicolon = j < length && text[j] === ";";

    if (!entityName) {
      result.push("&");
      i += 1;
      continue;
    }

    if (hasSemicolon && entities.has(entityName)) {
      result.push(entities.get(entityName)!);
      i = j + 1;
      continue;
    }

    if (hasSemicolon && !inAttribute) {
      let bestMatch: string | undefined;
      let bestMatchLen = 0;
      for (let k = entityName.length; k > 0; k -= 1) {
        const prefix = entityName.slice(0, k);
        if (LEGACY_ENTITIES.has(prefix) && entities.has(prefix)) {
          bestMatch = entities.get(prefix)!;
          bestMatchLen = k;
          break;
        }
      }
      if (bestMatch) {
        result.push(bestMatch);
        i = i + 1 + bestMatchLen;
        continue;
      }
    }

    if (LEGACY_ENTITIES.has(entityName) && entities.has(entityName)) {
      const nextChar = j < length ? text[j] : null;
      if (
        inAttribute &&
        nextChar &&
        (isAsciiAlphanumeric(nextChar) || nextChar === "=")
      ) {
        result.push("&");
        i += 1;
        continue;
      }

      result.push(entities.get(entityName)!);
      i = j;
      continue;
    }

    let bestMatch: string | undefined;
    let bestMatchLen = 0;
    for (let k = entityName.length; k > 0; k -= 1) {
      const prefix = entityName.slice(0, k);
      if (LEGACY_ENTITIES.has(prefix) && entities.has(prefix)) {
        bestMatch = entities.get(prefix)!;
        bestMatchLen = k;
        break;
      }
    }

    if (bestMatch) {
      if (inAttribute) {
        result.push("&");
        i += 1;
        continue;
      }

      result.push(bestMatch);
      i = i + 1 + bestMatchLen;
      continue;
    }

    if (hasSemicolon) {
      result.push(text.slice(i, j + 1));
      i = j + 1;
    } else {
      result.push("&");
      i += 1;
    }
  }

  return result.join("");
}
