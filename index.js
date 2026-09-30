/*
 * Gallery++ Version 1.5.0
 * Modified from SillyTavern's Gallery extension, originally authored by City-Unit.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
    eventSource,
    getRequestHeaders,
    event_types,
    animation_duration,
    animation_easing,
} from '../../../../script.js';
import { groups, selected_group } from '../../../group-chats.js';
import { loadFileToDocument, getBase64Async, getSanitizedFilename, saveBase64AsFile, getFileExtension, getVideoThumbnail, clamp } from '../../../utils.js';
import { power_user } from '../../../power-user.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { DragAndDropHandler } from '../../../dragdrop.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { t, translate } from '../../../i18n.js';
import { Popup } from '../../../popup.js';
import { deleteMediaFromServer } from '../../../chats.js';
import { MEDIA_REQUEST_TYPE, VIDEO_EXTENSIONS } from '../../../constants.js';

const isVideo = (/** @type {string} */ url) => {
    const lowerUrl = String(url).toLowerCase();
    return VIDEO_EXTENSIONS.some(ext => {
        const normalizedExt = String(ext).toLowerCase();
        return lowerUrl.endsWith(normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`);
    });
};
// Resolve bundled assets from the actual installed extension URL.
// This works for both user-scoped and all-users third-party installs, regardless
// of the repository/folder name SillyTavern chooses for the clone.
const extensionBaseUrl = new URL('.', import.meta.url);
const getExtensionAssetUrl = (fileName) => new URL(fileName, extensionBaseUrl).href;
let firstTime = true;
let deleteModeActive = false;
let galleryRequestToken = 0;
let galleryInitialized = false;
let galleryFoldersCache = null;
let galleryFoldersCacheTime = 0;
const galleryVideoThumbnailCache = new Map();
const GALLERY_FOLDERS_CACHE_TTL = 15_000;
const DEFAULT_GALLERY_SIDE = 'left';
const GALLERY_BACK_Z_INDEX = '1';


// Remove all draggables associated with the gallery
$('#movingDivs').on('click', '.dragClose', function () {
    const relatedId = $(this).data('related-id');
    if (!relatedId) return;
    const relatedElement = $(`#movingDivs > .draggable[id="${relatedId}"]`);
    relatedElement.transition({
        opacity: 0,
        duration: animation_duration,
        easing: animation_easing,
        complete: () => {
            relatedElement.remove();
        },
    });
});

const CUSTOM_GALLERY_REMOVED_EVENT = 'galleryRemoved';

const mutationObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        mutation.removedNodes.forEach((node) => {
            if (node instanceof HTMLElement && node.tagName === 'DIV' && node.id === 'gallery') {
                eventSource.emit(CUSTOM_GALLERY_REMOVED_EVENT);
            }
        });
    });
});

mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
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
    if (!context.extensionSettings.gallery) {
        context.extensionSettings.gallery = structuredClone(defaultSettings);
        shouldSave = true;
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings.gallery, key)) {
            context.extensionSettings.gallery[key] = structuredClone(defaultSettings[key]);
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
    const folders = context.extensionSettings.gallery?.folders ?? {};
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
    const side = SillyTavern.getContext().extensionSettings.gallery.side;
    return side === 'right' ? 'right' : DEFAULT_GALLERY_SIDE;
}

/**
 * Persists the gallery side toggle state.
 * @param {'left'|'right'} side The new side
 */
function setGallerySide(side) {
    const context = SillyTavern.getContext();
    context.extensionSettings.gallery.side = side === 'right' ? 'right' : DEFAULT_GALLERY_SIDE;
    context.saveSettingsDebounced();
}

/**
 * Waits for two animation frames so newly-created draggable panels have their
 * final layout before we measure and position them. This replaces arbitrary
 * 100ms waits and makes opening the gallery feel more responsive.
 * @returns {Promise<void>} Resolves after two animation frames
 */
function waitForLayout() {
    return new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
}

/**
 * Calculates a safe number of thumbnail rows for the usable viewport.
 * Nanogallery2 lazily creates thumbnails based on the viewport, so letting a
 * page extend beneath the browser/taskbar can also cause only part of a page
 * to be instantiated. Keeping a few hundred pixels in reserve for the
 * gallery header/controls prevents both problems on portrait-heavy galleries.
 */
function getGalleryMaxRows(thumbnailHeight) {
    const viewportHeight = Math.max(360, Math.floor(window.visualViewport?.height ?? window.innerHeight));
    const usableHeight = Math.max(thumbnailHeight, Math.floor(viewportHeight * 0.82 - 220));
    return clamp(Math.floor(usableHeight / thumbnailHeight), 1, 8);
}

