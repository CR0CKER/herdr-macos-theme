# Changelog

All on 26–27 November 2026, herdr-app 0.1.18. Newest last.

## 0.1.0: first version
- Themes `macos-light` / `macos-dark` from the Sable macOS tokens: blended to solid hex, ANSI
  colours nudged to 4.5:1 on the card, bright black included.
- Layouts `macos` (shadow card) and `macos-flat` (hairline card), built from Herdr's `main`
  (merged into one in 0.5.0).
- SF Pro UI via `.SystemUIFont` (fixes missing bold in Geist), Menlo terminals.
- Tab bar on the card (`tabs-md`, `props.surface`).

## 0.2.0: polish after first review
- Sidebar selection: pale blue tint → neutral grey.
- Card top corners: tab bar no longer paints over them.
- Hairline added to the shadow card (shadow alone vanished at the top/sides and in dark mode).
- Status bar moved under the card, drawn bare (`status-md`), so it no longer cuts the shadow off.

## 0.3.0: folded sidebar ("rail")
- Spaces show their coloured letter badges, agents their program icons (`spaces-md`, `agents-md`).
- One sidebar button next to the window buttons (`chrome-md`), in the same spot in both states;
  macOS rail 108 px. Cmd+B folds/unfolds; Cmd+Shift+B hides fully.
- Content fade on fold/unfold; then a real width slide (8 steps, 180 ms).
- Fix: a stale render `cx` in the button made folding leave an invisible full-width sidebar.
- Fix: a click mid-slide could make the sidebar remember an in-between width.

## 0.4.0: rail design
- Agents grouped under their space, joined by a line in the space's colour.
- Bigger badges (44 px) and agent icons (28 px); more space between groups.
- Selected space: grey ring with a gap instead of a grey underlay.
- Active agent: a thicker bar on the space's line that slides to the new agent.
- "Needs you" pulses. Hover cards with name, folder, ⌃1–9 shortcut, agents and status;
  anchored right of the icon (an offset version swallowed clicks); hidden after a click.
- Fix: Claude icon seams (SVG declared `1em`); fixed 24×24 copy.

## 0.5.0: one layout, hairline only
- Dropped the drop shadow and with it the separate "macOS Flat" layout: Herdr's layout shadow is
  a flat grey band (sm/md/lg alike), and layered translucent rings were just as stepped.
- The status bar stays bare under the card. Its original reason (not cutting off the shadow) is
  gone, but it still reads better as part of the window.
- Package (`README.md`, `CLAUDE.md`, `install.sh`) for a Git repo; no Editor button in it.

## 0.6.0: smoother fold, no header title
- The fold moves the open sidebar out with the edge instead of re-laying it out every frame;
  the rail takes over within 12 px of the end and fades in from 35% (no empty frames). One
  resize per frame (12 steps over 180 ms) instead of 8.
- Sidebar header: the "Herdr" title and app icon are gone; search sits at the header's end.
- Linux: the rail is 72 px (was 44, too narrow for the 60 px space cells).

## Unreleased: ready to publish
- Repository laid out like Herdr's config folder (`themes/`, `layouts/`, `mods/`, `keys.json` at
  the root) for herdr.dev/layouts, with `RECIPE.md`.
- Keys apply only in the macOS layout (`layout:macos` in `keys.json`); other layouts keep Herdr's
  Cmd+B.
- Apache License 2.0.
- Screenshots: `preview.png` (light, shown at herdr.dev/layouts) and `preview-dark.png`.
- The card's edge matches Sable's flat card: the `selected` grey (#d4d4d5 light) instead of the
  softer `border`; inner lines unchanged.
- Spaces list: no bottom padding in the open sidebar, so a list that fits no longer scrolls by 14px.
- macOS-style scrollers in the Spaces and Agents lists and the Files tree: a 5px rounded overlay
  thumb shown while scrolling, fading out; the tab strip's bar shows only while scrolling.
- Files panel: slides open and shut from the tab bar; sort by name, modified or created; hide dot
  files (`files-md`). The panel's minimum width is 1px so the slide can finish.
- Notifications can go to macOS Notification Center (opt-in, `notifications.json`), with
  terminal-notifier or AppleScript; in-app toast otherwise (`toast-md`).
- Reordering tabs shows where the tab lands: a copy follows the pointer and a blue line marks the
  gap (left or right half of the tab under the pointer).
- Moving agents: drag a tab, an Agents-list row or a rail icon onto another space (or "New
  space") to move it there, running and with its name.
- Extra tab bar buttons: `tabs-md` shows buttons for other mods listed in the user's own
  `tab-buttons.json`, so personal buttons live in their own mod and survive reinstalling the theme.
