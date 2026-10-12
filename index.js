/*
 * Gallery++ Version 1.6.2
 * Modified from SillyTavern's Gallery extension, originally authored by City-Unit.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
    eventSource,
    getRequestHeaders,
    event_types,
    animation_duration,
    animation_easing,
} from '../../../script.js';
import { groups, selected_group } from '../../group-chats.js';
import { loadFileToDocument, getBase64Async, getSanitizedFilename, saveBase64AsFile, getFileExtension, getVideoThumbnail, clamp } from '../../utils.js';
import { power_user } from '../../power-user.js';
import { dragElement } from '../../RossAscends-mods.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { DragAndDropHandler } from '../../dragdrop.js';
import { commonEnumProviders } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { t, translate } from '../../i18n.js';
import { Popup } from '../../popup.js';
import { deleteMediaFromServer } from '../../chats.js';
import { MEDIA_REQUEST_TYPE, VIDEO_EXTENSIONS } from '../../constants.js';

const isVideo = (/** @type {string} */ url) => {
    const lowerUrl = String(url).toLowerCase();
    return VIDEO_EXTENSIONS.some(ext => {
        const normalizedExt = String(ext).toLowerCase();
        return lowerUrl.endsWith(normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`);
    });
};
const extensionName = 'gallery-plus-plus';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}/`;
let galleryWelcomeShown = false;
let galleryAssetsPromise = null;
let deleteModeActive = false;
let galleryRequestToken = 0;
let galleryInitialized = false;
let galleryFoldersCache = null;
let galleryFoldersCacheTime = 0;
const galleryThumbnailMemoryCache = new Map();
const galleryThumbnailJobQueue = [];
let activeGalleryThumbnailJobs = 0;
const GALLERY_THUMBNAIL_CONCURRENCY = 2;
const GALLERY_THUMBNAIL_MAX_SIDE = 256;
const GALLERY_THUMBNAIL_MEMORY_LIMIT = 200;
const GALLERY_FOLDERS_CACHE_TTL = 15_000;
const GALLERY_CACHE_DB_NAME = 'ST_Gallery_Plus_Plus_Cache';
const GALLERY_CACHE_DB_VERSION = 1;
const GALLERY_CACHE_STORE_NAME = 'thumbnails';
let galleryDBPromise = null;
const IMAGE_PLACEHOLDER = makeGalleryPlaceholder('image');
const VIDEO_PLACEHOLDER = makeGalleryPlaceholder('video');
const DEFAULT_GALLERY_SIDE = 'left';
const GALLERY_BACK_Z_INDEX = '1';


const CUSTOM_GALLERY_REMOVED_EVENT = 'galleryPlusPlusRemoved';

/**
 * Emits the gallery teardown event and removes the outer panel. Keeping this
 * explicit avoids observing SillyTavern's entire document subtree for removals.
 */
function removeGalleryPanel() {
    const panel = $('#movingDivs > #galleryPlusPlus');
    if (!panel.length) return;
    eventSource.emit(CUSTOM_GALLERY_REMOVED_EVENT);
    panel.remove();
}

// Remove draggable windows through the normal animated close path.
$('#movingDivs').on('click', '.dragClose', function () {
    const relatedId = $(this).data('related-id');
    if (!relatedId) return;
    const relatedElement = $(`#movingDivs > .draggable[id="${relatedId}"]`);
    relatedElement.transition({
        opacity: 0,
        duration: animation_duration,
        easing: animation_easing,
        complete: () => {
            if (relatedId === 'galleryPlusPlus') {
                eventSource.emit(CUSTOM_GALLERY_REMOVED_EVENT);
            }
            relatedElement.remove();
        },
    });
});

const SORT = Object.freeze({
    NAME_ASC: { value: 'nameAsc', field: 'name', order: 'asc', label: t`Name (A-Z)` },
    NAME_DESC: { value: 'nameDesc', field: 'name', order: 'desc', label: t`Name (Z-A)` },
    DATE_DESC: { value: 'dateDesc', field: 'date', order: 'desc', label: t`Newest` },
    DATE_ASC: { value: 'dateAsc', field: 'date', order: 'asc', label: t`Oldest` },
});

const defaultSettings = Object.freeze({
    folders: {},
    sort: SORT.DATE_ASC.value,
    side: DEFAULT_GALLERY_SIDE,
});

/**
 * Initializes the settings for the gallery extension.
 */
function initSettings() {
    let shouldSave = false;
    const context = SillyTavern.getContext();
    const extensionSettings = context.extensionSettings;

    if (!extensionSettings.galleryPlusPlus || typeof extensionSettings.galleryPlusPlus !== 'object') {
        const legacySettings = extensionSettings.gallery && typeof extensionSettings.gallery === 'object'
            ? extensionSettings.gallery
            : {};
        const migratedSettings = structuredClone(defaultSettings);
        for (const key of Object.keys(defaultSettings)) {
            if (Object.hasOwn(legacySettings, key)) {
                migratedSettings[key] = structuredClone(legacySettings[key]);
            }
        }
        migratedSettings.folders = {
            ...structuredClone(defaultSettings.folders),
            ...(legacySettings.folders && typeof legacySettings.folders === 'object' ? legacySettings.folders : {}),
        };
        extensionSettings.galleryPlusPlus = migratedSettings;
        shouldSave = true;
    }

    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings.galleryPlusPlus, key)) {
            extensionSettings.galleryPlusPlus[key] = structuredClone(defaultSettings[key]);
            shouldSave = true;
        }
    }

    if (shouldSave) {
        context.saveSettingsDebounced();
    }
}

/**
 * Retrieves the gallery folder for a given character.
 * The current SillyTavern context is the source of truth for character data;
 * this avoids stale imported character-array references after character changes.
 * @param {Character} char Character data
 * @returns {string} The gallery folder for the character
 */
function getGalleryFolder(char) {
    const context = SillyTavern.getContext();
    const folders = context.extensionSettings.galleryPlusPlus?.folders ?? {};
    return folders[char?.avatar] ?? char?.name;
}

/**
 * Returns the currently selected single character, or null for groups/no character.
 * @returns {Character|null}
 */
function getCurrentGalleryCharacter() {
    const context = SillyTavern.getContext();
    if (context.groupId || context.characterId === undefined || context.characterId === null) {
        return null;
    }
    return context.characters?.[context.characterId] ?? null;
}

/**
 * Gets the persisted gallery side. Invalid/legacy values fall back to the left side.
 * @returns {'left'|'right'} The configured side
 */
function getGallerySide() {
    const side = SillyTavern.getContext().extensionSettings.galleryPlusPlus.side;
    return side === 'right' ? 'right' : DEFAULT_GALLERY_SIDE;
}

/**
 * Persists the gallery side toggle state.
 * @param {'left'|'right'} side The new side
 */
function setGallerySide(side) {
    const context = SillyTavern.getContext();
    context.extensionSettings.galleryPlusPlus.side = side === 'right' ? 'right' : DEFAULT_GALLERY_SIDE;
    context.saveSettingsDebounced();
}

/**
 * Creates a tiny SVG data URI used until a real image/video thumbnail is ready.
 * @param {'image'|'video'} kind Placeholder type
 * @returns {string} SVG data URI
 */
function makeGalleryPlaceholder(kind) {
    // Match the gallery's fixed 9:16 portrait tile ratio to avoid square placeholders
    // stretching or leaving inconsistent empty space while thumbnails are generated.
    const symbol = kind === 'video'
        ? '<path d="M3.2 5.2v5.6L7.1 8z" fill="#eee"/>'
        : '<path d="M1.2 13.2 3.4 9.6l2.1 2.3 1.2-1.5 1.1 2.8H1.2zm1.9-5.5a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8z" fill="#ddd"/>';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="256" viewBox="0 0 9 16"><rect width="9" height="16" fill="#222"/>${symbol}</svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

/**
 * Loads the thumbnail database once per extension runtime. IDB errors are
 * tolerated so gallery browsing continues if storage is disabled or full.
 * @returns {Promise<IDBDatabase>}
 */
function openGalleryDB() {
    if (!('indexedDB' in window)) {
        return Promise.reject(new Error('IndexedDB is unavailable'));
    }
    if (!galleryDBPromise) {
        galleryDBPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(GALLERY_CACHE_DB_NAME, GALLERY_CACHE_DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(GALLERY_CACHE_STORE_NAME)) {
                    db.createObjectStore(GALLERY_CACHE_STORE_NAME);
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => {
                    db.close();
                    galleryDBPromise = null;
                };
                resolve(db);
            };
            request.onerror = () => reject(request.error ?? new Error('Failed to open thumbnail cache'));
            request.onblocked = () => reject(new Error('Thumbnail cache upgrade was blocked'));
        }).catch(error => {
            galleryDBPromise = null;
            throw error;
        });
    }
    return galleryDBPromise;
}

