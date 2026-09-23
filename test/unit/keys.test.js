"use strict";
// Keypress-level behavior: real KeyboardEvents dispatched on the document, observed through
// DOM side effects (checkbox state, toast text, recorded scrolls). These are the closest the
// jsdom tier gets to "what the user sees".
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  PR,
  loadPage,
  layout,
  layoutAsCurrent,
  layoutAsScrolledPast,
  press,
  toastText,
  twoFrames,
} = require("./helpers");

const COMMIT = PR + "/commits/0123abcdef456";
const checkbox = (file) => file.querySelector("input.js-reviewed-checkbox");
// markHistory is created inside the jsdom realm; strip its prototypes so strict deepEqual
// compares structure rather than realm identity.
const history = (prks) => JSON.parse(JSON.stringify(prks.markHistory));

test("regression: `v` marks the current file viewed on a single-commit diff", () => {
  const { prks, window } = loadPage("classic-commit.html", COMMIT);
  const [a, b, c] = prks.getFiles();
  layoutAsCurrent(prks, a);
  layout(b, { top: 500, height: 300 });
  layout(c, { top: 800, height: 300 });

  const e = press(window, "v");
  assert.equal(e.defaultPrevented, true, "the key was handled");
  assert.equal(checkbox(a).checked, true);
  assert.deepEqual(history(prks), [["diff-aaa"]]);
});

test("`v` is inert on the Commits list itself", () => {
  const { prks, window } = loadPage("classic-commit.html", PR + "/commits");
  const a = prks.getFiles()[0];
  layoutAsCurrent(prks, a);
  const e = press(window, "v");
  assert.equal(e.defaultPrevented, false);
  assert.equal(checkbox(a).checked, false);
});

test("`v` on a file with no Viewed control skips to the next file", () => {
  const { prks, window, document } = loadPage("classic-commit.html", COMMIT);
  const [a, b, c] = prks.getFiles();
  layoutAsScrolledPast(a);
  layoutAsCurrent(prks, b); // b has no control
  layout(c, { top: 600, height: 300 });
  layout(prks.fileHeader(c), { top: 600, height: 40 });

  press(window, "v");
  assert.match(toastText(document), /skipped to next/);
  const last = window.scrollCalls.at(-1);
  assert.equal(last.top, 600 - prks.STICKY_OFFSET, "scrolled so c's header sits under the sticky bar");
  assert.deepEqual(history(prks), [], "nothing was marked");
});

test("`v` on an unmarkable last file says so and stays", () => {
  const { prks, window, document } = loadPage("classic-commit.html", COMMIT);
  const [a, b, c] = prks.getFiles();
  c.remove();
  layoutAsScrolledPast(a);
  layoutAsCurrent(prks, b);
  press(window, "v");
  assert.match(toastText(document), /last file/);
  assert.equal(window.scrollCalls.length, 0);
});

test("regression: `u` with everything viewed on a single-commit diff says 'All files viewed'", () => {
  // Counter says 12 files, this commit has 2 (after dropping the control-less one). Before the
  // fix this showed a sticky "Loading… (2 / 12 files)" toast and waited 30 s.
  const { prks, window, document } = loadPage("classic-commit.html", COMMIT);
  const [a, b, c] = prks.getFiles();
  b.remove();
  checkbox(a).checked = true;
  checkbox(c).checked = true;
  layoutAsCurrent(prks, a);
  press(window, "u");
  assert.equal(toastText(document), "All files viewed");
});

test("`u` jumps to the next not-viewed file below the current one", () => {
  const { prks, window, document } = loadPage("classic-files.html", PR + "/files");
  const [a, b] = prks.getViewFiles(); // a: unviewed, b: viewed
  layoutAsScrolledPast(b); // put b (viewed) "above" so a is not current
  layoutAsCurrent(prks, a);
  // Nothing unviewed below a, so `u` wraps to the topmost unviewed — a itself.
  press(window, "u");
  assert.equal(toastText(document), "Wrapped to first unviewed");
});

