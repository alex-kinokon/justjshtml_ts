import {
  BUTTON_SCOPE_TERMINATORS,
  DEFAULT_SCOPE_TERMINATORS,
  DEFINITION_SCOPE_TERMINATORS,
  FOREIGN_ATTRIBUTE_ADJUSTMENTS,
  FOREIGN_BREAKOUT_ELEMENTS,
  FORMAT_MARKER,
  FORMATTING_ELEMENTS,
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
} from "./constants.js";
import { FragmentContext } from "./context.js";
import { Node } from "./node.js";
import { CharacterToken, CommentToken, DoctypeToken, EOFToken, ParseError, Tag, TokenSinkResult } from "./tokens.js";
import { InsertionMode, doctypeErrorAndQuirks, isAllWhitespace } from "./treebuilder_utils.js";

function lowerAscii(value) {
  return value ? String(value).toLowerCase() : "";
}

function isTemplateNode(node) {
  return node && node.name === "template" && node.templateContent;
}

// ---- Insertion mode handlers (incremental port) ---------------------------

function handleDoctype(self, token) {
  if (self.mode !== InsertionMode.INITIAL) {
    self._parse_error("unexpected-doctype");
    return TokenSinkResult.Continue;
  }

  const doctype = token.doctype;
  const [parseError, quirksMode] = doctypeErrorAndQuirks(doctype, { iframeSrcdoc: self.iframe_srcdoc });

  const node = new Node("!doctype", { data: doctype, namespace: null });
  self.document.append_child(node);

  if (parseError) self._parse_error("unknown-doctype");

  self._set_quirks_mode(quirksMode);
  self.mode = InsertionMode.BEFORE_HTML;
  return TokenSinkResult.Continue;
}

function modeInitial(self, token) {
  if (token instanceof CharacterToken) {
    if (isAllWhitespace(token.data)) return null;
    self._parse_error("expected-doctype-but-got-chars");
    self._set_quirks_mode("quirks");
    return ["reprocess", InsertionMode.BEFORE_HTML, token];
  }
  if (token instanceof CommentToken) {
    self._append_comment_to_document(token.data);
    return null;
  }
  if (token instanceof EOFToken) {
    self._parse_error("expected-doctype-but-got-eof");
    self._set_quirks_mode("quirks");
    self.mode = InsertionMode.BEFORE_HTML;
    return ["reprocess", InsertionMode.BEFORE_HTML, token];
  }

  if (token instanceof Tag) {
    if (token.kind === Tag.START) self._parse_error("expected-doctype-but-got-start-tag", token.name);
    else self._parse_error("expected-doctype-but-got-end-tag", token.name);
  }
  self._set_quirks_mode("quirks");
  return ["reprocess", InsertionMode.BEFORE_HTML, token];
}

function modeBeforeHtml(self, token) {
  if (token instanceof CharacterToken && isAllWhitespace(token.data)) return null;
  if (token instanceof CommentToken) {
    self._append_comment_to_document(token.data);
    return null;
  }

  if (token instanceof Tag) {
    if (token.kind === Tag.START && token.name === "html") {
      self._create_root(token.attrs);
      self.mode = InsertionMode.BEFORE_HEAD;
      return null;
    }
    if (token.kind === Tag.END && ["head", "body", "html", "br"].includes(token.name)) {
      self._create_root({});
      self.mode = InsertionMode.BEFORE_HEAD;
      return ["reprocess", InsertionMode.BEFORE_HEAD, token];
    }
    if (token.kind === Tag.END) {
      self._parse_error("unexpected-end-tag-before-html", token.name);
      return null;
    }
  }

  if (token instanceof EOFToken) {
    self._create_root({});
    self.mode = InsertionMode.BEFORE_HEAD;
    return ["reprocess", InsertionMode.BEFORE_HEAD, token];
  }

  if (token instanceof CharacterToken) {
    const stripped = token.data.replace(/^[\t\n\f\r ]+/, "");
    if (stripped.length !== token.data.length) token = new CharacterToken(stripped);
  }

  self._create_root({});
  self.mode = InsertionMode.BEFORE_HEAD;
  return ["reprocess", InsertionMode.BEFORE_HEAD, token];
}

