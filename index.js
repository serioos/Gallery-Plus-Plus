/*
 * Gallery++ 2.0 — a from-scratch rewrite of SillyTavern's Gallery extension.
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
    filterByName, fitTile, isVideoName, pageCount, pageForIndex, pageSlice, parseAspect, parsePageInput, sanitizeHTMLId,
    thumbBucket,
} from './lib.js';
import {
    configureSettings, getBoolean, getLayout, getSettings, getSide, getSort, removeAvatar, renameAvatar,
    resetLayout, resolveCharacterFolder, setBoolean, setFolderOverride, setLayout, setSide, setSort,
    getFolderOverride,
} from './settings.js';
import { clearThumbnailCache, getThumbnail, invalidateThumbnailChecks, isThumbnailVerified, peekThumbnail, purgeThumbnail, purgeThumbnails } from './thumbs.js';

// ------------------------------------------------------------------------------- constants

const PANEL_ID = 'gallery'; // same id as the original extension, so the saved window position carries over
const GRID_GAP = 6;
const GRID_PADDING = 6;
const DEFAULT_TILE_SIDE = 300; // only used to size thumbnails before the first fit has run
const REVEAL_TIMEOUT_MS = 900; // longest a new gallery window waits (hidden) for its final shape
const ASPECT_HINTS_KEY = 'gpp_aspect_hints'; // folder -> detected tile ratio, so reopening is instant
const DEFAULT_RATIO = 2 / 3; // used until a gallery's dominant shape is known
const ASPECT_SAMPLES = 18; // pictures sampled to find a gallery's dominant shape
const MOBILE_BREAKPOINT = 1000;
const SEARCH_DEBOUNCE_MS = 120;
const FOLDERS_CACHE_TTL = 15_000;

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

function fadeRemove(element, onDone) {
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

// ------------------------------------------------------------------------------- state

/**
 * @typedef {{path: string, url: string, name: string, nameLower: string, video: boolean}} GalleryItem
 * @typedef {{el: HTMLElement, img: HTMLImageElement, item: GalleryItem, objectUrl: string|null, blob?: Blob}} Tile
 */

const view = {
    /** @type {HTMLElement|null} */ panel: null,
    /** @type {Record<string, any>} */ refs: {},
    token: 0,
    /** @type {AbortController|null} */ loadCtl: null,
    /** @type {AbortController|null} */ renderCtl: null,
    /** @type {IntersectionObserver|null} */ observer: null,
    kind: /** @type {'char'|'group'} */ ('char'),
    folder: '',
    /** @type {GalleryItem[]} */ items: [],
    /** @type {GalleryItem[]} */ filtered: [],
    query: '',
    page: 1,
    pageSize: 1,
    /** @type {Map<HTMLElement, Tile>} */ tiles: new Map(),
    status: /** @type {'loading'|'ready'|'error'} */ ('loading'),
    deleteMode: false,
    uploading: false,
    /** @type {{tw: number, th: number}|null} */ fit: null,
    /** Thumbnail bucket the tiles on screen were rendered with. */
    renderedBucket: 0,
    rendering: false,
    revealed: false,
    /** Width/height detected for the open gallery (used when the shape option is 'auto'). */
    /** @type {number|null} */ autoRatio: null,
};

let initialized = false;
let foldersCache = { time: 0, list: /** @type {string[]|null} */ (null) };
const sanitizedCache = new Map();

// ------------------------------------------------------------------------------- data access

async function sanitizeFolder(name) {
    const key = String(name);
    if (!sanitizedCache.has(key)) sanitizedCache.set(key, await getSanitizedFilename(key));
    return sanitizedCache.get(key);
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
    return files.map(file => {
        const name = String(file);
        const path = `user/images/${safe}/${name}`;
        return { path, url: encodePath(path), name, nameLower: name.toLowerCase(), video: isVideoName(name, VIDEO_EXTENSIONS) };
    });
}

