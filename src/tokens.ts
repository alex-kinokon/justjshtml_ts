import type { NodeAttrMap } from "./node.ts";

export type AttrMap = Record<string, string | null>;

export type Token = TagToken | CharacterToken | CommentToken | DoctypeToken | EOFToken;

export const enum TagKind {
  Start,
  End,
}

export enum TokenKind {
  Tag,
  Character,
  Comment,
  Doctype,
  EOF,
}

export interface TagToken {
  readonly type: TokenKind.Tag;
  readonly kind: TagKind;
  readonly name: string;
  readonly attrs: NodeAttrMap;
  readonly selfClosing: boolean;
}

export function createTagToken(
  kind: TagKind,
  name: string,
  attrs: NodeAttrMap,
  selfClosing = false
): TagToken {
  return { type: TokenKind.Tag, kind, name, attrs, selfClosing };
}

export interface CharacterToken {
  readonly type: TokenKind.Character;
  readonly data: string;
}

export function createCharacterToken(data: string): CharacterToken {
  return { type: TokenKind.Character, data };
}

export interface CommentToken {
  readonly type: TokenKind.Comment;
  readonly data: string;
}

export function createCommentToken(data: string): CommentToken {
  return { type: TokenKind.Comment, data };
}

export class Doctype {
  readonly name: string | undefined;
  readonly publicId: string | undefined;
  readonly systemId: string | undefined;
  readonly forceQuirks: boolean;

  constructor({
    name,
    publicId,
    systemId,
    forceQuirks = false,
  }: {
    name?: string | undefined;
    publicId?: string | undefined;
    systemId?: string | undefined;
    forceQuirks?: boolean;
  } = {}) {
    this.name = name;
    this.publicId = publicId;
    this.systemId = systemId;
    this.forceQuirks = forceQuirks;
  }
}

export interface DoctypeToken {
  readonly type: TokenKind.Doctype;
  readonly doctype: Doctype;
}

export function createDocTypeToken(doctype: Doctype): DoctypeToken {
  return { type: TokenKind.Doctype, doctype };
}

export interface EOFToken {
  readonly type: TokenKind.EOF;
}

export function eofToken(): EOFToken {
  return { type: TokenKind.EOF };
}

export const enum TokenSinkResult {
  Continue,
  Plaintext,
}
