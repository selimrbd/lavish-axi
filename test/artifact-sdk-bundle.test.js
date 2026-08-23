import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { createSdkJs } from "../src/server.js";

// The SDK the browser actually runs is a serialized bundle, not the module: `createSdkJs` has to
// declare every helper `createArtifactSdk` reaches for. A helper left out compiles fine and only
// ReferenceErrors on the first click, so these tests boot the served bundle and drive the real
// annotation path through a DOM stub instead of inspecting the module directly.

function createElement(tag) {
  const attributes = new Map();
  const queried = new Map();
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    style: {},
    value: "",
    innerHTML: "",
    textContent: "",
    offsetWidth: 100,
    offsetHeight: 100,
    hidden: false,
    listeners: [],
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    matches(selectorList) {
      return String(selectorList)
        .split(",")
        .some((part) => {
          const selector = part.trim();
          if (selector.startsWith("[")) return attributes.has(selector.slice(1, selector.indexOf("]")).split("=")[0]);
          return selector === element.tagName.toLowerCase();
        });
    },
    closest(selectorList) {
      let current = element;
      while (current) {
        if (current.matches(selectorList)) return current;
        current = current.parentElement;
      }
      return null;
    },
    appendChild(child) {
      child.parentElement = element;
      element.children.push(child);
      return child;
    },
    remove() {
      const index = element.parentElement?.children.indexOf(element) ?? -1;
      if (index >= 0) element.parentElement.children.splice(index, 1);
    },
    // Card internals are looked up by class after innerHTML is assigned, so hand back a stable
    // stub per selector: the test drives the very buttons the SDK wired up.
    querySelector(selector) {
      if (!queried.has(selector)) queried.set(selector, createElement(selector.replace(/^[.#]/, "")));
      return queried.get(selector);
    },
    // Cards and the action menu are direct children of the shadow root, and the SDK removes them
    // by class, so a class match over the children is all the stub owes it.
    querySelectorAll(selector) {
      const wanted = String(selector).replace(/^\./, "");
      if (String(selector).startsWith(".")) return element.children.filter((child) => child.className === wanted);
      return element.children.filter((child) => child.tagName === wanted.toUpperCase());
    },
    replaceWith(next) {
      const parent = element.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(element);
      if (index >= 0) parent.children.splice(index, 1, next);
      next.parentElement = parent;
      element.parentElement = null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 };
    },
    addEventListener(type, handler) {
      element.listeners.push({ type, handler });
    },
    removeEventListener() {},
    focus() {},
    click() {},
    scrollIntoView() {},
    attachShadow() {
      element.shadowRoot = createElement("shadow-root");
      return element.shadowRoot;
    },
  };
  return element;
}

function appendTo(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function cell(tag, text) {
  const element = createElement(tag);
  element.textContent = text;
  return element;
}

function bootSdk() {
  const posted = [];
  const execCommands = [];
  const documentListeners = [];
  // Deferred work the SDK schedules, run only when a test asks for it: the draft-anchor settle
  // re-query is a real timer, and asserting on it means running it rather than assuming it.
  const timers = [];
  const scheduleTimer = (fn, ms) => timers.push({ fn, ms }) && timers.length;
  const cancelTimer = (id) => {
    if (timers[id - 1]) timers[id - 1].cancelled = true;
  };
  /** @type {(selector: string) => any} */
  let documentQuery = () => null;
  const documentElement = createElement("html");
  const head = createElement("head");
  const body = createElement("body");
  appendTo(documentElement, head);
  appendTo(documentElement, body);

  const sandbox = {
    parent: { postMessage: (message) => posted.push(message) },
    navigator: { platform: "Linux" },
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
    URL: {
      createObjectURL() {
        return "blob:lavish-test";
      },
      revokeObjectURL() {},
    },
    getComputedStyle: () => ({}),
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: () => 0,
    document: {
      readyState: "complete",
      documentElement,
      head,
      body,
      activeElement: body,
      baseURI: "http://127.0.0.1/artifact/abc/index.html",
      addEventListener: (type, handler) => documentListeners.push({ type, handler }),
      removeEventListener() {},
      createElement,
      getElementById: () => null,
      querySelector: (selector) => documentQuery(selector),
      querySelectorAll: () => [],
      execCommand: (command, showUi, value) => {
        execCommands.push([command, value]);
        return command !== "insertLineBreak";
      },
      getSelection: () => null,
      createRange: () => ({ selectNodeContents() {} }),
      getElementsByTagName: (tag) => {
        const wanted = String(tag).toUpperCase();
        const found = [];
        const visit = (node) => {
          for (const child of node.children || []) {
            if (child.tagName === wanted) found.push(child);
            visit(child);
          }
        };
        visit(documentElement);
        return found;
      },
    },
  };
  const windowListeners = [];
  sandbox.window = {
    addEventListener: (type, handler) => windowListeners.push({ type, handler }),
    removeEventListener() {},
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: () => 0,
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    location: { origin: "http://127.0.0.1" },
    URL: sandbox.URL,
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(createSdkJs("abc", 3, "load-token"), sandbox);

  return {
    posted,
    execCommands,
    body,
    api: sandbox.window.lavish,
    rawClick(target) {
      const listener = documentListeners.find((entry) => entry.type === "click");
      assert.ok(listener, "the SDK registers a document click listener");
      listener.handler({ target, preventDefault() {}, stopPropagation() {} });
    },
    // The armed mode decides what a click does, and the chrome is what arms it.
    setMode(mode) {
      this.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: mode === "annotate" });
      this.sendChromeMessage({ type: "lavish:setEditMode", enabled: mode === "edit" });
    },
    click(target) {
      this.rawClick(target);
    },
    edit(target) {
      this.setMode("edit");
      this.rawClick(target);
    },
    pressKey(key, target) {
      const listeners = documentListeners.filter((entry) => entry.type === "keydown");
      assert.ok(listeners.length > 0, "the SDK registers a document keydown listener");
      let prevented = false;
      for (const listener of listeners) {
        listener.handler({ key, target: target || body, preventDefault: () => (prevented = true) });
      }
      return prevented;
    },
    toolbar() {
      return documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .find((child) => child.className === "lavish-edit-toolbar");
    },
    tool(id) {
      const bar = this.toolbar();
      assert.ok(bar, "editing opens the toolbar");
      const button = bar.children.find((child) => child.getAttribute("data-tool") === id);
      assert.ok(button, `the toolbar offers "${id}"`);
      return button;
    },
    setDocumentQuery(query) {
      documentQuery = query;
    },
    runTimers() {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) {
        if (!timer.cancelled) timer.fn();
      }
    },
    // The chrome is the only legitimate sender, so its messages arrive with `source: parent`.
    sendChromeMessage(data) {
      const listeners = windowListeners.filter((entry) => entry.type === "message");
      assert.ok(listeners.length > 0, "the SDK registers a window message listener");
      for (const listener of listeners) listener.handler({ source: sandbox.parent, data });
    },
    cards() {
      return documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .filter((child) => child.className === "lavish-annotation-card");
    },
    card() {
      const card = this.cards().at(-1);
      assert.ok(card, "clicking an element opens an annotation card");
      return card;
    },
    queue(text) {
      const card = this.card();
      card.querySelector("textarea").value = text;
      card.querySelector(".lavish-send").onclick();
      return posted.at(-1);
    },
  };
}

function buildTable(sdk) {
  const table = appendTo(sdk.body, createElement("table"));
  const thead = appendTo(table, createElement("thead"));
  const headerRow = appendTo(thead, createElement("tr"));
  for (const label of ["Permission / setting", "Visible state", "Database evidence"]) {
    appendTo(headerRow, cell("th", label));
  }
  const tbody = appendTo(table, createElement("tbody"));
  const dataRow = appendTo(tbody, createElement("tr"));
  appendTo(dataRow, cell("td", "Media & Apple Music"));
  appendTo(dataRow, cell("td", "4 apps"));
  const evidence = appendTo(dataRow, cell("td", "Drive, Neovide, Cursor"));
  const badge = appendTo(evidence, cell("code", "Drive"));
  return { evidence, badge };
}

test("the served SDK bundle queues a table-cell annotation without a missing-helper ReferenceError", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);
  const message = sdk.queue("Check this permission");

  assert.equal(message.type, "lavish:queuePrompt");
  assert.equal(message.prompt.prompt, "Check this permission");
  assert.deepEqual(
    { ...message.prompt.target },
    {
      type: "table-cell",
      selector: "body > table > tbody > tr > td:nth-of-type(3)",
      rowLabel: "Media & Apple Music",
      columnLabel: "Database evidence",
      text: "Drive, Neovide, Cursor",
    },
  );
});

