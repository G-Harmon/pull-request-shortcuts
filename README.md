# GitHub PR Review Shortcuts

A small Chrome extension that adds keyboard-only navigation to the GitHub
**Files changed** tab when reviewing pull requests on Joby's GitHub Enterprise
(`github.example.com`).

## Shortcuts

| Key | Action |
|-----|--------|
| `]` | Next file |
| `[` | Previous file |
| `j` / `k` | Jump to next / previous change (added/deleted lines) |
| `v` | Mark the current file **Viewed**; keeps it in view at the top and briefly flashes it (the next file follows below) |
| `V` | Mark all files in the current (filtered) view as **Viewed** |
| `b` | Undo the last viewed-mark (re-expands the file); one press undoes a whole `V` batch |
| `u` | Jump to first not-viewed file |
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
3. Click **Load unpacked** and select this `github-pr-shortcuts/` folder.
4. Open a PR's **Files changed** tab on `github.example.com` and try the keys above.

After editing the source, return to `chrome://extensions` and click the refresh
icon on the extension card, then reload the PR page.

## Customizing

All keybindings and tunables live at the top of `content.js` in the `KEYS`
constant (plus `STICKY_OFFSET`, `CHORD_TIMEOUT_MS`, `TOAST_MS`).

## Notes / troubleshooting

- **Injection scope:** the content script is injected on *every* `github.example.com`
  page (`content_scripts.matches` is `https://github.example.com/*`), but it does
  nothing unless you're on a PR **Files changed** page (gated by `isPrFilesPage()`
  in `content.js`). This is deliberate: GitHub navigates between PR tabs with
  Turbo/pjax *soft* navigation, which never triggers content-script injection — so
  the script must already be present in the document. Being injected host-wide
  means it's there no matter how you navigate into the PR, and its `document`-level
  keydown listener survives the soft navigations.
- The extension finds diff files via the `.file` selector (with
  `[data-tagsearch-path]` / `.js-file` fallbacks) and the "Viewed" checkbox via
  `input.js-reviewed-checkbox`. If a future GitHub Enterprise upgrade changes the
  DOM, update `FILE_SELECTORS` in `content.js`. A warning is logged to the console
  (only on a files page) when no files are found.
- **`u` on a large, still-loading PR:** GitHub streams a big diff in batches, so
  the file holding the first unviewed change may not be in the DOM yet when you
  press `u`. Rather than wrongly report "All files viewed", the extension reads the
  total file count from the **Files** tab counter (`#files_tab_counter`), and if
  more files are still loading it watches for the streamed-in files and jumps as
  soon as the first unviewed one appears. If a future upgrade renames that counter,
  the count just can't be read and `u` falls back to its old immediate behavior
  (only sees already-loaded files) — update the selector in `expectedFileCount()`.
- To support public `github.com` too, add its pattern to `content_scripts.matches`
  in `manifest.json` and re-verify the selectors there.

## Scope (v1)

Intentionally minimal: file navigation + mark-viewed. Not included: configurable
keybindings UI, Approve/Request-changes submission shortcuts, github.com support.