function rememberGalleryThumbnail(key, value) {
    galleryThumbnailMemoryCache.delete(key);
    galleryThumbnailMemoryCache.set(key, value);
    while (galleryThumbnailMemoryCache.size > GALLERY_THUMBNAIL_MEMORY_LIMIT) {
        const oldestKey = galleryThumbnailMemoryCache.keys().next().value;
        galleryThumbnailMemoryCache.delete(oldestKey);
    }
}

/** @param {string} key @returns {Promise<string|null>} */
async function getCachedThumbnail(key) {
    const memoryValue = galleryThumbnailMemoryCache.get(key);
    if (memoryValue) {
        // Refresh insertion order to keep frequently used thumbnails in memory.
        rememberGalleryThumbnail(key, memoryValue);
        return memoryValue;
    }

    try {
        const db = await openGalleryDB();
        const value = await new Promise((resolve, reject) => {
            const tx = db.transaction(GALLERY_CACHE_STORE_NAME, 'readonly');
            const request = tx.objectStore(GALLERY_CACHE_STORE_NAME).get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
            tx.onerror = () => reject(tx.error);
        });
        if (typeof value === 'string' && value) {
            rememberGalleryThumbnail(key, value);
            return value;
        }
        if (value instanceof Blob) {
            const dataUrl = await blobToDataUrl(value);
            rememberGalleryThumbnail(key, dataUrl);
            return dataUrl;
        }
        return null;
    } catch (error) {
        console.debug('Gallery thumbnail cache read skipped:', error);
        return null;
    }
}

/** @param {string} key @param {string|Blob} value @returns {Promise<string>} displayable data URL */
async function setCachedThumbnail(key, value) {
    // Store image thumbnails as compact Blobs in IndexedDB while retaining a
    // ready-to-apply data URL in the bounded in-memory cache.
    const displayUrl = typeof value === 'string' ? value : await blobToDataUrl(value);
    rememberGalleryThumbnail(key, displayUrl);
    try {
        const db = await openGalleryDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(GALLERY_CACHE_STORE_NAME, 'readwrite');
            tx.objectStore(GALLERY_CACHE_STORE_NAME).put(value, key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('Thumbnail cache write aborted'));
        });
    } catch (error) {
        console.warn('Failed to persist gallery thumbnail:', error);
    }
    return displayUrl;
}

/**
 * Limits expensive canvas/video decode work to a small number of concurrent
 * jobs. The jobs themselves are enqueued only for thumbnails instantiated by
 * nanogallery2 on the active page.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueueGalleryThumbnailJob(task) {
    return new Promise((resolve, reject) => {
        galleryThumbnailJobQueue.push({ task, resolve, reject });
        runNextGalleryThumbnailJobs();
    });
}

function runNextGalleryThumbnailJobs() {
    while (activeGalleryThumbnailJobs < GALLERY_THUMBNAIL_CONCURRENCY && galleryThumbnailJobQueue.length > 0) {
        const job = galleryThumbnailJobQueue.shift();
        activeGalleryThumbnailJobs++;
        Promise.resolve()
            .then(job.task)
            .then(job.resolve, job.reject)
            .finally(() => {
                activeGalleryThumbnailJobs--;
                runNextGalleryThumbnailJobs();
            });
    }
}

/** @param {Blob} blob @returns {Promise<string>} */
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('Could not encode gallery thumbnail'));
        reader.onerror = () => reject(reader.error ?? new Error('Could not encode gallery thumbnail'));
        reader.readAsDataURL(blob);
    });
}

/**
 * Creates a compact WebP thumbnail on demand. The full image is fetched only
 * after its tile is instantiated; all later views use the persistent cache.
 * @param {string} src
 * @returns {Promise<string|null>}
 */
