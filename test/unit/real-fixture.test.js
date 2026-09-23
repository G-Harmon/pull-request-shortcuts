"use strict";
// Against a sanitized REAL page: a GitHub Enterprise classic single-commit diff
// (test/fixtures/real/). Unlike the hand-written fixtures this is what the extension actually
// met in the wild, so these tests pin down real-world facts: the commit view has no "Viewed"
// checkbox, GitHub's own role="region" element is not a file, and so on.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, press, toastText } = require("./helpers");

const FIXTURE = "real/ghe-classic-single-commit.html";
const URL =
  "https://github.com/acme/sandbox/pull/87/commits/c511c45d8f512a3ea0f13c06fe01a3d63c2393fe";

test("real GHE single-commit page: gated as a files page and a commit diff", () => {
  const { prks } = loadPage(FIXTURE, URL);
  assert.equal(prks.isPrFilesPage(), true);
  assert.equal(prks.isCommitDiffPage(), true);
  assert.equal(prks.isPrConversationPage(), false);
  assert.equal(prks.filesTabSuffix(), "/files", "Enterprise: classic /files tab");
});

test("real GHE single-commit page: exactly one file, found via the classic selector", () => {
  const { prks, warnings } = loadPage(FIXTURE, URL);
  const files = prks.getFiles();
  assert.equal(files.length, 1);
  assert.equal(files[0].getAttribute("data-tagsearch-path"), "scripts/install-iwyu.sh");
  // GitHub's own portal root is role="region" but not a diff container.
  assert.equal(files[0].getAttribute("role"), null);
  assert.ok(prks.fileHeader(files[0]).classList.contains("file-header"));
  assert.deepEqual(warnings, []);
});

test("real GHE single-commit page: the file has no Viewed control", () => {
  const { prks } = loadPage(FIXTURE, URL);
  const file = prks.getFiles()[0];
  assert.equal(prks.viewedToggle(file), null);
  assert.equal(prks.isFileViewed(file), false);
});

test("real GHE single-commit page: changed rows are detected", () => {
  const { prks } = loadPage(FIXTURE, URL);
  const rows = prks.changedRows();
  assert.ok(rows.length >= 8, `expected several changed rows, got ${rows.length}`);
  assert.ok(rows.every((tr) => prks.isChangedRow(tr)));
});

test("real GHE single-commit page: file counter is ignored on the commit view", () => {
  const { prks } = loadPage(FIXTURE, URL);
  assert.equal(prks.expectedFileCount(), null);
  assert.equal(prks.diffStillLoading(), false);
});

test("real GHE single-commit page: `v` reports the file can't be marked; `u` doesn't hang on 'loading'", () => {
  const { prks, window, document } = loadPage(FIXTURE, URL);
  let e = press(window, "v");
  assert.equal(e.defaultPrevented, true, "handled (the original bug: nothing happened here)");
  assert.match(toastText(document), /Can't mark this file viewed/);
  assert.deepEqual(JSON.parse(JSON.stringify(prks.markHistory)), []);

  e = press(window, "u");
  assert.equal(e.defaultPrevented, true);
  assert.doesNotMatch(toastText(document), /Loading/);
});
