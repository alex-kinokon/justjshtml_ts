/* eslint-disable unicorn/prefer-modern-dom-apis */
/* eslint-disable unicorn/prefer-dom-node-remove */
import {
  BUTTON_SCOPE_TERMINATORS,
  DEFAULT_SCOPE_TERMINATORS,
  DEFINITION_SCOPE_TERMINATORS,
  FOREIGN_ATTRIBUTE_ADJUSTMENTS,
  FOREIGN_BREAKOUT_ELEMENTS,
  FORMATTING_ELEMENTS,
  FORMAT_MARKER,
  HEADING_ELEMENTS,
  HTML_INTEGRATION_POINT_SET,
  IMPLIED_END_TAGS,
  LIST_ITEM_SCOPE_TERMINATORS,
  MATHML_ATTRIBUTE_ADJUSTMENTS,
  MATHML_TEXT_INTEGRATION_POINT_SET,
  SPECIAL_ELEMENTS,
  SVG_ATTRIBUTE_ADJUSTMENTS,
  SVG_TAG_NAME_ADJUSTMENTS,
  TABLE_ALLOWED_CHILDREN,
  TABLE_FOSTER_TARGETS,
  TABLE_SCOPE_TERMINATORS,
  integrationPointKey,
} from "./constants.ts";
import type { FragmentContext } from "./context.ts";
import { Node, type NodeAttrMap } from "./node.ts";
import { ParseError } from "./parser.ts";
import type { Tokenizer } from "./tokenizer.ts";
import {
  type CharacterToken,
  type CommentToken,
  type DoctypeToken,
  type EOFToken,
  TagKind,
  type TagToken,
  type Token,
  TokenKind,
  TokenSinkResult,
  createCharacterToken,
  createTagToken,
} from "./tokens.ts";
import {
  InsertionMode,
  QuirksMode,
  doctypeErrorAndQuirks,
  isAllWhitespace,
} from "./treebuilder_utils.ts";

type TreeToken = CharacterToken | CommentToken | DoctypeToken | EOFToken | TagToken;
type ReprocessInstruction = [
  typeof REPROCESS,
  insertionMode: InsertionMode,
  token: TreeToken,
  forceHtml?: boolean,
];
type ModeResult = ReprocessInstruction | undefined;

const REPROCESS = Symbol();

const reprocessInstruction = (
  insertionMode: InsertionMode,
  token: TreeToken,
  forceHtml = false
): ReprocessInstruction => [REPROCESS, insertionMode, token, forceHtml];

interface Formatting {
  readonly name: string;
  readonly attrs: NodeAttrMap;
  node: Node;
  readonly signature: string;
}

export type { ErrorCode as ParseErrorCode };

const enum ErrorCode {
  AdoptionAgency13,
  EndTagTooEarly,
  ExpectedClosingTagButGotEof,
  ExpectedDoctypeButGotChars,
  ExpectedDoctypeButGotEndTag,
  ExpectedDoctypeButGotEof,
  ExpectedDoctypeButGotStartTag,
  ExpectedNamedClosingTagButGotEof,
  FosterParentingCharacter,
  ImageStartTag,
  InvalidCodepoint,
  InvalidCodepointBeforeHead,
  InvalidCodepointInBody,
  InvalidCodepointInForeignContent,
  InvalidCodepointInSelect,
  InvalidCodepointInTableText,
  NonVoidHtmlElementStartTagWithTrailingSolidus,
  UnexpectedCellInTableBody,
  UnexpectedCharactersInColumnGroup,
  UnexpectedCharactersInTemplateColumnGroup,
  UnexpectedDoctype,
  UnexpectedEndTag,
  UnexpectedEndTagAfterHead,
  UnexpectedEndTagBeforeHead,
  UnexpectedEndTagBeforeHtml,
  UnexpectedEndTagImpliesTableVoodoo,
  UnexpectedEndTagInForeignContent,
  UnexpectedEndTagInFragmentContext,
  UnexpectedFormInTable,
  UnexpectedHiddenInputAfterHead,
  UnexpectedHiddenInputInTable,
  UnexpectedHtmlElementInForeignContent,
  UnexpectedNullCharacter,
  UnexpectedStartTag,
  UnexpectedStartTagIgnored,
  UnexpectedStartTagImpliesEndTag,
  UnexpectedStartTagImpliesTableVoodoo,
  UnexpectedStartTagInCellFragment,
  UnexpectedStartTagInColumnGroup,
  UnexpectedStartTagInTemplateColumnGroup,
  UnexpectedStartTagInTemplateTableContext,
  UnexpectedTokenAfterAfterBody,
  UnexpectedTokenAfterAfterFrameset,
  UnexpectedTokenAfterBody,
  UnexpectedTokenAfterFrameset,
  UnexpectedTokenInFrameset,
  UnknownDoctype,
}

const BEFORE_HEAD_IMPLIED_END_TAGS = new Set(["body", "br", "head", "html"]);
const FRAGMENT_TABLE_SECTION_TAGS = new Set(["tbody", "tfoot", "thead"]);
const FRAGMENT_CELL_TAGS = new Set(["td", "th"]);

export function isTemplateNode(
  node: Node | undefined
): node is Node & { templateContent: Node } {
  return !!node && node.name === "template" && !!node.templateContent;
}

// ---- Insertion mode handlers (incremental port) ---------------------------

/** Handles a doctype token and sets document quirks mode. */
function handleDoctype(state: TreeBuilder, token: DoctypeToken): TokenSinkResult {
  if (state.mode !== InsertionMode.INITIAL) {
    parseError(state, ErrorCode.UnexpectedDoctype);
    return TokenSinkResult.Continue;
  }

  const { doctype } = token;
  const { error, quirksMode } = doctypeErrorAndQuirks(doctype, state.iframeSrcdoc);

  const node = new Node("!doctype", doctype);
  state.document.appendChild(node);

  if (error) {
    parseError(state, ErrorCode.UnknownDoctype);
  }

  setQuirksMode(state, quirksMode);
  state.mode = InsertionMode.BEFORE_HTML;
  return TokenSinkResult.Continue;
}

/** `INITIAL` insertion mode. */
function modeInitial(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character:
      if (isAllWhitespace(token.data)) return;
      parseError(state, ErrorCode.ExpectedDoctypeButGotChars);
      setQuirksMode(state, QuirksMode.Quirks);
      return reprocessInstruction(InsertionMode.BEFORE_HTML, token);

    case TokenKind.Comment:
      appendCommentToDocument(state, token.data);
      return;

    case TokenKind.EOF:
      parseError(state, ErrorCode.ExpectedDoctypeButGotEof);
      setQuirksMode(state, QuirksMode.Quirks);
      state.mode = InsertionMode.BEFORE_HTML;
      return reprocessInstruction(InsertionMode.BEFORE_HTML, token);

    case TokenKind.Tag:
      parseError(
        state,
        token.kind === TagKind.Start
          ? ErrorCode.ExpectedDoctypeButGotStartTag
          : ErrorCode.ExpectedDoctypeButGotEndTag,
        token.name
      );
      break;
  }

  setQuirksMode(state, QuirksMode.Quirks);
  return reprocessInstruction(InsertionMode.BEFORE_HTML, token);
}

/** `BEFORE_HTML` insertion mode. */
function modeBeforeHtml(state: TreeBuilder, token: TreeToken): ModeResult {
  if (token.type === TokenKind.Character && isAllWhitespace(token.data)) {
    return;
  }

  switch (token.type) {
    case TokenKind.Comment:
      appendCommentToDocument(state, token.data);
      return;

    case TokenKind.Tag:
      if (token.kind === TagKind.Start && token.name === "html") {
        createRoot(state, token.attrs);
        state.mode = InsertionMode.BEFORE_HEAD;
        return;
      }

      if (token.kind === TagKind.End && BEFORE_HEAD_IMPLIED_END_TAGS.has(token.name)) {
        createRoot(state, new Map());
        state.mode = InsertionMode.BEFORE_HEAD;
        return reprocessInstruction(InsertionMode.BEFORE_HEAD, token);
      }
      if (token.kind === TagKind.End) {
        parseError(state, ErrorCode.UnexpectedEndTagBeforeHtml, token.name);
        return;
      }

      break;

    case TokenKind.EOF:
      createRoot(state, new Map());
      state.mode = InsertionMode.BEFORE_HEAD;
      return reprocessInstruction(InsertionMode.BEFORE_HEAD, token);

    case TokenKind.Character:
      const stripped = token.data.replace(/^[\t\n\f\r ]+/, "");
      if (stripped.length !== token.data.length) {
        token = {
          type: TokenKind.Character,
          data: stripped,
        };
      }

      break;
  }

  createRoot(state, new Map());
  state.mode = InsertionMode.BEFORE_HEAD;
  return reprocessInstruction(InsertionMode.BEFORE_HEAD, token);
}

/** `BEFORE_HEAD` insertion mode. */
function modeBeforeHead(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character: {
      let data = token.data;
      if (data.includes("\x00")) {
        parseError(state, ErrorCode.InvalidCodepointBeforeHead);
        data = data.replaceAll("\x00", "");
        if (!data) return;
      }
      if (isAllWhitespace(data)) return;
      token = { type: TokenKind.Character, data };
      break;
    }

    case TokenKind.Comment:
      appendComment(state, token.data);
      return;

    case TokenKind.Tag:
      if (token.kind === TagKind.Start) {
        if (token.name === "html") {
          const html = state.openElements[0];
          addMissingAttributes(html!, token.attrs);
          return;
        } else if (token.name === "head") {
          const head = insertElement(state, token, true);
          state.headElement = head;
          state.mode = InsertionMode.IN_HEAD;
          return;
        }
      } else {
        if (BEFORE_HEAD_IMPLIED_END_TAGS.has(token.name)) {
          state.headElement = insertPhantom(state, "head");
          state.mode = InsertionMode.IN_HEAD;
          return reprocessInstruction(InsertionMode.IN_HEAD, token);
        }

        parseError(state, ErrorCode.UnexpectedEndTagBeforeHead, token.name);
        return;
      }
      break;

    case TokenKind.EOF:
      state.headElement = insertPhantom(state, "head");
      state.mode = InsertionMode.IN_HEAD;
      return reprocessInstruction(InsertionMode.IN_HEAD, token);

    // No default
  }

  state.headElement = insertPhantom(state, "head");
  state.mode = InsertionMode.IN_HEAD;
  return reprocessInstruction(InsertionMode.IN_HEAD, token);
}

/** `IN_HEAD` insertion mode. */
function modeInHead(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character: {
      if (isAllWhitespace(token.data)) {
        appendText(state, token.data);
        return;
      }

      const { data } = token;
      let i = 0;
      while (i < data.length && "\t\n\f\r ".includes(data[i]!)) i += 1;
      const leadingWs = data.slice(0, i);
      const remaining = data.slice(i);
      if (leadingWs && state.openElements.at(-1)?.hasChildNodes()) {
        appendText(state, leadingWs);
      }
      popCurrent(state);
      state.mode = InsertionMode.AFTER_HEAD;
      return reprocessInstruction(InsertionMode.AFTER_HEAD, {
        type: TokenKind.Character,
        data: remaining,
      });
    }

    case TokenKind.Comment:
      appendComment(state, token.data);
      return;

    case TokenKind.Tag:
      if (token.kind === TagKind.Start) {
        switch (token.name) {
          case "html":
            popCurrent(state);
            state.mode = InsertionMode.AFTER_HEAD;
            return reprocessInstruction(InsertionMode.AFTER_HEAD, token);

          case "base":
          case "basefont":
          case "bgsound":
          case "link":
          case "meta":
            insertElement(state, token, false);
            return;

          case "template":
            insertElement(state, token, true);
            pushFormattingMarker(state);
            state.framesetOk = false;
            state.mode = InsertionMode.IN_TEMPLATE;
            state.templateModes.push(InsertionMode.IN_TEMPLATE);
            return;
        }
      }

      if (token.kind === TagKind.End && token.name === "template") {
        const hasTemplate = state.openElements.some(node => node.name === "template");
        if (!hasTemplate) return;
        generateImpliedEndTags(state, undefined);
        popUntilInclusive(state, "template");
        clearActiveFormattingUpToMarker(state);
        state.templateModes.pop();
        resetInsertionMode(state);
        return;
      }

      if (token.kind === TagKind.Start) {
        switch (token.name) {
          case "noframes":
          case "script":
          case "style":
          case "title":
            insertElement(state, token, true);
            state.originalMode = state.mode;
            state.mode = InsertionMode.TEXT;
            return;

          case "noscript":
            insertElement(state, token, true);
            state.mode = InsertionMode.IN_HEAD_NOSCRIPT;
            return;
        }
      } else {
        switch (token.name) {
          case "head":
            popCurrent(state);
            state.mode = InsertionMode.AFTER_HEAD;
            return;

          case "body":
          case "br":
          case "html":
            popCurrent(state);
            state.mode = InsertionMode.AFTER_HEAD;
            return reprocessInstruction(InsertionMode.AFTER_HEAD, token);
        }
      }
      break;

    case TokenKind.EOF:
      popCurrent(state);
      state.mode = InsertionMode.AFTER_HEAD;
      return reprocessInstruction(InsertionMode.AFTER_HEAD, token);
  }

  popCurrent(state);
  state.mode = InsertionMode.AFTER_HEAD;
  return reprocessInstruction(InsertionMode.AFTER_HEAD, token);
}

/** `IN_HEAD_NOSCRIPT` insertion mode. */
function modeInHeadNoscript(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character: {
      const { data } = token;
      if (isAllWhitespace(data)) return modeInHead(state, token);
      unexpectedStartTag(state, "text");
      popCurrent(state);
      state.mode = InsertionMode.IN_HEAD;
      return reprocessInstruction(InsertionMode.IN_HEAD, token);
    }
    case TokenKind.Comment:
      return modeInHead(state, token);

    case TokenKind.Tag:
      if (token.kind === TagKind.Start) {
        switch (token.name) {
          case "html":
            return modeInBody(state, token);

          case "basefont":
          case "bgsound":
          case "link":
          case "meta":
          case "noframes":
          case "style":
            return modeInHead(state, token);

          case "head":
          case "noscript":
            unexpectedStartTag(state, token.name);
            return;

          // No default
        }
        unexpectedStartTag(state, token.name);
        popCurrent(state);
        state.mode = InsertionMode.IN_HEAD;
        return reprocessInstruction(InsertionMode.IN_HEAD, token);
      } else if (token.name === "noscript") {
        popCurrent(state);
        state.mode = InsertionMode.IN_HEAD;
        return;
      } else if (token.name === "br") {
        unexpectedEndTag(state, token.name);
        popCurrent(state);
        state.mode = InsertionMode.IN_HEAD;
        return reprocessInstruction(InsertionMode.IN_HEAD, token);
      }
      unexpectedEndTag(state, token.name);
      return;

    case TokenKind.EOF:
      parseError(state, ErrorCode.ExpectedClosingTagButGotEof, "noscript");
      popCurrent(state);
      state.mode = InsertionMode.IN_HEAD;
      return reprocessInstruction(InsertionMode.IN_HEAD, token);
  }
  return;
}

