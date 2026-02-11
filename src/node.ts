import { querySelectorAll } from "./selector.ts";
import { nodeToHTML } from "./serialize.ts";
import type { AttrMap, Doctype } from "./tokens.ts";

type NodeNamespace = "html" | "svg" | "mathml" | null | (string & {});
export type NodeAttrMap = Map<string, string | null>;

export interface ToTextOptions {
  readonly separator?: string;
  readonly strip?: boolean;
}

export interface ToHTMLOptions {
  readonly indent?: number;
  readonly indentSize?: number;
  readonly pretty?: boolean;
}

/**
 * Mutable tree node used throughout parsing, querying, and serialization.
 */
export class Node {
  parentNode: Node | undefined;
  templateContent: Node | undefined;
  readonly childNodes: Node[] = [];
  attrs: NodeAttrMap;

  /**
   * Creates a node with optional attributes, text/doctype payload, and namespace.
   */
  constructor(
    readonly name: string,
    public data?: string | Doctype,
    readonly namespace: NodeNamespace = "html",
    attrs: NodeAttrMap = new Map()
  ) {
    this.attrs = attrs;
    if (name === "template" && this.namespace === "html") {
      this.templateContent = new Node("#document-fragment");
    }
  }

  appendChild(node: Node): void {
    this.childNodes.push(node);
    node.parentNode = this;
  }

  removeChild(node: Node): void {
    const i = this.childNodes.indexOf(node);
    if (i === -1) {
      throw new Error("Node is not a child of this node");
    }
    this.childNodes.splice(i, 1);
    node.parentNode = undefined;
  }

  insertBefore(node: Node, referenceNode: Node | undefined): void {
    if (referenceNode == null) {
      this.appendChild(node);
      return;
    }
    const i = this.childNodes.indexOf(referenceNode);
    if (i === -1) {
      throw new Error("Reference node is not a child of this node");
    }
    this.childNodes.splice(i, 0, node);
    node.parentNode = this;
  }

  replaceChild(newNode: Node, oldNode: Node): Node {
    const i = this.childNodes.indexOf(oldNode);
    if (i === -1) {
      throw new Error("Old node is not a child of this node");
    }
    this.childNodes[i] = newNode;
    oldNode.parentNode = undefined;
    newNode.parentNode = this;
    return oldNode;
  }

  hasChildNodes(): boolean {
    return this.childNodes.length > 0;
  }

  hasAttribute(name: string) {
    return this.attrs.has(name);
  }

  getAttribute(name: string) {
    return this.attrs.get(name);
  }

  private get dataString() {
    return typeof this.data === "string" ? this.data : "";
  }

  get text(): string {
    return this.name === "#text" ? this.dataString : "";
  }

  /**
   * Returns aggregated text from this node subtree.
   */
  toText({ separator = " ", strip = true }: ToTextOptions = {}): string {
    const parts: string[] = [];

    const walk = (node: Node): void => {
      if (node.name === "#text") {
        let data = node.dataString;
        if (strip) data = data.trim();
        if (data) parts.push(data);
        return;
      }
      for (const child of node.childNodes) {
        walk(child);
      }
      if (node.templateContent) {
        walk(node.templateContent);
      }
    };

    walk(this);
    return parts.join(separator);
  }

  /**
   * Serializes this subtree as HTML.
   */
  toHTML(options?: ToHTMLOptions): string {
    return nodeToHTML(this, options?.indent, options?.indentSize, options?.pretty);
  }

  /**
   * Returns the first descendant node that matches the provided CSS selector.
   */
  querySelector(selector: string): Node | null {
    for (const node of querySelectorAll<Node>(this, selector)) {
      return node;
    }
    return null;
  }

  /**
   * Returns descendant nodes that match the provided CSS selector.
   */
  querySelectorAll(selector: string): Iterable<Node> {
    return querySelectorAll<Node>(this, selector);
  }

  /**
   * Returns a shallow or deep clone of this node.
   */
  cloneNode(deep = false): Node {
    const clone = new Node(this.name, this.data, this.namespace, new Map(this.attrs));
    if (this.templateContent) {
      clone.templateContent = this.templateContent.cloneNode(deep);
    }
    if (deep) {
      for (const child of this.childNodes) {
        clone.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }

  get children(): Node[] {
    return this.childNodes.filter(c => isElementNode(c));
  }

  get previousSibling(): Node | undefined {
    const { parentNode: parent } = this;
    if (!parent) return;

    let prev: Node | undefined;
    for (const child of parent.childNodes) {
      if (child === this) return prev;
      if (isElementNode(child)) prev = child;
    }
  }
}

export function isElementNode(node: unknown): node is Node {
  if (node == null || typeof node !== "object") return false;
  const n = node as Node;
  return typeof n.name === "string" && !n.name.startsWith("#") && n.name !== "!doctype";
}
