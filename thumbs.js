/*
 * Gallery++ — thumbnail service.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * - Thumbnails are small WebP blobs persisted in IndexedDB along with original {w, h} dimensions
 *   and a server version signature (ETag / Last-Modified / Content-Length).
 * - Image fetch, decoding, resizing, and WebP encoding run off the main thread in a lightweight
 *   Web Worker that auto-terminates after an idle period (with transparent main-thread fallback).
 * - IndexedDB reads are batched per page (one transaction) and writes are coalesced into periodic
 *   batch transactions. Cache pruning uses a key-only cursor so evicted blobs are never loaded into RAM.
 * - Cached hits paint immediately (stale-while-revalidate) while throttled, abortable HEAD requests
 *   verify freshness in the background; cache misses extract the signature directly from GET headers.
 * - In-flight jobs use caller ref-counting so aborting one caller never breaks another waiting caller.
 */

import { getVideoThumbnail } from '../../../utils.js';
import { THUMB_BUCKETS, parseImageDimensions } from './lib.js';

const DB_NAME = 'ST_Gallery_Cache';
const DB_VERSION = 2;
const STORE = 'thumbs2';
const LEGACY_STORE = 'thumbnails'; // v1 stored bulky data-URL strings; dropped on upgrade
const MAX_DB_ENTRIES = 4000;
const PRUNE_EVERY_WRITES = 40;
const MEMORY_LIMIT = 400;
const OBJECT_URL_LIMIT = 200; // > max pageSize (12x12 = 144), so active page + previous page stay hot
const CONCURRENCY = 3;
const HEAD_CONCURRENCY = 4;
const VIDEO_TIMEOUT_MS = 15_000;
const WEBP_QUALITY = 0.76;
const SIGNATURE_TTL_MS = 30_000;
const LRU_TOUCH_MS = 24 * 60 * 60 * 1000;
const PUT_FLUSH_MS = 180;
const PUT_FLUSH_BATCH = 24;
const WORKER_IDLE_MS = 60_000;
const PROBE_MAX_BYTES = 65_536;

/**
 * @typedef {{blob: Blob, v: string|null, w: number, h: number, objectUrl: string|null}} MemoryEntry
 * @typedef {{url: string, blob: Blob, w: number, h: number, verified: boolean}} ThumbnailHit
 */

/** @type {Map<string, MemoryEntry>} insertion-ordered LRU */
const memory = new Map();
/** @type {Set<string>} insertion-ordered LRU of keys currently holding a live blob: objectUrl */
const liveObjectUrls = new Set();
/** @type {Map<string, {sig: string|null, time: number}>} last server signature seen per file URL */
const signatures = new Map();
/** @type {Map<string, RefCountedJob<string|null>>} */
const signatureInFlight = new Map();
/** @type {Map<string, RefCountedJob<ThumbnailHit|null>>} */
const renderInFlight = new Map();
/** @type {Map<string, {blob: Blob, v: string|null, w: number, h: number, t: number}>} */
const pendingPuts = new Map();

let putFlushTimer = 0;
let writesSincePrune = 0;
let pruning = false;
let cacheEpoch = 0;
/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

const keyOf = (src, bucket) => `${src}|${bucket}`;

/** Returns candidate buckets >= requested bucket, exact match first, ascending. */
function candidateBuckets(bucket) {
    const list = [];
    if (!THUMB_BUCKETS.includes(bucket)) list.push(bucket);
    for (const b of THUMB_BUCKETS) {
        if (b >= bucket) list.push(b);
    }
    return list;
}

function revokeKeyUrl(key, entry) {
    if (entry?.objectUrl) {
        URL.revokeObjectURL(entry.objectUrl);
        entry.objectUrl = null;
    }
    liveObjectUrls.delete(key);
}

function ensureObjectUrl(key, entry) {
    if (!entry.objectUrl) {
        entry.objectUrl = URL.createObjectURL(entry.blob);
    }
    liveObjectUrls.delete(key);
    liveObjectUrls.add(key);
    while (liveObjectUrls.size > OBJECT_URL_LIMIT) {
        const oldestKey = liveObjectUrls.values().next().value;
        liveObjectUrls.delete(oldestKey);
        const oldest = memory.get(oldestKey);
        if (oldest?.objectUrl) {
            URL.revokeObjectURL(oldest.objectUrl);
            oldest.objectUrl = null;
        }
    }
    return entry.objectUrl;
}