/** `AFTER_HEAD` insertion mode. */
function modeAfterHead(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character: {
      let { data } = token;
      if (data.includes("\x00")) {
        parseError(state, ErrorCode.InvalidCodepointInBody);
        data = data.replaceAll("\x00", "");
      }
      if (data.includes("\x0C")) {
        parseError(state, ErrorCode.InvalidCodepointInBody);
        data = data.replaceAll("\x0C", "");
      }
      if (!data || isAllWhitespace(data)) {
        if (data) appendText(state, data);
        return;
      }
      insertBodyIfMissing(state);
      return reprocessInstruction(InsertionMode.IN_BODY, {
        type: TokenKind.Character,
        data,
      });
    }
    case TokenKind.Comment:
      appendComment(state, token.data);
      return;

    case TokenKind.Tag:
      if (token.kind === TagKind.Start) {
        switch (token.name) {
          case "html":
            insertBodyIfMissing(state);
            return reprocessInstruction(InsertionMode.IN_BODY, token);

          case "body":
            insertElement(state, token, true);
            state.mode = InsertionMode.IN_BODY;
            state.framesetOk = false;
            return;

          case "frameset":
            insertElement(state, token, true);
            state.mode = InsertionMode.IN_FRAMESET;
            return;

          case "input": {
            let inputType: string | undefined;
            for (const [name, value] of token.attrs) {
              if (name === "type") {
                inputType = value?.toLowerCase();
                break;
              }
            }
            if (inputType === "hidden") {
              parseError(state, ErrorCode.UnexpectedHiddenInputAfterHead);
              return;
            }
            insertBodyIfMissing(state);
            return reprocessInstruction(InsertionMode.IN_BODY, token);
          }

          case "base":
          case "basefont":
          case "bgsound":
          case "link":
          case "meta":
          case "noscript":
          case "script":
          case "style":
          case "title": {
            const head = state.headElement!;
            state.openElements.push(head);
            const result = modeInHead(state, token);
            const headIndex = state.openElements.indexOf(head);
            if (headIndex !== -1) state.openElements.splice(headIndex, 1);
            return result;
          }

          case "template":
            state.openElements.push(state.headElement!);
            state.mode = InsertionMode.IN_HEAD;
            return reprocessInstruction(InsertionMode.IN_HEAD, token);
        }
      } else {
        switch (token.name) {
          case "template":
            return modeInHead(state, token);

          case "body":
            insertBodyIfMissing(state);
            return reprocessInstruction(InsertionMode.IN_BODY, token);

          case "html":
          case "br":
            insertBodyIfMissing(state);
            return reprocessInstruction(InsertionMode.IN_BODY, token);

          default:
            parseError(state, ErrorCode.UnexpectedEndTagAfterHead, token.name);
            return;
        }
      }

      break;

    case TokenKind.EOF:
      insertBodyIfMissing(state);
      state.mode = InsertionMode.IN_BODY;
      return reprocessInstruction(InsertionMode.IN_BODY, token);
  }

  insertBodyIfMissing(state);
  return reprocessInstruction(InsertionMode.IN_BODY, token);
}

/** `TEXT` insertion mode for raw text / RCDATA elements. */
function modeText(state: TreeBuilder, token: TreeToken): ModeResult {
  if (token.type === TokenKind.Character) {
    appendText(state, token.data);
    return;
  }
  if (token.type === TokenKind.EOF) {
    const tagName = state.openElements.at(-1)?.name;
    parseError(state, ErrorCode.ExpectedNamedClosingTagButGotEof, tagName);
    popCurrent(state);
    state.mode = state.originalMode || InsertionMode.IN_BODY;
    return reprocessInstruction(state.mode, token);
  }
  popCurrent(state);
  state.mode = state.originalMode || InsertionMode.IN_BODY;
  return;
}

const EOF_ALLOWED_UNCLOSED = new Set([
  "dd",
  "dt",
  "li",
  "optgroup",
  "option",
  "p",
  "rb",
  "rp",
  "rt",
  "rtc",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "body",
  "html",
]);

const SET_LI = new Set(["li"]);
const SET_DD = new Set(["dd"]);
const SET_DT = new Set(["dt"]);
const SET_DD_DT = new Set(["dd", "dt"]);
const SET_RB_RP_RT_RTC = new Set(["rb", "rp", "rt", "rtc"]);

function handleCharactersInBody(state: TreeBuilder, token: CharacterToken): ModeResult {
  let data = token.data;
  if (data.includes("\x00")) {
    invalidCodepoint(state);
    data = data.replaceAll("\x00", "");
  }
  if (isAllWhitespace(data)) {
    reconstructActiveFormattingElements(state);
    appendText(state, data);
    return;
  }
  reconstructActiveFormattingElements(state);
  state.framesetOk = false;
  appendText(state, data);
  return;
}

function handleCommentInBody(state: TreeBuilder, token: CommentToken): ModeResult {
  appendComment(state, token.data);
  return;
}

function handleBodyStartHtml(state: TreeBuilder, token: TagToken): ModeResult {
  if (state.templateModes.length) {
    unexpectedStartTag(state, token.name);
    return;
  }
  if (state.openElements.length) {
    addMissingAttributes(state.openElements[0]!, token.attrs);
  }
  return;
}

function handleBodyStartBody(state: TreeBuilder, token: TagToken): ModeResult {
  if (state.templateModes.length) {
    unexpectedStartTag(state, token.name);
    return;
  }
  if (state.openElements.length > 1) {
    unexpectedStartTag(state, token.name);
    const body = state.openElements[1];
    if (body?.name === "body") addMissingAttributes(body, token.attrs);
    state.framesetOk = false;
    return;
  }
  state.framesetOk = false;
  return;
}

function handleBodyStartHead(state: TreeBuilder, token: TagToken): ModeResult {
  unexpectedStartTag(state, token.name);
  return;
}

function handleBodyStartInHead(state: TreeBuilder, token: TreeToken): ModeResult {
  return modeInHead(state, token);
}

function handleBodyStartBlockWithP(state: TreeBuilder, token: TagToken): ModeResult {
  closePElement(state);
  insertElement(state, token, true);
  return;
}

function handleBodyStartHeading(state: TreeBuilder, token: TagToken): ModeResult {
  closePElement(state);
  if (
    state.openElements.length &&
    HEADING_ELEMENTS.has(state.openElements.at(-1)!.name)
  ) {
    unexpectedStartTag(state, token.name);
    popCurrent(state);
  }
  insertElement(state, token, true);
  state.framesetOk = false;
  return;
}

function handleBodyStartPreListing(state: TreeBuilder, token: TagToken): ModeResult {
  closePElement(state);
  insertElement(state, token, true);
  state.ignoreLF = true;
  state.framesetOk = false;
  return;
}

function handleBodyStartForm(state: TreeBuilder, token: TagToken): ModeResult {
  if (state.formElement != null) {
    unexpectedStartTag(state, token.name);
    return;
  }
  closePElement(state);
  const node = insertElement(state, token, true);
  state.formElement = node;
  state.framesetOk = false;
  return;
}

function handleBodyStartButton(state: TreeBuilder, token: TagToken): ModeResult {
  if (hasInScope(state, "button")) {
    parseError(state, ErrorCode.UnexpectedStartTagImpliesEndTag, token.name);
    closeElementByName(state, "button");
  }
  insertElement(state, token, true);
  state.framesetOk = false;
  return;
}

function handleBodyStartParagraph(state: TreeBuilder, token: TagToken): ModeResult {
  closePElement(state);
  insertElement(state, token, true);
  return;
}

function handleBodyStartMath(state: TreeBuilder, token: TagToken): ModeResult {
  reconstructActiveFormattingElements(state);
  const attrs = prepareForeignAttributes("math", token.attrs);
  const newTag = createTagToken(TagKind.Start, token.name, attrs, token.selfClosing);
  insertElement(state, newTag, !token.selfClosing, "math");
  return;
}

function handleBodyStartSvg(state: TreeBuilder, token: TagToken): ModeResult {
  reconstructActiveFormattingElements(state);
  const adjustedName = adjustSVGTagName(token.name);
  const attrs = prepareForeignAttributes("svg", token.attrs);
  const newTag = createTagToken(TagKind.Start, adjustedName, attrs, token.selfClosing);
  insertElement(state, newTag, !token.selfClosing, "svg");
  return;
}

function handleBodyStartLi(state: TreeBuilder, token: TagToken): ModeResult {
  state.framesetOk = false;
  closePElement(state);
  if (hasInListItemScope(state, "li")) popUntilAnyInclusive(state, SET_LI);
  insertElement(state, token, true);
  return;
}

function handleBodyStartDdDt(state: TreeBuilder, token: TagToken): ModeResult {
  state.framesetOk = false;
  closePElement(state);
  const { name } = token;
  if (name === "dd") {
    if (hasInDefinitionScope(state, "dd")) popUntilAnyInclusive(state, SET_DD);
    if (hasInDefinitionScope(state, "dt")) popUntilAnyInclusive(state, SET_DT);
  } else {
    if (hasInDefinitionScope(state, "dt")) popUntilAnyInclusive(state, SET_DT);
    if (hasInDefinitionScope(state, "dd")) popUntilAnyInclusive(state, SET_DD);
  }
  insertElement(state, token, true);
  return;
}

function handleBodyStartA(state: TreeBuilder, token: TagToken): ModeResult {
  if (hasActiveFormattingEntry(state, "a")) {
    runAdoptionAgencyAlgorithm(state, "a");
    removeLastActiveFormattingByName(state, "a");
    removeLastOpenElementByName(state, "a");
  }
  reconstructActiveFormattingElements(state);
  const node = insertElement(state, token, true);
  appendActiveFormattingEntry(state, "a", token.attrs, node);
  return;
}

function handleBodyStartFormatting(state: TreeBuilder, token: TagToken): ModeResult {
  const { name, attrs } = token;
  if (name === "nobr" && inScope(state, "nobr")) {
    runAdoptionAgencyAlgorithm(state, "nobr");
    removeLastActiveFormattingByName(state, "nobr");
    removeLastOpenElementByName(state, "nobr");
  }
  reconstructActiveFormattingElements(state);
  const dupIndex = findActiveFormattingDuplicate(state, name, attrs);
  if (dupIndex != null) removeFormattingEntry(state, dupIndex);
  const node = insertElement(state, token, true);
  appendActiveFormattingEntry(state, name, attrs, node);
  return;
}

function handleBodyStartAppletLike(state: TreeBuilder, token: TagToken): ModeResult {
  reconstructActiveFormattingElements(state);
  insertElement(state, token, true);
  pushFormattingMarker(state);
  state.framesetOk = false;
  return;
}

function handleBodyStartBr(state: TreeBuilder, token: TagToken): ModeResult {
  reconstructActiveFormattingElements(state);
  insertElement(state, token, false);
  state.framesetOk = false;
  return;
}

function handleBodyStartHr(state: TreeBuilder, token: TagToken): ModeResult {
  closePElement(state);
  insertElement(state, token, false);
  state.framesetOk = false;
  return;
}

function handleBodyStartFrameset(state: TreeBuilder, token: TagToken): ModeResult {
  if (!state.framesetOk) {
    unexpectedStartTagIgnored(state, token.name);
    return;
  }

  let bodyIndex: number | undefined;
  for (let i = 0; i < state.openElements.length; i += 1) {
    if (state.openElements[i]!.name === "body") {
      bodyIndex = i;
      break;
    }
  }
  if (bodyIndex == null) {
    unexpectedStartTagIgnored(state, token.name);
    return;
  }

  const bodyElem = state.openElements[bodyIndex];
  bodyElem?.parentNode?.removeChild(bodyElem);
  state.openElements.length = bodyIndex;

  insertElement(state, token, true);
  state.mode = InsertionMode.IN_FRAMESET;
}

function handleBodyStartStructureIgnored(
  state: TreeBuilder,
  token: TagToken
): ModeResult {
  unexpectedStartTagIgnored(state, token.name);
  return;
}

function handleBodyStartColOrFrame(state: TreeBuilder, token: TagToken): ModeResult {
  if (state.fragmentContext == null) {
    unexpectedStartTagIgnored(state, token.name);
    return;
  }
  insertElement(state, token, false);
}

function handleBodyStartImage(state: TreeBuilder, token: TagToken): ModeResult {
  parseError(state, ErrorCode.ImageStartTag, token.name);
  const imgToken = createTagToken(TagKind.Start, "img", token.attrs, token.selfClosing);
  reconstructActiveFormattingElements(state);
  insertElement(state, imgToken, false);
  state.framesetOk = false;
  return;
}

function handleBodyStartVoidWithFormatting(
  state: TreeBuilder,
  token: TagToken
): ModeResult {
  reconstructActiveFormattingElements(state);
  insertElement(state, token, false);
  state.framesetOk = false;
  return;
}

function handleBodyStartSimpleVoid(state: TreeBuilder, token: TagToken): ModeResult {
  insertElement(state, token, false);
  return;
}

function handleBodyStartInput(state: TreeBuilder, token: TagToken): ModeResult {
  let inputType: string | undefined;
  for (const [name, value] of token.attrs) {
    if (name === "type") {
      inputType = value?.toLowerCase();
      break;
    }
  }
  insertElement(state, token, false);
  if (inputType !== "hidden") {
    state.framesetOk = false;
  }
  return;
}

function handleBodyStartTable(state: TreeBuilder, token: TagToken): ModeResult {
  if (state.quirksMode !== QuirksMode.Quirks) closePElement(state);
  insertElement(state, token, true);
  state.framesetOk = false;
  state.mode = InsertionMode.IN_TABLE;
  return;
}

function handleBodyStartPlaintextXmp(state: TreeBuilder, token: TagToken): ModeResult {
  closePElement(state);
  insertElement(state, token, true);
  state.framesetOk = false;
  if (token.name === "plaintext") {
    state.tokenizerStateOverride = TokenSinkResult.Plaintext;
  } else {
    state.originalMode = state.mode;
    state.mode = InsertionMode.TEXT;
  }
  return;
}

function handleBodyStartTextarea(state: TreeBuilder, token: TagToken): ModeResult {
  insertElement(state, token, true);
  state.ignoreLF = true;
  state.framesetOk = false;
  return;
}

function handleBodyStartSelect(state: TreeBuilder, token: TagToken): ModeResult {
  reconstructActiveFormattingElements(state);
  insertElement(state, token, true);
  state.framesetOk = false;
  resetInsertionMode(state);
  return;
}

