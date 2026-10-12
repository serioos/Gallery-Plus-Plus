/*
 * Gallery++ — settings and per-character folder persistence.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Why the character → folder assignment used to vanish, and how it is protected now:
 *
 *  1. Saves were only ever debounced (~1 s). Closing the tab / stopping SillyTavern shortly after
 *     choosing a folder dropped the write. Every assignment change is now flushed immediately.
 *  2. The data lived in the generic `extension_settings.gallery` blob that the built-in Gallery
 *     also owns. Gallery++ now owns `extension_settings.gallery_plus_plus`, and mirrors the
 *     folder map back into the legacy key so switching extensions never loses assignments.
 *  3. As a last line of defence a copy is kept in localStorage; if the server-side map ever comes
 *     back empty while the local copy is not, the assignments are restored from it.
 *  4. The settings object is re-validated on every access instead of once at start-up, so a late
 *     settings reload or a partially corrupt file can never leave the extension with undefined data.
 */

import { LAYOUT_DEFAULTS, LAYOUT_LIMITS, normalizeLayout, clampInt } from './lib.js';

export const SETTINGS_KEY = 'gallery_plus_plus';
export const LEGACY_KEY = 'gallery';
export const LOCAL_BACKUP_KEY = 'gallery_plus_plus.folders.v2';
export const SORT_VALUES = Object.freeze(['nameAsc', 'nameDesc', 'dateDesc', 'dateAsc']);
const SCHEMA_VERSION = 2;

/**
 * @typedef {object} Host
 * @property {() => Record<string, any>} getRoot   Returns SillyTavern's `extension_settings` object.
 * @property {() => void} saveDebounced            Debounced settings save.
 * @property {() => (void|Promise<void>)} [saveNow] Immediate settings save (optional).
 * @property {Storage|null} [storage]              Storage used for the recovery copy.
 */

/** @type {Host|null} */
let host = null;
/** The settings object recovery was last evaluated for (recovery must not re-run after a deliberate clear). */
let recoveryCheckedFor = null;