async function createImageGalleryThumbnail(src) {
    const cacheKey = `image:${src}`;
    const cached = await getCachedThumbnail(cacheKey);
    if (cached) return cached;

    const response = await fetch(src, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status} while loading gallery image`);
    const originalBlob = await response.blob();
    let imageSource;
    let cleanupSource = () => {};

    if (typeof createImageBitmap === 'function') {
        imageSource = await createImageBitmap(originalBlob);
        cleanupSource = () => imageSource?.close?.();
    } else {
        const objectUrl = URL.createObjectURL(originalBlob);
        const image = new Image();
        image.decoding = 'async';
        image.src = objectUrl;
        try {
            await image.decode();
        } catch (error) {
            URL.revokeObjectURL(objectUrl);
            throw error;
        }
        imageSource = image;
        cleanupSource = () => URL.revokeObjectURL(objectUrl);
    }

    try {
        const width = imageSource.width ?? imageSource.naturalWidth;
        const height = imageSource.height ?? imageSource.naturalHeight;
        if (!width || !height) return null;
        const scale = Math.min(1, GALLERY_THUMBNAIL_MAX_SIDE / Math.max(width, height));
        const targetWidth = Math.max(1, Math.round(width * scale));
        const targetHeight = Math.max(1, Math.round(height * scale));
        const canvas = typeof OffscreenCanvas === 'function'
            ? new OffscreenCanvas(targetWidth, targetHeight)
            : Object.assign(document.createElement('canvas'), { width: targetWidth, height: targetHeight });
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D context unavailable');
        context.drawImage(imageSource, 0, 0, targetWidth, targetHeight);

        let thumbnailBlob;
        if (typeof canvas.convertToBlob === 'function') {
            thumbnailBlob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
        } else if (typeof canvas.toBlob === 'function') {
            thumbnailBlob = await new Promise((resolve, reject) => {
                canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('WebP thumbnail encoding failed')), 'image/webp', 0.82);
            });
        } else {
            const dataUrl = canvas.toDataURL('image/webp', 0.82);
            await setCachedThumbnail(cacheKey, dataUrl);
            return dataUrl;
        }

        // Persist the compact Blob; the helper also creates an in-memory data URL.
        return await setCachedThumbnail(cacheKey, thumbnailBlob);
    } finally {
        cleanupSource();
    }
}

/**
 * Resolves the thumbnail for a rendered tile and updates nanogallery2's visible
 * background and its hidden image element together. This prevents the original
 * full-resolution URL from being requested as the thumbnail source.
 * @param {JQuery<HTMLElement>} $thumbnail
 * @param {{src: string, isVideo?: boolean}} item
 */
function loadGalleryThumbnail($thumbnail, item) {
    if (!item?.src) return;
    const thumbnailElement = $thumbnail[0];
    const src = item.src;
    // Fall back to the URL extension in case nanogallery2 drops custom fields.
    const video = Boolean(item.isVideo || isVideo(src));
    const cacheKey = `${video ? 'video' : 'image'}:${src}`;
    $thumbnail.find('.nGY2TnImg2')
        .attr('loading', 'lazy')
        .attr('decoding', 'async');

    const applyThumbnail = (thumbnailUrl) => {
        if (!thumbnailUrl || !thumbnailElement?.isConnected) return;
        if (thumbnailElement.getAttribute('data-gallery-src') !== src) return;
        $thumbnail.find('.nGY2TnImg').css('background-image', `url("${thumbnailUrl}")`);
        $thumbnail.find('.nGY2TnImg2')
            .attr('loading', 'lazy')
            .attr('decoding', 'async')
            .attr('src', thumbnailUrl);
    };

    void (async () => {
        const cached = await getCachedThumbnail(cacheKey);
        if (cached) {
            applyThumbnail(cached);
            return;
        }
        try {
            const thumbnail = await enqueueGalleryThumbnailJob(async () => {
                if (!thumbnailElement?.isConnected) return null;
                const justCached = await getCachedThumbnail(cacheKey);
                if (justCached) return justCached;
                if (video) {
                    const generated = await getVideoThumbnail(src, GALLERY_THUMBNAIL_MAX_SIDE, GALLERY_THUMBNAIL_MAX_SIDE);
                    if (generated) await setCachedThumbnail(cacheKey, generated);
                    return generated;
                }
                return await createImageGalleryThumbnail(src);
            });
            applyThumbnail(thumbnail);
        } catch (error) {
            console.debug(`Failed to generate thumbnail for ${src}:`, error);
        }
    })();
}

/** Loads the gallery JS/CSS once; idle preloading and first-open share a promise. */
function loadGalleryAssets() {
    if (!galleryAssetsPromise) {
        galleryAssetsPromise = Promise.all([
            loadFileToDocument(`${extensionFolderPath}nanogallery2.woff.min.css`, 'css'),
            loadFileToDocument(`${extensionFolderPath}jquery.nanogallery2.min.js`, 'js'),
        ]).catch(error => {
            galleryAssetsPromise = null;
            throw error;
        });
    }
    return galleryAssetsPromise;
}

/**
 * Calculates a safe number of thumbnail rows for the usable viewport.
 * With deterministic square tiles the gallery can size pages without waiting
 * for image dimensions, while reserving room for the controls and taskbar.
 * @param {number} thumbnailHeight
 * @returns {number}
 */
function getGalleryMaxRows(thumbnailHeight) {
    const viewportHeight = Math.max(360, Math.floor(window.visualViewport?.height ?? window.innerHeight));
    const usableHeight = Math.max(thumbnailHeight, Math.floor(viewportHeight * 0.82 - 220));
    return clamp(Math.floor(usableHeight / thumbnailHeight), 1, 8);
}

/**
 * Loads only one element's Moving UI state instead of reloading every movable
 * panel in SillyTavern.
 * @param {JQuery<HTMLElement>} element The draggable element
 */
function loadMovingUIElementState(element) {
    const id = element.attr('id');
    const state = id ? power_user?.movingUIState?.[id] : null;
    if (state && typeof state === 'object') {
        element.css(state);
    }
}

/**
 * Mirrors an element horizontally within the viewport.
 * @param {JQuery<HTMLElement>} element The draggable element
 */
function mirrorElementHorizontally(element) {
    const node = element[0];
    if (!(node instanceof HTMLElement)) return;

    const rect = node.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const mirroredLeft = clamp(window.innerWidth - rect.right, 0, maxLeft);

    element.css({
        left: `${mirroredLeft}px`,
        right: 'auto',
        margin: 'unset',
    });
}

/**
 * Places an element on the configured side without disturbing its vertical
 * position or user-defined size. If the element is already on the correct side,
 * its exact saved position is preserved.
 * @param {JQuery<HTMLElement>} element The draggable element
 * @param {'left'|'right'} side Desired side
 */
function ensureElementOnGallerySide(element, side) {
    const node = element[0];
    if (!(node instanceof HTMLElement) || node.offsetWidth <= 0) return;

    const rect = node.getBoundingClientRect();
    const centerX = rect.left + (rect.width / 2);
    const isOnRight = centerX > window.innerWidth / 2;

    if ((side === 'right') !== isOnRight) {
        mirrorElementHorizontally(element);
    }
}

/**
 * Applies the gallery side to the panel and every currently-opened image
 * window. Each window is mirrored independently, preserving its layout.
 * @param {boolean} forceMirror Whether to mirror even if an element is already
 * on the target side
 */
function applyGalleryBackLayer(element) {
    const node = element?.[0];
    if (!(node instanceof HTMLElement)) return;

    // Gallery windows deliberately live in the same low stacking layer as the
    // gallery panel. SillyTavern's draggable helper may raise a window when it
    // receives focus/drag events, so use !important here and re-apply it on the
    // next frame after those events.
    node.style.setProperty('z-index', GALLERY_BACK_Z_INDEX, 'important');
}

function applyGallerySideToOpenWindows(forceMirror = false) {
    const side = getGallerySide();
    const elements = $('#galleryPlusPlus, .galleryPlusPlusImageDraggable');

    elements.each(function () {
        const element = $(this);
        applyGalleryBackLayer(element);
        if (forceMirror) {
            mirrorElementHorizontally(element);
        } else {
            ensureElementOnGallerySide(element, side);
        }
    });
}

function keepGalleryWindowOnBackLayer(element) {
    applyGalleryBackLayer(element);
    const node = element?.[0];
    if (!(node instanceof HTMLElement)) return;

    const restoreBackLayer = () => {
        applyGalleryBackLayer(element);
        requestAnimationFrame(() => applyGalleryBackLayer(element));
    };

    node.addEventListener('pointerdown', restoreBackLayer, true);
    node.addEventListener('mousedown', restoreBackLayer, true);
    node.addEventListener('touchstart', restoreBackLayer, { capture: true, passive: true });
    node.addEventListener('focusin', restoreBackLayer, true);
}

/**
 * Refreshes all gallery windows after changing a gallery-side toggle.
 */
function toggleGallerySide() {
    const nextSide = getGallerySide() === 'right' ? 'left' : 'right';
    setGallerySide(nextSide);
    applyGallerySideToOpenWindows(true);
}

/**
 * Fetches the raw filenames from the server, without creating UI items or
 * generating any thumbnails. Shared by the gallery and /list-gallery-plus command.
 * @param {string} url Gallery folder
 * @returns {Promise<string[]>}
 */
async function fetchImageFileList(url) {
    const sortValue = getSortOrder();
    const sortObj = Object.values(SORT).find(it => it.value === sortValue) ?? SORT.DATE_ASC;
    const response = await fetch('/api/images/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            folder: url,
            sortField: sortObj.field,
            sortOrder: sortObj.order,
            type: MEDIA_REQUEST_TYPE.IMAGE | MEDIA_REQUEST_TYPE.VIDEO,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to list gallery images. HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
        throw new Error('Gallery image list response was not an array');
    }
    return data;
}

/**
 * Converts file names into lightweight gallery items immediately. Real image
 * and video thumbnails are fetched/decoded lazily by fnThumbnailInit.
 * @param {string} url Gallery folder
 * @returns {Promise<Array<{src: string, srct: string, title: string, isVideo: boolean}>>}
 */
async function getGalleryItems(url) {
    const [files, sanitizedUrl] = await Promise.all([
        fetchImageFileList(url),
        getSanitizedFilename(url),
    ]);

    return files.map(file => {
        const src = `user/images/${sanitizedUrl}/${file}`;
        const video = isVideo(file);
        return {
            src,
            // Only a small inline SVG is initially loaded by nanogallery2.
            srct: video ? VIDEO_PLACEHOLDER : IMAGE_PLACEHOLDER,
            title: '',
            isVideo: video,
        };
    });
}

/**
 * Retrieves a list of gallery folders. This function calls an API endpoint
 * @returns {Promise<string[]>} - Resolves with an array of gallery folders.
 */
async function getGalleryFolders() {
    const now = Date.now();
    if (Array.isArray(galleryFoldersCache) && now - galleryFoldersCacheTime < GALLERY_FOLDERS_CACHE_TTL) {
        return galleryFoldersCache;
    }

    try {
        const response = await fetch('/api/images/folders', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            throw new Error(`HTTP error. Status: ${response.status}`);
        }
        const data = await response.json();
        galleryFoldersCache = Array.isArray(data) ? data : [];
        galleryFoldersCacheTime = now;
        return galleryFoldersCache;
    } catch (error) {
        console.error('Failed to fetch gallery folders:', error);
        return [];
    }
}

/**
 * Deletes a gallery item based on the provided URL.
 * @param {string} url - The URL of the image to be deleted.
 */
async function deleteGalleryItem(url) {
    const isDeleted = await deleteMediaFromServer(url, false);
    if (isDeleted) {
        toastr.success(t`Image deleted successfully.`);
    }
}

/**
 * Sets the sort order for the gallery.
 * @param {string} order Sort order
 */
function setSortOrder(order) {
    const context = SillyTavern.getContext();
    context.extensionSettings.galleryPlusPlus.sort = order;
    context.saveSettingsDebounced();
}

/**
 * Retrieves the current sort order for the gallery.
 * @returns {string} The current sort order for the gallery.
 */
function getSortOrder() {
    return SillyTavern.getContext().extensionSettings.galleryPlusPlus.sort ?? defaultSettings.sort;
}

/**
 * Initializes a gallery using the provided items and sets up the drag-and-drop functionality.
 * It uses the nanogallery2 library to display the items and also initializes
 * event listeners to handle drag-and-drop of files onto the gallery.
 *
 * @param {Array<Object>} items - An array of objects representing the items to display in the gallery.
 * @param {string} url - The URL to use when a file is dropped onto the gallery for uploading.
 * @returns {Promise<void>} - Promise representing the completion of the gallery initialization.
 */
async function initGallery(items, url) {
    // Fixed geometry selects the GRID engine and avoids album-wide image-size preloads.
    // 144 × 256 is an exact 9:16 portrait ratio while remaining a compact grid tile.
    const thumbnailWidth = 144;
    const thumbnailHeight = 256;
    const paginationVisiblePages = 5;
    const paginationMaxLinesPerPage = 2;
    const galleryMaxRows = getGalleryMaxRows(thumbnailHeight);

    const nonce = `nonce-${Math.random().toString(36).substring(2, 15)}`;
    const gallery = $('#dragGalleryPlusPlus');
    gallery.addClass(nonce);
    gallery.nanogallery2({
        'items': items,
        thumbnailWidth: thumbnailWidth,
        thumbnailHeight: thumbnailHeight,
        thumbnailAlignment: 'fillWidth',
        thumbnailWaitImageLoaded: false,
        galleryDisplayTransition: 'none',
        paginationVisiblePages: paginationVisiblePages,
        paginationMaxLinesPerPage: paginationMaxLinesPerPage,
        galleryMaxRows: galleryMaxRows,
        // The extension provides compact page buttons beside Add Image.
        // Do not create nanogallery2's large top navigation controls.
        galleryPaginationTopButtons: false,
        galleryNavigationOverlayButtons: false,
        galleryPaginationMode: 'rectangles',
        galleryTheme: {
            navigationBar: { background: 'none', borderTop: '', borderBottom: '', borderRight: '', borderLeft: '' },
            navigationBreadcrumb: { background: '#111', color: '#fff', colorHover: '#ccc', borderRadius: '4px' },
            navigationFilter: { color: '#ddd', background: '#111', colorSelected: '#fff', backgroundSelected: '#111', borderRadius: '4px' },
            navigationPagination: { background: '#111', color: '#fff', colorHover: '#ccc', borderRadius: '4px' },
            thumbnail: { background: '#444', backgroundImage: 'linear-gradient(315deg, #111 0%, #445 90%)', borderColor: '#000', borderRadius: '0px', labelOpacity: 1, labelBackground: 'rgba(34, 34, 34, 0)', titleColor: '#fff', titleBgColor: 'transparent', titleShadow: '', descriptionColor: '#ccc', descriptionBgColor: 'transparent', descriptionShadow: '', stackBackground: '#aaa' },
            thumbnailIcon: { padding: '5px', color: '#fff', shadow: '' },
            pagination: { background: '#181818', backgroundSelected: '#666', color: '#fff', borderRadius: '2px', shapeBorder: '3px solid var(--SmartThemeQuoteColor)', shapeColor: '#444', shapeSelectedColor: '#aaa' },
        },
        galleryDisplayMode: 'pagination',
        fnThumbnailOpen: (thumbnailItems) => viewWithDragbox(thumbnailItems, 'left'),
        fnThumbnailInit: function (/** @type {JQuery<HTMLElement>} */ $thumbnail, /** @type {{src: string}} */ item) {
            if (!item?.src) return;
            $thumbnail.attr('title', String(item.src).split('/').pop());
            // nanogallery2's data-idx is a rendered/filtered position, not a
            // guaranteed index into the original items array. Keep the real
            // source URL on the thumbnail so contextmenu can resolve the exact
            // picture under the pointer.
            $thumbnail.attr('data-gallery-src', item.src);
            loadGalleryThumbnail($thumbnail, item);
        },
    });

    // nanogallery2 handles normal left-clicks through fnThumbnailOpen. Its
    // Hammer tap recognizer intentionally ignores non-primary mouse buttons,
    // so right-click needs a native contextmenu handler of its own. Resolve
    // the clicked picture by the source URL stored on the thumbnail rather
    // than by nanogallery2's internal data-idx.
    gallery.off('contextmenu.galleryPlusPlus');
    gallery.on('contextmenu.galleryPlusPlus', '.nGY2GThumbnail', function (event) {
        if (event.button !== 2) return;

        const itemUrl = this.getAttribute('data-gallery-src');
        if (!itemUrl) return;

        event.preventDefault();
        event.stopPropagation();

        viewWithDragbox([{
            responsiveURL: () => itemUrl,
        }], 'right');
    });

    const dragDropHandler = new DragAndDropHandler(`#dragGalleryPlusPlus.${nonce}`, async (files) => {
        if (!Array.isArray(files) || files.length === 0) {
            return;
        }

        // Upload into the active folder, which may have changed without remounting the modal.
        for (const file of files) {
            await uploadFile(file, getOpenGalleryUrl(url));
        }

        // Keep the modal and controls mounted; rebuild only the nanogallery instance.
        await refreshGalleryContent(getOpenGalleryUrl(url));
    });

    const resizeHandler = function () {
        if (gallery.closest('#galleryPlusPlus').length) {
            gallery.nanogallery2('resize');
        }
    };

    const chatChangedHandler = function () {
        galleryRequestToken++;
        removeGalleryPanel();
    };

    let cleanedUp = false;
    const cleanup = function () {
        if (cleanedUp) return;
        cleanedUp = true;
        try {
            gallery.nanogallery2('destroy');
        } catch (error) {
            // The gallery may already have been destroyed during a replacement.
            console.debug('Gallery cleanup skipped:', error);
        }
        gallery.off('contextmenu.galleryPlusPlus');
        gallery.removeData('gallery-plus-plus-source-items');
        gallery.removeData('gallery-plus-plus-cleanup');
        dragDropHandler.destroy();
        eventSource.removeListener('resizeUI', resizeHandler);
        eventSource.removeListener(event_types.CHAT_CHANGED, chatChangedHandler);
        eventSource.removeListener(CUSTOM_GALLERY_REMOVED_EVENT, cleanup);
    };

    eventSource.on('resizeUI', resizeHandler);
    eventSource.on(event_types.CHAT_CHANGED, chatChangedHandler);
    eventSource.once(CUSTOM_GALLERY_REMOVED_EVENT, cleanup);
    gallery.data('gallery-plus-plus-cleanup', cleanup);

    // Fixed-size grid thumbnails need no image-load race or forced resize.
    gallery.css('height', 'unset');
}

