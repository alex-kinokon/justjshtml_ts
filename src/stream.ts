import { decodeHTML } from "./encoding.ts";
import { type TokenizerOpts, createTokenizer } from "./tokenizer.ts";
import {
  type AttrMap,
  TagKind,
  type Token,
  TokenKind,
  TokenSinkResult,
} from "./tokens.ts";
import type { TokenizerSink } from "./treebuilder.ts";

type StreamEvent =
  | ["start", [string, AttrMap]]
  | ["end", string]
  | ["comment", string]
  | ["doctype", [string | undefined, string | undefined, string | undefined]]
  | ["text", string];

class StreamSink implements TokenizerSink {
  events: StreamEvent[] = [];

  processToken(token: Token): TokenSinkResult {
    if (token.type === TokenKind.Tag) {
      if (token.kind === TagKind.Start) {
        this.events.push(["start", [token.name, Object.fromEntries(token.attrs)]]);
      } else {
        this.events.push(["end", token.name]);
      }
      return TokenSinkResult.Continue;
    }

    if (token.type === TokenKind.Comment) {
      this.events.push(["comment", token.data]);
      return TokenSinkResult.Continue;
    }

    if (token.type === TokenKind.Doctype) {
      const dt = token.doctype;
      this.events.push(["doctype", [dt.name, dt.publicId, dt.systemId]]);
      return TokenSinkResult.Continue;
    }

    return TokenSinkResult.Continue;
  }

  processCharacters(data: string) {
    this.events.push(["text", data]);
  }
}

/**
 * Incrementally tokenizes HTML and yields normalized stream events.
 *
 * Adjacent text chunks are coalesced before being yielded.
 */
export function* stream(
  html: string | ArrayBuffer | Uint8Array | object = "",
  {
    encoding,
    tokenizerOpts = {},
  }: {
    encoding?: string;
    tokenizerOpts?: TokenizerOpts;
  } = {}
): Generator<StreamEvent, void, void> {
  let input = html;

  if (typeof input === "string") {
    // Already decoded.
  } else if (input instanceof ArrayBuffer) {
    input = new Uint8Array(input);
  }

  if (input instanceof Uint8Array) {
    input = decodeHTML(input, encoding).text;
  }

  const sink = new StreamSink();
  const tokenizer = createTokenizer(sink, tokenizerOpts);
  tokenizer.initialize(input as string);

  while (true) {
    const isEof = tokenizer.step();

    if (sink.events.length) {
      let textBuffer: string | undefined;

      for (const [event, data] of sink.events) {
        if (event === "text") {
          textBuffer ??= "";
          textBuffer += data;
          continue;
        }

        if (textBuffer != null) {
          yield ["text", textBuffer];
          textBuffer = undefined;
        }

        yield [event, data] as StreamEvent;
      }

      if (textBuffer != null) yield ["text", textBuffer];
      sink.events = [];
    }

    if (isEof) break;
  }
}
