// GitHub PR Review Shortcuts — content script.
// Adds keyboard-only navigation to the PR "Files changed" tab.
//
// Injected on every page of the host so it's already present in the document
// before GitHub's Turbo/pjax soft navigation lands on a PR (a content script is
// only injected on a *full* load, and soft navigation never triggers one). The
// document-level keydown listener then survives those soft navigations. The
// handler is gated by isPrFilesPage() so it stays inert everywhere else, and all
// DOM lookups are done lazily per keypress so no stale nodes are cached.

(function () {
  "use strict";

  // --- Keybindings (edit here to retune) ---------------------------------
  const KEYS = {
    nextFile: "]",
    prevFile: "[",
    markViewed: "v",
    markAllVisible: "V", // shift+v: mark all files in the current view viewed
    firstUnviewed: "u", // scroll to first not-yet-viewed file
    // 'g' is a chord prefix: gg = first file. Handled specially below.
    firstFile: "g", // pressed twice
    lastFile: "G", // shift+g
    help: "\\", // backslash; '?' is left to GitHub's native shortcut help
  };

  const STICKY_OFFSET = 60; // px reserved for GitHub's sticky page header
  const CHORD_TIMEOUT_MS = 500;
  const TOAST_MS = 1200;

  // Are we currently on a PR "Files changed" page? Checked live (not cached) so
  // it tracks Turbo soft navigation between PR tabs.
  function isPrFilesPage() {
    return /\/pull\/\d+\/files\b/.test(location.pathname);
  }

  // --- File discovery -----------------------------------------------------
  // Primary selector matches current GitHub; fallbacks cover Enterprise drift.
  const FILE_SELECTORS = [".file", "[data-tagsearch-path]", ".js-file"];

  function getFiles() {
    for (const sel of FILE_SELECTORS) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length) return els;
    }
    // Only a real failure when we're on a files page; silent elsewhere.
    if (isPrFilesPage()) {
      console.warn(
        "[PR Shortcuts] No diff files found. Selectors may need updating for this GitHub version."
      );
    }
    return [];
  }

  function fileHeader(file) {
    return file.querySelector(".file-header") || file;
  }

  // Files in the current view. A file filter hides non-matching files with the
  // `hidden` attribute; in-view files are always laid out, so we can scroll to them
  // directly. Unfiltered this is every file.
  function getViewFiles() {
    return getFiles().filter((f) => !f.hasAttribute("hidden"));
  }

  // Index (within the in-view list) of the file currently being read: the first
  // file not yet fully scrolled past the sticky line. Robust to short collapsed
  // (viewed) headers, unlike picking "the last header above the line".
  function getCurrentIndex(files) {
    if (!files.length) return -1;
    const line = STICKY_OFFSET + 1;
    for (let i = 0; i < files.length; i++) {
      if (files[i].getBoundingClientRect().bottom > line) return i;
    }
    return files.length - 1;
  }

  // Whether the page is scrolled as far down as it can go. When true, the trailing
  // files can never be scrolled up to the sticky line, so `v` must mark them in place.
  function atScrollBottom() {
    return (
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 2
    );
  }

  // --- Navigation ---------------------------------------------------------
  function goToFile(index) {
    const files = getViewFiles();
    if (!files.length) return;
    const i = Math.max(0, Math.min(index, files.length - 1));
    const header = fileHeader(files[i]);
    const box = header.getBoundingClientRect();
    if (box.height || box.width) {
      window.scrollTo({ top: box.top + window.scrollY - STICKY_OFFSET, behavior: "smooth" });
    } else {
      files[i].scrollIntoView({ behavior: "smooth", block: "start" }); // defensive
    }
    toast(`File ${i + 1} / ${files.length}`);
  }

  function nextFile() {
    goToFile(getCurrentIndex(getViewFiles()) + 1);
  }

  function prevFile() {
    goToFile(getCurrentIndex(getViewFiles()) - 1);
  }

  function isFileViewed(file) {
    const cb = file.querySelector("input.js-reviewed-checkbox");
    return !!(cb && cb.checked); // no checkbox => treated as not viewed
  }

  // Toggle a single file's "Viewed" checkbox on (if not already). Returns true
  // if it actually changed it. Clicks the label so GitHub's own handlers fire.
  function markFileViewed(file) {
    const checkbox = file.querySelector("input.js-reviewed-checkbox");
    if (!checkbox || checkbox.checked) return false;
    const label =
      checkbox.closest("label") ||
      file.querySelector(".js-reviewed-toggle") ||
      checkbox;
    label.click();
    return true;
  }

  function firstUnviewedFile() {
    const files = getViewFiles();
    const i = files.findIndex((f) => !isFileViewed(f));
    if (i === -1) {
      toast("All files viewed");
      return;
    }
    goToFile(i);
  }

  function markViewedAndAdvance() {
    const files = getViewFiles();
    const cur = getCurrentIndex(files);
    if (cur < 0) return;
    let i = cur;
    if (isFileViewed(files[cur])) {
      // The file at the top is already viewed (e.g. we just marked it). Find the
      // next unviewed file below it.
      const next = files.findIndex((f, k) => k > cur && !isFileViewed(f));
      if (next === -1) {
        toast("No unviewed files below");
        return;
      }
      // If we can still scroll down, reveal that file first and let the next `v`
      // mark it — don't mark a file the user hasn't seen. Only when bottomed out,
      // where the trailing files can't be scrolled up any further, mark in place.
      if (!atScrollBottom()) {
        goToFile(next);
        return;
      }
      i = next;
    }
    markFileViewed(files[i]);
    // The marked file collapses, shifting layout; wait for it to settle before
    // computing the next file's scroll position.
    requestAnimationFrame(() => requestAnimationFrame(() => goToFile(i + 1)));
  }

  function markAllVisibleViewed() {
    const files = getViewFiles();
    if (!files.length) {
      toast("No files in view");
      return;
    }
    const n = files.reduce((c, f) => c + (markFileViewed(f) ? 1 : 0), 0);
    toast(n ? `Marked ${n} file${n === 1 ? "" : "s"} viewed` : "Already all viewed");
  }

  // --- Toast + help overlay ----------------------------------------------
  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    // Recreate if missing or detached (Turbo replaces document.body on nav).
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement("div");
      toastEl.className = "prks-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("prks-toast--show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("prks-toast--show"), TOAST_MS);
  }

  let helpEl = null;
  function toggleHelp() {
    // If still on-screen, close it; a detached node (post-Turbo) counts as closed.
    if (helpEl && helpEl.isConnected) {
      helpEl.remove();
      helpEl = null;
      return;
    }
    helpEl = document.createElement("div");
    helpEl.className = "prks-help";
    helpEl.innerHTML = `
      <div class="prks-help__card">
        <h3>PR Review Shortcuts</h3>
        <table>
          <tr><td><kbd>]</kbd></td><td>Next file</td></tr>
          <tr><td><kbd>[</kbd></td><td>Previous file</td></tr>
          <tr><td><kbd>v</kbd></td><td>Mark file viewed &amp; advance</td></tr>
          <tr><td><kbd>V</kbd></td><td>Mark all files in view viewed</td></tr>
          <tr><td><kbd>u</kbd></td><td>First not-viewed file</td></tr>
          <tr><td><kbd>g</kbd> <kbd>g</kbd></td><td>Jump to first file</td></tr>
          <tr><td><kbd>G</kbd></td><td>Jump to last file</td></tr>
          <tr><td><kbd>\\</kbd></td><td>Toggle this help</td></tr>
        </table>
        <p class="prks-help__hint">Shortcuts are disabled while typing in a text field.</p>
      </div>`;
    helpEl.addEventListener("click", toggleHelp);
    document.body.appendChild(helpEl);
  }

  // --- Input guard --------------------------------------------------------
  function isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      el.isContentEditable
    );
  }

  // --- Key handling -------------------------------------------------------
  let lastG = 0;

  function onKeydown(e) {
    if (!isPrFilesPage()) return; // inert on every page except a PR files diff
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping()) return;

    const k = e.key;

    // 'g' chord: two g's within the timeout => first file.
    if (k === KEYS.firstFile) {
      const now = Date.now();
      if (now - lastG < CHORD_TIMEOUT_MS) {
        lastG = 0;
        goToFile(0);
        e.preventDefault();
      } else {
        lastG = now;
      }
      return;
    }
    lastG = 0;

    switch (k) {
      case KEYS.nextFile:
        nextFile();
        break;
      case KEYS.prevFile:
        prevFile();
        break;
      case KEYS.markViewed:
        markViewedAndAdvance();
        break;
      case KEYS.markAllVisible:
        markAllVisibleViewed();
        break;
      case KEYS.firstUnviewed:
        firstUnviewedFile();
        break;
      case KEYS.lastFile:
        goToFile(getViewFiles().length - 1);
        break;
      case KEYS.help:
        toggleHelp();
        break;
      default:
        return; // not ours — leave native behavior intact
    }
    e.preventDefault();
  }

  document.addEventListener("keydown", onKeydown, true);
})();
