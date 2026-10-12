# Gallery++ Extension — Changelog

## v1.6.3

- Fixed third-party extension import paths so SillyTavern core modules resolve when installed from GitHub.
- Changed bundled nanogallery2 asset URLs to resolve relative to the installed extension module, supporting user-scoped and global installs.
- Kept the 9:16 thumbnail, caching, and Gallery++ isolation changes from v1.6.2.

## v1.6.2

- Changed the thumbnail grid to fixed 9:16 portrait tiles for predictable geometry with mixed image sizes.
- Added bounded, lazy thumbnail generation for images and videos.
- Added a bounded in-memory cache and IndexedDB persistence for generated thumbnails.
- Added lightweight portrait placeholders and improved off-screen thumbnail rendering behavior.
- Tightened viewport containment to reduce overflow and keep gallery pagination visible.
- Preserved fixed-side left/right image opening, compact pagination controls, and keyboard shortcuts.
- Isolated Gallery++ settings, commands, panel IDs, CSS classes, teardown events, and thumbnail-cache storage from the built-in Gallery.
- Added migration of compatible folder, sort, and panel-side settings from the built-in Gallery settings namespace.

## v1.5.0

- Fixed gallery page navigation controls being pushed below the viewport on 1080p displays.
- Replaced oversized page flippers with small left/right buttons beside “Add Image.”
- Added `[` / `]` keyboard shortcuts for previous/next gallery pages.
- Added left-click → open image on the left side of the screen.
- Added right-click → open image on the right side of the screen.
- Added `\` to toggle the gallery panel and `=` to close all currently open gallery pictures.
- Fixed character gallery-folder selection persistence and partially loaded pages after page flips.
- Prevented tall/portrait images from spilling outside the gallery panel and under the taskbar.
- Added a left/right gallery positioning toggle and background-level z-layer behavior.
- Optimized gallery performance with caching, bounded loading, reduced delays, and improved layout handling.
- Corrected third-party installation asset paths and namespaced the fork as Gallery++.
