# Gallery++ Version 1.5.0

Gallery++ is a community fork of SillyTavern's Gallery extension. It keeps the normal gallery workflow—folders, sorting, upload, deletion, pagination, image/video preview, and draggable windows—while adding the fixes and quality-of-life changes listed below.

## Install directly from GitHub

Gallery++ is structured as a SillyTavern third-party extension repository. The extension manifest is kept at the repository root so SillyTavern can install it from the repository URL.

1. In SillyTavern, open **Extensions** → **Install Extension**.
2. Paste:

   `https://github.com/serioos/Gallery-Plus-Plus`

3. Install the extension and reload SillyTavern when prompted.

SillyTavern's documentation describes third-party installation by pasting a Git repository URL into **Extensions → Install Extension**: https://docs.sillytavern.app/extensions/

### Important for the built-in Gallery

Gallery++ uses the Gallery UI IDs and slash commands from the original extension so it can act as a drop-in fork. For a single Gallery implementation, disable the built-in **Gallery** extension after installing Gallery++ rather than running both copies at the same time.

## Manual installation

The repository contents can also be placed directly in either of these locations:

```text
SillyTavern/data/<your-user>/extensions/gallery-plus-plus/
```

or, for a global installation:

```text
SillyTavern/public/scripts/extensions/third-party/gallery-plus-plus/
```

`manifest.json` and `index.js` must be directly inside the `gallery-plus-plus` directory.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `[` | Previous gallery page |
| `]` | Next gallery page |
| `\` | Toggle the Gallery++ panel open/closed |
| `=` | Close all currently open gallery pictures |

Gallery++ only handles these shortcuts when focus is not inside an input, textarea, select, or contenteditable element. It also ignores the shortcuts while a SillyTavern popup is open.

## Mouse actions

- **Left-click** an image to open that exact image on the **left** side of the screen.
- **Right-click** an image to open that exact image on the **right** side of the screen.

The image window side is independent of the side where the Gallery++ panel itself is positioned.

## Gallery panel positioning

Gallery++ includes a left/right positioning toggle for the gallery panel. The selected side is persisted in SillyTavern settings and restored after restarting SillyTavern.

Opened gallery pictures are kept at a background-level z-layer so other SillyTavern UI can appear above them. The same low stacking level is re-applied after dragging/focusing an opened picture.

## What changed in v1.5.0

Compared with the vanilla SillyTavern Gallery 1.5.0:

- Fixed gallery **page navigation controls** being pushed below the viewport on 1080p displays.
- Replaced oversized page flippers with **small left/right buttons beside “Add Image.”**
- Added **`[` / `]` keyboard shortcuts** for previous/next gallery pages.
- Added left-click → open image on the left side of the screen.
- Added right-click → open image on the right side of the screen.
- `\` — Toggle the gallery panel open/closed.
- `=` — Close all currently open gallery pictures.
- Hotkeys only activate when **not typing** in an input field.
- Fixed the **character gallery-folder dropdown** so selected folders persist and reopen correctly.
- Fixed **partially loaded gallery pages** after page flips by stabilizing image loading and layout recalculation.
- Prevented tall/portrait images from **spilling outside the gallery panel** and under the taskbar.
- Added a **left/right gallery positioning toggle**, with the selected side persisted across SillyTavern restarts.
- Moved the Gallery panel to a **background-level z-layer** so other UI elements can layer above it.
- Applied the same **low z-layer behavior to opened gallery images**, including after dragging/focusing them.
- Optimized gallery performance with **thumbnail caching, bounded loading, folder caching, reduced delays, and improved layout handling**.
- Improved cleanup and fixed a **mutation-observer teardown leak**.
- Fixed the **video-extension matching regex**.
- Fixed file-picker behavior when **selecting the same image again**.
- Prevented duplicate **Gallery wand buttons** during repeated initialization.
- Hardened folder restoration when **character data is unavailable**.
- Added a visible **error notification when gallery loading fails**.
- Removed minor redundant CSS/code.
- Renamed the fork to **Gallery++**.

## Compatibility

The manifest uses SillyTavern's modern extension lifecycle hook and declares **SillyTavern 1.17.0+** as the minimum client version for this packaged build.

## Files

```text
Gallery-Plus-Plus/
├── CHANGELOG.md
├── LICENSE
├── NOTICE.md
├── README.md
├── index.i18n.html
├── index.js
├── jquery.nanogallery2.min.js
├── manifest.json
├── nanogallery2.woff.min.css
└── style.css
```

## Attribution and license

Gallery++ is a modified version of the Gallery extension included with SillyTavern and originally authored by **City-Unit**. The derived source is distributed under the **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**. See `LICENSE` and `NOTICE.md`.