function modeBeforeHead(self, token) {
  if (token instanceof CharacterToken) {
    let data = token.data || "";
    if (data.includes("\x00")) {
      self._parse_error("invalid-codepoint-before-head");
      data = data.replaceAll("\x00", "");
      if (!data) return null;
    }
    if (isAllWhitespace(data)) return null;
    token = new CharacterToken(data);
  }

  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    if (token.kind === Tag.START && token.name === "html") {
      const html = self.open_elements[0];
      self._add_missing_attributes(html, token.attrs);
      return null;
    }
    if (token.kind === Tag.START && token.name === "head") {
      const head = self._insert_element(token, { push: true });
      self.head_element = head;
      self.mode = InsertionMode.IN_HEAD;
      return null;
    }
    if (token.kind === Tag.END && ["head", "body", "html", "br"].includes(token.name)) {
      self.head_element = self._insert_phantom("head");
      self.mode = InsertionMode.IN_HEAD;
      return ["reprocess", InsertionMode.IN_HEAD, token];
    }
    if (token.kind === Tag.END) {
      self._parse_error("unexpected-end-tag-before-head", token.name);
      return null;
    }
  }

  if (token instanceof EOFToken) {
    self.head_element = self._insert_phantom("head");
    self.mode = InsertionMode.IN_HEAD;
    return ["reprocess", InsertionMode.IN_HEAD, token];
  }

  self.head_element = self._insert_phantom("head");
  self.mode = InsertionMode.IN_HEAD;
  return ["reprocess", InsertionMode.IN_HEAD, token];
}

function modeInHead(self, token) {
  if (token instanceof CharacterToken) {
    if (isAllWhitespace(token.data)) {
      self._append_text(token.data);
      return null;
    }

    const data = token.data || "";
    let i = 0;
    while (i < data.length && "\t\n\f\r ".includes(data[i])) i += 1;
    const leadingWs = data.slice(0, i);
    const remaining = data.slice(i);
    if (leadingWs) {
      const current = self.open_elements.length ? self.open_elements[self.open_elements.length - 1] : null;
      if (current && current.has_child_nodes()) self._append_text(leadingWs);
    }
    self._pop_current();
    self.mode = InsertionMode.AFTER_HEAD;
    return ["reprocess", InsertionMode.AFTER_HEAD, new CharacterToken(remaining)];
  }

  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    if (token.kind === Tag.START && token.name === "html") {
      self._pop_current();
      self.mode = InsertionMode.AFTER_HEAD;
      return ["reprocess", InsertionMode.AFTER_HEAD, token];
    }

    if (token.kind === Tag.START && ["base", "basefont", "bgsound", "link", "meta"].includes(token.name)) {
      self._insert_element(token, { push: false });
      return null;
    }

    if (token.kind === Tag.START && token.name === "template") {
      self._insert_element(token, { push: true });
      self._push_formatting_marker();
      self.frameset_ok = false;
      self.mode = InsertionMode.IN_TEMPLATE;
      self.template_modes.push(InsertionMode.IN_TEMPLATE);
      return null;
    }

    if (token.kind === Tag.END && token.name === "template") {
      const hasTemplate = self.open_elements.some((node) => node.name === "template");
      if (!hasTemplate) return null;
      self._generate_implied_end_tags();
      self._pop_until_inclusive("template");
      self._clear_active_formatting_up_to_marker();
      self.template_modes.pop();
      self._reset_insertion_mode();
      return null;
    }

    if (token.kind === Tag.START && ["title", "style", "script", "noframes"].includes(token.name)) {
      self._insert_element(token, { push: true });
      self.original_mode = self.mode;
      self.mode = InsertionMode.TEXT;
      return null;
    }

    if (token.kind === Tag.START && token.name === "noscript") {
      self._insert_element(token, { push: true });
      self.mode = InsertionMode.IN_HEAD_NOSCRIPT;
      return null;
    }

    if (token.kind === Tag.END && token.name === "head") {
      self._pop_current();
      self.mode = InsertionMode.AFTER_HEAD;
      return null;
    }

    if (token.kind === Tag.END && ["body", "html", "br"].includes(token.name)) {
      self._pop_current();
      self.mode = InsertionMode.AFTER_HEAD;
      return ["reprocess", InsertionMode.AFTER_HEAD, token];
    }
  }

  if (token instanceof EOFToken) {
    self._pop_current();
    self.mode = InsertionMode.AFTER_HEAD;
    return ["reprocess", InsertionMode.AFTER_HEAD, token];
  }

  self._pop_current();
  self.mode = InsertionMode.AFTER_HEAD;
  return ["reprocess", InsertionMode.AFTER_HEAD, token];
}

