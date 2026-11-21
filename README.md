# Desk

A tabbed writing desk for your computer. One window, as many tabs as you need (short-form scripts, essays, grants, anything), wrapped in a 6px civic blue frame with phone-style rounded corners.

It starts **blank**. Your tabs and text are saved on your own machine, never in this repo.

## Run it

```bash
bun install
bun run start
```

Requires [Bun](https://bun.sh). Built with Electron; tested on macOS. The first launch downloads the Electron binary and builds a private `Desk.app` copy (so the Dock and menu bar say Desk), so give it a moment.

## Build a standalone app (macOS)

```bash
bun run package
```

This creates `out/Desk-darwin-arm64/Desk.app`. Drag it to your Applications folder.

To change the icon, replace `build/icon.svg` and run `bunx electron scripts/render-icon.js`.

## Use it

| Action | How |
| --- | --- |
| New tab | `+` or `Cmd+T`, type its name, press `Enter`, then write |
| Rename tab | Select a tab and press `Enter`, or double-click its title |
| Close tab | `x` on the tab or `Cmd+W` |
| Default font | The last font you pick becomes the starting font for every new tab |
| Move between tabs | With a tab selected, `Left` / `Right` arrows (`Home` / `End` for first / last) |
| Jump to tab | `Cmd+1` to `Cmd+9` |
| Cycle tabs | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Font | Format panel, Font picker. Fonts you installed yourself (e.g. via Font Book, read from `~/Library/Fonts`) are pinned at the top. You can also add any Google Font by name at the bottom of the list |
| Format | The panel on the right: styles, bold/italic/underline, lists, alignment, undo. Collapse it to a circle, reopen with `Aa` or `Cmd+\`. `Cmd+Shift+F` jumps into it: arrow keys move between controls, `Enter` applies, `Esc` returns to the text |

## Studio (dev tool)

Edit the UI visually instead of describing it in words. Run Desk from source (`bun run start`) and press `Cmd+L` (or **Studio > Studio Mode**), or press and hold any component for 4 seconds.

- Click any element. Drag the pink handles to resize (hold `Shift` to keep the proportions, so a circle stays a circle), the green ones for padding, the orange one for corner radius. Press `Delete` (or **Delete element**) to remove the selected element. **Style** opens a pop-out for border, fill, text color, size and weight. Select an element and a small fan of buttons appears next to it (select parent, Shape, Style, Delete). **Shape** opens a magnified editing box that grows out of the shape and shrinks back when you press Done: round each corner separately (`Shift` for all four), slice the shape with a line (a circle cut in half becomes a semicircle), and move it (arrow keys nudge). `Up` selects the parent, `Cmd+Z` undoes, `Esc` exits.
- **Draw** (button, or press `D` in Studio): sketch straight on the running UI with Pen (smoothed freehand), Line, Curve (drag, then bend it with the green dot; any line or arrow can be bent), Arrow, Box, Oval, Text and an Eraser (rubs out parts of freehand strokes, removes other marks you touch), in any color, thin/medium/thick, optionally filled (`Shift` keeps boxes square and lines at 45°). **Select** moves a mark, drags its ends, recolors it, or deletes it (`Delete`). Write a note to the agent in the text box, then **Send to agent**: the brief includes a clean and an annotated screenshot, your note, and the elements and source lines under each mark.
- Studio records exact before/after values and finds likely source lines, then writes `.studio/brief.md` with before and after screenshots. **View brief** shows it.
- **Send to agent** runs Claude Code in the project (`claude -p`, limited to Read/Edit/Glob/Grep) on that brief. It only runs when the git tree is clean, so the agent's edits show up as their own diff.
- The brief file is always there, so you can also point your own agent session at `.studio/brief.md`.

It is disabled in packaged builds unless `DESK_STUDIO=1`. To point it at another project's folder, set `STUDIO_PROJECT`.

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
