/*
 * Gallery++ — thumbnail service.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * - Thumbnails are small WebP blobs persisted in IndexedDB, so revisiting a folder never re-downloads
 *   full-size images.
 * - A bounded in-memory LRU gives synchronous hits when flipping back and forth between pages.
 * - Every cached thumbnail remembers a "version signature" of the file it was made from (ETag /
 *   Last-Modified / size, read with a cheap HEAD request). When the file on the server has changed, the
 *   stale thumbnail is discarded and regenerated, so replaced or edited images never show old previews.
 * - Decoding is limited to a few concurrent jobs, and queued jobs are dropped when their tile has been
 *   scrolled away or the page changed (AbortSignal), so fast page flipping never builds a backlog.
 */

import { getVideoThumbnail } from '../../../utils.js';

const DB_NAME = 'ST_Gallery_Cache';
const DB_VERSION = 2;
const STORE = 'thumbs2';
const LEGACY_STORE = 'thumbnails'; // v1 stored bulky data-URL strings; dropped on upgrade
const MAX_DB_ENTRIES = 4000;
const PRUNE_EVERY_WRITES = 40;
const MEMORY_LIMIT = 400;
const CONCURRENCY = 3;
const VIDEO_TIMEOUT_MS = 15_000;
const WEBP_QUALITY = 0.82;
const SIGNATURE_TTL_MS = 30_000; // how long a checked signature is trusted before re-checking the server

/** @type {Map<string, {blob: Blob, v: string|null}>} insertion-ordered LRU */
const memory = new Map();
/** @type {Map<string, {sig: string|null, time: number}>} last server signature seen per file URL */
const signatures = new Map();
/** @type {Map<string, Promise<string|null>>} */
const signatureInFlight = new Map();
/** @type {Map<string, Promise<Blob|null>>} */
const inFlight = new Map();
/** @type {Array<{run: () => Promise<void>, signal?: AbortSignal, cancel: () => void}>} */
const queue = [];
let active = 0;
let writesSincePrune = 0;
/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

const keyOf = (src, bucket) => `${src}|${bucket}`;

function remember(key, blob, v = null) {
    memory.delete(key);
    memory.set(key, { blob, v });
    while (memory.size > MEMORY_LIMIT) {
        memory.delete(memory.keys().next().value);
    }
}

// ------------------------------------------------------------------------------ IndexedDB

function openDB() {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (db.objectStoreNames.contains(LEGACY_STORE)) db.deleteObjectStore(LEGACY_STORE);
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE).createIndex('t', 't');
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { db.close(); dbPromise = null; };
                resolve(db);
            };
            request.onerror = () => reject(request.error ?? new Error('Could not open thumbnail cache'));
            request.onblocked = () => reject(new Error('Thumbnail cache upgrade blocked'));
        }).catch(error => {
            dbPromise = null;
            throw error;
        });
    }
    return dbPromise;
}

const wrap = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

async function dbGet(key) {
    try {
        const db = await openDB();
        const row = await wrap(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
        return row?.blob instanceof Blob ? { blob: row.blob, v: row.v ?? null } : null;
    } catch {
        return null;
    }
}

async function dbPut(key, blob, v) {
    try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({ blob, v: v ?? null, t: Date.now() }, key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('aborted'));
        });
        if (++writesSincePrune >= PRUNE_EVERY_WRITES) {
            writesSincePrune = 0;
            void prune();
        }
    } catch (error) {
        console.debug('[Gallery++] Could not persist thumbnail:', error);
    }
}

/** Evicts the oldest rows once the store grows beyond MAX_DB_ENTRIES. */
async function prune() {
    try {
        const db = await openDB();
        const count = await wrap(db.transaction(STORE, 'readonly').objectStore(STORE).count());
        if (count <= MAX_DB_ENTRIES) return;
        let toDelete = count - Math.floor(MAX_DB_ENTRIES * 0.9);
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const cursorRequest = tx.objectStore(STORE).index('t').openCursor();
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (cursor && toDelete-- > 0) {
                    cursor.delete();
                    cursor.continue();
                }
            };
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (error) {
        console.debug('[Gallery++] Thumbnail cache prune skipped:', error);
    }
}