async function getAllFolders() {
    const now = Date.now();
    if (foldersCache.list && now - foldersCache.time < FOLDERS_CACHE_TTL) return foldersCache.list;
    try {
        const response = await fetch('/api/images/folders', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        foldersCache = { time: now, list: Array.isArray(data) ? data : [] };
    } catch (error) {
        console.error('[Gallery++] Failed to fetch folders:', error);
        foldersCache = { time: 0, list: null };
        return [];
    }
    return foldersCache.list ?? [];
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
 * @param {{keepPage?: boolean, previousPaths?: Set<string>}} [options]
 */
async function loadFolder({ keepPage = false, previousPaths = null } = {}) {
    if (!view.panel) return;
    invalidateThumbnailChecks(); // re-verify cached thumbnails against the server whenever a folder is (re)loaded
    const token = ++view.token;
    view.loadCtl?.abort();
    const ctl = (view.loadCtl = new AbortController());
    if (getLayout().aspect === 'auto') primeAspect();
    view.panel.classList.add('gpp-busy');
    if (view.items.length === 0) { view.status = 'loading'; renderPage(); }

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
            if (index >= 0) view.page = pageForIndex(index, view.pageSize);
        } else if (!keepPage) {
            view.page = 1;
        }
        renderPage();
        if (view.revealed) {
            void detectAspect();
        } else {
            // First open and the shape of this gallery is not known yet: wait briefly for it so the
            // window appears once, already at its final size.
            await Promise.race([detectAspect(), new Promise(resolve => setTimeout(resolve, REVEAL_TIMEOUT_MS))]);
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
    return { ...layout, pageSize: layout.rows * layout.cols };
}

const aspectCache = new Map(); // `${folder}|${count}` -> detected ratio

/** Thumbnail resolution that matches the tiles actually on screen (a little extra for `cover` cropping). */
function currentBucket() {
    const tw = view.fit?.tw ?? DEFAULT_TILE_SIDE;
    const th = view.fit?.th ?? DEFAULT_TILE_SIDE;
    return thumbBucket(tw * 1.2, th * 1.2, window.devicePixelRatio);
}

function readAspectHints() {
    try { return JSON.parse(window.localStorage.getItem(ASPECT_HINTS_KEY) ?? '{}') ?? {}; } catch { return {}; }
}

function saveAspectHint(folder, ratio) {
    try {
        const hints = readAspectHints();
        if (hints[folder] === ratio) return;
        hints[folder] = ratio;
        window.localStorage.setItem(ASPECT_HINTS_KEY, JSON.stringify(hints));
    } catch { /* storage unavailable: the hint is only an optimisation */ }
}

/** Starts from the last detected shape of this folder so the window opens at its final size. */
function primeAspect() {
    const ratio = Number(readAspectHints()[view.folder]);
    if (ratio > 0 && Number.isFinite(ratio)) { view.autoRatio = ratio; return true; }
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

async function imageRatio(blob) {
    try {
        if (typeof createImageBitmap === 'function') {
            const bitmap = await createImageBitmap(blob);
            const ratio = bitmap.width / bitmap.height;
            bitmap.close?.();
            return ratio;
        }
    } catch { /* fall through */ }
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img.naturalWidth / img.naturalHeight); };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
    });
}

/** Finds the shape most pictures in the open gallery have (only when the option is 'auto'). */
async function detectAspect() {
    if (!view.panel || getLayout().aspect !== 'auto') return;
    const token = view.token;
    const key = `${view.folder}|${view.items.length}`;
    const cached = aspectCache.get(key);
    if (cached) {
        if (view.autoRatio !== cached) { view.autoRatio = cached; fitPanel(); }
        return;
    }
    const images = view.items.filter(i => !i.video);
    if (images.length === 0) return;
    const step = Math.max(1, images.length / ASPECT_SAMPLES);
    const samples = [];
    for (let i = 0; i < Math.min(ASPECT_SAMPLES, images.length); i++) samples.push(images[Math.floor(i * step)]);

    const bucket = currentBucket();
    const ratios = [];
    await Promise.all(samples.map(async (item) => {
        const blob = await getThumbnail(item.url, { video: false, bucket });
        const ratio = blob ? await imageRatio(blob) : null;
        if (ratio && Number.isFinite(ratio)) ratios.push(ratio);
    }));
    if (token !== view.token || !view.panel) return; // the gallery changed meanwhile
    const value = dominantAspect(ratios);
    const preset = ASPECT_PRESETS.find(p => p.value === value);
    if (!preset) return;
    aspectCache.set(key, preset.ratio);
    saveAspectHint(view.folder, preset.ratio);
    if (getLayout().aspect === 'auto' && view.autoRatio !== preset.ratio) {
        view.autoRatio = preset.ratio;
        fitPanel();
    }
}