function remember(key, blob, v = null, w = 0, h = 0) {
    const prev = memory.get(key);
    let objectUrl = null;
    if (prev) {
        if (prev.blob === blob) objectUrl = prev.objectUrl;
        else revokeKeyUrl(key, prev);
        memory.delete(key);
    }
    const entry = { blob, v, w: w || prev?.w || 0, h: h || prev?.h || 0, objectUrl };
    memory.set(key, entry);
    while (memory.size > MEMORY_LIMIT) {
        const oldestKey = memory.keys().next().value;
        const oldest = memory.get(oldestKey);
        revokeKeyUrl(oldestKey, oldest);
        memory.delete(oldestKey);
    }
    return entry;
}

function findInMemory(src, bucket) {
    for (const b of candidateBuckets(bucket)) {
        const key = keyOf(src, b);
        const entry = memory.get(key);
        if (entry) return { key, entry };
    }
    return null;
}

function isSignatureFresh(src, entry) {
    const known = signatures.get(src);
    return !!known && Date.now() - known.time < SIGNATURE_TTL_MS && (known.sig === null || entry.v === known.sig);
}

function toHit(src, key, entry) {
    return {
        url: ensureObjectUrl(key, entry),
        blob: entry.blob,
        w: entry.w,
        h: entry.h,
        verified: isSignatureFresh(src, entry),
    };
}

function extractSignature(headers) {
    const parts = [headers.get('etag'), headers.get('last-modified'), headers.get('content-length')];
    return parts.some(Boolean) ? parts.map(p => p ?? '').join('|') : null;
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

function scheduleDbPut(key, blob, v, w = 0, h = 0) {
    pendingPuts.set(key, { blob, v: v ?? null, w: w || 0, h: h || 0, t: Date.now() });
    if (pendingPuts.size >= PUT_FLUSH_BATCH) {
        clearTimeout(putFlushTimer);
        putFlushTimer = 0;
        void flushDbPuts();
    } else if (!putFlushTimer) {
        putFlushTimer = setTimeout(() => {
            putFlushTimer = 0;
            void flushDbPuts();
        }, PUT_FLUSH_MS);
    }
}

async function flushDbPuts() {
    if (pendingPuts.size === 0) return;
    const epoch = cacheEpoch;
    const batch = [...pendingPuts.entries()];
    pendingPuts.clear();
    try {
        const db = await openDB();
        if (epoch !== cacheEpoch) return;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            for (const [key, row] of batch) store.put(row, key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('aborted'));
        });
        writesSincePrune += batch.length;
        if (writesSincePrune >= PRUNE_EVERY_WRITES) {
            writesSincePrune = 0;
            void prune();
        }
    } catch (error) {
        if (error?.name === 'QuotaExceededError') {
            void prune(0.6);
        } else {
            console.debug('[Gallery++] Could not persist thumbnails:', error);
        }
    }
}

/** Evicts the oldest rows once the store grows beyond MAX_DB_ENTRIES using a key-only cursor (zero blobs loaded). */
async function prune(keepRatio = 0.9) {
    if (pruning) return;
    pruning = true;
    try {
        const db = await openDB();
        const count = await wrap(db.transaction(STORE, 'readonly').objectStore(STORE).count());
        const target = Math.floor(MAX_DB_ENTRIES * keepRatio);
        if (keepRatio >= 0.9 && count <= MAX_DB_ENTRIES) return;
        let toDelete = Math.max(0, count - target);
        if (toDelete <= 0) return;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const cursorRequest = store.index('t').openKeyCursor();
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (cursor && toDelete-- > 0) {
                    store.delete(cursor.primaryKey);
                    cursor.continue();
                }
            };
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('aborted'));
        });
    } catch (error) {
        console.debug('[Gallery++] Thumbnail cache prune skipped:', error);
    } finally {
        pruning = false;
    }
}

