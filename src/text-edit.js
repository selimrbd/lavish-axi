import { parse, parseFragment, serialize } from "parse5";

import { decodeHtmlEntities } from "./mermaid-source.js";

// In-place edits made from the review surface.
//
// The browser sends the element's tag name, its position among the elements of that tag in document
// order - the order `document.getElementsByTagName(tag)` yields - and the text the element held when
// the edit began. The file is patched only while that text still matches, so a stale review can
// never write over a file that changed underneath it.
//
// An edit carries markup, not plain text, because the review surface offers lists, emphasis and
// links. What it may carry is bounded twice over: the element being edited has to be a block with
// no block inside it, and the incoming markup is re-parsed here and stripped down to the tags the
// toolbar writes, so an edit can never introduce a script, a style, an image or a layout container
// into the artifact. `scope` says which range is spliced: "inner" replaces what sits between the
// tags, "outer" replaces the element itself, which is what turns a paragraph into a list, and
// "remove" takes it out of the file altogether.
//
// Anything else the block already held - a span carrying the author's own class, an image, a
// nested widget - is an ATOM: the browser froze it while the reviewer typed around it, and it comes
// back here as a numbered marker. The markup written to the file takes those bytes from the file
// itself, so an atom survives an edit exactly as its author wrote it, attributes and all. A
// reviewer can move an atom or delete it; they can never rewrite one, and nothing can forge one,
// since a marker only ever resolves to source already in the file.

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// The markup a reviewer may write: the two list kinds, emphasis, a line break and a link.
export const EDITABLE_TAGS = new Set(["ul", "ol", "li", "strong", "em", "b", "i", "br", "a"]);

// A block may be turned into one of these, whatever it was before. A paragraph is in the set because
// it is where a list goes back to: the block it came from is not knowable once the file holds a
// list and the session that converted it is over.
const BLOCK_TAGS = new Set(["ul", "ol", "p"]);

// Structure an edit must never swallow: a block holding one of these is a container, and the thing
// to edit is the block inside it, not the container.
const BLOCK_LEVEL_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "canvas",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "video",
]);

const ALLOWED_ATTRIBUTES = { a: new Set(["href"]) };

// Private-use characters stand in for an atom while the markup is parsed and pruned: they survive
// serialization as ordinary text and cannot be confused with anything a reviewer types, which is
// why any that arrive from the browser are dropped before parsing.
const ATOM_OPEN = "\uE000";
const ATOM_CLOSE = "\uE001";
const ATOM_MARKER_ATTRIBUTE = "data-lavish-atom";

