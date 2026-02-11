import { type Node, isElementNode } from "./node.ts";

export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectorError";
  }
}

const enum TokenType {
  TAG,
  ID,
  CLASS,
  UNIVERSAL,
  ATTR_START,
  ATTR_END,
  ATTR_OP,
  STRING,
  COMBINATOR,
  COMMA,
  COLON,
  PAREN_OPEN,
  PAREN_CLOSE,
  EOF,
}

class Token {
  constructor(
    readonly type: TokenType,
    readonly value?: string | undefined
  ) {}

  toString(): string {
    return `Token(${this.type}, ${JSON.stringify(this.value)})`;
  }
}

function isNameStart(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  if (code > 127) return true;
  if (ch === "_" || ch === "-") return true;
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

function isNameChar(ch: string): boolean {
  if (isNameStart(ch)) return true;
  return ch >= "0" && ch <= "9";
}

function createSelectorTokenizer(selector: string) {
  let pos = 0;
  const { length } = selector;

  function peek(offset = 0): string {
    const p = pos + offset;
    if (p < length) return selector[p]!;
    return "";
  }

  function skipWhitespace(): void {
    while (pos < length && " \t\n\r\f".includes(selector[pos]!)) pos += 1;
  }

  function readName(): string {
    const start = pos;
    while (pos < length && isNameChar(selector[pos]!)) {
      pos += 1;
    }
    return selector.slice(start, pos);
  }

  function readString(quote: string): string {
    pos += 1;
    let start = pos;
    const parts = [];

    while (pos < length) {
      const ch = selector[pos];
      if (ch === quote) {
        if (pos > start) parts.push(selector.slice(start, pos));
        pos += 1;
        return parts.join("");
      }
      if (ch === "\\") {
        if (pos > start) parts.push(selector.slice(start, pos));
        pos += 1;
        if (pos < length) {
          parts.push(selector[pos]);
          pos += 1;
          start = pos;
        } else {
          start = pos;
        }
      } else {
        pos += 1;
      }
    }

    throw new SelectorError(
      `Unterminated string in selector: ${JSON.stringify(selector)}`
    );
  }

  function readUnquotedAttrValue(): string {
    const start = pos;
    while (pos < length) {
      const ch = selector[pos]!;
      if (" \t\n\r\f]".includes(ch)) break;
      pos += 1;
    }
    return selector.slice(start, pos);
  }

  return (): Token[] => {
    const tokens: Token[] = [];
    let pendingWhitespace = false;

    while (pos < length) {
      const ch = selector[pos]!;
      switch (ch) {
        case " ":
        case "\t":
        case "\n":
        case "\r":
        case "\f":
          pendingWhitespace = true;
          skipWhitespace();
          continue;

        case ">":
        case "+":
        case "~":
          pendingWhitespace = false;
          pos += 1;
          skipWhitespace();
          tokens.push(new Token(TokenType.COMBINATOR, ch));
          continue;
      }

      if (pendingWhitespace && tokens.length && ch !== ",") {
        tokens.push(new Token(TokenType.COMBINATOR, " "));
      }
      pendingWhitespace = false;

      switch (ch) {
        case "*":
          pos += 1;
          tokens.push(new Token(TokenType.UNIVERSAL));
          continue;

        case "#": {
          pos += 1;
          const name = readName();
          if (!name) {
            throw new SelectorError(`Expected identifier after # at position ${pos}`);
          }
          tokens.push(new Token(TokenType.ID, name));
          continue;
        }

        case ".": {
          pos += 1;
          const name = readName();
          if (!name) {
            throw new SelectorError(`Expected identifier after . at position ${pos}`);
          }
          tokens.push(new Token(TokenType.CLASS, name));
          continue;
        }

        case "[": {
          pos += 1;
          tokens.push(new Token(TokenType.ATTR_START));
          skipWhitespace();

          const attrName = readName();
          if (!attrName) {
            throw new SelectorError(`Expected attribute name at position ${pos}`);
          }
          tokens.push(new Token(TokenType.TAG, attrName));
          skipWhitespace();

          const ch2 = peek();
          if (ch2 === "]") {
            pos += 1;
            tokens.push(new Token(TokenType.ATTR_END));
            continue;
          }

          if (ch2 === "=") {
            pos += 1;
            tokens.push(new Token(TokenType.ATTR_OP, "="));
          } else if ("~|^$*".includes(ch2)) {
            const opChar = ch2;
            pos += 1;
            if (peek() !== "=") {
              throw new SelectorError(`Expected = after ${opChar} at position ${pos}`);
            }
            pos += 1;
            tokens.push(new Token(TokenType.ATTR_OP, `${opChar}=`));
          } else {
            throw new SelectorError(
              `Unexpected character in attribute selector: ${JSON.stringify(ch2)}`
            );
          }

          skipWhitespace();

          const ch3 = peek();
          const value =
            ch3 === '"' || ch3 === "'" ? readString(ch3) : readUnquotedAttrValue();
          tokens.push(new Token(TokenType.STRING, value));

          skipWhitespace();
          if (peek() !== "]") {
            throw new SelectorError(`Expected ] at position ${pos}`);
          }
          pos += 1;
          tokens.push(new Token(TokenType.ATTR_END));
          continue;
        }

        case ",":
          pos += 1;
          skipWhitespace();
          tokens.push(new Token(TokenType.COMMA));
          continue;

        case ":": {
          pos += 1;
          tokens.push(new Token(TokenType.COLON));

          const name = readName();
          if (!name) {
            throw new SelectorError(
              `Expected pseudo-class name after : at position ${pos}`
            );
          }
          tokens.push(new Token(TokenType.TAG, name));

          if (peek() === "(") {
            pos += 1;
            tokens.push(new Token(TokenType.PAREN_OPEN));
            skipWhitespace();

            let parenDepth = 1;
            const argStart = pos;
            while (pos < length && parenDepth > 0) {
              const c = selector[pos];
              if (c === "(") {
                parenDepth += 1;
              } else if (c === ")") {
                parenDepth -= 1;
              }
              if (parenDepth > 0) pos += 1;
            }

            const arg = selector.slice(argStart, pos).trim();
            if (arg) {
              tokens.push(new Token(TokenType.STRING, arg));
            }

            if (peek() !== ")") {
              throw new SelectorError(`Expected ) at position ${pos}`);
            }
            pos += 1;
            tokens.push(new Token(TokenType.PAREN_CLOSE));
          }

          continue;
        }
      }

      if (isNameStart(ch)) {
        const name = readName().toLowerCase();
        tokens.push(new Token(TokenType.TAG, name));
        continue;
      }

      throw new SelectorError(
        `Unexpected character ${JSON.stringify(ch)} at position ${pos}`
      );
    }

    tokens.push(new Token(TokenType.EOF));
    return tokens;
  };
}

const enum SelectorType {
  Tag,
  Id,
  Class,
  Universal,
  Attribute,
  Pseudo,
  Compound,
  Complex,
}

type SimpleSelector =
  | TagSelector
  | IdSelector
  | ClassSelector
  | UniversalSelector
  | AttributeSelector
  | PseudoSelector;

interface TagSelector {
  readonly kind: SelectorType.Tag;
  readonly name: string;
}

interface IdSelector {
  readonly kind: SelectorType.Id;
  readonly name: string;
}

interface ClassSelector {
  readonly kind: SelectorType.Class;
  readonly name: string;
}

interface UniversalSelector {
  readonly kind: SelectorType.Universal;
}

interface AttributeSelector {
  readonly kind: SelectorType.Attribute;
  readonly name: string;
  readonly operator: string | undefined;
  readonly value: string | undefined;
}

function createAttributeSelector(
  name: string,
  operator: string | undefined,
  value: string | undefined
): AttributeSelector {
  return { kind: SelectorType.Attribute, name, operator, value };
}

interface PseudoSelector {
  readonly kind: SelectorType.Pseudo;
  readonly name: string;
  readonly arg: string | undefined;
}

export interface CompoundSelector {
  readonly kind: SelectorType.Compound;
  readonly selectors: readonly SimpleSelector[];
}

export interface ComplexSelector {
  readonly kind: SelectorType.Complex;
  readonly parts: Array<[string | undefined, CompoundSelector]>;
}

export type SelectorList = ComplexSelector[];

function createSelectorParser(tokens: Token[]) {
  let pos = 0;

  function peek(): Token {
    if (pos < tokens.length) return tokens[pos]!;
    return new Token(TokenType.EOF);
  }

  function advance(): Token {
    const token = peek();
    pos += 1;
    return token;
  }

  function expect(tokenType: TokenType): Token {
    const token = peek();
    if (token.type !== tokenType) {
      throw new SelectorError(`Expected ${tokenType}, got ${token.type}`);
    }
    return advance();
  }

  function parseComplexSelector(): ComplexSelector | undefined {
    const complexSel: ComplexSelector = {
      kind: SelectorType.Complex,
      parts: [],
    };

    const compound = parseCompoundSelector();
    if (!compound) return;
    complexSel.parts.push([undefined, compound]);

    while (peek().type === TokenType.COMBINATOR) {
      const combinator = advance().value;
      const nextCompound = parseCompoundSelector();
      if (!nextCompound) throw new SelectorError("Expected selector after combinator");
      complexSel.parts.push([combinator, nextCompound]);
    }

    return complexSel;
  }

  function parseCompoundSelector(): CompoundSelector | undefined {
    const simpleSelectors: SimpleSelector[] = [];

    out: while (true) {
      const token = peek();

      switch (token.type) {
        case TokenType.TAG:
          advance();
          simpleSelectors.push({
            kind: SelectorType.Tag,
            name: token.value ?? "",
          });
          break;
        case TokenType.UNIVERSAL:
          advance();
          simpleSelectors.push({
            kind: SelectorType.Universal,
          });
          break;
        case TokenType.ID:
          advance();
          simpleSelectors.push({
            kind: SelectorType.Id,
            name: token.value ?? "",
          });
          break;
        case TokenType.CLASS:
          advance();
          simpleSelectors.push({
            kind: SelectorType.Class,
            name: token.value ?? "",
          });
          break;
        case TokenType.ATTR_START:
          simpleSelectors.push(parseAttributeSelector());
          break;
        case TokenType.COLON:
          simpleSelectors.push(parsePseudoSelector());
          break;
        default:
          break out;
      }
    }

    if (!simpleSelectors.length) return;

    return {
      kind: SelectorType.Compound,
      selectors: simpleSelectors,
    };
  }

  function parseAttributeSelector(): AttributeSelector {
    expect(TokenType.ATTR_START);
    const name = expect(TokenType.TAG).value ?? "";

    const token = peek();
    if (token.type === TokenType.ATTR_END) {
      advance();
      return createAttributeSelector(name, undefined, undefined);
    }

    const operator = expect(TokenType.ATTR_OP).value;
    const value = expect(TokenType.STRING).value;
    expect(TokenType.ATTR_END);

    return createAttributeSelector(name, operator, value);
  }

  function parsePseudoSelector(): PseudoSelector {
    expect(TokenType.COLON);
    const name = expect(TokenType.TAG).value ?? "";
    let arg: string | undefined;

    if (peek().type === TokenType.PAREN_OPEN) {
      advance();
      if (peek().type === TokenType.STRING) {
        arg = advance().value;
      }
      expect(TokenType.PAREN_CLOSE);
    }

    return { kind: SelectorType.Pseudo, name, arg };
  }

  return (): ComplexSelector | SelectorList => {
    const selectors: ComplexSelector[] = [parseComplexSelector()!];

    while (peek().type === TokenType.COMMA) {
      advance();
      const selector = parseComplexSelector();
      if (selector) selectors.push(selector);
    }

    if (peek().type !== TokenType.EOF) {
      throw new SelectorError(`Unexpected token: ${peek().toString()}`);
    }

    if (selectors.length === 1) {
      return selectors[0]!;
    }
    return selectors;
  };
}

function parseSelector(selectorString: string): ComplexSelector | SelectorList {
  if (!selectorString || !selectorString.trim()) {
    throw new SelectorError("Empty selector");
  }

  const tokenizer = createSelectorTokenizer(selectorString.trim());
  const tokens = tokenizer();
  const parse = createSelectorParser(tokens);
  return parse();
}

function matchesSelector(
  node: Node,
  sel: ComplexSelector | CompoundSelector | SimpleSelector | SelectorList
): boolean {
  if (Array.isArray(sel)) {
    return sel.some(sel => matchesSelector(node, sel));
  }
  switch (sel.kind) {
    case SelectorType.Complex:
      return matchesComplex(node, sel);
    case SelectorType.Compound:
      return matchesCompound(node, sel);
    default:
      return matchesSimple(node, sel);
  }
}

function matchesComplex(node: Node, selector: ComplexSelector): boolean {
  const { parts } = selector;
  if (!parts.length) return false;

  const [, compound] = parts.at(-1)!;
  if (!matchesCompound(node, compound)) return false;

  let current = node;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const [combinator] = parts[i + 1]!;
    const [, prevCompound] = parts[i]!;

    switch (combinator) {
      case " ": {
        let found = false;
        let ancestor = current.parentNode;
        while (ancestor) {
          if (matchesCompound(ancestor, prevCompound)) {
            current = ancestor;
            found = true;
            break;
          }
          ancestor = ancestor.parentNode;
        }
        if (!found) return false;

        break;
      }

      case ">": {
        const parent = current.parentNode;
        if (!parent || !matchesCompound(parent, prevCompound)) return false;
        current = parent;

        break;
      }

      case "+": {
        const sibling = current.previousSibling;
        if (!sibling || !matchesCompound(sibling, prevCompound)) return false;
        current = sibling;

        break;
      }

      default: {
        let found = false;
        let sibling = current.previousSibling;
        while (sibling) {
          if (matchesCompound(sibling, prevCompound)) {
            current = sibling;
            found = true;
            break;
          }
          sibling = sibling.previousSibling;
        }
        if (!found) return false;
      }
    }
  }

  return true;
}