async function dbGetBest(src, bucket) {
    try {
        const db = await openDB();
        const buckets = candidateBuckets(bucket);
        const rows = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const store = tx.objectStore(STORE);
            const found = new Array(buckets.length);
            buckets.forEach((b, i) => {
                const req = store.get(keyOf(src, b));
                req.onsuccess = () => { found[i] = req.result; };
            });
            tx.oncomplete = () => resolve(found);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('aborted'));
        });
        for (let i = 0; i < buckets.length; i++) {
            const row = rows[i];
            if (row?.blob instanceof Blob) {
                return { key: keyOf(src, buckets[i]), row };
            }
        }
        return null;
    } catch {
        return null;
    }
}

// ----------------------------------------------------------------------------- priority queues & ref-counted jobs

function createQueue(concurrency) {
    /** @type {Array<{run: () => Promise<void>, priority: number, cleanup: () => void}>} */
    const queue = [];
    let active = 0;

    function pump() {
        while (active < concurrency && queue.length > 0) {
            const job = queue.shift();
            job.cleanup();
            active++;
            job.run().finally(() => {
                active--;
                pump();
            });
        }
    }

    /**
     * @template T
     * @param {() => Promise<T>} task
     * @param {{signal?: AbortSignal, priority?: number}} [options]
     * @returns {Promise<T|null>}
     */
    function enqueue(task, { signal, priority = 0 } = {}) {
        if (signal?.aborted) return Promise.resolve(null);
        return new Promise((resolve, reject) => {
            let removed = false;
            const onAbort = () => {
                if (removed) return;
                removed = true;
                const idx = queue.indexOf(job);
                if (idx >= 0) queue.splice(idx, 1);
                resolve(null);
            };
            const cleanup = () => {
                removed = true;
                signal?.removeEventListener('abort', onAbort);
            };
            const job = {
                priority,
                cleanup,
                run: () => (signal?.aborted ? Promise.resolve(null) : task()).then(resolve, reject),
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            // Insert ahead of lower-priority queued items while keeping FIFO within the same priority.
            let insertAt = queue.length;
            while (insertAt > 0 && queue[insertAt - 1].priority < priority) insertAt--;
            queue.splice(insertAt, 0, job);
            pump();
        });
    }

    return { enqueue };
}

const renderQueue = createQueue(CONCURRENCY);
const headQueue = createQueue(HEAD_CONCURRENCY);

/**
 * @template T
 * @typedef {{ctl: AbortController, waiters: number, promise: Promise<T>}} RefCountedJob
 */

/**
 * Deduplicates async work by key while keeping every caller's AbortSignal isolated.
 * The underlying job is aborted only when *all* attached callers have aborted.
 * @template T
 * @param {Map<string, RefCountedJob<T>>} map
 * @param {string} key
 * @param {(signal: AbortSignal) => Promise<T>} factory
 * @param {AbortSignal} [signal]
 * @returns {Promise<T|null>}
 */
function attachJob(map, key, factory, signal) {
    if (signal?.aborted) return Promise.resolve(null);
    let job = map.get(key);
    if (!job) {
        const ctl = new AbortController();
        job = { ctl, waiters: 0, promise: null };
        map.set(key, job);
        job.promise = Promise.resolve()
            .then(() => factory(ctl.signal))
            .finally(() => {
                if (map.get(key) === job) map.delete(key);
            });
    }
    job.waiters++;

    return new Promise((resolve) => {
        let settled = false;
        const release = (aborted) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            if (aborted) {
                job.waiters--;
                if (job.waiters <= 0) {
                    if (map.get(key) === job) map.delete(key);
                    job.ctl.abort();
                }
                resolve(null);
            }
        };
        const onAbort = () => release(true);
        signal?.addEventListener('abort', onAbort, { once: true });

        job.promise.then(
            (value) => {
                if (settled) return;
                release(false);
                resolve(value);
            },
            () => {
                if (settled) return;
                release(false);
                resolve(null);
            },
        );
    });
}

// ------------------------------------------------------------------------ change detection

/**
 * Asks the server what version of a file is current (throttled & abortable).
 * Resolves null when it cannot be told (network error, missing validators), in which case
 * the cached thumbnail is trusted.
 * @param {string} src
 * @param {AbortSignal} [signal]
 * @returns {Promise<string|null>}
 */