/** Returns the active folder recorded on the mounted gallery panel. */
function getOpenGalleryUrl(fallback) {
    const value = $('#galleryPlusPlus').attr('data-gallery-url');
    return value === undefined || value === '' ? fallback : value;
}

/**
 * Installs items in an existing modal when possible. The inner nanogallery2
 * instance and its handlers are destroyed/recreated while #galleryPlusPlus stays put.
 * @param {Array<Object>} items
 * @param {string} url
 * @param {number} requestToken
 */
async function renderGalleryItems(items, url, requestToken) {
    if (requestToken !== galleryRequestToken) return;
    let panel = $('#movingDivs > #galleryPlusPlus');

    if (panel.length) {
        panel.attr('data-gallery-url', String(url ?? ''));
        const gallery = panel.find('#dragGalleryPlusPlus');
        const cleanup = gallery.data('gallery-plus-plus-cleanup');
        if (typeof cleanup === 'function') cleanup();
        gallery.off('contextmenu.galleryPlusPlus')
            .removeData('gallery-plus-plus-cleanup')
            .removeClass()
            .empty()
            .css('height', 'unset');
    } else {
        await makeMovable(url);
        panel = $('#movingDivs > #galleryPlusPlus');
        if (requestToken !== galleryRequestToken) {
            removeGalleryPanel();
            return;
        }
        panel.attr('data-gallery-url', String(url ?? ''));
    }

    if (requestToken !== galleryRequestToken || !panel.length || !panel[0].isConnected) return;
    await initGallery(items, url);
    if (requestToken === galleryRequestToken) applyGallerySideToOpenWindows(false);
}

