import assert from "node:assert/strict";
import test from "node:test";

import { applyTextEdit, escapeArtifactText } from "../src/text-edit.js";

const page = [
  "<title>Data Profiler RFC</title>",
  "<style>body{background:#fff}</style>",
  '<div class="page">',
  "  <h1>Data Profiler</h1>",
  '  <p class="dek">One tool to see what a data source holds.</p>',
  "  <p>Every question has started the same way.</p>",
  "</div>",
].join("\n");

test("an edit replaces one element's text and leaves every other byte alone", () => {
  const result = applyTextEdit(page, {
    tag: "h1",
    index: 0,
    before: "Data Profiler",
    after: "The Data Profiler",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.html, page.replace("<h1>Data Profiler</h1>", "<h1>The Data Profiler</h1>"));
});

test("the element is found by its position among elements of the same tag", () => {
  const result = applyTextEdit(page, {
    tag: "p",
    index: 1,
    before: "Every question has started the same way.",
    after: "Every question starts the same way.",
  });

  assert.ok(result.html.includes("<p>Every question starts the same way.</p>"));
  assert.ok(result.html.includes("One tool to see what a data source holds."), "the first paragraph is untouched");
});

test("text is compared as the reader sees it, not as it is written", () => {
  const spaced = "<p>  the goal\n  of the tool  </p>";
  const result = applyTextEdit(spaced, { tag: "p", index: 0, before: "the goal of the tool", after: "the point" });
  assert.equal(result.html, "<p>the point</p>");
});

test("an edit against text the file no longer holds is refused", () => {
  const result = applyTextEdit(page, {
    tag: "h1",
    index: 0,
    before: "Something else entirely",
    after: "The Data Profiler",
  });

  assert.equal(result.error, "stale");
  assert.equal(result.html, undefined);
});

test("an element holding markup is refused rather than flattened", () => {
  const withMarkup = "<p>a goal and a <strong>promise</strong></p>";
  const result = applyTextEdit(withMarkup, {
    tag: "p",
    index: 0,
    before: "a goal and a promise",
    after: "just a goal",
  });

  assert.equal(result.error, "not_text_only");
});

test("a missing element, a void element and a bad target are all refused", () => {
  assert.equal(applyTextEdit(page, { tag: "h1", index: 7, before: "x", after: "y" }).error, "not_found");
  assert.equal(applyTextEdit(page, { tag: "br", index: 0, before: "x", after: "y" }).error, "not_editable");
  assert.equal(applyTextEdit(page, { tag: "", index: 0, before: "x", after: "y" }).error, "bad_target");
  assert.equal(applyTextEdit(page, { tag: "h1", index: -1, before: "x", after: "y" }).error, "bad_target");
  assert.equal(applyTextEdit(page, { tag: "h1", index: 0, before: "Data Profiler" }).error, "bad_text");
});

test("markup characters typed into the text are escaped, not injected", () => {
  const result = applyTextEdit(page, {
    tag: "h1",
    index: 0,
    before: "Data Profiler",
    after: "Profiler <script>alert(1)</script> & co",
  });

  assert.ok(result.html.includes("<h1>Profiler &lt;script&gt;alert(1)&lt;/script&gt; &amp; co</h1>"));
  assert.equal(escapeArtifactText("a < b & c > d"), "a &lt; b &amp; c &gt; d");
});

test("an edited entity survives the round trip", () => {
  const entities = "<p>Limitations &amp; future improvements</p>";
  const unchanged = applyTextEdit(entities, {
    tag: "p",
    index: 0,
    before: "Limitations & future improvements",
    after: "Limitations & open questions",
  });
  assert.equal(unchanged.html, "<p>Limitations &amp; open questions</p>");
});
