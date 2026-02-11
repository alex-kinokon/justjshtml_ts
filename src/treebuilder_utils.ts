import {
  HTML4_PUBLIC_PREFIXES,
  LIMITED_QUIRKY_PUBLIC_PREFIXES,
  QUIRKY_PUBLIC_MATCHES,
  QUIRKY_PUBLIC_PREFIXES,
  QUIRKY_SYSTEM_MATCHES,
} from "./constants.ts";

// Port of ~/dev/justhtml/src/justhtml/treebuilder_utils.py

export enum InsertionMode {
  INITIAL,
  BEFORE_HTML,
  BEFORE_HEAD,
  IN_HEAD,
  IN_HEAD_NOSCRIPT,
  AFTER_HEAD,
  TEXT,
  IN_BODY,
  AFTER_BODY,
  AFTER_AFTER_BODY,
  IN_TABLE,
  IN_TABLE_TEXT,
  IN_CAPTION,
  IN_COLUMN_GROUP,
  IN_TABLE_BODY,
  IN_ROW,
  IN_CELL,
  IN_FRAMESET,
  AFTER_FRAMESET,
  AFTER_AFTER_FRAMESET,
  IN_SELECT,
  IN_TEMPLATE,
}

interface DoctypeLike {
  readonly name?: string;
  readonly publicId?: string;
  readonly systemId?: string;
  readonly forceQuirks?: boolean;
}

export function isAllWhitespace(text: string | undefined): boolean {
  if (!text) return true;
  for (const ch of text) {
    if (ch !== "\t" && ch !== "\n" && ch !== "\f" && ch !== "\r" && ch !== " ")
      return false;
  }
  return true;
}

function containsPrefix(prefixes: string[], needle: string): boolean {
  for (const prefix of prefixes) {
    if (needle.startsWith(prefix)) return true;
  }
  return false;
}

const acceptable = new Set([
  ["html", undefined, undefined].join("\u0000"),
  ["html", undefined, "about:legacy-compat"].join("\u0000"),
  ["html", "-//W3C//DTD HTML 4.0//EN", undefined].join("\u0000"),
  ["html", "-//W3C//DTD HTML 4.0//EN", "http://www.w3.org/TR/REC-html40/strict.dtd"].join(
    "\u0000"
  ),
  ["html", "-//W3C//DTD HTML 4.01//EN", undefined].join("\u0000"),
  ["html", "-//W3C//DTD HTML 4.01//EN", "http://www.w3.org/TR/html4/strict.dtd"].join(
    "\u0000"
  ),
  [
    "html",
    "-//W3C//DTD XHTML 1.0 Strict//EN",
    "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd",
  ].join("\u0000"),
  [
    "html",
    "-//W3C//DTD XHTML 1.1//EN",
    "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd",
  ].join("\u0000"),
]);

export const enum QuirksMode {
  Quirks,
  LimitedQuirks,
  NoQuirks,
}

export function doctypeErrorAndQuirks(
  doctype: DoctypeLike | undefined,
  iframeSrcdoc = false
): { error: boolean; quirksMode: QuirksMode } {
  const name = doctype?.name?.toLowerCase();
  const publicId = doctype?.publicId;
  const systemId = doctype?.systemId;

  const key = [name, publicId, systemId].join("\u0000");
  const error = !acceptable.has(key);

  const publicLower = publicId?.toLowerCase() ?? null;
  const systemLower = systemId?.toLowerCase() ?? null;

  let quirksMode: QuirksMode;
  if (doctype?.forceQuirks) {
    quirksMode = QuirksMode.Quirks;
  } else if (iframeSrcdoc) {
    quirksMode = QuirksMode.NoQuirks;
  } else if (name !== "html") {
    quirksMode = QuirksMode.Quirks;
  } else if (publicLower && QUIRKY_PUBLIC_MATCHES.includes(publicLower)) {
    quirksMode = QuirksMode.Quirks;
  } else if (systemLower && QUIRKY_SYSTEM_MATCHES.includes(systemLower)) {
    quirksMode = QuirksMode.Quirks;
  } else if (publicLower && containsPrefix(QUIRKY_PUBLIC_PREFIXES, publicLower)) {
    quirksMode = QuirksMode.Quirks;
  } else if (publicLower && containsPrefix(LIMITED_QUIRKY_PUBLIC_PREFIXES, publicLower)) {
    quirksMode = QuirksMode.LimitedQuirks;
  } else if (publicLower && containsPrefix(HTML4_PUBLIC_PREFIXES, publicLower)) {
    quirksMode = systemLower == null ? QuirksMode.Quirks : QuirksMode.LimitedQuirks;
  } else {
    quirksMode = QuirksMode.NoQuirks;
  }

  return { error, quirksMode };
}