/**
 * Refreshes gallery content without unmounting the draggable modal.
 * @param {string} url Folder to display
 * @returns {Promise<void>}
 */
async function refreshGalleryContent(url) {
    if (!$('#movingDivs > #galleryPlusPlus').length) {
        return showCharGallery(deleteModeActive);
    }

    const requestToken = ++galleryRequestToken;
    try {
        const items = await getGalleryItems(url);
        if (requestToken !== galleryRequestToken || !$('#movingDivs > #galleryPlusPlus').length) return;
        await renderGalleryItems(items, url, requestToken);
    } catch (error) {
        console.error('Failed to refresh gallery:', error);
        toastr.error(t`Failed to refresh the gallery.`);
    }
}

/**
 * Displays a character gallery using the nanogallery2 library.
 *
 * This function takes care of:
 * - Loading necessary resources for the gallery on the first invocation.
 * - Preparing gallery items based on the character or group selection.
 * - Handling the drag-and-drop functionality for image upload.
 * - Displaying the gallery in a popup.
 * - Cleaning up resources when the gallery popup is closed.
 *
 * @returns {Promise<void>} - Promise representing the completion of the gallery display process.
 */
async function showCharGallery(deleteModeState = false) {
    const requestToken = ++galleryRequestToken;

    try {
        await loadGalleryAssets();
        if (!galleryWelcomeShown) {
            toastr.info('Images can also be found in the folder `user/images`', 'Drag and drop images onto the gallery to upload them', { timeOut: 6000 });
            galleryWelcomeShown = true;
        }

        deleteModeActive = deleteModeState;
        const context = SillyTavern.getContext();
        let url = context.groupId || selected_group;
        if (!context.groupId && context.characterId !== undefined && context.characterId !== null) {
            url = getGalleryFolder(getCurrentGalleryCharacter());
        }

        const items = await getGalleryItems(url);
        if (requestToken !== galleryRequestToken) return;
        await renderGalleryItems(items, url, requestToken);
    } catch (err) {
        console.error('Failed to show gallery:', err);
        toastr.error(t`Failed to load the gallery.`);
    }
}

/**
 * Uploads a given file to a specified URL and reports the result. Callers
 * refresh the gallery contents in place after their upload batch completes.
 *
 * @param {File} file - The file object to be uploaded.
 * @param {string} url - The URL indicating where the file should be uploaded.
 * @returns {Promise<void>} - Promise representing the completion of the file upload and gallery refresh.
 */
async function uploadFile(file, url) {
    try {
        // Convert the file to a base64 string
        const fileBase64 = await getBase64Async(file);
        const base64Data = fileBase64.split(',')[1];
        const extension = getFileExtension(file);
        const path = await saveBase64AsFile(base64Data, url, '', extension);

        toastr.success(t`File uploaded successfully. Saved at: ${path}`);
    } catch (error) {
        console.error('There was an issue uploading the file:', error);

        // Replacing alert with toastr error notification
        toastr.error(t`Failed to upload the file.`);
    }
}

/**
 * Creates a new draggable container based on a template.
 * This function takes a template with the ID 'generic_draggable_template' and clones it.
 * The cloned element has its attributes set, a new child div appended, and is made visible on the body.
 * Additionally, it sets up the element to prevent dragging on its images.
 * @param {string} url - The URL of the image source.
 * @returns {Promise<void>} - Promise representing the completion of the draggable container creation.
 */