function matchesCompound(node: Node, compound: CompoundSelector): boolean {
  return compound.selectors.every(simple => matchesSimple(node, simple));
}

function matchesSimple(node: Node, selector: SimpleSelector): boolean {
  if (!isElementNode(node)) {
    return false;
  }

  switch (selector.kind) {
    case SelectorType.Universal:
      return true;

    case SelectorType.Tag:
      return node.name.toLowerCase() === selector.name.toLowerCase();

    case SelectorType.Id:
      return node.attrs.get("id") === selector.name;

    case SelectorType.Class: {
      const classAttr = node.attrs.get("class") ?? "";
      const classes = classAttr ? classAttr.split(/\s+/).filter(Boolean) : [];
      return classes.includes(selector.name);
    }
    case SelectorType.Attribute:
      return matchesAttribute(node, selector);

    case SelectorType.Pseudo:
      return matchesPseudo(node, selector);

    default:
      return false;
  }
}

function matchesAttribute(node: Node, selector: AttributeSelector): boolean {
  const attrName = selector.name.toLowerCase();

  let found = false;
  let attrValue: string | undefined;
  for (const [name, value] of node.attrs) {
    if (name.toLowerCase() === attrName) {
      found = true;
      attrValue = value ?? undefined;
      break;
    }
  }

  if (!found) return false;

  const { operator: op, value } = selector;
  if (op == null) return true;
  if (value == null) return false;
  const s = attrValue ?? "";

  switch (op) {
    case "=":
      return s === value;
    case "~=":
      return (s ? s.split(/\s+/).filter(Boolean) : []).includes(value);
    case "|=":
      return s === value || (value ? s.startsWith(`${value}-`) : false);
    case "^=":
      return value !== "" && s.startsWith(value);
    case "$=":
      return value !== "" && s.endsWith(value);
    case "*=":
      return value !== "" && s.includes(value);
  }

  return false;
}