function currentSignature(src, signal) {
    const known = signatures.get(src);
    if (known && Date.now() - known.time < SIGNATURE_TTL_MS) return Promise.resolve(known.sig);

    return attachJob(signatureInFlight, src, (jobSignal) => headQueue.enqueue(async () => {
        try {
            // `no-cache` forces revalidation, so a stale HTTP-cache entry cannot hide a change.
            const response = await fetch(src, { method: 'HEAD', credentials: 'same-origin', cache: 'no-cache', signal: jobSignal });
            if (!response.ok) return null;
            const sig = extractSignature(response.headers);
            if (sig !== null) signatures.set(src, { sig, time: Date.now() });
            return sig;
        } catch {
            return null;
        }
    }, { signal: jobSignal }), signal);
}

/** A cached entry is current unless the server reports a different (or, for old rows, an unknown) version. */
const isCurrent = (entry, sig) => sig === null || entry.v === sig;

/** Forgets checked signatures so the next lookups re-verify against the server. */
export function invalidateThumbnailChecks() {
    signatures.clear();
}

// ----------------------------------------------------------------------------- Web Worker encoder

const WORKER_SOURCE = `
const controllers = new Map();
function extractSig(headers) {
    const parts = [headers.get('etag'), headers.get('last-modified'), headers.get('content-length')];
    return parts.some(Boolean) ? parts.map(p => p ?? '').join('|') : null;
}
self.onmessage = async (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'abort') {
        const ctl = controllers.get(msg.id);
        if (ctl) { ctl.abort(); controllers.delete(msg.id); }
        return;
    }
    if (msg.type !== 'render') return;
    const { id, url, bucket, quality } = msg;
    const ctl = new AbortController();
    controllers.set(id, ctl);
    try {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-cache', signal: ctl.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const sig = extractSig(response.headers);
        const original = await response.blob();
        if (ctl.signal.aborted) { self.postMessage({ id, ok: false, aborted: true }); return; }
        let bitmap;
        try {
            bitmap = await createImageBitmap(original);
        } catch {
            self.postMessage({ id, ok: false, fallback: true, original, sig });
            return;
        }
        try {
            const w = bitmap.width;
            const h = bitmap.height;
            if (!w || !h) { self.postMessage({ id, ok: true, blob: null, w: 0, h: 0, sig }); return; }
            const scale = Math.min(1, bucket / Math.max(w, h));
            if (scale === 1 && original.type === 'image/webp' && original.size <= 65536) {
                self.postMessage({ id, ok: true, blob: original, w, h, sig });
                return;
            }
            const tw = Math.max(1, Math.round(w * scale));
            const th = Math.max(1, Math.round(h * scale));
            const canvas = new OffscreenCanvas(tw, th);
            const ctx = canvas.getContext('2d');
            if (!ctx) { self.postMessage({ id, ok: false, fallback: true, original, sig }); return; }
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bitmap, 0, 0, tw, th);
            if (ctl.signal.aborted) { self.postMessage({ id, ok: false, aborted: true }); return; }
            const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
            if (ctl.signal.aborted) { self.postMessage({ id, ok: false, aborted: true }); return; }
            self.postMessage({ id, ok: true, blob, w, h, sig });
        } finally {
            bitmap.close();
        }
    } catch (error) {
        const aborted = ctl.signal.aborted || error?.name === 'AbortError';
        self.postMessage({ id, ok: false, aborted, message: error?.message ?? String(error) });
    } finally {
        controllers.delete(id);
    }
};
`;

let workerUnsupported = typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function';
/** @type {Worker|null} */
let worker = null;
/** @type {string|null} */
let workerScriptUrl = null;
let workerNextId = 1;
let workerIdleTimer = 0;
/** @type {Map<number, {resolve: (v: any) => void, reject: (e: any) => void}>} */
const workerPending = new Map();

function terminateWorker() {
    clearTimeout(workerIdleTimer);
    workerIdleTimer = 0;
    if (worker) {
        worker.terminate();
        worker = null;
    }
    if (workerScriptUrl) {
        URL.revokeObjectURL(workerScriptUrl);
        workerScriptUrl = null;
    }
    for (const pending of workerPending.values()) pending.reject(new Error('Worker terminated'));
    workerPending.clear();
}