function handleBodyStartOption(state: TreeBuilder, token: TagToken): ModeResult {
  popOpenElementIf(state, "option");
  reconstructActiveFormattingElements(state);
  insertElement(state, token, true);
  return;
}

function handleBodyStartOptgroup(state: TreeBuilder, token: TagToken): ModeResult {
  popOpenElementIf(state, "option");
  reconstructActiveFormattingElements(state);
  insertElement(state, token, true);
  return;
}

function handleBodyStartRpRt(state: TreeBuilder, token: TagToken): ModeResult {
  generateImpliedEndTags(state, "rtc");
  insertElement(state, token, true);
  return;
}

function handleBodyStartRbRtc(state: TreeBuilder, token: TagToken): ModeResult {
  if (
    state.openElements.length &&
    SET_RB_RP_RT_RTC.has(state.openElements.at(-1)!.name)
  ) {
    generateImpliedEndTags(state, undefined);
  }
  insertElement(state, token, true);
  return;
}

function handleBodyStartTableParseError(state: TreeBuilder, token: TagToken): ModeResult {
  unexpectedStartTag(state, token.name);
  return;
}

function handleBodyStartDefault(state: TreeBuilder, token: TagToken): ModeResult {
  reconstructActiveFormattingElements(state);
  insertElement(state, token, true);
  if (token.selfClosing) {
    parseError(
      state,
      ErrorCode.NonVoidHtmlElementStartTagWithTrailingSolidus,
      token.name
    );
  }
  state.framesetOk = false;
  return;
}

const BODY_START_HANDLERS = new Map<
  string,
  (state: TreeBuilder, token: TagToken) => ModeResult
>([
  ["a", handleBodyStartA],
  ["address", handleBodyStartBlockWithP],
  ["applet", handleBodyStartAppletLike],
  ["area", handleBodyStartVoidWithFormatting],
  ["article", handleBodyStartBlockWithP],
  ["aside", handleBodyStartBlockWithP],
  ["b", handleBodyStartFormatting],
  ["base", handleBodyStartInHead],
  ["basefont", handleBodyStartInHead],
  ["bgsound", handleBodyStartInHead],
  ["big", handleBodyStartFormatting],
  ["blockquote", handleBodyStartBlockWithP],
  ["body", handleBodyStartBody],
  ["br", handleBodyStartBr],
  ["button", handleBodyStartButton],
  ["caption", handleBodyStartTableParseError],
  ["center", handleBodyStartBlockWithP],
  ["code", handleBodyStartFormatting],
  ["col", handleBodyStartColOrFrame],
  ["colgroup", handleBodyStartStructureIgnored],
  ["dd", handleBodyStartDdDt],
  ["details", handleBodyStartBlockWithP],
  ["dialog", handleBodyStartBlockWithP],
  ["dir", handleBodyStartBlockWithP],
  ["div", handleBodyStartBlockWithP],
  ["dl", handleBodyStartBlockWithP],
  ["dt", handleBodyStartDdDt],
  ["em", handleBodyStartFormatting],
  ["embed", handleBodyStartVoidWithFormatting],
  ["fieldset", handleBodyStartBlockWithP],
  ["figcaption", handleBodyStartBlockWithP],
  ["figure", handleBodyStartBlockWithP],
  ["font", handleBodyStartFormatting],
  ["footer", handleBodyStartBlockWithP],
  ["form", handleBodyStartForm],
  ["frame", handleBodyStartColOrFrame],
  ["frameset", handleBodyStartFrameset],
  ["h1", handleBodyStartHeading],
  ["h2", handleBodyStartHeading],
  ["h3", handleBodyStartHeading],
  ["h4", handleBodyStartHeading],
  ["h5", handleBodyStartHeading],
  ["h6", handleBodyStartHeading],
  ["head", handleBodyStartHead],
  ["header", handleBodyStartBlockWithP],
  ["hgroup", handleBodyStartBlockWithP],
  ["hr", handleBodyStartHr],
  ["html", handleBodyStartHtml],
  ["i", handleBodyStartFormatting],
  ["image", handleBodyStartImage],
  ["img", handleBodyStartVoidWithFormatting],
  ["input", handleBodyStartInput],
  ["keygen", handleBodyStartVoidWithFormatting],
  ["li", handleBodyStartLi],
  ["link", handleBodyStartInHead],
  ["listing", handleBodyStartPreListing],
  ["main", handleBodyStartBlockWithP],
  ["marquee", handleBodyStartAppletLike],
  ["math", handleBodyStartMath],
  ["menu", handleBodyStartBlockWithP],
  ["meta", handleBodyStartInHead],
  ["nav", handleBodyStartBlockWithP],
  ["nobr", handleBodyStartFormatting],
  ["noframes", handleBodyStartInHead],
  ["object", handleBodyStartAppletLike],
  ["ol", handleBodyStartBlockWithP],
  ["optgroup", handleBodyStartOptgroup],
  ["option", handleBodyStartOption],
  ["p", handleBodyStartParagraph],
  ["param", handleBodyStartSimpleVoid],
  ["plaintext", handleBodyStartPlaintextXmp],
  ["pre", handleBodyStartPreListing],
  ["rb", handleBodyStartRbRtc],
  ["rp", handleBodyStartRpRt],
  ["rt", handleBodyStartRpRt],
  ["rtc", handleBodyStartRbRtc],
  ["s", handleBodyStartFormatting],
  ["script", handleBodyStartInHead],
  ["search", handleBodyStartBlockWithP],
  ["section", handleBodyStartBlockWithP],
  ["select", handleBodyStartSelect],
  ["small", handleBodyStartFormatting],
  ["source", handleBodyStartSimpleVoid],
  ["strike", handleBodyStartFormatting],
  ["strong", handleBodyStartFormatting],
  ["style", handleBodyStartInHead],
  ["summary", handleBodyStartBlockWithP],
  ["svg", handleBodyStartSvg],
  ["table", handleBodyStartTable],
  ["tbody", handleBodyStartStructureIgnored],
  ["td", handleBodyStartStructureIgnored],
  ["template", handleBodyStartInHead],
  ["textarea", handleBodyStartTextarea],
  ["tfoot", handleBodyStartStructureIgnored],
  ["th", handleBodyStartStructureIgnored],
  ["thead", handleBodyStartStructureIgnored],
  ["title", handleBodyStartInHead],
  ["tr", handleBodyStartStructureIgnored],
  ["track", handleBodyStartSimpleVoid],
  ["tt", handleBodyStartFormatting],
  ["u", handleBodyStartFormatting],
  ["ul", handleBodyStartBlockWithP],
  ["wbr", handleBodyStartVoidWithFormatting],
  ["xmp", handleBodyStartPlaintextXmp],
]);

function handleBodyEndBody(state: TreeBuilder): ModeResult {
  if (inScope(state, "body")) state.mode = InsertionMode.AFTER_BODY;
  return;
}

function handleBodyEndHtml(state: TreeBuilder, token: TreeToken): ModeResult {
  if (inScope(state, "body"))
    return reprocessInstruction(InsertionMode.AFTER_BODY, token);
  return;
}

function handleBodyEndP(state: TreeBuilder, token: TagToken): ModeResult {
  if (!closePElement(state)) {
    unexpectedEndTag(state, token.name);
    const phantom = createTagToken(TagKind.Start, "p", new Map(), false);
    insertElement(state, phantom, true);
    closePElement(state);
  }
  return;
}

function handleBodyEndLi(state: TreeBuilder, token: TagToken): ModeResult {
  if (!hasInListItemScope(state, "li")) {
    unexpectedEndTag(state, token.name);
    return;
  }
  popUntilAnyInclusive(state, SET_LI);
  return;
}

function handleBodyEndDdDt(state: TreeBuilder, token: TagToken): ModeResult {
  const { name } = token;
  if (!hasInDefinitionScope(state, name)) {
    unexpectedEndTag(state, name);
    return;
  }
  popUntilAnyInclusive(state, SET_DD_DT);
  return;
}

function handleBodyEndForm(state: TreeBuilder, token: TagToken): ModeResult {
  if (state.formElement == null) {
    unexpectedEndTag(state, token.name);
    return;
  }
  const removed = removeFromOpenElements(state, state.formElement);
  state.formElement = undefined;
  if (!removed) unexpectedEndTag(state, token.name);
  return;
}

function handleBodyEndAppletLike(state: TreeBuilder, token: TagToken): ModeResult {
  const { name } = token;
  if (!inScope(state, name)) {
    unexpectedEndTag(state, name);
    return;
  }
  for (const node of popOpenElements(state)) {
    if (node.name === name) break;
  }
  clearActiveFormattingUpToMarker(state);
  return;
}

function handleBodyEndHeading(state: TreeBuilder, token: TagToken): ModeResult {
  const { name } = token;
  if (!hasAnyInScope(state, HEADING_ELEMENTS)) {
    unexpectedEndTag(state, name);
    return;
  }
  generateImpliedEndTags(state, undefined);

  const node = state.openElements.at(-1);
  if (node != null && node.name !== name) {
    endTagTooEarly(state, name);
  }
  for (const node of popOpenElements(state)) {
    if (HEADING_ELEMENTS.has(node.name)) break;
  }
  return;
}

function handleBodyEndBlock(state: TreeBuilder, token: TagToken): ModeResult {
  const { name } = token;
  if (!inScope(state, name)) {
    unexpectedEndTag(state, name);
    return;
  }
  generateImpliedEndTags(state, undefined);
  if (state.openElements.length && state.openElements.at(-1)!.name !== name) {
    endTagTooEarly(state, name);
  }
  popUntilAnyInclusive(state, new Set([name]));
  return;
}

function handleBodyEndTemplate(state: TreeBuilder, token: TreeToken): ModeResult {
  const hasTemplate = state.openElements.some(node => node.name === "template");
  if (!hasTemplate) return;
  generateImpliedEndTags(state, undefined);
  popUntilInclusive(state, "template");
  clearActiveFormattingUpToMarker(state);
  if (state.templateModes.length) state.templateModes.pop();
  resetInsertionMode(state);
  return;
}

const BODY_END_HANDLERS = new Map<
  string,
  (state: TreeBuilder, token: TagToken) => ModeResult
>([
  ["address", handleBodyEndBlock],
  ["applet", handleBodyEndAppletLike],
  ["article", handleBodyEndBlock],
  ["aside", handleBodyEndBlock],
  ["blockquote", handleBodyEndBlock],
  ["body", handleBodyEndBody],
  ["button", handleBodyEndBlock],
  ["center", handleBodyEndBlock],
  ["dd", handleBodyEndDdDt],
  ["details", handleBodyEndBlock],
  ["dialog", handleBodyEndBlock],
  ["dir", handleBodyEndBlock],
  ["div", handleBodyEndBlock],
  ["dl", handleBodyEndBlock],
  ["dt", handleBodyEndDdDt],
  ["fieldset", handleBodyEndBlock],
  ["figcaption", handleBodyEndBlock],
  ["figure", handleBodyEndBlock],
  ["footer", handleBodyEndBlock],
  ["form", handleBodyEndForm],
  ["h1", handleBodyEndHeading],
  ["h2", handleBodyEndHeading],
  ["h3", handleBodyEndHeading],
  ["h4", handleBodyEndHeading],
  ["h5", handleBodyEndHeading],
  ["h6", handleBodyEndHeading],
  ["header", handleBodyEndBlock],
  ["hgroup", handleBodyEndBlock],
  ["html", handleBodyEndHtml],
  ["li", handleBodyEndLi],
  ["listing", handleBodyEndBlock],
  ["main", handleBodyEndBlock],
  ["marquee", handleBodyEndAppletLike],
  ["menu", handleBodyEndBlock],
  ["nav", handleBodyEndBlock],
  ["object", handleBodyEndAppletLike],
  ["ol", handleBodyEndBlock],
  ["p", handleBodyEndP],
  ["pre", handleBodyEndBlock],
  ["search", handleBodyEndBlock],
  ["section", handleBodyEndBlock],
  ["summary", handleBodyEndBlock],
  ["table", handleBodyEndBlock],
  ["template", handleBodyEndTemplate],
  ["ul", handleBodyEndBlock],
]);

/** Handles start/end tag dispatch while in body mode. */
function handleTagInBody(state: TreeBuilder, token: TagToken): ModeResult {
  if (token.kind === TagKind.Start) {
    const handler = BODY_START_HANDLERS.get(token.name) ?? handleBodyStartDefault;
    return handler(state, token);
  }

  const { name } = token;
  if (name === "br") {
    unexpectedEndTag(state, name);
    const brTag = createTagToken(TagKind.Start, "br", new Map(), false);
    return modeInBody(state, brTag);
  }

  if (FORMATTING_ELEMENTS.has(name)) {
    runAdoptionAgencyAlgorithm(state, name);
    return;
  }

  const handler = BODY_END_HANDLERS.get(name);
  if (handler != null) return handler(state, token);

  anyOtherEndTag(state, name);
  return;
}

/** EOF handling for body mode. */
function handleEofInBody(state: TreeBuilder, token: TreeToken): ModeResult {
  if (state.templateModes.length) return modeInTemplate(state, token);

  for (const node of state.openElements) {
    if (!EOF_ALLOWED_UNCLOSED.has(node.name)) {
      parseError(state, ErrorCode.ExpectedClosingTagButGotEof, node.name);
      break;
    }
  }

  state.mode = InsertionMode.AFTER_BODY;
  return reprocessInstruction(InsertionMode.AFTER_BODY, token);
}

/** `IN_BODY` insertion mode (primary tree-construction mode). */
function modeInBody(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character:
      return handleCharactersInBody(state, token);
    case TokenKind.Comment:
      return handleCommentInBody(state, token);
    case TokenKind.Tag:
      return handleTagInBody(state, token);
    case TokenKind.EOF:
      return handleEofInBody(state, token);
  }
  return;
}

/** `AFTER_BODY` insertion mode. */
function modeAfterBody(state: TreeBuilder, token: TreeToken): ModeResult {
  if (token.type === TokenKind.Character && isAllWhitespace(token.data))
    return modeInBody(state, token);
  if (token.type === TokenKind.Comment) {
    const html = state.openElements[0];
    appendComment(state, token.data, html);
    return;
  }
  if (token.type === TokenKind.Tag) {
    if (token.kind === TagKind.Start && token.name === "html")
      return modeInBody(state, token);
    if (token.kind === TagKind.End && token.name === "html") {
      state.mode = InsertionMode.AFTER_AFTER_BODY;
      return;
    }
  }
  if (token.type === TokenKind.EOF) return;
  parseError(state, ErrorCode.UnexpectedTokenAfterBody);
  state.mode = InsertionMode.IN_BODY;
  return reprocessInstruction(InsertionMode.IN_BODY, token);
}