function modeInHeadNoscript(self, token) {
  if (token instanceof CharacterToken) {
    const data = token.data || "";
    if (isAllWhitespace(data)) return modeInHead(self, token);
    self._parse_error("unexpected-start-tag", "text");
    self._pop_current();
    self.mode = InsertionMode.IN_HEAD;
    return ["reprocess", InsertionMode.IN_HEAD, token];
  }
  if (token instanceof CommentToken) return modeInHead(self, token);
  if (token instanceof Tag) {
    if (token.kind === Tag.START) {
      if (token.name === "html") return modeInBody(self, token);
      if (["basefont", "bgsound", "link", "meta", "noframes", "style"].includes(token.name)) return modeInHead(self, token);
      if (["head", "noscript"].includes(token.name)) {
        self._parse_error("unexpected-start-tag", token.name);
        return null;
      }
      self._parse_error("unexpected-start-tag", token.name);
      self._pop_current();
      self.mode = InsertionMode.IN_HEAD;
      return ["reprocess", InsertionMode.IN_HEAD, token];
    }
    if (token.name === "noscript") {
      self._pop_current();
      self.mode = InsertionMode.IN_HEAD;
      return null;
    }
    if (token.name === "br") {
      self._parse_error("unexpected-end-tag", token.name);
      self._pop_current();
      self.mode = InsertionMode.IN_HEAD;
      return ["reprocess", InsertionMode.IN_HEAD, token];
    }
    self._parse_error("unexpected-end-tag", token.name);
    return null;
  }
  if (token instanceof EOFToken) {
    self._parse_error("expected-closing-tag-but-got-eof", "noscript");
    self._pop_current();
    self.mode = InsertionMode.IN_HEAD;
    return ["reprocess", InsertionMode.IN_HEAD, token];
  }
  return null;
}

function modeAfterHead(self, token) {
  if (token instanceof CharacterToken) {
    let data = token.data || "";
    if (data.includes("\x00")) {
      self._parse_error("invalid-codepoint-in-body");
      data = data.replaceAll("\x00", "");
    }
    if (data.includes("\x0c")) {
      self._parse_error("invalid-codepoint-in-body");
      data = data.replaceAll("\x0c", "");
    }
    if (!data || isAllWhitespace(data)) {
      if (data) self._append_text(data);
      return null;
    }
    self._insert_body_if_missing();
    return ["reprocess", InsertionMode.IN_BODY, new CharacterToken(data)];
  }

  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }

  if (token instanceof Tag) {
    if (token.kind === Tag.START && token.name === "html") {
      self._insert_body_if_missing();
      return ["reprocess", InsertionMode.IN_BODY, token];
    }
    if (token.kind === Tag.START && token.name === "body") {
      self._insert_element(token, { push: true });
      self.mode = InsertionMode.IN_BODY;
      self.frameset_ok = false;
      return null;
    }

    // Many additional rules not yet ported (frameset, head-only, etc).
    self._insert_body_if_missing();
    return ["reprocess", InsertionMode.IN_BODY, token];
  }

  if (token instanceof EOFToken) {
    self._insert_body_if_missing();
    self.mode = InsertionMode.IN_BODY;
    return ["reprocess", InsertionMode.IN_BODY, token];
  }

  self._insert_body_if_missing();
  return ["reprocess", InsertionMode.IN_BODY, token];
}

function modeText(self, token) {
  if (token instanceof CharacterToken) {
    self._append_text(token.data);
    return null;
  }
  if (token instanceof EOFToken) {
    const tagName = self.open_elements.length ? self.open_elements[self.open_elements.length - 1].name : null;
    self._parse_error("expected-named-closing-tag-but-got-eof", tagName);
    self._pop_current();
    self.mode = self.original_mode || InsertionMode.IN_BODY;
    return ["reprocess", self.mode, token];
  }
  self._pop_current();
  self.mode = self.original_mode || InsertionMode.IN_BODY;
  return null;
}