test("the served SDK bundle keeps the clicked element's own identity inside a table cell", () => {
  const sdk = bootSdk();
  const { badge } = buildTable(sdk);

  sdk.click(badge);
  const message = sdk.queue("Rename this app");

  assert.equal(message.prompt.tag, "code");
  assert.equal(message.prompt.selector, "table > tbody > tr > td:nth-of-type(3) > code");
  assert.equal(message.prompt.text, "Drive");
  assert.equal(message.prompt.target.selector, "body > table > tbody > tr > td:nth-of-type(3)");
  assert.equal(message.prompt.target.columnLabel, "Database evidence");
});

test("the annotation card names the cell it annotates when the cell itself is clicked", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);

  assert.match(sdk.card().innerHTML, /Annotate cell: Media &amp; Apple Music → Database evidence/);
  assert.match(sdk.card().innerHTML, /about this table cell/);
});

test("the annotation card names the clicked element, not the cell, for a nested click", () => {
  const sdk = bootSdk();
  const { badge } = buildTable(sdk);

  sdk.click(badge);

  assert.match(sdk.card().innerHTML, /Annotate &lt;code&gt; in Media &amp; Apple Music → Database evidence/);
  assert.doesNotMatch(sdk.card().innerHTML, /about this table cell/);
});

test("the served SDK bundle resolves table coordinates only for annotation clicks", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.api.queuePrompt("Programmatic note", { element: evidence });

  assert.equal(sdk.posted.at(-1).prompt.target, undefined);
});