/** `AFTER_AFTER_BODY` insertion mode. */
function modeAfterAfterBody(state: TreeBuilder, token: TreeToken): ModeResult {
  if (token.type === TokenKind.Comment) {
    if (state.fragmentContext != null) {
      const html = findLastOnStack(state, "html");
      if (html) appendComment(state, token.data, html);
      else appendCommentToDocument(state, token.data);
      return;
    }
    appendCommentToDocument(state, token.data);
    return;
  }
  if (token.type === TokenKind.Character && isAllWhitespace(token.data))
    return modeInBody(state, token);
  if (
    token.type === TokenKind.Tag &&
    token.kind === TagKind.Start &&
    token.name === "html"
  )
    return modeInBody(state, token);
  if (token.type === TokenKind.EOF) return;
  parseError(state, ErrorCode.UnexpectedTokenAfterAfterBody);
  state.mode = InsertionMode.IN_BODY;
  return reprocessInstruction(InsertionMode.IN_BODY, token);
}

const TABLE_BODY_CONTEXT_TAGS = new Set(["tbody", "tfoot", "thead"]);
const TABLE_BODY_CONTEXT_CLEAR_UNTIL = new Set([
  "tbody",
  "tfoot",
  "thead",
  "template",
  "html",
]);
const TABLE_ROW_CONTEXT_CLEAR_UNTIL = new Set(["tr", "template", "html"]);
const TABLE_CONTEXT_CLEAR_UNTIL = new Set(["table", "template", "html"]);

const TABLE_MODE_TABLE_VOODOO_END_TAGS = new Set([
  "body",
  "caption",
  "col",
  "colgroup",
  "html",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
]);

/** `IN_TABLE` insertion mode. */
function modeInTable(state: TreeBuilder, token: TreeToken): ModeResult {
  if (token.type === TokenKind.Character) {
    let data = token.data;
    if (data.includes("\x00")) {
      parseError(state, ErrorCode.UnexpectedNullCharacter);
      data = data.replaceAll("\x00", "");
      if (!data) return;
      token = createCharacterToken(data);
    }

    state.pendingTableText = [];
    state.tableTextOriginalMode = state.mode;
    state.mode = InsertionMode.IN_TABLE_TEXT;
    return reprocessInstruction(InsertionMode.IN_TABLE_TEXT, token);
  }

  if (token.type === TokenKind.Comment) {
    appendComment(state, token.data);
    return;
  }

  if (token.type === TokenKind.Tag) {
    const { name, kind } = token;
    if (kind === TagKind.Start) {
      if (name === "caption") {
        clearStackUntil(state, TABLE_CONTEXT_CLEAR_UNTIL);
        pushFormattingMarker(state);
        insertElement(state, token, true);
        state.mode = InsertionMode.IN_CAPTION;
        return;
      }
      if (name === "colgroup") {
        clearStackUntil(state, TABLE_CONTEXT_CLEAR_UNTIL);
        insertElement(state, token, true);
        state.mode = InsertionMode.IN_COLUMN_GROUP;
        return;
      }
      if (name === "col") {
        clearStackUntil(state, TABLE_CONTEXT_CLEAR_UNTIL);
        const implied = createTagToken(TagKind.Start, "colgroup", new Map(), false);
        insertElement(state, implied, true);
        state.mode = InsertionMode.IN_COLUMN_GROUP;
        return reprocessInstruction(InsertionMode.IN_COLUMN_GROUP, token);
      }
      if (name === "tbody" || name === "tfoot" || name === "thead") {
        clearStackUntil(state, TABLE_CONTEXT_CLEAR_UNTIL);
        insertElement(state, token, true);
        state.mode = InsertionMode.IN_TABLE_BODY;
        return;
      }
      if (name === "td" || name === "th" || name === "tr") {
        clearStackUntil(state, TABLE_CONTEXT_CLEAR_UNTIL);
        const implied = createTagToken(TagKind.Start, "tbody", new Map(), false);
        insertElement(state, implied, true);
        state.mode = InsertionMode.IN_TABLE_BODY;
        return reprocessInstruction(InsertionMode.IN_TABLE_BODY, token);
      }
      if (name === "table") {
        parseError(state, ErrorCode.UnexpectedStartTagImpliesEndTag, name);
        const closed = closeTableElement(state);
        if (closed) return reprocessInstruction(state.mode, token);
        return;
      }
      if (name === "style" || name === "script") {
        insertElement(state, token, true);
        state.originalMode = state.mode;
        state.mode = InsertionMode.TEXT;
        return;
      }
      if (name === "template") {
        return modeInHead(state, token);
      }
      if (name === "input") {
        let inputType: string | undefined;
        // eslint-disable-next-line unicorn/consistent-destructuring
        for (const [attrName, attrValue] of token.attrs) {
          if (attrName === "type") {
            inputType = (attrValue ?? "").toLowerCase();
            break;
          }
        }
        if (inputType === "hidden") {
          parseError(state, ErrorCode.UnexpectedHiddenInputInTable);
          insertElement(state, token, true);
          state.openElements.pop();
          return;
        }
      }
      if (name === "form") {
        parseError(state, ErrorCode.UnexpectedFormInTable);
        if (state.formElement == null) {
          const node = insertElement(state, token, true);
          state.formElement = node;
          state.openElements.pop();
        }
        return;
      }

      parseError(state, ErrorCode.UnexpectedStartTagImpliesTableVoodoo, name);
      const previous = state.insertFromTable;
      state.insertFromTable = true;
      try {
        return modeInBody(state, token);
      } finally {
        state.insertFromTable = previous;
      }
    }

    // End tag.
    if (name === "table") {
      closeTableElement(state);
      return;
    }
    if (TABLE_MODE_TABLE_VOODOO_END_TAGS.has(name)) {
      unexpectedEndTag(state, name);
      return;
    }

    parseError(state, ErrorCode.UnexpectedEndTagImpliesTableVoodoo, name);
    const previous = state.insertFromTable;
    state.insertFromTable = true;
    try {
      return modeInBody(state, token);
    } finally {
      state.insertFromTable = previous;
    }
  }

  if (token.type === TokenKind.EOF) {
    if (state.templateModes.length) return modeInTemplate(state, token);
    if (hasInTableScope(state, "table"))
      parseError(state, ErrorCode.ExpectedClosingTagButGotEof, "table");
    return;
  }

  return;
}

/** `IN_TABLE_TEXT` insertion mode. */
function modeInTableText(state: TreeBuilder, token: TreeToken): ModeResult {
  if (token.type === TokenKind.Character) {
    let data = token.data;
    if (data.includes("\x0C")) {
      parseError(state, ErrorCode.InvalidCodepointInTableText);
      data = data.replaceAll("\x0C", "");
    }
    if (data) state.pendingTableText.push(data);
    return;
  }

  flushPendingTableText(state);
  const original = state.tableTextOriginalMode ?? InsertionMode.IN_TABLE;
  state.tableTextOriginalMode = undefined;
  state.mode = original;
  return reprocessInstruction(original, token);
}

const CAPTION_STRUCTURE_START_TAGS = new Set([
  "caption",
  "col",
  "colgroup",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "td",
  "th",
]);
const CAPTION_END_TAGS_NEVER_inScope = new Set(["tbody", "tfoot", "thead"]);

/** `IN_CAPTION` insertion mode. */
function modeInCaption(state: TreeBuilder, token: TreeToken): ModeResult {
  if (token.type === TokenKind.Character) return modeInBody(state, token);
  if (token.type === TokenKind.Comment) {
    appendComment(state, token.data);
    return;
  }

  if (token.type === TokenKind.Tag) {
    const { name, kind } = token;
    if (kind === TagKind.Start) {
      if (CAPTION_STRUCTURE_START_TAGS.has(name)) {
        parseError(state, ErrorCode.UnexpectedStartTagImpliesEndTag, name);
        if (closeCaptionElement(state))
          return reprocessInstruction(InsertionMode.IN_TABLE, token);
        return;
      }
      if (name === "table") {
        parseError(state, ErrorCode.UnexpectedStartTagImpliesEndTag, name);
        if (closeCaptionElement(state))
          return reprocessInstruction(InsertionMode.IN_TABLE, token);
        return modeInBody(state, token);
      }
      return modeInBody(state, token);
    }

    // End tag.
    if (name === "caption") {
      closeCaptionElement(state);
      return;
    }
    if (name === "table") {
      if (closeCaptionElement(state))
        return reprocessInstruction(InsertionMode.IN_TABLE, token);
      return;
    }
    if (CAPTION_END_TAGS_NEVER_inScope.has(name)) {
      unexpectedEndTag(state, name);
      return;
    }
    return modeInBody(state, token);
  }

  if (token.type === TokenKind.EOF) {
    return modeInBody(state, token);
  }
  return;
}

/** `IN_COLUMN_GROUP` insertion mode. */
function modeInColumnGroup(state: TreeBuilder, token: TreeToken): ModeResult {
  const current = state.openElements.length ? state.openElements.at(-1)! : null;

  switch (token.type) {
    case TokenKind.Character: {
      const { data } = token;
      let i = 0;
      while (i < data.length && "\t\n\f\r ".includes(data[i]!)) i += 1;

      if (i) appendText(state, data.slice(0, i));
      const rest = data.slice(i);
      if (!rest) return;

      if (current && current.name === "html") {
        parseError(state, ErrorCode.UnexpectedCharactersInColumnGroup);
        return;
      }
      if (current && current.name === "template") {
        parseError(state, ErrorCode.UnexpectedCharactersInTemplateColumnGroup);
        return;
      }

      parseError(state, ErrorCode.UnexpectedCharactersInColumnGroup);
      popCurrent(state);
      state.mode = InsertionMode.IN_TABLE;
      return reprocessInstruction(InsertionMode.IN_TABLE, createCharacterToken(rest));
    }
    case TokenKind.Comment: {
      appendComment(state, token.data);
      return;
    }
    case TokenKind.Tag: {
      const { name, kind } = token;
      if (kind === TagKind.Start) {
        if (name === "html") return modeInBody(state, token);
        if (name === "col") {
          insertElement(state, token, true);
          state.openElements.pop();
          return;
        }
        if (name === "template") return modeInHead(state, token);
        if (name === "colgroup") {
          parseError(state, ErrorCode.UnexpectedStartTagImpliesEndTag, name);
          if (current && current.name === "colgroup") {
            popCurrent(state);
            state.mode = InsertionMode.IN_TABLE;
            return reprocessInstruction(InsertionMode.IN_TABLE, token);
          }
          return;
        }

        if (
          state.fragmentContext &&
          (
            state.fragmentContext.tagName ||
            state.fragmentContext.tagName ||
            ""
          ).toLowerCase() === "colgroup" &&
          !hasInTableScope(state, "table")
        ) {
          parseError(state, ErrorCode.UnexpectedStartTagInColumnGroup, name);
          return;
        }

        if (current && current.name === "colgroup") {
          popCurrent(state);
          state.mode = InsertionMode.IN_TABLE;
          return reprocessInstruction(InsertionMode.IN_TABLE, token);
        }

        parseError(state, ErrorCode.UnexpectedStartTagInTemplateColumnGroup, name);
        return;
      }

      // End tag.
      if (name === "colgroup") {
        if (current && current.name === "colgroup") {
          popCurrent(state);
          state.mode = InsertionMode.IN_TABLE;
        } else {
          unexpectedEndTag(state, name);
        }
        return;
      }
      if (name === "col") {
        unexpectedEndTag(state, name);
        return;
      }
      if (name === "template") {
        return modeInHead(state, token);
      }

      if (current && current.name !== "html") {
        popCurrent(state);
        state.mode = InsertionMode.IN_TABLE;
      }
      return reprocessInstruction(InsertionMode.IN_TABLE, token);
    }
    case TokenKind.EOF:
      if (current && current.name === "colgroup") {
        popCurrent(state);
        state.mode = InsertionMode.IN_TABLE;
        return reprocessInstruction(InsertionMode.IN_TABLE, token);
      }
      if (current && current.name === "template") return modeInTemplate(state, token);
      return;

    // No default
  }

  return;
}

const TABLE_BODY_EXIT_START_TAGS = new Set([
  "caption",
  "col",
  "colgroup",
  "tbody",
  "tfoot",
  "thead",
  "table",
]);
const TABLE_BODY_UNEXPECTED_END_TAGS = new Set([
  "caption",
  "col",
  "colgroup",
  "td",
  "th",
  "tr",
]);

/** `IN_TABLE_BODY` insertion mode. */
function modeInTableBody(state: TreeBuilder, token: TreeToken): ModeResult {
  const { openElements, fragmentContext } = state;
  switch (token.type) {
    case TokenKind.Character:
    case TokenKind.Comment:
      return modeInTable(state, token);

    case TokenKind.Tag: {
      const { name, kind } = token;
      if (kind === TagKind.Start) {
        if (name === "tr") {
          clearStackUntil(state, TABLE_BODY_CONTEXT_CLEAR_UNTIL);
          insertElement(state, token, true);
          state.mode = InsertionMode.IN_ROW;
          return;
        }
        if (name === "td" || name === "th") {
          parseError(state, ErrorCode.UnexpectedCellInTableBody);
          clearStackUntil(state, TABLE_BODY_CONTEXT_CLEAR_UNTIL);
          const implied = createTagToken(TagKind.Start, "tr", new Map(), false);
          insertElement(state, implied, true);
          state.mode = InsertionMode.IN_ROW;
          return reprocessInstruction(InsertionMode.IN_ROW, token);
        }

        if (TABLE_BODY_EXIT_START_TAGS.has(name)) {
          const current = openElements.at(-1);
          if (current?.name === "template") {
            parseError(state, ErrorCode.UnexpectedStartTagInTemplateTableContext, name);
            return;
          }
          if (
            fragmentContext &&
            current?.name === "html" &&
            TABLE_BODY_CONTEXT_TAGS.has(fragmentContext.tagName.toLowerCase())
          ) {
            unexpectedStartTag(state, fragmentContext.tagName);
            return;
          }
          if (openElements.length) {
            openElements.pop();
            state.mode = InsertionMode.IN_TABLE;
            return reprocessInstruction(InsertionMode.IN_TABLE, token);
          }
          state.mode = InsertionMode.IN_TABLE;
          return;
        }

        return modeInTable(state, token);
      }

      if (name === "tbody" || name === "tfoot" || name === "thead") {
        if (!hasInTableScope(state, name)) {
          unexpectedEndTag(state, name);
          return;
        }
        clearStackUntil(state, TABLE_BODY_CONTEXT_CLEAR_UNTIL);
        popCurrent(state);
        state.mode = InsertionMode.IN_TABLE;
        return;
      }

      if (name === "table") {
        const current = openElements.at(-1);
        if (current && current.name === "template") {
          unexpectedEndTag(state, name);
          return;
        }
        if (
          fragmentContext &&
          current?.name === "html" &&
          TABLE_BODY_CONTEXT_TAGS.has(fragmentContext.tagName.toLowerCase())
        ) {
          unexpectedEndTag(state, name);
          return;
        }
        if (current && TABLE_BODY_CONTEXT_TAGS.has(current.name)) {
          openElements.pop();
        }
        state.mode = InsertionMode.IN_TABLE;
        return reprocessInstruction(InsertionMode.IN_TABLE, token);
      }

      if (TABLE_BODY_UNEXPECTED_END_TAGS.has(name)) {
        unexpectedEndTag(state, name);
        return;
      }

      return modeInTable(state, token);
    }

    case TokenKind.EOF:
      return modeInTable(state, token);
  }
  return;
}

