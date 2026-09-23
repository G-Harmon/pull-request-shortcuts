"use strict";
// File discovery and the "how many files does this page have" logic, on both UIs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PR, loadPage, navigate, layout } = require("./helpers");

// Array.from (Node realm) rather than els.map (jsdom realm) so strict deepEqual compares
// structure, not Array prototype identity across realms.
const ids = (els) => Array.from(els, (e) => e.id);

test("classic: getFiles finds .file entries and ignores suggestion blobs in comments", () => {
  const { prks, warnings } = loadPage("classic-files.html", PR + "/files");
  assert.deepEqual(ids(prks.getFiles()), ["diff-aaa", "diff-bbb", "diff-ccc"]);
  assert.deepEqual(warnings, []);
});

test("classic: getViewFiles drops files hidden by a file filter", () => {
  const { prks } = loadPage("classic-files.html", PR + "/files");
  assert.deepEqual(ids(prks.getViewFiles()), ["diff-aaa", "diff-bbb"]);
});

test("new UI: getFiles finds role=region diff-* files", () => {
  const { prks } = loadPage("new-files.html", PR + "/changes");
  assert.deepEqual(ids(prks.getFiles()), ["diff-111", "diff-222", "diff-333"]);
  assert.deepEqual(ids(prks.getViewFiles()), ["diff-111", "diff-222"]);
});

test("fileHeader picks the UI-appropriate header element", () => {
  const classic = loadPage("classic-files.html", PR + "/files");
  const c = classic.prks.getFiles()[0];
  assert.ok(classic.prks.fileHeader(c).classList.contains("file-header"));

  const fresh = loadPage("new-files.html", PR + "/changes");
  const n = fresh.prks.getFiles()[0];
  assert.ok(fresh.prks.fileHeader(n).hasAttribute("data-diff-header-wrapper"));
});

test("getFiles warns (once per call) only when a files page has no files", () => {
  const { dom, document, prks, warnings } = loadPage("classic-files.html", PR + "/files");
  document.getElementById("files").remove();
  navigate(dom, PR); // Conversation: silent
  assert.equal(prks.getFiles().length, 0);
  assert.equal(warnings.length, 0);
  navigate(dom, PR + "/files");
  assert.equal(prks.getFiles().length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No diff files found/);
});

test("getCurrentIndex is the first file not yet scrolled past the sticky line", () => {
  const { prks } = loadPage("classic-files.html", PR + "/files");
  const files = prks.getViewFiles();
  // a: fully above the line (scrolled past); b: straddles it.
  layout(files[0], { top: -500, height: 400 });
  layout(files[1], { top: -100, height: 300 });
  assert.equal(prks.getCurrentIndex(files), 1);
  // Both on screen below the line: the first wins.
  layout(files[0], { top: 100, height: 400 });
  layout(files[1], { top: 500, height: 300 });
  assert.equal(prks.getCurrentIndex(files), 0);
  assert.equal(prks.getCurrentIndex([]), -1);
});

test("expectedFileCount reads the Files tab counter on the whole-PR view", () => {
  const { prks } = loadPage("classic-files.html", PR + "/files");
  assert.equal(prks.expectedFileCount(), 3);
  assert.equal(prks.diffStillLoading(), false); // 3 loaded of 3
});

test("expectedFileCount is null on a single-commit diff (counter is the whole PR's)", () => {
  // Regression: the commit touches 3 files but the counter says 12. Trusting it would make
  // `u` report "still loading" forever.
  const { dom, prks } = loadPage("classic-commit.html", PR + "/commits/0123abcdef456");
  assert.equal(prks.getFiles().length, 3);
  assert.equal(prks.expectedFileCount(), null);
  assert.equal(prks.diffStillLoading(), false);
  // The same DOM at the whole-PR URL would (correctly) still be loading.
  navigate(dom, PR + "/files");
  assert.equal(prks.expectedFileCount(), 12);
  assert.equal(prks.diffStillLoading(), true);
});

test("new UI: no readable counter, so never 'still loading'", () => {
  const { prks } = loadPage("new-files.html", PR + "/changes");
  assert.equal(prks.expectedFileCount(), null);
  assert.equal(prks.diffStillLoading(), false);
});
