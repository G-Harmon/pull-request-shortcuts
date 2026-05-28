// GitHub PR Review Shortcuts — content script.
// Adds keyboard-only navigation to the PR "Files changed" tab.
// All DOM lookups are done lazily per keypress so the script survives
// GitHub's Turbo/pjax soft navigation without caching stale nodes.

(function () {
  "use strict";

  // --- Keybindings (edit here to retune) ---------------------------------
  const KEYS = {
    nextFile: "]",
    prevFile: "[",
    markViewed: "v",
    // 'g' is a chord prefix: gg = first file. Handled specially below.
    firstFile: "g", // pressed twice
    lastFile: "G", // shift+g
    help: "\\", // backslash; '?' is left to GitHub's native shortcut help
  };

  const STICKY_OFFSET = 60; // px reserved for GitHub's sticky page header
  const CHORD_TIMEOUT_MS = 500;
  const TOAST_MS = 1200;

  // --- File discovery -----------------------------------------------------
  // Primary selector matches current GitHub; fallbacks cover Enterprise drift.
  const FILE_SELECTORS = [".file", "[data-tagsearch-path]", ".js-file"];

  function getFiles() {
    for (const sel of FILE_SELECTORS) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length) return els;
    }
    console.warn(
      "[PR Shortcuts] No diff files found. Selectors may need updating for this GitHub version."
    );
    return [];
  }

  function fileHeader(file) {
    return file.querySelector(".file-header") || file;
  }

  // Index of the file whose header sits nearest the top of the viewport.
  function getCurrentIndex(files) {
    if (!files.length) return -1;
    let best = 0;
    let bestTop = -Infinity;
    files.forEach((file, i) => {
      const top = fileHeader(file).getBoundingClientRect().top - STICKY_OFFSET;
      // The current file is the last one whose header is at/above the line.
      if (top <= 1 && top > bestTop) {
        bestTop = top;
        best = i;
      }
    });
    // If every header is below the line, we're at the very top -> first file.
    return best;
  }

  // --- Navigation ---------------------------------------------------------
  function goToFile(index) {
    const files = getFiles();
    if (!files.length) return;
    const i = Math.max(0, Math.min(index, files.length - 1));
    const header = fileHeader(files[i]);
    const y = header.getBoundingClientRect().top + window.scrollY - STICKY_OFFSET;
    window.scrollTo({ top: y, behavior: "smooth" });
    toast(`File ${i + 1} / ${files.length}`);
  }

  function nextFile() {
    const files = getFiles();
    goToFile(getCurrentIndex(files) + 1);
  }

  function prevFile() {
    const files = getFiles();
    goToFile(getCurrentIndex(files) - 1);
  }

  function markViewedAndAdvance() {
    const files = getFiles();
    const i = getCurrentIndex(files);
    if (i < 0) return;
    const checkbox = files[i].querySelector("input.js-reviewed-checkbox");
    if (checkbox && !checkbox.checked) {
      // Click the label so GitHub's own handlers (collapse, persist) fire.
      const label =
        checkbox.closest("label") ||
        files[i].querySelector(".js-reviewed-toggle") ||
        checkbox;
      label.click();
    }
    goToFile(i + 1);
  }

  // --- Toast + help overlay ----------------------------------------------
  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
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
    if (helpEl) {
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
      case KEYS.lastFile:
        goToFile(getFiles().length - 1);
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
