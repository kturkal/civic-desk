# Desk

A tabbed writing desk for your computer. One window, as many tabs as you need (short-form scripts, essays, grants, anything), wrapped in a 6px civic blue frame with phone-style rounded corners.

It starts **blank**. Your tabs and text are saved on your own machine, never in this repo.

## Run it

```bash
bun install
bun run start
```

Requires [Bun](https://bun.sh). Built with Electron; tested on macOS. The first launch downloads the Electron binary, so give it a moment.

## Build a standalone app (macOS)

```bash
bun run package
```

This creates `out/Desk-darwin-arm64/Desk.app`. Drag it to your Applications folder.

## Use it

| Action | How |
| --- | --- |
| New tab | `+` or `Cmd+T`, type its name, press `Enter`, then write |
| Rename tab | Select a tab and press `Enter`, or double-click its title |
| Close tab | `x` on the tab or `Cmd+W` |
| Jump to tab | `Cmd+1` to `Cmd+9` |
| Cycle tabs | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Font | Format panel, Font picker. Fonts you installed yourself (e.g. via Font Book, read from `~/Library/Fonts`) are pinned at the top. You can also add any Google Font by name at the bottom of the list |
| Format | The panel on the right: styles, bold/italic/underline, lists, alignment, undo. Collapse it to a circle, reopen with `Aa` or `Cmd+\` |

## Where your writing lives

In Electron's user-data folder (on macOS: `~/Library/Application Support/civic-desk/workspace.json`). To keep a private setup, such as your own named tabs, just use the app. Nothing you write is ever written to this repository.

## Design

The look is defined by a few variables at the top of `src/styles.css`:

- `--civic-blue: #1578cf`, the frame and accent color
- `--border: 6px`, the frame width
- `--radius: 44px`, the corner radius, like a phone screen

Change them once and the whole app follows.

## License

MIT