const ROW_TABLE_EXIT_START_TAGS = new Set([
  "caption",
  "col",
  "colgroup",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "table",
]);
const ROW_UNEXPECTED_END_TAGS = new Set(["caption", "col", "group", "td", "th"]);

/** `IN_ROW` insertion mode. */
function modeInRow(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character:
    case TokenKind.Comment:
      return modeInTable(state, token);

    case TokenKind.Tag: {
      const { name, kind } = token;
      if (kind === TagKind.Start) {
        if (name === "td" || name === "th") {
          clearStackUntil(state, TABLE_ROW_CONTEXT_CLEAR_UNTIL);
          insertElement(state, token, true);
          pushFormattingMarker(state);
          state.mode = InsertionMode.IN_CELL;
          return;
        }
        if (ROW_TABLE_EXIT_START_TAGS.has(name)) {
          if (!hasInTableScope(state, "tr")) {
            parseError(state, ErrorCode.UnexpectedStartTagImpliesEndTag, name);
            return;
          }
          endTRElement(state);
          return reprocessInstruction(state.mode, token);
        }

        const previous = state.insertFromTable;
        state.insertFromTable = true;
        try {
          return modeInBody(state, token);
        } finally {
          state.insertFromTable = previous;
        }
      }

      if (name === "tr") {
        if (!hasInTableScope(state, "tr")) {
          unexpectedEndTag(state, name);
          return;
        }
        endTRElement(state);
        return;
      }

      if (name === "table" || name === "tbody" || name === "tfoot" || name === "thead") {
        if (hasInTableScope(state, name)) {
          endTRElement(state);
          return reprocessInstruction(state.mode, token);
        }
        unexpectedEndTag(state, name);
        return;
      }

      if (ROW_UNEXPECTED_END_TAGS.has(name)) {
        unexpectedEndTag(state, name);
        return;
      }

      const previous = state.insertFromTable;
      state.insertFromTable = true;
      try {
        return modeInBody(state, token);
      } finally {
        state.insertFromTable = previous;
      }
    }

    case TokenKind.EOF:
      return modeInTable(state, token);
  }
  return;
}

const CELL_STRUCTURE_TAGS = new Set([
  "caption",
  "col",
  "colgroup",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
]);

/** `IN_CELL` insertion mode. */
function modeInCell(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character: {
      const previous = state.insertFromTable;
      state.insertFromTable = false;
      try {
        return modeInBody(state, token);
      } finally {
        state.insertFromTable = previous;
      }
    }
    case TokenKind.Comment:
      appendComment(state, token.data);
      return;

    case TokenKind.Tag: {
      const { name, kind } = token;
      if (kind === TagKind.Start) {
        if (CELL_STRUCTURE_TAGS.has(name)) {
          if (closeTableCell(state)) return reprocessInstruction(state.mode, token);
          parseError(state, ErrorCode.UnexpectedStartTagInCellFragment, name);
          return;
        }
        const previous = state.insertFromTable;
        state.insertFromTable = false;
        try {
          return modeInBody(state, token);
        } finally {
          state.insertFromTable = previous;
        }
      }

      switch (name) {
        case "td":
        case "th":
          if (!hasInTableScope(state, name)) {
            unexpectedEndTag(state, name);
            return;
          }
          endTableCell(state, name);
          return;

        case "table":
        case "tbody":
        case "tfoot":
        case "thead":
        case "tr":
          if (!hasInTableScope(state, name)) {
            unexpectedEndTag(state, name);
            return;
          }
          closeTableCell(state);
          return reprocessInstruction(state.mode, token);
      }

      const previous = state.insertFromTable;
      state.insertFromTable = false;
      try {
        return modeInBody(state, token);
      } finally {
        state.insertFromTable = previous;
      }
    }

    case TokenKind.EOF:
      return closeTableCell(state)
        ? reprocessInstruction(state.mode, token)
        : modeInTable(state, token);
  }
  return;
}

/** `IN_FRAMESET` insertion mode. */
function modeInFrameset(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character: {
      const { data } = token;
      let whitespace = "";
      for (const ch of data) {
        if (ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r" || ch === " ")
          whitespace += ch;
      }
      if (whitespace) appendText(state, whitespace);
      return;
    }
    case TokenKind.Comment:
      appendComment(state, token.data);
      return;

    case TokenKind.Tag: {
      if (token.kind === TagKind.Start) {
        if (token.name === "html") {
          return reprocessInstruction(InsertionMode.IN_BODY, token);
        } else if (token.name === "frameset") {
          insertElement(state, token, true);
          return;
        }
      }
      const { openElements } = state;
      if (token.kind === TagKind.End && token.name === "frameset") {
        if (openElements.at(-1)?.name === "html") {
          unexpectedEndTag(state, token.name);
          return;
        }
        openElements.pop();
        if (openElements.length && openElements.at(-1)!.name !== "frameset") {
          state.mode = InsertionMode.AFTER_FRAMESET;
        }
        return;
      }
      if (token.kind === TagKind.Start) {
        if (token.name === "frame") {
          insertElement(state, token, true);
          openElements.pop();
          return;
        } else if (token.name === "noframes") {
          insertElement(state, token, true);
          // eslint-disable-next-line unicorn/consistent-destructuring
          state.originalMode = state.mode;
          state.mode = InsertionMode.TEXT;
          return;
        }
      }

      break;
    }
    case TokenKind.EOF: {
      const node = state.openElements.at(-1);
      if (node != null && node.name !== "html") {
        parseError(state, ErrorCode.ExpectedClosingTagButGotEof, node.name);
      }
      return;
    }
  }

  parseError(state, ErrorCode.UnexpectedTokenInFrameset);
  return;
}

/** `AFTER_FRAMESET` insertion mode. */
function modeAfterFrameset(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character: {
      const { data } = token;
      let whitespace = "";
      for (const ch of data) {
        if (ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r" || ch === " ")
          whitespace += ch;
      }
      if (whitespace) appendText(state, whitespace);
      return;
    }
    case TokenKind.Comment:
      appendComment(state, token.data);
      return;

    case TokenKind.Tag:
      if (token.kind === TagKind.Start && token.name === "html")
        return reprocessInstruction(InsertionMode.IN_BODY, token);
      if (token.kind === TagKind.End && token.name === "html") {
        state.mode = InsertionMode.AFTER_AFTER_FRAMESET;
        return;
      }
      if (token.kind === TagKind.Start && token.name === "noframes") {
        insertElement(state, token, true);
        state.originalMode = state.mode;
        state.mode = InsertionMode.TEXT;
        return;
      }
      break;

    case TokenKind.EOF:
      return;
  }

  parseError(state, ErrorCode.UnexpectedTokenAfterFrameset);
  state.mode = InsertionMode.IN_FRAMESET;
  return reprocessInstruction(InsertionMode.IN_FRAMESET, token);
}

/** `AFTER_AFTER_FRAMESET` insertion mode. */
function modeAfterAfterFrameset(state: TreeBuilder, token: TreeToken): ModeResult {
  if (token.type === TokenKind.Character && isAllWhitespace(token.data)) {
    modeInBody(state, token);
    return;
  }

  switch (token.type) {
    case TokenKind.Comment:
      appendCommentToDocument(state, token.data);
      return;

    case TokenKind.Tag: {
      if (token.kind === TagKind.Start && token.name === "html")
        return reprocessInstruction(InsertionMode.IN_BODY, token);
      if (token.kind === TagKind.Start && token.name === "noframes") {
        insertElement(state, token, true);
        state.originalMode = state.mode;
        state.mode = InsertionMode.TEXT;
        return;
      }

      break;
    }
    case TokenKind.EOF:
      return;
    // No default
  }

  parseError(state, ErrorCode.UnexpectedTokenAfterAfterFrameset);
  state.mode = InsertionMode.IN_FRAMESET;
  return reprocessInstruction(InsertionMode.IN_FRAMESET, token);
}

const SELECT_END_TAG_TABLE_ELEMENTS = new Set([
  "caption",
  "col",
  "colgroup",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "table",
]);
const SELECT_ALLOWED_ELEMENTS = new Set([
  "p",
  "div",
  "span",
  "button",
  "datalist",
  "selectedcontent",
]);
const SELECT_HEAD_TAGS = new Set([
  "base",
  "basefont",
  "bgsound",
  "link",
  "meta",
  "noframes",
  "script",
  "style",
  "template",
  "title",
]);

/** `IN_SELECT` insertion mode. */
function modeInSelect(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character: {
      let data = token.data;
      if (data.includes("\x00")) {
        parseError(state, ErrorCode.InvalidCodepointInSelect);
        data = data.replaceAll("\x00", "");
      }
      if (data.includes("\x0C")) {
        parseError(state, ErrorCode.InvalidCodepointInSelect);
        data = data.replaceAll("\x0C", "");
      }
      if (data) {
        reconstructActiveFormattingElements(state);
        appendText(state, data);
      }
      return;
    }
    case TokenKind.Comment: {
      appendComment(state, token.data);
      return;
    }
    case TokenKind.Tag: {
      const { attrs, name, kind, selfClosing } = token;
      if (kind === TagKind.Start) {
        switch (name) {
          case "html":
            return reprocessInstruction(InsertionMode.IN_BODY, token);

          case "option":
            popOpenElementIf(state, "option");
            reconstructActiveFormattingElements(state);
            insertElement(state, token, true);
            return;

          case "optgroup":
            popOpenElementIf(state, "option");
            popOpenElementIf(state, "optgroup");
            reconstructActiveFormattingElements(state);
            insertElement(state, token, true);
            return;

          case "select":
            parseError(state, ErrorCode.UnexpectedStartTagImpliesEndTag, name);
            popUntilAnyInclusive(state, new Set(["select"]));
            resetInsertionMode(state);
            return;

          case "input":
          case "textarea":
            parseError(state, ErrorCode.UnexpectedStartTagImpliesEndTag, name);
            popUntilAnyInclusive(state, new Set(["select"]));
            resetInsertionMode(state);
            return reprocessInstruction(state.mode, token);

          case "keygen":
            reconstructActiveFormattingElements(state);
            insertElement(state, token, false);
            return;

          // No default
        }

        if (SELECT_END_TAG_TABLE_ELEMENTS.has(name)) {
          parseError(state, ErrorCode.UnexpectedStartTagImpliesEndTag, name);
          popUntilAnyInclusive(state, new Set(["select"]));
          resetInsertionMode(state);
          return reprocessInstruction(state.mode, token);
        }

        switch (name) {
          case "script":
          case "template":
            return modeInHead(state, token);

          case "svg":
          case "math":
            reconstructActiveFormattingElements(state);
            insertElement(state, token, !selfClosing, name);
            return;
        }

        if (FORMATTING_ELEMENTS.has(name)) {
          reconstructActiveFormattingElements(state);
          const node = insertElement(state, token, true);
          appendActiveFormattingEntry(state, name, attrs, node);
          return;
        }

        switch (name) {
          case "hr":
            popOpenElementIf(state, "option");
            popOpenElementIf(state, "optgroup");
            reconstructActiveFormattingElements(state);
            insertElement(state, token, false);
            return;

          case "menuitem":
            reconstructActiveFormattingElements(state);
            insertElement(state, token, true);
            return;
        }

        if (SELECT_ALLOWED_ELEMENTS.has(name)) {
          reconstructActiveFormattingElements(state);
          insertElement(state, token, !selfClosing);
          return;
        }

        switch (name) {
          case "br":
          case "img":
            reconstructActiveFormattingElements(state);
            insertElement(state, token, false);
            return;
          case "plaintext":
            reconstructActiveFormattingElements(state);
            insertElement(state, token, true);
            return;
        }
        return;
      }

      // End tag.
      switch (name) {
        case "optgroup":
          popOpenElementIf(state, "option");
          if (!popOpenElementIf(state, "optgroup")) {
            unexpectedEndTag(state, name);
          }
          return;

        case "option":
          if (!popOpenElementIf(state, "option")) {
            unexpectedEndTag(state, name);
          }
          return;

        case "select":
          popUntilAnyInclusive(state, new Set(["select"]));
          resetInsertionMode(state);
          return;

        // No default
      }

      if (name === "a" || FORMATTING_ELEMENTS.has(name)) {
        const selectNode = findLastOnStack(state, "select");
        const fmtIndex = findActiveFormattingIndex(state, name);
        if (fmtIndex != null) {
          const target = (state.activeFormatting[fmtIndex] as Formatting).node;
          const { openElements } = state;
          if (openElements.includes(target) && selectNode) {
            const selectIndex = openElements.indexOf(selectNode);
            const targetIndex = openElements.indexOf(target);
            if (targetIndex < selectIndex) {
              unexpectedEndTag(state, name);
              return;
            }
          }
        }
        runAdoptionAgencyAlgorithm(state, name);
        return;
      }

      if (SELECT_ALLOWED_ELEMENTS.has(name)) {
        let selectIdx: number | undefined;
        let targetIdx: number | undefined;
        for (const [i, node] of state.openElements.entries()) {
          if (node.name === "select" && selectIdx == null) selectIdx = i;
          if (node.name === name) targetIdx = i;
        }
        if (targetIdx != null && (selectIdx == null || targetIdx > selectIdx)) {
          for (const node of popOpenElements(state)) {
            if (node.name === name) break;
          }
        } else {
          unexpectedEndTag(state, name);
        }
        return;
      }

      if (SELECT_END_TAG_TABLE_ELEMENTS.has(name)) {
        unexpectedEndTag(state, name);
        popUntilAnyInclusive(state, new Set(["select"]));
        resetInsertionMode(state);
        return reprocessInstruction(state.mode, token);
      }

      unexpectedEndTag(state, name);
      return;
    }

    case TokenKind.EOF:
      return modeInBody(state, token);
  }
  return;
}

