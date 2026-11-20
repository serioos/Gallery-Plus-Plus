# Gallery++ 2.1

A ground-up rewrite of SillyTavern's Gallery extension, focused on speed, low resource usage, and ease of use.

## Install

**Extensions → Install Extension**, paste `https://github.com/serioos/Gallery-Plus-Plus`, reload.
Disable the built-in **Gallery** extension so only one is active (both register `/show-gallery`).
Your existing folder assignments, sort order and panel side are imported automatically (the old settings are left untouched).

## Options (Extensions tab → Gallery++)

| Option | Range / Values | Default |
| --- | --- | --- |
| Rows per page | 1–12 | 3 |
| Columns per page | 1–12 | 4 |
| Picture shape (width : height) | `Auto` or preset (`9:21` … `21:9`) | `Auto` |
| Always show file names on pictures | on/off | off |
| Clean opened pictures (frame & close button only on hover) | on/off | on |
| Esc never closes opened pictures or the gallery | on/off | off |
| Keyboard shortcuts | on/off | on |

Images per page = rows × columns. Tiles automatically scale to fill the free space beside the chat panel, and `Auto` detects each folder's dominant aspect ratio from image headers. Changes apply instantly to an open gallery and keep your place. Buttons: **Open gallery**, **Reset layout**, **Clear thumbnail cache**.

## Using the gallery

- **Search**: type in the search box to filter by file name (case-insensitive, all words must match). `Esc` clears it. Pages are recalculated for the matches.
- **Page navigation**: first / previous / next / last buttons, plus a box to type a page number and press Enter. The total page count is always shown (`3 / 12`), with a `25–36 of 140 items` summary.
- **Open a picture**: left-click opens it on the left of the screen, right-click on the right. Re-clicking an already open picture moves it instead of duplicating it.
- **Side toggle** (`⇄`): dock the gallery panel to the left or right of the chat panel.
- **Folder**: type a folder (or pick from suggestions) and press Enter / ✓ to assign it to the current character. ♻ restores the default (the character's name). Group chats use a fixed folder.
- **Refresh** (`↻`): re-lists the folder and rebuilds all cached thumbnails for it.
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
3. Keeps a **browser-side recovery copy** (scoped per account in multi-user setups); if the saved map ever comes back empty, it is restored.
4. Re-validates settings on every access, so corrupt or partial settings are repaired instead of breaking the extension.

## Performance

- Zero third-party gallery library overhead (the old 300 KB of nanogallery2 JS/CSS is gone).
- Only the current page's tiles exist in the DOM; CSS containment isolates gallery layout from the chat log, and pagination avoids full-panel reflows.
- Image decoding, resizing, and WebP encoding run off the main thread in an auto-terminating Web Worker (with transparent main-thread fallback).
- Thumbnails are cached in coarse resolution buckets (`256`, `512`, `768`, `1024`) in IndexedDB (`ST_Gallery_Cache`, capped at 4,000 entries with key-only LRU pruning) plus an in-memory LRU that retains decoded object URLs for instant page-back.
- IndexedDB reads are batched per page and writes are coalesced into batch transactions. Cached thumbnails paint immediately (stale-while-revalidate) while throttled, abortable `HEAD` checks detect replaced/edited files in the background; cache misses read version headers straight from `GET`.
- `Auto` aspect-ratio detection reads cached dimensions or tiny `Range` header probes instead of downloading full images.
- Searching, paging, deleting, and layout changes never re-fetch the folder, and all extension storage is cleaned up automatically via SillyTavern's `clean` lifecycle hook.

Clearing site data only makes thumbnails regenerate; your images are never modified.

## Slash commands

`/show-gallery` (`/sg`) and `/list-gallery` (`/lg`, optional `char=` / `group=`). `/list-gallery char=Name` honours that character's assigned folder.

## Files

`index.js` (UI), `settings.js` (persistence), `thumbs.js` (thumbnail worker & cache), `lib.js` (pure logic), `style.css`.

## License

AGPL-3.0-or-later; derived from the SillyTavern Gallery extension by City-Unit. See `LICENSE` and `NOTICE.md`.