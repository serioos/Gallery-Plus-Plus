# Changelog

## 2.0.4
- The gallery window now sits flush against the chat panel and the bottom edge of the screen, exactly like opened pictures, and hugs its grid.
- **No more flash of a small window.** Opened pictures stay invisible until their real size is known (previously a 320x320 placeholder faded in and then jumped to the picture's size). The gallery window itself also appears only once, at its final size.
- **Tiles now scale with the grid.** Picture size is derived from columns x rows and the free space beside the chat, with no upper cap: few columns/rows give big pictures that fill the window, many give small ones that still fit. The old 1x cap that left small, loose grids is gone.
- The window keeps the same size while loading, on a half-empty last page, when searching with no results and when showing messages (it used to collapse and re-expand, which looked like a deformed gallery).
- Thumbnails are generated at the resolution of the tiles actually on screen, so enlarged tiles stay sharp.
- The shape detected for each gallery is remembered, so reopening it starts at the right size immediately.
- The manual resize handle is hidden on desktop (the size is automatic).

## 2.0.3
- Opened pictures now sit flush against the chat panel and the bottom edge of the screen (like a character sprite).
- Picture width/height options replaced by a **Picture shape** dropdown (9:21 … 21:9). The default, **Auto**, samples each gallery and uses the shape most of its pictures have.
- Tile size is derived from the free space beside the chat, so no manual pixel sizes are needed.
- The "assign folder" check mark now always gives feedback (including "already showing this folder"), matches existing folder names case-insensitively, and ignores double clicks.

## 2.0.2
- Folder dropdown rewritten as a built-in suggestion list: clicking (or arrow keys + Enter) now reliably switches to the chosen gallery.
- The gallery window and opened pictures are now fitted to the free space beside the chat panel (left or right), never spilling under it. Thumbnails scale down to fit, and everything re-fits when the browser window or chat width changes.

## 2.0.1
- Fixed "Failed to load the gallery": folder-name autocomplete no longer crashes the window if jQuery UI's autocomplete can't initialise; falls back to a native datalist.

## 2.0.0 — full rewrite

### New
- **Gallery++ options** in the Extensions tab: rows, columns, fixed picture width and height (plus file-name captions and a shortcuts toggle).
- **Name search bar** (multi-word, case-insensitive, `Esc` to clear).
- **Page navigation**: jump-to-page box, first/last buttons, total page count and item range.
- **Persistent folder assignments** (immediate save, dedicated settings key, browser recovery copy, automatic migration from the old Gallery settings).

### Performance
- Removed the nanogallery2 dependency; custom CSS-grid renderer with only the visible page in the DOM.
- Lazy thumbnails (IntersectionObserver), WebP IndexedDB cache with size cap and old-cache cleanup, in-memory LRU, bounded and cancellable decode queue.
- Deleting removes the item locally; uploads/sorting refresh in place.

### Fixes and improvements
- Fixed leaked drag-and-drop handlers (replaced by native listeners scoped to the window).
- Fixed the always-on-bottom z-index forcing the gallery under everything on mobile layouts.
- Opened pictures use `contain` instead of cropping, are sized to the picture, and are not duplicated if opened twice.
- The gallery follows character/group changes instead of closing; no more loading an `undefined` folder when nothing is selected.
- Files with `#`, `?` or `%` in their names now load.
- One summary toast per upload batch; shows the page containing the new file.
- `/list-gallery char=` honours the assigned folder.
- Window is kept inside the viewport after layout changes; stale saved sizes no longer override layout changes.
- Keyboard-accessible tiles (`Enter`/`Space` = left, `Shift+Enter` = right).