/**
 * Re-measures nanogallery2 after a page change. The library calculates row
 * membership before all newly-visible image thumbnails have necessarily
 * completed layout, which can leave a page partially populated. Waiting for
 * the current thumbnails to decode and then resizing makes the page stable.
 */
async function stabilizeGalleryAfterPageChange(gallery) {
    await waitForLayout();
    if (!gallery.closest('#gallery').length) return;

    const imageElements = [...gallery.find('img')].filter(img => !img.complete);
    if (imageElements.length > 0) {
        const imageReady = imageElements.map(img => new Promise(resolve => {
            const done = () => resolve();
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
        }));
        await Promise.race([
            Promise.all(imageReady),
            new Promise(resolve => setTimeout(resolve, 1200)),
        ]);
    }

    if (!gallery.closest('#gallery').length) return;
    gallery.nanogallery2('resize');
    await waitForLayout();
    if (gallery.closest('#gallery').length) {
        gallery.nanogallery2('resize');
    }
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
    const elements = $('#gallery, .galleryImageDraggable');

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
 * Retrieves a list of gallery items based on a given URL. This function calls an API endpoint
 * to get the filenames and then constructs the item list.
 *
 * @param {string} url - The base URL to retrieve the list of images.
 * @returns {Promise<Array>} - Resolves with an array of gallery item objects, rejects on error.
 */
async function getGalleryItems(url) {
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

    const sanitizedUrl = await getSanitizedFilename(url);
    const data = await response.json();
    if (!Array.isArray(data)) {
        throw new Error('Gallery image list response was not an array');
    }

    const items = data.map(file => ({
        src: `user/images/${sanitizedUrl}/${file}`,
        srct: `user/images/${sanitizedUrl}/${file}`,
        title: '', // Optional title for each item
    }));

    // Thumbnail generation is client-side and can be expensive for video-heavy
    // folders. Use a small worker pool so a large gallery does not spawn dozens
    // of simultaneous video decodes, while still avoiding the old serial wait.
    const videoJobs = items
        .map((item, index) => ({ item, index, file: data[index] }))
        .filter(job => isVideo(job.file));

    const workerCount = Math.min(4, videoJobs.length);
    let nextJob = 0;

    const worker = async () => {
        while (true) {
            const jobIndex = nextJob++;
            if (jobIndex >= videoJobs.length) return;

            const { item, file } = videoJobs[jobIndex];
            const cachedThumbnail = galleryVideoThumbnailCache.get(item.src);
            if (cachedThumbnail) {
                item.srct = cachedThumbnail;
                continue;
            }

            try {
                // 150px of max height with some allowance for various aspect ratios
                const maxSide = Math.round(150 * 1.5);
                const thumbnail = await getVideoThumbnail(item.src, maxSide, maxSide);
                if (thumbnail) {
                    item.srct = thumbnail;
                    galleryVideoThumbnailCache.set(item.src, thumbnail);
                }
            } catch (error) {
                console.error(`Failed to generate video thumbnail for gallery item ${file}:`, error);
            }
        }
    };

    if (workerCount > 0) {
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }

    // Keep the in-memory cache bounded; gallery thumbnails are regenerated if
    // they fall out, which is preferable to retaining an unbounded base64 cache.
    while (galleryVideoThumbnailCache.size > 100) {
        const oldestKey = galleryVideoThumbnailCache.keys().next().value;
        galleryVideoThumbnailCache.delete(oldestKey);
    }

    return items;
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
    context.extensionSettings.gallery.sort = order;
    context.saveSettingsDebounced();
}

/**
 * Retrieves the current sort order for the gallery.
 * @returns {string} The current sort order for the gallery.
 */
function getSortOrder() {
    return SillyTavern.getContext().extensionSettings.gallery.sort ?? defaultSettings.sort;
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
    // Exposed defaults for future tweaking
    const thumbnailHeight = 150;
    const paginationVisiblePages = 5;
    const paginationMaxLinesPerPage = 2;
    const galleryMaxRows = getGalleryMaxRows(thumbnailHeight);

    const nonce = `nonce-${Math.random().toString(36).substring(2, 15)}`;
    const gallery = $('#dragGallery');
    gallery.addClass(nonce);
    gallery.nanogallery2({
        'items': items,
        thumbnailWidth: 'auto',
        thumbnailHeight: thumbnailHeight,
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
        },
    });

    // nanogallery2 handles normal left-clicks through fnThumbnailOpen. Its
    // Hammer tap recognizer intentionally ignores non-primary mouse buttons,
    // so right-click needs a native contextmenu handler of its own. Resolve
    // the clicked picture by the source URL stored on the thumbnail rather
    // than by nanogallery2's internal data-idx.
    gallery.off('contextmenu.gallery');
    gallery.on('contextmenu.gallery', '.nGY2GThumbnail', function (event) {
        if (event.button !== 2) return;

        const itemUrl = this.getAttribute('data-gallery-src');
        if (!itemUrl) return;

        event.preventDefault();
        event.stopPropagation();

        viewWithDragbox([{
            responsiveURL: () => itemUrl,
        }], 'right');
    });

    const dragDropHandler = new DragAndDropHandler(`#dragGallery.${nonce}`, async (files) => {
        if (!Array.isArray(files) || files.length === 0) {
            return;
        }

        // Upload each file
        for (const file of files) {
            await uploadFile(file, url);
        }

        // Refresh the gallery
        const newItems = await getGalleryItems(url);
        $('#dragGallery').closest('#gallery').remove();
        await makeMovable(url);
        await waitForLayout();
        await initGallery(newItems, url);
    });

    const resizeHandler = function () {
        if (gallery.closest('#gallery').length) {
            gallery.nanogallery2('resize');
        }
    };

    const chatChangedHandler = function () {
        galleryRequestToken++;
        gallery.closest('#gallery').remove();
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
        gallery.off('contextmenu.gallery');
        gallery.removeData('gallery-source-items');
        dragDropHandler.destroy();
        eventSource.removeListener('resizeUI', resizeHandler);
        eventSource.removeListener(event_types.CHAT_CHANGED, chatChangedHandler);
        eventSource.removeListener(CUSTOM_GALLERY_REMOVED_EVENT, cleanup);
    };

    eventSource.on('resizeUI', resizeHandler);
    eventSource.on(event_types.CHAT_CHANGED, chatChangedHandler);
    eventSource.once(CUSTOM_GALLERY_REMOVED_EVENT, cleanup);

    // Set dropzone height to be the same as the parent
    gallery.css('height', gallery.parent().css('height'));

    // Give the browser a couple of frames to resolve the panel dimensions.
    await waitForLayout();
    //unset the height (which must be getting set by the gallery library at some point)
    gallery.css('height', 'unset');
    // Force a resize to make images display correctly.
    gallery.nanogallery2('resize');
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

    // Load necessary files if it's the first time calling the function
    if (firstTime) {
        await loadFileToDocument(
            getExtensionAssetUrl('nanogallery2.woff.min.css'),
            'css',
        );
        await loadFileToDocument(
            getExtensionAssetUrl('jquery.nanogallery2.min.js'),
            'js',
        );
        firstTime = false;
        toastr.info('Images can also be found in the folder `user/images`', 'Drag and drop images onto the gallery to upload them', { timeOut: 6000 });
    }

    try {
        deleteModeActive = deleteModeState;
        const context = SillyTavern.getContext();
        let url = context.groupId || selected_group;
        if (!context.groupId && context.characterId !== undefined && context.characterId !== null) {
            url = getGalleryFolder(getCurrentGalleryCharacter());
        }

        const items = await getGalleryItems(url);
        if (requestToken !== galleryRequestToken) return;

        // if there already is a gallery, destroy it and place this one in its place
        $('#dragGallery').closest('#gallery').remove();
        await makeMovable(url);
        if (requestToken !== galleryRequestToken) {
            $('#dragGallery').closest('#gallery').remove();
            return;
        }
        await initGallery(items, url);
        applyGallerySideToOpenWindows(false);
    } catch (err) {
        console.error('Failed to show gallery:', err);
        toastr.error(t`Failed to load the gallery.`);
    }
}

