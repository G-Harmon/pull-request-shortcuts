// GitHub PR Review Shortcuts — content script.
// Adds keyboard-only navigation to the PR "Files changed" tab.
//
// Injected on every page of the host so it's already present in the document
// before GitHub's Turbo/pjax soft navigation lands on a PR (a content script is
// only injected on a *full* load, and soft navigation never triggers one). The
// document-level keydown listener then survives those soft navigations. The
// handler is gated by isPrPage() (tab-jump chords work on any PR tab) and the
// file-navigation keys are further gated by isPrFilesPage(); it's inert everywhere
// else, and all DOM lookups are done lazily per keypress so no stale nodes cached.

(function () {
  "use strict";

  // --- Keybindings (edit here to retune) ---------------------------------
  const KEYS = {
    nextFile: "]",
    prevFile: "[",
    nextChange: "j", // jump to next change block (vim down)
    prevChange: "k", // jump to previous change block (vim up)
    markViewed: "v",
    markAllVisible: "V", // shift+v: mark all files in the current view viewed
    undoMark: "b", // 'back': un-mark the last file marked viewed
    firstUnviewed: "u", // scroll to first not-yet-viewed file
    // 'g' is a chord prefix. gg = first file; g + a tab key = jump to that PR tab.
    firstFile: "g", // pressed twice
    lastFile: "G", // shift+g
    // PR tab chords (g + key), work on any PR tab:
    tabConversation: "c", // g c
    tabCommits: "m", // g m  (coMMits)
    tabChecks: "k", // g k  (checKs)
    tabFiles: "f", // g f
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

  // Any PR tab (Conversation / Commits / Checks / Files). The tab chords work here;
  // the file-navigation shortcuts are further gated to isPrFilesPage().
  function isPrPage() {
    return /\/pull\/\d+/.test(location.pathname);
  }

  // --- PR tab navigation --------------------------------------------------
  const TAB_LABELS = {
    "": "Conversation",
    "/commits": "Commits",
    "/checks": "Checks",
    "/files": "Files changed",
  };

  // Jump to a PR tab by suffix ("" | "/commits" | "/checks" | "/files"). Clicks the
  // existing tab link so GitHub does a Turbo soft-nav (no reload); falls back to a
  // full navigation if no link is found.
  function goToTab(suffix) {
    const m = location.pathname.match(/^(.*\/pull\/\d+)/);
    if (!m) return;
    const targetPath = m[1] + suffix;
    if (location.pathname === targetPath) {
      toast(`Already on ${TAB_LABELS[suffix]}`);
      return;
    }
    const link = Array.from(document.querySelectorAll("a[href]")).find((a) => {
      try {
        return new URL(a.href, location.origin).pathname === targetPath;
      } catch (e) {
        return false;
      }
    });
    if (link) link.click();
    else location.assign(targetPath);
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

  // --- Change-block discovery --------------------------------------------
  // Added/deleted diff lines. Long-standing GitHub classes; update if GHE drifts.
  const CHANGED_LINE_SELECTOR = "td.blob-code-addition, td.blob-code-deletion";

  function isChangedRow(tr) {
    return !!(tr && tr.querySelector(CHANGED_LINE_SELECTOR));
  }

  // Rendered change-block start rows in document order: the first changed row of each
  // contiguous run of changes. Rows that aren't laid out (collapsed/filtered/deferred)
  // are skipped, so jumping naturally crosses into the next rendered file's changes.
  function getChangeStarts() {
    const starts = [];
    let lastRow = null;
    document.querySelectorAll(CHANGED_LINE_SELECTOR).forEach((cell) => {
      const tr = cell.closest("tr");
      if (!tr || tr === lastRow) return; // one entry per row (split diff has 2 cells)
      lastRow = tr;
      if (!tr.getClientRects().length) return; // not rendered
      if (!isChangedRow(tr.previousElementSibling)) starts.push(tr);
    });
    return starts;
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

  // The file's header is fully within the visible area (below the sticky header,
  // above the viewport bottom) — i.e. you can actually see which file it is.
  function headerOnScreen(file) {
    const r = fileHeader(file).getBoundingClientRect();
    return r.top >= STICKY_OFFSET - 1 && r.bottom <= window.innerHeight;
  }

  // Briefly highlight a file's header so it's obvious which file was acted on.
  // Retriggers the CSS animation on repeated calls.
  function flash(file) {
    const el = fileHeader(file);
    el.classList.remove("prks-flash");
    void el.offsetWidth; // force reflow so the animation restarts
    el.classList.add("prks-flash");
  }

  // --- Navigation ---------------------------------------------------------
  function goToFile(index, message) {
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
    toast(message || `File ${i + 1} / ${files.length}`);
  }

  function nextFile() {
    goToFile(getCurrentIndex(getViewFiles()) + 1);
  }

  // Top offset for landing a diff row: the page header (STICKY_OFFSET) plus the file's
  // own sticky header, so the change lands just below it (not hidden behind it). Also
  // used as the detection line so a just-landed change isn't re-counted as "below".
  function changeTopOffset() {
    const h = document.querySelector(".file-header");
    return STICKY_OFFSET + (h ? h.getBoundingClientRect().height : 0);
  }

  function scrollRowToLine(tr) {
    window.scrollTo({
      top: tr.getBoundingClientRect().top + window.scrollY - changeTopOffset(),
      behavior: "smooth",
    });
  }

  // Jump to the start of the next (forward) / previous change block relative to the
  // line where changes land. Crosses files; skips collapsed/filtered/unrendered ones.
  function jumpToChange(forward) {
    const starts = getChangeStarts();
    if (!starts.length) {
      toast("No changes in view");
      return;
    }
    const line = changeTopOffset();
    let target = null;
    if (forward) {
      target = starts.find((tr) => tr.getBoundingClientRect().top - line > 1);
      if (!target) {
        toast("No more changes below");
        return;
      }
    } else {
      for (const tr of starts) {
        if (line - tr.getBoundingClientRect().top > 1) target = tr; // last one above
        else break;
      }
      if (!target) {
        toast("No more changes above");
        return;
      }
    }
    scrollRowToLine(target);
  }

  function prevFile() {
    goToFile(getCurrentIndex(getViewFiles()) - 1);
  }

  function isFileViewed(file) {
    const cb = file.querySelector("input.js-reviewed-checkbox");
    return !!(cb && cb.checked); // no checkbox => treated as not viewed
  }

  function viewedToggle(file) {
    const checkbox = file.querySelector("input.js-reviewed-checkbox");
    if (!checkbox) return null;
    const label =
      checkbox.closest("label") ||
      file.querySelector(".js-reviewed-toggle") ||
      checkbox;
    return { checkbox, label };
  }

  // Toggle a single file's "Viewed" checkbox on (if not already). Returns true if it
  // actually changed it. Clicks the label so GitHub's own handlers fire. Callers
  // record what they marked on the undo stack (as a batch).
  function markFileViewed(file) {
    const t = viewedToggle(file);
    if (!t || t.checkbox.checked) return false;
    t.label.click();
    return true;
  }

  // Push one undo batch (a group of file ids marked together).
  function recordMarks(ids) {
    if (ids.length) markHistory.push(ids);
  }

  // Un-mark a file's "Viewed" checkbox (if set). Returns true if it changed it.
  // Unchecking makes GitHub re-expand the diff and mark the file unviewed.
  function unmarkFileViewed(file) {
    const t = viewedToggle(file);
    if (!t || !t.checkbox.checked) return false;
    t.label.click();
    return true;
  }

  // Undo the most recent batch the extension marked viewed: pop the last batch with
  // any still-viewed files, un-mark them all, flash them, and scroll to the topmost.
  // A `v` is a one-file batch; a `V` is one batch of everything it marked. Tracking
  // exact ids (not a geometric "current") avoids mis-targeting collapsed headers.
  function undoLastMark() {
    let ids = null;
    while (markHistory.length) {
      const present = markHistory.pop().filter((id) => {
        const f = document.getElementById(id);
        return f && isFileViewed(f);
      });
      if (present.length) {
        ids = present;
        break;
      }
    }
    if (!ids) {
      toast("Nothing to undo");
      return;
    }
    const view = getViewFiles();
    let firstIdx = Infinity;
    ids.forEach((id) => {
      const f = document.getElementById(id);
      unmarkFileViewed(f);
      flash(f);
      const idx = view.indexOf(f);
      if (idx >= 0 && idx < firstIdx) firstIdx = idx;
    });
    const msg = `Undid ${ids.length} file${ids.length === 1 ? "" : "s"}`;
    if (firstIdx !== Infinity) {
      // The files re-expand, shifting layout; let it settle before scrolling.
      requestAnimationFrame(() => requestAnimationFrame(() => goToFile(firstIdx, msg)));
    } else {
      toast(msg); // none of the batch is in the current filtered view
    }
  }

  // Jump to the first not-yet-viewed file in the current view. Returns false if
  // none is present, so the caller can decide whether to wait for more to load.
  function jumpToFirstUnviewed() {
    const files = getViewFiles();
    const i = files.findIndex((f) => !isFileViewed(f));
    if (i === -1) return false;
    goToFile(i);
    return true;
  }

  function firstUnviewedFile() {
    if (jumpToFirstUnviewed()) {
      cancelUnviewedWatch();
      return;
    }
    // Nothing unviewed among the files loaded so far. On a large PR the diff
    // streams in top-to-bottom, so the first unviewed file may simply not be
    // rendered yet — arm a watcher to jump once it arrives. Only when the diff
    // is fully loaded is "All files viewed" actually true.
    if (diffStillLoading()) {
      toast("Loading… will jump to first unviewed");
      armUnviewedWatch();
    } else {
      toast("All files viewed");
    }
  }

  // --- Deferred "first unviewed" for progressively-loading diffs ----------
  // A large PR streams its files in top-to-bottom. If `u` is pressed before the
  // file holding the first unviewed file has rendered, we can't find it yet. We
  // arm a short-lived observer that retries the jump as more files arrive, and
  // give up once the diff is fully loaded (or after a safety timeout).
  let unviewedWatch = null; // { observer, timer } while armed

  // Total files GitHub says this PR has, read from the Files tab counter. Returns
  // null if we can't read it — then we never claim the diff is "still loading",
  // so behavior degrades to exactly today's.
  function expectedFileCount() {
    const el =
      document.querySelector("#files_tab_counter") ||
      document.querySelector('.tabnav-tab[href*="/files"] .Counter');
    if (!el) return null;
    const raw = el.getAttribute("title") || el.textContent || "";
    const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }

  // More files are still streaming in: fewer loaded .file nodes than the counter.
  // getFiles() counts all loaded files (a filter only hides, doesn't remove them),
  // so this compares loaded-vs-total regardless of any active file filter.
  function diffStillLoading() {
    const total = expectedFileCount();
    return total != null && getFiles().length < total;
  }

  function cancelUnviewedWatch() {
    if (!unviewedWatch) return;
    unviewedWatch.observer.disconnect();
    clearTimeout(unviewedWatch.timer);
    unviewedWatch = null;
  }

  // Watch the diff for newly-streamed files and retry the jump each batch. Stop on
  // success, when loading finishes with nothing unviewed, on leaving the files
  // page, or after a safety timeout so the observer never lingers. Re-arming first
  // tears down any existing watch (pressing `u` twice won't stack observers).
  function armUnviewedWatch() {
    cancelUnviewedWatch();
    const container = document.getElementById("files") || document.body;
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return; // coalesce a burst of additions into one check
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (!isPrFilesPage()) {
          cancelUnviewedWatch();
        } else if (jumpToFirstUnviewed()) {
          cancelUnviewedWatch();
        } else if (!diffStillLoading()) {
          cancelUnviewedWatch();
          toast("All files viewed");
        }
      });
    });
    observer.observe(container, { childList: true, subtree: true });
    // Backstop only: the watch normally ends on success / full load / page change.
    // This guards the pathological case where loading stalls so the observer can't
    // linger. Generous since a very large diff can take a while to finish loading.
    const timer = setTimeout(cancelUnviewedWatch, 30000);
    unviewedWatch = { observer, timer };
  }

  function markViewedAndAdvance() {
    const files = getViewFiles();
    const cur = getCurrentIndex(files);
    if (cur < 0) return;
    let i = cur;
    if (isFileViewed(files[cur])) {
      // The file at the top is already viewed (e.g. we just marked it). Find the
      // next unviewed file below it.
      i = files.findIndex((f, k) => k > cur && !isFileViewed(f));
      if (i === -1) {
        toast("No unviewed files below");
        return;
      }
      // Don't mark a file the user can't see; if its header isn't on screen, reveal
      // it and let the next `v` mark it.
      if (!headerOnScreen(files[i])) {
        goToFile(i);
        return;
      }
    }
    if (markFileViewed(files[i])) recordMarks(files[i].id ? [files[i].id] : []);
    flash(files[i]);
    // Keep the just-marked (now collapsed) file at the top of the view so it's clear
    // which one was marked. Let the collapse settle before scrolling.
    requestAnimationFrame(() => requestAnimationFrame(() => goToFile(i)));
  }

  function markAllVisibleViewed() {
    const files = getViewFiles();
    if (!files.length) {
      toast("No files in view");
      return;
    }
    const marked = [];
    files.forEach((f) => {
      if (markFileViewed(f) && f.id) marked.push(f.id);
    });
    recordMarks(marked);
    toast(
      marked.length
        ? `Marked ${marked.length} file${marked.length === 1 ? "" : "s"} viewed`
        : "Already all viewed"
    );
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
          <tr><td><kbd>j</kbd></td><td>Next change</td></tr>
          <tr><td><kbd>k</kbd></td><td>Previous change</td></tr>
          <tr><td><kbd>v</kbd></td><td>Mark file viewed &amp; advance</td></tr>
          <tr><td><kbd>V</kbd></td><td>Mark all files in view viewed</td></tr>
          <tr><td><kbd>b</kbd></td><td>Undo last mark (re-expand)</td></tr>
          <tr><td><kbd>u</kbd></td><td>First not-viewed file</td></tr>
          <tr><td><kbd>g</kbd> <kbd>g</kbd></td><td>Jump to first file</td></tr>
          <tr><td><kbd>G</kbd></td><td>Jump to last file</td></tr>
          <tr><td><kbd>g</kbd> <kbd>c</kbd></td><td>Go to Conversation tab</td></tr>
          <tr><td><kbd>g</kbd> <kbd>m</kbd></td><td>Go to Commits tab</td></tr>
          <tr><td><kbd>g</kbd> <kbd>k</kbd></td><td>Go to Checks tab</td></tr>
          <tr><td><kbd>g</kbd> <kbd>f</kbd></td><td>Go to Files changed tab</td></tr>
          <tr><td><kbd>\\</kbd></td><td>Toggle this help</td></tr>
        </table>
        <p class="prks-help__hint">Press any key to close. Shortcuts are disabled while typing in a text field.</p>
      </div>`;
    helpEl.addEventListener("click", toggleHelp);
    document.body.appendChild(helpEl);
  }

  // --- Input guard --------------------------------------------------------
  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      el.isContentEditable
    );
  }

  function isTyping() {
    return isEditable(document.activeElement);
  }

  // --- Key handling -------------------------------------------------------
  let lastG = 0;
  const markHistory = []; // LIFO undo stack of batches (each a list of marked file ids)

  function onKeydown(e) {
    if (isTyping()) return; // also covered by detaching on focus; this is a safety net
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Help overlay open: any key closes it (and is swallowed, not acted on).
    if (helpEl && helpEl.isConnected) {
      toggleHelp();
      e.preventDefault();
      return;
    }

    if (!isPrPage()) return; // inert on every page except a PR

    const k = e.key;

    // --- 'g'-prefix chords (work on any PR tab) ---
    const gFresh = lastG && Date.now() - lastG < CHORD_TIMEOUT_MS;
    if (gFresh) {
      lastG = 0;
      // gg = first file (Files page only); g + tab key = jump to that PR tab.
      if (k === KEYS.firstFile) {
        if (isPrFilesPage()) goToFile(0);
        e.preventDefault();
        return;
      }
      if (k === KEYS.tabFiles) {
        goToTab("/files");
        e.preventDefault();
        return;
      }
      if (k === KEYS.tabConversation) {
        goToTab("");
        e.preventDefault();
        return;
      }
      if (k === KEYS.tabCommits) {
        goToTab("/commits");
        e.preventDefault();
        return;
      }
      if (k === KEYS.tabChecks) {
        goToTab("/checks");
        e.preventDefault();
        return;
      }
      // unrecognized second key: fall through and handle k on its own
    }
    if (k === KEYS.firstFile) {
      lastG = Date.now(); // begin chord; don't preventDefault (GitHub g-chords work)
      return;
    }
    lastG = 0;

    // --- single-key file-navigation (Files page only) ---
    if (!isPrFilesPage()) return;
    // Any key other than `u` means the user moved on; drop a pending deferred jump
    // so it can't yank the viewport away once more files finish loading.
    if (k !== KEYS.firstUnviewed) cancelUnviewedWatch();
    switch (k) {
      case KEYS.nextFile:
        nextFile();
        break;
      case KEYS.prevFile:
        prevFile();
        break;
      case KEYS.nextChange:
        jumpToChange(true);
        break;
      case KEYS.prevChange:
        jumpToChange(false);
        break;
      case KEYS.markViewed:
        markViewedAndAdvance();
        break;
      case KEYS.markAllVisible:
        markAllVisibleViewed();
        break;
      case KEYS.undoMark:
        undoLastMark();
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

  // Attach the keydown listener only while no text field is focused, so we add zero
  // per-keystroke overhead (no synchronous capture-phase hop) while composing comments.
  // focusin/focusout fire only on focus changes, not per keystroke.
  let keysAttached = false;
  function attachKeys() {
    if (!keysAttached) {
      document.addEventListener("keydown", onKeydown, true);
      keysAttached = true;
    }
  }
  function detachKeys() {
    if (keysAttached) {
      document.removeEventListener("keydown", onKeydown, true);
      keysAttached = false;
    }
  }
  function syncKeyListener() {
    if (isTyping()) detachKeys();
    else attachKeys();
  }

  // focusin's activeElement is already the new element; after focusout it settles next frame.
  document.addEventListener("focusin", syncKeyListener, true);
  document.addEventListener("focusout", () => requestAnimationFrame(syncKeyListener), true);
  syncKeyListener(); // initial state
})();