async function makeMovable(url) {
    const id = 'galleryPlusPlus';
    const template = $('#generic_draggable_template').html();
    const newElement = $(template);
    newElement.css({ 'background-color': 'var(--SmartThemeBlurTintColor)', 'opacity': 0 });
    newElement.attr('forChar', id);
    newElement.attr('id', id);
    newElement.attr('data-gallery-url', String(url ?? ''));
    newElement.find('.drag-grabber').attr('id', `${id}header`);
    const dragTitle = newElement.find('.dragTitle');
    dragTitle.addClass('flex-container justifySpaceBetween alignItemsBaseline');
    const titleText = document.createElement('span');
    titleText.textContent = t`Image Gallery`;
    dragTitle.append(titleText);

    // Create a container for the controls
    const controlsContainer = document.createElement('div');
    controlsContainer.classList.add('flex-container', 'alignItemsCenter');

    const sortSelect = document.createElement('select');
    sortSelect.classList.add('gallery-plus-plus-sort-select');

    for (const sort of Object.values(SORT)) {
        const option = document.createElement('option');
        option.value = sort.value;
        option.textContent = sort.label;
        sortSelect.appendChild(option);
    }

    sortSelect.addEventListener('change', async () => {
        const selectedOption = sortSelect.options[sortSelect.selectedIndex].value;
        setSortOrder(selectedOption);
        await refreshGalleryContent(getOpenGalleryUrl(url));
    });

    sortSelect.value = getSortOrder();
    controlsContainer.appendChild(sortSelect);

    const gallerySideToggle = document.createElement('div');
    gallerySideToggle.classList.add('menu_button', 'menu_button_icon', 'interactable', 'gallery-plus-plus-side-toggle');
    const updateGallerySideToggle = () => {
        const side = getGallerySide();
        gallerySideToggle.classList.toggle('toggled', side === 'right');
        gallerySideToggle.title = side === 'right'
            ? t`Move gallery to the left side`
            : t`Move gallery to the right side`;
        gallerySideToggle.setAttribute('aria-label', gallerySideToggle.title);
        gallerySideToggle.setAttribute('aria-pressed', String(side === 'right'));
        gallerySideToggle.innerHTML = '<i class="fa-solid fa-right-left fa-fw"></i>';
    };
    updateGallerySideToggle();
    gallerySideToggle.addEventListener('click', () => {
        toggleGallerySide();
        updateGallerySideToggle();
    });
    controlsContainer.appendChild(gallerySideToggle);

    // Create the "Add Image" button
    const addImageButton = document.createElement('div');
    addImageButton.classList.add('menu_button', 'menu_button_icon', 'interactable');
    addImageButton.title = t`Add Image`;
    addImageButton.innerHTML = '<i class="fa-solid fa-plus fa-fw"></i><div>Add Image</div>';

    /**
     * Create a compact page-flip button. Using nanogallery2's instance API
     * avoids its jQuery wrapper typo in the next-page method.
     */
    const createPageButton = (direction, icon, label) => {
        const button = document.createElement('div');
        button.classList.add('menu_button', 'menu_button_icon', 'interactable', 'gallery-plus-plus-page-button');
        button.title = label;
        button.setAttribute('aria-label', label);
        button.innerHTML = `<i class="${icon}"></i>`;
        button.addEventListener('click', () => {
            const liveGallery = $('#dragGalleryPlusPlus');
            if (!liveGallery.length) return;
            const instance = liveGallery.nanogallery2('instance');
            if (!instance) return;
            if (direction === 'previous') {
                instance.PaginationPreviousPage();
            } else {
                instance.PaginationNextPage();
            }
        });
        return button;
    };

    // The compact page buttons intentionally sit immediately to the right of
    // Add Image, as requested.
    const previousPageButton = createPageButton('previous', 'fa-solid fa-chevron-left fa-fw', t`Previous gallery page`);
    const nextPageButton = createPageButton('next', 'fa-solid fa-chevron-right fa-fw', t`Next gallery page`);

    // Create a hidden file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*,video/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';

    // Trigger file input when the button is clicked
    addImageButton.addEventListener('click', () => {
        fileInput.click();
    });

    // Handle file selection
    fileInput.addEventListener('change', async () => {
        const files = fileInput.files;
        try {
            if (files.length > 0) {
                for (const file of files) {
                    await uploadFile(file, getOpenGalleryUrl(url));
                }
                // Refresh the current folder without unmounting the modal.
                await refreshGalleryContent(getOpenGalleryUrl(url));
            }
        } finally {
            // Clearing the input also lets the user select the exact same file
            // again later, which would otherwise not fire a `change` event.
            fileInput.value = '';
        }
    });

    controlsContainer.appendChild(addImageButton);
    controlsContainer.appendChild(previousPageButton);
    controlsContainer.appendChild(nextPageButton);
    dragTitle.append(controlsContainer);
    newElement.append(fileInput); // Append hidden file input to the main element

    // add no-scrollbar class to this element
    newElement.addClass('no-scrollbar');

    // get the close button and set its id and data-related-id
    const closeButton = newElement.find('.dragClose');
    closeButton.attr('id', `${id}close`);
    closeButton.attr('data-related-id', `${id}`);

    const topBarElement = document.createElement('div');
    topBarElement.classList.add('flex-container', 'alignItemsCenter');

    let folderChangeRequest = 0;
    const onChangeFolder = async (/** @type {Event|string} */ eventOrFolder) => {
        if (eventOrFolder instanceof KeyboardEvent && eventOrFolder.key !== 'Enter') {
            return;
        }

        // Capture the selected value and character identity before awaiting any
        // network operation. This prevents an autocomplete selection from being
        // replaced by a later UI event or a character switch.
        const requestedFolder = String(typeof eventOrFolder === 'string'
            ? eventOrFolder
            : galleryFolderInput.value).trim();
        if (!requestedFolder) {
            toastr.warning(t`Folder name cannot be empty`);
            return;
        }

        const requestId = ++folderChangeRequest;
        const contextAtSelection = SillyTavern.getContext();
        const characterIdAtSelection = contextAtSelection.characterId;
        const avatarAtSelection = contextAtSelection.characters?.[characterIdAtSelection]?.avatar;

        try {
            if (contextAtSelection.groupId) {
                throw new Error('Cannot change gallery folder in group chat');
            }
            if (characterIdAtSelection === undefined || characterIdAtSelection === null) {
                throw new Error('Character is not selected');
            }
            if (!avatarAtSelection) {
                throw new Error('Character PNG ID is not found');
            }

            const newUrl = await getSanitizedFilename(requestedFolder);
            if (requestId !== folderChangeRequest) return;

            updateGalleryFolder(newUrl, { characterId: characterIdAtSelection, avatar: avatarAtSelection });
            galleryFolderInput.value = newUrl;
            galleryFoldersCache = null;
            galleryFoldersCacheTime = 0;
            $('#galleryPlusPlus').attr('data-gallery-url', newUrl);
            await refreshGalleryContent(newUrl);
            toastr.info(t`Gallery folder changed to ${newUrl}`);
        } catch (error) {
            console.error('Failed to change gallery folder:', error);
            toastr.error(error?.message || t`Unknown error`, t`Failed to change gallery folder`);
        }
    };

    const onRestoreFolder = async () => {
        try {
            restoreGalleryFolder();
            const restoredUrl = getGalleryFolder(getCurrentGalleryCharacter());
            galleryFolderInput.value = restoredUrl;
            $('#galleryPlusPlus').attr('data-gallery-url', restoredUrl);
            await refreshGalleryContent(restoredUrl);
        } catch (error) {
            console.error('Failed to restore gallery folder:', error);
            toastr.error(error?.message || t`Unknown error`, t`Failed to restore gallery folder`);
        }
    };

    const galleryFolderInput = document.createElement('input');
    galleryFolderInput.type = 'text';
    galleryFolderInput.placeholder = t`Folder Name`;
    galleryFolderInput.title = t`Enter a folder name to change the gallery folder`;
    galleryFolderInput.value = url;
    galleryFolderInput.classList.add('text_pole', 'gallery-plus-plus-folder-input', 'flex1');
    galleryFolderInput.addEventListener('keyup', onChangeFolder);

    const galleryFolderAccept = document.createElement('div');
    galleryFolderAccept.classList.add('right_menu_button', 'fa-solid', 'fa-check', 'fa-fw');
    galleryFolderAccept.title = t`Change gallery folder`;
    galleryFolderAccept.addEventListener('click', onChangeFolder);

    const galleryDeleteMode = document.createElement('div');
    galleryDeleteMode.classList.add('right_menu_button', 'fa-solid', 'fa-trash', 'fa-fw');
    galleryDeleteMode.classList.toggle('warning', deleteModeActive);
    galleryDeleteMode.title = t`Delete mode`;
    galleryDeleteMode.addEventListener('click', () => {
        deleteModeActive = !deleteModeActive;
        galleryDeleteMode.classList.toggle('warning', deleteModeActive);
        if (deleteModeActive) {
            toastr.info(t`Delete mode is ON. Click on images you want to delete.`);
        }
    });

    const galleryFolderRestore = document.createElement('div');
    galleryFolderRestore.classList.add('right_menu_button', 'fa-solid', 'fa-recycle', 'fa-fw');
    galleryFolderRestore.title = t`Restore gallery folder`;
    galleryFolderRestore.addEventListener('click', onRestoreFolder);

    topBarElement.appendChild(galleryFolderInput);
    topBarElement.appendChild(galleryFolderAccept);
    topBarElement.appendChild(galleryDeleteMode);
    topBarElement.appendChild(galleryFolderRestore);
    newElement.append(topBarElement);

    // Load folder suggestions only when the user focuses the input. This avoids
    // blocking modal creation on a second API request and keeps suggestions fresh.
    $(galleryFolderInput)
        .autocomplete({
            source: async (i, o) => {
                const folders = await getGalleryFolders();
                const term = String(i.term ?? '').toLowerCase();
                const filtered = folders.filter(f => f.toLowerCase().includes(term));
                o(filtered);
            },
            select: (e, u) => {
                const selectedFolder = String(u?.item?.value ?? '');
                galleryFolderInput.value = selectedFolder;
                void onChangeFolder(selectedFolder);
                return false;
            },
            minLength: 0,
        })
        .on('focus', () => $(galleryFolderInput).autocomplete('search', ''));

    //add a div for the gallery
    newElement.append('<div id="dragGalleryPlusPlus"></div>');

    $('#dragGalleryPlusPlus').css('display', 'block');

    $('#movingDivs').append(newElement);

    loadMovingUIElementState(newElement);
    $(`.draggable[forChar="${id}"]`).css('display', 'block');
    dragElement(newElement);
    ensureElementOnGallerySide(newElement, getGallerySide());
    newElement.transition({
        opacity: 1,
        duration: animation_duration,
        easing: animation_easing,
    });

    $(`.draggable[forChar="${id}"] img`).on('dragstart', (e) => {
        e.preventDefault();
        return false;
    });
}

