# Gallery++

A community fork of SillyTavern's Gallery extension. Gallery++ keeps the existing gallery, upload, sorting, folder, delete, pagination, image/video preview, and draggable-window behavior while adding fixed-side mouse actions:

- **Left click** a picture to open that exact picture on the **left side** of the screen.
- **Right click** a picture to open that exact picture on the **right side** of the screen.
- The image window side is independent of where the Gallery++ panel itself is positioned.
- Right-click selection uses the actual thumbnail source URL, so mixed portrait/landscape dimensions do not shift the selected image.

## Installation

### SillyTavern extension installer

1. Open **Extensions → Install Extension** in SillyTavern.
2. Paste the URL of this GitHub repository.
3. Install and reload SillyTavern.

SillyTavern's third-party installer installs the repository as an extension, so keep `manifest.json` at the repository root. The extension is packaged with its third-party asset path (`scripts/extensions/third-party/gallery-plus-plus/`) so the bundled nanogallery2 assets load correctly.

### Manual installation

Place the repository contents directly in:

```text
SillyTavern/data/<your-user>/extensions/gallery-plus-plus/
```

or, for a global installation:

```text
SillyTavern/public/scripts/extensions/third-party/gallery-plus-plus/
```

The folder must contain `manifest.json` and `index.js` directly; do not add another nested `gallery-plus-plus` folder.

## Compatibility

Gallery++ targets SillyTavern **1.17.0 or newer** because it uses the modern extension lifecycle hook declared in `manifest.json`. The current SillyTavern release is **1.19.0** as of 2026-09-30.

## Notes for existing Gallery users

Gallery++ uses its own extension settings namespace and UI IDs so it can be installed as a separate third-party extension without colliding with the built-in Gallery. On first run, it copies existing `gallery` settings (folder overrides, sorting, and panel side) into the Gallery++ settings namespace.

For a single Gallery button and command set, disable the built-in Gallery after installing Gallery++.

## Changes in 1.0.0

- Renamed the fork to **Gallery++**.
- Added left-click → left-side opening.
- Added right-click → right-side opening.
- Right-click selection is based on the thumbnail's real source URL.
- Made the extension safe to install from a GitHub repository as a third-party extension.
- Added isolated settings/UI namespaces and migration from the original Gallery settings.
- Renamed slash commands to avoid collisions:
  - `/show-gallery-plus` (`/sgp`)
  - `/list-gallery-plus` (`/lgp`)

## License and attribution

Gallery++ is a modified version of SillyTavern's Gallery extension, originally authored by City-Unit. The derived source is distributed under **AGPL-3.0**; see `LICENSE` and `NOTICE.md`.