// Relative, anchor, mail and web links only: `javascript:` and `data:` are how a link becomes code.
const SAFE_HREF = /^(?:https?:\/\/|mailto:|#|\/|\.{0,2}\/|[\w.-]+(?:\/|$))/i;

export function escapeArtifactText(text) {
  return String(text).replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
}

// Whitespace and entity forms differ between the file and the rendered DOM, so the two texts are
// compared as the reader sees them rather than as they are written.
function asRendered(text) {
  return decodeHtmlEntities(String(text)).replace(/\s+/g, " ").trim();
}

function textOf(node) {
  if (node.nodeName === "#text") return String(node.value || "");
  return Array.isArray(node.childNodes) ? node.childNodes.map(textOf).join("") : "";
}

function isElement(node) {
  return Boolean(node && node.tagName);
}

function childrenOf(node) {
  return node.childNodes || [];
}

function attributeIsAllowed(tag, attribute) {
  const allowed = ALLOWED_ATTRIBUTES[tag];
  if (!allowed || !allowed.has(attribute.name)) return false;
  if (attribute.name !== "href") return true;
  return SAFE_HREF.test(String(attribute.value || "").trim());
}

// Whether an element is the reviewer's to rewrite, or an atom to be preserved as it stands.
function isWritable(node) {
  if (!EDITABLE_TAGS.has(node.tagName)) return false;
  return (node.attrs || []).every((attribute) => attributeIsAllowed(node.tagName, attribute));
}

// A block is editable when it holds no block: its text is the reviewer's, its writable tags are the
// reviewer's, and everything else inside it is an atom. A container of blocks is not editable, so a
// click in a section still resolves to the paragraph inside it.
function isEditableBlock(node) {
  return childrenOf(node).every((child) => {
    if (!isElement(child)) return child.nodeName !== "#comment";
    if (BLOCK_LEVEL_TAGS.has(child.tagName)) return false;
    // An atom is opaque: what it holds is not the reviewer's business, so it is not walked into.
    return !isWritable(child) || isEditableBlock(child);
  });
}

// Every atom of a block, outermost first and in document order, as the exact bytes the file holds.
// The browser numbered them the same way, walking the same tree.
function atomSources(html, node, found = []) {
  for (const child of childrenOf(node)) {
    if (!isElement(child)) continue;
    if (!isWritable(child)) {
      const location = child.sourceCodeLocation;
      found.push(location ? html.slice(location.startOffset, location.endOffset) : "");
      continue;
    }
    atomSources(html, child, found);
  }
  return found;
}

// Marker elements become plain text carrying their number, before any pruning can unwrap them. The
// node is replaced rather than rewritten: parse5 tells an element from a text node by whether it
// has a tagName at all, so a mutated one serializes as <undefined>.
function markersToSentinels(node) {
  const children = childrenOf(node);
  for (let position = 0; position < children.length; position += 1) {
    const child = children[position];
    if (!isElement(child)) continue;
    const marker = (child.attrs || []).find((attribute) => attribute.name === ATOM_MARKER_ATTRIBUTE);
    if (marker) {
      const index = Number(marker.value);
      children[position] = {
        nodeName: "#text",
        value: Number.isInteger(index) && index >= 0 ? ATOM_OPEN + index + ATOM_CLOSE : "",
        parentNode: node,
      };
      continue;
    }
    markersToSentinels(child);
  }
  return node;
}

// Returns the markup with every sentinel replaced by the source of the atom it stands for, or null
// when one names an atom the file does not have.
function restoreAtoms(markup, sources) {
  let unknown = false;
  const restored = markup.replace(new RegExp(ATOM_OPEN + "(\\d+)" + ATOM_CLOSE, "g"), (_, index) => {
    const source = sources[Number(index)];
    if (source === undefined) unknown = true;
    return source ?? "";
  });
  return unknown ? null : restored;
}

// Disallowed elements are unwrapped rather than dropped, so the words a reviewer typed survive even
// when the tag around them does not.
function pruneToEditableTags(node) {
  const kept = [];
  for (const child of childrenOf(node)) {
    if (child.nodeName === "#comment") continue;
    if (!isElement(child)) {
      kept.push(child);
      continue;
    }
    pruneToEditableTags(child);
    if (EDITABLE_TAGS.has(child.tagName)) {
      child.attrs = (child.attrs || []).filter((attribute) => attributeIsAllowed(child.tagName, attribute));
      kept.push(child);
      continue;
    }
    for (const orphan of childrenOf(child)) {
      orphan.parentNode = node;
      kept.push(orphan);
    }
  }
  node.childNodes = kept;
  return node;
}

function withoutSentinels(markup) {
  return String(markup).split(ATOM_OPEN).join("").split(ATOM_CLOSE).join("");
}

/** The markup as the artifact may hold it: same words, only editable tags left standing. */
export function sanitizeArtifactMarkup(markup) {
  return serialize(pruneToEditableTags(markersToSentinels(parseFragment(withoutSentinels(markup)))));
}

// An outer edit rewrites the element itself, so its root has to be a tag the reviewer is allowed to
// end up with: one of the block tags, or the tag the element already has. The root's own children
// are pruned like any other markup; the root's attributes are not read from here at all.
function editedRoot(markup, currentTag) {
  const fragment = markersToSentinels(parseFragment(withoutSentinels(markup)));
  const children = childrenOf(fragment);
  const elements = children.filter(isElement);
  const root = elements[0];
  if (elements.length !== 1 || !root) return null;
  if (!BLOCK_TAGS.has(root.tagName) && root.tagName !== currentTag) return null;
  if (children.some((child) => child !== root && textOf(child).trim())) return null;
  return pruneToEditableTags(root);
}

function elementsByTag(document, tag) {
  const found = [];
  const visit = (node) => {
    for (const child of node.childNodes || []) {
      if (child.tagName === tag) found.push(child);
      visit(child);
    }
  };
  visit(document);
  return found;
}

// Returns the patched html plus the markup actually written, or an error naming why nothing was
// written. Every field arrives from the browser, so nothing here trusts its type.
/**
 * @param {string} html
 * @param {{ tag?: unknown, index?: unknown, before?: unknown, after?: unknown, scope?: unknown }} edit
 */
export function applyTextEdit(html, { tag, index, before, after, scope }) {
  const name = String(tag || "").toLowerCase();
  const position = Number(index);
  const remove = scope === "remove";
  const outer = scope === "outer" || remove;
  if (!name || !Number.isInteger(position) || position < 0) return { error: "bad_target" };
  if (VOID_ELEMENTS.has(name)) return { error: "not_editable" };
  if (typeof after !== "string") return { error: "bad_text" };

  const element = elementsByTag(parse(html, { sourceCodeLocationInfo: true }), name)[position];
  if (!element) return { error: "not_found" };
  if (!isEditableBlock(element)) return { error: "not_text_only" };

  const location = element.sourceCodeLocation;
  if (!location || !location.startTag || !location.endTag) return { error: "no_source_range" };
  if (asRendered(textOf(element)) !== asRendered(before)) return { error: "stale" };

  // Taking a block out takes its own line with it, indentation and line break included, so the file
  // does not fill up with the blank lines of everything a review deleted.
  if (remove) {
    let start = location.startOffset;
    let end = location.endOffset;
    const lineStart = html.lastIndexOf("\n", start - 1) + 1;
    if (!html.slice(lineStart, start).trim()) start = lineStart;
    if (html[end] === "\n") end += 1;
    return { html: html.slice(0, start) + html.slice(end), markup: "" };
  }

  const atoms = atomSources(html, element);

  let markup;
  if (outer) {
    const root = editedRoot(after, name);
    if (!root) return { error: "bad_root" };
    // Keeping the same tag keeps its attributes, taken from the file rather than from the browser,
    // so an edit can neither drop the class an author wrote nor add one.
    const open =
      root.tagName === name
        ? html.slice(location.startTag.startOffset, location.startTag.endOffset)
        : "<" + root.tagName + ">";
    markup = open + serialize(root) + "</" + root.tagName + ">";
  } else {
    markup = sanitizeArtifactMarkup(after);
  }

  markup = restoreAtoms(markup, atoms);
  if (markup === null) return { error: "bad_atom" };

  const start = outer ? location.startOffset : location.startTag.endOffset;
  const end = outer ? location.endOffset : location.endTag.startOffset;
  return { html: html.slice(0, start) + markup + html.slice(end), markup };
}