/**
 * Uploads a given file to a specified URL.
 * Once the file is uploaded, it provides a success message using toastr,
 * destroys the existing gallery, fetches the latest items, and reinitializes the gallery.
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
    const id = 'gallery';
    const template = $('#generic_draggable_template').html();
    const newElement = $(template);
    newElement.css({ 'background-color': 'var(--SmartThemeBlurTintColor)', 'opacity': 0 });
    newElement.attr('forChar', id);
    newElement.attr('id', id);
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
    sortSelect.classList.add('gallery-sort-select');

    for (const sort of Object.values(SORT)) {
        const option = document.createElement('option');
        option.value = sort.value;
        option.textContent = sort.label;
        sortSelect.appendChild(option);
    }

    sortSelect.addEventListener('change', async () => {
        const selectedOption = sortSelect.options[sortSelect.selectedIndex].value;
        setSortOrder(selectedOption);
        closeButton.trigger('click');
        await showCharGallery();
    });

    sortSelect.value = getSortOrder();
    controlsContainer.appendChild(sortSelect);

    const gallerySideToggle = document.createElement('div');
    gallerySideToggle.classList.add('menu_button', 'menu_button_icon', 'interactable', 'gallery-side-toggle');
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
        button.classList.add('menu_button', 'menu_button_icon', 'interactable', 'gallery-page-button');
        button.title = label;
        button.setAttribute('aria-label', label);
        button.innerHTML = `<i class="${icon}"></i>`;
        button.addEventListener('click', () => {
            const liveGallery = $('#dragGallery');
            if (!liveGallery.length) return;
            const instance = liveGallery.nanogallery2('instance');
            if (!instance) return;
            if (direction === 'previous') {
                instance.PaginationPreviousPage();
            } else {
                instance.PaginationNextPage();
            }
            void stabilizeGalleryAfterPageChange(liveGallery);
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
                    await uploadFile(file, url);
                }
                // Refresh the gallery.
                closeButton.trigger('click');
                await showCharGallery();
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
            closeButton.trigger('click');
            await showCharGallery();
            toastr.info(t`Gallery folder changed to ${newUrl}`);
        } catch (error) {
            console.error('Failed to change gallery folder:', error);
            toastr.error(error?.message || t`Unknown error`, t`Failed to change gallery folder`);
        }
    };

    const onRestoreFolder = async () => {
        try {
            restoreGalleryFolder();
            closeButton.trigger('click');
            await showCharGallery();
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
    galleryFolderInput.classList.add('text_pole', 'gallery-folder-input', 'flex1');
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

    // Populate the gallery folder input with a list of available folders
    const folders = await getGalleryFolders();
    $(galleryFolderInput)
        .autocomplete({
            source: (i, o) => {
                const term = i.term.toLowerCase();
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
    newElement.append('<div id="dragGallery"></div>');

    $('#dragGallery').css('display', 'block');

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

    const currentGallerySettings = context.extensionSettings.gallery ?? (context.extensionSettings.gallery = {});
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
    const existingOverride = context.extensionSettings.gallery.folders[avatar];
    if (!existingOverride) {
        throw new Error('No folder override found');
    }
    const folders = { ...(context.extensionSettings.gallery?.folders ?? {}) };
    delete folders[avatar];
    context.extensionSettings.gallery.folders = folders;
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

        // Add the galleryImageDraggable to have unique class
        draggableElem.classList.add('galleryImageDraggable');

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
                    deleteGalleryItem(url).then(() => showCharGallery(deleteModeActive));
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
    name: 'show-gallery',
    aliases: ['sg'],
    callback: () => {
        showCharGallery();
        return '';
    },
    helpString: 'Shows the gallery.',
}));
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'list-gallery',
    aliases: ['lg'],
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

        const items = await getGalleryItems(url);
        return JSON.stringify(items.map(it => it.src));
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
    const galleryPanel = $('#dragGallery').closest('#gallery');
    if (galleryPanel.length) {
        galleryRequestToken++;
        galleryPanel.remove();
        return;
    }

    void showCharGallery();
}

/**
 * Closes every currently-opened gallery picture window. Reusing each window's
 * existing close button keeps the normal draggable cleanup/animation path.
 */
