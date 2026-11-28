/*
 * Gallery++ — pure helper logic (no SillyTavern or DOM dependencies, so it can be unit-tested in Node).
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Allowed ranges for the user-configurable grid layout. */
export const LAYOUT_LIMITS = Object.freeze({
    portraitRows: { min: 1, max: 12 },
    portraitCols: { min: 1, max: 12 },
    landscapeRows: { min: 1, max: 12 },
    landscapeCols: { min: 1, max: 12 },
});

/** Picture shapes offered in the options (width:height). 'auto' is handled separately. */
export const ASPECT_PRESETS = Object.freeze([
    '9:21', '9:16', '2:3', '3:4', '4:5', '1:1', '5:4', '4:3', '3:2', '16:9', '21:9',
].map((value) => {
    const [w, h] = value.split(':').map(Number);
    return Object.freeze({ value, label: value, w, h, ratio: w / h });
}));

export const LAYOUT_DEFAULTS = Object.freeze({
    portraitRows: 3,
    portraitCols: 4,
    landscapeRows: 4,
    landscapeCols: 2,
    aspect: 'auto',
});

/** Coarse thumbnail resolution buckets (longest side in px). Fewer buckets mean higher cache hit rates. */
export const THUMB_BUCKETS = Object.freeze([256, 512, 768, 1024]);

/**
 * Coerces any value to an integer within [min, max]; falls back when it is not a finite number.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
    const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** True for 'auto' or one of the preset values. */
export function isValidAspect(value) {
    return value === 'auto' || ASPECT_PRESETS.some(p => p.value === value);
}

/** Width / height for a preset value such as '9:16'; null for 'auto' or anything unknown. */
export function parseAspect(value) {
    return ASPECT_PRESETS.find(p => p.value === value)?.ratio ?? null;
}

/**
 * The preset that most of the given width/height ratios are closest to.
 * Ties go to the preset with the smaller total distance.
 * @param {number[]} ratios
 * @returns {string|null} A preset value, or null when there is nothing usable.
 */
export function dominantAspect(ratios) {
    const votes = new Map();
    for (const ratio of ratios) {
        if (!(ratio > 0) || !Number.isFinite(ratio)) continue;
        let best = null;
        let bestDistance = Infinity;
        for (const preset of ASPECT_PRESETS) {
            const distance = Math.abs(Math.log(ratio / preset.ratio));
            if (distance < bestDistance) { best = preset; bestDistance = distance; }
        }
        const entry = votes.get(best.value) ?? { count: 0, distance: 0 };
        entry.count++;
        entry.distance += bestDistance;
        votes.set(best.value, entry);
    }
    let winner = null;
    for (const [value, entry] of votes) {
        if (!winner || entry.count > winner.count || (entry.count === winner.count && entry.distance < winner.distance)) {
            winner = { value, ...entry };
        }
    }
    return winner?.value ?? null;
}

/**
 * Returns a fully valid layout object from arbitrary (possibly corrupt) input.
 * @param {Partial<typeof LAYOUT_DEFAULTS>|null|undefined} raw
 */
export function normalizeLayout(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const portraitRowsRaw = src.portraitRows ?? src.rows;
    const portraitColsRaw = src.portraitCols ?? src.cols;
    return {
        portraitRows: clampInt(portraitRowsRaw, LAYOUT_LIMITS.portraitRows.min, LAYOUT_LIMITS.portraitRows.max, LAYOUT_DEFAULTS.portraitRows),
        portraitCols: clampInt(portraitColsRaw, LAYOUT_LIMITS.portraitCols.min, LAYOUT_LIMITS.portraitCols.max, LAYOUT_DEFAULTS.portraitCols),
        landscapeRows: clampInt(src.landscapeRows, LAYOUT_LIMITS.landscapeRows.min, LAYOUT_LIMITS.landscapeRows.max, LAYOUT_DEFAULTS.landscapeRows),
        landscapeCols: clampInt(src.landscapeCols, LAYOUT_LIMITS.landscapeCols.min, LAYOUT_LIMITS.landscapeCols.max, LAYOUT_DEFAULTS.landscapeCols),
        aspect: isValidAspect(src.aspect) ? src.aspect : LAYOUT_DEFAULTS.aspect,
    };
}

/** True when a width/height ratio is wider than tall (landscape). */
export function isLandscapeRatio(ratio) {
    return Number.isFinite(ratio) && ratio > 1;
}

/**
 * Picks the portrait or landscape rows/columns for the active tile ratio.
 * Square (1:1) and portrait (< 1) ratios use the portrait grid; ratios > 1 use the landscape grid.
 * @param {typeof LAYOUT_DEFAULTS} layout
 * @param {number} ratio
 * @returns {{rows: number, cols: number, orientation: 'portrait'|'landscape'}}
 */
export function resolveGridForRatio(layout, ratio) {
    if (isLandscapeRatio(ratio)) {
        return { rows: layout.landscapeRows, cols: layout.landscapeCols, orientation: 'landscape' };
    }
    return { rows: layout.portraitRows, cols: layout.portraitCols, orientation: 'portrait' };
}