// ----------------------------------------------------------------------------- job queue

/**
 * @template T
 * @param {() => Promise<T>} task
 * @param {AbortSignal} [signal]
 * @returns {Promise<T|null>} Resolves null when cancelled before it started.
 */
function enqueue(task, signal) {
    return new Promise((resolve, reject) => {
        const job = {
            signal,
            cancel: () => resolve(null),
            run: () => task().then(resolve, reject),
        };
        queue.push(job);
        pump();
    });
}

function pump() {
    while (active < CONCURRENCY && queue.length > 0) {
        const job = queue.shift();
        if (job.signal?.aborted) {
            job.cancel();
            continue;
        }
        active++;
        job.run().finally(() => {
            active--;
            pump();
        });
    }
}

// ------------------------------------------------------------------------ change detection

/**
 * Asks the server what version of a file is current. Resolves null when it cannot be told (network error,
 * missing validators), in which case the cached thumbnail is simply trusted.
 * Results are shared between callers and reused for SIGNATURE_TTL_MS.
 * @param {string} src
 * @returns {Promise<string|null>}
 */
function currentSignature(src) {
    const known = signatures.get(src);
    if (known && Date.now() - known.time < SIGNATURE_TTL_MS) return Promise.resolve(known.sig);
    let promise = signatureInFlight.get(src);
    if (!promise) {
        promise = (async () => {
            try {
                // `no-cache` forces revalidation, so a stale HTTP-cache entry can't hide a change.
                const response = await fetch(src, { method: 'HEAD', credentials: 'same-origin', cache: 'no-cache' });
                if (!response.ok) return null;
                const h = response.headers;
                const parts = [h.get('etag'), h.get('last-modified'), h.get('content-length')];
                return parts.some(Boolean) ? parts.map(p => p ?? '').join('|') : null;
            } catch {
                return null;
            }
        })().then(sig => {
            if (sig !== null) signatures.set(src, { sig, time: Date.now() });
            return sig;
        }).finally(() => signatureInFlight.delete(src));
        signatureInFlight.set(src, promise);
    }
    return promise;
}

/** A cached entry is current unless the server reports a different (or, for old rows, an unknown) version. */
const isCurrent = (entry, sig) => sig === null || entry.v === sig;

/** Forgets checked signatures, so the next lookups re-verify against the server (e.g. when a folder is (re)opened). */
export function invalidateThumbnailChecks() {
    signatures.clear();
}

// ----------------------------------------------------------------------------- generation

async function decode(blob) {
    if (typeof createImageBitmap === 'function') {
        try {
            return { source: await createImageBitmap(blob), width: 0, height: 0, dispose() { this.source.close?.(); } };
        } catch {
            // e.g. SVG in some browsers: fall through to <img> decoding.
        }
    }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
        await img.decode();
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
    return { source: img, dispose() { URL.revokeObjectURL(url); } };
}

async function canvasToWebp(canvas) {
    if (typeof canvas.convertToBlob === 'function') {
        return canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
    }
    return new Promise((resolve, reject) => {
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('WebP encoding failed'))), 'image/webp', WEBP_QUALITY);
    });
}