function modeInBody(self, token) {
  // Minimal IN_BODY implementation to get early tree-construction tests running.
  if (token instanceof CharacterToken) {
    let data = token.data || "";
    if (data.includes("\x00")) {
      self._parse_error("invalid-codepoint");
      data = data.replaceAll("\x00", "");
    }
    if (!data) return null;
    if (isAllWhitespace(data)) {
      self._append_text(data);
      return null;
    }
    self.frameset_ok = false;
    self._append_text(data);
    return null;
  }
  if (token instanceof CommentToken) {
    self._append_comment(token.data);
    return null;
  }
  if (token instanceof Tag) {
    if (token.kind === Tag.START) {
      if (token.name === "html") {
        const html = self.open_elements.length ? self.open_elements[0] : null;
        if (html) self._add_missing_attributes(html, token.attrs);
        return null;
      }
      if (token.name === "body") {
        // Ignore extra body.
        return null;
      }
      self._insert_element(token, { push: !token.selfClosing });
      return null;
    }
    // End tags: pop if matches current element, else ignore.
    const name = token.name;
    if (name === "body" || name === "html") {
      self.mode = InsertionMode.AFTER_BODY;
      return null;
    }
    if (self.open_elements.length && self.open_elements[self.open_elements.length - 1].name === name) {
      self._pop_current();
    }
    return null;
  }
  if (token instanceof EOFToken) {
    return null;
  }
  return null;
}

function modeAfterBody(self, token) {
  if (token instanceof CharacterToken && isAllWhitespace(token.data)) return modeInBody(self, token);
  if (token instanceof CommentToken) {
    const html = self.open_elements.length ? self.open_elements[0] : null;
    self._append_comment(token.data, html || undefined);
    return null;
  }
  if (token instanceof Tag) {
    if (token.kind === Tag.START && token.name === "html") return modeInBody(self, token);
    if (token.kind === Tag.END && token.name === "html") {
      self.mode = InsertionMode.AFTER_AFTER_BODY;
      return null;
    }
  }
  if (token instanceof EOFToken) return null;
  self._parse_error("unexpected-token-after-body");
  self.mode = InsertionMode.IN_BODY;
  return ["reprocess", InsertionMode.IN_BODY, token];
}

function modeAfterAfterBody(self, token) {
  if (token instanceof CommentToken) {
    self._append_comment_to_document(token.data);
    return null;
  }
  if (token instanceof CharacterToken && isAllWhitespace(token.data)) return modeInBody(self, token);
  if (token instanceof Tag && token.kind === Tag.START && token.name === "html") return modeInBody(self, token);
  if (token instanceof EOFToken) return null;
  self._parse_error("unexpected-token-after-after-body");
  self.mode = InsertionMode.IN_BODY;
  return ["reprocess", InsertionMode.IN_BODY, token];
}

// Placeholder modes - will be fully ported in later milestones.
function modeFallbackToBody(self, token) {
  self.mode = InsertionMode.IN_BODY;
  return ["reprocess", InsertionMode.IN_BODY, token];
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
  modeFallbackToBody, // IN_TABLE
  modeFallbackToBody, // IN_TABLE_TEXT
  modeFallbackToBody, // IN_CAPTION
  modeFallbackToBody, // IN_COLUMN_GROUP
  modeFallbackToBody, // IN_TABLE_BODY
  modeFallbackToBody, // IN_ROW
  modeFallbackToBody, // IN_CELL
  modeFallbackToBody, // IN_FRAMESET
  modeFallbackToBody, // AFTER_FRAMESET
  modeFallbackToBody, // AFTER_AFTER_FRAMESET
  modeFallbackToBody, // IN_SELECT
  modeFallbackToBody, // IN_TEMPLATE
];

export class TreeBuilder {
  constructor(fragment_context = null, iframe_srcdoc = false, collect_errors = false) {
    this.fragment_context = fragment_context;
    this.iframe_srcdoc = Boolean(iframe_srcdoc);
    this.collect_errors = Boolean(collect_errors);

    this.errors = [];
    this.tokenizer = null;
    this.fragment_context_element = null;

    if (fragment_context != null) this.document = new Node("#document-fragment", { namespace: null });
    else this.document = new Node("#document", { namespace: null });

    this.mode = InsertionMode.INITIAL;
    this.original_mode = null;
    this.table_text_original_mode = null;
    this.open_elements = [];
    this.head_element = null;
    this.form_element = null;
    this.frameset_ok = true;
    this.quirks_mode = "no-quirks";
    this.ignore_lf = false;
    this.active_formatting = [];
    this.insert_from_table = false;
    this.pending_table_text = [];
    this.template_modes = [];
    this.tokenizer_state_override = null;

    if (fragment_context != null) {
      // Fragment parsing per HTML5 spec
      const root = this._create_element("html", null, {});
      this.document.append_child(root);
      this.open_elements.push(root);

      const namespace = fragment_context.namespace;
      const contextName = fragment_context.tag_name || fragment_context.tagName || "";
      const name = contextName.toLowerCase();

      if (namespace && namespace !== "html") {
        let adjustedName = contextName;
        if (namespace === "svg") adjustedName = this._adjust_svg_tag_name(contextName);
        const contextElement = this._create_element(adjustedName, namespace, {});
        root.append_child(contextElement);
        this.open_elements.push(contextElement);
        this.fragment_context_element = contextElement;
      }

      if (name === "html") this.mode = InsertionMode.BEFORE_HEAD;
      else if ((namespace == null || namespace === "html") && ["tbody", "thead", "tfoot"].includes(name))
        this.mode = InsertionMode.IN_TABLE_BODY;
      else if ((namespace == null || namespace === "html") && name === "tr") this.mode = InsertionMode.IN_ROW;
      else if ((namespace == null || namespace === "html") && ["td", "th"].includes(name)) this.mode = InsertionMode.IN_CELL;
      else if ((namespace == null || namespace === "html") && name === "caption") this.mode = InsertionMode.IN_CAPTION;
      else if ((namespace == null || namespace === "html") && name === "colgroup") this.mode = InsertionMode.IN_COLUMN_GROUP;
      else if ((namespace == null || namespace === "html") && name === "table") this.mode = InsertionMode.IN_TABLE;
      else this.mode = InsertionMode.IN_BODY;

      this.frameset_ok = false;
    }
  }