function applyLayoutVariables() {
    const { cols, rows } = getLayout();
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

function disposeTiles() {
    view.renderCtl?.abort();
    view.renderCtl = null;
    view.observer?.disconnect();
    view.observer = null;
    for (const tile of view.tiles.values()) {
        if (tile.objectUrl) URL.revokeObjectURL(tile.objectUrl);
    }
    view.tiles.clear();
}

function showMessage(iconClass, text, ...actions) {
    const { grid } = view.refs;
    grid.replaceChildren(h('div', { class: 'gpp-message' }, icon(iconClass), h('div', {}, text), ...actions));
    grid.classList.add('gpp-grid-empty');
}

function renderPage() {
    if (!view.panel) return;
    const { grid, scroller } = view.refs;
    const layout = currentLayout();
    view.pageSize = layout.pageSize;
    const pages = pageCount(view.filtered.length, layout.pageSize);
    view.page = clampPage(view.page, pages);

    view.rendering = true;
    disposeTiles();
    grid.classList.remove('gpp-grid-empty');
    updatePager(pages); // the pager height is part of the window chrome, so it must be final before fitting
    fitPanel();         // synchronous: tiles are created at their final size, never resized afterwards

    if (view.status === 'loading' && view.items.length === 0) {
        showMessage('fa-solid fa-spinner fa-spin', t`Loading…`);
    } else if (view.status === 'error') {
        showMessage('fa-solid fa-triangle-exclamation', t`Could not load this gallery.`,
            h('div', { class: 'menu_button menu_button_icon interactable', onClick: () => loadFolder() }, icon('fa-solid fa-rotate'), h('span', {}, t`Retry`)));
    } else if (view.items.length === 0) {
        showMessage('fa-regular fa-images', t`This gallery is empty. Drop images here or press “Add Image”.`);
    } else if (view.filtered.length === 0) {
        showMessage('fa-solid fa-magnifying-glass', `${t`No images match`} “${view.query}”.`,
            h('div', { class: 'menu_button menu_button_icon interactable', onClick: () => setQuery('') }, icon('fa-solid fa-xmark'), h('span', {}, t`Clear search`)));
    } else {
        const ctl = (view.renderCtl = new AbortController());
        const bucket = currentBucket();
        view.renderedBucket = bucket;
        const fragment = document.createDocumentFragment();
        const pending = [];

        for (const item of pageSlice(view.filtered, view.page, layout.pageSize)) {
            const img = h('img', { class: 'gpp-img', alt: '', decoding: 'async', draggable: 'false' });
            const el = h('div', {
                class: `gpp-tile${item.video ? ' gpp-video' : ''}`,
                tabindex: '0',
                role: 'button',
                title: item.name,
                'aria-label': item.name,
            }, img, item.video ? icon('fa-solid fa-circle-play gpp-badge') : null, h('span', { class: 'gpp-name' }, item.name));
            const tile = { el, img, item, objectUrl: null };
            view.tiles.set(el, tile);
            fragment.append(el);

            // Instant paint for thumbnails already in memory.
            // A hit that hasn't been checked against the server yet is still shown right away, but is also
            // queued so it gets swapped out if the file changed.
            const hit = peekThumbnail(item.url, bucket);
            if (hit) applyThumbnail(tile, hit);
            if (!hit || !isThumbnailVerified(item.url, bucket)) pending.push(tile);
        }
        grid.replaceChildren(fragment);

        if (pending.length > 0) {
            const start = (tile) => void loadTileThumbnail(tile, bucket, ctl.signal);
            if (typeof IntersectionObserver === 'function') {
                view.observer = new IntersectionObserver((entries, observer) => {
                    for (const entry of entries) {
                        if (!entry.isIntersecting) continue;
                        observer.unobserve(entry.target);
                        const tile = view.tiles.get(/** @type {HTMLElement} */ (entry.target));
                        if (tile) start(tile);
                    }
                }, { root: scroller, rootMargin: '200px' });
                for (const tile of pending) view.observer.observe(tile.el);
            } else {
                pending.forEach(start);
            }
        }
    }

    scroller.scrollTop = 0;
    view.rendering = false;
}

/** @param {Tile} tile @param {Blob} blob */
function applyThumbnail(tile, blob) {
    if (!view.tiles.has(tile.el) || tile.blob === blob) return;
    if (tile.objectUrl) URL.revokeObjectURL(tile.objectUrl);
    tile.objectUrl = URL.createObjectURL(blob);
    tile.blob = blob;
    tile.img.src = tile.objectUrl;
    tile.el.classList.add('gpp-loaded');
}

/** @param {Tile} tile */
async function loadTileThumbnail(tile, bucket, signal) {
    const blob = await getThumbnail(tile.item.url, { video: tile.item.video, bucket, signal });
    if (signal.aborted || !view.tiles.has(tile.el)) return;
    if (blob) applyThumbnail(tile, blob);
    else tile.el.classList.add('gpp-failed');
}

function updatePager(pages) {
    if (!view.panel) return;
    const { pageInput, pageTotal, first, prev, next, last, info } = view.refs;
    pageInput.value = String(view.page);
    pageInput.setAttribute('aria-label', `${t`Page`} (1–${pages})`);
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
        const range = total === 0 ? '0' : (pages > 1 ? `${from}–${to} ${t`of`} ${total}` : String(total));
        const filtered = view.query && total !== view.items.length ? ` (${t`filtered from`} ${view.items.length})` : '';
        info.textContent = `${range} ${total === 1 ? t`item` : t`items`}${filtered}`;
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
    view.query = String(value ?? '');
    const { search, clearSearch } = view.refs;
    if (search.value !== view.query) search.value = view.query;
    clearSearch.hidden = view.query === '';
    applyFilter();
    view.page = 1;
    renderPage();
}

/** Re-applies layout options (rows/cols/size) to the open window, keeping the user's place. */
function applyLayoutToOpenGallery({ resizePanel = true } = {}) {
    if (!view.panel) return;
    const firstVisible = (view.page - 1) * view.pageSize;
    view.page = pageForIndex(firstVisible, currentLayout().pageSize);
    applyLayoutVariables();
    if (resizePanel) {
        if (!isMobileLayout()) {
            // A stale saved size would otherwise win again the next time the window is opened.
            const saved = power_user?.movingUIState?.[PANEL_ID];
            if (saved) { delete saved.width; delete saved.height; SillyTavern.getContext().saveSettingsDebounced(); }
        }
        fitPanel();
    }
    void detectAspect();
    renderPage();
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

/** Height of everything in the window except the picture grid (toolbars, pager, title, padding, gaps). */
function measureChrome(panel, padY, gap) {
    let chrome = padY;
    let count = 0;
    for (const child of panel.children) {
        if (!(child instanceof HTMLElement) || child.hidden) continue;
        const ccs = getComputedStyle(child);
        if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed') continue;
        count++;
        if (child !== view.refs.scroller) chrome += child.offsetHeight;
    }
    return chrome + gap * Math.max(0, count - 1);
}

/**
 * Sizes the gallery window and its thumbnails to the free strip beside the chat panel.
 * The window sits flush against the chat panel and the bottom of the screen (like opened pictures)
 * and hugs its grid; the tiles are as large as the strip allows for the chosen columns x rows,
 * so a few big pictures and many small ones both fill the window neatly.
 */
function fitPanel() {
    const panel = view.panel;
    if (!panel || !panel.isConnected) return;
    if (isMobileLayout()) { fitPanelMobile(panel); return; }
    const side = panel.dataset.gppSide === 'left' || panel.dataset.gppSide === 'right' ? panel.dataset.gppSide : getSide();
    panel.dataset.gppSide = side;
    const bounds = getBounds(side, true);
    const { cols, rows } = getLayout();
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
    // and with it the tile size and the width again. Iterate until that settles (usually 2 passes).
    let width = bounds.width;
    let tile = { tw: 24, th: 24 };
    for (let pass = 0; pass < 5; pass++) {
        panel.style.width = `${width}px`;
        const chrome = measureChrome(panel, padY, gap);
        tile = fitTile(width - padX - gridX - 1, bounds.height - chrome - gridY, cols, rows, ratio);
        const wanted = Math.ceil(cols * tile.tw + gridX + padX + 1);
        const next = Math.min(bounds.width, Math.max(minWidth, wanted));
        if (Math.abs(next - width) < 1) break;
        width = next;
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

/** Full-screen layout: tiles fill the width, and the whole page is fitted into the height when it can. */
function fitPanelMobile(panel) {
    const { cols, rows } = getLayout();
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
}

/** @param {HTMLElement} win @param {'left'|'right'} side */
function fitImageWindow(win, side) {
    if (isMobileLayout()) return;
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
    fitPanel();
    if (isMobileLayout()) return;
    document.querySelectorAll('.galleryImageDraggable').forEach((win) => {
        if (win instanceof HTMLElement) fitImageWindow(win, win.dataset.gppSide === 'left' ? 'left' : 'right');
    });
}

/** After the user drags a window across the chat panel, remember which side it now belongs to. */
function rememberDraggedSides() {
    const sheld = document.getElementById('sheld')?.getBoundingClientRect();
    if (!sheld) return;
    const mid = (sheld.left + sheld.right) / 2;
    document.querySelectorAll('#gallery, .galleryImageDraggable').forEach((win) => {
        if (!(win instanceof HTMLElement)) return;
        const r = win.getBoundingClientRect();
        if (r.width) win.dataset.gppSide = r.left + r.width / 2 < mid ? 'left' : 'right';
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
    const pagerButton = (classes, label) => h('div', { class: `menu_button menu_button_icon interactable gallery-page-button`, title: label, 'aria-label': label, role: 'button' }, icon(classes));
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
    wirePanel(panel);
    return panel;
}

function updateSideToggle() {
    const { sideToggle } = view.refs;
    const right = getSide() === 'right';
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
 * an entry always assigns that folder.
 */
function wireFolderSuggestions(input, submit) {
    const list = h('div', { class: 'gpp-suggest', role: 'listbox', hidden: true });
    document.body.append(list);
    view.refs.suggest = list;
    let entries = [];
    let active = -1;
    let seq = 0;

    const isOpen = () => !list.hidden;
    const close = () => { seq++; list.hidden = true; active = -1; document.removeEventListener('pointerdown', onOutside, true); };
    const onOutside = (e) => { if (e.target !== input && !list.contains(e.target)) close(); };
    const position = () => {
        const r = input.getBoundingClientRect();
        list.style.left = `${Math.round(r.left)}px`;
        list.style.top = `${Math.round(r.bottom + 2)}px`;
        list.style.width = `${Math.round(r.width)}px`;
        list.style.maxHeight = `${Math.max(120, Math.min(260, window.innerHeight - r.bottom - 12))}px`;
    };
    const setActive = (index) => {
        active = index;
        [...list.children].forEach((el, i) => el.classList.toggle('gpp-active', i === index));
        list.children[index]?.scrollIntoView({ block: 'nearest' });
    };
    const choose = (name) => {
        input.value = name;
        close();
        submit();
    };
    const render = () => {
        list.replaceChildren(...entries.map((name, i) => {
            const item = h('div', { class: `gpp-suggest-item${name === view.folder ? ' gpp-current' : ''}`, role: 'option', title: name }, name);
            item.addEventListener('mousedown', (e) => e.preventDefault()); // keep the input focused
            item.addEventListener('click', () => choose(name));
            item.addEventListener('mousemove', () => { if (active !== i) setActive(i); });
            return item;
        }));
        if (!entries.length) { close(); return; }
        position();
        if (!isOpen()) { list.hidden = false; document.addEventListener('pointerdown', onOutside, true); }
    };
    const open = async (filter) => {
        if (input.readOnly) return;
        const mine = ++seq;
        const all = await getAllFolders();
        if (mine !== seq) return;
        const term = String(filter ?? '').trim().toLowerCase();
        entries = all.filter(f => !term || f.toLowerCase().includes(term));
        active = -1;
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
            if (n) setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (isOpen() && active >= 0 && entries[active] !== undefined) choose(entries[active]);
            else { close(); submit(); }
        } else if (e.key === 'Escape' && isOpen()) {
            e.preventDefault();
            close();
        }
    });
    window.addEventListener('resize', close);
    list.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
}

function wirePanel(panel) {
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
    r.search.addEventListener('input', () => { r.clearSearch.hidden = r.search.value === ''; runSearch(); });
    r.search.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape' && r.search.value) { e.preventDefault(); runSearch.cancel(); setQuery(''); }
        else if (e.key === 'Enter') { runSearch.cancel(); setQuery(r.search.value); }
    });
    r.clearSearch.addEventListener('click', () => { runSearch.cancel(); setQuery(''); r.search.focus(); });

    // Sort / side / upload
    r.sort.addEventListener('change', () => { setSort(r.sort.value); void loadFolder(); });
    updateSideToggle();
    r.sideToggle.addEventListener('click', () => {
        setSide(getSide() === 'right' ? 'left' : 'right');
        updateSideToggle();
        panel.dataset.gppSide = getSide();
        fitPanel();
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
    wireFolderSuggestions(r.folderInput, submitFolder);

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
    panel.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); depth++; panel.classList.add('gpp-dropping'); });
    panel.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; });
    panel.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) panel.classList.remove('gpp-dropping'); });
    panel.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); e.stopPropagation();
        depth = 0; panel.classList.remove('gpp-dropping');
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
    const confirmed = await Popup.show.confirm(t`Are you sure you want to delete this image?`, item.path);
    if (!confirmed) return;
    const deleted = await deleteMediaFromServer(item.path, false);
    if (!deleted) return;
    toastr.success(t`Image deleted successfully.`);
    void purgeThumbnail(item.url);
    $(`.galleryImageDraggable[data-src="${CSS.escape(item.url)}"] .dragClose`).trigger('click');
    // Update locally; no need to re-list the whole folder.
    view.items = view.items.filter(i => i.path !== item.path);
    applyFilter();
    renderPage();
}

