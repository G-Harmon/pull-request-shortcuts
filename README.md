# GitHub PR Review Shortcuts

A small Chrome extension that adds keyboard-only navigation to the GitHub
**Files changed** tab when reviewing pull requests. Works on **github.com** out of
the box, and on self-hosted **GitHub Enterprise** hosts you add yourself.

## Shortcuts

| Key | Action |
|-----|--------|
| `]` | Next file |
| `[` | Previous file |
| `j` / `k` | Jump to next / previous change (added/deleted lines); the change block is highlighted and a few lines of context are shown above it |
| `v` | Mark the current file **Viewed**; keeps it in view at the top and briefly flashes it (the next file follows below) |
| `V` | Mark all files in the current (filtered) view as **Viewed** |
| `b` | Undo the last viewed-mark (re-expands the file); one press undoes a whole `V` batch |
| `u` | **Files changed:** jump to first not-viewed file. **Conversation:** jump to the first **unresolved** review thread (ring-highlighted); like not-viewed, pressing `u` again after you resolve it advances to the next unresolved thread |
| `g` `g` | Jump to first file |
| `G` | Jump to last file |
| `g` `c` | Go to the **Conversation** tab |
| `g` `m` | Go to the **Commits** tab |
| `g` `k` | Go to the **Checks** tab |
| `g` `f` | Go to the **Files changed** tab |
| `\` | Toggle the shortcut help overlay (leaves `?` for GitHub's own help) |

Shortcuts are ignored while you're typing in a text field (e.g. writing a review
comment), and they don't override GitHub's built-in shortcuts.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Open a PR's **Files changed** tab on `github.com` and try the keys above.

After editing the source, return to `chrome://extensions` and click the refresh
icon on the extension card, then reload the PR page.

## Using it on GitHub Enterprise

The extension runs on `github.com` automatically. To use it on a self-hosted
GitHub Enterprise instance, click the extension's **toolbar icon** and add the host
(e.g. `git.example.com`). Chrome will ask for permission to run on that site; once
granted, the shortcuts work there too (reload any already-open tabs). Remove a host
from the same popup to revoke it. Your host list syncs via `chrome.storage.sync`.

## Customizing

All keybindings and tunables live at the top of `content.js` in the `KEYS`
constant (plus `STICKY_OFFSET`, `CHORD_TIMEOUT_MS`, `TOAST_MS`, `CHANGE_CONTEXT_LINES`).

## Notes / troubleshooting

- **Injection scope:** the content script is injected on *every* page of an enabled
  host (`github.com` via `content_scripts.matches`; added hosts via dynamically
  registered scripts), but it does nothing unless you're on a PR **Files changed**
  page (gated by `isPrFilesPage()` in `content.js`). This is deliberate: GitHub
  navigates between PR tabs with Turbo/pjax *soft* navigation, which never triggers
  content-script injection — so the script must already be present in the document,
  and its `document`-level keydown listener survives the soft navigations.
- **Added hosts** are stored in `chrome.storage.sync` and injected via
  `chrome.scripting.registerContentScripts` after you grant the per-site permission.
  Opening the popup reconciles the list (e.g. if you revoke a site permission from
  `chrome://extensions`, it's dropped).
- The extension finds diff files via the `.file` selector (with
  `[data-tagsearch-path]` / `.js-file` fallbacks) and the "Viewed" checkbox via
  `input.js-reviewed-checkbox`. If a future GitHub upgrade changes the DOM, update
  `FILE_SELECTORS` in `content.js`. A warning is logged to the console (only on a
  files page) when no files are found.
- **Unresolved-comment navigation** (`u` on the Conversation tab) finds review
  threads via `.js-resolvable-timeline-thread-container` (fallback
  `.review-thread-component`) and treats a thread as resolved when it carries
  `data-resolved="true"`. Resolved (collapsed) threads and plain discussion comments are
  skipped, as are threads not yet rendered (e.g. hidden behind a "show resolved" control).
  If a future GitHub upgrade changes the DOM, update `THREAD_SELECTORS` / `isThreadResolved`
  in `content.js`; a warning is logged (only on a Conversation page) when nothing matches.
- **`u` on a large, still-loading PR:** GitHub streams a big diff in batches, so the
  file holding the first unviewed change may not be in the DOM yet when you press `u`.
  Rather than wrongly report "All files viewed", the extension reads the total file
  count from the **Files** tab counter (`#files_tab_counter`), and if more files are
  still loading it watches for the streamed-in files and jumps as soon as the first
  unviewed one appears. If a future upgrade renames that counter, the count just can't
  be read and `u` falls back to its old immediate behavior — update the selector in
  `expectedFileCount()`.

## Scope

Intentionally minimal: file navigation, mark-viewed, change highlighting, and
unresolved-comment navigation on the Conversation tab. Not included: configurable
keybindings UI, or Approve/Request-changes submission shortcuts.