function scheduleWorkerIdle() {
    clearTimeout(workerIdleTimer);
    if (workerPending.size > 0 || !worker) return;
    workerIdleTimer = setTimeout(() => {
        if (workerPending.size === 0) terminateWorker();
    }, WORKER_IDLE_MS);
}

function getWorker() {
    if (workerUnsupported) return null;
    if (!worker) {
        try {
            workerScriptUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
            worker = new Worker(workerScriptUrl);
            worker.onmessage = (event) => {
                const msg = event.data;
                if (!msg) return;
                const entry = workerPending.get(msg.id);
                if (!entry) return;
                workerPending.delete(msg.id);
                entry.resolve(msg);
                scheduleWorkerIdle();
            };
            worker.onerror = () => {
                workerUnsupported = true;
                terminateWorker();
            };
        } catch {
            workerUnsupported = true;
            terminateWorker();
            return null;
        }
    }
    clearTimeout(workerIdleTimer);
    return worker;
}

function resolveAbsoluteUrl(src) {
    try {
        const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : globalThis.location?.href;
        return base ? new URL(src, base).href : src;
    } catch {
        return src;
    }
}

async function encodeBlobOnMainThread(original, bucket, signal) {
    if (signal?.aborted) return null;
    let source;
    let dispose;
    if (typeof createImageBitmap === 'function') {
        try {
            source = await createImageBitmap(original);
            dispose = () => source.close?.();
        } catch { /* SVG or unsupported bitmap: fall through to <img> */ }
    }
    if (!source) {
        const url = URL.createObjectURL(original);
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        try {
            await img.decode();
        } catch (error) {
            URL.revokeObjectURL(url);
            throw error;
        }
        source = img;
        dispose = () => URL.revokeObjectURL(url);
    }
    try {
        if (signal?.aborted) return null;
        const w = source.width ?? source.naturalWidth;
        const h = source.height ?? source.naturalHeight;
        if (!w || !h) return { blob: null, w: 0, h: 0 };
        const scale = Math.min(1, bucket / Math.max(w, h));
        if (scale === 1 && original.type === 'image/webp' && original.size <= 65_536) {
            return { blob: original, w, h };
        }
        const tw = Math.max(1, Math.round(w * scale));
        const th = Math.max(1, Math.round(h * scale));
        const canvas = typeof OffscreenCanvas === 'function'
            ? new OffscreenCanvas(tw, th)
            : Object.assign(document.createElement('canvas'), { width: tw, height: th });
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2D canvas unavailable');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, tw, th);
        if (signal?.aborted) return null;
        const blob = typeof canvas.convertToBlob === 'function'
            ? await canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY })
            : await new Promise((resolve, reject) => {
                canvas.toBlob(b => (b ? resolve(b) : reject(new Error('WebP encoding failed'))), 'image/webp', WEBP_QUALITY);
            });
        return { blob, w, h };
    } finally {
        dispose();
    }
}