function matchesPseudo(node: Node, selector: PseudoSelector): boolean {
  const name = selector.name.toLowerCase();
  switch (name) {
    case "first-child":
      return isFirstChild(node);

    case "last-child":
      return isLastChild(node);

    case "nth-child":
      return matchesNthChild(node, selector.arg);

    case "not":
      return !selector.arg || !matchesSelector(node, parseSelector(selector.arg));

    case "only-child":
      return isFirstChild(node) && isLastChild(node);

    case "empty":
      for (const child of node.childNodes) {
        if (child.name === "#text") {
          if (typeof child.data === "string" && child.data.trim()) {
            return false;
          }
        } else if (isElementNode(child)) {
          return false;
        }
      }
      return true;

    case "root": {
      const parent = node.parentNode;
      return (
        parent != null &&
        (parent.name === "#document" || parent.name === "#document-fragment")
      );
    }

    case "first-of-type":
      return isFirstOfType(node);
    case "last-of-type":
      return isLastOfType(node);
    case "nth-of-type":
      return matchesNthOfType(node, selector.arg);
    case "only-of-type":
      return isFirstOfType(node) && isLastOfType(node);
    default:
      throw new SelectorError(`Unsupported pseudo-class: :${name}`);
  }
}

function isFirstChild(node: Node): boolean {
  const { parentNode: parent } = node;
  if (!parent) return false;
  const elements = parent.children;
  return elements.length ? elements[0] === node : false;
}