async function renderImageThumbnail(src, bucket, signal) {
    const response = await fetch(src, { credentials: 'same-origin', cache: 'no-cache', signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const original = await response.blob();
    const decoded = await decode(original);
    try {
        const source = decoded.source;
        const w = source.width ?? source.naturalWidth;
        const h = source.height ?? source.naturalHeight;
        if (!w || !h) return null;
        const scale = Math.min(1, bucket / Math.max(w, h));
        const tw = Math.max(1, Math.round(w * scale));
        const th = Math.max(1, Math.round(h * scale));
        const canvas = typeof OffscreenCanvas === 'function'
            ? new OffscreenCanvas(tw, th)
            : Object.assign(document.createElement('canvas'), { width: tw, height: th });
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2D canvas unavailable');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, tw, th);
        return await canvasToWebp(canvas);
    } finally {
        decoded.dispose();
    }
}

async function renderVideoThumbnail(src, bucket) {
    const dataUrl = await Promise.race([
        getVideoThumbnail(src, bucket, bucket, 'image/webp'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Video thumbnail timed out')), VIDEO_TIMEOUT_MS)),
    ]);
    if (!dataUrl) return null;
    return (await fetch(dataUrl)).blob();
}

// ---------------------------------------------------------------------------------- public

/**
 * Synchronous memory-only lookup, so cached pages paint instantly.
 * @param {string} src @param {number} bucket
 * @returns {Blob|null}
 */
export function peekThumbnail(src, bucket) {
    const key = keyOf(src, bucket);
    const hit = memory.get(key);
    if (hit) remember(key, hit.blob, hit.v);
    return hit?.blob ?? null;
}

/**
 * Whether the thumbnail for this file was already checked against the server recently, i.e. whether
 * a synchronous {@link peekThumbnail} hit can be trusted without another look.
 * @param {string} src @param {number} bucket
 */
export function isThumbnailVerified(src, bucket) {
    const entry = memory.get(keyOf(src, bucket));
    const known = signatures.get(src);
    return !!entry && !!known && Date.now() - known.time < SIGNATURE_TTL_MS && entry.v === known.sig;
}

/**
 * Gets (from memory → IndexedDB → freshly generated) a thumbnail blob.
 * Resolves null if cancelled, undecodable, or unavailable.
 * @param {string} src Fetchable URL of the full-size media
 * @param {{video: boolean, bucket: number, signal?: AbortSignal}} options
 * @returns {Promise<Blob|null>}
 */
export async function getThumbnail(src, { video, bucket, signal }) {
    const key = keyOf(src, bucket);

    const cached = memory.get(key) ?? await dbGet(key);
    if (cached) {
        const sig = await currentSignature(src);
        if (isCurrent(cached, sig)) {
            remember(key, cached.blob, cached.v);
            return cached.blob;
        }
        // The file changed on the server: drop the stale thumbnail and fall through to regenerate it.
        memory.delete(key);
    }
    if (signal?.aborted) return null;

    let promise = inFlight.get(key);
    if (!promise) {
        promise = enqueue(async () => {
            const sig = await currentSignature(src);
            const blob = video
                ? await renderVideoThumbnail(src, bucket)
                : await renderImageThumbnail(src, bucket, signal);
            if (blob) {
                remember(key, blob, sig);
                await dbPut(key, blob, sig);
            }
            return blob;
        }, signal)
            .catch(error => {
                if (error?.name !== 'AbortError') console.debug(`[Gallery++] Thumbnail failed for ${src}:`, error);
                return null;
            })
            .finally(() => inFlight.delete(key));
        inFlight.set(key, promise);
    }
    return promise;
}

/** Removes every cached size of one file (after it was deleted). */
export async function purgeThumbnail(src) {
    signatures.delete(src);
    for (const key of [...memory.keys()]) {
        if (key.startsWith(`${src}|`)) memory.delete(key);
    }
    try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(IDBKeyRange.bound(`${src}|`, `${src}|\uffff`));
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (error) {
        console.debug('[Gallery++] Could not purge thumbnail:', error);
    }
}

/** Removes every cached size of many files at once (one transaction). Used by the refresh button. */
export async function purgeThumbnails(srcs) {
    const list = [...new Set(srcs)];
    for (const src of list) signatures.delete(src);
    const prefixes = list.map(src => `${src}|`);
    for (const key of [...memory.keys()]) {
        if (prefixes.some(prefix => key.startsWith(prefix))) memory.delete(key);
    }
    if (list.length === 0) return;
    try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            for (const src of list) store.delete(IDBKeyRange.bound(`${src}|`, `${src}|\uffff`));
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('aborted'));
        });
    } catch (error) {
        console.debug('[Gallery++] Could not purge thumbnails:', error);
    }
}

/** Empties both cache layers. Returns the number of persisted entries removed. */
export async function clearThumbnailCache() {
    memory.clear();
    signatures.clear();
    try {
        const db = await openDB();
        const count = await wrap(db.transaction(STORE, 'readonly').objectStore(STORE).count());
        await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
        return count;
    } catch {
        return 0;
    }
}