/** `IN_TEMPLATE` insertion mode. */
function modeInTemplate(state: TreeBuilder, token: TreeToken): ModeResult {
  switch (token.type) {
    case TokenKind.Character:
      return modeInBody(state, token);

    case TokenKind.Comment:
      return modeInBody(state, token);

    case TokenKind.Tag: {
      const { templateModes } = state;
      if (token.kind === TagKind.Start) {
        switch (token.name) {
          case "caption":
          case "colgroup":
          case "tbody":
          case "tfoot":
          case "thead":
            templateModes.pop();
            templateModes.push(InsertionMode.IN_TABLE);
            state.mode = InsertionMode.IN_TABLE;
            return reprocessInstruction(InsertionMode.IN_TABLE, token);

          case "col":
            templateModes.pop();
            templateModes.push(InsertionMode.IN_COLUMN_GROUP);
            state.mode = InsertionMode.IN_COLUMN_GROUP;
            return reprocessInstruction(InsertionMode.IN_COLUMN_GROUP, token);

          case "tr":
            templateModes.pop();
            templateModes.push(InsertionMode.IN_TABLE_BODY);
            state.mode = InsertionMode.IN_TABLE_BODY;
            return reprocessInstruction(InsertionMode.IN_TABLE_BODY, token);

          case "td":
          case "th":
            templateModes.pop();
            templateModes.push(InsertionMode.IN_ROW);
            state.mode = InsertionMode.IN_ROW;
            return reprocessInstruction(InsertionMode.IN_ROW, token);
        }

        if (!SELECT_HEAD_TAGS.has(token.name)) {
          templateModes.pop();
          templateModes.push(InsertionMode.IN_BODY);
          state.mode = InsertionMode.IN_BODY;
          return reprocessInstruction(InsertionMode.IN_BODY, token);
        }
      }

      if (token.kind === TagKind.End && token.name === "template") {
        return modeInHead(state, token);
      } else if (SELECT_HEAD_TAGS.has(token.name)) {
        return modeInHead(state, token);
      }

      break;
    }

    case TokenKind.EOF: {
      const hasTemplate = state.openElements.some(node => node.name === "template");
      if (!hasTemplate) return;
      parseError(state, ErrorCode.ExpectedClosingTagButGotEof, "template");
      popUntilInclusive(state, "template");
      clearActiveFormattingUpToMarker(state);
      state.templateModes.pop();
      resetInsertionMode(state);
      return reprocessInstruction(state.mode, token);
    }
  }

  return;
}

// Placeholder for any unported modes.
/** Fallback dispatcher when mode index is unknown. */
function modeFallbackToBody(state: TreeBuilder, token: TreeToken): ModeResult {
  state.mode = InsertionMode.IN_BODY;
  return reprocessInstruction(InsertionMode.IN_BODY, token);
}

const MODE_HANDLERS = [
  modeInitial,
  modeBeforeHtml,
  modeBeforeHead,
  modeInHead,
  modeInHeadNoscript,
  modeAfterHead,
  modeText,
  modeInBody,
  modeAfterBody,
  modeAfterAfterBody,
  modeInTable,
  modeInTableText,
  modeInCaption,
  modeInColumnGroup,
  modeInTableBody,
  modeInRow,
  modeInCell,
  modeInFrameset,
  modeAfterFrameset,
  modeAfterAfterFrameset,
  modeInSelect,
  modeInTemplate,
];

export interface TreeBuilderState {
  readonly fragmentContext: FragmentContext | undefined;
  readonly iframeSrcdoc: boolean;
  readonly collectErrors: boolean;
  readonly errors: ParseError[];
  tokenizer: Tokenizer | undefined;
  fragmentContextElement: Node | undefined;
  readonly document: Node;
  mode: InsertionMode;
  originalMode: InsertionMode | undefined;
  tableTextOriginalMode: InsertionMode | undefined;
  readonly openElements: Node[];
  headElement: Node | undefined;
  formElement: Node | undefined;
  framesetOk: boolean;
  quirksMode: QuirksMode;
  ignoreLF: boolean;
  readonly activeFormatting: Array<typeof FORMAT_MARKER | Formatting>;
  insertFromTable: boolean;
  pendingTableText: string[];
  readonly templateModes: InsertionMode[];
  tokenizerStateOverride: TokenSinkResult | undefined;
}

export type TreeBuilder = TreeBuilderState;

/**
 * Creates and initializes treebuilder state for document or fragment parsing.
 */
export function createTreeBuilder(
  fragmentContext: FragmentContext | undefined = undefined,
  iframeSrcdoc = false,
  collectErrors = false
): TreeBuilderState {
  const state: TreeBuilderState = {
    fragmentContext,
    iframeSrcdoc,
    collectErrors,
    errors: [],
    tokenizer: undefined,
    fragmentContextElement: undefined,
    document:
      fragmentContext != null ? new Node("#document-fragment") : new Node("#document"),
    mode: InsertionMode.INITIAL,
    originalMode: undefined,
    tableTextOriginalMode: undefined,
    openElements: [],
    headElement: undefined,
    formElement: undefined,
    framesetOk: true,
    quirksMode: QuirksMode.NoQuirks,
    ignoreLF: false,
    activeFormatting: [],
    insertFromTable: false,
    pendingTableText: [],
    templateModes: [],
    tokenizerStateOverride: undefined,
  };

  if (fragmentContext != null) {
    // Fragment parsing per HTML5 spec
    const root = createElement("html", undefined, new Map());
    state.document.appendChild(root);
    state.openElements.push(root);

    const { namespace, tagName: contextName } = fragmentContext;
    const name = contextName.toLowerCase();

    if (namespace && namespace !== "html") {
      let adjustedName = contextName;
      if (namespace === "svg") adjustedName = adjustSVGTagName(contextName);
      const contextElement = createElement(adjustedName, namespace, new Map());
      root.appendChild(contextElement);
      state.openElements.push(contextElement);
      state.fragmentContextElement = contextElement;
    }

    if (name === "html") state.mode = InsertionMode.BEFORE_HEAD;
    else if (
      (namespace == null || namespace === "html") &&
      FRAGMENT_TABLE_SECTION_TAGS.has(name)
    )
      state.mode = InsertionMode.IN_TABLE_BODY;
    else if ((namespace == null || namespace === "html") && name === "tr")
      state.mode = InsertionMode.IN_ROW;
    else if ((namespace == null || namespace === "html") && FRAGMENT_CELL_TAGS.has(name))
      state.mode = InsertionMode.IN_CELL;
    else if ((namespace == null || namespace === "html") && name === "caption")
      state.mode = InsertionMode.IN_CAPTION;
    else if ((namespace == null || namespace === "html") && name === "colgroup")
      state.mode = InsertionMode.IN_COLUMN_GROUP;
    else if ((namespace == null || namespace === "html") && name === "table")
      state.mode = InsertionMode.IN_TABLE;
    else state.mode = InsertionMode.IN_BODY;

    state.framesetOk = false;
  }

  return state;
}

function* popOpenElements(state: TreeBuilderState) {
  while (state.openElements.length) {
    yield state.openElements.pop()!;
  }
}

function popOpenElementIf(state: TreeBuilderState, name: string) {
  if (state.openElements.at(-1)?.name === name) {
    state.openElements.pop();
    return true;
  }
}

function* activeFormattingStack(state: TreeBuilderState) {
  const { activeFormatting } = state;
  for (let index = activeFormatting.length - 1; index >= 0; index -= 1) {
    yield [index, activeFormatting[index]!] as const;
  }
}

function* openElementsStack(state: TreeBuilderState) {
  const { openElements } = state;
  for (let index = openElements.length - 1; index >= 0; index -= 1) {
    yield [index, openElements[index]!] as const;
  }
}

function setQuirksMode(state: TreeBuilderState, mode: QuirksMode): void {
  state.quirksMode = mode;
}

function parseError(state: TreeBuilderState, code: ErrorCode, tagName?: string): void {
  if (!state.collectErrors) return;
  state.errors.push(new ParseError(code, tagName));
}

function unexpectedEndTag(state: TreeBuilderState, name: string) {
  parseError(state, ErrorCode.UnexpectedEndTag, name);
}
function unexpectedStartTag(state: TreeBuilderState, name: string) {
  parseError(state, ErrorCode.UnexpectedStartTag, name);
}
function unexpectedStartTagIgnored(state: TreeBuilderState, name: string) {
  parseError(state, ErrorCode.UnexpectedStartTagIgnored, name);
}
function invalidCodepoint(state: TreeBuilderState) {
  parseError(state, ErrorCode.InvalidCodepoint);
}
function endTagTooEarly(state: TreeBuilderState, name: string | undefined) {
  parseError(state, ErrorCode.EndTagTooEarly, name);
}

function hasElementInScope(
  state: TreeBuilderState,
  target: string,
  terminators: Set<string> | undefined = undefined,
  checkIntegrationPoints = true
): boolean {
  const terms = terminators ?? DEFAULT_SCOPE_TERMINATORS;
  for (const [, node] of openElementsStack(state)) {
    if (node.name === target) return true;

    const ns = node.namespace;
    if (ns === "html" || ns == null) {
      if (terms.has(node.name)) return false;
    } else if (
      checkIntegrationPoints &&
      (isHTMLIntegrationPoint(node) || isMathMLTextIntegrationPoint(node))
    ) {
      return false;
    }
  }
  return false;
}

function hasElementInButtonScope(state: TreeBuilderState, target: string): boolean {
  return hasElementInScope(state, target, BUTTON_SCOPE_TERMINATORS);
}

function popUntilInclusive(state: TreeBuilderState, name: string): void {
  for (const node of popOpenElements(state)) {
    if (node.name === name) break;
  }
}

function popUntilAnyInclusive(state: TreeBuilderState, names: Set<string>): void {
  for (const node of popOpenElements(state)) {
    if (names.has(node.name)) return;
  }
}

function closePElement(state: TreeBuilderState): boolean {
  if (hasElementInButtonScope(state, "p")) {
    generateImpliedEndTags(state, "p");
    const node = state.openElements.at(-1);
    if (node != null && node.name !== "p") {
      endTagTooEarly(state, "p");
    }
    popUntilInclusive(state, "p");
    return true;
  }
  return false;
}

function inScope(state: TreeBuilderState, name: string): boolean {
  return hasElementInScope(state, name, DEFAULT_SCOPE_TERMINATORS);
}

function closeElementByName(state: TreeBuilderState, name: string): void {
  const { openElements } = state;
  let index = openElements.length - 1;
  while (index >= 0) {
    if (openElements[index]!.name === name) {
      openElements.splice(index);
      return;
    }
    index -= 1;
  }
}

function anyOtherEndTag(state: TreeBuilderState, name: string): void {
  const { openElements } = state;
  let index = openElements.length - 1;
  while (index >= 0) {
    const node = openElements[index]!;
    if (node.name === name) {
      if (index !== openElements.length - 1) {
        endTagTooEarly(state, undefined);
      }
      openElements.splice(index);
      return;
    }
    if (isSpecialElement(node)) {
      unexpectedEndTag(state, name);
      return;
    }
    index -= 1;
  }
}

function generateImpliedEndTags(
  state: TreeBuilderState,
  exclude: string | undefined
): void {
  const { openElements } = state;
  while (openElements.length) {
    const node = openElements.at(-1)!;
    if (IMPLIED_END_TAGS.has(node.name) && node.name !== exclude) {
      openElements.pop();
      continue;
    }
    break;
  }
}

function clearActiveFormattingUpToMarker(state: TreeBuilderState): void {
  const { activeFormatting } = state;
  while (activeFormatting.length) {
    const entry = activeFormatting.pop();
    if (entry === FORMAT_MARKER) break;
  }
}

function pushFormattingMarker(state: TreeBuilderState): void {
  state.activeFormatting.push(FORMAT_MARKER);
}

function resetInsertionMode(state: TreeBuilderState): void {
  for (const [, node] of openElementsStack(state)) {
    const { name } = node;
    if (name === "select") {
      state.mode = InsertionMode.IN_SELECT;
      return;
    }
    if (name === "td" || name === "th") {
      state.mode = InsertionMode.IN_CELL;
      return;
    }
    if (name === "tr") {
      state.mode = InsertionMode.IN_ROW;
      return;
    }
    if (name === "tbody" || name === "tfoot" || name === "thead") {
      state.mode = InsertionMode.IN_TABLE_BODY;
      return;
    }
    if (name === "caption") {
      state.mode = InsertionMode.IN_CAPTION;
      return;
    }
    if (name === "table") {
      state.mode = InsertionMode.IN_TABLE;
      return;
    }
    if (name === "template" && state.templateModes.length) {
      state.mode = state.templateModes.at(-1)!;
      return;
    }
    if (name === "head") {
      state.mode = InsertionMode.IN_HEAD;
      return;
    }
    if (name === "html") {
      state.mode = InsertionMode.IN_BODY;
      return;
    }
  }
  state.mode = InsertionMode.IN_BODY;
}

/** Central token-processing loop for tree construction. */
function processToken(
  state: TreeBuilderState,
  token: Token
): TokenSinkResult | undefined {
  const { openElements } = state;
  if (token.type === TokenKind.Doctype) {
    if (openElements.length) {
      const current = openElements.at(-1)!;
      if (current.namespace != null && current.namespace !== "html") {
        parseError(state, ErrorCode.UnexpectedDoctype);
        return TokenSinkResult.Continue;
      }
    }
    return handleDoctype(state, token);
  }

  let currentToken: Token = token;
  let forceHtmlMode = false;

  while (true) {
    const currentNode = openElements.at(-1);
    const isHtmlNamespace =
      currentNode == null ||
      currentNode.namespace == null ||
      currentNode.namespace === "html";

    let result: ModeResult | undefined;

    if (forceHtmlMode || isHtmlNamespace) {
      forceHtmlMode = false;
      const handler = MODE_HANDLERS[state.mode] ?? modeFallbackToBody;
      result = handler(state, currentToken);
    } else if (shouldUseForeignContent(state, currentToken)) {
      result = processForeignContent(state, currentToken);
    } else if (
      currentToken.type === TokenKind.Character &&
      isMathMLTextIntegrationPoint(currentNode)
    ) {
      let data = currentToken.data;
      if (data.includes("\x00")) {
        invalidCodepoint(state);
        data = data.replaceAll("\x00", "");
      }
      if (data.includes("\x0C")) {
        invalidCodepoint(state);
        data = data.replaceAll("\x0C", "");
      }
      if (data) {
        if (!isAllWhitespace(data)) {
          reconstructActiveFormattingElements(state);
          state.framesetOk = false;
        }
        appendText(state, data);
      }
      result = undefined;
    } else {
      const isIntegrationPoint =
        isMathMLTextIntegrationPoint(currentNode) || isHTMLIntegrationPoint(currentNode);

      if (
        isIntegrationPoint &&
        currentToken.type === TokenKind.Tag &&
        currentToken.kind === TagKind.Start &&
        state.mode !== InsertionMode.IN_BODY
      ) {
        const isTableMode =
          state.mode === InsertionMode.IN_TABLE ||
          state.mode === InsertionMode.IN_TABLE_BODY ||
          state.mode === InsertionMode.IN_ROW ||
          state.mode === InsertionMode.IN_CELL ||
          state.mode === InsertionMode.IN_CAPTION ||
          state.mode === InsertionMode.IN_COLUMN_GROUP;
        const hasTableInScope = hasInTableScope(state, "table");

        if (isTableMode && !hasTableInScope) {
          const savedMode = state.mode;
          state.mode = InsertionMode.IN_BODY;
          const handler = MODE_HANDLERS[state.mode] ?? modeFallbackToBody;
          result = handler(state, currentToken);
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (state.mode === InsertionMode.IN_BODY) {
            state.mode = savedMode;
          }
        } else {
          const handler = MODE_HANDLERS[state.mode] ?? modeFallbackToBody;
          result = handler(state, currentToken);
        }
      } else {
        const handler = MODE_HANDLERS[state.mode] ?? modeFallbackToBody;
        result = handler(state, currentToken);
      }
    }

    if (result == null) {
      // eslint-disable-next-line unicorn/consistent-destructuring
      const out = state.tokenizerStateOverride ?? TokenSinkResult.Continue;
      state.tokenizerStateOverride = undefined;
      return out;
    }

    const [, mode, tokenOverride, forceHtml] = result;
    state.mode = mode;
    currentToken = tokenOverride;
    forceHtmlMode = Boolean(forceHtml);
  }
}