function isLastChild(node: Node): boolean {
  const { parentNode: parent } = node;
  if (!parent) return false;
  const elements = parent.children;
  return elements.length ? elements.at(-1) === node : false;
}

function isFirstOfType(node: Node): boolean {
  const { name, parentNode: parent } = node;
  if (!parent) return false;
  const nodeName = name.toLowerCase();
  for (const child of parent.children) {
    if (child.name.toLowerCase() === nodeName) {
      return child === node;
    }
  }
  return false;
}

function isLastOfType(node: Node): boolean {
  const { name, parentNode: parent } = node;
  if (!parent) return false;
  const nodeName = name.toLowerCase();
  let lastOfType: Node | undefined;
  for (const child of parent.children) {
    if (child.name.toLowerCase() === nodeName) {
      lastOfType = child;
    }
  }
  return lastOfType === node;
}

function parseNthExpression(expr?: string): [number, number] | undefined {
  if (!expr) return;

  let s = expr.trim().toLowerCase();
  if (s === "odd") return [2, 1];
  if (s === "even") return [2, 0];

  s = s.replaceAll(" ", "");

  let a = 0;
  let b = 0;

  if (s.includes("n")) {
    const parts = s.split("n");
    const aPart = parts[0]!;
    const bPart = parts.length > 1 ? parts[1] : "";

    if (aPart === "" || aPart === "+") a = 1;
    else if (aPart === "-") a = -1;
    else {
      a = Number.parseInt(aPart, 10);
      if (Number.isNaN(a)) return;
    }

    if (bPart) {
      b = Number.parseInt(bPart, 10);
      if (Number.isNaN(b)) return;
    }
  } else {
    b = Number.parseInt(s, 10);
    if (Number.isNaN(b)) return;
  }

  return [a, b];
}

