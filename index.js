/*
 * Gallery++ 2.1 — a from-scratch rewrite of SillyTavern's Gallery extension.
 * Original Gallery extension by City-Unit. SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as ST from '../../../../script.js';
import { eventSource, getRequestHeaders, event_types, animation_duration, animation_easing } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { getBase64Async, getFileExtension, getSanitizedFilename, saveBase64AsFile } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { t, translate } from '../../../i18n.js';
import { Popup } from '../../../popup.js';
import { deleteMediaFromServer } from '../../../chats.js';
import { MEDIA_REQUEST_TYPE, VIDEO_EXTENSIONS } from '../../../constants.js';

import {
    ASPECT_PRESETS, LAYOUT_DEFAULTS, LAYOUT_LIMITS, baseName, clampInt, clampPage, dominantAspect, encodePath,
    filterByName, fitTile, isVideoName, normalizeExtensions, pageCount, pageForIndex, pageSlice, parseAspect,
    parsePageInput, resolveGridForRatio, sanitizeHTMLId, thumbBucket, tokenizeQuery,
} from './lib.js';
import {
    clearLocalBackup, configureSettings, getBoolean, getFolderOverride, getLayout, getSettings, getSide, getSort,
    removeAvatar, renameAvatar, resetLayout, resolveCharacterFolder, setBoolean, setFolderOverride, setLayout,
    setSide, setSort,
} from './settings.js';
import {
    clearThumbnailCache, configureThumbs, deleteThumbnailDatabase, getThumbnail, invalidateThumbnailChecks,
    peekDimensions, peekThumbnail, prefetchPageFromDB, probeImageDimensions, purgeFolderThumbnails, purgeThumbnail,
    revalidateThumbnail,
} from './thumbs.js';

// ------------------------------------------------------------------------------- constants

const PANEL_ID = 'gallery'; // same id as the original extension, so the saved window position carries over
const GRID_GAP = 6;
const GRID_PADDING = 6;
const DEFAULT_TILE_SIDE = 300; // only used to size thumbnails before the first fit has run
const REVEAL_TIMEOUT_MS = 900; // longest a new gallery window waits (hidden) for its final shape
const ASPECT_HINTS_KEY = 'gpp_aspect_hints'; // folder -> detected tile ratio, so reopening is instant
const ASPECT_HINTS_LIMIT = 200;
const ASPECT_CACHE_LIMIT = 200;
const SANITIZED_CACHE_LIMIT = 500;
const UPLOAD_CONCURRENCY = 3;
const DEFAULT_RATIO = 2 / 3; // used until a gallery's dominant shape is known
const ASPECT_SAMPLES = 12; // pictures sampled to find a gallery's dominant shape
const MOBILE_BREAKPOINT = 1000;
const SEARCH_DEBOUNCE_MS = 120;
const FOLDERS_CACHE_TTL = 15_000;
const VIDEO_EXT_SET = normalizeExtensions(VIDEO_EXTENSIONS);
const HOTKEY_SET = new Set(['\\', '=', '[', ']']);

const SORTS = Object.freeze([
    { value: 'nameAsc', field: 'name', order: 'asc', label: t`Name (A-Z)` },
    { value: 'nameDesc', field: 'name', order: 'desc', label: t`Name (Z-A)` },
    { value: 'dateDesc', field: 'date', order: 'desc', label: t`Newest` },
    { value: 'dateAsc', field: 'date', order: 'asc', label: t`Oldest` },
]);

// ------------------------------------------------------------------------------- small helpers

/** Tiny DOM builder. `on*` keys become listeners; `class`, `dataset` and a few props are handled. */
function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'readOnly') el[key] = value;
        else el.setAttribute(key, value === true ? '' : String(value));
    }
    if (attrs?.role === 'button' && tag !== 'button') {
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        if (!el.classList.contains('gpp-tile')) {
            el.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (el.classList.contains('disabled')) return;
                e.preventDefault();
                el.click();
            });
        }
    }
    for (const child of children.flat()) {
        if (child === undefined || child === null || child === false) continue;
        el.append(child);
    }
    return el;
}

const icon = (classes) => h('i', { class: classes, 'aria-hidden': 'true' });

function debounce(fn, ms) {
    let timer = 0;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
}

const isMobileLayout = () => window.innerWidth <= MOBILE_BREAKPOINT;

function stopVideoIn(element) {
    const video = element?.querySelector?.('video');
    if (video instanceof HTMLVideoElement) {
        video.pause();
        video.removeAttribute('src');
        video.load();
    }
}

function fadeRemove(element, onDone) {
    stopVideoIn(element);
    const $el = $(element);
    const finish = () => { element.remove(); onDone?.(); };
    if (typeof $el.transition === 'function') {
        $el.transition({ opacity: 0, duration: animation_duration, easing: animation_easing, complete: finish });
    } else {
        finish();
    }
}

function fadeIn(element) {
    const $el = $(element);
    if (typeof $el.transition === 'function') {
        $el.transition({ opacity: 1, duration: animation_duration, easing: animation_easing });
    } else {
        element.style.opacity = '1';
    }
}

/** Raises the clicked gallery or picture window above sibling gallery/picture windows (still behind ST drawers). */
function raiseGalleryWindow(win) {
    if (!(win instanceof HTMLElement)) return;
    document.querySelectorAll('#gallery.gpp-raised, .galleryImageDraggable.gpp-raised')
        .forEach(el => { if (el !== win) el.classList.remove('gpp-raised'); });
    win.classList.add('gpp-raised');
}

function clearDesktopInlineGeometry(el) {
    el.style.width = '';
    el.style.height = '';
    el.style.left = '';
    el.style.right = '';
    el.style.top = '';
    el.style.bottom = '';
    el.style.maxWidth = '';
    el.style.maxHeight = '';
    el.style.minWidth = '';
    el.style.margin = '';
}

// ------------------------------------------------------------------------------- state

/**
 * @typedef {{path: string, url: string, name: string, nameLower: string, video: boolean}} GalleryItem
 * @typedef {{el: HTMLElement, img: HTMLImageElement, item: GalleryItem, url: string|null, blob: Blob|null}} Tile
 */

const view = {
    /** @type {HTMLElement|null} */ panel: null,
    /** @type {Record<string, any>} */ refs: {},
    /** @type {AbortController|null} */ panelCtl: null,
    token: 0,
    /** @type {AbortController|null} */ loadCtl: null,
    /** @type {AbortController|null} */ renderCtl: null,
    /** @type {IntersectionObserver|null} */ observer: null,
    kind: /** @type {'char'|'group'} */ ('char'),
    folder: '',
    /** @type {GalleryItem[]} */ items: [],
    /** @type {GalleryItem[]} */ filtered: [],
    query: '',
    queryTokensKey: '',
    page: 1,
    pageSize: 1,
    /** @type {Map<HTMLElement, Tile>} */ tiles: new Map(),
    status: /** @type {'loading'|'ready'|'error'} */ ('loading'),
    deleteMode: false,
    uploading: false,
    /** @type {{tw: number, th: number}|null} */ fit: null,
    lastFitKey: '',
    /** Thumbnail bucket the tiles on screen were rendered with. */
    renderedBucket: 0,
    rendering: false,
    revealed: false,
    /** Width/height detected for the open gallery (used when the shape option is 'auto'). */
    /** @type {number|null} */ autoRatio: null,
};

let initialized = false;
/** @type {string|null} */
let activeUserScope = null;
/** @type {AbortController|null} */
let initCtl = null;
/** @type {ResizeObserver|null} */
let sheldObserver = null;
/** @type {((...args: any[]) => void) & {cancel: () => void} | null} */
let refitDebounced = null;
/** @type {Array<[string, Function]>} */
let eventHandlers = [];
/** @type {Promise<void>|null} */
let openingPromise = null;
let idlePrefetchHandle = 0;
let idlePrefetchIsIdle = false;
const inFlightDeletes = new Set();
let foldersCache = { time: 0, list: /** @type {string[]|null} */ (null) };
/** @type {Promise<string[]>|null} */
let foldersInFlight = null;
const sanitizedCache = new Map();
let lastViewportSig = '';

// ------------------------------------------------------------------------------- data access

async function sanitizeFolder(name) {
    const key = String(name);
    if (sanitizedCache.has(key)) {
        const val = sanitizedCache.get(key);
        sanitizedCache.delete(key);
        sanitizedCache.set(key, val);
        return val;
    }
    const sanitized = await getSanitizedFilename(key);
    sanitizedCache.set(key, sanitized);
    while (sanitizedCache.size > SANITIZED_CACHE_LIMIT) {
        sanitizedCache.delete(sanitizedCache.keys().next().value);
    }
    return sanitized;
}

/** @returns {{kind: 'char'|'group', folder: string, character: any}|null} */
function getTarget() {
    const ctx = SillyTavern.getContext();
    if (ctx.groupId) return { kind: 'group', folder: String(ctx.groupId), character: null };
    if (ctx.characterId !== undefined && ctx.characterId !== null) {
        const character = ctx.characters?.[ctx.characterId];
        if (character) return { kind: 'char', folder: resolveCharacterFolder(character) ?? character.name, character };
    }
    return null;
}

