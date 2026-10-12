# Gallery++

Gallery++ is a community fork of SillyTavern's Gallery extension, originally authored by City-Unit. It keeps image/video browsing, upload, sorting, folder overrides, deletion, pagination, and draggable previews, with fixed-side image opening and performance improvements for large portrait-heavy galleries.

## Highlights in 1.6.3

- Fixes third-party module imports and resolves bundled asset URLs relative to the installed extension path.
- Uses fixed **9:16 portrait thumbnails** for a consistent grid with mixed image dimensions.
- Caches generated image/video thumbnails in memory and IndexedDB to speed up revisits.
- Limits thumbnail-generation concurrency and lazily generates thumbnails as tiles are needed.
- Uses lightweight image/video placeholders while thumbnails are prepared.
- Constrains the gallery to the usable viewport and clips overflowing content so pagination controls remain usable.
- Keeps left-click image opening on the left and right-click opening on the right; the gallery panel can be positioned independently.
- Preserves compact page controls, keyboard shortcuts, folder sorting, folder overrides, and image/video upload.
- Uses Gallery++-specific settings, commands, panel IDs, CSS classes, and cache storage to avoid replacing built-in Gallery state.

## Installation

### SillyTavern extension installer

1. Open **Extensions → Install Extension** in SillyTavern.
2. Paste `https://github.com/serioos/Gallery-Plus-Plus`.
3. Install and reload SillyTavern.

Keep `manifest.json` at the repository root. Bundled nanogallery2 resources are resolved relative to `index.js`, so both user-scoped and global third-party installs can find them.

### Manual installation

Place the repository contents directly in one of these folders:

```text
SillyTavern/data/<your-user>/extensions/gallery-plus-plus/
```

or, for a global installation:

```text
SillyTavern/public/scripts/extensions/third-party/gallery-plus-plus/
```

`manifest.json` and `index.js` must be directly inside the extension folder. Do not add another nested `Gallery-Plus-Plus` directory.

## Compatibility

Gallery++ targets SillyTavern **1.17.0 or newer**.

## Commands and shortcuts

- `/show-gallery-plus` (`/sgp`) opens the gallery.
- `/list-gallery-plus` (`/lgp`) returns the current character/group image list.
- `[` and `]` navigate gallery pages.
- `\` toggles the gallery panel.
- `=` closes open Gallery++ image windows.
- Left-click a thumbnail to open it on the left; right-click to open it on the right.

The shortcuts do not activate while typing in an input field or while a popup is open.

## Settings migration

On first launch, Gallery++ copies compatible folder, sort, and panel-side settings from the built-in `gallery` settings namespace into its own `galleryPlusPlus` namespace. The original settings are left untouched. To avoid duplicate gallery buttons and overlapping global hotkeys, disable the built-in Gallery if you intend to use Gallery++ as your primary gallery.

## License and attribution

Gallery++ is derived from SillyTavern's Gallery extension, originally authored by City-Unit. The derived source is distributed under **GNU AGPL-3.0-or-later**. See the existing `LICENSE` and `NOTICE.md` files in the repository. The bundled nanogallery2 files remain third-party dependencies; retain their upstream notices when redistributing them.