/** Number of pages; always at least 1 so an empty gallery still shows "1 / 1". */
export function pageCount(totalItems, pageSize) {
    if (!(pageSize > 0)) return 1;
    return Math.max(1, Math.ceil(Math.max(0, totalItems) / pageSize));
}

/** Clamps a 1-based page number into [1, pages]. */
export function clampPage(page, pages) {
    return clampInt(page, 1, Math.max(1, pages), 1);
}

/** Items shown on a 1-based page. */
export function pageSlice(items, page, pageSize) {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
}

/**
 * Page that keeps a previously-visible item on screen after the page size changes.
 * @param {number} firstIndex Zero-based index of the first item that was visible
 * @param {number} newPageSize
 */
export function pageForIndex(firstIndex, newPageSize) {
    return Math.floor(Math.max(0, firstIndex) / Math.max(1, newPageSize)) + 1;
}

/**
 * Parses what a user typed into the "jump to page" box.
 * @param {string} text
 * @param {number} pages
 * @returns {number|null} A valid page, or null when the text is not a number at all.
 */
export function parsePageInput(text, pages) {
    const trimmed = String(text ?? '').trim();
    if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return null;
    return clampPage(Math.round(Number(trimmed)), pages);
}

/** Splits a search query into lowercase tokens. Every token must match (AND). */
export function tokenizeQuery(query) {
    return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Filters items by file name. Items must carry a pre-lowercased `nameLower` field so
 * searching thousands of files never re-lowercases strings on each keystroke.
 * @template {{nameLower: string}} T
 * @param {T[]} items
 * @param {string} query
 * @returns {T[]}
 */
export function filterByName(items, query) {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return items;
    return items.filter(item => tokens.every(token => item.nameLower.includes(token)));
}

/**
 * Largest tile of a given shape such that `cols` x `rows` of them fit into the available area.
 * There is deliberately no upper cap: few columns/rows give big pictures, many give small ones.
 * @param {number} availW Width available to the tiles themselves (gaps and padding already removed)
 * @param {number} availH Height available to the tiles (<= 0 / NaN means "unconstrained")
 * @param {number} cols
 * @param {number} rows
 * @param {number} ratio Tile width / height
 * @param {number} [minSide]
 * @returns {{tw: number, th: number}}
 */
export function fitTile(availW, availH, cols, rows, ratio, minSide = 24) {
    const r = ratio > 0 && Number.isFinite(ratio) ? ratio : 2 / 3;
    const maxW = availW / Math.max(1, cols);
    let tw = maxW;
    if (availH > 0 && Number.isFinite(availH)) tw = Math.min(maxW, (availH / Math.max(1, rows)) * r);
    tw = Math.max(minSide, Math.floor(tw));
    const th = Math.max(minSide, Math.floor(tw / r));
    return { tw, th };
}

/**
 * Picks the smallest coarse thumbnail resolution bucket that covers the rendered tile size.
 * @param {number} width
 * @param {number} height
 * @param {number} [devicePixelRatio]
 * @returns {number}
 */
export function thumbBucket(width, height, devicePixelRatio = 1) {
    const dpr = Math.min(2, Math.max(1, Number(devicePixelRatio) || 1));
    const side = Math.max(width, height) * dpr;
    for (const bucket of THUMB_BUCKETS) {
        if (side <= bucket) return bucket;
    }
    return THUMB_BUCKETS[THUMB_BUCKETS.length - 1];
}

/**
 * Pre-normalizes a list of file extensions into a lowercase Set (without leading dots) for O(1) lookups.
 * @param {Iterable<string>} extensions
 * @returns {Set<string>}
 */
export function normalizeExtensions(extensions) {
    const set = new Set();
    for (const e of extensions ?? []) {
        const clean = String(e).toLowerCase().replace(/^\./, '');
        if (clean) set.add(clean);
    }
    return set;
}

/** @param {string} fileName @param {Set<string>|string[]} extensions */
export function isVideoName(fileName, extensions) {
    const lower = String(fileName).toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot < 0) return false;
    const ext = lower.slice(dot + 1);
    if (extensions instanceof Set) return extensions.has(ext);
    return extensions.some(e => String(e).toLowerCase().replace(/^\./, '') === ext);
}

/** Percent-encodes each path segment so names containing # ? % etc. still load. */
export function encodePath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
}

/** Last path segment. */
export function baseName(path) {
    const s = String(path);
    return s.slice(s.lastIndexOf('/') + 1);
}

/** Makes a string safe to use as a DOM id. */
export function sanitizeHTMLId(text) {
    const cleaned = String(text)
        .replace(/\s+/g, '-')
        .replace(/[^\x00-\x7F]/g, '-')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned || 'image';
}

/**
 * Parses EXIF Orientation (tag 0x0112) from a JPEG APP1 segment payload (starting at "Exif\0\0").
 * Returns 1..8 when found, or 1 otherwise.
 * @param {Uint8Array} bytes
 * @param {number} start Offset of "Exif\0\0"
 * @param {number} end Exclusive end offset of the APP1 segment
 * @returns {number}
 */