/** @param {Host} h */
export function configureSettings(h) {
    host = h;
    recoveryCheckedFor = null;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function getStorage() {
    try {
        return host?.storage ?? null;
    } catch {
        return null;
    }
}

/** Returns a copy containing only string → non-empty string entries. */
function cleanFolderMap(map) {
    const out = {};
    if (!isPlainObject(map)) return out;
    for (const [avatar, folder] of Object.entries(map)) {
        if (typeof folder === 'string' && folder.trim() !== '') out[avatar] = folder;
    }
    return out;
}

function readBackup() {
    try {
        const raw = getStorage()?.getItem(LOCAL_BACKUP_KEY);
        return raw ? cleanFolderMap(JSON.parse(raw)) : {};
    } catch {
        return {};
    }
}

function writeBackup(folders) {
    try {
        getStorage()?.setItem(LOCAL_BACKUP_KEY, JSON.stringify(folders));
    } catch {
        // Storage may be full or disabled; the server-side copy is still authoritative.
    }
}

/** Mirrors the folder map into the legacy `gallery` key (kept for the built-in Gallery). */
function mirrorToLegacy(root, folders) {
    if (!isPlainObject(root[LEGACY_KEY])) root[LEGACY_KEY] = {};
    root[LEGACY_KEY].folders = { ...folders };
}

/**
 * Returns the validated Gallery++ settings object, creating, migrating or repairing it as needed.
 * Cheap enough to call on every access.
 */
export function getSettings() {
    if (!host) throw new Error('Gallery++ settings accessed before configureSettings()');
    const root = host.getRoot();
    let changed = false;

    if (!isPlainObject(root[SETTINGS_KEY])) {
        root[SETTINGS_KEY] = {};
        changed = true;
    }
    const s = root[SETTINGS_KEY];

    if (!isPlainObject(s.folders)) { s.folders = {}; changed = true; }
    if (!SORT_VALUES.includes(s.sort)) { s.sort = 'dateAsc'; changed = true; }
    if (s.side !== 'left' && s.side !== 'right') { s.side = 'left'; changed = true; }
    if (typeof s.hotkeys !== 'boolean') { s.hotkeys = true; changed = true; }
    if (typeof s.showNames !== 'boolean') { s.showNames = false; changed = true; }

    for (const stale of ['thumbWidth', 'thumbHeight']) { // replaced by the aspect-ratio option
        if (stale in s) { delete s[stale]; changed = true; }
    }
    const layout = normalizeLayout(s);
    for (const key of Object.keys(LAYOUT_DEFAULTS)) {
        if (s[key] !== layout[key]) { s[key] = layout[key]; changed = true; }
    }

    if (s.schema !== SCHEMA_VERSION) {
        // One-time, non-destructive import from the original Gallery extension's settings.
        const legacy = isPlainObject(root[LEGACY_KEY]) ? root[LEGACY_KEY] : null;
        if (legacy) {
            s.folders = { ...cleanFolderMap(legacy.folders), ...cleanFolderMap(s.folders) };
            if (SORT_VALUES.includes(legacy.sort)) s.sort = legacy.sort;
            if (legacy.side === 'left' || legacy.side === 'right') s.side = legacy.side;
        }
        s.schema = SCHEMA_VERSION;
        changed = true;
    }

    // Recovery: the server-side map came back empty but the browser still remembers assignments.
    // Evaluated once per loaded settings object, so deliberately clearing the last assignment later
    // is never "recovered" back.
    if (recoveryCheckedFor !== s) {
        recoveryCheckedFor = s;
        if (Object.keys(s.folders).length === 0) {
            const backup = readBackup();
            if (Object.keys(backup).length > 0) {
                s.folders = backup;
                changed = true;
            }
        }
    }

    if (changed) {
        mirrorToLegacy(root, s.folders);
        writeBackup(s.folders);
        host.saveDebounced();
    }
    return s;
}

/** Persists after a change. `immediate` bypasses the debounce for rare, important writes. */
function commit({ immediate = false } = {}) {
    const s = getSettings();
    mirrorToLegacy(host.getRoot(), s.folders);
    writeBackup(s.folders);
    host.saveDebounced();
    if (immediate && typeof host.saveNow === 'function') {
        try {
            const result = host.saveNow();
            if (result && typeof result.catch === 'function') {
                result.catch(error => console.warn('[Gallery++] Immediate settings save failed:', error));
            }
        } catch (error) {
            console.warn('[Gallery++] Immediate settings save failed:', error);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Folder assignments
// ---------------------------------------------------------------------------------------------

/** @param {string} avatar @returns {string|undefined} The user-assigned folder, if any. */
export function getFolderOverride(avatar) {
    if (!avatar) return undefined;
    const value = getSettings().folders[avatar];
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The folder shown for a character: the user's assignment, otherwise the character's name.
 * @param {{avatar?: string, name?: string}|null|undefined} character
 */
export function resolveCharacterFolder(character) {
    if (!character) return undefined;
    return getFolderOverride(character.avatar) ?? character.name;
}

/**
 * Assigns (or, with null, clears) the folder of a character. Saved immediately.
 * @param {string} avatar
 * @param {string|null} folder
 */
export function setFolderOverride(avatar, folder) {
    if (!avatar) throw new Error('Character PNG ID is not found');
    const s = getSettings();
    const next = { ...s.folders };
    if (folder === null || String(folder).trim() === '') delete next[avatar];
    else next[avatar] = String(folder).trim();
    s.folders = next;
    commit({ immediate: true });
}

/** Moves an assignment when ST renames a character's avatar file. */
export function renameAvatar(oldAvatar, newAvatar) {
    const s = getSettings();
    if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) return;
    const folder = s.folders[oldAvatar];
    if (!folder) return;
    const next = { ...s.folders };
    next[newAvatar] = folder;
    delete next[oldAvatar];
    s.folders = next;
    commit({ immediate: true });
}

/** Forgets a deleted character's assignment. */
export function removeAvatar(avatar) {
    const s = getSettings();
    if (!avatar || !(avatar in s.folders)) return;
    const next = { ...s.folders };
    delete next[avatar];
    s.folders = next;
    commit({ immediate: true });
}

// ---------------------------------------------------------------------------------------------
// Other options
// ---------------------------------------------------------------------------------------------

export function getLayout() {
    return normalizeLayout(getSettings());
}

/** @param {Partial<typeof LAYOUT_DEFAULTS>} partial @returns {typeof LAYOUT_DEFAULTS} */
export function setLayout(partial) {
    const s = getSettings();
    const merged = normalizeLayout({ ...normalizeLayout(s), ...partial });
    Object.assign(s, merged);
    commit();
    return merged;
}

export function resetLayout() {
    return setLayout({ ...LAYOUT_DEFAULTS });
}

export function getSort() { return getSettings().sort; }
export function setSort(sort) {
    if (!SORT_VALUES.includes(sort)) return;
    getSettings().sort = sort;
    commit();
}

export function getSide() { return getSettings().side === 'right' ? 'right' : 'left'; }
export function setSide(side) {
    getSettings().side = side === 'right' ? 'right' : 'left';
    commit();
}

export function getBoolean(key) { return Boolean(getSettings()[key]); }
export function setBoolean(key, value) {
    if (key !== 'hotkeys' && key !== 'showNames') return;
    getSettings()[key] = Boolean(value);
    commit();
}

export { LAYOUT_LIMITS, clampInt };