async function uploadFiles(files) {
    if (view.uploading || !view.panel) return;
    const accepted = files.filter(f => /^(image|video)\//.test(f.type) || isVideoName(f.name, VIDEO_EXTENSIONS) || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(f.name));
    if (accepted.length === 0) { toastr.warning(t`Only image and video files can be uploaded.`); return; }

    view.uploading = true;
    view.panel.classList.add('gpp-busy');
    const folder = view.folder;
    const before = new Set(view.items.map(i => i.path));
    let ok = 0;
    let failed = 0;
    try {
        for (const file of accepted) {
            try {
                const base64 = (await getBase64Async(file)).split(',')[1];
                await saveBase64AsFile(base64, folder, '', getFileExtension(file));
                ok++;
            } catch (error) {
                failed++;
                console.error('[Gallery++] Upload failed:', error);
            }
        }
    } finally {
        view.uploading = false;
    }
    if (ok) toastr.success(`${t`Uploaded`} ${ok} ${ok === 1 ? t`file` : t`files`}.`);
    if (failed) toastr.error(`${t`Failed to upload`} ${failed} ${failed === 1 ? t`file` : t`files`}.`);
    if (view.panel && view.folder === folder) await loadFolder({ previousPaths: before });
}

let refreshing = false;

/** Re-lists the folder and throws away every cached thumbnail of it, so all of them are rebuilt from the files. */
async function refreshGallery() {
    if (!view.panel || refreshing) return;
    refreshing = true;
    const button = view.refs.refreshButton;
    button.classList.add('fa-spin', 'disabled');
    const folder = view.folder;
    try {
        view.renderCtl?.abort(); // stop thumbnail work for the old tiles
        await purgeThumbnails(view.items.map(i => i.url));
        for (const key of [...aspectCache.keys()]) {
            if (key.startsWith(`${folder}|`)) aspectCache.delete(key);
        }
        foldersCache = { time: 0, list: null };
        await loadFolder({ keepPage: true });
        if (view.panel && view.folder === folder && view.status === 'ready') toastr.success(t`Gallery refreshed`);
    } finally {
        refreshing = false;
        button.classList.remove('fa-spin', 'disabled');
    }
}

let folderBusy = false;

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
        updateFolderControls();
        if (nextFolder === view.folder) {
            toastr.info(t`This gallery is already showing the folder ${nextFolder}`);
            return;
        }
        view.folder = nextFolder;
        updateFolderControls();
        await loadFolder();
        toastr.info(t`Gallery folder changed to ${nextFolder}`);
    } catch (error) {
        console.error('[Gallery++] Failed to change gallery folder:', error);
        toastr.error(error?.message || t`Unknown error`, t`Failed to change gallery folder`);
    } finally {
        folderBusy = false;
    }
}