test("the served SDK bundle annotates elements outside tables with no table target", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const message = sdk.queue("Reword this");

  assert.equal(message.prompt.tag, "p");
  assert.equal(message.prompt.target, undefined);
});

// The chrome cannot see into this document, so a draft whose anchor is gone is only ever retired
// if the SDK says so. Silence left it to be retried against every later load.
test("the served SDK bundle reports a draft whose anchor the artifact no longer has", () => {
  const sdk = bootSdk();

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  // The load event proves the document parsed, not that it finished rendering, so nothing is
  // reported until the anchor has had time to appear.
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );

  sdk.runTimers();
  const report = sdk.posted.at(-1);
  assert.equal(report.type, "lavish:reviewDraftUnrestorable");
  assert.equal(report.selector, "#hero");
  assert.equal(report.artifact_load_token, "load-token");
});

// A section this page builds in script, or a Mermaid diagram, is not in the document when it
// loads. Reporting that as a missing anchor is how a live draft gets thrown away.
test("the served SDK bundle restores a draft whose anchor arrives after the load", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
    "an anchor that arrived late is restored, not reported gone",
  );
  assert.equal(sdk.card().querySelector("textarea").value, "needs a shorter headline");
});

test("the served SDK bundle reports nothing when there is no draft to restore", () => {
  const sdk = bootSdk();
  const before = sdk.posted.length;

  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: { card: null, fields: [] } });
  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: { card: { selector: "#hero", text: "  " } } });
  sdk.runTimers();

  assert.equal(sdk.posted.length, before);
});

// `showAnnotationCard` closes whatever card is open before it draws, so a late restore landing on
// a card the user opened inside the settle window would delete text they are still typing - text
// no report has carried to the chrome yet.
test("the served SDK bundle leaves a card the user opened alone when the anchor arrives late", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector("textarea").value = "typing something new";
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(sdk.card().querySelector("textarea").value, "typing something new");
  // The draft is still stored on the chrome side, so a later load can try again; nothing here
  // claims the anchor is gone either.
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );
});

// Cancelling a card reports `card: null`, which is what retires the stored draft on the chrome
// side. A late restore firing after that cancel would draw text the chrome no longer holds and
// report it back as a live draft, so the card the user dismissed reappears with someone else's
// text in it.
test("the served SDK bundle drops a late restore once the user has opened a card of their own", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector(".lavish-cancel").onclick();
  const cardsAfterCancel = sdk.cards().length;

  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  // Cancelling really removes the card, so the restore is proven by nothing coming back rather
  // than by what a leftover card holds.
  assert.equal(sdk.cards().length, cardsAfterCancel, "the cancelled card is not replaced by a restored one");
  assert.equal(cardsAfterCancel, 0, "cancelling closes the card");
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );
});

// --- the two modes, and editing text in place ---------------------------------------------------

function editableParagraph(sdk, text) {
  const paragraph = appendTo(sdk.body, createElement("p"));
  paragraph.textContent = text;
  paragraph.innerHTML = text;
  paragraph.childNodes = [{ nodeType: 3, textContent: text }];
  return paragraph;
}

test("clicking an element opens a card while annotate is armed", () => {
  const sdk = bootSdk();
  sdk.click(editableParagraph(sdk, "The goal of the tool"));

  assert.equal(sdk.cards().length, 1, "annotate is the mode a session opens in");
});