function closeAllGalleryImages() {
    $('.galleryImageDraggable .dragClose').each(function () {
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

    const gallery = $('#dragGallery');
    if (!gallery.length) return;

    const instance = gallery.nanogallery2('instance');
    if (!instance) return;

    if (event.key === '[') {
        instance.PaginationPreviousPage();
    } else {
        instance.PaginationNextPage();
    }
    void stabilizeGalleryAfterPageChange(gallery);
    event.preventDefault();
}

function addGalleryWandButton() {
    const showGalleryContainer = document.getElementById('gallery_wand_container') || document.getElementById('extensionsMenu');
    if (!(showGalleryContainer instanceof HTMLElement)) {
        return;
    }
    if (document.getElementById('show_gallery_wand_button')) {
        return;
    }
    const showGalleryButton = document.createElement('div');
    showGalleryButton.id = 'show_gallery_wand_button';
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
    eventSource.on(event_types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        const context = SillyTavern.getContext();
        const galleryFolder = context.extensionSettings.gallery.folders[oldAvatar];
        if (galleryFolder) {
            context.extensionSettings.gallery.folders[newAvatar] = galleryFolder;
            delete context.extensionSettings.gallery.folders[oldAvatar];
            context.saveSettingsDebounced();
        }
    });
    eventSource.on(event_types.CHARACTER_DELETED, (data) => {
        const avatar = data?.character?.avatar;
        if (!avatar) return;
        const context = SillyTavern.getContext();
        delete context.extensionSettings.gallery.folders[avatar];
        context.saveSettingsDebounced();
    });
    eventSource.on(event_types.CHARACTER_MANAGEMENT_DROPDOWN, (selectedOptionId) => {
        if (selectedOptionId === 'show_char_gallery') {
            showCharGallery();
        }
    });

    // Add an option to the dropdown
    $('#char-management-dropdown').append(
        $('<option>', {
            id: 'show_char_gallery',
            text: translate('Show Gallery'),
        }),
    );
    addGalleryWandButton();
}