async function restoreDefaultFolder() {
    const target = getTarget();
    if (!target || target.kind !== 'char' || !view.panel) return;
    if (!getFolderOverride(target.character.avatar)) { toastr.info(t`This character already uses its default folder.`); return; }
    setFolderOverride(target.character.avatar, null);
    view.folder = target.character.name;
    updateFolderControls();
    await loadFolder();
}

// ------------------------------------------------------------------------------- open / close

async function openGallery() {
    const target = getTarget();
    if (!target) { toastr.info(t`Select a character or group to open its gallery.`); return; }

    if (view.panel?.isConnected) {
        // Already open: follow the current chat, or just refresh the listing.
        if (!(await syncToContext())) await loadFolder({ keepPage: true });
        return;
    }
    // A previous window may still be fading out; two elements with one id would break dragging.
    document.getElementById(PANEL_ID)?.remove();
    view.panel = null;
    view.fit = null;
    view.kind = target.kind;
    view.folder = target.folder;
    view.items = [];
    view.filtered = [];
    view.query = '';
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
    view.fit = null;
    if (isMobileLayout()) applySavedWindowState(panel);
    else panel.dataset.gppSide = getSide();
    dragElement($(panel));
    renderPage(); // fits the (still invisible) window to its final size
    // Show it right away when its final shape is certain; otherwise loadFolder() reveals it as soon as
    // the shape is detected. The timer is only a safety net for a slow or failing server.
    if (shapeKnown) revealPanel();
    else setTimeout(() => { if (view.panel === panel) revealPanel(); }, REVEAL_TIMEOUT_MS + 600);
    await loadFolder();
}

