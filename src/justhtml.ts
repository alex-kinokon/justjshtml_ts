import type { FragmentContext } from "./context.ts";
import { decodeHTML } from "./encoding.ts";
import type { Node, ToHTMLOptions, ToTextOptions } from "./node.ts";
import { type ParseError, parseDocument } from "./parser.ts";
import type { TokenizerOpts } from "./tokenizer.ts";

interface JustHTMLOptions {
  readonly collectErrors?: boolean;
  readonly encoding?: string | undefined;
  readonly strict?: boolean;
  readonly fragmentContext?: FragmentContext | undefined;
  readonly iframeSrcdoc?: boolean;
  readonly tokenizerOpts?: TokenizerOpts | undefined;
}

export class StrictModeError extends SyntaxError {
  readonly error: ParseError;

  constructor(error: ParseError) {
    super(error.message || String(error.code) || "parse-error");
    this.error = error;
    this.name = "StrictModeError";
  }
}

/**
 * High-level API for parsing HTML and querying/serializing the resulting tree.
 */
export class JustHTML {
  readonly encoding: string | undefined;
  readonly errors: ParseError[];
  readonly fragmentContext: FragmentContext | undefined;
  readonly root: Node;
  readonly collectErrors: boolean;
  readonly strict: boolean;
  readonly iframeSrcdoc: boolean;

  /**
   * Parses HTML input from a string or bytes.
   *
   * When bytes are provided, character encoding is sniffed according to HTML rules.
   */
  constructor(input: string | ArrayBuffer | Uint8Array, options: JustHTMLOptions = {}) {
    const {
      collectErrors = false,
      encoding,
      strict = false,
      fragmentContext,
      iframeSrcdoc = false,
      tokenizerOpts,
    } = options;

    this.encoding = undefined;
    this.errors = [];
    this.fragmentContext = fragmentContext;

    let html = input;
    if (typeof html === "string") {
      // Already decoded.
    } else if (html instanceof ArrayBuffer) {
      const bytes = new Uint8Array(html);
      const decoded = decodeHTML(bytes, encoding);
      this.encoding = decoded.encoding;
      html = decoded.text;
    } else if (html instanceof Uint8Array) {
      const decoded = decodeHTML(html, encoding);
      this.encoding = decoded.encoding;
      html = decoded.text;
    }

    const shouldCollect = collectErrors || strict;
    const parsed = parseDocument(html, {
      fragmentContext,
      iframeSrcdoc,
      collectErrors: shouldCollect,
      tokenizerOpts,
    });
    this.root = parsed.root;
    this.errors = parsed.errors;

    this.collectErrors = collectErrors;
    this.strict = strict;
    this.iframeSrcdoc = iframeSrcdoc;

    if (this.strict && this.errors.length) {
      throw new StrictModeError(this.errors[0]!);
    }
  }

  /**
   * Returns concatenated text content from the parsed tree.
   */
  toText(options?: ToTextOptions): string {
    return this.root.toText(options);
  }

  /**
   * Serializes the parsed tree back to HTML.
   */
  toHTML(options?: ToHTMLOptions): string {
    return this.root.toHTML(options);
  }

  /**
   * Returns the first descendant node that matches the provided CSS selector.
   */
  querySelector(selector: string): Node | null {
    return this.root.querySelector(selector);
  }

  /**
   * Returns all nodes in the tree that match a CSS selector.
   */
  querySelectorAll(selector: string): Iterable<Node> {
    return this.root.querySelectorAll(selector);
  }
}
