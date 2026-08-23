import { parse } from "parse5";

import { decodeHtmlEntities } from "./mermaid-source.js";

// In-place text edits made from the review surface.
//
// The browser sends the element's tag name, its position among the elements of that tag in document
// order - the order `document.getElementsByTagName(tag)` yields - and the text the element held when
// the edit began. The file is patched only while that text still matches, so a stale review can
// never write over a file that changed underneath it. Only the element's own inner range is
// spliced, so every other byte of the artifact is left exactly as the author wrote it.

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

function hasElementChild(node) {
  return (node.childNodes || []).some((child) => child.nodeName !== "#text" && child.nodeName !== "#comment");
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

// Returns the patched html, or an error naming why nothing was written. Every field arrives from
// the browser, so nothing here trusts its type.
/**
 * @param {string} html
 * @param {{ tag?: unknown, index?: unknown, before?: unknown, after?: unknown }} edit
 */
export function applyTextEdit(html, { tag, index, before, after }) {
  const name = String(tag || "").toLowerCase();
  const position = Number(index);
  if (!name || !Number.isInteger(position) || position < 0) return { error: "bad_target" };
  if (VOID_ELEMENTS.has(name)) return { error: "not_editable" };
  if (typeof after !== "string") return { error: "bad_text" };

  const element = elementsByTag(parse(html, { sourceCodeLocationInfo: true }), name)[position];
  if (!element) return { error: "not_found" };
  if (hasElementChild(element)) return { error: "not_text_only" };

  const location = element.sourceCodeLocation;
  if (!location || !location.startTag || !location.endTag) return { error: "no_source_range" };
  if (asRendered(textOf(element)) !== asRendered(before)) return { error: "stale" };

  const start = location.startTag.endOffset;
  const end = location.endTag.startOffset;
  return { html: html.slice(0, start) + escapeArtifactText(after) + html.slice(end) };
}
