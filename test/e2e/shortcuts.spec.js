// @ts-check
// Real-browser tests: the unpacked extension is loaded into Google Chrome exactly as a user
// would load it, and the fixture pages are served at real github.com URLs via request
// interception. That way the manifest's `https://github.com/*` content-script match injects
// content.js and overlay.css with no test-only tweaks, and layout, smooth scrolling and the
// :target highlight all run for real. No network access to github.com is made.
//
// Run:  npm run test:e2e            (headless; Chrome >= 132 supports extensions headless)
//       HEADED=1 npm run test:e2e   (watch it)
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test: base, expect, chromium } = require("@playwright/test");

const ROOT = path.join(__dirname, "..", "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const PR = "https://github.com/o/r/pull/7";
const SHA = "0123abcdef456";

// Which fixture backs which PR URL. The commits *list* deliberately serves the same
// single-commit markup so a test can prove the shortcuts stay inert there by URL alone.
const ROUTES = [
  // Sanitized real GitHub Enterprise page (see test/fixtures/real/).
  [/\/pull\/87\/commits\/[0-9a-f]+$/, "real/ghe-classic-single-commit.html"],
  [/\/pull\/7\/commits\/[0-9a-f]+$/, "classic-commit.html"],
  [/\/pull\/7\/commits$/, "classic-commit.html"],
  [/\/pull\/7\/files$/, "classic-files.html"],
  [/\/pull\/7\/changes$/, "new-files.html"],
];

const test = base.extend({
  // Extensions need a persistent context; one fresh profile per test.
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prks-e2e-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      // Playwright's own Chromium (`npx playwright install chromium`). Branded Google Chrome
      // ignores --load-extension since Chrome 137, so the system Chrome silently loads no
      // extension; and the headless-shell build has no extension support either. This
      // channel is the full Chromium build, which supports extensions headless.
      channel: "chromium",
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
    });
    await context.route("https://github.com/**", (route) => {
      const { pathname } = new URL(route.request().url());
      const hit = ROUTES.find(([re]) => re.test(pathname));
      route.fulfill({
        contentType: "text/html",
        body: hit
          ? fs.readFileSync(path.join(FIXTURES, hit[1]), "utf8")
          : "<!doctype html><title>stub</title><p>stub page</p>",
      });
    });
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
  },
});

// Content scripts inject at document_idle, slightly after `load`, and a keypress that lands
// before that is simply lost. The content script is in an isolated world (no `window.__prks`
// visible to page.evaluate), so probe by toggling the help overlay until it responds.
async function openPr(page, suffix, base = PR) {
  await page.goto(base + suffix);
  await expect
    .poll(
      async () => {
        await page.keyboard.press("\\");
        return page
          .locator(".prks-help")
          .waitFor({ timeout: 250 })
          .then(() => true)
          .catch(() => false);
      },
      { timeout: 10_000, message: "extension did not respond to the help key" }
    )
    .toBe(true);
  await page.keyboard.press("\\"); // any key closes the help
  await expect(page.locator(".prks-help")).toHaveCount(0);
}

const toast = (page) => page.locator(".prks-toast");
const headerTop = (page, fileId) =>
  page.evaluate(
    (id) =>
      Math.round(
        document
          .querySelector(`#${id} .file-header, #${id} [data-diff-header-wrapper]`)
          .getBoundingClientRect().top
      ),
    fileId
  );
const STICKY_OFFSET = 60; // mirrors content.js

test.describe("single-commit diff (/pull/N/commits/<sha>)", () => {
  test("`v` marks the current file viewed", async ({ page }) => {
    await openPr(page, `/commits/${SHA}`);
    const box = page.locator("#diff-aaa input.js-reviewed-checkbox");
    await expect(box).not.toBeChecked();
    await page.keyboard.press("v");
    await expect(box).toBeChecked();
  });

  test("`v` on a file with no Viewed control skips to the next file", async ({ page }) => {
    await openPr(page, `/commits/${SHA}`);
    await page.evaluate(() => document.getElementById("diff-bbb").scrollIntoView());
    await page.keyboard.press("v");
    await expect(toast(page)).toContainText("skipped to next");
    await expect.poll(() => headerTop(page, "diff-ccc")).toBe(STICKY_OFFSET);
    await expect(page.locator("#diff-ccc input.js-reviewed-checkbox")).not.toBeChecked();
  });

  test("`u` with every markable file viewed says so instead of waiting for 'loading'", async ({
    page,
  }) => {
    await openPr(page, `/commits/${SHA}`);
    await page.evaluate(() => {
      document.getElementById("diff-bbb").remove(); // the control-less file
      document
        .querySelectorAll("input.js-reviewed-checkbox")
        .forEach((c) => ((/** @type {HTMLInputElement} */ (c)).checked = true));
    });
    await page.keyboard.press("u");
    await expect(toast(page)).toHaveText("All files viewed");
  });

  test("`V` marks all markable files; `b` undoes them", async ({ page }) => {
    await openPr(page, `/commits/${SHA}`);
    await page.keyboard.press("Shift+V");
    await expect(toast(page)).toHaveText("Marked 2 files viewed");
    await expect(page.locator("#diff-aaa input.js-reviewed-checkbox")).toBeChecked();
    await expect(page.locator("#diff-ccc input.js-reviewed-checkbox")).toBeChecked();
    await page.keyboard.press("b");
    await expect(toast(page)).toHaveText("Undid 2 files");
    await expect(page.locator("#diff-aaa input.js-reviewed-checkbox")).not.toBeChecked();
  });

  test("`g` `m` goes to the Commits list", async ({ page }) => {
    await openPr(page, `/commits/${SHA}`);
    await page.keyboard.press("g");
    await page.keyboard.press("m");
    await expect(page).toHaveURL(/\/pull\/7\/commits$/);
  });
});