async function renderImageThumbnail(src, bucket, signal) {
    const w = getWorker();
    if (w) {
        const id = workerNextId++;
        const url = resolveAbsoluteUrl(src);
        try {
            const msg = await new Promise((resolve, reject) => {
                const onAbort = () => {
                    workerPending.delete(id);
                    try { w.postMessage({ type: 'abort', id }); } catch { /* ignore */ }
                    resolve({ ok: false, aborted: true });
                    scheduleWorkerIdle();
                };
                if (signal?.aborted) { resolve({ ok: false, aborted: true }); return; }
                signal?.addEventListener('abort', onAbort, { once: true });
                workerPending.set(id, {
                    resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
                    reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
                });
                w.postMessage({ type: 'render', id, url, bucket, quality: WEBP_QUALITY });
            });
            if (msg.aborted || signal?.aborted) return null;
            if (msg.ok) return { blob: msg.blob, w: msg.w, h: msg.h, sig: msg.sig ?? null };
            if (msg.fallback && msg.original instanceof Blob) {
                const res = await encodeBlobOnMainThread(msg.original, bucket, signal);
                return res ? { ...res, sig: msg.sig ?? null } : null;
            }
            throw new Error(msg.message || 'Worker thumbnail render failed');
        } catch (error) {
            if (!workerUnsupported) throw error;
            // Worker failed to initialize / crashed: fall through to main thread.
        }
    }

    const response = await fetch(src, { credentials: 'same-origin', cache: 'no-cache', signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const sig = extractSignature(response.headers);
    const original = await response.blob();
    if (signal?.aborted) return null;
    const res = await encodeBlobOnMainThread(original, bucket, signal);
    return res ? { ...res, sig } : null;
}

async function renderVideoThumbnail(src, bucket, signal) {
    if (signal?.aborted) return null;
    const sig = await currentSignature(src, signal);
    if (signal?.aborted) return null;
    let timer = 0;
    try {
        const dataUrl = await Promise.race([
            getVideoThumbnail(src, bucket, bucket, 'image/webp'),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Video thumbnail timed out')), VIDEO_TIMEOUT_MS); }),
        ]);
        if (!dataUrl || signal?.aborted) return null;
        const blob = await (await fetch(dataUrl)).blob();
        return { blob, w: 0, h: 0, sig };
    } finally {
        clearTimeout(timer);
    }
}

async function generateAndStore(src, { video, bucket, signal, priority = 1 }) {
    const key = keyOf(src, bucket);
    const epoch = cacheEpoch;

    return attachJob(renderInFlight, key, (jobSignal) => renderQueue.enqueue(async () => {
        try {
            const result = video
                ? await renderVideoThumbnail(src, bucket, jobSignal)
                : await renderImageThumbnail(src, bucket, jobSignal);
            if (!result?.blob || jobSignal.aborted) return null;
            if (result.sig !== null) signatures.set(src, { sig: result.sig, time: Date.now() });
            if (epoch !== cacheEpoch) return null; // purged or cleared while generating
            const entry = remember(key, result.blob, result.sig, result.w, result.h);
            scheduleDbPut(key, result.blob, result.sig, result.w, result.h);
            return toHit(src, key, entry);
        } catch (error) {
            if (error?.name !== 'AbortError' && !jobSignal.aborted) {
                console.debug(`[Gallery++] Thumbnail failed for ${src}:`, error);
            }
            return null;
        }
    }, { signal: jobSignal, priority }), signal);
}

// ---------------------------------------------------------------------------------- public

/**
 * Synchronous memory-only lookup (reuses any larger cached bucket).
 * @param {string} src @param {number} bucket
 * @returns {ThumbnailHit|null}
 */
export function peekThumbnail(src, bucket) {
    const found = findInMemory(src, bucket);
    if (!found) return null;
    const entry = remember(found.key, found.entry.blob, found.entry.v, found.entry.w, found.entry.h);
    return toHit(src, found.key, entry);
}

/**
 * Synchronous dimension lookup from memory cache (any bucket).
 * @param {string} src
 * @returns {{w: number, h: number}|null}
 */
export function peekDimensions(src) {
    for (const b of THUMB_BUCKETS) {
        const entry = memory.get(keyOf(src, b));
        if (entry && entry.w > 0 && entry.h > 0) return { w: entry.w, h: entry.h };
    }
    return null;
}

/**
 * Reads an entire page of misses from IndexedDB in a single readonly transaction so cached
 * thumbnails paint immediately (before any background server revalidation).
 * @param {string[]} srcs
 * @param {number} bucket
 * @returns {Promise<Map<string, ThumbnailHit>>}
 */
export async function prefetchPageFromDB(srcs, bucket) {
    const hits = new Map();
    if (!srcs.length) return hits;
    const epoch = cacheEpoch;
    const buckets = candidateBuckets(bucket);
    try {
        const db = await openDB();
        if (epoch !== cacheEpoch) return hits;
        const raw = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const store = tx.objectStore(STORE);
            const results = new Map();
            for (const src of srcs) {
                const arr = new Array(buckets.length);
                results.set(src, arr);
                buckets.forEach((b, i) => {
                    const req = store.get(keyOf(src, b));
                    req.onsuccess = () => { arr[i] = req.result; };
                });
            }
            tx.oncomplete = () => resolve(results);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('aborted'));
        });
        if (epoch !== cacheEpoch) return hits;
        const now = Date.now();
        for (const [src, arr] of raw) {
            for (let i = 0; i < buckets.length; i++) {
                const row = arr[i];
                if (row?.blob instanceof Blob) {
                    const key = keyOf(src, buckets[i]);
                    const entry = remember(key, row.blob, row.v ?? null, row.w || 0, row.h || 0);
                    hits.set(src, toHit(src, key, entry));
                    // Lazy LRU timestamp refresh (at most once per day per item).
                    if (!row.t || now - row.t > LRU_TOUCH_MS) {
                        scheduleDbPut(key, row.blob, row.v ?? null, row.w || 0, row.h || 0);
                    }
                    break;
                }
            }
        }
    } catch { /* IndexedDB unavailable: fall through to generation */ }
    return hits;
}