  _set_quirks_mode(mode) {
    this.quirks_mode = mode;
  }

  _parse_error(code, tag_name = null) {
    if (!this.collect_errors) return;
    this.errors.push(new ParseError(code, { message: tag_name ? `${code}: ${tag_name}` : code }));
  }

  _has_element_in_scope(target, terminators = null, checkIntegrationPoints = true) {
    const terms = terminators || DEFAULT_SCOPE_TERMINATORS;
    for (let idx = this.open_elements.length - 1; idx >= 0; idx -= 1) {
      const node = this.open_elements[idx];
      if (node.name === target) return true;

      const ns = node.namespace;
      if (ns === "html" || ns == null) {
        if (terms.has(node.name)) return false;
      } else if (checkIntegrationPoints && (this._is_html_integration_point(node) || this._is_mathml_text_integration_point(node))) {
        return false;
      }
    }
    return false;
  }

  _has_element_in_button_scope(target) {
    return this._has_element_in_scope(target, BUTTON_SCOPE_TERMINATORS);
  }

  _pop_until_inclusive(name) {
    while (this.open_elements.length) {
      const node = this.open_elements.pop();
      if (node.name === name) break;
    }
  }

  _pop_until_any_inclusive(names) {
    while (this.open_elements.length) {
      const node = this.open_elements.pop();
      if (names.has(node.name)) return;
    }
  }

  _generate_implied_end_tags(exclude = null) {
    while (this.open_elements.length) {
      const node = this.open_elements[this.open_elements.length - 1];
      if (IMPLIED_END_TAGS.has(node.name) && node.name !== exclude) {
        this.open_elements.pop();
        continue;
      }
      break;
    }
  }

  _clear_active_formatting_up_to_marker() {
    while (this.active_formatting.length) {
      const entry = this.active_formatting.pop();
      if (entry === FORMAT_MARKER) break;
    }
  }

  _push_formatting_marker() {
    this.active_formatting.push(FORMAT_MARKER);
  }

  _reset_insertion_mode() {
    for (let idx = this.open_elements.length - 1; idx >= 0; idx -= 1) {
      const node = this.open_elements[idx];
      const name = node.name;
      if (name === "head") {
        this.mode = InsertionMode.IN_HEAD;
        return;
      }
      if (name === "html") {
        this.mode = InsertionMode.IN_BODY;
        return;
      }
    }
    this.mode = InsertionMode.IN_BODY;
  }

  process_token(token) {
    return this.processToken(token);
  }