test("`]` scrolls to the next file's header and reports the position", () => {
  const { prks, window, document } = loadPage("classic-files.html", PR + "/files");
  const [a, b] = prks.getViewFiles();
  layoutAsCurrent(prks, a);
  layout(b, { top: 500, height: 300 });
  layout(prks.fileHeader(b), { top: 500, height: 40 });
  press(window, "]");
  assert.equal(toastText(document), "File 2 / 2");
  assert.equal(window.scrollCalls.at(-1).top, 500 - prks.STICKY_OFFSET);
  assert.equal(window.location.hash, "#diff-bbb", "the file became the :target");
});

test("`V` marks every markable file in view; `b` undoes the batch", async () => {
  const { prks, window, document } = loadPage("classic-commit.html", COMMIT);
  const [a, b, c] = prks.getFiles();
  press(window, "V");
  assert.equal(checkbox(a).checked, true);
  assert.equal(prks.viewedToggle(b), null, "b has nothing to mark");
  assert.equal(checkbox(c).checked, true);
  assert.equal(toastText(document), "Marked 2 files viewed");
  assert.deepEqual(history(prks), [["diff-aaa", "diff-ccc"]]);

  press(window, "V");
  assert.equal(toastText(document), "Already all viewed");

  press(window, "b");
  assert.equal(checkbox(a).checked, false);
  assert.equal(checkbox(c).checked, false);
  await twoFrames(window); // undo re-positions (and toasts) after layout settles
  assert.equal(toastText(document), "Undid 2 files");
});

test("`V` with no markable files says so instead of 'Already all viewed'", () => {
  const { prks, window, document } = loadPage("classic-commit.html", COMMIT);
  document.querySelectorAll(".js-reviewed-toggle").forEach((l) => l.remove());
  assert.equal(prks.getFiles().length, 3);
  press(window, "V");
  assert.equal(toastText(document), "No files here can be marked viewed");
});

test("shortcuts are ignored while typing in a text field", () => {
  const { prks, window, document } = loadPage("classic-files.html", PR + "/files");
  const a = prks.getFiles()[0];
  layoutAsCurrent(prks, a);
  document.getElementById("comment-box").focus();
  const e = press(window, "v");
  assert.equal(e.defaultPrevented, false);
  assert.equal(checkbox(a).checked, false);
});

test("`\\` toggles the help overlay, dimming rows that don't apply to this tab", () => {
  const { dom, window, document } = loadPage("classic-files.html", PR + "/files");
  press(window, "\\");
  let help = document.querySelector(".prks-help");
  assert.ok(help, "help is open");
  const rows = help.querySelectorAll("tr");
  assert.equal(rows[0].classList.contains("dim"), false, "`]` row lit on the Files tab");

  const e = press(window, "x"); // any key closes and is swallowed
  assert.equal(document.querySelector(".prks-help"), null);
  assert.equal(e.defaultPrevented, true);

  dom.reconfigure({ url: PR }); // Conversation tab
  press(window, "\\");
  help = document.querySelector(".prks-help");
  assert.equal(help.querySelectorAll("tr")[0].classList.contains("dim"), true, "`]` row dimmed");
});

test("`g` `f` on the Conversation tab clicks the Files changed tab link", () => {
  const { window, document } = loadPage("classic-files.html", PR);
  const link = document.querySelector('a[href="/o/r/pull/7/files"]');
  let clicked = 0;
  link.addEventListener("click", (e) => {
    clicked++;
    e.preventDefault(); // jsdom can't navigate
  });
  press(window, "g");
  press(window, "f");
  assert.equal(clicked, 1);
});

test("`g` `m` on a single-commit diff goes to the Commits list", () => {
  const { window, document } = loadPage("classic-commit.html", COMMIT);
  const link = document.querySelector('a[href="/o/r/pull/7/commits"]');
  let clicked = 0;
  link.addEventListener("click", (e) => {
    clicked++;
    e.preventDefault();
  });
  press(window, "g");
  press(window, "m");
  assert.equal(clicked, 1);
});
