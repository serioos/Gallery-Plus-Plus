/*
 * Gallery++ — pure helper logic (no SillyTavern or DOM dependencies, so it can be unit-tested in Node).
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Allowed ranges for the user-configurable grid layout. */
export const LAYOUT_LIMITS = Object.freeze({
    rows: { min: 1, max: 12 },
    cols: { min: 1, max: 12 },
});

/** Picture shapes offered in the options (width:height). 'auto' is handled separately. */
export const ASPECT_PRESETS = Object.freeze([
    '9:21', '9:16', '2:3', '3:4', '4:5', '1:1', '5:4', '4:3', '3:2', '16:9', '21:9',
].map((value) => {
    const [w, h] = value.split(':').map(Number);
    return Object.freeze({ value, label: value, w, h, ratio: w / h });
}));

export const LAYOUT_DEFAULTS = Object.freeze({
    rows: 3,
    cols: 4,
    aspect: 'auto',
});

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
    return {
        rows: clampInt(src.rows, LAYOUT_LIMITS.rows.min, LAYOUT_LIMITS.rows.max, LAYOUT_DEFAULTS.rows),
        cols: clampInt(src.cols, LAYOUT_LIMITS.cols.min, LAYOUT_LIMITS.cols.max, LAYOUT_DEFAULTS.cols),
        aspect: isValidAspect(src.aspect) ? src.aspect : LAYOUT_DEFAULTS.aspect,
    };
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
 * Thumbnail resolution bucket. Rounding up to 64px steps means small layout tweaks
 * reuse cached thumbnails, while bigger tiles / HiDPI screens get sharper ones.
 */
export function thumbBucket(width, height, devicePixelRatio = 1) {
    const dpr = Math.min(2, Math.max(1, Number(devicePixelRatio) || 1));
    const side = Math.max(width, height) * dpr;
    return Math.min(1024, Math.max(128, Math.ceil(side / 64) * 64));
}

/** @param {string} fileName @param {string[]} extensions */
export function isVideoName(fileName, extensions) {
    const lower = String(fileName).toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot < 0) return false;
    const ext = lower.slice(dot + 1);
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
    const cleaned = String(text).replace(/\s+/g, '-').replace(/[^\x00-\x7F]/g, '-').replace(/\W/g, '');
    return cleaned || 'image';
}
