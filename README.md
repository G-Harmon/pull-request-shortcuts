# GitHub PR Review Shortcuts

A small Chrome extension that adds keyboard-only navigation to the GitHub
**Files changed** tab when reviewing pull requests on Joby's GitHub Enterprise
(`github.example.com`).

## Shortcuts

| Key | Action |
|-----|--------|
| `]` | Next file |
| `[` | Previous file |
| `v` | Mark current file **Viewed** and advance to the next file |
| `g` `g` | Jump to first file |
| `G` | Jump to last file |
| `?` | Toggle the shortcut help overlay |

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

- The extension finds diff files via the `.file` selector (with
  `[data-tagsearch-path]` / `.js-file` fallbacks) and the "Viewed" checkbox via
  `input.js-reviewed-checkbox`. If a future GitHub Enterprise upgrade changes the
  DOM, update `FILE_SELECTORS` in `content.js`. A warning is logged to the console
  when no files are found.
- To support public `github.com` too, add its pattern to `content_scripts.matches`
  in `manifest.json` and re-verify the selectors there.

## Scope (v1)

Intentionally minimal: file navigation + mark-viewed. Not included: configurable
keybindings UI, Approve/Request-changes submission shortcuts, github.com support.
