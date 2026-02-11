import type { FragmentContext } from "./context.ts";
import type { Node } from "./node.ts";
import {
  type Tokenizer,
  type TokenizerOpts,
  TokenizerState,
  createTokenizer,
} from "./tokenizer.ts";
import {
  type ParseErrorCode,
  type TreeBuilder,
  createTreeBuilder,
  finishTreeBuilder,
  getTokenizerSink,
} from "./treebuilder.ts";

interface ParseDocumentOptions {
  readonly fragmentContext?: FragmentContext | undefined;
  readonly iframeSrcdoc?: boolean;
  readonly collectErrors?: boolean;
  readonly tokenizerOpts?: TokenizerOpts | undefined;
}

interface ParseDocumentResult {
  readonly root: Node;
  readonly errors: ParseError[];
  readonly tokenizer: Tokenizer;
  readonly treeBuilder: TreeBuilder;
}

export class ParseError extends Error {
  constructor(
    readonly code: ParseErrorCode,
    readonly tagName: string | undefined
  ) {
    super(tagName ? `${code}: ${tagName}` : undefined);
    this.name = "ParseError";
  }
}

/**
 * Parses an HTML document or fragment into the internal node tree.
 *
 * @param html Raw HTML source text.
 * @param options Parser options controlling fragment mode, tokenizer behavior, and error collection.
 * @returns The parsed root node plus parser/tokenizer state useful for debugging and tests.
 */
export function parseDocument(
  html: string,
  {
    fragmentContext,
    iframeSrcdoc = false,
    collectErrors = false,
    tokenizerOpts,
  }: ParseDocumentOptions
): ParseDocumentResult {
  const opts = {
    ...(tokenizerOpts as TokenizerOpts),
  };

  const shouldCollect = collectErrors;
  const treeBuilder = createTreeBuilder(fragmentContext, iframeSrcdoc, shouldCollect);

  // Match justhtml's fragment tokenizer state overrides.
  if (fragmentContext && !fragmentContext.namespace) {
    const tagName = fragmentContext.tagName.toLowerCase();
    if (tagName === "textarea" || tagName === "title" || tagName === "style") {
      opts.initialState = TokenizerState.RawText;
      opts.initialRawTextTag = tagName;
    } else if (tagName === "plaintext" || tagName === "script") {
      opts.initialState = TokenizerState.PlainText;
      opts.initialRawTextTag = undefined;
    }
  }

  const sink = getTokenizerSink(treeBuilder);
  const tokenizer = createTokenizer(sink, opts);
  treeBuilder.tokenizer = tokenizer;

  tokenizer.run(html);
  const root = finishTreeBuilder(treeBuilder);
  const errors = [...tokenizer.errors, ...treeBuilder.errors] as ParseError[];

  return { root, errors, tokenizer, treeBuilder };
}