/** Feeds character data through the same token-processing pipeline. */
function processCharacters(
  state: TreeBuilderState,
  data: string
): TokenSinkResult | undefined {
  return processToken(state, createCharacterToken(data));
}

/** Finalizes the tree and applies post-parse adjustments. */
export function finishTreeBuilder(state: TreeBuilderState): Node {
  const { document } = state;
  // eslint-disable-next-line unicorn/consistent-destructuring
  if (state.fragmentContext != null) {
    const root = document.childNodes[0]!;
    // eslint-disable-next-line unicorn/consistent-destructuring
    const contextElem = state.fragmentContextElement;
    if (contextElem?.parentNode === root) {
      for (const child of contextElem.childNodes.slice()) {
        contextElem.removeChild(child);
        root.appendChild(child);
      }
      root.removeChild(contextElem);
    }
    for (const child of root.childNodes.slice()) {
      root.removeChild(child);
      document.appendChild(child);
    }
    document.removeChild(root);
  }

  populateSelectedContent(document);
  return document;
}

// ---------------- Insertion helpers ----------------

function appendCommentToDocument(state: TreeBuilderState, text: string): void {
  state.document.appendChild(new Node("#comment", text));
}

function appendComment(
  state: TreeBuilderState,
  text: string,
  parent: Node | undefined = undefined
): void {
  let target = parent ?? currentNodeOrHTML(state)!;
  if (isTemplateNode(target)) {
    target = target.templateContent!;
  }
  target.appendChild(new Node("#comment", text));
}

function appendText(state: TreeBuilderState, text: string): void {
  if (!text) return;
  if (state.ignoreLF) {
    state.ignoreLF = false;
    if (text.startsWith("\n")) {
      text = text.slice(1);
      if (!text) return;
    }
  }

  const { openElements } = state;
  if (!openElements.length) return;

  const target = openElements.at(-1)!;
  if (!TABLE_FOSTER_TARGETS.has(target.name) && !isTemplateNode(target)) {
    const children = target.childNodes;
    if (children.at(-1)?.name === "#text") {
      children.at(-1)!.data = (children.at(-1)!.data as string) + text;
      return;
    }
    target.appendChild(new Node("#text", text));
    return;
  }

  const adjustedTarget = currentNodeOrHTML(state)!;
  const foster = shouldFosterParenting(state, adjustedTarget, undefined, true);
  if (foster) reconstructActiveFormattingElements(state);

  const [parent, position] = appropriateInsertionLocation(state, undefined, foster);
  if (position > 0) {
    const node = parent.childNodes[position - 1];
    if (node?.name === "#text") {
      node.data = (node.data as string) + text;
      return;
    }
  }

  insertNodeAt(parent, position, new Node("#text", text));
}

function currentNodeOrHTML(state: TreeBuilderState): Node | undefined {
  if (state.openElements.length) {
    return state.openElements.at(-1)!;
  }
  for (const child of state.document.childNodes) {
    if (child.name === "html") return child;
  }
  return state.document.childNodes[0];
}

function createRoot(state: TreeBuilderState, attrs: NodeAttrMap): Node {
  const node = new Node("html", undefined, "html", attrs);
  state.document.appendChild(node);
  state.openElements.push(node);
  return node;
}

function insertElement(
  state: TreeBuilderState,
  tag: TagToken,
  push: boolean,
  namespace: string | null = "html"
): Node {
  const node = new Node(tag.name, undefined, namespace, tag.attrs);

  if (!state.insertFromTable) {
    const target = currentNodeOrHTML(state)!;
    const parent = isTemplateNode(target) ? target.templateContent : target;
    parent.appendChild(node);
    if (push) {
      state.openElements.push(node);
    }
    return node;
  }

  const target = currentNodeOrHTML(state)!;
  const foster = shouldFosterParenting(state, target, tag.name, false);
  const [parent, position] = appropriateInsertionLocation(state, undefined, foster);
  insertNodeAt(parent, position, node);
  if (push) {
    state.openElements.push(node);
  }
  return node;
}

function insertPhantom(state: TreeBuilderState, name: string): Node {
  const tag = createTagToken(TagKind.Start, name, new Map(), false);
  return insertElement(state, tag, true);
}

function insertBodyIfMissing(state: TreeBuilderState): void {
  const htmlNode = findLastOnStack(state, "html")!;
  const node = new Node("body", undefined);
  htmlNode.appendChild(node);
  state.openElements.push(node);
}

function createElement(name: string, namespace = "html", attrs: NodeAttrMap): Node {
  return new Node(name, undefined, namespace, attrs);
}

function popCurrent(state: TreeBuilderState): Node | undefined {
  return state.openElements.pop();
}

function addMissingAttributes(node: Node, attrs: NodeAttrMap | undefined): void {
  if (!attrs) return;
  const existing = node.attrs;
  for (const [name, value] of attrs) {
    if (!existing.has(name)) {
      existing.set(name, value);
    }
  }
}

function removeFromOpenElements(state: TreeBuilderState, node: Node): boolean {
  for (let index = 0; index < state.openElements.length; index += 1) {
    if (state.openElements[index] === node) {
      state.openElements.splice(index, 1);
      return true;
    }
  }
  return false;
}

function isSpecialElement(node: Node): boolean {
  if (node.namespace != null && node.namespace !== "html") return false;
  return SPECIAL_ELEMENTS.has(node.name);
}

function findActiveFormattingIndex(
  state: TreeBuilderState,
  name: string
): number | undefined {
  for (const [index, entry] of activeFormattingStack(state)) {
    if (entry === FORMAT_MARKER) break;
    if (entry.name === name) return index;
  }
}

function findActiveFormattingIndexByNode(
  state: TreeBuilderState,
  node: Node
): number | undefined {
  for (const [index, entry] of activeFormattingStack(state)) {
    if (entry !== FORMAT_MARKER && entry.node === node) return index;
  }
}

function cloneAttributes(attrs: NodeAttrMap | undefined): NodeAttrMap {
  return attrs ? new Map(attrs) : new Map();
}

function attrsSignature(attrs: NodeAttrMap | undefined): string {
  if (!attrs || !attrs.size) return "";

  const keys = Array.from(attrs.keys());
  keys.sort();
  let out = "";
  for (const key of keys) {
    const value = attrs.get(key) || "";
    out += `${key}\u0000${value}\u0001`;
  }
  return out;
}

function findActiveFormattingDuplicate(
  state: TreeBuilderState,
  name: string,
  attrs: NodeAttrMap | undefined
): number | undefined {
  const signature = attrsSignature(attrs);
  let matches: number[] = [];
  for (const [i, entry] of state.activeFormatting.entries()) {
    if (entry === FORMAT_MARKER) {
      matches = [];
      continue;
    }
    if (entry.name === name && entry.signature === signature) {
      matches.push(i);
    }
  }
  if (matches.length >= 3) {
    return matches[0];
  }
  return;
}

function hasActiveFormattingEntry(state: TreeBuilderState, name: string): boolean {
  for (const [, entry] of activeFormattingStack(state)) {
    if (entry === FORMAT_MARKER) break;
    if (entry.name === name) return true;
  }
  return false;
}

function removeLastActiveFormattingByName(state: TreeBuilderState, name: string): void {
  for (const [index, entry] of activeFormattingStack(state)) {
    if (entry === FORMAT_MARKER) {
      break;
    } else if (entry.name === name) {
      state.activeFormatting.splice(index, 1);
      return;
    }
  }
}

function removeLastOpenElementByName(state: TreeBuilderState, name: string): void {
  for (const [idx, node] of openElementsStack(state)) {
    if (node.name === name) {
      state.openElements.splice(idx, 1);
      return;
    }
  }
}

function appendActiveFormattingEntry(
  state: TreeBuilderState,
  name: string,
  attrs: NodeAttrMap | undefined,
  node: Node
): void {
  const entryAttrs = cloneAttributes(attrs);
  state.activeFormatting.push({
    name,
    attrs: entryAttrs,
    node,
    signature: attrsSignature(entryAttrs),
  });
}

function removeFormattingEntry(state: TreeBuilderState, index: number): void {
  if (index < 0 || index >= state.activeFormatting.length)
    throw new Error(`Invalid formatting index: ${index}`);
  state.activeFormatting.splice(index, 1);
}

/** Reconstructs active formatting elements before inserting phrasing content. */
function reconstructActiveFormattingElements(state: TreeBuilderState): void {
  if (!state.activeFormatting.length) return;
  const lastEntry = state.activeFormatting.at(-1)!;
  if (lastEntry === FORMAT_MARKER) return;

  const { activeFormatting, openElements } = state;
  if (openElements.includes(lastEntry.node)) return;

  let index = activeFormatting.length - 1;
  while (true) {
    index -= 1;
    if (index < 0) break;
    const entry = activeFormatting[index]!;
    if (entry === FORMAT_MARKER || openElements.includes(entry.node)) {
      index += 1;
      break;
    }
  }
  if (index < 0) index = 0;

  while (index < activeFormatting.length) {
    const entry = activeFormatting[index]!;
    if (entry === FORMAT_MARKER) {
      index += 1;
      continue;
    }
    const tag = createTagToken(
      TagKind.Start,
      entry.name,
      cloneAttributes(entry.attrs),
      false
    );
    const newNode = insertElement(state, tag, true);
    entry.node = newNode;
    index += 1;
  }
}

/** HTML adoption-agency algorithm for mis-nested formatting end tags. */
function runAdoptionAgencyAlgorithm(state: TreeBuilderState, subject: string): void {
  const { activeFormatting, openElements } = state;
  if (
    openElements.at(-1)?.name === subject &&
    !hasActiveFormattingEntry(state, subject)
  ) {
    popUntilInclusive(state, subject);
    return;
  }

  for (let outer = 0; outer < 8; outer += 1) {
    const formattingElementIndex = findActiveFormattingIndex(state, subject);
    if (formattingElementIndex == null) return;

    const formattingEntry = activeFormatting[formattingElementIndex]!;
    if (formattingEntry === FORMAT_MARKER) return;
    const formattingElement = formattingEntry.node;

    if (!openElements.includes(formattingElement)) {
      parseError(state, ErrorCode.AdoptionAgency13);
      removeFormattingEntry(state, formattingElementIndex);
      return;
    }

    if (!hasElementInScope(state, formattingElement.name)) {
      parseError(state, ErrorCode.AdoptionAgency13);
      return;
    }

    if (formattingElement !== openElements.at(-1)) {
      parseError(state, ErrorCode.AdoptionAgency13);
    }

    let furthestBlock: Node | undefined;
    const formattingElementInOpenIndex = openElements.indexOf(formattingElement);
    for (let i = formattingElementInOpenIndex + 1; i < openElements.length; i += 1) {
      const node = openElements[i]!;
      if (isSpecialElement(node)) {
        furthestBlock = node;
        break;
      }
    }

    if (!furthestBlock) {
      for (const node of popOpenElements(state)) {
        if (node === formattingElement) break;
      }
      removeFormattingEntry(state, formattingElementIndex);
      return;
    }

    let bookmark = formattingElementIndex + 1;
    let node = furthestBlock;
    let lastNode = furthestBlock;

    let innerLoopCounter = 0;
    while (true) {
      innerLoopCounter += 1;

      const nodeIndex = openElements.indexOf(node);
      node = openElements[nodeIndex - 1]!;

      if (node === formattingElement) break;

      let nodeFormattingIndex = findActiveFormattingIndexByNode(state, node);

      if (innerLoopCounter > 3 && nodeFormattingIndex != null) {
        removeFormattingEntry(state, nodeFormattingIndex);
        if (nodeFormattingIndex < bookmark) bookmark -= 1;
        nodeFormattingIndex = undefined;
      }

      if (nodeFormattingIndex == null) {
        const idx = openElements.indexOf(node);
        openElements.splice(idx, 1);
        node = openElements[idx]!;
        continue;
      }

      const entry = activeFormatting[nodeFormattingIndex]!;
      if (entry === FORMAT_MARKER) {
        throw new Error("Unexpected format marker");
      }
      const newElement = createElement(
        entry.name,
        entry.node.namespace ?? undefined,
        entry.attrs
      );
      entry.node = newElement;
      openElements[openElements.indexOf(node)] = newElement;
      node = newElement;

      if (lastNode === furthestBlock) bookmark = nodeFormattingIndex + 1;

      if (lastNode.parentNode) lastNode.parentNode.removeChild(lastNode);
      node.appendChild(lastNode);

      lastNode = node;
    }

    const commonAncestor = openElements[formattingElementInOpenIndex - 1]!;
    if (lastNode.parentNode) lastNode.parentNode.removeChild(lastNode);

    if (shouldFosterParenting(state, commonAncestor, lastNode.name, false)) {
      const [parent, position] = appropriateInsertionLocation(
        state,
        commonAncestor,
        true
      );
      insertNodeAt(parent, position, lastNode);
    } else if (isTemplateNode(commonAncestor)) {
      commonAncestor.templateContent.appendChild(lastNode);
    } else {
      commonAncestor.appendChild(lastNode);
    }

    const entry = activeFormatting[formattingElementIndex]!;
    if (entry === FORMAT_MARKER) {
      throw new Error("Unexpected format marker");
    }

    const newFormattingElement = createElement(
      entry.name,
      entry.node.namespace ?? undefined,
      entry.attrs
    );
    entry.node = newFormattingElement;

    while (furthestBlock.hasChildNodes()) {
      const child = furthestBlock.childNodes[0]!;
      furthestBlock.removeChild(child);
      newFormattingElement.appendChild(child);
    }
    furthestBlock.appendChild(newFormattingElement);

    removeFormattingEntry(state, formattingElementIndex);
    bookmark -= 1;
    activeFormatting.splice(bookmark, 0, entry);

    const fmtOpenIndex = openElements.indexOf(formattingElement);
    if (fmtOpenIndex !== -1) openElements.splice(fmtOpenIndex, 1);
    const furthestBlockIndex = openElements.indexOf(furthestBlock);
    openElements.splice(furthestBlockIndex + 1, 0, newFormattingElement);
  }
}

