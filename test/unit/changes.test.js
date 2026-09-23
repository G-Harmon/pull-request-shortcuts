"use strict";
// Changed-row detection for j/k on both UIs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PR, loadPage } = require("./helpers");

const text = (tr) => tr.textContent.trim();

test("classic: changed rows are those with addition/deletion cells, one entry per row", () => {
  const { document, prks } = loadPage("classic-files.html", PR + "/files");
  const rows = prks.changedRows();
  assert.deepEqual(Array.from(rows, text), [
    "+ added 1",
    "+ added 2",
    "- removed",
    "+ added",
    "- removed",
    "+ suggested", // classic selector is page-wide; the suggestion blob's row is included here
  ]);
  const ctx = document.querySelector("#diff-aaa tr");
  assert.equal(prks.isChangedRow(ctx), false);
  assert.equal(prks.isChangedRow(rows[0]), true);
  assert.equal(prks.isChangedRow(null), false);
});

test("new UI: hunk headers and neutral (context) rows are not changes", () => {
  const { document, prks } = loadPage("new-files.html", PR + "/changes");
  const rows = prks.changedRows();
  assert.deepEqual(Array.from(rows, text), ["2+ added 1", "3+ added 2", "5- removed", "1+ added", "1- removed"]);
  const [hunk, ctx] = document.querySelectorAll("#diff-111 tr.diff-line-row");
  assert.equal(prks.isChangedRow(hunk), false);
  assert.equal(prks.isChangedRow(ctx), false);
});