/**
 * Checks whether an already-displayed cached thumbnail is still current on the server.
 * Returns a fresh ThumbnailHit only if the file changed and had to be regenerated; otherwise null.
 * @param {string} src
 * @param {{video: boolean, bucket: number, signal?: AbortSignal}} options
 * @returns {Promise<ThumbnailHit|null>}
 */
export async function revalidateThumbnail(src, { video, bucket, signal }) {
    if (signal?.aborted) return null;
    const found = findInMemory(src, bucket);
    if (!found) return getThumbnail(src, { video, bucket, signal });
    if (isSignatureFresh(src, found.entry)) return null;

    const sig = await currentSignature(src, signal);
    if (signal?.aborted) return null;
    if (isCurrent(found.entry, sig)) return null;

    // File changed on the server: evict stale entry and regenerate.
    revokeKeyUrl(found.key, found.entry);
    memory.delete(found.key);
    pendingPuts.delete(found.key);
    return generateAndStore(src, { video, bucket, signal, priority: 1 });
}

/**
 * Gets (from memory → IndexedDB → freshly generated) a thumbnail hit.
 * Resolves null if cancelled, undecodable, or unavailable.
 * @param {string} src Fetchable URL of the full-size media
 * @param {{video: boolean, bucket: number, signal?: AbortSignal, priority?: number, skipCache?: boolean}} options
 * @returns {Promise<ThumbnailHit|null>}
 */
export async function getThumbnail(src, { video, bucket, signal, priority = 1, skipCache = false }) {
    if (signal?.aborted) return null;
    if (!skipCache) {
        const mem = findInMemory(src, bucket);
        if (mem) {
            const entry = remember(mem.key, mem.entry.blob, mem.entry.v, mem.entry.w, mem.entry.h);
            return toHit(src, mem.key, entry);
        }
        const epoch = cacheEpoch;
        const fromDb = await dbGetBest(src, bucket);
        if (signal?.aborted) return null;
        if (fromDb && epoch === cacheEpoch) {
            const { key, row } = fromDb;
            const entry = remember(key, row.blob, row.v ?? null, row.w || 0, row.h || 0);
            if (!row.t || Date.now() - row.t > LRU_TOUCH_MS) {
                scheduleDbPut(key, row.blob, row.v ?? null, row.w || 0, row.h || 0);
            }
            return toHit(src, key, entry);
        }
    }
    return generateAndStore(src, { video, bucket, signal, priority });
}

/**
 * Fast, low-bandwidth image dimension probe for aspect-ratio detection.
 * Checks memory cache first; otherwise reads only the leading header bytes (Range <= 64 KB)
 * and cancels the stream immediately once dimensions are parsed.
 * @param {string} src
 * @param {AbortSignal} [signal]
 * @returns {Promise<{w: number, h: number}|null>}
 */