test("enter writes a line inside the block, and only cmd+enter ends the edit", () => {
  const sdk = bootSdk();
  const paragraph = editableParagraph(sdk, "Profile a source");

  sdk.edit(paragraph);
  const keydown = paragraph.listeners.find((entry) => entry.type === "keydown");
  keydown.handler({ key: "Enter", shiftKey: false, preventDefault() {} });

  assert.deepEqual(sdk.execCommands, [
    ["insertLineBreak", undefined],
    // insertLineBreak is not everywhere; a <br> is the fallback, and the tag an edit may write.
    ["insertHTML", "<br>"],
  ]);
  assert.equal(paragraph.getAttribute("contenteditable"), "true", "the block keeps the caret");
  assert.ok(!sdk.posted.some((message) => message.type === "lavish:textEdit"));

  paragraph.innerHTML = "Profile a source<br>Review each field";
  keydown.handler({ key: "Enter", shiftKey: false, metaKey: true, preventDefault() {} });

  assert.equal(sdk.posted.at(-1).after, "Profile a source<br>Review each field");
  assert.equal(paragraph.getAttribute("contenteditable"), null, "cmd+enter ends it");
});

test("enter in a list is left to the browser, which makes the next item", () => {
  const sdk = bootSdk();
  const paragraph = editableParagraph(sdk, "Profile a source");

  sdk.edit(paragraph);
  sdk.tool("ul").onclick();
  const list = sdk.body.children.at(-1);
  let prevented = false;
  list.listeners
    .find((entry) => entry.type === "keydown")
    .handler({ key: "Enter", shiftKey: false, preventDefault: () => (prevented = true) });

  assert.equal(prevented, false);
  assert.deepEqual(sdk.execCommands, [], "no line break is forced into a list");
});

test("escape dismisses an open annotation card", () => {
  const sdk = bootSdk();
  sdk.click(editableParagraph(sdk, "The goal of the tool"));
  assert.equal(sdk.cards().length, 1);

  assert.equal(sdk.pressKey("Escape"), true);

  assert.equal(sdk.cards().length, 0);
  assert.equal(sdk.pressKey("Escape"), false, "with no card open, escape is the artifact's own");
});

test("clicking an element edits it in place while edit is armed", () => {
  const sdk = bootSdk();
  const paragraph = editableParagraph(sdk, "The goal of the tool");

  sdk.edit(paragraph);

  assert.equal(paragraph.getAttribute("contenteditable"), "true");
  assert.equal(paragraph.getAttribute("data-lavish-editing"), "true");
  assert.equal(sdk.cards().length, 0, "editing never opens an annotation card");
});

test("an element holding markup is refused rather than edited", () => {
  const sdk = bootSdk();
  const wrapper = appendTo(sdk.body, createElement("div"));
  wrapper.textContent = "a heading and a paragraph";
  wrapper.childNodes = [createElement("h2"), createElement("p")];

  sdk.edit(wrapper);

  assert.equal(wrapper.getAttribute("contenteditable"), null);
  assert.equal(wrapper.style.outline, "2px solid #ff9d7a", "the refusal is visible on the element");
});

test("arming one mode disarms the other", () => {
  const sdk = bootSdk();
  const paragraph = editableParagraph(sdk, "The goal of the tool");

  sdk.setMode("edit");
  sdk.setMode("annotate");
  sdk.rawClick(paragraph);

  assert.equal(paragraph.getAttribute("contenteditable"), null, "annotate wins once it is armed");
  assert.equal(sdk.cards().length, 1);
});

test("a bare a or e asks the chrome to switch mode, unless it is being typed", () => {
  const sdk = bootSdk();

  assert.equal(sdk.pressKey("e"), true);
  assert.equal(sdk.posted.at(-1).type, "lavish:toggleEditMode");
  assert.equal(sdk.pressKey("a"), true);
  assert.equal(sdk.posted.at(-1).type, "lavish:toggleAnnotationMode");

  const field = createElement("textarea");
  const before = sdk.posted.length;
  assert.equal(sdk.pressKey("e", field), false);
  assert.equal(sdk.posted.length, before, "a letter typed into a field is just a letter");
});