/**
 * Sets the gallery folder to a new URL.
 * @param {string} newUrl - The new URL to set for the gallery folder.
 */
function updateGalleryFolder(newUrl, characterRef = {}) {
    const folder = String(newUrl ?? '').trim();
    if (!folder) {
        throw new Error('Folder name cannot be empty');
    }

    const context = SillyTavern.getContext();
    if (context.groupId) {
        throw new Error('Cannot change gallery folder in group chat');
    }

    const characterId = characterRef.characterId ?? context.characterId;
    if (characterId === undefined || characterId === null) {
        throw new Error('Character is not selected');
    }

    const character = context.characters?.[characterId];
    const avatar = characterRef.avatar ?? character?.avatar;
    const name = character?.name;
    if (!avatar) {
        throw new Error('Character PNG ID is not found');
    }

    const currentGallerySettings = context.extensionSettings.galleryPlusPlus ?? (context.extensionSettings.galleryPlusPlus = {});
    const existingFolders = currentGallerySettings.folders && typeof currentGallerySettings.folders === 'object'
        ? currentGallerySettings.folders
        : {};
    const nextFolders = { ...existingFolders };

    if (folder === name) {
        // Selecting the character's own name means use the default folder.
        delete nextFolders[avatar];
    } else {
        // Store a per-avatar override. Replacing the object also makes the
        // mutation explicit for settings serializers and proxies.
        nextFolders[avatar] = folder;
    }

    currentGallerySettings.folders = nextFolders;
    context.saveSettingsDebounced();
}


/**
 * Restores the gallery folder to the default value.
 */
function restoreGalleryFolder() {
    const context = SillyTavern.getContext();
    if (context.groupId) {
        throw new Error('Cannot change gallery folder in group chat');
    }
    if (context.characterId === undefined || context.characterId === null) {
        throw new Error('Character is not selected');
    }
    const avatar = context.characters?.[context.characterId]?.avatar;
    if (!avatar) {
        throw new Error('Character PNG ID is not found');
    }
    const existingOverride = context.extensionSettings.galleryPlusPlus.folders[avatar];
    if (!existingOverride) {
        throw new Error('No folder override found');
    }
    const folders = { ...(context.extensionSettings.galleryPlusPlus?.folders ?? {}) };
    delete folders[avatar];
    context.extensionSettings.galleryPlusPlus.folders = folders;
    context.saveSettingsDebounced();
}

/**
 * Creates a new draggable image based on a template.
 *
 * This function clones a provided template with the ID 'generic_draggable_template',
 * appends the given image URL, ensures the element has a unique ID,
 * and attaches the element to the body. After appending, it also prevents
 * dragging on the appended image.
 *
 * @param {string} id - A base identifier for the new draggable element.
 * @param {string} url - The URL of the image to be added to the draggable element.
 * @param {'left'|'right'} side - The fixed screen side where the window should open.
 */
function makeDragImg(id, url, side = 'left') {
    // Step 1: Clone the template content
    const template = document.getElementById('generic_draggable_template');

    if (!(template instanceof HTMLTemplateElement)) {
        console.error('The element is not a <template> tag');
        return;
    }

    const newElement = document.importNode(template.content, true);

    // Step 2: Append the given image
    const mediaElement = isVideo(url)
        ? document.createElement('video')
        : document.createElement('img');
    mediaElement.src = url;
    if (mediaElement instanceof HTMLVideoElement) {
        mediaElement.controls = true;
        mediaElement.autoplay = true;
    }

    let uniqueId = `draggable_${id}`;
    const draggableElem = /** @type {HTMLElement} */ (newElement.querySelector('.draggable'));
    if (draggableElem) {
        draggableElem.appendChild(mediaElement);

        // Find a unique id for the draggable element

        let counter = 1;
        while (document.getElementById(uniqueId)) {
            uniqueId = `draggable_${id}_${counter}`;
            counter++;
        }
        draggableElem.id = uniqueId;

        // Add the galleryPlusPlusImageDraggable to have unique class
        draggableElem.classList.add('galleryPlusPlusImageDraggable');

        // Ensure that the newly added element is displayed as block
        draggableElem.style.display = 'block';
        //and has no padding unlike other non-zoomed-avatar draggables
        draggableElem.style.padding = '0';

        // Add an id to the close button
        // If the close button exists, set related-id
        const closeButton = /** @type {HTMLElement} */ (draggableElem.querySelector('.dragClose'));
        if (closeButton) {
            closeButton.id = `${uniqueId}close`;
            closeButton.dataset.relatedId = uniqueId;
        }

        // Find the .drag-grabber and set its matching unique ID
        const dragGrabber = draggableElem.querySelector('.drag-grabber');
        if (dragGrabber) {
            dragGrabber.id = `${uniqueId}header`; // appending _header to make it match the parent's unique ID
        }
    }

    // Step 3: Attach it to the movingDivs container
    document.getElementById('movingDivs').appendChild(newElement);

    // Step 4: Load the saved state for this window and enable dragging
    const appendedElement = document.getElementById(uniqueId);
    if (appendedElement) {
        var elmntName = $(appendedElement);
        loadMovingUIElementState(elmntName);
        dragElement(elmntName);
        keepGalleryWindowOnBackLayer(elmntName);
        ensureElementOnGallerySide(elmntName, side);

        // Prevent dragging the image
        $(`#${uniqueId} img`).on('dragstart', (e) => {
            e.preventDefault();
            return false;
        });
    } else {
        console.error('Failed to append the template content or retrieve the appended content.');
    }
}

/**
 * Sanitizes a given ID to ensure it can be used as an HTML ID.
 * This function replaces spaces and non-word characters with dashes.
 * It also removes any non-ASCII characters.
 * @param {string} id - The ID to be sanitized.
 * @returns {string} - The sanitized ID.
 */
function sanitizeHTMLId(id) {
    // Replace spaces and non-word characters
    id = id.replace(/\s+/g, '-')
        .replace(/[^\x00-\x7F]/g, '-')
        .replace(/\W/g, '');

    return id;
}