function findLastOnStack(state: TreeBuilderState, name: string): Node | undefined {
  for (const [, node] of openElementsStack(state)) {
    if (node.name === name) return node;
  }
}

function insertNodeAt(parent: Node, index: number, node: Node): void {
  const ref = index < parent.childNodes.length ? parent.childNodes[index] : undefined;
  parent.insertBefore(node, ref);
}

/** Computes the spec-defined insertion location, including foster parenting. */
function appropriateInsertionLocation(
  state: TreeBuilderState,
  overrideTarget: Node | undefined = undefined,
  fosterParenting = false
): [Node, number] {
  const target = overrideTarget ?? currentNodeOrHTML(state)!;
  if (fosterParenting && TABLE_FOSTER_TARGETS.has(target.name)) {
    const lastTemplate = findLastOnStack(state, "template");
    const lastTable = findLastOnStack(state, "table");
    if (
      lastTemplate &&
      (lastTable == null ||
        state.openElements.indexOf(lastTemplate) > state.openElements.indexOf(lastTable))
    ) {
      return [
        lastTemplate.templateContent!,
        lastTemplate.templateContent!.childNodes.length,
      ];
    }
    if (!lastTable) return [target, target.childNodes.length];
    const parent = lastTable.parentNode;
    if (!parent) return [target, target.childNodes.length];
    const pos = parent.childNodes.indexOf(lastTable);
    return [parent, pos];
  }
  if (isTemplateNode(target)) {
    return [target.templateContent, target.templateContent.childNodes.length];
  }
  return [target, target.childNodes.length];
}

function hasInTableScope(state: TreeBuilderState, name: string): boolean {
  return hasElementInScope(state, name, TABLE_SCOPE_TERMINATORS, false);
}

function clearStackUntil(state: TreeBuilderState, names: Set<string>): void {
  const { openElements } = state;
  while (openElements.length) {
    const node = openElements.at(-1)!;
    if ((node.namespace == null || node.namespace === "html") && names.has(node.name)) {
      break;
    }
    openElements.pop();
  }
}

function closeTableCell(state: TreeBuilderState): boolean {
  if (hasInTableScope(state, "td")) {
    endTableCell(state, "td");
    return true;
  }
  if (hasInTableScope(state, "th")) {
    endTableCell(state, "th");
    return true;
  }
  return false;
}

function endTableCell(state: TreeBuilderState, name: string): void {
  generateImpliedEndTags(state, name);
  for (const node of popOpenElements(state)) {
    if (node.name === name && (node.namespace == null || node.namespace === "html"))
      break;
  }
  clearActiveFormattingUpToMarker(state);
  state.mode = InsertionMode.IN_ROW;
}

function closeCaptionElement(state: TreeBuilderState): boolean {
  if (!hasInTableScope(state, "caption")) {
    unexpectedEndTag(state, "caption");
    return false;
  }
  generateImpliedEndTags(state, undefined);
  for (const node of popOpenElements(state)) {
    if (node.name === "caption") break;
  }
  clearActiveFormattingUpToMarker(state);
  state.mode = InsertionMode.IN_TABLE;
  return true;
}

function endTRElement(state: TreeBuilderState): void {
  clearStackUntil(state, TABLE_ROW_CONTEXT_CLEAR_UNTIL);
  if (state.openElements.at(-1)?.name === "tr") {
    state.openElements.pop();
  }
  state.mode = state.templateModes.length
    ? state.templateModes.at(-1)!
    : InsertionMode.IN_TABLE_BODY;
}

function flushPendingTableText(state: TreeBuilderState): void {
  const data = state.pendingTableText.join("");
  state.pendingTableText = [];
  if (!data) return;
  if (isAllWhitespace(data)) {
    appendText(state, data);
    return;
  }
  parseError(state, ErrorCode.FosterParentingCharacter);
  const previous = state.insertFromTable;
  state.insertFromTable = true;
  try {
    reconstructActiveFormattingElements(state);
    appendText(state, data);
  } finally {
    state.insertFromTable = previous;
  }
}

function closeTableElement(state: TreeBuilderState): boolean {
  if (!hasInTableScope(state, "table")) {
    unexpectedEndTag(state, "table");
    return false;
  }
  generateImpliedEndTags(state, undefined);
  for (const node of popOpenElements(state)) {
    if (node.name === "table") break;
  }
  resetInsertionMode(state);
  return true;
}

function hasInScope(state: TreeBuilderState, name: string): boolean {
  return hasElementInScope(state, name, DEFAULT_SCOPE_TERMINATORS);
}

function hasInListItemScope(state: TreeBuilderState, name: string): boolean {
  return hasElementInScope(state, name, LIST_ITEM_SCOPE_TERMINATORS);
}

function hasInDefinitionScope(state: TreeBuilderState, name: string): boolean {
  return hasElementInScope(state, name, DEFINITION_SCOPE_TERMINATORS);
}

function hasAnyInScope(state: TreeBuilderState, names: Set<string>): boolean {
  const terminators = DEFAULT_SCOPE_TERMINATORS;
  for (const [, node] of openElementsStack(state)) {
    if (names.has(node.name)) {
      return true;
    } else if (
      (node.namespace == null || node.namespace === "html") &&
      terminators.has(node.name)
    ) {
      return false;
    }
  }
  return false;
}

/** Populates `<selectedcontent>` from the selected/first `<option>` in each `<select>`. */
function populateSelectedContent(root: Node): void {
  const selects: Node[] = [];
  findElements(root, "select", selects);
  for (const select of selects) {
    const selectedContent = findElement(select, "selectedcontent");
    if (!selectedContent) continue;

    const options: Node[] = [];
    findElements(select, "option", options);
    if (!options.length) continue;

    let selectedOption: Node | undefined;
    for (const opt of options) {
      if (opt.attrs.has("selected")) {
        selectedOption = opt;
        break;
      }
    }
    selectedOption ??= options[0]!;

    cloneChildren(selectedOption, selectedContent);
  }
}

function findElements(node: Node | undefined, name: string, result: Node[]): void {
  if (!node) return;
  if (node.name === name) result.push(node);

  for (const child of node.childNodes) findElements(child, name, result);
  const templateContent = node.templateContent ?? null;
  if (templateContent) findElements(templateContent, name, result);
}

function findElement(node: Node | undefined, name: string): Node | undefined {
  if (!node) return;
  if (node.name === name) return node;

  for (const child of node.childNodes) {
    const found = findElement(child, name);
    if (found) return found;
  }
  const templateContent = node.templateContent ?? null;
  if (templateContent) return findElement(templateContent, name);
  return;
}

function cloneChildren(source: Node, target: Node): void {
  for (const child of source.childNodes) {
    target.appendChild(child.cloneNode(true));
  }
}

function shouldFosterParenting(
  state: TreeBuilderState,
  target: Node,
  forTag?: string,
  isText?: boolean
): boolean {
  if (!state.insertFromTable) return false;
  if (!TABLE_FOSTER_TARGETS.has(target.name)) return false;
  if (isText) return true;
  if (forTag && TABLE_ALLOWED_CHILDREN.has(forTag)) return false;
  return true;
}

/** Applies namespace-specific attribute name adjustments for foreign elements. */
function prepareForeignAttributes(
  namespace: string | null,
  attrs: NodeAttrMap | undefined
): NodeAttrMap {
  const adjusted = new Map<string, string | null>();
  if (!attrs) {
    return adjusted;
  }
  for (const [name0, value] of attrs) {
    let name = name0;
    let lowerName = name.toLowerCase();

    if (namespace === "math" && MATHML_ATTRIBUTE_ADJUSTMENTS.has(lowerName)) {
      name = MATHML_ATTRIBUTE_ADJUSTMENTS.get(lowerName)!;
      lowerName = name.toLowerCase();
    } else if (namespace === "svg" && SVG_ATTRIBUTE_ADJUSTMENTS.has(lowerName)) {
      name = SVG_ATTRIBUTE_ADJUSTMENTS.get(lowerName)!;
      lowerName = name.toLowerCase();
    }

    const foreignAdjustment = FOREIGN_ATTRIBUTE_ADJUSTMENTS.get(lowerName);
    if (foreignAdjustment != null) {
      const [prefix, local] = foreignAdjustment;
      name = prefix ? `${prefix}:${local}` : local;
    }

    adjusted.set(name, value);
  }
  return adjusted;
}

function nodeAttributeValue(node: Node, name: string) {
  const target = name.toLowerCase();
  for (const [attrName, attrValue] of node.attrs) {
    if (attrName.toLowerCase() === target) {
      return attrValue || "";
    }
  }
  return;
}

function isHTMLIntegrationPoint(node: Node): boolean {
  if (node.namespace === "math" && node.name === "annotation-xml") {
    const encoding = nodeAttributeValue(node, "encoding");
    if (encoding) {
      const encLower = encoding.toLowerCase();
      if (encLower === "text/html" || encLower === "application/xhtml+xml") return true;
    }
    return false;
  }
  return HTML_INTEGRATION_POINT_SET.has(integrationPointKey(node.namespace!, node.name));
}

function isMathMLTextIntegrationPoint(node: Node): boolean {
  if (node.namespace !== "math") return false;
  return MATHML_TEXT_INTEGRATION_POINT_SET.has(
    integrationPointKey(node.namespace, node.name)
  );
}

function shouldUseForeignContent(state: TreeBuilderState, token: TreeToken): boolean {
  const current = state.openElements.at(-1)!;
  if (current.namespace === "html") return false;
  if (token.type === TokenKind.EOF) return false;

  if (isMathMLTextIntegrationPoint(current)) {
    if (token.type === TokenKind.Character) {
      return false;
    } else if (token.type === TokenKind.Tag && token.kind === TagKind.Start) {
      const nameLower = token.name.toLowerCase();
      if (nameLower !== "mglyph" && nameLower !== "malignmark") return false;
    }
  }

  if (
    current.namespace === "math" &&
    current.name === "annotation-xml" &&
    token.type === TokenKind.Tag &&
    token.kind === TagKind.Start &&
    token.name.toLowerCase() === "svg"
  ) {
    return false;
  }

  if (
    isHTMLIntegrationPoint(current) &&
    (token.type === TokenKind.Character ||
      (token.type === TokenKind.Tag && token.kind === TagKind.Start))
  ) {
    return false;
  }

  return true;
}

function foreignBreakoutFont(tag: TagToken): boolean {
  for (const name of tag.attrs.keys()) {
    const lowerName = name.toLowerCase();
    if (lowerName === "color" || lowerName === "face" || lowerName === "size") {
      return true;
    }
  }
  return false;
}

function popUntilHTMLOrIntegrationPoint(state: TreeBuilderState): void {
  const { fragmentContextElement, openElements } = state;
  while (openElements.length) {
    const node = openElements.at(-1)!;
    if (node.namespace == null || node.namespace === "html") return;
    if (isHTMLIntegrationPoint(node)) return;
    if (fragmentContextElement && node === fragmentContextElement) return;
    openElements.pop();
  }
}

function adjustSVGTagName(name: string): string {
  const lowered = name.toLowerCase();
  return SVG_TAG_NAME_ADJUSTMENTS.get(lowered) || name;
}

/** Handles token processing while inside foreign-content namespaces (SVG/MathML). */
function processForeignContent(state: TreeBuilderState, token: TreeToken): ModeResult {
  const { openElements } = state;
  const current = openElements.at(-1)!;

  if (token.type === TokenKind.Character) {
    const raw = token.data;
    const cleaned: string[] = [];
    let hasNonNullNonWs = false;
    for (const ch of raw) {
      if (ch === "\x00") {
        parseError(state, ErrorCode.InvalidCodepointInForeignContent);
        cleaned.push("\uFFFD");
        continue;
      }
      cleaned.push(ch);
      if (!"\t\n\f\r ".includes(ch)) hasNonNullNonWs = true;
    }
    const data = cleaned.join("");
    if (hasNonNullNonWs) state.framesetOk = false;
    appendText(state, data);
    return;
  } else if (token.type === TokenKind.Comment) {
    appendComment(state, token.data);
    return;
  }

  if (token.type !== TokenKind.Tag) return;

  const nameLower = token.name.toLowerCase();
  const { mode } = state;
  if (token.kind === TagKind.Start) {
    if (
      FOREIGN_BREAKOUT_ELEMENTS.has(nameLower) ||
      (nameLower === "font" && foreignBreakoutFont(token))
    ) {
      parseError(state, ErrorCode.UnexpectedHtmlElementInForeignContent);
      popUntilHTMLOrIntegrationPoint(state);
      resetInsertionMode(state);
      return reprocessInstruction(mode, token, true);
    }

    const { namespace } = current;
    let adjustedName = token.name;
    if (namespace === "svg") adjustedName = adjustSVGTagName(token.name);
    const attrs = prepareForeignAttributes(namespace, token.attrs);
    const newTag = createTagToken(TagKind.Start, adjustedName, attrs, token.selfClosing);
    insertElement(state, newTag, !token.selfClosing, namespace);
    return;
  }

  if (nameLower === "br" || nameLower === "p") {
    parseError(state, ErrorCode.UnexpectedHtmlElementInForeignContent);
    popUntilHTMLOrIntegrationPoint(state);
    resetInsertionMode(state);
    return reprocessInstruction(mode, token, true);
  }

  const { fragmentContextElement } = state;
  let idx = openElements.length - 1;
  let first = true;
  while (idx >= 0) {
    const node = openElements[idx]!;
    const isHtml = node.namespace == null || node.namespace === "html";
    const nameEq = node.name.toLowerCase() === nameLower;

    if (nameEq) {
      if (fragmentContextElement && node === fragmentContextElement) {
        parseError(state, ErrorCode.UnexpectedEndTagInFragmentContext);
        return;
      }
      if (isHtml) return reprocessInstruction(mode, token, true);
      openElements.splice(idx);
      return;
    }

    if (first) {
      parseError(state, ErrorCode.UnexpectedEndTagInForeignContent, token.name);
      first = false;
    }

    if (isHtml) return reprocessInstruction(mode, token, true);
    idx -= 1;
  }

  return;
}

export interface TokenizerSink {
  processToken: (token: Token) => TokenSinkResult | undefined;
  processCharacters: (data: string) => void;
  readonly openElements?: readonly Node[];
}

/** Exposes treebuilder state as a tokenizer sink. */
export function getTokenizerSink(state: TreeBuilderState): TokenizerSink {
  return {
    processToken: token => processToken(state, token),
    processCharacters(data) {
      processCharacters(state, data);
    },
    get openElements() {
      return state.openElements;
    },
  };
}