function closeGallery() {
    const panel = view.panel;
    if (!panel) return;
    view.token++;
    view.loadCtl?.abort();
    disposeTiles();
    view.refs.suggest?.remove();
    view.panel = null;
    view.refs = {};
    view.fit = null;
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
    view.folder = target.folder;
    view.items = [];
    view.filtered = [];
    view.status = 'loading';
    view.query = '';
    view.refs.search.value = '';
    view.refs.clearSearch.hidden = true;
    updateFolderControls();
    await loadFolder();
    return true;
}

// ------------------------------------------------------------------------------- media windows

/** @param {GalleryItem} item @param {'left'|'right'} side */
function openMedia(item, side) {
    const existing = document.querySelector(`.galleryImageDraggable[data-src="${CSS.escape(item.url)}"]`);
    if (existing instanceof HTMLElement) {
        // Same picture already open: move it to the requested side instead of stacking duplicates.
        fitImageWindow(existing, side);
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
    media.src = item.url;
    media.draggable = false;
    if (media instanceof HTMLVideoElement) { media.controls = true; media.autoplay = true; media.loop = true; }
    win.append(media);
    document.getElementById('movingDivs').append(win);

    if (isMobileLayout()) applySavedWindowState(win);
    win.dataset.gppSide = side;

    let shown = false;
    const reveal = () => {
        if (shown || !win.isConnected) return;
        shown = true;
        win.style.visibility = '';
        fadeIn(win);
    };
    const fit = () => {
        const w = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
        const hgt = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
        if (!w || !hgt) return;
        win.dataset.gppW = String(w);
        win.dataset.gppH = String(hgt);
        fitImageWindow(win, win.dataset.gppSide === 'left' ? 'left' : 'right');
        reveal();
    };
    media.addEventListener(media instanceof HTMLVideoElement ? 'loadedmetadata' : 'load', fit, { once: true });
    media.addEventListener('error', reveal, { once: true }); // broken file: show the (default-sized) window anyway
    setTimeout(reveal, 3000); // safety net for a very slow server

    dragElement($(win));
    fitImageWindow(win, side); // provisional placement while hidden
    if (media instanceof HTMLImageElement && media.complete) fit(); // cached picture: size is known right now
}

function closeAllImages() {
    document.querySelectorAll('.galleryImageDraggable .dragClose').forEach(btn => /** @type {HTMLElement} */ (btn).click());
}

// ------------------------------------------------------------------------------- hotkeys

function isTyping() {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return false;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
        || el.isContentEditable || Boolean(el.closest('[contenteditable="true"]'));
}

function onHotkey(event) {
    if (!getBoolean('hotkeys')) return;
    if (event.isComposing || event.defaultPrevented || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
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
        const l = currentLayout();
        const shape = l.aspect === 'auto' ? t`shape detected per gallery` : `${l.aspect} ${t`shape`}`;
        summary.textContent = `${l.pageSize} ${t`images per page`} (${l.cols} ${t`columns`} × ${l.rows} ${t`rows`}), ${shape}. ${t`Pictures are sized to fit beside the chat.`}`;
    };

    const applyField = debounce((key) => {
        const { min, max } = LAYOUT_LIMITS[key];
        if (inputs[key].value.trim() === '') return; // still typing
        const value = clampInt(inputs[key].value, min, max, LAYOUT_DEFAULTS[key]);
        setLayout({ [key]: value });
        refreshSummary();
        applyLayoutToOpenGallery();
    }, 250);

    const numberField = (key, label, unit) => {
        const { min, max } = LAYOUT_LIMITS[key];
        inputs[key] = h('input', { type: 'number', class: 'text_pole gpp-number', min, max, step: 1, value: String(getLayout()[key]), 'aria-label': label });
        inputs[key].addEventListener('input', () => applyField(key));
        inputs[key].addEventListener('change', () => {
            applyField.cancel();
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
        });
        return h('label', { class: 'checkbox_label' }, input, h('span', {}, label));
    };

    const resetButton = h('div', { class: 'menu_button menu_button_icon interactable', role: 'button' }, icon('fa-solid fa-rotate-left'), h('span', {}, t`Reset layout`));
    resetButton.addEventListener('click', () => {
        const layout = resetLayout();
        for (const key of Object.keys(layout)) inputs[key].value = String(layout[key]);
        refreshSummary();
        applyLayoutToOpenGallery();
    });
    const clearButton = h('div', { class: 'menu_button menu_button_icon interactable', role: 'button', title: t`Thumbnails are regenerated the next time you open a folder` }, icon('fa-solid fa-broom'), h('span', {}, t`Clear thumbnail cache`));
    clearButton.addEventListener('click', async () => {
        const removed = await clearThumbnailCache();
        toastr.success(`${t`Thumbnail cache cleared`} (${removed})`);
        if (view.panel) renderPage();
    });
    const openButton = h('div', { class: 'menu_button menu_button_icon interactable', role: 'button' }, icon('fa-solid fa-sd-card'), h('span', {}, t`Open gallery`));
    openButton.addEventListener('click', () => void openGallery());

    const content = h('div', { class: 'inline-drawer-content' },
        h('div', { class: 'gpp-settings-grid' },
            numberField('rows', t`Rows per page`),
            numberField('cols', t`Columns per page`),
            aspectField()),
        summary,
        checkbox('showNames', t`Always show file names on pictures`),
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
            folder = ctx.groups?.find(g => g.name == args.group)?.id;
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

// ------------------------------------------------------------------------------- bootstrap

export async function init() {
    if (initialized) return;
    initialized = true;

    configureSettings({
        getRoot: () => SillyTavern.getContext().extensionSettings,
        saveDebounced: () => SillyTavern.getContext().saveSettingsDebounced(),
        saveNow: typeof ST.saveSettings === 'function' ? () => ST.saveSettings() : undefined,
        storage: (() => { try { return window.localStorage; } catch { return null; } })(),
    });
    getSettings(); // validates, migrates from the original Gallery, and restores folder assignments

    // Closing windows. ST has no global handler for generic draggables.
    $('#movingDivs').on('click', '.gpp-panel .dragClose, .galleryImageDraggable .dragClose', function () {
        const target = $(this).closest('.draggable')[0];
        if (!target) return;
        if (target === view.panel) closeGallery();
        else fadeRemove(target);
    });

    document.addEventListener('keydown', onHotkey);

    // Keep every gallery window fitted beside the chat panel when the screen or chat width changes.
    const refit = debounce(fitAllWindows, 60);
    window.addEventListener('resize', refit);
    const sheld = document.getElementById('sheld');
    if (sheld && typeof ResizeObserver === 'function') new ResizeObserver(refit).observe(sheld);
    const afterDrag = () => setTimeout(rememberDraggedSides, 0);
    document.addEventListener('mouseup', afterDrag);
    document.addEventListener('touchend', afterDrag);
    eventSource.on(event_types.CHAT_CHANGED, () => void syncToContext());
    eventSource.on(event_types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => renameAvatar(oldAvatar, newAvatar));
    eventSource.on(event_types.CHARACTER_DELETED, (data) => removeAvatar(data?.character?.avatar));
    eventSource.on(event_types.CHARACTER_MANAGEMENT_DROPDOWN, (id) => { if (id === 'gpp_show_gallery_option') void openGallery(); });

    registerCommands();
    addMenuEntries();
    mountSettings();
}