async function listFolderFiles(folder, signal) {
    const sort = SORTS.find(s => s.value === getSort()) ?? SORTS[3];
    const response = await fetch('/api/images/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal,
        body: JSON.stringify({
            folder,
            sortField: sort.field,
            sortOrder: sort.order,
            type: MEDIA_REQUEST_TYPE.IMAGE | MEDIA_REQUEST_TYPE.VIDEO,
        }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} while listing the gallery`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Unexpected gallery list response');
    return data;
}

/** @returns {Promise<GalleryItem[]>} */
async function fetchItems(folder, signal) {
    const [files, safe] = await Promise.all([listFolderFiles(folder, signal), sanitizeFolder(folder)]);
    const prefix = `user/images/${safe}/`;
    const encodedPrefix = encodePath(prefix);
    return files.map(file => {
        const name = String(file);
        const path = prefix + name;
        return { path, url: encodedPrefix + encodeURIComponent(name), name, nameLower: name.toLowerCase(), video: isVideoName(name, VIDEO_EXT_SET) };
    });
}

async function getAllFolders() {
    const now = Date.now();
    if (foldersCache.list && now - foldersCache.time < FOLDERS_CACHE_TTL) return foldersCache.list;
    if (!foldersInFlight) {
        foldersInFlight = (async () => {
            try {
                const response = await fetch('/api/images/folders', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }) });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                foldersCache = { time: Date.now(), list: Array.isArray(data) ? data : [] };
            } catch (error) {
                console.error('[Gallery++] Failed to fetch folders:', error);
                foldersCache = { time: 0, list: null };
                return [];
            }
            return foldersCache.list ?? [];
        })().finally(() => { foldersInFlight = null; });
    }
    return foldersInFlight;
}

// ------------------------------------------------------------------------------- loading + filtering

function applyFilter() {
    view.filtered = filterByName(view.items, view.query);
}

/** Fades the gallery window in. Called once it has its final size, so it never visibly resizes. */
function revealPanel() {
    const panel = view.panel;
    if (!panel || view.revealed) return;
    view.revealed = true;
    fadeIn(panel);
}

/**
 * Loads the current folder in place; the panel stays mounted.
 * @param {{keepPage?: boolean, previousPaths?: Set<string>, revalidate?: boolean}} [options]
 */
async function loadFolder({ keepPage = false, previousPaths = null, revalidate = true } = {}) {
    if (!view.panel) return;
    if (revalidate) invalidateThumbnailChecks();
    const token = ++view.token;
    view.loadCtl?.abort();
    const ctl = (view.loadCtl = new AbortController());
    if (getLayout().aspect === 'auto') primeAspect();
    view.panel.classList.add('gpp-busy');
    if (view.items.length === 0) {
        view.status = 'loading';
        renderPage({ refit: true });
    }

    try {
        const items = await fetchItems(view.folder, ctl.signal);
        if (token !== view.token || !view.panel) return;
        view.items = items;
        view.status = 'ready';
        useCachedAspect();
        applyFilter();
        if (previousPaths) {
            // After an upload, show the page holding the first new file.
            const index = view.filtered.findIndex(item => !previousPaths.has(item.path));
            if (index >= 0) view.page = pageForIndex(index, currentLayout().pageSize);
        } else if (!keepPage) {
            view.page = 1;
        }
        renderPage();
        if (view.revealed) {
            void detectAspect(ctl.signal);
        } else {
            // First open and the shape of this gallery is not known yet: wait briefly for fast header
            // probing so the window appears once, already at its final size.
            let revealTimer = 0;
            try {
                await Promise.race([
                    detectAspect(ctl.signal),
                    new Promise(resolve => { revealTimer = setTimeout(resolve, REVEAL_TIMEOUT_MS); }),
                ]);
            } finally {
                clearTimeout(revealTimer);
            }
            if (token === view.token) revealPanel();
        }
    } catch (error) {
        if (error?.name === 'AbortError' || token !== view.token || !view.panel) return;
        console.error('[Gallery++] Failed to load gallery:', error);
        view.items = [];
        view.filtered = [];
        view.status = 'error';
        renderPage();
        revealPanel();
        toastr.error(t`Failed to load the gallery.`);
    } finally {
        if (token === view.token) view.panel?.classList.remove('gpp-busy');
    }
}

// ------------------------------------------------------------------------------- rendering

function currentLayout() {
    const layout = getLayout();
    const { rows, cols, orientation } = resolveGridForRatio(layout, activeRatio());
    return { ...layout, rows, cols, orientation, pageSize: rows * cols };
}

const aspectCache = new Map(); // `${folder}|${count}` -> detected ratio

function setAspectCache(key, ratio) {
    aspectCache.delete(key);
    aspectCache.set(key, ratio);
    while (aspectCache.size > ASPECT_CACHE_LIMIT) {
        aspectCache.delete(aspectCache.keys().next().value);
    }
}

function getAspectHintsKey() {
    const scope = typeof activeUserScope === 'string' ? activeUserScope.trim() : '';
    if (scope && scope !== 'default-user') return `${ASPECT_HINTS_KEY}.${scope}`;
    return ASPECT_HINTS_KEY;
}

/** Thumbnail resolution that matches the tiles actually on screen. */
function currentBucket() {
    const tw = view.fit?.tw ?? DEFAULT_TILE_SIDE;
    const th = view.fit?.th ?? DEFAULT_TILE_SIDE;
    // Slight margin for object-fit: cover when the user chose a fixed aspect preset.
    const mult = getLayout().aspect === 'auto' ? 1.05 : 1.15;
    return thumbBucket(tw * mult, th * mult, window.devicePixelRatio);
}

function readAspectHints() {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(getAspectHintsKey()) ?? '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function saveAspectHint(folder, ratio) {
    try {
        const hints = readAspectHints();
        const keys = Object.keys(hints);
        if (hints[folder] === ratio && keys[keys.length - 1] === folder && keys.length <= ASPECT_HINTS_LIMIT) return;
        delete hints[folder];
        hints[folder] = ratio;
        const allKeys = Object.keys(hints);
        if (allKeys.length > ASPECT_HINTS_LIMIT) {
            for (const oldKey of allKeys.slice(0, allKeys.length - ASPECT_HINTS_LIMIT)) delete hints[oldKey];
        }
        window.localStorage.setItem(getAspectHintsKey(), JSON.stringify(hints));
    } catch { /* storage unavailable: the hint is only an optimisation */ }
}

function deleteAspectHint(folder) {
    try {
        const hints = readAspectHints();
        if (!(folder in hints)) return;
        delete hints[folder];
        window.localStorage.setItem(getAspectHintsKey(), JSON.stringify(hints));
    } catch { /* ignore */ }
}

/** Starts from the last detected shape of this folder, or clears stale ratio from a previous folder. */
function primeAspect() {
    const ratio = Number(readAspectHints()[view.folder]);
    if (ratio > 0 && Number.isFinite(ratio)) {
        view.autoRatio = ratio;
        return true;
    }
    view.autoRatio = null;
    return false;
}

/** Width / height of a tile: the chosen shape, or the gallery's detected one. */
function activeRatio() {
    return parseAspect(getLayout().aspect) ?? view.autoRatio ?? DEFAULT_RATIO;
}

function useCachedAspect() {
    const ratio = aspectCache.get(`${view.folder}|${view.items.length}`);
    if (ratio) view.autoRatio = ratio;
}

/** Picks up to ASPECT_SAMPLES images, prioritizing Page 1 first so detection aligns with visible tiles. */
function pickAspectSamples(images) {
    if (images.length <= ASPECT_SAMPLES) return images;
    const picked = [];
    const seen = new Set();
    const pageImages = pageSlice(view.filtered, view.page, view.pageSize).filter(i => !i.video);
    for (const item of pageImages) {
        if (picked.length >= ASPECT_SAMPLES) break;
        if (!seen.has(item.url)) { seen.add(item.url); picked.push(item); }
    }
    if (picked.length < ASPECT_SAMPLES) {
        const remaining = images.filter(item => !seen.has(item.url));
        const needed = ASPECT_SAMPLES - picked.length;
        if (remaining.length <= needed) {
            picked.push(...remaining);
        } else {
            const step = remaining.length / needed;
            for (let i = 0; i < needed; i++) {
                picked.push(remaining[Math.min(remaining.length - 1, Math.floor(i * step))]);
            }
        }
    }
    return picked;
}

/**
 * Finds the shape most pictures in the open gallery have (only when the option is 'auto').
 * Uses cached {w, h} metadata first, then lightweight Range header probes (<= 64 KB) so it never
 * downloads full images or competes with Page 1's thumbnail decode queue.
 * @param {AbortSignal} [signal]
 */
async function detectAspect(signal) {
    if (!view.panel || getLayout().aspect !== 'auto' || signal?.aborted) return;
    const token = view.token;
    const key = `${view.folder}|${view.items.length}`;
    const cached = aspectCache.get(key);
    if (cached) {
        applyDetectedAspect(cached);
        return;
    }
    const images = view.items.filter(i => !i.video);
    if (images.length === 0) return;

    const samples = pickAspectSamples(images);
    const ratios = [];
    const needProbe = [];

    for (const item of samples) {
        const dims = peekDimensions(item.url);
        if (dims && dims.w > 0 && dims.h > 0) ratios.push(dims.w / dims.h);
        else needProbe.push(item);
    }

    if (needProbe.length > 0) {
        const probed = await Promise.all(needProbe.map(item => probeImageDimensions(item.url, signal)));
        if (signal?.aborted || token !== view.token || !view.panel) return;
        for (const dims of probed) {
            if (dims && dims.w > 0 && dims.h > 0) ratios.push(dims.w / dims.h);
        }
    }

    // Fallback for formats without parsed headers (e.g. AVIF / SVG): inspect a few low-priority thumbnails.
    if (ratios.length === 0 && !signal?.aborted) {
        const bucket = currentBucket();
        const fallback = samples.slice(0, 4);
        const hits = await Promise.all(fallback.map(item => getThumbnail(item.url, { video: false, bucket, signal, priority: 0 })));
        if (signal?.aborted || token !== view.token || !view.panel) return;
        for (const hit of hits) {
            if (hit && hit.w > 0 && hit.h > 0) ratios.push(hit.w / hit.h);
        }
    }

    if (signal?.aborted || token !== view.token || !view.panel) return;
    const value = dominantAspect(ratios);
    const preset = ASPECT_PRESETS.find(p => p.value === value);
    if (!preset) return;
    setAspectCache(key, preset.ratio);
    saveAspectHint(view.folder, preset.ratio);
    if (getLayout().aspect === 'auto') {
        applyDetectedAspect(preset.ratio);
    }
}

/** Updates autoRatio and re-renders if the orientation switch changed the active rows/columns. */
function applyDetectedAspect(ratio) {
    if (view.autoRatio === ratio) return;
    const prev = currentLayout();
    view.autoRatio = ratio;
    const next = currentLayout();
    if (next.rows !== prev.rows || next.cols !== prev.cols) {
        const firstVisible = (view.page - 1) * view.pageSize;
        view.page = pageForIndex(firstVisible, next.pageSize);
        view.lastFitKey = '';
        renderPage({ refit: true });
    } else {
        fitPanel(true);
    }
}

function applyLayoutVariables() {
    const { cols, rows } = currentLayout();
    const ratio = activeRatio();
    // Before the first fit: a placeholder tile of the right shape.
    const tw = view.fit?.tw ?? Math.round(DEFAULT_TILE_SIDE * Math.min(1, ratio));
    const th = view.fit?.th ?? Math.round(tw / ratio);
    const style = view.panel.style;
    style.setProperty('--gpp-cols', String(cols));
    style.setProperty('--gpp-rows', String(rows));
    style.setProperty('--gpp-tw', `${tw}px`);
    style.setProperty('--gpp-th', `${th}px`);
    style.setProperty('--gpp-gap', `${GRID_GAP}px`);
    style.setProperty('--gpp-pad', `${GRID_PADDING}px`);
    if (isMobileLayout()) {
        style.removeProperty('--gpp-grid-h'); // full-screen window: the grid area simply fills it
    } else {
        // The grid area always has the size of a full page, so the window never changes size
        // while loading, on a half-empty last page, or when showing a message.
        style.setProperty('--gpp-grid-h', `${rows * th + 2 * GRID_PADDING + (rows - 1) * GRID_GAP}px`);
    }
    view.refs.grid.classList.toggle('gpp-show-names', getBoolean('showNames'));
}

function cancelIdlePrefetch() {
    if (!idlePrefetchHandle) return;
    if (idlePrefetchIsIdle && typeof cancelIdleCallback === 'function') cancelIdleCallback(idlePrefetchHandle);
    else clearTimeout(idlePrefetchHandle);
    idlePrefetchHandle = 0;
    idlePrefetchIsIdle = false;
}

function scheduleNextPagePrefetch(bucket, signal) {
    cancelIdlePrefetch();
    const pages = pageCount(view.filtered.length, view.pageSize);
    if (view.page >= pages || signal.aborted) return;
    const nextItems = pageSlice(view.filtered, view.page + 1, view.pageSize);
    const urls = nextItems.filter(item => !peekThumbnail(item.url, bucket)).map(item => item.url);
    if (urls.length === 0) return;

    const run = () => {
        idlePrefetchHandle = 0;
        idlePrefetchIsIdle = false;
        if (signal.aborted || !view.panel) return;
        void prefetchPageFromDB(urls, bucket);
    };
    if (typeof requestIdleCallback === 'function') {
        idlePrefetchIsIdle = true;
        idlePrefetchHandle = requestIdleCallback(run, { timeout: 1000 });
    } else {
        idlePrefetchIsIdle = false;
        idlePrefetchHandle = setTimeout(run, 120);
    }
}

function disposeTiles() {
    cancelIdlePrefetch();
    view.renderCtl?.abort();
    view.renderCtl = null;
    view.observer?.disconnect();
    view.observer = null;
    view.tiles.clear(); // objectUrls are lifecycle-managed by the thumbs.js LRU so recent pages stay decoded
}

function showMessage(iconClass, text, ...actions) {
    const { grid } = view.refs;
    grid.replaceChildren(h('div', { class: 'gpp-message' }, icon(iconClass), h('div', {}, text), ...actions));
    grid.classList.add('gpp-grid-empty');
}

/** @param {{refit?: boolean}} [options] */
function renderPage({ refit = false } = {}) {
    if (!view.panel) return;
    const { grid, scroller } = view.refs;
    const layout = currentLayout();
    view.pageSize = layout.pageSize;
    const pages = pageCount(view.filtered.length, layout.pageSize);
    view.page = clampPage(view.page, pages);

    view.rendering = true;
    disposeTiles();
    grid.classList.remove('gpp-grid-empty');
    updatePager(pages); // pager chrome must be up-to-date before fitting
    if (refit || !view.fit || needsRefit(pages)) fitPanel(refit);

    if (view.status === 'loading' && view.items.length === 0) {
        showMessage('fa-solid fa-spinner fa-spin', t`Loading…`);
    } else if (view.status === 'error') {
        showMessage('fa-solid fa-triangle-exclamation', t`Could not load this gallery.`,
            h('div', { class: 'menu_button menu_button_icon interactable', role: 'button', onClick: () => loadFolder({ revalidate: true }) }, icon('fa-solid fa-rotate'), h('span', {}, t`Retry`)));
    } else if (view.items.length === 0) {
        showMessage('fa-regular fa-images', t`This gallery is empty. Drop images here or press “Add Image”.`);
    } else if (view.filtered.length === 0) {
        showMessage('fa-solid fa-magnifying-glass', t`No images match “${view.query}”.`,
            h('div', { class: 'menu_button menu_button_icon interactable', role: 'button', onClick: () => setQuery('') }, icon('fa-solid fa-xmark'), h('span', {}, t`Clear search`)));
    } else {
        const ctl = (view.renderCtl = new AbortController());
        const bucket = currentBucket();
        view.renderedBucket = bucket;
        const fragment = document.createDocumentFragment();
        /** @type {Tile[]} */
        const dbMisses = [];
        /** @type {Tile[]} */
        const toRevalidate = [];

        for (const item of pageSlice(view.filtered, view.page, layout.pageSize)) {
            const img = h('img', { class: 'gpp-img', alt: '', decoding: 'async', draggable: 'false' });
            const el = h('div', {
                class: `gpp-tile${item.video ? ' gpp-video' : ''}`,
                tabindex: '0',
                role: 'button',
                title: item.name,
                'aria-label': item.name,
            }, img, item.video ? icon('fa-solid fa-circle-play gpp-badge') : null, h('span', { class: 'gpp-name' }, item.name));
            const tile = { el, img, item, url: null, blob: null };
            view.tiles.set(el, tile);
            fragment.append(el);

            // Instant paint for thumbnails already in memory (with reused decoded objectUrl).
            const hit = peekThumbnail(item.url, bucket);
            if (hit) {
                applyThumbnail(tile, hit.url, hit.blob);
                if (!hit.verified) toRevalidate.push(tile);
            } else {
                dbMisses.push(tile);
            }
        }
        grid.replaceChildren(fragment);

        if (dbMisses.length > 0 || toRevalidate.length > 0) {
            void populatePendingTiles(dbMisses, toRevalidate, bucket, ctl.signal);
        } else {
            scheduleNextPagePrefetch(bucket, ctl.signal);
        }
    }

    scroller.scrollTop = 0;
    view.rendering = false;
}

/**
 * Hydrates tiles not in RAM via a single batched IndexedDB read (instant paint), schedules
 * generation for true cache misses, and runs background stale-while-revalidate checks.
 * @param {Tile[]} dbMisses
 * @param {Tile[]} toRevalidate
 * @param {number} bucket
 * @param {AbortSignal} signal
 */
async function populatePendingTiles(dbMisses, toRevalidate, bucket, signal) {
    /** @type {Tile[]} */
    const toGenerate = [];

    if (dbMisses.length > 0) {
        const dbHits = await prefetchPageFromDB(dbMisses.map(tile => tile.item.url), bucket);
        if (signal.aborted || !view.panel) return;
        for (const tile of dbMisses) {
            if (!view.tiles.has(tile.el)) continue;
            const hit = dbHits.get(tile.item.url);
            if (hit) {
                applyThumbnail(tile, hit.url, hit.blob);
                if (!hit.verified) toRevalidate.push(tile);
            } else {
                toGenerate.push(tile);
            }
        }
    }

    if (signal.aborted || !view.panel) return;

    const scroller = view.refs.scroller;
    const needsScrollLazy = scroller && scroller.scrollHeight > scroller.clientHeight + 4 && typeof IntersectionObserver === 'function';

    const startGenerate = (tile) => void loadTileThumbnail(tile, bucket, signal);
    const startRevalidate = (tile) => void revalidateTileThumbnail(tile, bucket, signal);

    if (needsScrollLazy && (toGenerate.length > 0 || toRevalidate.length > 0)) {
        const genSet = new Set(toGenerate.map(tile => tile.el));
        view.observer = new IntersectionObserver((entries, observer) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                observer.unobserve(entry.target);
                const el = /** @type {HTMLElement} */ (entry.target);
                const tile = view.tiles.get(el);
                if (!tile) continue;
                if (genSet.has(el)) startGenerate(tile);
                else startRevalidate(tile);
            }
        }, { root: scroller, rootMargin: '200px' });
        for (const tile of toGenerate) view.observer.observe(tile.el);
        for (const tile of toRevalidate) view.observer.observe(tile.el);
    } else {
        // Desktop pages fit entirely in view: skip the 1-frame IntersectionObserver delay.
        for (const tile of toGenerate) startGenerate(tile);
        for (const tile of toRevalidate) startRevalidate(tile);
    }
    scheduleNextPagePrefetch(bucket, signal);
}

/** @param {Tile} tile @param {string} url @param {Blob} blob */
function applyThumbnail(tile, url, blob) {
    if (!view.tiles.has(tile.el) || (tile.blob === blob && tile.url === url)) return;
    tile.url = url;
    tile.blob = blob;
    tile.el.classList.remove('gpp-failed');
    tile.img.src = url;
    if (tile.img.complete && tile.img.naturalWidth > 0) {
        tile.el.classList.add('gpp-loaded');
    } else if (typeof tile.img.decode === 'function') {
        tile.img.decode().then(
            () => { if (view.tiles.has(tile.el) && tile.url === url) tile.el.classList.add('gpp-loaded'); },
            () => { if (view.tiles.has(tile.el) && tile.url === url) tile.el.classList.add('gpp-loaded'); },
        );
    } else {
        tile.el.classList.add('gpp-loaded');
    }
}

/** @param {Tile} tile */
async function loadTileThumbnail(tile, bucket, signal) {
    const hit = await getThumbnail(tile.item.url, { video: tile.item.video, bucket, signal, priority: 1, skipCache: true });
    if (signal.aborted || !view.tiles.has(tile.el)) return;
    if (hit) applyThumbnail(tile, hit.url, hit.blob);
    else tile.el.classList.add('gpp-failed');
}

/** @param {Tile} tile */
async function revalidateTileThumbnail(tile, bucket, signal) {
    const fresh = await revalidateThumbnail(tile.item.url, { video: tile.item.video, bucket, signal });
    if (signal.aborted || !view.tiles.has(tile.el)) return;
    if (fresh) applyThumbnail(tile, fresh.url, fresh.blob);
}

function updatePager(pages) {
    if (!view.panel) return;
    const { pageInput, pageTotal, first, prev, next, last, info } = view.refs;
    pageInput.value = String(view.page);
    pageInput.setAttribute('aria-label', t`Page (1–${pages})`);
    pageInput.style.width = `${Math.max(3, String(pages).length + 2)}ch`;
    pageTotal.textContent = `/ ${pages}`;
    first.classList.toggle('disabled', view.page <= 1);
    prev.classList.toggle('disabled', view.page <= 1);
    next.classList.toggle('disabled', view.page >= pages);
    last.classList.toggle('disabled', view.page >= pages);

    const total = view.filtered.length;
    if (view.items.length === 0) {
        info.textContent = '';
    } else {
        const from = (view.page - 1) * view.pageSize + 1;
        const to = Math.min(total, view.page * view.pageSize);
        const isFiltered = Boolean(view.query) && total !== view.items.length;
        const allCount = view.items.length;
        if (total === 0) {
            info.textContent = isFiltered ? t`0 items (filtered from ${allCount})` : t`0 items`;
        } else if (pages > 1) {
            info.textContent = isFiltered
                ? t`${from}–${to} of ${total} items (filtered from ${allCount})`
                : t`${from}–${to} of ${total} items`;
        } else if (total === 1) {
            info.textContent = isFiltered ? t`1 item (filtered from ${allCount})` : t`1 item`;
        } else {
            info.textContent = isFiltered ? t`${total} items (filtered from ${allCount})` : t`${total} items`;
        }
    }
}

function goToPage(page) {
    if (!view.panel) return;
    const pages = pageCount(view.filtered.length, view.pageSize);
    const target = clampPage(page, pages);
    if (target === view.page) { updatePager(pages); return; }
    view.page = target;
    renderPage();
}

function setQuery(value) {
    if (!view.panel) return;
    const next = String(value ?? '');
    const tokensKey = tokenizeQuery(next).join('\0');
    const { search, clearSearch } = view.refs;
    view.query = next;
    if (search.value !== next) search.value = next;
    clearSearch.hidden = next === '';
    if (tokensKey === view.queryTokensKey) return;
    view.queryTokensKey = tokensKey;
    applyFilter();
    view.page = 1;
    renderPage();
}

/** Re-applies layout options (rows/cols/aspect) to the open window, keeping the user's place. */
function applyLayoutToOpenGallery({ resizePanel = true } = {}) {
    if (!view.panel) return;
    const layout = currentLayout();
    const firstVisible = (view.page - 1) * view.pageSize;
    view.page = pageForIndex(firstVisible, layout.pageSize);
    view.lastFitKey = '';
    if (resizePanel && !isMobileLayout()) {
        // A stale saved size would otherwise win again the next time the window is opened.
        const saved = power_user?.movingUIState?.[PANEL_ID];
        if (saved) { delete saved.width; delete saved.height; SillyTavern.getContext().saveSettingsDebounced(); }
    }
    renderPage({ refit: resizePanel });
    if (layout.aspect === 'auto') void detectAspect(view.loadCtl?.signal);
}

// ------------------------------------------------------------------------------- window placement

const FIT_GAP = 4;

/**
 * The free strip of screen beside the chat panel (#sheld) on the requested side.
 * @param {'left'|'right'} side
 * @returns {{left: number, top: number, width: number, height: number}}
 */
function getBounds(side, flush = false) {
    const gap = flush ? 0 : FIT_GAP;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sheld = document.getElementById('sheld');
    let sl = vw / 2;
    let sr = vw / 2;
    if (sheld) {
        const r = sheld.getBoundingClientRect();
        if (r.width > 0 && getComputedStyle(sheld).display !== 'none') { sl = r.left; sr = r.right; }
    }
    const topBar = document.getElementById('top-bar')?.getBoundingClientRect();
    const top = topBar && topBar.bottom > 0 && topBar.bottom < vh / 3 ? Math.ceil(topBar.bottom) + gap : gap;
    const height = Math.max(120, vh - top - gap);
    if (side === 'left') {
        const width = Math.max(120, Math.floor(sl - 2 * gap));
        return { left: gap, top, width, height };
    }
    const left = Math.ceil(sr) + gap;
    return { left, top, width: Math.max(120, Math.floor(vw - left - gap)), height };
}

/** Pins a window against the chat panel (or the screen edge) inside the given bounds. */
function placeInBounds(element, side, bounds, width, anchorBottom = false) {
    const left = side === 'right' ? bounds.left : bounds.left + bounds.width - width;
    element.style.left = `${Math.max(0, Math.round(left))}px`;
    element.style.right = 'auto';
    if (anchorBottom) {
        // Sits on the bottom edge of the screen, like a character sprite.
        element.style.top = 'auto';
        element.style.bottom = '0px';
    } else {
        element.style.top = `${Math.round(bounds.top)}px`;
        element.style.bottom = 'auto';
    }
    element.style.margin = 'unset';
}

/** Collects visible in-flow chrome elements once so multi-pass fitting avoids repeated getComputedStyle() calls. */
function collectChromeLayout(panel) {
    /** @type {HTMLElement[]} */
    const chromeChildren = [];
    let flowCount = 0;
    for (const child of panel.children) {
        if (!(child instanceof HTMLElement) || child.hidden) continue;
        const ccs = getComputedStyle(child);
        if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed') continue;
        flowCount++;
        if (child !== view.refs.scroller) chromeChildren.push(child);
    }
    return { chromeChildren, flowCount };
}

function measureChromeFrom(chromeLayout, padY, gap) {
    let chrome = padY;
    for (const child of chromeLayout.chromeChildren) chrome += child.offsetHeight;
    return chrome + gap * Math.max(0, chromeLayout.flowCount - 1);
}

/** Height of everything in the window except the picture grid (toolbars, pager, title, padding, gaps). */
function measureChrome(panel, padY, gap) {
    return measureChromeFrom(collectChromeLayout(panel), padY, gap);
}

function computeFitKey(pages) {
    const mobile = isMobileLayout();
    const { cols, rows } = currentLayout();
    const ratio = activeRatio();
    const pageDigits = String(pages ?? pageCount(view.filtered.length, view.pageSize)).length;
    if (mobile) {
        return `m|${window.innerWidth}x${window.innerHeight}|${cols}x${rows}|${ratio}|${pageDigits}`;
    }
    const side = view.panel?.dataset.gppSide === 'left' || view.panel?.dataset.gppSide === 'right'
        ? view.panel.dataset.gppSide
        : getSide();
    const b = getBounds(side, true);
    return `d|${side}|${b.left},${b.top},${b.width},${b.height}|${cols}x${rows}|${ratio}|${pageDigits}`;
}

function needsRefit(pages) {
    if (!view.panel || !view.fit) return true;
    return computeFitKey(pages) !== view.lastFitKey;
}

/**
 * Sizes the gallery window and its thumbnails to the free strip beside the chat panel.
 * The window sits flush against the chat panel and the bottom of the screen (like opened pictures)
 * and hugs its grid; the tiles are as large as the strip allows for the chosen columns x rows.
 */
function fitPanel(force = false) {
    const panel = view.panel;
    if (!panel || !panel.isConnected) return;
    const fitKey = computeFitKey();
    if (!force && fitKey === view.lastFitKey && view.fit) return;
    view.lastFitKey = fitKey;

    if (isMobileLayout()) { fitPanelMobile(panel); return; }

    panel.dataset.gppMode = 'desktop';
    const side = panel.dataset.gppSide === 'left' || panel.dataset.gppSide === 'right' ? panel.dataset.gppSide : getSide();
    panel.dataset.gppSide = side;
    const bounds = getBounds(side, true);
    const { cols, rows } = currentLayout();
    const ratio = activeRatio();
    const cs = getComputedStyle(panel);
    const px = (v) => parseFloat(v) || 0;
    const padX = px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
    const padY = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    const gap = px(cs.rowGap) || 5;
    const gridX = 2 * GRID_PADDING + (cols - 1) * GRID_GAP;
    const gridY = 2 * GRID_PADDING + (rows - 1) * GRID_GAP;
    const minWidth = Math.min(280, bounds.width); // the toolbars need some room even for a tiny grid

    panel.style.minWidth = '0';
    panel.style.height = '';
    panel.style.maxHeight = `${bounds.height}px`;
    panel.style.maxWidth = `${bounds.width}px`;

    // The toolbar wraps differently at different widths, which changes the height left for the grid
    // and with it the tile size and the width again. Cache non-changing child visibility outside
    // the loop and break early once toolbar height and width settle.
    const chromeLayout = collectChromeLayout(panel);
    let width = bounds.width;
    let tile = { tw: 24, th: 24 };
    let prevChrome = -1;
    for (let pass = 0; pass < 5; pass++) {
        panel.style.width = `${width}px`;
        const chrome = measureChromeFrom(chromeLayout, padY, gap);
        tile = fitTile(width - padX - gridX - 1, bounds.height - chrome - gridY, cols, rows, ratio);
        const wanted = Math.ceil(cols * tile.tw + gridX + padX + 1);
        const next = Math.min(bounds.width, Math.max(minWidth, wanted));
        if (Math.abs(next - width) < 1) break;
        if (pass > 0 && chrome === prevChrome) {
            width = next;
            break;
        }
        prevChrome = chrome;
        width = next;
        if (pass === 4) {
            panel.style.width = `${width}px`;
            const finalChrome = measureChromeFrom(chromeLayout, padY, gap);
            tile = fitTile(width - padX - gridX - 1, bounds.height - finalChrome - gridY, cols, rows, ratio);
        }
    }
    panel.style.width = `${width}px`;
    view.fit = tile;
    applyLayoutVariables();

    // Pin the window to the bottom edge with an explicit height. (With `height: auto` plus the
    // `top`/`bottom` pair SillyTavern's dragging writes, the window would stretch.)
    placeInBounds(panel, side, bounds, width, true);
    const total = Math.min(bounds.height, Math.ceil(panel.getBoundingClientRect().height));
    panel.style.height = `${total}px`;

    // Tiles that became much bigger need a sharper thumbnail than the one they were rendered with.
    if (!view.rendering && view.renderedBucket && view.tiles.size > 0 && currentBucket() > view.renderedBucket) {
        renderPage();
    }
}

/** Full-screen layout: clears any desktop inline geometry and fits tiles into the viewport. */
function fitPanelMobile(panel) {
    if (panel.dataset.gppMode !== 'mobile') {
        panel.dataset.gppMode = 'mobile';
        clearDesktopInlineGeometry(panel);
        applySavedWindowState(panel);
    }
    const { cols, rows } = currentLayout();
    const ratio = activeRatio();
    const scroller = view.refs.scroller;
    const cs = getComputedStyle(panel);
    const px = (v) => parseFloat(v) || 0;
    const padY = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    const gridX = 2 * GRID_PADDING + (cols - 1) * GRID_GAP;
    const gridY = 2 * GRID_PADDING + (rows - 1) * GRID_GAP;
    const availW = (scroller?.clientWidth || panel.clientWidth || window.innerWidth) - 10 - gridX;
    // Screen height minus the toolbars/pager. Deliberately not the scroller's own height: that depends on
    // the tiles being sized here.
    const availH = window.innerHeight - measureChrome(panel, padY, px(cs.rowGap) || 5) - gridY;
    view.fit = fitTile(availW, availH, cols, rows, ratio);
    applyLayoutVariables();

    if (!view.rendering && view.renderedBucket && view.tiles.size > 0 && currentBucket() > view.renderedBucket) {
        renderPage();
    }
}

/** @param {HTMLElement} win @param {'left'|'right'} side */
function fitImageWindow(win, side) {
    if (isMobileLayout()) {
        if (win.dataset.gppMode !== 'mobile') {
            win.dataset.gppMode = 'mobile';
            clearDesktopInlineGeometry(win);
            applySavedWindowState(win);
        }
        return;
    }
    win.dataset.gppMode = 'desktop';
    win.dataset.gppSide = side;
    const w = Number(win.dataset.gppW);
    const hgt = Number(win.dataset.gppH);
    const bounds = getBounds(side, true);
    let width;
    let height;
    if (w > 0 && hgt > 0) {
        const scale = Math.min(bounds.width / w, bounds.height / hgt, 2);
        width = Math.max(40, Math.floor(w * scale));
        height = Math.max(40, Math.floor(hgt * scale));
    } else {
        width = Math.min(bounds.width, 320);
        height = Math.min(bounds.height, 320);
    }
    win.style.maxWidth = `${bounds.width}px`;
    win.style.maxHeight = `${bounds.height}px`;
    win.style.width = `${width}px`;
    win.style.height = `${height}px`;
    placeInBounds(win, side, bounds, width, true);
}

function fitAllWindows() {
    const imageWins = document.querySelectorAll('.galleryImageDraggable');
    if (!view.panel && imageWins.length === 0) return;

    // Ignore vertical-only #sheld mutations (e.g. chat growing while streaming), but track #top-bar height.
    const sheld = document.getElementById('sheld');
    const r = sheld ? sheld.getBoundingClientRect() : null;
    const topBar = document.getElementById('top-bar')?.getBoundingClientRect();
    const topSig = topBar ? Math.round(topBar.bottom) : '';
    const sig = `${window.innerWidth}x${window.innerHeight}|${r ? `${Math.round(r.left)},${Math.round(r.right)}` : ''}|${topSig}`;
    if (sig === lastViewportSig) return;
    lastViewportSig = sig;

    fitPanel(true);
    imageWins.forEach((win) => {
        if (win instanceof HTMLElement) fitImageWindow(win, win.dataset.gppSide === 'left' ? 'left' : 'right');
    });
}

/** After the user drags a gallery/image window across the chat panel, remember which side it now belongs to. */
function rememberDraggedSides() {
    const sheld = document.getElementById('sheld')?.getBoundingClientRect();
    if (!sheld) return;
    const mid = (sheld.left + sheld.right) / 2;
    document.querySelectorAll('#gallery, .galleryImageDraggable').forEach((win) => {
        if (!(win instanceof HTMLElement)) return;
        const r = win.getBoundingClientRect();
        if (!r.width) return;
        const side = r.left + r.width / 2 < mid ? 'left' : 'right';
        win.dataset.gppSide = side;
        if (win === view.panel) {
            if (getSide() !== side) setSide(side);
            updateSideToggle();
        }
    });
}

function applySavedWindowState(element) {
    const state = element.id ? power_user?.movingUIState?.[element.id] : null;
    if (state && typeof state === 'object') $(element).css(state);
    return state ?? null;
}

// ------------------------------------------------------------------------------- panel construction

function buildPanel() {
    const template = document.getElementById('generic_draggable_template');
    if (!(template instanceof HTMLTemplateElement)) throw new Error('generic_draggable_template is missing');
    const panel = /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
    panel.id = PANEL_ID;
    panel.classList.add('gpp-panel');
    panel.setAttribute('forChar', PANEL_ID);
    panel.style.opacity = '0';
    panel.style.backgroundColor = 'var(--SmartThemeBlurTintColor)';
    panel.querySelector('.drag-grabber').id = `${PANEL_ID}header`;
    const closeButton = panel.querySelector('.dragClose');
    closeButton.id = `${PANEL_ID}close`;
    closeButton.setAttribute('data-related-id', PANEL_ID);
    panel.querySelector('.dragTitle').classList.add('flex-container', 'alignItemsBaseline');
    panel.querySelector('.dragTitle').append(h('span', {}, t`Image Gallery`), h('small', { class: 'gpp-title-tag' }, '++'));

    view.panelCtl?.abort();
    view.panelCtl = new AbortController();

    const refs = {};

    // --- folder row
    refs.folderInput = h('input', {
        type: 'text', class: 'text_pole gallery-folder-input flex1', placeholder: t`Folder Name`,
        title: t`Enter a folder name to assign it to this character`, spellcheck: 'false', autocomplete: 'off',
    });
    refs.folderAccept = h('div', { class: 'right_menu_button fa-solid fa-check fa-fw', title: t`Assign this folder to the character`, role: 'button' });
    refs.refreshButton = h('div', { class: 'right_menu_button fa-solid fa-arrows-rotate fa-fw gpp-refresh', title: t`Refresh the gallery and rebuild all thumbnails`, role: 'button' });
    refs.deleteToggle = h('div', { class: 'right_menu_button fa-solid fa-trash fa-fw', title: t`Delete mode`, role: 'button', 'aria-pressed': 'false' });
    refs.folderRestore = h('div', { class: 'right_menu_button fa-solid fa-recycle fa-fw', title: t`Restore the default gallery folder`, role: 'button' });
    const folderRow = h('div', { class: 'gpp-row' }, refs.folderInput, refs.folderAccept, refs.refreshButton, refs.deleteToggle, refs.folderRestore);

    // --- search / sort / side / add row
    refs.search = h('input', { type: 'search', class: 'text_pole gpp-search', placeholder: t`Search by name…`, 'aria-label': t`Search images by name`, spellcheck: 'false', autocomplete: 'off' });
    refs.clearSearch = h('div', { class: 'gpp-clear fa-solid fa-xmark', title: t`Clear search`, role: 'button', hidden: true });
    const searchBox = h('div', { class: 'gpp-searchbox' }, icon('fa-solid fa-magnifying-glass gpp-search-icon'), refs.search, refs.clearSearch);

    refs.sort = h('select', { class: 'gallery-sort-select', 'aria-label': t`Sort order` },
        SORTS.map(s => h('option', { value: s.value }, s.label)));
    refs.sort.value = getSort();
    refs.sideToggle = h('div', { class: 'menu_button menu_button_icon interactable gallery-side-toggle', role: 'button' }, icon('fa-solid fa-right-left fa-fw'));
    refs.addButton = h('div', { class: 'menu_button menu_button_icon interactable', title: t`Add Image`, role: 'button' }, icon('fa-solid fa-plus fa-fw'), h('div', {}, t`Add Image`));
    refs.fileInput = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, style: 'display:none' });
    const toolRow = h('div', { class: 'gpp-row gpp-row-wrap' }, searchBox, refs.sort, refs.sideToggle, refs.addButton);

    // --- grid
    refs.grid = h('div', { class: 'gpp-grid', role: 'list' });
    refs.scroller = h('div', { class: 'gpp-scroller' }, refs.grid);

    // --- pager
    const pagerButton = (classes, label) => h('div', { class: 'menu_button menu_button_icon interactable gallery-page-button', title: label, 'aria-label': label, role: 'button' }, icon(classes));
    refs.first = pagerButton('fa-solid fa-angles-left fa-fw', t`First page`);
    refs.prev = pagerButton('fa-solid fa-chevron-left fa-fw', t`Previous gallery page`);
    refs.next = pagerButton('fa-solid fa-chevron-right fa-fw', t`Next gallery page`);
    refs.last = pagerButton('fa-solid fa-angles-right fa-fw', t`Last page`);
    refs.pageInput = h('input', {
        type: 'text', inputmode: 'numeric', class: 'text_pole gpp-page-input', value: '1',
        title: t`Type a page number and press Enter to jump to it`, autocomplete: 'off',
    });
    refs.pageTotal = h('span', { class: 'gpp-page-total' }, '/ 1');
    refs.info = h('span', { class: 'gpp-info' });
    const pager = h('div', { class: 'gpp-pager' },
        refs.first, refs.prev,
        h('div', { class: 'gpp-page-jump' }, refs.pageInput, refs.pageTotal),
        refs.next, refs.last, refs.info);

    panel.append(folderRow, toolRow, refs.scroller, pager, refs.fileInput);
    view.refs = refs;
    wirePanel(panel, view.panelCtl.signal);
    return panel;
}

function updateSideToggle() {
    const { sideToggle } = view.refs;
    if (!sideToggle) return;
    const currentSide = view.panel?.dataset.gppSide === 'left' || view.panel?.dataset.gppSide === 'right'
        ? view.panel.dataset.gppSide
        : getSide();
    const right = currentSide === 'right';
    sideToggle.classList.toggle('toggled', right);
    const label = right ? t`Move gallery to the left side` : t`Move gallery to the right side`;
    sideToggle.title = label;
    sideToggle.setAttribute('aria-label', label);
    sideToggle.setAttribute('aria-pressed', String(right));
}

function updateFolderControls() {
    const { folderInput, folderAccept, folderRestore } = view.refs;
    const group = view.kind === 'group';
    folderInput.value = view.folder;
    folderInput.readOnly = group;
    folderInput.title = group ? t`Group galleries use a fixed folder` : t`Enter a folder name to assign it to this character`;
    folderAccept.hidden = group;
    folderRestore.hidden = group;
}

/**
 * Folder-name suggestions: a small self-made dropdown (no jQuery UI, no <datalist>), so picking
 * an entry always assigns that folder. All global listeners bind to `panelSignal` so closing the
 * gallery leaves zero leaked handlers or detached DOM trees.
 */
function wireFolderSuggestions(input, submit, panelSignal) {
    const list = h('div', { class: 'gpp-suggest', role: 'listbox', hidden: true });
    document.body.append(list);
    view.refs.suggest = list;
    let entries = [];
    let active = -1;
    /** @type {Element|null} */
    let activeEl = null;
    let seq = 0;

    const isOpen = () => !list.hidden;
    const close = () => {
        seq++;
        list.hidden = true;
        active = -1;
        activeEl?.classList.remove('gpp-active');
        activeEl = null;
        document.removeEventListener('pointerdown', onOutside, true);
    };
    view.refs.closeSuggest = close;

    const onOutside = (e) => { if (e.target !== input && !list.contains(e.target)) close(); };
    const position = () => {
        const r = input.getBoundingClientRect();
        const spaceBelow = window.innerHeight - r.bottom - 12;
        const spaceAbove = r.top - 12;
        list.style.left = `${Math.round(r.left)}px`;
        list.style.width = `${Math.round(r.width)}px`;
        if (spaceBelow < 140 && spaceAbove > spaceBelow) {
            list.style.top = 'auto';
            list.style.bottom = `${Math.round(window.innerHeight - r.top + 2)}px`;
            list.style.maxHeight = `${Math.max(80, Math.min(260, spaceAbove))}px`;
        } else {
            list.style.bottom = 'auto';
            list.style.top = `${Math.round(r.bottom + 2)}px`;
            list.style.maxHeight = `${Math.max(80, Math.min(260, spaceBelow))}px`;
        }
    };
    const setActive = (index, scroll = false) => {
        if (active === index) return;
        activeEl?.classList.remove('gpp-active');
        active = index;
        activeEl = index >= 0 ? (list.children[index] ?? null) : null;
        activeEl?.classList.add('gpp-active');
        if (scroll) activeEl?.scrollIntoView({ block: 'nearest' });
    };
    const choose = (name) => {
        input.value = name;
        close();
        submit();
    };
    const render = () => {
        active = -1;
        activeEl = null;
        list.replaceChildren(...entries.map((name, i) => {
            const item = h('div', { class: `gpp-suggest-item${name === view.folder ? ' gpp-current' : ''}`, role: 'option', title: name }, name);
            item.addEventListener('mousedown', (e) => e.preventDefault()); // keep the input focused
            item.addEventListener('click', () => choose(name));
            item.addEventListener('mousemove', () => setActive(i, false));
            return item;
        }));
        if (!entries.length) { close(); return; }
        position();
        if (!isOpen()) {
            list.hidden = false;
            document.addEventListener('pointerdown', onOutside, { capture: true, signal: panelSignal });
        }
    };
    const open = async (filter) => {
        if (input.readOnly || panelSignal.aborted) return;
        const mine = ++seq;
        const all = await getAllFolders();
        if (mine !== seq || panelSignal.aborted || document.activeElement !== input) return;
        const term = String(filter ?? '').trim().toLowerCase();
        entries = all.filter(f => !term || f.toLowerCase().includes(term));
        render();
    };

    input.addEventListener('focus', () => void open(''));
    input.addEventListener('click', () => { if (!isOpen()) void open(''); });
    input.addEventListener('input', () => void open(input.value));
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 150));
    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (!isOpen()) { void open(''); e.preventDefault(); return; }
            e.preventDefault();
            const n = entries.length;
            if (n) setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n, true);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (isOpen() && active >= 0 && entries[active] !== undefined) choose(entries[active]);
            else { close(); submit(); }
        } else if (e.key === 'Escape' && isOpen()) {
            e.preventDefault();
            close();
        }
    });
    window.addEventListener('resize', close, { signal: panelSignal });
    panelSignal.addEventListener('abort', close, { once: true });
    list.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
}

function wirePanel(panel, panelSignal) {
    const r = view.refs;

    // Pager
    r.first.addEventListener('click', () => goToPage(1));
    r.prev.addEventListener('click', () => goToPage(view.page - 1));
    r.next.addEventListener('click', () => goToPage(view.page + 1));
    r.last.addEventListener('click', () => goToPage(Number.MAX_SAFE_INTEGER));
    r.pageInput.addEventListener('focus', () => r.pageInput.select());
    r.pageInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commitPageInput(); r.pageInput.select(); }
        else if (e.key === 'Escape') { r.pageInput.value = String(view.page); r.pageInput.blur(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); goToPage(view.page + 1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); goToPage(view.page - 1); }
    });
    r.pageInput.addEventListener('blur', commitPageInput);

    // Search
    const runSearch = debounce(() => setQuery(r.search.value), SEARCH_DEBOUNCE_MS);
    panelSignal.addEventListener('abort', () => runSearch.cancel(), { once: true });
    r.search.addEventListener('input', () => { r.clearSearch.hidden = r.search.value === ''; runSearch(); });
    r.search.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape' && r.search.value) { e.preventDefault(); runSearch.cancel(); setQuery(''); }
        else if (e.key === 'Enter') { runSearch.cancel(); setQuery(r.search.value); }
    });
    r.clearSearch.addEventListener('click', () => { runSearch.cancel(); setQuery(''); r.search.focus(); });

    // Sort / side / upload
    r.sort.addEventListener('change', () => { setSort(r.sort.value); void loadFolder({ revalidate: false }); });
    updateSideToggle();
    r.sideToggle.addEventListener('click', () => {
        const current = panel.dataset.gppSide === 'left' || panel.dataset.gppSide === 'right' ? panel.dataset.gppSide : getSide();
        const next = current === 'right' ? 'left' : 'right';
        setSide(next);
        panel.dataset.gppSide = next;
        updateSideToggle();
        fitPanel(true);
    });
    r.addButton.addEventListener('click', () => r.fileInput.click());
    r.fileInput.addEventListener('change', async () => {
        const files = [...r.fileInput.files];
        r.fileInput.value = ''; // lets the same file be chosen again
        if (files.length) await uploadFiles(files);
    });

    // Folder assignment
    const submitFolder = () => void applyFolderChoice(r.folderInput.value);
    r.folderAccept.addEventListener('click', submitFolder);
    r.folderRestore.addEventListener('click', () => void restoreDefaultFolder());
    r.refreshButton.addEventListener('click', () => void refreshGallery());
    r.deleteToggle.addEventListener('click', () => setDeleteMode(!view.deleteMode));
    wireFolderSuggestions(r.folderInput, submitFolder, panelSignal);

    // Grid: left-click → left window, right-click → right window, Enter/Space like left-click.
    r.grid.addEventListener('click', (e) => onTileActivate(e, 'left'));
    r.grid.addEventListener('contextmenu', (e) => onTileActivate(e, 'right'));
    r.grid.addEventListener('dragstart', (e) => e.preventDefault());
    r.grid.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (!(e.target instanceof HTMLElement) || !e.target.classList.contains('gpp-tile')) return;
        e.preventDefault();
        onTileActivate(e, e.shiftKey ? 'right' : 'left');
    });

    // Drag & drop upload. Native listeners on the panel die with it (no leaked handlers).
    const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    let depth = 0;
    const resetDrop = () => { depth = 0; panel.classList.remove('gpp-dropping'); };
    panel.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); depth++; panel.classList.add('gpp-dropping'); });
    panel.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; });
    panel.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) panel.classList.remove('gpp-dropping'); });
    panel.addEventListener('dragend', resetDrop);
    panel.addEventListener('pointerenter', () => { if (depth > 0) resetDrop(); });
    window.addEventListener('dragend', resetDrop, { signal: panelSignal });
    window.addEventListener('drop', resetDrop, { signal: panelSignal });
    panel.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); e.stopPropagation();
        resetDrop();
        const files = [...e.dataTransfer.files];
        if (files.length) void uploadFiles(files);
    });
}

function commitPageInput() {
    const { pageInput } = view.refs;
    if (!pageInput) return;
    const pages = pageCount(view.filtered.length, view.pageSize);
    const parsed = parsePageInput(pageInput.value, pages);
    if (parsed === null) { pageInput.value = String(view.page); return; }
    goToPage(parsed);
    pageInput.value = String(view.page);
}

function setDeleteMode(on) {
    view.deleteMode = Boolean(on);
    view.refs.deleteToggle.classList.toggle('warning', view.deleteMode);
    view.refs.deleteToggle.setAttribute('aria-pressed', String(view.deleteMode));
    view.panel.classList.toggle('gpp-delete-mode', view.deleteMode);
    if (view.deleteMode) toastr.info(t`Delete mode is ON. Click on images you want to delete.`);
}

// ------------------------------------------------------------------------------- actions

/** @param {Event} event @param {'left'|'right'} side */
function onTileActivate(event, side) {
    const el = event.target instanceof Element ? event.target.closest('.gpp-tile') : null;
    if (!el) return;
    const tile = view.tiles.get(/** @type {HTMLElement} */ (el));
    if (!tile) return;
    event.preventDefault();
    if (view.deleteMode) void deleteItem(tile.item);
    else openMedia(tile.item, side);
}

async function deleteItem(item) {
    if (inFlightDeletes.has(item.path)) return;
    inFlightDeletes.add(item.path);
    const folder = view.folder;
    try {
        const confirmed = await Popup.show.confirm(t`Are you sure you want to delete this image?`, item.path);
        if (!confirmed) return;
        const deleted = await deleteMediaFromServer(item.path, false);
        if (!deleted) return;
        toastr.success(t`Image deleted successfully.`);
        void purgeThumbnail(item.url);
        $(`.galleryImageDraggable[data-src="${CSS.escape(item.url)}"] .dragClose`).each((_, btn) => forceClose(btn));
        // Update locally only if the same folder is still open.
        if (view.panel && view.folder === folder) {
            view.items = view.items.filter(i => i.path !== item.path);
            applyFilter();
            renderPage();
        }
    } finally {
        inFlightDeletes.delete(item.path);
    }
}

async function uploadFiles(files) {
    if (view.uploading || !view.panel) return;
    const accepted = files.filter(f => /^(image|video)\//.test(f.type) || isVideoName(f.name, VIDEO_EXT_SET) || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(f.name));
    if (accepted.length === 0) { toastr.warning(t`Only image and video files can be uploaded.`); return; }

    view.uploading = true;
    view.panel.classList.add('gpp-busy');
    const folder = view.folder;
    const before = new Set(view.items.map(i => i.path));
    let ok = 0;
    let failed = 0;
    try {
        let nextIndex = 0;
        const workerCount = Math.min(UPLOAD_CONCURRENCY, accepted.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (nextIndex < accepted.length) {
                const file = accepted[nextIndex++];
                try {
                    const dataUrl = await getBase64Async(file);
                    const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
                    if (comma < 0) throw new Error('Invalid base64 data URL');
                    const base64 = dataUrl.slice(comma + 1);
                    await saveBase64AsFile(base64, folder, '', getFileExtension(file));
                    ok++;
                } catch (error) {
                    failed++;
                    console.error('[Gallery++] Upload failed:', error);
                }
            }
        });
        await Promise.all(workers);
    } finally {
        view.uploading = false;
        if (!ok || !view.panel || view.folder !== folder) {
            view.panel?.classList.remove('gpp-busy');
        }
    }
    if (ok) {
        foldersCache = { time: 0, list: null };
        toastr.success(ok === 1 ? t`Uploaded 1 file.` : t`Uploaded ${ok} files.`);
    }
    if (failed) toastr.error(failed === 1 ? t`Failed to upload 1 file.` : t`Failed to upload ${failed} files.`);
    if (ok && view.panel && view.folder === folder) {
        await loadFolder({ previousPaths: before, revalidate: false });
    }
}

let refreshing = false;

/** Re-lists the folder and throws away every cached thumbnail under it so all of them rebuild from disk. */
async function refreshGallery() {
    if (!view.panel || refreshing) return;
    refreshing = true;
    const button = view.refs.refreshButton;
    button.classList.add('fa-spin', 'disabled');
    const folder = view.folder;
    try {
        view.renderCtl?.abort(); // stop thumbnail work for the old tiles
        const safe = await sanitizeFolder(folder);
        await purgeFolderThumbnails(`${encodePath(`user/images/${safe}`)}/`);
        for (const key of [...aspectCache.keys()]) {
            if (key.startsWith(`${folder}|`)) aspectCache.delete(key);
        }
        deleteAspectHint(folder);
        foldersCache = { time: 0, list: null };
        if (!view.panel || view.folder !== folder) return; // character/folder changed during purge
        await loadFolder({ keepPage: true, revalidate: true });
        if (view.panel && view.folder === folder && view.status === 'ready') toastr.success(t`Gallery refreshed`);
    } finally {
        refreshing = false;
        button.classList.remove('fa-spin', 'disabled');
    }
}

let folderBusy = false;

function resetViewForFolderSwitch(nextFolder) {
    view.folder = nextFolder;
    view.items = [];
    view.filtered = [];
    view.status = 'loading';
    view.query = '';
    view.queryTokensKey = '';
    if (view.refs.search) view.refs.search.value = '';
    if (view.refs.clearSearch) view.refs.clearSearch.hidden = true;
    updateFolderControls();
}

async function applyFolderChoice(requested) {
    if (!view.panel || folderBusy) return;
    const target = getTarget();
    const name = String(requested ?? '').trim();
    if (!name) { toastr.warning(t`Folder name cannot be empty`); return; }
    folderBusy = true;
    try {
        if (!target || target.kind !== 'char') throw new Error(target?.kind === 'group' ? 'Cannot change gallery folder in group chat' : 'Character is not selected');
        const { character } = target;
        if (!character.avatar) throw new Error('Character PNG ID is not found');

        // Use the exact spelling of an existing folder (matters on case-sensitive file systems).
        const existing = await getAllFolders();
        const wanted = existing.find(f => f.toLowerCase() === name.toLowerCase()) ?? name;

        const [safe, safeDefault] = await Promise.all([sanitizeFolder(wanted), sanitizeFolder(character.name)]);
        const stillSame = getTarget()?.character?.avatar === character.avatar;
        if (!stillSame || !view.panel) return; // the user switched character while we were waiting

        const isDefault = safe === safeDefault;
        setFolderOverride(character.avatar, isDefault ? null : safe);
        const nextFolder = isDefault ? character.name : safe;
        foldersCache = { time: 0, list: null };
        if (nextFolder === view.folder) {
            updateFolderControls();
            toastr.info(t`This gallery is already showing the folder ${nextFolder}`);
            return;
        }
        resetViewForFolderSwitch(nextFolder);
        await loadFolder({ revalidate: true });
        if (view.panel && view.folder === nextFolder && view.status === 'ready') {
            toastr.info(t`Gallery folder changed to ${nextFolder}`);
        }
    } catch (error) {
        console.error('[Gallery++] Failed to change gallery folder:', error);
        toastr.error(error?.message || t`Unknown error`, t`Failed to change gallery folder`);
    } finally {
        folderBusy = false;
    }
}

async function restoreDefaultFolder() {
    if (!view.panel || folderBusy) return;
    const target = getTarget();
    if (!target || target.kind !== 'char') return;
    if (!getFolderOverride(target.character.avatar)) { toastr.info(t`This character already uses its default folder.`); return; }
    folderBusy = true;
    try {
        setFolderOverride(target.character.avatar, null);
        resetViewForFolderSwitch(target.character.name);
        await loadFolder({ revalidate: true });
    } finally {
        folderBusy = false;
    }
}

// ------------------------------------------------------------------------------- open / close

async function openGallery() {
    if (openingPromise) return openingPromise;
    openingPromise = openGalleryImpl().finally(() => { openingPromise = null; });
    return openingPromise;
}

async function openGalleryImpl() {
    const target = getTarget();
    if (!target) { toastr.info(t`Select a character or group to open its gallery.`); return; }

    if (view.panel?.isConnected) {
        // Already open: follow the current chat, or just refresh the listing.
        if (!(await syncToContext())) await loadFolder({ keepPage: true, revalidate: true });
        return;
    }
    // A previous window may still be fading out; two elements with one id would break dragging.
    document.getElementById(PANEL_ID)?.remove();
    view.panel = null;
    view.fit = null;
    view.lastFitKey = '';
    view.autoRatio = null;
    view.kind = target.kind;
    view.folder = target.folder;
    view.items = [];
    view.filtered = [];
    view.query = '';
    view.queryTokensKey = '';
    view.page = 1;
    view.status = 'loading';
    view.deleteMode = false;

    let panel;
    try {
        panel = buildPanel();
    } catch (error) {
        console.error('[Gallery++] Could not build the gallery window:', error);
        toastr.error(t`Failed to load the gallery.`);
        return;
    }
    view.panel = panel;
    view.revealed = false;
    view.renderedBucket = 0;
    updateFolderControls();
    const shapeKnown = getLayout().aspect !== 'auto' || primeAspect();
    applyLayoutVariables();

    document.getElementById('movingDivs').append(panel);
    raiseGalleryWindow(panel);
    if (isMobileLayout()) {
        panel.dataset.gppMode = 'mobile';
        applySavedWindowState(panel);
    } else {
        panel.dataset.gppMode = 'desktop';
        panel.dataset.gppSide = getSide();
    }
    dragElement($(panel));

    // loadFolder() synchronously renders the initial loading state and fits the window once.
    const loadPromise = loadFolder({ revalidate: true });
    if (shapeKnown) {
        revealPanel();
    } else {
        setTimeout(() => { if (view.panel === panel) revealPanel(); }, REVEAL_TIMEOUT_MS + 600);
    }
    await loadPromise;
}

function closeGallery() {
    const panel = view.panel;
    if (!panel) return;
    view.token++;
    view.loadCtl?.abort();
    view.panelCtl?.abort();
    view.panelCtl = null;
    disposeTiles();
    view.refs.suggest?.remove();
    view.panel = null;
    view.refs = {};
    view.fit = null;
    view.lastFitKey = '';
    view.renderedBucket = 0;
    view.items = [];
    view.filtered = [];
    if (panel.isConnected) fadeRemove(panel);
}

function toggleGallery() {
    if (view.panel?.isConnected) closeGallery();
    else void openGallery();
}

/**
 * Called when the active chat changes: follow the new character/group in place.
 * @returns {Promise<boolean>} true when the window switched to a different folder (or closed)
 */
async function syncToContext() {
    if (!view.panel) return false;
    const target = getTarget();
    if (!target) { closeGallery(); return true; }
    if (target.kind === view.kind && target.folder === view.folder) return false;
    view.kind = target.kind;
    resetViewForFolderSwitch(target.folder);
    await loadFolder({ revalidate: true });
    return true;
}

// ------------------------------------------------------------------------------- media windows

/** @param {GalleryItem} item @param {'left'|'right'} side */
function openMedia(item, side) {
    const existing = document.querySelector(`.galleryImageDraggable[data-src="${CSS.escape(item.url)}"]`);
    if (existing instanceof HTMLElement) {
        // Same picture already open: move it to the requested side instead of stacking duplicates.
        fitImageWindow(existing, side);
        raiseGalleryWindow(existing);
        existing.classList.add('gpp-flash');
        setTimeout(() => existing.classList.remove('gpp-flash'), 600);
        return;
    }

    const template = document.getElementById('generic_draggable_template');
    if (!(template instanceof HTMLTemplateElement)) return;
    const win = /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));

    const stem = baseName(item.path).replace(/\.[^.]+$/, '');
    const baseId = `draggable_${sanitizeHTMLId(stem)}`;
    let id = baseId;
    for (let n = 1; document.getElementById(id); n++) id = `${baseId}_${n}`;

    win.id = id;
    win.classList.add('galleryImageDraggable');
    win.dataset.src = item.url;
    win.style.display = 'block';
    win.style.padding = '0';
    win.style.opacity = '0';
    // Stay invisible (and un-clickable) until the real picture size is known, so the user never sees
    // a placeholder-sized window that then jumps to its final size.
    win.style.visibility = 'hidden';
    win.querySelector('.drag-grabber').id = `${id}header`;
    const close = win.querySelector('.dragClose');
    close.id = `${id}close`;
    close.setAttribute('data-related-id', id);

    const media = item.video ? document.createElement('video') : document.createElement('img');
    media.draggable = false;
    if (media instanceof HTMLVideoElement) {
        media.controls = true;
        media.autoplay = true;
        media.loop = true;
        if (getBoolean('muteVideos')) {
            media.muted = true;
            media.defaultMuted = true;
        }
    }

    let shown = false;
    let fallbackTimer = 0;
    const reveal = () => {
        clearTimeout(fallbackTimer);
        if (shown || !win.isConnected) return;
        shown = true;
        win.style.visibility = '';
        fadeIn(win);
    };
    const fit = () => {
        const w = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
        const hgt = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
        if (!w || !hgt) { reveal(); return; }
        win.dataset.gppW = String(w);
        win.dataset.gppH = String(hgt);
        fitImageWindow(win, win.dataset.gppSide === 'left' ? 'left' : 'right');
        reveal();
    };
    media.addEventListener(media instanceof HTMLVideoElement ? 'loadedmetadata' : 'load', fit, { once: true });
    media.addEventListener('error', reveal, { once: true }); // broken file: show the (default-sized) window anyway
    media.src = item.url;

    win.append(media);
    document.getElementById('movingDivs').append(win);
    raiseGalleryWindow(win);

    if (isMobileLayout()) {
        win.dataset.gppMode = 'mobile';
        applySavedWindowState(win);
    }
    win.dataset.gppSide = side;
    fallbackTimer = setTimeout(reveal, 3000); // safety net for a very slow server

    dragElement($(win));
    fitImageWindow(win, side); // provisional placement while hidden
    if ((media instanceof HTMLImageElement && media.complete) || (media instanceof HTMLVideoElement && media.readyState >= 1)) fit();
}

/** Closes a window through its close button on purpose (bypasses the Escape guard below). */
function forceClose(button) {
    allowSyntheticClose = true;
    try { $(button).trigger('click'); } finally { allowSyntheticClose = false; }
}

function closeAllImages() {
    document.querySelectorAll('.galleryImageDraggable .dragClose').forEach(btn => forceClose(btn));
}

// ------------------------------------------------------------------------------- Escape guard
//
// SillyTavern closes floating windows when Escape is pressed, by "clicking" their close button from script.
// That click is not a real mouse click, so Gallery++ can tell it apart and refuse it when it should not
// close anything:
//   - the "Escape does not close pictures / gallery" option is on, or
//   - Escape was used for something else: cancelling a message edit, closing a popup, or leaving a text field.
// SillyTavern removes the edit box while handling the same key press, so the state is captured *before*
// SillyTavern sees the event (capture phase on window).

const ESCAPE_WINDOW_MS = 400;
let lastEscape = { time: 0, protect: false };
let allowSyntheticClose = false;

function escapeIsForSomethingElse() {
    if (document.querySelector('#curEditTextarea')) return true; // editing a chat message
    if (Popup.util.isPopupOpen()) return true; // dismissing a confirmation / modal dialog
    return isTyping();
}

function onEscapeCapture(event) {
    if (event.key !== 'Escape') return;
    if (event.repeat) {
        // Keep the initial protection active while Escape is held down.
        lastEscape.time = performance.now();
        return;
    }
    lastEscape = {
        time: performance.now(),
        protect: getBoolean('escKeepsOpen') || escapeIsForSomethingElse(),
    };
}

/** True when this close-button click should be ignored. */
function shouldBlockClose(event) {
    if (allowSyntheticClose) return false;
    if (event.originalEvent?.isTrusted) return false; // a real click by the user
    return lastEscape.protect && performance.now() - lastEscape.time < ESCAPE_WINDOW_MS;
}

/** Frame and close button of opened pictures appear only on hover (see style.css). */
function applyPictureStyle() {
    document.body.classList.toggle('gpp-clean-pictures', getBoolean('cleanPictures'));
}

/** Mutes any currently opened gallery videos when auto-mute is enabled. */
function applyVideoMuteSetting() {
    if (!getBoolean('muteVideos')) return;
    document.querySelectorAll('.galleryImageDraggable video').forEach((video) => {
        if (video instanceof HTMLVideoElement) video.muted = true;
    });
}

// ------------------------------------------------------------------------------- hotkeys

function isTyping() {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return false;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
        || el.isContentEditable || Boolean(el.closest('[contenteditable="true"]'));
}

function onHotkey(event) {
    // Check the key first so normal typing across SillyTavern does zero settings lookups.
    if (!HOTKEY_SET.has(event.key)) return;
    if (event.isComposing || event.defaultPrevented || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if (!getBoolean('hotkeys')) return;
    if (isTyping() || Popup.util.isPopupOpen()) return;

    switch (event.key) {
        case '\\': toggleGallery(); break;
        case '=': closeAllImages(); break;
        case '[': if (!view.panel) return; goToPage(view.page - 1); break;
        case ']': if (!view.panel) return; goToPage(view.page + 1); break;
        default: return;
    }
    event.preventDefault();
}

// ------------------------------------------------------------------------------- Extensions-tab settings

function mountSettings() {
    if (document.getElementById('gpp_settings')) return;
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) { console.warn('[Gallery++] Extensions settings container not found'); return; }

    const inputs = {};
    const summary = h('small', { class: 'gpp-settings-summary' });

    const refreshSummary = () => {
        const l = getLayout();
        const pSize = l.portraitRows * l.portraitCols;
        const lSize = l.landscapeRows * l.landscapeCols;
        const shape = l.aspect === 'auto' ? t`shape detected per gallery` : t`${l.aspect} shape`;
        summary.textContent = t`Portrait: ${pSize}/page (${l.portraitCols}×${l.portraitRows}) · Landscape: ${lSize}/page (${l.landscapeCols}×${l.landscapeRows}), ${shape}. Pictures are sized to fit beside the chat.`;
    };

    const fieldDebouncers = [];
    const numberField = (key, label, unit) => {
        const { min, max } = LAYOUT_LIMITS[key];
        const applyOne = debounce(() => {
            if (inputs[key].value.trim() === '') return; // still typing
            const value = clampInt(inputs[key].value, min, max, LAYOUT_DEFAULTS[key]);
            setLayout({ [key]: value });
            refreshSummary();
            applyLayoutToOpenGallery();
        }, 250);
        fieldDebouncers.push(applyOne);
        inputs[key] = h('input', { type: 'number', class: 'text_pole gpp-number', min, max, step: 1, value: String(getLayout()[key]), 'aria-label': label });
        inputs[key].addEventListener('input', applyOne);
        inputs[key].addEventListener('change', () => {
            applyOne.cancel();
            const normalized = clampInt(inputs[key].value, min, max, LAYOUT_DEFAULTS[key]);
            inputs[key].value = String(normalized); // show the corrected value
            setLayout({ [key]: normalized });
            refreshSummary();
            applyLayoutToOpenGallery();
        });
        return h('label', { class: 'gpp-field' },
            h('span', {}, label), h('span', { class: 'gpp-field-input' }, inputs[key], unit ? h('small', {}, unit) : null),
            h('small', { class: 'gpp-range' }, `${min}–${max}`));
    };

    const aspectField = () => {
        const select = h('select', { class: 'text_pole gpp-select', 'aria-label': t`Picture shape` });
        select.append(h('option', { value: 'auto' }, t`Auto (match each gallery)`),
            ...ASPECT_PRESETS.map(p => h('option', { value: p.value }, p.label)));
        select.value = getLayout().aspect;
        select.addEventListener('change', () => {
            setLayout({ aspect: select.value });
            refreshSummary();
            applyLayoutToOpenGallery();
        });
        inputs.aspect = select;
        return h('label', { class: 'gpp-field' }, h('span', {}, t`Picture shape`), select, h('small', { class: 'gpp-range' }, t`width : height`));
    };

    const checkbox = (key, label) => {
        const input = h('input', { type: 'checkbox', checked: getBoolean(key) });
        input.addEventListener('change', () => {
            setBoolean(key, input.checked);
            if (key === 'showNames' && view.panel) view.refs.grid.classList.toggle('gpp-show-names', input.checked);
            if (key === 'cleanPictures') applyPictureStyle();
            if (key === 'muteVideos') applyVideoMuteSetting();
        });
        return h('label', { class: 'checkbox_label' }, input, h('span', {}, label));
    };

    const resetButton = h('div', { class: 'menu_button menu_button_icon interactable', role: 'button' }, icon('fa-solid fa-rotate-left'), h('span', {}, t`Reset layout`));
    resetButton.addEventListener('click', () => {
        for (const fn of fieldDebouncers) fn.cancel();
        const layout = resetLayout();
        for (const key of Object.keys(layout)) inputs[key].value = String(layout[key]);
        refreshSummary();
        applyLayoutToOpenGallery();
    });
    const clearButton = h('div', { class: 'menu_button menu_button_icon interactable', role: 'button', title: t`Thumbnails are regenerated the next time you open a folder` }, icon('fa-solid fa-broom'), h('span', {}, t`Clear thumbnail cache`));
    clearButton.addEventListener('click', async () => {
        view.renderCtl?.abort();
        const removed = await clearThumbnailCache();
        toastr.success(t`Thumbnail cache cleared (${removed})`);
        if (view.panel) renderPage();
    });
    const openButton = h('div', { class: 'menu_button menu_button_icon interactable', role: 'button' }, icon('fa-solid fa-sd-card'), h('span', {}, t`Open gallery`));
    openButton.addEventListener('click', () => void openGallery());

    const content = h('div', { class: 'inline-drawer-content' },
        h('div', { class: 'gpp-settings-section-label' }, t`Portrait grid`),
        h('div', { class: 'gpp-settings-grid gpp-settings-pair' },
            numberField('portraitRows', t`Rows per page`),
            numberField('portraitCols', t`Columns per page`)),
        h('div', { class: 'gpp-settings-section-label' }, t`Landscape grid`),
        h('div', { class: 'gpp-settings-grid gpp-settings-pair' },
            numberField('landscapeRows', t`Rows per page`),
            numberField('landscapeCols', t`Columns per page`)),
        h('div', { class: 'gpp-settings-grid' },
            aspectField()),
        summary,
        checkbox('showNames', t`Always show file names on pictures`),
        checkbox('cleanPictures', t`Clean opened pictures: window frame and close button only show on hover (better for transparent images)`),
        checkbox('muteVideos', t`Automatically mute videos`),
        checkbox('escKeepsOpen', t`Esc never closes opened pictures or the gallery`),
        checkbox('hotkeys', t`Keyboard shortcuts:  [  ]  page ·  \\  toggle ·  =  close pictures`),
        h('div', { class: 'flex-container gpp-settings-buttons' }, openButton, resetButton, clearButton));

    const drawer = h('div', { id: 'gpp_settings', class: 'gpp-settings' },
        h('div', { class: 'inline-drawer' },
            h('div', { class: 'inline-drawer-toggle inline-drawer-header' },
                h('b', {}, 'Gallery++'),
                h('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' })),
            content));
    host.append(drawer);
    refreshSummary();
}

// ------------------------------------------------------------------------------- slash commands

function registerCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'show-gallery',
        aliases: ['sg'],
        callback: () => { void openGallery(); return ''; },
        helpString: 'Shows the gallery.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'list-gallery',
        aliases: ['lg'],
        callback: listGalleryCommand,
        returns: 'list of images',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'char', description: 'character name', typeList: [ARGUMENT_TYPE.STRING], enumProvider: commonEnumProviders.characters('character') }),
            SlashCommandNamedArgument.fromProps({ name: 'group', description: 'group name', typeList: [ARGUMENT_TYPE.STRING], enumProvider: commonEnumProviders.characters('group') }),
        ],
        helpString: 'List images in the gallery of the current char / group or a specified char / group.',
    }));
}

async function listGalleryCommand(args) {
    try {
        const ctx = SillyTavern.getContext();
        let folder;
        if (args.char) {
            const character = ctx.characters?.find(c => c.name === args.char);
            folder = character ? resolveCharacterFolder(character) : args.char;
        } else if (args.group) {
            folder = ctx.groups?.find(g => g.name === args.group || String(g.id) === String(args.group))?.id;
        } else {
            folder = getTarget()?.folder;
        }
        if (!folder) return JSON.stringify([]);
        const items = await fetchItems(String(folder));
        return JSON.stringify(items.map(i => i.path));
    } catch (error) {
        console.error('[Gallery++]', error);
        return JSON.stringify([]);
    }
}

// ------------------------------------------------------------------------------- menu entries

function addMenuEntries() {
    const dropdown = document.getElementById('char-management-dropdown');
    if (dropdown && !document.getElementById('gpp_show_gallery_option')) {
        dropdown.append(h('option', { id: 'gpp_show_gallery_option' }, `${translate('Show Gallery')}++`));
    }
    const wand = document.getElementById('gallery_wand_container') ?? document.getElementById('extensionsMenu');
    if (wand && !document.getElementById('gpp_wand_button')) {
        const button = h('div', { id: 'gpp_wand_button', class: 'list-group-item flex-container flexGap5' },
            h('div', { class: 'fa-solid fa-sd-card extensionsMenuExtensionButton' }), h('span', {}, `${translate('Show Gallery')}++`));
        button.addEventListener('click', () => void openGallery());
        wand.append(button);
    }
}

// ------------------------------------------------------------------------------- bootstrap & cleanup

async function detectUserScope() {
    try {
        const mod = await import('../../../user.js');
        if (typeof mod?.currentUser?.handle === 'string' && mod.currentUser.handle) {
            return mod.currentUser.handle;
        }
    } catch { /* single-user or custom host */ }
    return null;
}

export async function init() {
    if (initialized) return;
    initialized = true;

    const userScope = await detectUserScope();
    activeUserScope = userScope;
    configureSettings({
        getRoot: () => SillyTavern.getContext().extensionSettings,
        saveDebounced: () => SillyTavern.getContext().saveSettingsDebounced(),
        saveNow: typeof ST.saveSettings === 'function' ? () => ST.saveSettings() : undefined,
        storage: (() => { try { return window.localStorage; } catch { return null; } })(),
        userScope,
    });
    configureThumbs({ userScope });
    getSettings(); // validates, migrates from the original Gallery, and restores folder assignments

    initCtl?.abort();
    initCtl = new AbortController();
    const { signal } = initCtl;

    const movingDivs = document.getElementById('movingDivs');

    // Closing windows. ST has no global handler for generic draggables.
    $('#movingDivs').off('.gpp').on('click.gpp', '.gpp-panel .dragClose, .galleryImageDraggable .dragClose', function (event) {
        if (shouldBlockClose(event)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        const target = $(this).closest('.draggable')[0];
        if (!target) return;
        if (target === view.panel) closeGallery();
        else fadeRemove(target);
    });

    // Track drags and active focus strictly on gallery / opened picture windows (never on unrelated ST clicks).
    let draggingGalleryWindow = false;
    const onMovingPointerDown = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const win = target.closest('#gallery, .galleryImageDraggable');
        if (win instanceof HTMLElement) raiseGalleryWindow(win);
        if (target.closest('#gallery .drag-grabber, .galleryImageDraggable .drag-grabber')) {
            draggingGalleryWindow = true;
            view.refs.closeSuggest?.();
        }
    };
    const onDragEnd = () => {
        if (!draggingGalleryWindow) return;
        draggingGalleryWindow = false;
        setTimeout(rememberDraggedSides, 0);
    };
    movingDivs?.addEventListener('pointerdown', onMovingPointerDown, { passive: true, signal });
    document.addEventListener('pointerup', onDragEnd, { passive: true, signal });
    document.addEventListener('pointercancel', onDragEnd, { passive: true, signal });

    document.addEventListener('keydown', onHotkey, { signal });
    window.addEventListener('keydown', onEscapeCapture, { capture: true, signal });
    applyPictureStyle();

    // Keep every gallery window fitted beside the chat panel when the screen or chat width changes.
    refitDebounced = debounce(fitAllWindows, 60);
    window.addEventListener('resize', refitDebounced, { signal });
    const sheld = document.getElementById('sheld');
    if (sheld && typeof ResizeObserver === 'function') {
        sheldObserver = new ResizeObserver(refitDebounced);
        sheldObserver.observe(sheld);
    }

    const bindEvent = (type, fn) => {
        eventSource.on(type, fn);
        eventHandlers.push([type, fn]);
    };
    bindEvent(event_types.CHAT_CHANGED, () => void syncToContext());
    bindEvent(event_types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => renameAvatar(oldAvatar, newAvatar));
    bindEvent(event_types.CHARACTER_DELETED, (data) => removeAvatar(data?.character?.avatar));
    bindEvent(event_types.CHARACTER_MANAGEMENT_DROPDOWN, (id) => { if (id === 'gpp_show_gallery_option') void openGallery(); });

    registerCommands();
    addMenuEntries();
    mountSettings();
}

/** SillyTavern 1.17+ lifecycle hook: removes listeners, UI nodes, and cached browser data on cleanup/uninstall. */
export async function clean() {
    closeGallery();
    closeAllImages();

    initCtl?.abort();
    initCtl = null;
    refitDebounced?.cancel();
    refitDebounced = null;
    sheldObserver?.disconnect();
    sheldObserver = null;
    try { $('#movingDivs').off('.gpp'); } catch { /* ignore */ }
    for (const [type, fn] of eventHandlers) {
        if (typeof eventSource.removeListener === 'function') eventSource.removeListener(type, fn);
        else if (typeof eventSource.off === 'function') eventSource.off(type, fn);
    }
    eventHandlers = [];

    document.getElementById('gpp_settings')?.remove();
    document.getElementById('gpp_show_gallery_option')?.remove();
    document.getElementById('gpp_wand_button')?.remove();
    document.body.classList.remove('gpp-clean-pictures');

    sanitizedCache.clear();
    aspectCache.clear();
    inFlightDeletes.clear();
    foldersCache = { time: 0, list: null };
    foldersInFlight = null;
    openingPromise = null;
    lastViewportSig = '';

    clearLocalBackup();
    try { window.localStorage.removeItem(getAspectHintsKey()); } catch { /* ignore */ }
    await deleteThumbnailDatabase();
    activeUserScope = null;
    initialized = false;
}