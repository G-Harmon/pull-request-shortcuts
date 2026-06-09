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

  // Guard against double-injection: an added host can be injected both by the dynamically
  // registered content script and by a one-off executeScript (active/open tabs). Running
  // setup twice would stack duplicate document keydown listeners.
  if (window.__prksLoaded) return;
  window.__prksLoaded = true;

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
  const CHANGE_CONTEXT_LINES = 3; // context lines shown above a change jumped to with j/k

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

  // The PR "Conversation" tab: the bare PR URL with no sub-tab suffix (excludes
  // /files, /commits, /checks, and /commits/<sha>). Checked live like the others so it
  // tracks Turbo soft navigation. The unresolved-comment shortcuts are gated to this.
  function isPrConversationPage() {
    return /\/pull\/\d+\/?$/.test(location.pathname);
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
  // ".file" also matches code-suggestion blobs embedded in review comments (e.g.
  // "blob-wrapper data file" inside .comment-body). Those aren't changed files: they have
  // no reviewed-checkbox (so they'd look "unviewed") and no layout while their comment is
  // collapsed (so we can't scroll to them), which derails index-based navigation. Exclude
  // anything living inside comment markup.
  const COMMENT_BLOB_SCOPE = ".comment-body, .js-comments-holder, .review-comment";

  function getFiles() {
    for (const sel of FILE_SELECTORS) {
      const els = Array.from(document.querySelectorAll(sel)).filter(
        (f) => !f.closest(COMMENT_BLOB_SCOPE)
      );
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

  // --- Unresolved-comment discovery (Conversation tab) -------------------
  // Resolvable review-comment threads. Primary selector matches current GitHub;
  // fallbacks cover Enterprise drift (mirrors FILE_SELECTORS).
  const THREAD_SELECTORS = [
    ".js-resolvable-timeline-thread-container",
    ".review-thread-component",
  ];

  // A resolved thread is collapsed and carries data-resolved="true". Anything without
  // that marker is still unresolved.
  function isThreadResolved(el) {
    return el.getAttribute("data-resolved") === "true";
  }

  // Rendered unresolved review threads in document order. Like getChangeStarts, threads
  // that aren't laid out (not yet rendered / hidden behind a "show resolved" control) are
  // skipped. Uses the first selector that matches anything on the page, so a fallback only
  // kicks in when the primary genuinely isn't present.
  function getUnresolvedThreads() {
    for (const sel of THREAD_SELECTORS) {
      if (!document.querySelector(sel)) continue;
      return Array.from(document.querySelectorAll(sel)).filter(
        (t) => !isThreadResolved(t) && t.getClientRects().length
      );
    }
    if (isPrConversationPage()) {
      console.warn(
        "[PR Shortcuts] No review threads found. THREAD_SELECTORS may need updating for this GitHub version."
      );
    }
    return [];
  }

  // --- Current-comment highlight (j/k on Conversation, only) -------------
  // Jumping between unresolved comments rings the thread you land on; cleared on manual
  // scroll or any other shortcut, exactly like the change highlight below.
  let commentHighlighted = false;

  function clearCommentHighlight() {
    if (!commentHighlighted) return;
    document.querySelectorAll(".prks-comment").forEach((t) => t.classList.remove("prks-comment"));
    commentHighlighted = false;
  }

  function highlightComment(el) {
    clearCommentHighlight();
    el.classList.add("prks-comment");
    commentHighlighted = true;
  }

  // --- Current-change highlight (j/k only) -------------------------------
  // Jumping between changes with j/k marks the change block you land on with a left bar —
  // the same contiguous run of added/deleted lines that j/k step through (getChangeStarts).
  // It persists until you scroll or press any other shortcut, and never appears from plain
  // scrolling or u/v.
  let changeHighlighted = false;

  // The contiguous run of changed rows starting at `tr` (a change-block start from
  // getChangeStarts): tr plus the following rows until the next context/unchanged row.
  function changeBlockRows(tr) {
    const rows = [];
    for (let r = tr; r && isChangedRow(r); r = r.nextElementSibling) rows.push(r);
    return rows;
  }

  function clearChangeHighlight() {
    if (!changeHighlighted) return; // cheap no-op for the wheel listener's common case
    document.querySelectorAll("tr.prks-change").forEach((r) => r.classList.remove("prks-change"));
    changeHighlighted = false;
  }

  function highlightChange(tr) {
    clearChangeHighlight();
    changeBlockRows(tr).forEach((r) => r.classList.add("prks-change"));
    changeHighlighted = true;
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

  // GitHub defers very large diffs behind a "Load diff" button instead of rendering them.
  // Click it so the diff is ready to review. The file header is already on screen, so the
  // diff streams in below it (content grows downward — no jarring jump). Returns true if a
  // load was kicked off. A long-standing GitHub class; update if GHE drifts.
  const LOAD_DIFF_SELECTOR = "button.load-diff-button, button.js-diff-load";
  function loadDeferredDiff(file) {
    if (!file) return false;
    const btn = file.querySelector(LOAD_DIFF_SELECTOR);
    // Don't gate on offsetParent: the button lives in the file's diff body, which GitHub
    // keeps render-skipped (content-visibility) while the file is off-screen — so
    // offsetParent is null right after we scroll to it, even though the button is live and
    // .click() still fires its handler. Gating on it skipped the load until a second press
    // brought the file on screen. Once clicked GitHub swaps the button out, so requiring it
    // to be present (and not disabled) is enough to avoid a double-fire.
    if (!btn || btn.disabled) return false;
    btn.click();
    toast("Loading diff…");
    return true;
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
  function goToFile(index, message, highlight = true) {
    const files = getViewFiles();
    if (!files.length) return;
    const i = Math.max(0, Math.min(index, files.length - 1));
    // Give the file GitHub's native highlight by making it the URL :target — the same thing
    // clicking it in the file tree does (the .file container is #diff-<sha> / a
    // js-targetable-element). Fragment navigation jumps the anchor to the top, so snapshot &
    // restore scroll and let our own scroll below position it. location.replace (not
    // assigning location.hash) avoids pushing a history entry on every jump.
    // Skipped (highlight=false) when we're only re-positioning a just-marked file: making a
    // collapsed (viewed) file the :target makes GitHub re-expand it.
    const idEl = files[i].id ? files[i] : files[i].querySelector("[id^='diff-']");
    const id = idEl && idEl.id;
    if (highlight && id && "#" + id !== location.hash) {
      const x = window.scrollX, y = window.scrollY;
      location.replace("#" + id);
      window.scrollTo(x, y); // undo the anchor jump before paint
    }
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

  function scrollRowToLine(tr, line) {
    window.scrollTo({
      top: tr.getBoundingClientRect().top + window.scrollY - line,
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
    // Land the change a few lines below the sticky header so the context above it is
    // visible. The same line decides which change is "next", so repeated j/k still advance;
    // it clamps naturally near the top of a file/hunk (nothing to scroll up to).
    const rowH = starts[0].getBoundingClientRect().height || 20;
    const line = changeTopOffset() + CHANGE_CONTEXT_LINES * rowH;
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
    scrollRowToLine(target, line);
    highlightChange(target);
  }

  // Jump to the next unresolved review thread below the current position, ring-highlighting
  // it. Mirrors `u` on the Files tab (next not-viewed file): when none remain below, wrap to
  // the topmost unresolved thread so repeated `u` round-robins through all of them. No
  // per-file sticky header on the Conversation tab, so the landing line is just below the
  // page header plus a little context (same forward scan as jumpToChange).
  function jumpToNextUnresolved() {
    const threads = getUnresolvedThreads();
    if (!threads.length) {
      toast("No unresolved comments");
      return;
    }
    const line = STICKY_OFFSET + CHANGE_CONTEXT_LINES * 20;
    let target, wrapped = false;
    // If we're parked on the thread a previous `u` highlighted (and a manual scroll hasn't
    // cleared that highlight), step to the next one by index rather than by live geometry.
    // scrollRowToLine can't always land the thread's top exactly on the line: content
    // rendering/expanding as it scrolls into view (plus sub-pixel rounding) often leaves it a
    // few px below, so a geometry scan would re-select the same thread and just nudge it —
    // stalling `u` on the current thread until an extra press settled it.
    const current = threads.find((t) => t.classList.contains("prks-comment"));
    if (current) {
      const next = threads.indexOf(current) + 1;
      wrapped = next >= threads.length;
      target = wrapped ? threads[0] : threads[next];
    } else {
      target = threads.find((t) => t.getBoundingClientRect().top - line > 1); // next below
      if (!target) {
        target = threads[0]; // none below: wrap to first
        wrapped = true;
      }
    }
    scrollRowToLine(target, line);
    highlightComment(target);
    toast(
      (wrapped ? "Wrapped — " : "") +
        `unresolved ${threads.indexOf(target) + 1} / ${threads.length}`
    );
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

  // The file the last `u` jumped to, used to anchor the next `u`. Cleared on a manual
  // scroll or any other shortcut, so it only persists across a run of `u` presses — the
  // file-side analogue of the .prks-comment anchor used for unresolved comments.
  let lastUnviewedFile = null;

  // Jump to the next not-yet-viewed file below the current one (like `]`, but skipping
  // viewed files). When none remain below, wrap to the topmost still-unviewed file so
  // repeated `u` round-robins through all remaining work. Returns false only when no
  // unviewed file is loaded at all, so the caller can decide whether to wait for more.
  function jumpToNextUnviewed() {
    const files = getViewFiles();
    if (!files.length) return false;
    // Anchor "current" on the file the previous `u` landed on rather than re-deriving it
    // from geometry: goToFile can't always land the header exactly on the line (layout
    // shifts as the diff renders mid-scroll), which nudges getCurrentIndex to the previous
    // file and makes "next below" re-pick the file we're already on. Fall back to live
    // geometry once the anchor is gone (first `u`, after a manual scroll, or any other key).
    let cur = lastUnviewedFile ? files.indexOf(lastUnviewedFile) : -1;
    if (cur === -1) cur = getCurrentIndex(files);
    let i = files.findIndex((f, k) => k > cur && !isFileViewed(f)); // next below current
    let wrapped = false;
    if (i === -1) {
      i = files.findIndex((f) => !isFileViewed(f)); // none below: wrap to topmost remaining
      wrapped = i !== -1;
    }
    if (i === -1) {
      lastUnviewedFile = null;
      return false; // none anywhere
    }
    lastUnviewedFile = files[i];
    goToFile(i, wrapped ? "Wrapped to first unviewed" : undefined);
    loadDeferredDiff(files[i]); // if the target's diff is deferred behind "Load diff", load it
    return true;
  }

  // Nothing unviewed is reachable in the current view and loading has finished: tell the
  // user whether a filter is hiding unviewed files (so they know to clear it) or everything
  // really is viewed.
  function toastNoUnviewedLeft() {
    const hiddenUnviewed = getFiles().filter(
      (f) => f.hasAttribute("hidden") && !isFileViewed(f)
    ).length;
    toast(
      hiddenUnviewed > 0
        ? `${hiddenUnviewed} unviewed file${hiddenUnviewed === 1 ? "" : "s"} hidden by the filter`
        : "All files viewed"
    );
  }

  function nextUnviewedFile() {
    if (jumpToNextUnviewed()) {
      cancelUnviewedWatch();
      return;
    }
    // Nothing unviewed in the current view yet. If files are still streaming in — true even
    // under a filter (GitHub loads every file and just hides filtered-out ones, so the
    // loaded/total counter stays valid) — watch and jump once the first unviewed arrives.
    if (diffStillLoading()) {
      toast(loadingMsg(), 0); // sticky: stays until the jump fires or loading ends
      armUnviewedWatch();
      return;
    }
    // Fully loaded: either a filter is hiding the unviewed files, or all really are viewed.
    cancelUnviewedWatch();
    toastNoUnviewedLeft();
  }

  // Sticky progress message shown while we wait for more files to stream in, with a
  // live loaded/total count so it's clear something is happening between jumps.
  function loadingMsg() {
    const total = expectedFileCount();
    const loaded = getFiles().length;
    return total != null
      ? `Loading… jumping to first unviewed (${loaded} / ${total} files)`
      : "Loading… will jump to first unviewed";
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
    // Drop the sticky "loading…" toast unless a real message already replaced it
    // (success / "all viewed" paths toast before cancelling, so this no-ops there).
    clearLoadingToast();
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
        } else if (jumpToNextUnviewed()) {
          cancelUnviewedWatch();
        } else if (!diffStillLoading()) {
          cancelUnviewedWatch();
          toastNoUnviewedLeft();
        } else {
          toast(loadingMsg(), 0); // still loading: refresh the live count
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
        loadDeferredDiff(files[i]); // if the revealed file's diff is deferred, load it now
        return;
      }
    }
    if (markFileViewed(files[i])) recordMarks(files[i].id ? [files[i].id] : []);
    flash(files[i]);
    // The just-marked file collapses and the next unviewed file slides up into view —
    // pre-load its diff now (if deferred) so it's ready by the time you reach it. The
    // reveal branch above only fires for an off-screen next file; this covers the common
    // case where the next file is already on screen below the collapsed one.
    const next = files.find((f, k) => k > i && !isFileViewed(f));
    if (next) loadDeferredDiff(next);
    // Keep the just-marked (now collapsed) file at the top of the view so it's clear
    // which one was marked. Let the collapse settle before scrolling. Don't highlight it:
    // making the collapsed file the :target would make GitHub re-expand it.
    requestAnimationFrame(() => requestAnimationFrame(() => goToFile(i, undefined, false)));
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
  let loadingToastActive = false; // a sticky (no-timer) toast is currently showing

  // Show a toast. With ms > 0 it auto-hides after ms (default). With ms === 0 it is
  // "sticky": no hide timer, stays until replaced by another toast or explicitly
  // cleared — used for the live "loading…" progress message. Any normal (timed)
  // toast supersedes a sticky one, so loadingToastActive tracks only the sticky case.
  function toast(msg, ms = TOAST_MS) {
    // Recreate if missing or detached (Turbo replaces document.body on nav).
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement("div");
      toastEl.className = "prks-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("prks-toast--show");
    clearTimeout(toastTimer);
    if (ms > 0) {
      loadingToastActive = false;
      toastTimer = setTimeout(() => toastEl.classList.remove("prks-toast--show"), ms);
    } else {
      loadingToastActive = true; // sticky
    }
  }

  // Hide a sticky loading toast if one is up. No-op once a normal toast has
  // superseded it (loadingToastActive is false), so it won't clear a real message.
  function clearLoadingToast() {
    if (!loadingToastActive) return;
    loadingToastActive = false;
    if (toastEl) toastEl.classList.remove("prks-toast--show");
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
          <tr><td><kbd>u</kbd></td><td>Next not-viewed file (Files) / next unresolved comment (Conversation)</td></tr>
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

    // --- Conversation tab: jump to first unresolved comment (reuses 'u') ---
    if (isPrConversationPage()) {
      // The comment highlight is a 'u'-only affordance; any other shortcut drops it.
      if (k !== KEYS.firstUnviewed) clearCommentHighlight();
      if (k === KEYS.firstUnviewed) {
        jumpToNextUnresolved();
        e.preventDefault();
      }
      return; // nothing else is ours on the Conversation tab
    }

    // --- single-key file-navigation (Files page only) ---
    if (!isPrFilesPage()) return;
    // Any key other than `u` means the user moved on; drop a pending deferred jump so it
    // can't yank the viewport away once more files finish loading, and release the `u`
    // anchor so the next `u` re-derives "current" from where the user now is.
    if (k !== KEYS.firstUnviewed) {
      cancelUnviewedWatch();
      lastUnviewedFile = null;
    }
    // The change highlight is a j/k-only affordance; any other shortcut drops it.
    if (k !== KEYS.nextChange && k !== KEYS.prevChange) clearChangeHighlight();
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
        nextUnviewedFile();
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

  // Manual scrolling (mouse wheel / trackpad) drops the j/k highlights, so they only ever
  // mark a change/comment you navigated to with j/k — not one you scrolled past. Programmatic
  // smooth scrolling (our own j/k jump) doesn't fire wheel events, so it won't self-clear.
  document.addEventListener(
    "wheel",
    () => {
      clearChangeHighlight();
      clearCommentHighlight();
      lastUnviewedFile = null; // re-derive `u`'s anchor from the new scroll position
    },
    { passive: true }
  );

  // focusin's activeElement is already the new element; after focusout it settles next frame.
  document.addEventListener("focusin", syncKeyListener, true);
  document.addEventListener("focusout", () => requestAnimationFrame(syncKeyListener), true);
  syncKeyListener(); // initial state
})();
