# Gallery++ 2.0

A ground-up rewrite of SillyTavern's Gallery extension, focused on speed and ease of use.

## Install

**Extensions → Install Extension**, paste `https://github.com/serioos/Gallery-Plus-Plus`, reload.
Disable the built-in **Gallery** extension so only one is active (both register `/show-gallery`).
Your existing folder assignments, sort order and panel side are imported automatically (the old settings are left untouched).

## Options (Extensions tab → Gallery++)

| Option | Range | Default |
| --- | --- | --- |
| Rows per page | 1–12 | 3 |
| Columns per page | 1–12 | 4 |
| Picture width / height (fixed, px) | 48–512 | 140 × 200 |
| Always show file names | on/off | off |
| Keyboard shortcuts | on/off | on |

Images per page = rows × columns. Changes apply instantly to an open gallery and keep your place. Out-of-range values are corrected automatically. Buttons: **Reset layout**, **Clear thumbnail cache**, **Open gallery**.

## Using the gallery

- **Search**: type in the search box to filter by file name (case-insensitive, all words must match). `Esc` clears it. Pages are recalculated for the matches.
- **Page navigation**: first / previous / next / last buttons, plus a box to type a page number and press Enter. The total page count is always shown (`3 / 12`), with a `25–36 of 140 items` summary.
- **Open a picture**: left-click opens it on the left of the screen, right-click on the right. Re-clicking an already open picture does not duplicate it.
- **Folder**: type a folder (or pick from suggestions) and press Enter / ✓ to assign it to the current character. ♻ restores the default (the character's name). Group chats use a fixed folder.
- **Upload**: *Add Image*, or drag & drop files onto the window. After uploading, the page containing the new file is shown.
- **Delete mode** (🗑): click a picture to delete it. The list updates locally without reloading.
- Switching characters/chats updates an open gallery in place.

| Key | Action |
| --- | --- |
| `[` / `]` | Previous / next page |
| `\` | Toggle the gallery |
| `=` | Close all open pictures |

Shortcuts are ignored while typing or when a popup is open, and can be turned off in the options.

## Why folder assignments used to disappear, and the fix

The assignment was only saved through SillyTavern's ~1 second debounced save and lived in a settings key shared with the built-in Gallery. Gallery++ now:

1. **Saves assignments immediately** instead of waiting for the debounce.
2. Stores them under its own `gallery_plus_plus` key, and mirrors them to the legacy `gallery` key.
3. Keeps a **browser-side recovery copy**; if the saved map ever comes back empty, it is restored.
4. Re-validates settings on every access, so corrupt or partial settings are repaired instead of breaking the extension.

## Performance

- No bundled gallery library (the old 300 KB of nanogallery2 JS/CSS and its per-page layout work are gone).
- Only the current page's tiles exist in the DOM; thumbnails load lazily as tiles scroll into view.
- Thumbnails are small WebP files cached in IndexedDB (`ST_Gallery_Cache`, capped at 4,000 entries) plus an in-memory cache, so revisited pages paint instantly. Decoding is limited to 3 concurrent jobs, and jobs for pages you have already left are cancelled.
- Searching, paging, deleting and layout changes never re-fetch the folder.
- No leaked listeners: the old drag-and-drop helper never actually unbound its handlers.

Clearing site data only makes thumbnails regenerate; your images are never modified.

## Slash commands

`/show-gallery` (`/sg`) and `/list-gallery` (`/lg`, optional `char=` / `group=`). `/list-gallery char=Name` now honours that character's assigned folder.

## Files

`index.js` (UI), `settings.js` (persistence), `thumbs.js` (thumbnail cache), `lib.js` (pure logic), `style.css`.

## License

AGPL-3.0-or-later; derived from the SillyTavern Gallery extension by City-Unit. See `LICENSE` and `NOTICE.md`.
