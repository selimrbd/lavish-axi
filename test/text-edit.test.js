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

test("an element holding markup the reviewer cannot write is refused rather than flattened", () => {
  const withMarkup = '<p>a goal and a <span class="badge">promise</span></p>';
  const result = applyTextEdit(withMarkup, {
    tag: "p",
    index: 0,
    before: "a goal and a promise",
    after: "just a goal",
  });

  assert.equal(result.error, "not_text_only");
});

test("an element built of editable tags is editable, markup and all", () => {
  const withMarkup = "<p>a goal and a <strong>promise</strong></p>";
  const result = applyTextEdit(withMarkup, {
    tag: "p",
    index: 0,
    before: "a goal and a promise",
    after: "a goal and an <em>intention</em>",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.html, "<p>a goal and an <em>intention</em></p>");
});

test("a missing element, a void element and a bad target are all refused", () => {
  assert.equal(applyTextEdit(page, { tag: "h1", index: 7, before: "x", after: "y" }).error, "not_found");
  assert.equal(applyTextEdit(page, { tag: "br", index: 0, before: "x", after: "y" }).error, "not_editable");
  assert.equal(applyTextEdit(page, { tag: "", index: 0, before: "x", after: "y" }).error, "bad_target");
  assert.equal(applyTextEdit(page, { tag: "h1", index: -1, before: "x", after: "y" }).error, "bad_target");
  assert.equal(applyTextEdit(page, { tag: "h1", index: 0, before: "Data Profiler" }).error, "bad_text");
});

test("markup characters typed into the text stay escaped", () => {
  // What a browser sends for a typed `<script>` is already the escaped form; it must survive as
  // text rather than being decoded into a tag on the way to the file.
  const result = applyTextEdit(page, {
    tag: "h1",
    index: 0,
    before: "Data Profiler",
    after: "Profiler &lt;script&gt;alert(1)&lt;/script&gt; &amp; co",
  });

  assert.ok(result.html.includes("<h1>Profiler &lt;script&gt;alert(1)&lt;/script&gt; &amp; co</h1>"));
  assert.equal(escapeArtifactText("a < b & c > d"), "a &lt; b &amp; c &gt; d");
});

test("a tag the reviewer may not write is stripped to the words inside it", () => {
  const result = applyTextEdit(page, {
    tag: "h1",
    index: 0,
    before: "Data Profiler",
    after: '<script>alert(1)</script><img src="x"><b>Data</b> <span style="color:red">Profiler</span>',
  });

  assert.equal(result.html.includes("<script"), false);
  assert.equal(result.html.includes("<img"), false);
  assert.equal(result.html.includes("<span"), false);
  assert.ok(result.html.includes("<h1>alert(1)<b>Data</b> Profiler</h1>"));
});

test("turning a paragraph into a list replaces the element itself", () => {
  const result = applyTextEdit(page, {
    tag: "p",
    index: 1,
    before: "Every question has started the same way.",
    after: "<ul><li>Every question</li><li>has started the same way.</li></ul>",
    scope: "outer",
  });

  assert.equal(result.error, undefined);
  assert.ok(result.html.includes("<ul><li>Every question</li><li>has started the same way.</li></ul>"));
  assert.equal(result.html.includes("<p>Every question has started"), false);
  assert.ok(result.html.includes('<p class="dek">'), "the paragraph before it is untouched");
});

test("a list is editable in turn, and converts back to the tag it came from", () => {
  const listed = "<div><ul><li>one</li><li>two</li></ul></div>";
  const inner = applyTextEdit(listed, {
    tag: "ul",
    index: 0,
    before: "onetwo",
    after: "<li>one</li><li>two</li><li>three</li>",
  });
  assert.equal(inner.html, "<div><ul><li>one</li><li>two</li><li>three</li></ul></div>");

  const back = applyTextEdit(listed, {
    tag: "ul",
    index: 0,
    before: "onetwo",
    after: "<p>one<br>two</p>",
    scope: "outer",
  });
  assert.equal(back.html, "<div><p>one<br>two</p></div>", "a list the file already held goes back to a paragraph");
});

test("an outer edit may only produce a list or the tag that was already there", () => {
  const rejected = applyTextEdit(page, {
    tag: "h1",
    index: 0,
    before: "Data Profiler",
    after: "<section>Data Profiler</section>",
    scope: "outer",
  });
  assert.equal(rejected.error, "bad_root");

  const two = applyTextEdit(page, {
    tag: "h1",
    index: 0,
    before: "Data Profiler",
    after: "<ul><li>a</li></ul><ul><li>b</li></ul>",
    scope: "outer",
  });
  assert.equal(two.error, "bad_root");

  const same = applyTextEdit(page, {
    tag: "h1",
    index: 0,
    before: "Data Profiler",
    after: "<h1>The <em>Data</em> Profiler</h1>",
    scope: "outer",
  });
  assert.equal(same.html.includes("<h1>The <em>Data</em> Profiler</h1>"), true);
});

test("removing a block takes its line with it", () => {
  const result = applyTextEdit(page, {
    tag: "p",
    index: 1,
    before: "Every question has started the same way.",
    after: "",
    scope: "remove",
  });

  assert.equal(result.error, undefined);
  assert.equal(
    result.html,
    [
      "<title>Data Profiler RFC</title>",
      "<style>body{background:#fff}</style>",
      '<div class="page">',
      "  <h1>Data Profiler</h1>",
      '  <p class="dek">One tool to see what a data source holds.</p>',
      "</div>",
    ].join("\n"),
    "no blank line is left behind",
  );
});

test("a removal is refused on text the file no longer holds", () => {
  const result = applyTextEdit(page, {
    tag: "p",
    index: 1,
    before: "something the reviewer never saw",
    after: "",
    scope: "remove",
  });

  assert.equal(result.error, "stale");
  assert.equal(result.html, undefined);
});

test("a link keeps only a safe href", () => {
  const safe = applyTextEdit(page, {
    tag: "h1",
    index: 0,
    before: "Data Profiler",
    after: '<a href="https://example.com" onclick="steal()" class="x">Data Profiler</a>',
  });
  assert.ok(safe.html.includes('<h1><a href="https://example.com">Data Profiler</a></h1>'));

  const unsafe = applyTextEdit(page, {
    tag: "h1",
    index: 0,
    before: "Data Profiler",
    after: '<a href="javascript:steal()">Data Profiler</a>',
  });
  assert.ok(unsafe.html.includes("<h1><a>Data Profiler</a></h1>"), "the link stays, the code does not");
});

test("the markup actually written is reported back", () => {
  const result = applyTextEdit(page, {
    tag: "h1",
    index: 0,
    before: "Data Profiler",
    after: '<b>Data</b> <span class="x">Profiler</span>',
  });

  assert.equal(result.markup, "<b>Data</b> Profiler");
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