export async function probeImageDimensions(src, signal) {
    const cached = peekDimensions(src);
    if (cached) return cached;
    if (signal?.aborted) return null;

    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        const response = await fetch(src, {
            credentials: 'same-origin',
            headers: { Range: `bytes=0-${PROBE_MAX_BYTES - 1}` },
            signal: ctl.signal,
        });
        if (!response.ok) return null;

        if (!response.body || typeof response.body.getReader !== 'function') {
            if (response.status !== 206) return null; // avoid reading a full un-ranged body
            const buf = new Uint8Array(await response.arrayBuffer());
            return parseImageDimensions(buf);
        }

        const reader = response.body.getReader();
        const combined = new Uint8Array(PROBE_MAX_BYTES);
        let offset = 0;
        try {
            while (offset < PROBE_MAX_BYTES) {
                const { done, value } = await reader.read();
                if (done || !value) break;
                const copyLen = Math.min(value.byteLength, PROBE_MAX_BYTES - offset);
                combined.set(value.subarray(0, copyLen), offset);
                offset += copyLen;
                const dims = parseImageDimensions(combined.subarray(0, offset));
                if (dims) return dims;
            }
            return parseImageDimensions(combined.subarray(0, offset));
        } finally {
            reader.cancel().catch(() => {});
        }
    } catch {
        return null;
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}

/** Removes every cached size of one file (after it was deleted). */
export async function purgeThumbnail(src) {
    cacheEpoch++;
    signatures.delete(src);
    const prefix = `${src}|`;
    for (const [key, entry] of [...memory.entries()]) {
        if (key.startsWith(prefix)) {
            revokeKeyUrl(key, entry);
            memory.delete(key);
        }
    }
    for (const key of [...pendingPuts.keys()]) {
        if (key.startsWith(prefix)) pendingPuts.delete(key);
    }
    try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (error) {
        console.debug('[Gallery++] Could not purge thumbnail:', error);
    }
}

/** Removes every cached size of every file under a folder URL prefix (single IDB range delete). */
export async function purgeFolderThumbnails(folderUrlPrefix) {
    if (!folderUrlPrefix) return;
    cacheEpoch++;
    for (const src of [...signatures.keys()]) {
        if (src.startsWith(folderUrlPrefix)) signatures.delete(src);
    }
    for (const [key, entry] of [...memory.entries()]) {
        if (key.startsWith(folderUrlPrefix)) {
            revokeKeyUrl(key, entry);
            memory.delete(key);
        }
    }
    for (const key of [...pendingPuts.keys()]) {
        if (key.startsWith(folderUrlPrefix)) pendingPuts.delete(key);
    }
    try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(IDBKeyRange.bound(folderUrlPrefix, `${folderUrlPrefix}\uffff`));
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('aborted'));
        });
    } catch (error) {
        console.debug('[Gallery++] Could not purge folder thumbnails:', error);
    }
}

/** Removes every cached size of many files at once (O(memory.size) sweep + single IDB transaction). */
export async function purgeThumbnails(srcs) {
    const srcSet = new Set(srcs);
    if (srcSet.size === 0) return;
    cacheEpoch++;
    for (const src of srcSet) signatures.delete(src);
    for (const [key, entry] of [...memory.entries()]) {
        const sep = key.lastIndexOf('|');
        const src = sep >= 0 ? key.slice(0, sep) : key;
        if (srcSet.has(src)) {
            revokeKeyUrl(key, entry);
            memory.delete(key);
        }
    }
    for (const key of [...pendingPuts.keys()]) {
        const sep = key.lastIndexOf('|');
        const src = sep >= 0 ? key.slice(0, sep) : key;
        if (srcSet.has(src)) pendingPuts.delete(key);
    }
    try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            for (const src of srcSet) store.delete(IDBKeyRange.bound(`${src}|`, `${src}|\uffff`));
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
    cacheEpoch++;
    clearTimeout(putFlushTimer);
    putFlushTimer = 0;
    pendingPuts.clear();
    for (const [key, entry] of memory.entries()) revokeKeyUrl(key, entry);
    memory.clear();
    liveObjectUrls.clear();
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

/** Completely removes the IndexedDB database and terminates the background worker (for the `clean` hook). */
export async function deleteThumbnailDatabase() {
    cacheEpoch++;
    clearTimeout(putFlushTimer);
    putFlushTimer = 0;
    pendingPuts.clear();
    terminateWorker();
    for (const [key, entry] of memory.entries()) revokeKeyUrl(key, entry);
    memory.clear();
    liveObjectUrls.clear();
    signatures.clear();
    if (dbPromise) {
        try { (await dbPromise).close(); } catch { /* ignore */ }
        dbPromise = null;
    }
    if (typeof indexedDB === 'undefined') return;
    await Promise.race([
        new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(DB_NAME);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
        new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
}