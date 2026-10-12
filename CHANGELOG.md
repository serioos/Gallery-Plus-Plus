# Gallery++ Extension — Changelog

## v1.6.2

Performance release. The v1.5.0 feature set and the third-party packaging fix are unchanged.

### Faster thumbnails

* Gallery tiles now render instantly with a small placeholder; **real thumbnails are generated lazily** as each tile appears instead of blocking the whole page.
* Image thumbnails are downscaled to compact **WebP (max 256 px)** and stored in a **persistent IndexedDB cache** (`ST_Gallery_Cache`), so folders you've already opened load without refetching the full-size images.
* Video thumbnails go through the same cache.
* Added a **bounded in-memory cache** (200 thumbnails) and limited thumbnail decoding to **2 concurrent jobs**, so large or video-heavy folders no longer spike CPU/memory.
* The cache degrades gracefully: if IndexedDB is unavailable or full, the gallery still works.

### Layout

* Tiles are now a fixed **144 × 256 (9:16 portrait)** grid, which avoids album-wide image-size preloading and the partially-populated-page race, so the page-flip re-measure workaround is no longer needed and was removed.
* Added CSS containment and `content-visibility` on tiles so off-screen tiles are cheap.
* Disabled the gallery transition animation.

### Smoother interactions

* **Sorting, uploading, deleting, changing folder, and restoring the folder now refresh in place** instead of closing and re-opening the Gallery++ window.
* Fixed uploads (including drag-and-drop) targeting a stale folder after the folder had been changed in the open window.
* Folder suggestions are now loaded **only when you focus the folder box**, so the window opens without waiting on a second request.
* Gallery assets (nanogallery2 JS/CSS) are **preloaded during browser idle time**; the first click shares that load.
* Replaced the document-wide `MutationObserver` with an **explicit teardown event**, so SillyTavern's whole DOM is no longer observed for removals.
* `/list-gallery` now only lists filenames and no longer builds thumbnail items.
* The "images can also be found in `user/images`" hint now appears only after the gallery loads successfully.
* Added an error notification when a gallery **refresh** fails.

## v1.5.0

These are the differences with the vanilla 1.5.0 Gallery extension of SillyTavern:

* Fixed gallery **page navigation controls** being pushed below the viewport on 1080p displays.
* Replaced oversized page flippers with **small left/right buttons beside “Add Image.”**
* Added **`[` / `]` keyboard shortcuts** for previous/next gallery pages.
* Added left-click → open image on the left side of the screen.
* Added right-click → open image on the right side of the screen.
* `\` — Toggle the gallery panel open/closed.
* `=` — Close all currently open gallery pictures.
* Hotkeys only activate when **not typing** in an input field.
* Fixed the **character gallery-folder dropdown** so selected folders persist and reopen correctly.
* Fixed **partially loaded gallery pages** after page flips by stabilizing image loading and layout recalculation.
* Prevented tall/portrait images from **spilling outside the gallery panel** and under the taskbar.
* Added a **left/right gallery positioning toggle**, with the selected side persisted across SillyTavern restarts.
* Moved the Gallery panel to a **background-level z-layer** so other UI elements can layer above it.
* Applied the same **low z-layer behavior to opened gallery images**, including after dragging/focusing them.
* Optimized gallery performance with **thumbnail caching, bounded loading, folder caching, reduced delays, and improved layout handling**.
* Improved cleanup and fixed a **mutation-observer teardown leak**.
* Fixed the **video-extension matching regex**.
* Fixed file-picker behavior when **selecting the same image again**.
* Prevented duplicate **Gallery wand buttons** during repeated initialization.
* Hardened folder restoration when **character data is unavailable**.
* Added a visible **error notification when gallery loading fails**.
* Removed minor redundant CSS/code.
* Renamed the fork to **Gallery++**.

### Packaging fix (same v1.5.0 feature set)

* Corrected the relative import paths for third-party SillyTavern installation.
* Resolved bundled nanogallery2 assets relative to the installed extension URL instead of assuming a particular folder name.