test("editing opens a toolbar of the tools the file can hold", () => {
  const sdk = bootSdk();
  const paragraph = editableParagraph(sdk, "The goal of the tool");

  sdk.edit(paragraph);

  assert.deepEqual(
    sdk
      .toolbar()
      .children.filter((child) => child.tagName === "BUTTON")
      .map((child) => child.getAttribute("data-tool")),
    ["ul", "ol", "bold", "italic", "link"],
  );

  paragraph.listeners.find((entry) => entry.type === "keydown").handler({ key: "Escape", preventDefault() {} });
  assert.equal(sdk.toolbar(), undefined, "the toolbar goes when the edit does");
});

test("bullets turn the block into a list, and the file is asked to replace the element", () => {
  const sdk = bootSdk();
  const paragraph = editableParagraph(sdk, "Profile a source");
  paragraph.innerHTML = "Profile a source<br>Review each field";

  sdk.edit(paragraph);
  sdk.tool("ul").onclick();

  const list = sdk.body.children.at(-1);
  assert.equal(list.tagName, "UL");
  assert.equal(list.innerHTML, "<li>Profile a source</li><li>Review each field</li>");
  assert.equal(list.getAttribute("contenteditable"), "true", "editing carries on in the new element");
  assert.equal(sdk.tool("ul").getAttribute("aria-pressed"), "true");

  list.listeners
    .find((entry) => entry.type === "keydown")
    .handler({ key: "Enter", shiftKey: false, metaKey: true, preventDefault() {} });

  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:textEdit");
  assert.equal(message.tag, "p", "the patch travels under the identity the edit began with");
  assert.equal(message.scope, "outer");
  assert.equal(message.after, "<ul><li>Profile a source</li><li>Review each field</li></ul>");
});

test("a saved edit is re-rendered from what the file now holds", () => {
  const sdk = bootSdk();
  const paragraph = editableParagraph(sdk, "The goal of the tool");

  sdk.edit(paragraph);
  paragraph.innerHTML = 'The <span class="x">goal</span> of the tool';
  paragraph.listeners
    .find((entry) => entry.type === "keydown")
    .handler({ key: "Enter", shiftKey: false, metaKey: true, preventDefault() {} });
  sdk.sendChromeMessage({ type: "lavish:textEditResult", ok: true, markup: "The goal of the tool" });

  assert.equal(paragraph.innerHTML, "The goal of the tool", "the stripped span does not linger on screen");
});

test("committing an in-place edit sends the element's position and both texts", () => {
  const sdk = bootSdk();
  const paragraph = editableParagraph(sdk, "The goal of the tool");

  sdk.edit(paragraph);
  paragraph.innerHTML = "What the tool is for";
  const keydown = paragraph.listeners.find((entry) => entry.type === "keydown");
  keydown.handler({ key: "Enter", shiftKey: false, metaKey: true, preventDefault() {} });

  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:textEdit");
  assert.equal(message.tag, "p");
  assert.equal(message.index, 0);
  assert.equal(message.scope, "inner");
  assert.equal(message.before, "The goal of the tool");
  assert.equal(message.after, "What the tool is for");
  assert.equal(paragraph.getAttribute("contenteditable"), null, "editing ends on commit");
});

test("escape leaves the text as the file has it", () => {
  const sdk = bootSdk();
  const paragraph = editableParagraph(sdk, "The goal of the tool");

  sdk.edit(paragraph);
  paragraph.innerHTML = "half-typed replacement";
  const keydown = paragraph.listeners.find((entry) => entry.type === "keydown");
  keydown.handler({ key: "Escape", preventDefault() {} });

  assert.equal(paragraph.innerHTML, "The goal of the tool");
  assert.ok(!sdk.posted.some((message) => message.type === "lavish:textEdit"), "a cancelled edit is never sent");
});

test("a refused edit puts the old text back", () => {
  const sdk = bootSdk();
  const paragraph = editableParagraph(sdk, "The goal of the tool");

  sdk.edit(paragraph);
  paragraph.innerHTML = "written while the file changed";
  paragraph.listeners
    .find((entry) => entry.type === "keydown")
    .handler({ key: "Enter", shiftKey: false, metaKey: true, preventDefault() {} });
  sdk.sendChromeMessage({ type: "lavish:textEditResult", ok: false, error: "stale" });

  assert.equal(paragraph.innerHTML, "The goal of the tool");
});

test("an unchanged edit is not sent", () => {
  const sdk = bootSdk();
  const paragraph = editableParagraph(sdk, "The goal of the tool");

  sdk.edit(paragraph);
  paragraph.listeners
    .find((entry) => entry.type === "keydown")
    .handler({ key: "Enter", shiftKey: false, metaKey: true, preventDefault() {} });

  assert.ok(!sdk.posted.some((message) => message.type === "lavish:textEdit"));
});
