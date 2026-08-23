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
// links. What it may carry is bounded twice over: the element being edited has to be built of
// nothing but editable tags, and the incoming markup is re-parsed here and stripped down to the
// same set, so an edit can never introduce a script, a style, an image or a layout container into
// the artifact. `scope` says which range is spliced: "inner" replaces what sits between the tags,
// "outer" replaces the element itself, which is what turns a paragraph into a list.

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

const ALLOWED_ATTRIBUTES = { a: new Set(["href"]) };

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

// An element is editable when everything inside it is: a reviewer rewriting a paragraph must not be
// able to destroy a nested figure, a styled span or anything else the author put there on purpose.
function subtreeIsEditable(node) {
  return childrenOf(node).every((child) => {
    if (child.nodeName === "#comment") return false;
    if (!isElement(child)) return true;
    if (!EDITABLE_TAGS.has(child.tagName)) return false;
    if ((child.attrs || []).some((attribute) => !attributeIsAllowed(child.tagName, attribute))) return false;
    return subtreeIsEditable(child);
  });
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

/** The markup as the artifact may hold it: same words, only editable tags left standing. */
export function sanitizeArtifactMarkup(markup) {
  return serialize(pruneToEditableTags(parseFragment(String(markup))));
}

// An outer edit rewrites the element itself, so its root has to be a tag the reviewer is allowed to
// end up with: one of the block tags, or the tag the element already has. The root's own children
// are pruned like any other markup; the root's attributes are not read from here at all.
function editedRoot(markup, currentTag) {
  const fragment = parseFragment(String(markup));
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
  const outer = scope === "outer";
  if (!name || !Number.isInteger(position) || position < 0) return { error: "bad_target" };
  if (VOID_ELEMENTS.has(name)) return { error: "not_editable" };
  if (typeof after !== "string") return { error: "bad_text" };

  const element = elementsByTag(parse(html, { sourceCodeLocationInfo: true }), name)[position];
  if (!element) return { error: "not_found" };
  if (!subtreeIsEditable(element)) return { error: "not_text_only" };

  const location = element.sourceCodeLocation;
  if (!location || !location.startTag || !location.endTag) return { error: "no_source_range" };
  if (asRendered(textOf(element)) !== asRendered(before)) return { error: "stale" };

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

  const start = outer ? location.startOffset : location.startTag.endOffset;
  const end = outer ? location.endOffset : location.endTag.startOffset;
  return { html: html.slice(0, start) + markup + html.slice(end), markup };
}
