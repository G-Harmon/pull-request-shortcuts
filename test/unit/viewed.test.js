"use strict";
// The "Viewed" control abstraction (viewedToggle) on both UIs, and files that have none.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PR, loadPage } = require("./helpers");

test("classic: checkbox-based Viewed control", () => {
  const { prks } = loadPage("classic-files.html", PR + "/files");
  const [a, b] = prks.getFiles();
  assert.equal(prks.isFileViewed(a), false);
  assert.equal(prks.isFileViewed(b), true);

  assert.equal(prks.markFileViewed(a), true, "marks an unviewed file");
  assert.equal(a.querySelector("input.js-reviewed-checkbox").checked, true);
  assert.equal(prks.isFileViewed(a), true);
  assert.equal(prks.markFileViewed(a), false, "already viewed: no-op");

  assert.equal(prks.unmarkFileViewed(a), true);
  assert.equal(prks.isFileViewed(a), false);
  assert.equal(prks.unmarkFileViewed(a), false, "already unviewed: no-op");
});

test("new UI: aria-pressed button Viewed control", () => {
  const { prks } = loadPage("new-files.html", PR + "/changes");
  const [a, b] = prks.getFiles();
  assert.equal(prks.isFileViewed(a), false);
  assert.equal(prks.isFileViewed(b), true);

  assert.equal(prks.markFileViewed(a), true);
  assert.equal(a.querySelector("button[aria-pressed]").getAttribute("aria-pressed"), "true");
  assert.equal(prks.isFileViewed(a), true);
  assert.equal(prks.markFileViewed(a), false);

  assert.equal(prks.unmarkFileViewed(b), true);
  assert.equal(prks.isFileViewed(b), false);
});

test("a file with no Viewed control has no toggle and counts as not viewed", () => {
  const { prks } = loadPage("classic-commit.html", PR + "/commits/0123abcdef456");
  const b = prks.getFiles()[1];
  assert.equal(b.id, "diff-bbb");
  assert.equal(prks.viewedToggle(b), null);
  assert.equal(prks.isFileViewed(b), false);
  assert.equal(prks.markFileViewed(b), false);
  assert.equal(prks.unmarkFileViewed(b), false);
});
