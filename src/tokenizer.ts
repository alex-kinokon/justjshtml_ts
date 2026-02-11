import { decodeEntitiesInText } from "./entities.ts";
import {
  Doctype,
  TagKind,
  type Token,
  TokenSinkResult,
  createCommentToken,
  createDocTypeToken,
  createTagToken,
  eofToken,
} from "./tokens.ts";
import type { TokenizerSink } from "./treebuilder.ts";

export const enum ErrorCode {
  AbruptClosingOfEmptyComment,
  AbruptDoctypePublicIdentifier,
  AbruptDoctypeSystemIdentifier,
  CdataInHtmlContent,
  DuplicateAttribute,
  EndTagWithAttributes,
  EofBeforeTagName,
  EofInCdata,
  EofInComment,
  EofInDoctype,
  EofInDoctypeName,
  EofInDoctypePublicIdentifier,
  EofInDoctypeSystemIdentifier,
  EofInTag,
  ExpectedDoctypeNameButGotRightBracket,
  IncorrectlyClosedComment,
  IncorrectlyOpenedComment,
  InvalidFirstCharacterOfTagName,
  MissingAttributeValue,
  MissingDoctypePublicIdentifier,
  MissingDoctypeSystemIdentifier,
  MissingEndTagName,
  MissingQuoteBeforeDoctypePublicIdentifier,
  MissingQuoteBeforeDoctypeSystemIdentifier,
  MissingWhitespaceAfterDoctypeName,
  MissingWhitespaceAfterDoctypePublicIdentifier,
  MissingWhitespaceBeforeDoctypeName,
  MissingWhitespaceBeforeDoctypePublicIdentifier,
  MissingWhitespaceBetweenAttributes,
  MissingWhitespaceBetweenDoctypePublicAndSystemIdentifiers,
  UnexpectedCharacterAfterDoctypePublicIdentifier,
  UnexpectedCharacterAfterDoctypePublicKeyword,
  UnexpectedCharacterAfterDoctypeSystemIdentifier,
  UnexpectedCharacterAfterDoctypeSystemKeyword,
  UnexpectedCharacterAfterSolidusInTag,
  UnexpectedEqualsSignBeforeAttributeName,
  UnexpectedNullCharacter,
  UnexpectedQuestionMarkInsteadOfTagName,
}

export interface TokenizerOpts {
  readonly initialState?: State;
  readonly initialRawTextTag?: string;
  readonly discardBom?: boolean;
  readonly xmlCoercion?: boolean;
}

export interface TokenizerError {
  readonly code: ErrorCode;
  readonly offset: number;
}

function isWhitespace(c: string | null | undefined): boolean {
  return c === "\t" || c === "\n" || c === "\f" || c === " " || c === "\r";
}

function isAsciiAlpha(c: string): boolean {
  const code = c.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function asciiLower(c: string): string {
  const code = c.charCodeAt(0);
  return code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : c;
}

const replacement = "\uFFFD";

function coerceTextForXML(text: string): string {
  if (!text) return text;

  let changed = false;
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0c) {
      out += " ";
      changed = true;
      continue;
    }
    if (cp >= 0xfdd0 && cp <= 0xfdef) {
      out += replacement;
      changed = true;
      continue;
    }
    const low16 = cp & 0xffff;
    if (low16 === 0xfffe || low16 === 0xffff) {
      out += replacement;
      changed = true;
      continue;
    }
    out += ch;
  }

  return changed ? out : text;
}

function coerceCommentForXML(text: string): string {
  if (!text) return text;
  return !text.includes("--") ? text : text.replaceAll("--", "- -");
}

const RCDATA_ELEMENTS = new Set(["title", "textarea"]);
const RAW_TEXT_SWITCH_TAGS = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "textarea",
  "title",
]);

export { State as TokenizerState };

// https://github.com/rolldown/rolldown/issues/4342
const enum State {
  Data,
  TagOpen,
  EndTagOpen,
  TagName,
  BeforeAttributeName,
  AttributeName,
  AfterAttributeName,
  BeforeAttributeValue,
  AttributeValueDouble,
  AttributeValueSingle,
  AttributeValueUnquoted,
  AfterAttributeValueQuoted,
  SelfClosingStartTag,
  MarkupDeclarationOpen,
  CommentStart,
  CommentStartDash,
  Comment,
  CommentEndDash,
  CommentEnd,
  CommentEndBang,
  BogusComment,
  Doctype,
  BeforeDoctypeName,
  DoctypeName,
  AfterDoctypeName,
  BogusDoctype,
  AfterDoctypePublicKeyword,
  AfterDoctypeSystemKeyword,
  BeforeDoctypePublicIdentifier,
  DoctypePublicIdentifierDoubleQuoted,
  DoctypePublicIdentifierSingleQuoted,
  AfterDoctypePublicIdentifier,
  BetweenDoctypePublicAndSystemIdentifiers,
  BeforeDoctypeSystemIdentifier,
  DoctypeSystemIdentifierDoubleQuoted,
  DoctypeSystemIdentifierSingleQuoted,
  AfterDoctypeSystemIdentifier,
  CDATASection,
  CDATASectionBracket,
  CDATASectionEnd,
  RCDATA,
  RCDATALessThanSign,
  RCDATAEndTagOpen,
  RCDATAEndTagName,
  RawText,
  RawTextLessThanSign,
  RawTextEndTagOpen,
  RawTextEndTagName,
  PlainText,
  ScriptDataEscaped,
  ScriptDataEscapedDash,
  ScriptDataEscapedDashDash,
  ScriptDataEscapedLessThanSign,
  ScriptDataEscapedEndTagOpen,
  ScriptDataEscapedEndTagName,
  ScriptDataDoubleEscapeStart,
  ScriptDataDoubleEscaped,
  ScriptDataDoubleEscapedDash,
  ScriptDataDoubleEscapedDashDash,
  ScriptDataDoubleEscapedLessThanSign,
  ScriptDataDoubleEscapeEnd,
}

export type Tokenizer = ReturnType<typeof createTokenizer>;

