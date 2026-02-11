/* eslint-disable unicorn/string-content */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-base-to-string */
import { FOREIGN_ATTRIBUTE_ADJUSTMENTS, VOID_ELEMENTS } from "./constants.ts";
import type { Node } from "./node.ts";
import { Doctype } from "./tokens.ts";
import { isTemplateNode } from "./treebuilder.ts";

function qualifiedName(node: Node): string {
  const ns = node.namespace ?? null;
  return ns && ns !== "html" ? `${ns} ${node.name}` : node.name;
}

function doctypeToTestFormat(node: Node): string {
  const doctype = node.data;
  if (!(doctype instanceof Doctype)) return "| <!DOCTYPE >";

  const name = doctype.name ?? "";
  const { publicId, systemId } = doctype;

  const parts = ["| <!DOCTYPE", name ? ` ${name}` : " "];

  if (publicId != null || systemId != null) {
    parts.push(` "${publicId ?? ""}"`, ` "${systemId ?? ""}"`);
  }

  parts.push(">");
  return parts.join("");
}

function attrsToTestFormat(node: Node, indent: number): string[] {
  const { attrs } = node;

  if (!attrs.size) return [];

  const padding = " ".repeat(indent + 2);
  const namespace = node.namespace ?? null;

  const displayAttrs: Array<[string, string]> = [];
  for (const [attrName, rawValue] of attrs) {
    const value = rawValue ?? "";
    let displayName = attrName;
    if (namespace && namespace !== "html") {
      const lowerName = attrName.toLowerCase();
      if (FOREIGN_ATTRIBUTE_ADJUSTMENTS.has(lowerName)) {
        displayName = attrName.replaceAll(":", " ");
      }
    }
    displayAttrs.push([displayName, value]);
  }

  // Match Python's default string sort (Unicode code point order), not locale collation.
  displayAttrs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return displayAttrs.map(([name, value]) => `| ${padding}${name}="${value}"`);
}

function nodeToTestFormat(node: Node, indent: number): string {
  switch (node.name) {
    case "#comment": {
      const comment = node.data ?? "";
      return `| ${" ".repeat(indent)}<!-- ${comment} -->`;
    }

    case "!doctype":
      return doctypeToTestFormat(node);

    case "#text": {
      const text = node.data ?? "";
      return `| ${" ".repeat(indent)}"${text}"`;
    }
  }

  const line = `| ${" ".repeat(indent)}<${qualifiedName(node)}>`;
  const attributeLines = attrsToTestFormat(node, indent);

  return isTemplateNode(node)
    ? [
        line,
        ...attributeLines,
        `| ${" ".repeat(indent + 2)}content`,
        ...node.templateContent.childNodes.map(child =>
          nodeToTestFormat(child, indent + 4)
        ),
      ].join("\n")
    : [
        line,
        ...attributeLines,
        ...node.childNodes.map(child => nodeToTestFormat(child, indent + 2)),
      ].join("\n");
}

/**
 * Serializes a node tree into html5lib-style test output format.
 *
 * This format is primarily used in conformance tests, not end-user output.
 */
export function toTestFormat(node: Node): string {
  return node.name === "#document" || node.name === "#document-fragment"
    ? node.childNodes.map(child => nodeToTestFormat(child, 0)).join("\n")
    : nodeToTestFormat(node, 0);
}

// Mirrors justhtml.serialize.toHTML (used for the public API, not html5lib-tests).

function escapeText(text: string): string {
  if (!text) return "";
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function chooseAttrQuote(value: string | undefined): '"' | "'" {
  if (value == null) return '"';
  const s = value;
  if (s.includes('"') && !s.includes("'")) return "'";
  return '"';
}

function escapeAttrValue(value: string | undefined, quoteChar: '"' | "'"): string {
  if (value == null) return "";
  const s = value.replaceAll("&", "&amp;");
  if (quoteChar === '"') return s.replaceAll('"', "&quot;");
  return s.replaceAll("'", "&#39;");
}

function canUnquoteAttrValue(value: string | undefined): boolean {
  if (value == null) return false;
  const s = value;
  for (const ch of s) {
    if (ch === ">") return false;
    if (ch === '"' || ch === "'" || ch === "=") return false;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r")
      return false;
  }
  return true;
}

function serializeStartTag(name: string, attrs: Map<string, string | null>): string {
  const parts: string[] = ["<", name];
  for (const [key, value] of attrs) {
    if (value == null || value === "") {
      parts.push(" ", key);
      continue;
    }

    if (canUnquoteAttrValue(value)) {
      const escaped = value.replaceAll("&", "&amp;");
      parts.push(" ", key, "=", escaped);
      continue;
    }

    const quote = chooseAttrQuote(value);
    const escaped = escapeAttrValue(value, quote);
    parts.push(" ", key, "=", quote, escaped, quote);
  }
  parts.push(">");
  return parts.join("");
}

function serializeEndTag(name: string): string {
  return `</${name}>`;
}

/**
 * Serializes a node tree to HTML.
 */
export function nodeToHTML(
  node: Node,
  indent = 0,
  indentSize = 2,
  pretty = true
): string {
  const prefix = pretty ? " ".repeat(indent * indentSize) : "";
  const newline = pretty ? "\n" : "";
  const { attrs, name, data } = node;

  switch (name) {
    case "#text": {
      let text = data as string;
      if (pretty) {
        text = text ? text.trim() : "";
        if (!text) return "";
        return `${prefix}${escapeText(text)}`;
      }
      return text ? escapeText(text) : "";
    }

    case "#comment":
      return `${prefix}<!--${data}-->`;

    case "!doctype":
      return `${prefix}<!DOCTYPE html>`;

    case "#document-fragment": {
      const parts: string[] = node.childNodes
        .map(child => nodeToHTML(child, indent, indentSize, pretty))
        .filter(Boolean);
      return pretty ? parts.join(newline) : parts.join("");
    }

    case "#document": {
      const parts: string[] = node.childNodes.map(child =>
        nodeToHTML(child, indent, indentSize, pretty)
      );
      return pretty ? parts.join(newline) : parts.join("");
    }
  }

  const openTag = serializeStartTag(name, attrs);
  if (VOID_ELEMENTS.has(name)) return `${prefix}${openTag}`;

  const children: Node[] = isTemplateNode(node)
    ? // eslint-disable-next-line unicorn/consistent-destructuring
      node.templateContent.childNodes
    : // eslint-disable-next-line unicorn/consistent-destructuring
      node.childNodes;

  if (!children.length) {
    return `${prefix}${openTag}${serializeEndTag(name)}`;
  }

  const allText = children.every(c => c.name === "#text");
  if (allText && pretty) {
    return `${prefix}${openTag}${escapeText(node.toText({ separator: "", strip: false }))}${serializeEndTag(name)}`;
  }

  const parts: string[] = [
    `${prefix}${openTag}`,
    ...children
      .map(child => nodeToHTML(child, indent + 1, indentSize, pretty))
      .filter(Boolean),
    `${prefix}${serializeEndTag(name)}`,
  ];
  return pretty ? parts.join(newline) : parts.join("");
}