test("shortcuts are inert on the Commits list even with diff markup present", async ({ page }) => {
  await openPr(page, "/commits");
  await page.keyboard.press("v");
  await page.keyboard.press("]");
  await page.waitForTimeout(300);
  await expect(page.locator("#diff-aaa input.js-reviewed-checkbox")).not.toBeChecked();
  await expect(toast(page)).toHaveCount(0);
});

test.describe("classic Files changed (/pull/N/files)", () => {
  test("`]` scrolls the next file's header under the sticky bar and makes it :target", async ({
    page,
  }) => {
    await openPr(page, "/files");
    await page.keyboard.press("]");
    await expect(toast(page)).toHaveText("File 2 / 2"); // c is hidden by the filter
    await expect.poll(() => headerTop(page, "diff-bbb")).toBe(STICKY_OFFSET);
    await expect(page).toHaveURL(/#diff-bbb$/);
  });

  test("`u` from the top skips the viewed file and wraps to the only unviewed one", async ({
    page,
  }) => {
    await openPr(page, "/files");
    await page.keyboard.press("]"); // sit on b (viewed)
    await expect(toast(page)).toHaveText("File 2 / 2");
    await page.keyboard.press("u");
    await expect(toast(page)).toHaveText("Wrapped to first unviewed");
    await expect.poll(() => headerTop(page, "diff-aaa")).toBe(STICKY_OFFSET);
  });

  test("keys are ignored while typing in a text field", async ({ page }) => {
    await openPr(page, "/files");
    await page.locator("#comment-box").focus();
    await page.keyboard.press("v");
    await page.waitForTimeout(300);
    await expect(page.locator("#diff-aaa input.js-reviewed-checkbox")).not.toBeChecked();
    await expect(page.locator("#comment-box")).toHaveValue("v");
  });

  test("help overlay lists the Files shortcuts and closes on any key", async ({ page }) => {
    await openPr(page, "/files");
    await page.keyboard.press("\\");
    const help = page.locator(".prks-help");
    await expect(help).toBeVisible();
    await expect(help).toContainText("Mark file viewed");
    await expect(help.locator("tr").first()).not.toHaveClass(/dim/);
    await page.screenshot({ path: test.info().outputPath("help.png") });
    await page.keyboard.press("x");
    await expect(help).toHaveCount(0);
  });
});

test.describe("new pull-request experience (/pull/N/changes)", () => {
  test("`v` toggles the aria-pressed Viewed button", async ({ page }) => {
    await openPr(page, "/changes");
    const btn = page.locator("#diff-111 button[aria-pressed]");
    await expect(btn).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("v");
    await expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  test("`j` lands on the first change block and highlights it", async ({ page }) => {
    await openPr(page, "/changes");
    await page.keyboard.press("j");
    const highlighted = page.locator("tr.prks-change");
    await expect(highlighted).toHaveCount(2); // "+ added 1", "+ added 2"
    await expect(highlighted.first()).toContainText("added 1");
  });
});

test.describe("real GitHub Enterprise single-commit page (sanitized capture)", () => {
  const REAL_PR = "https://github.com/acme/sandbox/pull/87";
  const REAL_SHA = "c511c45d8f512a3ea0f13c06fe01a3d63c2393fe";

  test("`v` is handled and reports the file can't be marked (the original bug)", async ({
    page,
  }) => {
    await openPr(page, `/commits/${REAL_SHA}`, REAL_PR);
    // Plain `.file` also matches code-suggestion blobs inside the two review comments (which
    // the extension excludes); real diff files carry data-tagsearch-path.
    await expect(page.locator(".file[data-tagsearch-path]")).toHaveCount(1);
    await expect(page.locator("input.js-reviewed-checkbox")).toHaveCount(0);
    await page.keyboard.press("v");
    await expect(toast(page)).toHaveText("Can't mark this file viewed — last file");
  });

  test("`j` highlights the first real change block", async ({ page }) => {
    await openPr(page, `/commits/${REAL_SHA}`, REAL_PR);
    await page.keyboard.press("j");
    await expect(page.locator("tr.prks-change").first()).toBeVisible();
  });

  test("`g` `f` follows the Enterprise /files tab link", async ({ page }) => {
    await openPr(page, `/commits/${REAL_SHA}`, REAL_PR);
    await page.keyboard.press("g");
    await page.keyboard.press("f");
    await expect(page).toHaveURL(/\/pull\/87\/files$/);
  });
});