/**
 * Processes a list of items (containing URLs) and creates a draggable box for the first item.
 *
 * If the provided list of items is non-empty, it takes the URL of the first item,
 * derives an ID from the URL, and uses the makeDragImg function to create
 * a draggable image element based on that ID and URL.
 *
 * @param {Array} items - A list of items where each item has a responsiveURL method that returns a URL.
 * @param {'left'|'right'} side - The fixed screen side where the window should open.
 */
function viewWithDragbox(items, side = 'left') {
    if (items && items.length > 0) {
        const url = items[0].responsiveURL(); // Get the URL of the clicked image/video
        if (deleteModeActive) {
            Popup.show.confirm(t`Are you sure you want to delete this image?`, url)
                .then(async (confirmed) => {
                    if (!confirmed) {
                        return;
                    }
                    deleteGalleryItem(url).then(() => refreshGalleryContent(getOpenGalleryUrl()));
                });
        } else {
            // ID should just be the last part of the URL, removing the extension
            const id = sanitizeHTMLId(url.substring(url.lastIndexOf('/') + 1, url.lastIndexOf('.')));
            makeDragImg(id, url, side);
        }
    }
}


// Registers a simple command for opening the char gallery.
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'show-gallery-plus',
    aliases: ['sgp'],
    callback: () => {
        showCharGallery();
        return '';
    },
    helpString: 'Shows the gallery.',
}));
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'list-gallery-plus',
    aliases: ['lgp'],
    callback: listGalleryCommand,
    returns: 'list of images',
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'char',
            description: 'character name',
            typeList: [ARGUMENT_TYPE.STRING],
            enumProvider: commonEnumProviders.characters('character'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'group',
            description: 'group name',
            typeList: [ARGUMENT_TYPE.STRING],
            enumProvider: commonEnumProviders.characters('group'),
        }),
    ],
    helpString: 'List images in the gallery of the current char / group or a specified char / group.',
}));

async function listGalleryCommand(args) {
    try {
        const context = SillyTavern.getContext();
        let url = args.char ?? (args.group ? groups.find(it => it.name == args.group)?.id : null) ?? (selected_group || context.characterId);
        if (!args.char && !args.group && !selected_group && context.characterId !== undefined && context.characterId !== null) {
            url = getGalleryFolder(getCurrentGalleryCharacter());
        }

        const [files, sanitizedUrl] = await Promise.all([
            fetchImageFileList(url),
            getSanitizedFilename(url),
        ]);
        return JSON.stringify(files.map(file => `user/images/${sanitizedUrl}/${file}`));
    } catch (err) {
        console.error(err);
    }
    return JSON.stringify([]);
}

function isTypingInGalleryContext() {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;

    return activeElement instanceof HTMLInputElement
        || activeElement instanceof HTMLTextAreaElement
        || activeElement instanceof HTMLSelectElement
        || activeElement.isContentEditable
        || Boolean(activeElement.closest('[contenteditable="true"]'));
}

/**
 * Toggles the gallery panel open/closed.
 * When closing an existing panel, invalidate any in-flight gallery load so it
 * cannot recreate the panel after the user has closed it.
 */
function toggleGalleryPanel() {
    const galleryPanel = $('#dragGalleryPlusPlus').closest('#galleryPlusPlus');
    if (galleryPanel.length) {
        galleryRequestToken++;
        removeGalleryPanel();
        return;
    }

    void showCharGallery();
}

/**
 * Closes every currently-opened gallery picture window. Reusing each window's
 * existing close button keeps the normal draggable cleanup/animation path.
 */
function closeAllGalleryImages() {
    $('.galleryPlusPlusImageDraggable .dragClose').each(function () {
        this.click();
    });
}

/**
 * Handles gallery hotkeys without stealing them from text inputs.
 * '[' moves to the previous page, ']' moves to the next page, '\\' toggles
 * the gallery panel, and "=" closes all currently-opened gallery pictures.
 * @param {KeyboardEvent} event Keyboard event
 */
function handleGalleryHotkeys(event) {
    if (event.isComposing || event.defaultPrevented || (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)) {
        return;
    }
    if (isTypingInGalleryContext()) return;
    if (Popup.util.isPopupOpen()) return;

    if (event.key === '\\') {
        toggleGalleryPanel();
        event.preventDefault();
        return;
    }

    if (event.key === '=') {
        closeAllGalleryImages();
        event.preventDefault();
        return;
    }

    if (event.key !== '[' && event.key !== ']') return;

    const gallery = $('#dragGalleryPlusPlus');
    if (!gallery.length) return;

    const instance = gallery.nanogallery2('instance');
    if (!instance) return;

    if (event.key === '[') {
        instance.PaginationPreviousPage();
    } else {
        instance.PaginationNextPage();
    }
    event.preventDefault();
}

function addGalleryWandButton() {
    const showGalleryContainer = document.getElementById('gallery_wand_container') || document.getElementById('extensionsMenu');
    if (!(showGalleryContainer instanceof HTMLElement)) {
        return;
    }
    if (document.getElementById('show_gallery_plus_plus_wand_button')) {
        return;
    }
    const showGalleryButton = document.createElement('div');
    showGalleryButton.id = 'show_gallery_plus_plus_wand_button';
    showGalleryButton.classList.add('list-group-item', 'flex-container', 'flexGap5');
    const showGalleryIcon = document.createElement('div');
    showGalleryIcon.classList.add('fa-solid', 'fa-sd-card', 'extensionsMenuExtensionButton');
    const showGalleryText = document.createElement('span');
    showGalleryText.textContent = translate('Show Gallery');
    showGalleryButton.appendChild(showGalleryIcon);
    showGalleryButton.appendChild(showGalleryText);
    showGalleryButton.addEventListener('click', () => {
        showCharGallery();
    });
    showGalleryContainer.appendChild(showGalleryButton);
}

// On extension load, ensure the settings are initialized
export async function init() {
    if (galleryInitialized) return;
    galleryInitialized = true;

    initSettings();
    document.addEventListener('keydown', handleGalleryHotkeys, { passive: false });

    // Warm the gallery assets during idle time; the first click shares this load.
    const preloadGalleryAssets = () => {
        void loadGalleryAssets().catch(error => {
            console.warn('Gallery asset preload failed; assets will retry on open:', error);
        });
    };
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(preloadGalleryAssets, { timeout: 3000 });
    } else {
        window.setTimeout(preloadGalleryAssets, 1500);
    }
    eventSource.on(event_types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        const context = SillyTavern.getContext();
        const galleryFolder = context.extensionSettings.galleryPlusPlus.folders[oldAvatar];
        if (galleryFolder) {
            context.extensionSettings.galleryPlusPlus.folders[newAvatar] = galleryFolder;
            delete context.extensionSettings.galleryPlusPlus.folders[oldAvatar];
            context.saveSettingsDebounced();
        }
    });
    eventSource.on(event_types.CHARACTER_DELETED, (data) => {
        const avatar = data?.character?.avatar;
        if (!avatar) return;
        const context = SillyTavern.getContext();
        delete context.extensionSettings.galleryPlusPlus.folders[avatar];
        context.saveSettingsDebounced();
    });
    eventSource.on(event_types.CHARACTER_MANAGEMENT_DROPDOWN, (selectedOptionId) => {
        if (selectedOptionId === 'show_char_gallery_plus_plus') {
            showCharGallery();
        }
    });

    // Add an option to the dropdown
    $('#char-management-dropdown').append(
        $('<option>', {
            id: 'show_char_gallery_plus_plus',
            text: translate('Show Gallery'),
        }),
    );
    addGalleryWandButton();
}