  processToken(token) {
    if (token instanceof DoctypeToken) {
      if (this.open_elements.length) {
        const current = this.open_elements[this.open_elements.length - 1];
        if (current.namespace != null && current.namespace !== "html") {
          this._parse_error("unexpected-doctype");
          return TokenSinkResult.Continue;
        }
      }
      return handleDoctype(this, token);
    }

    let currentToken = token;
    let forceHtmlMode = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const currentNode = this.open_elements.length ? this.open_elements[this.open_elements.length - 1] : null;
      const isHtmlNamespace = currentNode == null || currentNode.namespace == null || currentNode.namespace === "html";

      if (!forceHtmlMode && !isHtmlNamespace && this._should_use_foreign_content(currentToken)) {
        const result = this._process_foreign_content(currentToken);
        if (result == null) {
          const out = this.tokenizer_state_override ?? TokenSinkResult.Continue;
          this.tokenizer_state_override = null;
          return out;
        }
        const [, mode, tokenOverride, forceHtml] = result;
        this.mode = mode;
        currentToken = tokenOverride;
        forceHtmlMode = Boolean(forceHtml);
        continue;
      }

      forceHtmlMode = false;
      const handler = MODE_HANDLERS[this.mode] || modeFallbackToBody;
      const result = handler(this, currentToken);

      if (result == null) {
        const out = this.tokenizer_state_override ?? TokenSinkResult.Continue;
        this.tokenizer_state_override = null;
        return out;
      }

      const [, mode, tokenOverride, forceHtml] = result;
      this.mode = mode;
      currentToken = tokenOverride;
      forceHtmlMode = Boolean(forceHtml);
    }
  }

  process_characters(data) {
    return this.processCharacters(data);
  }

  processCharacters(data) {
    const currentNode = this.open_elements.length ? this.open_elements[this.open_elements.length - 1] : null;
    const isHtmlNamespace = currentNode == null || currentNode.namespace == null || currentNode.namespace === "html";
    if (!isHtmlNamespace) return this.processToken(new CharacterToken(data));
    return this.processToken(new CharacterToken(data));
  }

  finish() {
    if (this.fragment_context != null) {
      const root = this.document.children[0];
      const contextElem = this.fragment_context_element;
      if (contextElem && contextElem.parent === root) {
        for (const child of [...contextElem.children]) {
          contextElem.remove_child(child);
          root.append_child(child);
        }
        root.remove_child(contextElem);
      }
      for (const child of [...root.children]) {
        root.remove_child(child);
        this.document.append_child(child);
      }
      this.document.remove_child(root);
    }

    return this.document;
  }

  // ---------------- Insertion helpers ----------------

  _append_comment_to_document(text) {
    this.document.append_child(new Node("#comment", { data: text, namespace: null }));
  }

  _append_comment(text, parent = null) {
    let target = parent;
    if (!target) target = this._current_node_or_html();
    if (isTemplateNode(target)) target = target.templateContent;
    target.append_child(new Node("#comment", { data: text, namespace: null }));
  }

  _append_text(text) {
    if (!text) return;
    if (this.ignore_lf) {
      this.ignore_lf = false;
      if (text.startsWith("\n")) {
        text = text.slice(1);
        if (!text) return;
      }
    }

    if (!this.open_elements.length) return;
    const target = this._current_node_or_html();
    let parent = target;
    if (isTemplateNode(parent)) parent = parent.templateContent;

    const children = parent.children;
    if (children.length && children[children.length - 1].name === "#text") {
      children[children.length - 1].data = (children[children.length - 1].data || "") + text;
      return;
    }
    parent.append_child(new Node("#text", { data: text, namespace: null }));
  }

  _current_node_or_html() {
    if (this.open_elements.length) return this.open_elements[this.open_elements.length - 1];
    for (const child of this.document.children) {
      if (child.name === "html") return child;
    }
    return this.document.children.length ? this.document.children[0] : null;
  }

  _create_root(attrs) {
    const node = new Node("html", { attrs: attrs || {}, namespace: "html" });
    this.document.append_child(node);
    this.open_elements.push(node);
    return node;
  }

  _insert_element(tag, { push, namespace = "html" } = {}) {
    const node = new Node(tag.name, { attrs: tag.attrs || {}, namespace });

    if (!this.insert_from_table) {
      const target = this._current_node_or_html();
      const parent = isTemplateNode(target) ? target.templateContent : target;
      parent.append_child(node);
      if (push) this.open_elements.push(node);
      return node;
    }

    const target = this._current_node_or_html();
    const foster = this._should_foster_parenting(target, { forTag: tag.name });
    const [parent, position] = this._appropriate_insertion_location(null, { foster_parenting: foster });
    this._insert_node_at(parent, position, node);
    if (push) this.open_elements.push(node);
    return node;
  }

  _insert_phantom(name) {
    const tag = new Tag(Tag.START, name, {}, false);
    return this._insert_element(tag, { push: true });
  }

  _insert_body_if_missing() {
    const htmlNode = this._find_last_on_stack("html");
    const node = new Node("body", { namespace: "html" });
    htmlNode.append_child(node);
    this.open_elements.push(node);
  }

  _create_element(name, namespace, attrs) {
    const ns = namespace || "html";
    return new Node(name, { attrs: attrs || {}, namespace: ns });
  }

  _pop_current() {
    return this.open_elements.pop();
  }

  _add_missing_attributes(node, attrs) {
    if (!attrs) return;
    const existing = node.attrs || {};
    for (const [name, value] of Object.entries(attrs)) {
      if (!Object.prototype.hasOwnProperty.call(existing, name)) existing[name] = value;
    }
    node.attrs = existing;
  }

  _find_last_on_stack(name) {
    for (let idx = this.open_elements.length - 1; idx >= 0; idx -= 1) {
      const node = this.open_elements[idx];
      if (node.name === name) return node;
    }
    return null;
  }

  _insert_node_at(parent, index, node) {
    const ref = index != null && index < parent.children.length ? parent.children[index] : null;
    parent.insert_before(node, ref);
  }

  _appropriate_insertion_location(override_target = null, { foster_parenting = false } = {}) {
    const target = override_target || this._current_node_or_html();
    if (foster_parenting && TABLE_FOSTER_TARGETS.has(target.name)) {
      const lastTemplate = this._find_last_on_stack("template");
      const lastTable = this._find_last_on_stack("table");
      if (
        lastTemplate &&
        (lastTable == null || this.open_elements.indexOf(lastTemplate) > this.open_elements.indexOf(lastTable))
      ) {
        return [lastTemplate.templateContent, lastTemplate.templateContent.children.length];
      }
      if (!lastTable) return [target, target.children.length];
      const parent = lastTable.parent;
      if (!parent) return [target, target.children.length];
      const pos = parent.children.indexOf(lastTable);
      return [parent, pos];
    }
    if (isTemplateNode(target)) return [target.templateContent, target.templateContent.children.length];
    return [target, target.children.length];
  }

  _has_in_table_scope(name) {
    return this._has_element_in_scope(name, TABLE_SCOPE_TERMINATORS, false);
  }

  _should_foster_parenting(target, { forTag = null, isText = false } = {}) {
    if (!this.insert_from_table) return false;
    if (!TABLE_FOSTER_TARGETS.has(target.name)) return false;
    if (isText) return true;
    if (forTag && TABLE_ALLOWED_CHILDREN.has(forTag)) return false;
    return true;
  }

  _prepare_foreign_attributes(namespace, attrs) {
    if (!attrs) return {};
    const adjusted = {};
    for (const [name0, value] of Object.entries(attrs)) {
      let name = name0;
      let lowerName = lowerAscii(name);

      if (namespace === "math" && Object.prototype.hasOwnProperty.call(MATHML_ATTRIBUTE_ADJUSTMENTS, lowerName)) {
        name = MATHML_ATTRIBUTE_ADJUSTMENTS[lowerName];
        lowerName = lowerAscii(name);
      } else if (namespace === "svg" && Object.prototype.hasOwnProperty.call(SVG_ATTRIBUTE_ADJUSTMENTS, lowerName)) {
        name = SVG_ATTRIBUTE_ADJUSTMENTS[lowerName];
        lowerName = lowerAscii(name);
      }

      const foreignAdjustment = FOREIGN_ATTRIBUTE_ADJUSTMENTS[lowerName];
      if (foreignAdjustment != null) {
        const [prefix, local] = foreignAdjustment;
        name = prefix ? `${prefix}:${local}` : local;
      }

      adjusted[name] = value;
    }
    return adjusted;
  }

  _node_attribute_value(node, name) {
    const target = lowerAscii(name);
    const attrs = node?.attrs || {};
    for (const [attrName, attrValue] of Object.entries(attrs)) {
      if (lowerAscii(attrName) === target) return attrValue || "";
    }
    return null;
  }

  _is_html_integration_point(node) {
    if (node.namespace === "math" && node.name === "annotation-xml") {
      const encoding = this._node_attribute_value(node, "encoding");
      if (encoding) {
        const encLower = String(encoding).toLowerCase();
        if (encLower === "text/html" || encLower === "application/xhtml+xml") return true;
      }
      return false;
    }
    return HTML_INTEGRATION_POINT_SET.has(integrationPointKey(node.namespace, node.name));
  }

  _is_mathml_text_integration_point(node) {
    if (node.namespace !== "math") return false;
    return MATHML_TEXT_INTEGRATION_POINT_SET.has(integrationPointKey(node.namespace, node.name));
  }

  _should_use_foreign_content(token) {
    const current = this.open_elements[this.open_elements.length - 1];
    if (current.namespace == null || current.namespace === "html") return false;
    if (token instanceof EOFToken) return false;

    if (this._is_mathml_text_integration_point(current)) {
      if (token instanceof CharacterToken) return false;
      if (token instanceof Tag && token.kind === Tag.START) {
        const nameLower = lowerAscii(token.name);
        if (nameLower !== "mglyph" && nameLower !== "malignmark") return false;
      }
    }

    if (current.namespace === "math" && current.name === "annotation-xml") {
      if (token instanceof Tag && token.kind === Tag.START) {
        if (lowerAscii(token.name) === "svg") return false;
      }
    }

    if (this._is_html_integration_point(current)) {
      if (token instanceof CharacterToken) return false;
      if (token instanceof Tag && token.kind === Tag.START) return false;
    }

    return true;
  }

  _foreign_breakout_font(tag) {
    const attrs = tag.attrs || {};
    for (const name of Object.keys(attrs)) {
      const lowerName = lowerAscii(name);
      if (lowerName === "color" || lowerName === "face" || lowerName === "size") return true;
    }
    return false;
  }

  _pop_until_html_or_integration_point() {
    while (this.open_elements.length) {
      const node = this.open_elements[this.open_elements.length - 1];
      if (node.namespace == null || node.namespace === "html") return;
      if (this._is_html_integration_point(node)) return;
      if (this.fragment_context_element && node === this.fragment_context_element) return;
      this.open_elements.pop();
    }
  }

  _adjust_svg_tag_name(name) {
    const lowered = lowerAscii(name);
    return SVG_TAG_NAME_ADJUSTMENTS[lowered] || name;
  }

  _process_foreign_content(token) {
    const current = this.open_elements[this.open_elements.length - 1];

    if (token instanceof CharacterToken) {
      const raw = token.data || "";
      const cleaned = [];
      let hasNonNullNonWs = false;
      for (const ch of raw) {
        if (ch === "\x00") {
          this._parse_error("invalid-codepoint-in-foreign-content");
          cleaned.push("\ufffd");
          continue;
        }
        cleaned.push(ch);
        if (!"\t\n\f\r ".includes(ch)) hasNonNullNonWs = true;
      }
      const data = cleaned.join("");
      if (hasNonNullNonWs) this.frameset_ok = false;
      this._append_text(data);
      return null;
    }

    if (token instanceof CommentToken) {
      this._append_comment(token.data);
      return null;
    }

    if (!(token instanceof Tag)) return null;

    const nameLower = lowerAscii(token.name);
    if (token.kind === Tag.START) {
      if (FOREIGN_BREAKOUT_ELEMENTS.has(nameLower) || (nameLower === "font" && this._foreign_breakout_font(token))) {
        this._parse_error("unexpected-html-element-in-foreign-content");
        this._pop_until_html_or_integration_point();
        this._reset_insertion_mode();
        return ["reprocess", this.mode, token, true];
      }

      const namespace = current.namespace;
      let adjustedName = token.name;
      if (namespace === "svg") adjustedName = this._adjust_svg_tag_name(token.name);
      const attrs = this._prepare_foreign_attributes(namespace, token.attrs);
      const newTag = new Tag(Tag.START, adjustedName, attrs, token.selfClosing);
      this._insert_element(newTag, { push: !token.selfClosing, namespace });
      return null;
    }

    if (nameLower === "br" || nameLower === "p") {
      this._parse_error("unexpected-html-element-in-foreign-content");
      this._pop_until_html_or_integration_point();
      this._reset_insertion_mode();
      return ["reprocess", this.mode, token, true];
    }

    let idx = this.open_elements.length - 1;
    let first = true;
    while (idx >= 0) {
      const node = this.open_elements[idx];
      const isHtml = node.namespace == null || node.namespace === "html";
      const nameEq = lowerAscii(node.name) === nameLower;

      if (nameEq) {
        if (this.fragment_context_element && node === this.fragment_context_element) {
          this._parse_error("unexpected-end-tag-in-fragment-context");
          return null;
        }
        if (isHtml) return ["reprocess", this.mode, token, true];
        this.open_elements.splice(idx);
        return null;
      }

      if (first) {
        this._parse_error("unexpected-end-tag-in-foreign-content", token.name);
        first = false;
      }

      if (isHtml) return ["reprocess", this.mode, token, true];
      idx -= 1;
    }

    return null;
  }
}