function matchesNth(index: number, a: number, b: number): boolean {
  if (a === 0) return index === b;
  const diff = index - b;
  if (a > 0) return diff >= 0 && diff % a === 0;
  return diff <= 0 && diff % a === 0;
}

function matchesNthChild(node: Node, arg?: string): boolean {
  const { parentNode: parent } = node;
  if (!parent) return false;

  const parsed = parseNthExpression(arg);
  if (parsed == null) return false;
  const [a, b] = parsed;

  for (const [i, element] of parent.children.entries()) {
    if (element === node) {
      return matchesNth(i + 1, a, b);
    }
  }
  return false;
}

function matchesNthOfType(node: Node, arg?: string): boolean {
  const { name, parentNode: parent } = node;
  if (!parent) return false;

  const parsed = parseNthExpression(arg);
  if (parsed == null) return false;
  const [a, b] = parsed;

  const nodeName = name.toLowerCase();
  let typeIndex = 0;
  for (const child of parent.children) {
    if (child.name.toLowerCase() === nodeName) {
      typeIndex += 1;
      if (child === node) {
        return matchesNth(typeIndex, a, b);
      }
    }
  }
  return false;
}

function* queryDescendants<T extends Node>(
  node: T,
  selector: ComplexSelector | SelectorList
): Iterable<T> {
  if (!Array.isArray(node.childNodes)) return;

  for (const child of node.childNodes) {
    if (isElementNode(child) && matchesSelector(child, selector)) {
      yield child as T;
    }
    yield* queryDescendants(child as T, selector);
  }

  const { templateContent } = node;
  if (templateContent) {
    yield* queryDescendants(templateContent as T, selector);
  }
}

/**
 * Returns all descendant element nodes under `root` that match `selectorString`.
 */
export function* querySelectorAll<T extends Node>(
  root: T,
  selectorString: string
): Iterable<T> {
  yield* queryDescendants<T>(root, parseSelector(selectorString));
}

/**
 * Returns `true` when `node` matches `selectorString`.
 */
export function matches(node: Node, selectorString: string): boolean {
  return matchesSelector(node, parseSelector(selectorString));
}