function parseExifOrientation(bytes, start, end) {
    if (start + 14 > end) return 1;
    // "Exif\0\0"
    if (bytes[start] !== 0x45 || bytes[start + 1] !== 0x78 || bytes[start + 2] !== 0x69
        || bytes[start + 3] !== 0x66 || bytes[start + 4] !== 0x00 || bytes[start + 5] !== 0x00) {
        return 1;
    }
    const tiff = start + 6;
    const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49; // 'II'
    const big = bytes[tiff] === 0x4D && bytes[tiff + 1] === 0x4D;    // 'MM'
    if (!little && !big) return 1;

    const u16 = (o) => little
        ? (bytes[o] | (bytes[o + 1] << 8))
        : ((bytes[o] << 8) | bytes[o + 1]);
    const u32 = (o) => little
        ? ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0)
        : (((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);

    if (u16(tiff + 2) !== 0x002A) return 1;
    const ifdOffset = u32(tiff + 4);
    const ifd = tiff + ifdOffset;
    if (ifd < tiff || ifd + 2 > end) return 1;

    const entries = u16(ifd);
    for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > end) break;
        if (u16(entry) === 0x0112) {
            const val = u16(entry + 8);
            return val >= 1 && val <= 8 ? val : 1;
        }
    }
    return 1;
}

/**
 * Extracts image width & height from the leading bytes of PNG, JPEG, WebP, GIF, or BMP files.
 * Accounts for JPEG EXIF Orientation (tags 5–8 swap width and height) and OS/2 BMP headers.
 * Returns null if the format is unrecognized or more bytes are required.
 * @param {Uint8Array} bytes
 * @returns {{w: number, h: number}|null}
 */
export function parseImageDimensions(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 10) return null;
    const len = bytes.length;
    const u16be = (o) => (bytes[o] << 8) | bytes[o + 1];
    const u16le = (o) => bytes[o] | (bytes[o + 1] << 8);
    const u32be = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    const u32le = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
    const i32le = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) | 0;

    // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width/height at offsets 16 and 20
    if (len >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
        && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
        const w = u32be(16);
        const h = u32be(20);
        return w > 0 && h > 0 ? { w, h } : null;
    }

    // GIF: GIF87a / GIF89a
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
        && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
        const w = u16le(6);
        const h = u16le(8);
        return w > 0 && h > 0 ? { w, h } : null;
    }

    // WebP: RIFF....WEBP
    if (len >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        const c0 = bytes[12], c1 = bytes[13], c2 = bytes[14], c3 = bytes[15];
        // 'VP8 ' (lossy)
        if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x20
            && bytes[23] === 0x9D && bytes[24] === 0x01 && bytes[25] === 0x2A) {
            const w = u16le(26) & 0x3FFF;
            const h = u16le(28) & 0x3FFF;
            return w > 0 && h > 0 ? { w, h } : null;
        }
        // 'VP8L' (lossless)
        if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x4C && bytes[20] === 0x2F) {
            const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
            const w = 1 + (b0 | ((b1 & 0x3F) << 8));
            const h = 1 + (((b1 & 0xC0) >> 6) | (b2 << 2) | ((b3 & 0x0F) << 10));
            return w > 0 && h > 0 ? { w, h } : null;
        }
        // 'VP8X' (extended)
        if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x58) {
            const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
            const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
            return w > 0 && h > 0 ? { w, h } : null;
        }
        return null;
    }

    // BMP: 'BM' (supports both OS/2 BITMAPCOREHEADER (12 bytes) and Windows BITMAPINFOHEADER+)
    if (len >= 22 && bytes[0] === 0x42 && bytes[1] === 0x4D) {
        const dibSize = u32le(14);
        if (dibSize === 12) {
            const w = u16le(18);
            const h = u16le(20);
            return w > 0 && h > 0 ? { w, h } : null;
        }
        if (len >= 26) {
            const w = i32le(18);
            const h = Math.abs(i32le(22));
            return w > 0 && h > 0 ? { w, h } : null;
        }
        return null;
    }

    // JPEG: FF D8 ... APP1 (EXIF Orientation) ... SOF0..SOF15 (excluding DHT C4, JPG C8, DAC CC)
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
        let offset = 2;
        let orientation = 1;
        while (offset + 1 < len) {
            while (offset < len && bytes[offset] !== 0xFF) offset++;
            while (offset < len && bytes[offset] === 0xFF) offset++;
            if (offset >= len) break;
            const marker = bytes[offset++];
            if (marker === 0xD9 || marker === 0xDA) break; // EOI / SOS
            if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) continue; // standalone
            if (offset + 2 > len) break;
            const segLen = u16be(offset);
            if (segLen < 2) break;
            if (marker === 0xE1 && orientation === 1) {
                const segEnd = Math.min(len, offset + segLen);
                orientation = parseExifOrientation(bytes, offset + 2, segEnd);
            } else if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7)
                || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
                if (offset + 7 > len) break;
                const h = u16be(offset + 3);
                const w = u16be(offset + 5);
                if (w > 0 && h > 0) {
                    return orientation >= 5 && orientation <= 8 ? { w: h, h: w } : { w, h };
                }
                return null;
            }
            offset += segLen;
        }
    }

    return null;
}