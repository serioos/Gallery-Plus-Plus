# Gallery++ Extension — Changelog

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
