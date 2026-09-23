"use strict";
// URL gating: which PR pages each shortcut group is live on. Table-driven so a new page
// variant is one more row.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PR, loadPage, navigate } = require("./helpers");

const BASE = "https://github.com";

// path → { pr, files, conversation, commitDiff }
const CASES = [
  ["/o/r/pull/7", { pr: true, files: false, conversation: true, commitDiff: false }],
  ["/o/r/pull/7/", { pr: true, files: false, conversation: true, commitDiff: false }],
  ["/o/r/pull/7/files", { pr: true, files: true, conversation: false, commitDiff: false }],
  ["/o/r/pull/7/changes", { pr: true, files: true, conversation: false, commitDiff: false }],
  ["/o/r/pull/7/commits", { pr: true, files: false, conversation: false, commitDiff: false }],
  // Regression: a single commit picked from "Changes from" lands here. It renders the
  // Files-tab diff markup, so the file-navigation keys must be live.
  ["/o/r/pull/7/commits/0123abcdef456", { pr: true, files: true, conversation: false, commitDiff: true }],
  ["/o/r/pull/7/files/0123abc..456def", { pr: true, files: true, conversation: false, commitDiff: true }],
  ["/o/r/pull/7/changes/0123abc..456def", { pr: true, files: true, conversation: false, commitDiff: true }],
  ["/o/r/pull/7/checks", { pr: true, files: false, conversation: false, commitDiff: false }],
  ["/o/r/pulls", { pr: false, files: false, conversation: false, commitDiff: false }],
  ["/o/r/issues/7", { pr: false, files: false, conversation: false, commitDiff: false }],
  ["/o/r/commit/0123abcdef456", { pr: false, files: false, conversation: false, commitDiff: false }],
];

test("page gating by URL", () => {
  const { dom, prks } = loadPage("classic-files.html", PR + "/files");
  for (const [p, want] of CASES) {
    navigate(dom, BASE + p);
    const got = {
      pr: prks.isPrPage(),
      files: prks.isPrFilesPage(),
      conversation: prks.isPrConversationPage(),
      commitDiff: prks.isCommitDiffPage(),
    };
    assert.deepEqual(got, want, p);
  }
});

test("filesTabSuffix follows the current path when it is a files page", () => {
  const { dom, prks } = loadPage("classic-files.html", PR + "/files");
  assert.equal(prks.filesTabSuffix(), "/files");
  navigate(dom, PR + "/changes");
  assert.equal(prks.filesTabSuffix(), "/changes");
});

test("filesTabSuffix falls back to whichever tab link the page has", () => {
  // Classic nav links to /files: from the Conversation tab or a single-commit view, g f
  // must go to /files.
  const classic = loadPage("classic-files.html", PR);
  assert.equal(classic.prks.filesTabSuffix(), "/files");
  navigate(classic.dom, PR + "/commits/0123abcdef456");
  assert.equal(classic.prks.filesTabSuffix(), "/files");

  const fresh = loadPage("new-files.html", PR);
  assert.equal(fresh.prks.filesTabSuffix(), "/changes");
});