// Minimal HTML5 tokenizer, ported incrementally from ~/dev/justhtml.
export function createTokenizer(sink: TokenizerSink, opts: TokenizerOpts = {}) {
  let errors: TokenizerError[] = [];
  let state = State.Data;
  let buffer = "";
  let length = 0;
  let pos = 0;
  let reconsume = false;
  let currentChar: string | undefined;
  let ignoreLF = false;
  let textBuffer: string[] = [];
  let currentTagName: string[] = [];
  const currentTagAttrs = new Map<string, string>();
  let currentAttrName: string[] = [];
  let currentAttrValue: string[] = [];
  let currentAttrValueHasAmp = false;
  let currentTagSelfClosing = false;
  let currentTagKind = TagKind.Start;
  let currentComment: string[] = [];
  let currentDoctypeName: string[] = [];
  let currentDoctypePublic: string[] | undefined;
  let currentDoctypeSystem: string[] | undefined;
  let currentDoctypeForceQuirks = false;
  let lastStartTagName: string | undefined;
  let rawTextTagName: string | undefined;
  let tempBuffer: string[] = [];
  let originalTagName: string[] = [];
  let tagToken = createTagToken(TagKind.Start, "", new Map(), false);

  function initialize(input: string): void {
    if (opts.discardBom && input && input[0] === "\uFEFF") {
      input = input.slice(1);
    }

    buffer = input;
    length = input.length;
    pos = 0;
    reconsume = false;
    currentChar = undefined;
    ignoreLF = false;
    errors = [];

    textBuffer = [];
    currentTagName = [];
    currentTagAttrs.clear();
    currentAttrName = [];
    currentAttrValue = [];
    currentAttrValueHasAmp = false;
    currentTagSelfClosing = false;
    currentTagKind = TagKind.Start;
    currentComment = [];

    currentDoctypeName = [];
    currentDoctypePublic = undefined;
    currentDoctypeSystem = undefined;
    currentDoctypeForceQuirks = false;

    rawTextTagName = opts.initialRawTextTag;
    tempBuffer = [];
    originalTagName = [];
    lastStartTagName = undefined;

    state = typeof opts.initialState === "number" ? opts.initialState : State.Data;
  }

  function run(html: string): void {
    initialize(html);
    while (true) {
      if (step()) break;
    }
  }

  function step(): boolean {
    switch (state) {
      case State.Data:
        return stateData();
      case State.TagOpen:
        return stateTagOpen();
      case State.EndTagOpen:
        return stateEndTagOpen();
      case State.TagName:
        return stateTagName();
      case State.BeforeAttributeName:
        return stateBeforeAttributeName();
      case State.AttributeName:
        return stateAttributeName();
      case State.AfterAttributeName:
        return stateAfterAttributeName();
      case State.BeforeAttributeValue:
        return stateBeforeAttributeValue();
      case State.AttributeValueDouble:
        return stateAttributeValueDouble();
      case State.AttributeValueSingle:
        return stateAttributeValueSingle();
      case State.AttributeValueUnquoted:
        return stateAttributeValueUnquoted();
      case State.AfterAttributeValueQuoted:
        return stateAfterAttributeValueQuoted();
      case State.SelfClosingStartTag:
        return stateSelfClosingStartTag();
      case State.MarkupDeclarationOpen:
        return stateMarkupDeclarationOpen();
      case State.CommentStart:
        return stateCommentStart();
      case State.CommentStartDash:
        return stateCommentStartDash();
      case State.Comment:
        return stateComment();
      case State.CommentEndDash:
        return stateCommentEndDash();
      case State.CommentEnd:
        return stateCommentEnd();
      case State.CommentEndBang:
        return stateCommentEndBang();
      case State.BogusComment:
        return stateBogusComment();
      case State.Doctype:
        return stateDoctype();
      case State.BeforeDoctypeName:
        return stateBeforeDoctypeName();
      case State.DoctypeName:
        return stateDoctypeName();
      case State.AfterDoctypeName:
        return stateAfterDoctypeName();
      case State.BogusDoctype:
        return stateBogusDoctype();
      case State.AfterDoctypePublicKeyword:
        return stateAfterDoctypePublicKeyword();
      case State.AfterDoctypeSystemKeyword:
        return stateAfterDoctypeSystemKeyword();
      case State.BeforeDoctypePublicIdentifier:
        return stateBeforeDoctypePublicIdentifier();
      case State.DoctypePublicIdentifierDoubleQuoted:
        return stateDoctypePublicIdentifierDoubleQuoted();
      case State.DoctypePublicIdentifierSingleQuoted:
        return stateDoctypePublicIdentifierSingleQuoted();
      case State.AfterDoctypePublicIdentifier:
        return stateAfterDoctypePublicIdentifier();
      case State.BetweenDoctypePublicAndSystemIdentifiers:
        return stateBetweenDoctypePublicAndSystemIdentifiers();
      case State.BeforeDoctypeSystemIdentifier:
        return stateBeforeDoctypeSystemIdentifier();
      case State.DoctypeSystemIdentifierDoubleQuoted:
        return stateDoctypeSystemIdentifierDoubleQuoted();
      case State.DoctypeSystemIdentifierSingleQuoted:
        return stateDoctypeSystemIdentifierSingleQuoted();
      case State.AfterDoctypeSystemIdentifier:
        return stateAfterDoctypeSystemIdentifier();
      case State.CDATASection:
        return stateCdataSection();
      case State.CDATASectionBracket:
        return stateCdataSectionBracket();
      case State.CDATASectionEnd:
        return stateCdataSectionEnd();
      case State.RCDATA:
        return stateRcdata();
      case State.RCDATALessThanSign:
        return stateRcdataLessThanSign();
      case State.RCDATAEndTagOpen:
        return stateRcdataEndTagOpen();
      case State.RCDATAEndTagName:
        return stateRcdataEndTagName();
      case State.RawText:
        return stateRawText();
      case State.RawTextLessThanSign:
        return stateRawTextLessThanSign();
      case State.RawTextEndTagOpen:
        return stateRawTextEndTagOpen();
      case State.RawTextEndTagName:
        return stateRawTextEndTagName();
      case State.PlainText:
        return statePlaintext();
      case State.ScriptDataEscaped:
        return stateScriptDataEscaped();
      case State.ScriptDataEscapedDash:
        return stateScriptDataEscapedDash();
      case State.ScriptDataEscapedDashDash:
        return stateScriptDataEscapedDashDash();
      case State.ScriptDataEscapedLessThanSign:
        return stateScriptDataEscapedLessThanSign();
      case State.ScriptDataEscapedEndTagOpen:
        return stateScriptDataEscapedEndTagOpen();
      case State.ScriptDataEscapedEndTagName:
        return stateScriptDataEscapedEndTagName();
      case State.ScriptDataDoubleEscapeStart:
        return stateScriptDataDoubleEscapeStart();
      case State.ScriptDataDoubleEscaped:
        return stateScriptDataDoubleEscaped();
      case State.ScriptDataDoubleEscapedDash:
        return stateScriptDataDoubleEscapedDash();
      case State.ScriptDataDoubleEscapedDashDash:
        return stateScriptDataDoubleEscapedDashDash();
      case State.ScriptDataDoubleEscapedLessThanSign:
        return stateScriptDataDoubleEscapedLessThanSign();
      case State.ScriptDataDoubleEscapeEnd:
        return stateScriptDataDoubleEscapeEnd();
      default:
        // Not yet ported; fall back to DATA semantics to keep the runner usable.
        state = State.Data;
        return false;
    }
  }

  function getChar(): string | null {
    if (reconsume) {
      reconsume = false;
      return currentChar ?? null;
    }

    while (true) {
      if (pos >= length) {
        currentChar = undefined;
        return null;
      }

      let c = buffer[pos]!;
      pos += 1;

      if (c === "\r") {
        ignoreLF = true;
        c = "\n";
      } else if (c === "\n" && ignoreLF) {
        ignoreLF = false;
        continue;
      } else {
        ignoreLF = false;
      }

      currentChar = c;
      return c;
    }
  }

  function reconsumeCurrent(): void {
    reconsume = true;
  }

  function peekChar(offset: number): string | undefined {
    const p = pos + offset;
    return p < 0 || p >= length ? undefined : buffer[p];
  }

  function appendText(s: string): void {
    if (s) {
      textBuffer.push(s);
    }
  }

  function flushText(): void {
    if (!textBuffer.length) return;
    let data = textBuffer.join("");
    textBuffer = [];

    // Per HTML5 spec (and Python port):
    // - decode character references in DATA/RCDATA and similar (< RAW_TEXT)
    // - do not decode in RAW_TEXT/PLAINTEXT/script states or CDATA
    const inCDATA = state >= State.CDATASection && state <= State.CDATASectionEnd;
    if (
      !inCDATA &&
      state < State.RawText &&
      state < State.PlainText &&
      data.includes("&")
    ) {
      data = decodeEntitiesInText(data);
    }

    if (opts.xmlCoercion) data = coerceTextForXML(data);

    sink.processCharacters(data);
  }

  function emitToken(token: Token): void {
    sink.processToken(token);
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping
  function emitError(code: ErrorCode): void {
    // `pos` points to the next unread char after `getChar()`, so clamp to last-read offset.
    errors.push({ code, offset: Math.max(0, pos - 1) });
  }

  function startNewAttribute(): void {
    currentAttrName = [];
    currentAttrValue = [];
    currentAttrValueHasAmp = false;
  }

  function finishAttribute(): void {
    if (!currentAttrName.length) return;
    const name = currentAttrName.join("");
    currentAttrName = [];

    if (currentTagAttrs.has(name)) {
      emitError(ErrorCode.DuplicateAttribute);
      currentAttrValue = [];
      currentAttrValueHasAmp = false;
      return;
    }

    let value = "";
    if (currentAttrValue.length) {
      value = currentAttrValue.join("");
    }
    currentAttrValue = [];

    if (currentAttrValueHasAmp) {
      value = decodeEntitiesInText(value, /* inAttribute */ true);
    }
    currentAttrValueHasAmp = false;

    currentTagAttrs.set(name, value);
  }

  function emitCurrentTag(): boolean {
    const name = currentTagName.join("");
    const attrs = currentTagAttrs;

    tagToken = createTagToken(
      currentTagKind,
      name,
      new Map(attrs),
      currentTagSelfClosing
    );

    let switchedToRawText = false;
    if (currentTagKind === TagKind.Start) {
      lastStartTagName = name;

      const needsRawTextCheck = RAW_TEXT_SWITCH_TAGS.has(name) || name === "plaintext";
      if (needsRawTextCheck) {
        const stack = sink.openElements ?? [];
        const currentNode = stack.at(-1);
        const namespace = currentNode?.namespace;

        if (currentNode === undefined || namespace === "html") {
          if (RCDATA_ELEMENTS.has(name)) {
            state = State.RCDATA;
            rawTextTagName = name;
            switchedToRawText = true;
          } else if (RAW_TEXT_SWITCH_TAGS.has(name)) {
            state = State.RawText;
            rawTextTagName = name;
            switchedToRawText = true;
          } else {
            state = State.PlainText;
            switchedToRawText = true;
          }
        }
      }
    }

    const result = sink.processToken(tagToken);
    if (result === TokenSinkResult.Plaintext) {
      state = State.PlainText;
      switchedToRawText = true;
    }

    currentTagName = [];
    currentTagAttrs.clear();
    currentAttrName = [];
    currentAttrValue = [];
    currentAttrValueHasAmp = false;
    currentTagSelfClosing = false;
    currentTagKind = TagKind.Start;
    return switchedToRawText;
  }

  function emitComment(): void {
    let data = currentComment.join("");
    currentComment = [];
    if (opts.xmlCoercion) data = coerceCommentForXML(data);
    emitToken(createCommentToken(data));
  }

  function emitDoctype(): void {
    const name = currentDoctypeName.length ? currentDoctypeName.join("") : undefined;
    const publicId = currentDoctypePublic?.join("");
    const systemId = currentDoctypeSystem?.join("");

    const doctype = new Doctype({
      name,
      publicId,
      systemId,
      forceQuirks: currentDoctypeForceQuirks,
    });

    currentDoctypeName = [];
    currentDoctypePublic = undefined;
    currentDoctypeSystem = undefined;
    currentDoctypeForceQuirks = false;

    emitToken(createDocTypeToken(doctype));
  }

  function consumeIf(literal: string): boolean {
    const end = pos + literal.length;
    if (end > length) return false;
    if (buffer.slice(pos, end) !== literal) return false;
    pos = end;
    return true;
  }

  function consumeCaseInsensitive(literal: string): boolean {
    const end = pos + literal.length;
    if (end > length) return false;
    const segment = buffer.slice(pos, end);
    if (segment.toLowerCase() !== literal.toLowerCase()) return false;
    pos = end;
    return true;
  }

  // -----------------
  // State handlers
  // -----------------

  function stateData(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        flushText();
        emitToken(eofToken());
        return true;

      case "<":
        flushText();
        state = State.TagOpen;
        return false;
      default:
        appendText(c);
        return false;
    }
  }

  function statePlaintext(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        flushText();
        emitToken(eofToken());
        return true;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        appendText(replacement);
        return false;
      default:
        appendText(c);
        return false;
    }
  }

  function stateTagOpen(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        appendText("<");
        flushText();
        emitToken(eofToken());
        return true;

      case "!":
        state = State.MarkupDeclarationOpen;
        return false;

      case "/":
        state = State.EndTagOpen;
        return false;

      case "?":
        emitError(ErrorCode.UnexpectedQuestionMarkInsteadOfTagName);
        currentComment = [];
        reconsumeCurrent();
        state = State.BogusComment;
        return false;
      default:
        if (isAsciiAlpha(c)) {
          currentTagKind = TagKind.Start;
          currentTagName = [asciiLower(c)];
          currentTagAttrs.clear();
          currentTagSelfClosing = false;
          state = State.TagName;
          return false;
        }

        emitError(ErrorCode.InvalidFirstCharacterOfTagName);
        appendText("<");
        reconsumeCurrent();
        state = State.Data;
        return false;
    }
  }

  function stateEndTagOpen(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofBeforeTagName);
        appendText("</");
        flushText();
        emitToken(eofToken());
        return true;

      case ">":
        emitError(ErrorCode.MissingEndTagName);
        state = State.Data;
        return false;
      default:
        if (isAsciiAlpha(c)) {
          currentTagKind = TagKind.End;
          currentTagName = [asciiLower(c)];
          currentTagAttrs.clear();
          currentTagSelfClosing = false;
          state = State.TagName;
          return false;
        }

        emitError(ErrorCode.InvalidFirstCharacterOfTagName);
        currentComment = [];
        reconsumeCurrent();
        state = State.BogusComment;
        return false;
    }
  }

  function stateTagName(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInTag);
        emitToken(eofToken());
        return true;

      case "\t":
      case "\n":
      case "\f":
      case " ":
      case "\r":
        if (currentTagKind === TagKind.End) emitError(ErrorCode.EndTagWithAttributes);
        state = State.BeforeAttributeName;
        return false;

      case "/":
        state = State.SelfClosingStartTag;
        return false;

      case ">":
        if (!emitCurrentTag()) state = State.Data;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        currentTagName.push("\uFFFD");
        return false;
      default:
        currentTagName.push(asciiLower(c));
        return false;
    }
  }

  function stateBeforeAttributeName(): boolean {
    switch (getChar()) {
      case null:
        emitError(ErrorCode.EofInTag);
        flushText();
        emitToken(eofToken());
        return true;

      case "\t":
      case "\n":
      case "\f":
      case " ":
      case "\r":
        return false;

      case "/":
        state = State.SelfClosingStartTag;
        return false;

      case ">":
        if (!emitCurrentTag()) state = State.Data;
        return false;

      case "=":
        emitError(ErrorCode.UnexpectedEqualsSignBeforeAttributeName);
        startNewAttribute();
        currentAttrName.push("=");
        state = State.AttributeName;
        return false;
      default:
        startNewAttribute();
        reconsumeCurrent();
        state = State.AttributeName;
        return false;
    }
  }

  function stateAttributeName(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInTag);
        flushText();
        emitToken(eofToken());
        return true;

      case "\t":
      case "\n":
      case "\f":
      case " ":
      case "\r":
        finishAttribute();
        state = State.AfterAttributeName;
        return false;

      case "/":
        finishAttribute();
        state = State.SelfClosingStartTag;
        return false;

      case "=":
        state = State.BeforeAttributeValue;
        return false;

      case ">":
        finishAttribute();
        if (!emitCurrentTag()) state = State.Data;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        currentAttrName.push("\uFFFD");
        return false;
      default:
        currentAttrName.push(asciiLower(c));
        return false;
    }
  }

  function stateAfterAttributeName(): boolean {
    switch (getChar()) {
      case null:
        emitError(ErrorCode.EofInTag);
        flushText();
        emitToken(eofToken());
        return true;

      case "\t":
      case "\n":
      case "\f":
      case " ":
      case "\r":
        return false;

      case "/":
        state = State.SelfClosingStartTag;
        return false;

      case "=":
        state = State.BeforeAttributeValue;
        return false;

      case ">":
        if (!emitCurrentTag()) state = State.Data;
        return false;
      default:
        startNewAttribute();
        reconsumeCurrent();
        state = State.AttributeName;
        return false;
    }
  }

  function stateBeforeAttributeValue(): boolean {
    switch (getChar()) {
      case null:
        emitError(ErrorCode.EofInTag);
        flushText();
        emitToken(eofToken());
        return true;

      case "\t":
      case "\n":
      case "\f":
      case " ":
      case "\r":
        return false;

      case '"':
        state = State.AttributeValueDouble;
        return false;

      case "'":
        state = State.AttributeValueSingle;
        return false;

      case ">":
        emitError(ErrorCode.MissingAttributeValue);
        finishAttribute();
        if (!emitCurrentTag()) state = State.Data;
        return false;
      default:
        reconsumeCurrent();
        state = State.AttributeValueUnquoted;
        return false;
    }
  }

  function stateAttributeValueDouble(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInTag);
        flushText();
        emitToken(eofToken());
        return true;

      case '"':
        finishAttribute();
        state = State.AfterAttributeValueQuoted;
        return false;

      case "&":
        currentAttrValueHasAmp = true;
        currentAttrValue.push(c);
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        currentAttrValue.push("\uFFFD");
        return false;
      default:
        currentAttrValue.push(c);
        return false;
    }
  }

  function stateAttributeValueSingle(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInTag);
        flushText();
        emitToken(eofToken());
        return true;

      case "'":
        finishAttribute();
        state = State.AfterAttributeValueQuoted;
        return false;

      case "&":
        currentAttrValueHasAmp = true;
        currentAttrValue.push(c);
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        currentAttrValue.push("\uFFFD");
        return false;
      default:
        currentAttrValue.push(c);
        return false;
    }
  }

  function stateAttributeValueUnquoted(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInTag);
        flushText();
        emitToken(eofToken());
        return true;

      case "\t":
      case "\n":
      case "\f":
      case " ":
      case "\r":
        finishAttribute();
        state = State.BeforeAttributeName;
        return false;

      case "&":
        currentAttrValueHasAmp = true;
        currentAttrValue.push(c);
        return false;

      case ">":
        finishAttribute();
        if (!emitCurrentTag()) state = State.Data;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        currentAttrValue.push("\uFFFD");
        return false;
      default:
        currentAttrValue.push(c);
        return false;
    }
  }

  function stateAfterAttributeValueQuoted(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInTag);
        flushText();
        emitToken(eofToken());
        return true;

      case "\t":
      case "\n":
      case "\f":
      case " ":
      case "\r":
        state = State.BeforeAttributeName;
        return false;

      case "/":
        state = State.SelfClosingStartTag;
        return false;

      case ">":
        if (!emitCurrentTag()) {
          state = State.Data;
        }
        return false;

      default:
        emitError(ErrorCode.MissingWhitespaceBetweenAttributes);
        reconsumeCurrent();
        state = State.BeforeAttributeName;
        return false;
    }
  }

  function stateSelfClosingStartTag(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInTag);
        flushText();
        emitToken(eofToken());
        return true;

      case ">":
        currentTagSelfClosing = true;
        if (!emitCurrentTag()) state = State.Data;
        return false;

      default:
        emitError(ErrorCode.UnexpectedCharacterAfterSolidusInTag);
        reconsumeCurrent();
        state = State.BeforeAttributeName;
        return false;
    }
  }

  function stateMarkupDeclarationOpen(): boolean {
    if (consumeIf("--")) {
      currentComment = [];
      state = State.CommentStart;
      return false;
    }

    if (consumeCaseInsensitive("DOCTYPE")) {
      currentDoctypeName = [];
      currentDoctypePublic = undefined;
      currentDoctypeSystem = undefined;
      currentDoctypeForceQuirks = false;
      state = State.Doctype;
      return false;
    }

    if (consumeIf("[CDATA[")) {
      // CDATA sections are only valid in foreign content (SVG/MathML).
      // Tokenizer consults the current treebuilder stack to decide.
      const stack = sink.openElements;
      if (Array.isArray(stack) && stack.length) {
        const current = stack.at(-1)!;
        const ns = current.namespace ?? null;
        if (ns && ns !== "html") {
          state = State.CDATASection;
          return false;
        }
      }

      // Treat as bogus comment in HTML context, preserving "[CDATA[" prefix.
      emitError(ErrorCode.CdataInHtmlContent);
      currentComment = ["[CDATA["];
      state = State.BogusComment;
      return false;
    }

    emitError(ErrorCode.IncorrectlyOpenedComment);
    currentComment = [];
    state = State.BogusComment;
    return false;
  }

  function stateCommentStart(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInComment);
        emitComment();
        emitToken(eofToken());
        return true;

      case "-":
        state = State.CommentStartDash;
        return false;

      case ">":
        emitError(ErrorCode.AbruptClosingOfEmptyComment);
        emitComment();
        state = State.Data;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        currentComment.push(replacement);
        break;

      default:
        currentComment.push(c);
        break;
    }
    state = State.Comment;
    return false;
  }

  function stateCommentStartDash(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInComment);
        emitComment();
        emitToken(eofToken());
        return true;

      case "-":
        state = State.CommentEnd;
        return false;

      case ">":
        emitError(ErrorCode.AbruptClosingOfEmptyComment);
        emitComment();
        state = State.Data;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        currentComment.push("-", replacement);
        break;

      default:
        currentComment.push("-", c);
        break;
    }
    state = State.Comment;
    return false;
  }

  function stateComment(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInComment);
        emitComment();
        emitToken(eofToken());
        return true;

      case "-":
        state = State.CommentEndDash;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        currentComment.push(replacement);
        return false;

      default:
        currentComment.push(c);
        return false;
    }
  }

  function stateCommentEndDash(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInComment);
        emitComment();
        emitToken(eofToken());
        return true;

      case "-":
        state = State.CommentEnd;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        currentComment.push("-", replacement);
        state = State.Comment;
        return false;

      default:
        currentComment.push("-", c);
        state = State.Comment;
        return false;
    }
  }

  function stateCommentEnd(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInComment);
        emitComment();
        emitToken(eofToken());
        return true;

      case ">":
        emitComment();
        state = State.Data;
        return false;

      case "!":
        state = State.CommentEndBang;
        return false;

      case "-":
        currentComment.push("-");
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        currentComment.push("-", "-", replacement);
        state = State.Comment;
        return false;

      default:
        emitError(ErrorCode.IncorrectlyClosedComment);
        currentComment.push("-", "-", c);
        state = State.Comment;
        return false;
    }
  }

  function stateCommentEndBang(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitError(ErrorCode.EofInComment);
        emitComment();
        emitToken(eofToken());
        return true;

      case "-":
        currentComment.push("-", "-", "!");
        state = State.CommentEndDash;
        return false;

      case ">":
        emitError(ErrorCode.IncorrectlyClosedComment);
        emitComment();
        state = State.Data;

        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        currentComment.push("-", "-", "!", replacement);
        state = State.Comment;
        return false;

      default:
        currentComment.push("-", "-", "!", c);
        state = State.Comment;
        return false;
    }
  }

  function stateBogusComment(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        emitComment();
        emitToken(eofToken());
        return true;

      case ">":
        emitComment();
        state = State.Data;
        return false;

      case "\0":
        currentComment.push(replacement);
        return false;

      default:
        currentComment.push(c);
        return false;
    }
  }

  function stateDoctype(): boolean {
    switch (getChar()) {
      case null:
        emitError(ErrorCode.EofInDoctype);
        currentDoctypeForceQuirks = true;
        emitDoctype();
        emitToken(eofToken());
        return true;

      case "\t":
      case "\n":
      case "\f":
      case " ":
        state = State.BeforeDoctypeName;
        return false;

      case ">":
        emitError(ErrorCode.ExpectedDoctypeNameButGotRightBracket);
        currentDoctypeForceQuirks = true;
        emitDoctype();
        state = State.Data;
        return false;

      default:
        emitError(ErrorCode.MissingWhitespaceBeforeDoctypeName);
        reconsumeCurrent();
        state = State.BeforeDoctypeName;
        return false;
    }
  }

  function stateBeforeDoctypeName(): boolean {
    // Skip whitespace
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitError(ErrorCode.EofInDoctypeName);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "\t":
        case "\n":
        case "\f":
        case " ":
          continue;

        case ">":
          emitError(ErrorCode.ExpectedDoctypeNameButGotRightBracket);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          state = State.Data;
          return false;

        case "\0":
          emitError(ErrorCode.UnexpectedNullCharacter);
          currentDoctypeName.push("\uFFFD");
          state = State.DoctypeName;
          return false;

        default:
          if (c >= "A" && c <= "Z") {
            currentDoctypeName.push(String.fromCharCode(c.charCodeAt(0) + 32));
          } else {
            currentDoctypeName.push(c);
          }
          state = State.DoctypeName;
          return false;
      }
    }
  }

  function stateDoctypeName(): boolean {
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitError(ErrorCode.EofInDoctypeName);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "\t":
        case "\n":
        case "\f":
        case " ":
          state = State.AfterDoctypeName;
          return false;

        case ">":
          emitDoctype();
          state = State.Data;
          return false;

        case "\0":
          emitError(ErrorCode.UnexpectedNullCharacter);
          currentDoctypeName.push("\uFFFD");
          continue;

        default:
          if (c >= "A" && c <= "Z") {
            currentDoctypeName.push(String.fromCharCode(c.charCodeAt(0) + 32));
          } else {
            currentDoctypeName.push(c);
          }
      }
    }
  }

  function stateAfterDoctypeName(): boolean {
    if (consumeCaseInsensitive("PUBLIC")) {
      state = State.AfterDoctypePublicKeyword;
      return false;
    }
    if (consumeCaseInsensitive("SYSTEM")) {
      state = State.AfterDoctypeSystemKeyword;
      return false;
    }

    while (true) {
      switch (getChar()) {
        case null:
          emitError(ErrorCode.EofInDoctype);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "\t":
        case "\n":
        case "\f":
        case " ":
          continue;

        case ">":
          emitDoctype();
          state = State.Data;
          return false;

        default:
          emitError(ErrorCode.MissingWhitespaceAfterDoctypeName);
          currentDoctypeForceQuirks = true;
          reconsumeCurrent();
          state = State.BogusDoctype;
          return false;
      }
    }
  }

  function stateAfterDoctypePublicKeyword(): boolean {
    while (true) {
      switch (getChar()) {
        case null:
          emitError(ErrorCode.MissingQuoteBeforeDoctypePublicIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "\t":
        case "\n":
        case "\f":
        case " ":
          state = State.BeforeDoctypePublicIdentifier;
          return false;

        case '"':
          emitError(ErrorCode.MissingWhitespaceBeforeDoctypePublicIdentifier);
          currentDoctypePublic = [];
          state = State.DoctypePublicIdentifierDoubleQuoted;
          return false;

        case "'":
          emitError(ErrorCode.MissingWhitespaceBeforeDoctypePublicIdentifier);
          currentDoctypePublic = [];
          state = State.DoctypePublicIdentifierSingleQuoted;
          return false;

        case ">":
          emitError(ErrorCode.MissingDoctypePublicIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          state = State.Data;
          return false;

        default:
          emitError(ErrorCode.UnexpectedCharacterAfterDoctypePublicKeyword);
          currentDoctypeForceQuirks = true;
          reconsumeCurrent();
          state = State.BogusDoctype;
          return false;
      }
    }
  }

  function stateAfterDoctypeSystemKeyword(): boolean {
    while (true) {
      switch (getChar()) {
        case null:
          emitError(ErrorCode.MissingQuoteBeforeDoctypeSystemIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "\t":
        case "\n":
        case "\f":
        case " ":
          state = State.BeforeDoctypeSystemIdentifier;
          return false;

        case '"':
          emitError(ErrorCode.MissingWhitespaceAfterDoctypePublicIdentifier);
          currentDoctypeSystem = [];
          state = State.DoctypeSystemIdentifierDoubleQuoted;
          return false;

        case "'":
          emitError(ErrorCode.MissingWhitespaceAfterDoctypePublicIdentifier);
          currentDoctypeSystem = [];
          state = State.DoctypeSystemIdentifierSingleQuoted;
          return false;

        case ">":
          emitError(ErrorCode.MissingDoctypeSystemIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          state = State.Data;
          return false;

        default:
          emitError(ErrorCode.UnexpectedCharacterAfterDoctypeSystemKeyword);
          currentDoctypeForceQuirks = true;
          reconsumeCurrent();
          state = State.BogusDoctype;
          return false;
      }
    }
  }

  function stateBeforeDoctypePublicIdentifier(): boolean {
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitError(ErrorCode.MissingDoctypePublicIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "\t":
        case "\n":
        case "\f":
        case " ":
          continue;

        case '"':
          currentDoctypePublic = [];
          state = State.DoctypePublicIdentifierDoubleQuoted;
          return false;

        case "'":
          currentDoctypePublic = [];
          state = State.DoctypePublicIdentifierSingleQuoted;
          return false;

        case ">":
          emitError(ErrorCode.MissingDoctypePublicIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          state = State.Data;
          return false;
      }

      emitError(ErrorCode.MissingQuoteBeforeDoctypePublicIdentifier);
      currentDoctypeForceQuirks = true;
      reconsumeCurrent();
      state = State.BogusDoctype;
      return false;
    }
  }

  function stateDoctypePublicIdentifierDoubleQuoted(): boolean {
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitError(ErrorCode.EofInDoctypePublicIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case '"':
          state = State.AfterDoctypePublicIdentifier;
          return false;

        case "\0":
          emitError(ErrorCode.UnexpectedNullCharacter);
          currentDoctypePublic!.push("\uFFFD");
          continue;

        case ">":
          emitError(ErrorCode.AbruptDoctypePublicIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          state = State.Data;
          return false;
      }
      currentDoctypePublic!.push(c);
    }
  }

  function stateDoctypePublicIdentifierSingleQuoted(): boolean {
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitError(ErrorCode.EofInDoctypePublicIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "'":
          state = State.AfterDoctypePublicIdentifier;
          return false;

        case "\0":
          emitError(ErrorCode.UnexpectedNullCharacter);
          currentDoctypePublic!.push("\uFFFD");
          continue;

        case ">":
          emitError(ErrorCode.AbruptDoctypePublicIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          state = State.Data;
          return false;

        default:
          currentDoctypePublic!.push(c);
      }
    }
  }

  function stateAfterDoctypePublicIdentifier(): boolean {
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitError(ErrorCode.MissingWhitespaceBetweenDoctypePublicAndSystemIdentifiers);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "\t":
        case "\n":
        case "\f":
        case " ":
          state = State.BetweenDoctypePublicAndSystemIdentifiers;
          return false;

        case ">":
          emitDoctype();
          state = State.Data;
          return false;

        case '"':
          emitError(ErrorCode.MissingWhitespaceBetweenDoctypePublicAndSystemIdentifiers);
          currentDoctypeSystem = [];
          state = State.DoctypeSystemIdentifierDoubleQuoted;
          return false;

        case "'":
          emitError(ErrorCode.MissingWhitespaceBetweenDoctypePublicAndSystemIdentifiers);
          currentDoctypeSystem = [];
          state = State.DoctypeSystemIdentifierSingleQuoted;
          return false;

        default:
          emitError(ErrorCode.UnexpectedCharacterAfterDoctypePublicIdentifier);
          currentDoctypeForceQuirks = true;
          reconsumeCurrent();
          state = State.BogusDoctype;
          return false;
      }
    }
  }

  function stateBetweenDoctypePublicAndSystemIdentifiers(): boolean {
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitError(ErrorCode.MissingQuoteBeforeDoctypeSystemIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "\t":
        case "\n":
        case "\f":
        case " ":
          continue;

        case ">":
          emitDoctype();
          state = State.Data;
          return false;

        case '"':
          currentDoctypeSystem = [];
          state = State.DoctypeSystemIdentifierDoubleQuoted;
          return false;

        case "'":
          currentDoctypeSystem = [];
          state = State.DoctypeSystemIdentifierSingleQuoted;
          return false;

        default:
          emitError(ErrorCode.MissingQuoteBeforeDoctypeSystemIdentifier);
          currentDoctypeForceQuirks = true;
          reconsumeCurrent();
          state = State.BogusDoctype;
          return false;
      }
    }
  }

  function stateBeforeDoctypeSystemIdentifier(): boolean {
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitError(ErrorCode.MissingDoctypeSystemIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "\t":
        case "\n":
        case "\f":
        case " ":
          continue;

        case '"':
          currentDoctypeSystem = [];
          state = State.DoctypeSystemIdentifierDoubleQuoted;
          return false;

        case "'":
          currentDoctypeSystem = [];
          state = State.DoctypeSystemIdentifierSingleQuoted;
          return false;

        case ">":
          emitError(ErrorCode.MissingDoctypeSystemIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          state = State.Data;
          return false;

        default:
          emitError(ErrorCode.MissingQuoteBeforeDoctypeSystemIdentifier);
          currentDoctypeForceQuirks = true;
          reconsumeCurrent();
          state = State.BogusDoctype;
          return false;
      }
    }
  }

  function stateDoctypeSystemIdentifierDoubleQuoted(): boolean {
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitError(ErrorCode.EofInDoctypeSystemIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case '"':
          state = State.AfterDoctypeSystemIdentifier;
          return false;

        case "\0":
          emitError(ErrorCode.UnexpectedNullCharacter);
          currentDoctypeSystem!.push("\uFFFD");
          continue;

        case ">":
          emitError(ErrorCode.AbruptDoctypeSystemIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          state = State.Data;
          return false;

        default:
          currentDoctypeSystem!.push(c);
      }
    }
  }

  function stateDoctypeSystemIdentifierSingleQuoted(): boolean {
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitError(ErrorCode.EofInDoctypeSystemIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "'":
          state = State.AfterDoctypeSystemIdentifier;
          return false;

        case "\0":
          emitError(ErrorCode.UnexpectedNullCharacter);
          currentDoctypeSystem!.push("\uFFFD");
          continue;

        case ">":
          emitError(ErrorCode.AbruptDoctypeSystemIdentifier);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          state = State.Data;
          return false;

        default:
          currentDoctypeSystem!.push(c);
      }
    }
  }

  function stateAfterDoctypeSystemIdentifier(): boolean {
    while (true) {
      switch (getChar()) {
        case null:
          emitError(ErrorCode.EofInDoctype);
          currentDoctypeForceQuirks = true;
          emitDoctype();
          emitToken(eofToken());
          return true;

        case "\t":
        case "\n":
        case "\f":
        case " ":
          continue;

        case ">":
          emitDoctype();
          state = State.Data;
          return false;

        default:
          emitError(ErrorCode.UnexpectedCharacterAfterDoctypeSystemIdentifier);
          reconsumeCurrent();
          state = State.BogusDoctype;
          return false;
      }
    }
  }

  function stateBogusDoctype(): boolean {
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitDoctype();
          emitToken(eofToken());
          return true;

        case ">":
          emitDoctype();
          state = State.Data;
          return false;
      }
    }
  }

  function stateCdataSection(): boolean {
    // Consume characters until we see ']'.
    while (true) {
      const c = getChar();
      switch (c) {
        case null:
          emitError(ErrorCode.EofInCdata);
          flushText();
          emitToken(eofToken());
          return true;

        case "]":
          state = State.CDATASectionBracket;
          return false;

        default:
          appendText(c);
      }
    }
  }

  function stateCdataSectionBracket(): boolean {
    const c = getChar();
    switch (c) {
      case "]":
        state = State.CDATASectionEnd;
        return false;

      case null:
        appendText("]");
        emitError(ErrorCode.EofInCdata);
        flushText();
        emitToken(eofToken());
        return true;

      default:
        appendText("]");
        reconsumeCurrent();
        state = State.CDATASection;
        return false;
    }
  }

  function stateCdataSectionEnd(): boolean {
    const c = getChar();
    switch (c) {
      case ">":
        flushText();
        state = State.Data;
        return false;

      case null:
        appendText("]");
        appendText("]");
        emitError(ErrorCode.EofInCdata);
        flushText();
        emitToken(eofToken());
        return true;

      case "]":
        appendText("]");
        return false;

      default:
        appendText("]");
        appendText("]");
        reconsumeCurrent();
        state = State.CDATASection;
        return false;
    }
  }

  function stateRcdata(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        flushText();
        emitToken(eofToken());
        return true;

      case "<":
        state = State.RCDATALessThanSign;
        return false;

      case "&":
        appendText("&");
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        appendText("\uFFFD");
        return false;
      default:
        appendText(c);
        return false;
    }
  }

  function stateRcdataLessThanSign(): boolean {
    const c = getChar();
    switch (c) {
      case "/":
        currentTagName = [];
        originalTagName = [];
        state = State.RCDATAEndTagOpen;
        return false;
      default:
        appendText("<");
        reconsumeCurrent();
        state = State.RCDATA;
        return false;
    }
  }

  function stateRcdataEndTagOpen(): boolean {
    const c = getChar();
    if (c != null && isAsciiAlpha(c)) {
      currentTagName.push(asciiLower(c));
      originalTagName.push(c);
      state = State.RCDATAEndTagName;
      return false;
    }
    textBuffer.push("<", "/");
    reconsumeCurrent();
    state = State.RCDATA;
    return false;
  }

  function stateRcdataEndTagName(): boolean {
    while (true) {
      const c = getChar();
      if (c != null && isAsciiAlpha(c)) {
        currentTagName.push(asciiLower(c));
        originalTagName.push(c);
        continue;
      }

      const tagName = currentTagName.join("");
      if (tagName === rawTextTagName) {
        if (c === ">") {
          flushText();
          emitToken(createTagToken(TagKind.End, tagName, new Map(), false));
          state = State.Data;
          rawTextTagName = undefined;
          currentTagName = [];
          originalTagName = [];
          return false;
        }
        if (isWhitespace(c)) {
          flushText();
          currentTagKind = TagKind.End;
          currentTagAttrs.clear();
          state = State.BeforeAttributeName;
          return false;
        }
        if (c === "/") {
          flushText();
          currentTagKind = TagKind.End;
          currentTagAttrs.clear();
          state = State.SelfClosingStartTag;
          return false;
        }
      }

      if (c == null) {
        textBuffer.push("<", "/");
        for (const ch of originalTagName) appendText(ch);
        currentTagName = [];
        originalTagName = [];
        flushText();
        emitToken(eofToken());
        return true;
      }

      textBuffer.push("<", "/");
      for (const ch of originalTagName) appendText(ch);
      currentTagName = [];
      originalTagName = [];
      reconsumeCurrent();
      state = State.RCDATA;
      return false;
    }
  }

  function stateRawText(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        flushText();
        emitToken(eofToken());
        return true;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        appendText("\uFFFD");
        return false;

      case "<":
        if (rawTextTagName === "script") {
          const next1 = peekChar(0);
          const next2 = peekChar(1);
          const next3 = peekChar(2);
          if (next1 === "!" && next2 === "-" && next3 === "-") {
            textBuffer.push("<", "!", "-", "-");
            getChar();
            getChar();
            getChar();
            state = State.ScriptDataEscaped;
            return false;
          }
        }
        state = State.RawTextLessThanSign;
        return false;
      default:
        appendText(c);
        return false;
    }
  }

  function stateRawTextLessThanSign(): boolean {
    const c = getChar();
    switch (c) {
      case "/":
        currentTagName = [];
        originalTagName = [];
        state = State.RawTextEndTagOpen;
        return false;
      default:
        appendText("<");
        reconsumeCurrent();
        state = State.RawText;
        return false;
    }
  }

  function stateRawTextEndTagOpen(): boolean {
    const c = getChar();
    if (c != null && isAsciiAlpha(c)) {
      currentTagName.push(asciiLower(c));
      originalTagName.push(c);
      state = State.RawTextEndTagName;
      return false;
    }
    textBuffer.push("<", "/");
    reconsumeCurrent();
    state = State.RawText;
    return false;
  }

  function stateRawTextEndTagName(): boolean {
    while (true) {
      const c = getChar();
      if (c != null && isAsciiAlpha(c)) {
        currentTagName.push(asciiLower(c));
        originalTagName.push(c);
        continue;
      }

      const tagName = currentTagName.join("");
      if (tagName === rawTextTagName) {
        if (c === ">") {
          flushText();
          emitToken(createTagToken(TagKind.End, tagName, new Map(), false));
          state = State.Data;
          rawTextTagName = undefined;
          currentTagName = [];
          originalTagName = [];
          return false;
        }
        if (isWhitespace(c)) {
          flushText();
          currentTagKind = TagKind.End;
          currentTagAttrs.clear();
          state = State.BeforeAttributeName;
          return false;
        }
        if (c === "/") {
          flushText();
          currentTagKind = TagKind.End;
          currentTagAttrs.clear();
          state = State.SelfClosingStartTag;
          return false;
        }
      }

      if (c == null) {
        textBuffer.push("<", "/");
        for (const ch of originalTagName) appendText(ch);
        currentTagName = [];
        originalTagName = [];
        flushText();
        emitToken(eofToken());
        return true;
      }

      textBuffer.push("<", "/");
      for (const ch of originalTagName) appendText(ch);
      currentTagName = [];
      originalTagName = [];
      reconsumeCurrent();
      state = State.RawText;
      return false;
    }
  }

  function stateScriptDataEscaped(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        flushText();
        emitToken(eofToken());
        return true;

      case "-":
        appendText("-");
        state = State.ScriptDataEscapedDash;
        return false;

      case "<":
        state = State.ScriptDataEscapedLessThanSign;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        appendText("\uFFFD");
        return false;
      default:
        appendText(c);
        return false;
    }
  }

  function stateScriptDataEscapedDash(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        flushText();
        emitToken(eofToken());
        return true;

      case "-":
        appendText("-");
        state = State.ScriptDataEscapedDashDash;
        return false;

      case "<":
        state = State.ScriptDataEscapedLessThanSign;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        appendText("\uFFFD");
        state = State.ScriptDataEscaped;
        return false;
      default:
        appendText(c);
        state = State.ScriptDataEscaped;
        return false;
    }
  }

  function stateScriptDataEscapedDashDash(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        flushText();
        emitToken(eofToken());
        return true;

      case "-":
        appendText("-");
        return false;

      case "<":
        appendText("<");
        state = State.ScriptDataEscapedLessThanSign;
        return false;

      case ">":
        appendText(">");
        state = State.RawText;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        appendText("\uFFFD");
        state = State.ScriptDataEscaped;
        return false;
      default:
        appendText(c);
        state = State.ScriptDataEscaped;
        return false;
    }
  }

  function stateScriptDataEscapedLessThanSign(): boolean {
    const c = getChar();
    if (c === "/") {
      tempBuffer = [];
      state = State.ScriptDataEscapedEndTagOpen;
      return false;
    }
    if (c != null && isAsciiAlpha(c)) {
      tempBuffer = [];
      appendText("<");
      reconsumeCurrent();
      state = State.ScriptDataDoubleEscapeStart;
      return false;
    }
    appendText("<");
    reconsumeCurrent();
    state = State.ScriptDataEscaped;
    return false;
  }

  function stateScriptDataEscapedEndTagOpen(): boolean {
    const c = getChar();
    if (c != null && isAsciiAlpha(c)) {
      currentTagName = [];
      originalTagName = [];
      reconsumeCurrent();
      state = State.ScriptDataEscapedEndTagName;
      return false;
    }
    textBuffer.push("<", "/");
    reconsumeCurrent();
    state = State.ScriptDataEscaped;
    return false;
  }

  function stateScriptDataEscapedEndTagName(): boolean {
    const c = getChar();
    if (c != null && isAsciiAlpha(c)) {
      currentTagName.push(asciiLower(c));
      originalTagName.push(c);
      tempBuffer.push(c);
      return false;
    }

    const tagName = currentTagName.join("");
    const isAppropriate = tagName === rawTextTagName;

    if (isAppropriate) {
      if (isWhitespace(c)) {
        flushText();
        currentTagKind = TagKind.End;
        currentTagAttrs.clear();
        state = State.BeforeAttributeName;
        return false;
      }
      if (c === "/") {
        flushText();
        currentTagKind = TagKind.End;
        currentTagAttrs.clear();
        state = State.SelfClosingStartTag;
        return false;
      }
      if (c === ">") {
        flushText();
        emitToken(createTagToken(TagKind.End, tagName, new Map(), false));
        state = State.Data;
        rawTextTagName = undefined;
        currentTagName = [];
        originalTagName = [];
        tempBuffer = [];
        return false;
      }
    }

    textBuffer.push("<", "/");
    for (const ch of tempBuffer) appendText(ch);
    currentTagName = [];
    originalTagName = [];
    tempBuffer = [];
    reconsumeCurrent();
    state = State.ScriptDataEscaped;
    return false;
  }

  function stateScriptDataDoubleEscapeStart(): boolean {
    const c = getChar();
    if (
      c === " " ||
      c === "\t" ||
      c === "\n" ||
      c === "\r" ||
      c === "\f" ||
      c === "/" ||
      c === ">"
    ) {
      const temp = tempBuffer.join("").toLowerCase();
      state = temp === "script" ? State.ScriptDataDoubleEscaped : State.ScriptDataEscaped;
      appendText(c);
      return false;
    }
    if (c != null && isAsciiAlpha(c)) {
      tempBuffer.push(c);
      appendText(c);
      return false;
    }
    reconsumeCurrent();
    state = State.ScriptDataEscaped;
    return false;
  }

  function stateScriptDataDoubleEscaped(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        flushText();
        emitToken(eofToken());
        return true;

      case "-":
        appendText("-");
        state = State.ScriptDataDoubleEscapedDash;
        return false;

      case "<":
        appendText("<");
        state = State.ScriptDataDoubleEscapedLessThanSign;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        appendText("\uFFFD");
        return false;
      default:
        appendText(c);
        return false;
    }
  }

  function stateScriptDataDoubleEscapedDash(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        flushText();
        emitToken(eofToken());
        return true;

      case "-":
        appendText("-");
        state = State.ScriptDataDoubleEscapedDashDash;
        return false;

      case "<":
        appendText("<");
        state = State.ScriptDataDoubleEscapedLessThanSign;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        appendText("\uFFFD");
        state = State.ScriptDataDoubleEscaped;
        return false;
      default:
        appendText(c);
        state = State.ScriptDataDoubleEscaped;
        return false;
    }
  }

  function stateScriptDataDoubleEscapedDashDash(): boolean {
    const c = getChar();
    switch (c) {
      case null:
        flushText();
        emitToken(eofToken());
        return true;

      case "-":
        appendText("-");
        return false;

      case "<":
        appendText("<");
        state = State.ScriptDataDoubleEscapedLessThanSign;
        return false;

      case ">":
        appendText(">");
        state = State.RawText;
        return false;

      case "\0":
        emitError(ErrorCode.UnexpectedNullCharacter);
        appendText("\uFFFD");
        state = State.ScriptDataDoubleEscaped;
        return false;
      default:
        appendText(c);
        state = State.ScriptDataDoubleEscaped;
        return false;
    }
  }

  function stateScriptDataDoubleEscapedLessThanSign(): boolean {
    const c = getChar();
    if (c === "/") {
      tempBuffer = [];
      appendText("/");
      state = State.ScriptDataDoubleEscapeEnd;
      return false;
    }
    if (c != null && isAsciiAlpha(c)) {
      tempBuffer = [];
      reconsumeCurrent();
      state = State.ScriptDataDoubleEscapeStart;
      return false;
    }
    reconsumeCurrent();
    state = State.ScriptDataDoubleEscaped;
    return false;
  }

  function stateScriptDataDoubleEscapeEnd(): boolean {
    const c = getChar();
    if (
      c === " " ||
      c === "\t" ||
      c === "\n" ||
      c === "\r" ||
      c === "\f" ||
      c === "/" ||
      c === ">"
    ) {
      const temp = tempBuffer.join("").toLowerCase();
      state = temp === "script" ? State.ScriptDataEscaped : State.ScriptDataDoubleEscaped;
      appendText(c);
      return false;
    }
    if (c != null && isAsciiAlpha(c)) {
      tempBuffer.push(c);
      appendText(c);
      return false;
    }
    reconsumeCurrent();
    state = State.ScriptDataDoubleEscaped;
    return false;
  }

  return {
    initialize,
    step,
    run,
    setLastStartTagName(value: string | undefined) {
      lastStartTagName = value;
    },
    get errors() {
      return errors;
    },
  };
}
