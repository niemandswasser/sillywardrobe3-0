import { getSettings, saveSettings } from './settings.js';
import {
    addCharacterLibraryAppearanceItem,
    createCustomCharacterLibraryProfile,
    deleteCharacterLibraryEntry,
    downloadReferenceImageFromUrl,
    fetchUserAvatars,
    getCachedUserAvatars,
    getCharacterLibraryEntry,
    getCharacterReferenceKeyForCharacter,
    getActiveCustomCharacterLibraryProfileKey,
    getCurrentCharacterReferenceKey,
    getCurrentUserReferenceKey,
    getTemporaryCharacterPrimary,
    getUserReferenceKeyForAvatar,
    removeCharacterLibraryAppearanceItem,
    setActiveCustomCharacterLibraryProfile,
    setTemporaryCharacterPrimary,
} from './references.js';
import {
    normalizeStoredImagePath,
    imageUrlToBase64,
    readFileAsDataUrl,
    sanitizeForHtml,
    saveImageToFile,
} from './utils.js';
import { callVisionApi, DEFAULT_REFERENCE_APPEARANCE_VISION_PROMPT } from './vision.js';
import { t } from './i18n.js';
import { Popup } from '../../../../popup.js';

let selectedKind = 'char';
let selectedKeys = { char: '', user: '' };
let searchQuery = '';
let sourceFilter = 'all';
let tagFilter = '';
let pickerOpen = false;
const boundSections = new WeakSet();
let contextEventsBound = false;
let refreshTimer = null;
let searchRenderTimer = null;
let lastContextSignature = '';
let libraryRendered = false;
let legacyMigrationPromise = null;
const pendingContextSync = { character: false, user: false };

const MAX_RENDERED_ENTITIES = 80;

function emptyLibraryEntry() {
    return {
        displayName: '',
        triggerKeywords: '',
        custom: false,
        tags: [],
        primary: { enabled: true, imagePath: '', description: '' },
        appearanceItems: [],
        generations: [],
    };
}

function getContext() {
    try {
        return SillyTavern.getContext();
    } catch (_error) {
        return {};
    }
}

async function migrateLegacyAvatarLibrary(settings = getSettings()) {
    if (legacyMigrationPromise) return legacyMigrationPromise;
    legacyMigrationPromise = (async () => {
        const legacyItems = Array.isArray(settings.avatarItems) ? settings.avatarItems : [];
        const migrated = new Set(Array.isArray(settings.legacyAvatarLibraryMigratedIds)
            ? settings.legacyAvatarLibraryMigratedIds.map(String)
            : []);
        const pending = legacyItems.filter(item => item?.id && item?.imageData && !migrated.has(String(item.id)));
        if (!pending.length) return 0;

        const charKey = getCurrentCharacterReferenceKey();
        const userKey = await getCurrentUserReferenceKey(settings);
        let done = 0;
        const migratedKinds = new Set();
        for (const item of pending) {
            const kind = item.target === 'user' ? 'user' : 'char';
            const key = kind === 'user' ? userKey : charKey;
            if (!key || key === 'no-character' || key === 'no-user-avatar') continue;
            try {
                const imageData = String(item.imageData || '');
                const dataUrl = imageData.startsWith('data:') ? imageData : `data:image/png;base64,${imageData}`;
                const imagePath = normalizeStoredImagePath(await saveImageToFile(dataUrl, {
                    mode: 'legacy-avatar-library-migration',
                    entityKind: kind,
                    entityKey: key,
                    legacyAvatarId: String(item.id),
                }));
                const entry = getCharacterLibraryEntry(kind, key, settings);
                const activeId = kind === 'user' ? settings.activeAvatarUser : settings.activeAvatarChar;
                if (String(activeId || '') === String(item.id) && !entry.primary.imagePath) {
                    entry.primary.imagePath = imagePath;
                    entry.primary.description = String(item.appearance || '').trim();
                } else {
                    const appearance = addCharacterLibraryAppearanceItem(kind, key, 'image', settings);
                    appearance.imagePath = imagePath;
                    appearance.description = String(item.appearance || item.name || '').trim();
                }
                migrated.add(String(item.id));
                migratedKinds.add(kind);
                done++;
            } catch (error) {
                console.warn('[IIG] Failed to migrate legacy avatar:', item?.name || item?.id, error);
            }
        }
        settings.legacyAvatarLibraryMigratedIds = [...migrated];
        if (done) {
            if (migratedKinds.has('char')) settings.activeAvatarChar = null;
            if (migratedKinds.has('user')) settings.activeAvatarUser = null;
            saveSettings();
            toastr.success(t`Old avatars moved to the character library: ${done}`, t`Image Generation`);
        }
        return done;
    })();
    try { return await legacyMigrationPromise; }
    finally { legacyMigrationPromise = null; }
}

function getPersonaTitle(avatarFile) {
    const context = getContext();
    const configuredName = context?.powerUserSettings?.personas?.[avatarFile];
    return String(configuredName || avatarFile.replace(/\.[^.]+$/, '') || avatarFile).trim();
}

function getThumbnailUrl(type, file) {
    const value = String(file || '').trim();
    return value ? `/thumbnail?type=${encodeURIComponent(type)}&file=${encodeURIComponent(value)}` : '';
}

function getCharacterEntities(settings = getSettings()) {
    const context = getContext();
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const entities = new Map();
    const activeCustomKey = getActiveCustomCharacterLibraryProfileKey('char', settings);
    characters.forEach((character, index) => {
        const key = getCharacterReferenceKeyForCharacter(character, index);
        const libraryEntry = getCharacterLibraryEntry('char', key, settings, { create: false });
        entities.set(key, {
            kind: 'char',
            key,
            title: libraryEntry?.displayName || String(character?.name || character?.avatar || t`Character`),
            fallbackTitle: String(character?.name || character?.avatar || t`Character`),
            avatarUrl: getThumbnailUrl('avatar', character?.avatar),
            generationFolder: String(character?.name || '').trim(),
            active: !activeCustomKey && key === getCurrentCharacterReferenceKey(),
            configured: Boolean(libraryEntry),
            custom: false,
            tags: libraryEntry?.tags || [],
        });
    });

    const library = settings.characterReferenceLibrary?.characters || {};
    for (const key of Object.keys(library)) {
        if (entities.has(key)) continue;
        const entry = getCharacterLibraryEntry('char', key, settings, { create: false });
        const fallbackTitle = key.replace(/^(avatar|name|id):/, '') || t`Character`;
        const custom = entry?.custom === true || key.startsWith('custom:');
        entities.set(key, {
            kind: 'char',
            key,
            title: entry?.displayName || fallbackTitle,
            fallbackTitle,
            avatarUrl: custom ? normalizeStoredImagePath(entry?.primary?.imagePath) : (key.startsWith('avatar:') ? getThumbnailUrl('avatar', key.slice('avatar:'.length)) : ''),
            generationFolder: entry?.displayName || fallbackTitle.replace(/\.[^.]+$/, ''),
            active: custom && key === activeCustomKey,
            configured: true,
            custom,
            tags: entry?.tags || [],
        });
    }
    return [...entities.values()].sort((a, b) => a.title.localeCompare(b.title));
}

async function getUserEntities(settings = getSettings()) {
    let avatars = getCachedUserAvatars();
    if (avatars.length === 0) avatars = await fetchUserAvatars();
    const activeKey = await getCurrentUserReferenceKey(settings);
    const activeCustomKey = getActiveCustomCharacterLibraryProfileKey('user', settings);
    const entities = new Map();
    for (const avatarFile of avatars) {
        const key = getUserReferenceKeyForAvatar(avatarFile);
        const libraryEntry = getCharacterLibraryEntry('user', key, settings, { create: false });
        const fallbackTitle = getPersonaTitle(avatarFile);
        entities.set(key, {
            kind: 'user',
            key,
            title: libraryEntry?.displayName || fallbackTitle,
            fallbackTitle,
            avatarUrl: getThumbnailUrl('persona', avatarFile),
            generationFolder: '',
            active: !activeCustomKey && key === activeKey,
            configured: Boolean(libraryEntry),
            custom: false,
            tags: libraryEntry?.tags || [],
        });
    }

    const library = settings.characterReferenceLibrary?.users || {};
    for (const key of Object.keys(library)) {
        if (entities.has(key)) continue;
        const entry = getCharacterLibraryEntry('user', key, settings, { create: false });
        const avatarFile = key.replace(/^avatar:/, '');
        const custom = entry?.custom === true || key.startsWith('custom:');
        const fallbackTitle = custom ? (entry?.displayName || t`Persona`) : getPersonaTitle(avatarFile);
        entities.set(key, {
            kind: 'user',
            key,
            title: entry?.displayName || fallbackTitle,
            fallbackTitle,
            avatarUrl: custom ? normalizeStoredImagePath(entry?.primary?.imagePath) : getThumbnailUrl('persona', avatarFile),
            generationFolder: '',
            active: custom ? key === activeCustomKey : (!activeCustomKey && key === activeKey),
            configured: true,
            custom,
            tags: entry?.tags || [],
        });
    }
    return [...entities.values()].sort((a, b) => a.title.localeCompare(b.title));
}

async function getEntities(kind = selectedKind, settings = getSettings()) {
    return kind === 'user' ? await getUserEntities(settings) : getCharacterEntities(settings);
}

function buildAvatarHtml(src, fallbackIcon = 'fa-user') {
    const safeSrc = normalizeStoredImagePath(src);
    if (!safeSrc) {
        return `<span class="iig-library-avatar-placeholder"><i class="fa-solid ${fallbackIcon}"></i></span>`;
    }
    return `<img src="${sanitizeForHtml(safeSrc)}" alt="" loading="lazy" decoding="async">`;
}

function buildEntityOptionHtml(entity, selectedKey) {
    const searchable = `${entity.title} ${entity.fallbackTitle} ${entity.key} ${(entity.tags || []).join(' ')}`.toLowerCase();
    const status = entity.active
        ? t`Active`
        : entity.custom
            ? t`My profile`
            : entity.configured ? t`Configured` : '';
    return `
        <button type="button" class="iig-library-entity ${entity.key === selectedKey ? 'selected' : ''} ${entity.custom ? 'custom-profile' : ''}" data-library-kind="${entity.kind}" data-library-key="${sanitizeForHtml(entity.key)}" data-library-search="${sanitizeForHtml(searchable)}">
            <span class="iig-library-entity-avatar">${buildAvatarHtml(entity.avatarUrl, entity.kind === 'char' ? 'fa-user-pen' : 'fa-user')}</span>
            <span class="iig-library-entity-copy">
                <strong>${sanitizeForHtml(entity.title)}</strong>
                <small>${status}</small>
                ${(entity.tags || []).length ? `<span class="iig-library-entity-tags">${entity.tags.slice(0, 3).map((tag) => `<em>${sanitizeForHtml(tag)}</em>`).join('')}</span>` : ''}
            </span>
        </button>`;
}

function buildAppearanceItemsHtml(entry) {
    if (entry.appearanceItems.length === 0) {
        return `<div class="iig-library-empty">${t`No appearance details.`}</div>`;
    }
    return entry.appearanceItems.map((item) => {
        const isImage = item.type === 'image';
        const preview = isImage ? normalizeStoredImagePath(item.imagePath) : '';
        const temporaryPrimary = isImage && item.id === entry.temporaryPrimaryId;
        return `
            <div class="iig-library-appearance-row ${isImage ? 'image' : 'text'} ${item.enabled === false ? 'disabled' : ''}" data-appearance-id="${sanitizeForHtml(item.id)}" data-appearance-type="${item.type}">
                <label class="checkbox_label iig-library-enable" title="${isImage ? t`Use image reference` : t`Use text description`}">
                    <input type="checkbox" class="iig-library-appearance-enabled" ${item.enabled !== false ? 'checked' : ''}>
                    <span></span>
                </label>
                <div class="iig-library-appearance-preview">
                    ${isImage ? buildAvatarHtml(preview, 'fa-image') : '<span class="iig-library-appearance-text-icon"><i class="fa-solid fa-align-left"></i></span>'}
                </div>
                <div class="iig-library-appearance-fields">
                    <textarea class="text_pole iig-library-appearance-description" rows="2" placeholder="${isImage ? t`Reference description` : t`Appearance description`}">${sanitizeForHtml(item.description)}</textarea>
                </div>
                <div class="iig-library-row-actions">
                    ${isImage ? `<button type="button" class="menu_button iig-library-appearance-primary ${temporaryPrimary ? 'selected' : ''}" title="${temporaryPrimary ? t`Use saved main reference` : t`Use as temporary main reference`}"><i class="fa-solid fa-thumbtack"></i></button>
                    <button type="button" class="menu_button iig-library-reference-vision ${preview ? '' : 'iig-hidden'}" title="${t`Describe appearance via Vision AI`}"><i class="fa-solid fa-robot"></i></button>
                    <label class="menu_button" title="${t`Choose image`}">
                        <i class="fa-solid fa-upload"></i>
                        <input type="file" accept="image/*" class="iig-library-appearance-file" hidden>
                    </label>
                    <button type="button" class="menu_button iig-library-appearance-url" title="${t`Load image by URL`}"><i class="fa-solid fa-link"></i></button>` : ''}
                    <button type="button" class="menu_button iig-library-appearance-remove" title="${t`Delete`}"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>`;
    }).join('');
}

function buildEditorHtml(entity, entry) {
    if (!entity) {
        return `<div class="iig-library-empty iig-library-empty-editor">${t`Select a character or persona.`}</div>`;
    }
    const primaryPreview = normalizeStoredImagePath(entry.primary.imagePath) || entity.avatarUrl;
    const hasReplacement = Boolean(normalizeStoredImagePath(entry.primary.imagePath));
    const temporaryPrimary = getTemporaryCharacterPrimary(entity.kind, entity.key);
    entry.temporaryPrimaryId = temporaryPrimary?.id || '';
    return `
        <div class="iig-library-editor" data-library-kind="${entity.kind}" data-library-key="${sanitizeForHtml(entity.key)}" data-generation-folder="${sanitizeForHtml(entity.generationFolder || '')}">
            <div class="iig-library-editor-head">
                <span class="iig-library-editor-avatar">${buildAvatarHtml(primaryPreview, entity.kind === 'char' ? 'fa-user-pen' : 'fa-user')}</span>
                <label class="iig-library-name-field">
                    <span>${entity.custom ? t`My profile` : (entity.kind === 'char' ? t`Character` : t`Persona`)}</span>
                    <input type="text" class="text_pole iig-library-display-name" value="${sanitizeForHtml(entry.displayName)}" placeholder="${sanitizeForHtml(entity.fallbackTitle)}">
                </label>
                <div class="iig-library-editor-actions">
                    ${entity.custom ? `<button type="button" class="menu_button iig-library-profile-active ${entity.active ? 'selected' : ''}" title="${entity.active ? t`Return to the active card or persona` : t`Use this profile for generation`}"><i class="fa-solid ${entity.active ? 'fa-toggle-on' : 'fa-toggle-off'}"></i><span>${entity.active ? t`Active` : t`Activate`}</span></button>` : ''}
                    <button type="button" class="menu_button redWarningBG iig-library-entry-delete" title="${entity.custom ? t`Delete custom profile` : t`Clear reference settings`}"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>

            <label class="iig-library-trigger-field">
                <span>${t`Avatar match keys`}</span>
                <input type="text" class="text_pole iig-library-trigger-keywords" value="${sanitizeForHtml(entry.triggerKeywords)}" placeholder="Elon, Erica, Luka">
                <small>${t`Comma-separated aliases. In optional mode, this avatar is sent only when the prompt contains one of them.`}</small>
            </label>

            <label class="iig-library-trigger-field iig-library-tags-field">
                <span>${t`Tags`}</span>
                <input type="text" class="text_pole iig-library-tags" value="${sanitizeForHtml((entry.tags || []).join(', '))}" placeholder="main, fantasy, favorites">
                <small>${t`Comma-separated tags are used only to organize and filter the library.`}</small>
            </label>

            <section class="iig-library-editor-section">
                <div class="iig-library-section-head">
                    <strong>${t`Main reference`}</strong>
                    <div class="iig-library-row-actions">
                        <label class="menu_button" title="${t`Replace main reference`}">
                            <i class="fa-solid fa-upload"></i><span>${t`Replace`}</span>
                            <input type="file" accept="image/*" class="iig-library-primary-file" hidden>
                        </label>
                        <button type="button" class="menu_button iig-library-primary-url" title="${t`Load image by URL`}"><i class="fa-solid fa-link"></i></button>
                        <button type="button" class="menu_button iig-library-primary-vision ${primaryPreview ? '' : 'iig-hidden'}" title="${t`Describe appearance via Vision AI`}"><i class="fa-solid fa-robot"></i><span>${t`Vision`}</span></button>
                        <button type="button" class="menu_button iig-library-primary-reset ${hasReplacement ? '' : 'iig-hidden'}" title="${t`Use avatar`}"><i class="fa-solid fa-rotate-left"></i></button>
                    </div>
                </div>
                <div class="iig-library-primary-row ${entry.primary.enabled === false ? 'disabled' : ''}">
                    <span class="iig-library-primary-preview">${buildAvatarHtml(primaryPreview, 'fa-image')}</span>
                    <label class="checkbox_label iig-library-enable" title="${t`Use main reference`}">
                        <input type="checkbox" class="iig-library-primary-enabled" ${entry.primary.enabled !== false ? 'checked' : ''}>
                        <span></span>
                    </label>
                    <textarea class="text_pole iig-library-primary-description" rows="3" placeholder="${t`Main reference description`}">${sanitizeForHtml(entry.primary.description)}</textarea>
                </div>
            </section>

            <section class="iig-library-editor-section">
                <div class="iig-library-section-head">
                    <strong>${t`Appearance details`}</strong>
                    <div class="iig-library-row-actions iig-library-appearance-add-actions">
                        <button type="button" class="menu_button iig-library-appearance-add" data-appearance-type="text"><i class="fa-solid fa-plus"></i><span>${t`Add description`}</span></button>
                        <button type="button" class="menu_button iig-library-appearance-add" data-appearance-type="image"><i class="fa-solid fa-plus"></i><span>${t`Add reference`}</span></button>
                    </div>
                </div>
                <div class="iig-library-appearance-list">${buildAppearanceItemsHtml(entry)}</div>
            </section>

        </div>`;
}

export function buildCharacterLibraryBodyHtml(settings = getSettings()) {
    return `
        <div class="iig-character-library">
            <div class="iig-library-optional-send-setting">
                <label class="checkbox_label">
                    <input type="checkbox" id="iig_library_optional_send" ${settings.optionalAvatarSending === true ? 'checked' : ''}>
                    <span>${t`Optional avatar sending`}</span>
                </label>
                <p class="hint">${t`When enabled, allowed character and persona avatars are not sent by default. Each avatar is sent only when its match key appears in the image prompt.`}</p>
            </div>
            <div class="iig-library-toolbar">
                <div class="iig-library-tabs" role="tablist">
                    <button type="button" class="menu_button iig-library-tab selected" data-library-tab="char"><i class="fa-solid fa-address-card"></i><span>${t`Characters`}</span></button>
                    <button type="button" class="menu_button iig-library-tab" data-library-tab="user"><i class="fa-solid fa-user"></i><span>${t`Personas`}</span></button>
                </div>
                <button type="button" id="iig_library_create_profile" class="menu_button"><i class="fa-solid fa-user-plus"></i><span>${t`Add custom profile`}</span></button>
            </div>
            <div class="iig-library-picker">
                <button type="button" id="iig_library_picker_toggle" class="iig-library-picker-toggle" aria-expanded="false"></button>
                <div id="iig_library_picker_panel" class="iig-library-picker-panel iig-hidden">
                    <label class="iig-library-search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input id="iig_library_search" class="text_pole" type="search" placeholder="${t`Search characters and personas`}">
                    </label>
                    <div class="iig-library-filters">
                        <select id="iig_library_source_filter" class="text_pole">
                            <option value="all">${t`All sources`}</option>
                            <option value="linked">${t`Cards and personas`}</option>
                            <option value="custom">${t`My profiles`}</option>
                        </select>
                        <select id="iig_library_tag_filter" class="text_pole">
                            <option value="">${t`All tags`}</option>
                        </select>
                    </div>
                    <div id="iig_library_entities" class="iig-library-entities"></div>
                </div>
            </div>
            <div class="iig-library-layout iig-library-editor-layout">
                <div id="iig_library_editor_host" class="iig-library-editor-host"></div>
            </div>
        </div>`;
}

function syncPickerUi(selectedEntity = null) {
    const toggle = document.getElementById('iig_library_picker_toggle');
    const panel = document.getElementById('iig_library_picker_panel');
    if (toggle instanceof HTMLButtonElement) {
        toggle.setAttribute('aria-expanded', String(pickerOpen));
        toggle.innerHTML = selectedEntity
            ? `<span class="iig-library-entity-avatar">${buildAvatarHtml(selectedEntity.avatarUrl, selectedEntity.kind === 'char' ? 'fa-user-pen' : 'fa-user')}</span>
               <span class="iig-library-picker-copy"><small>${selectedEntity.kind === 'char' ? t`Character` : t`Persona`}</small><strong>${sanitizeForHtml(selectedEntity.title)}</strong></span>
               <i class="fa-solid fa-chevron-${pickerOpen ? 'up' : 'down'}"></i>`
            : `<span class="iig-library-picker-copy"><strong>${selectedKind === 'char' ? t`Select a character` : t`Select a persona`}</strong></span><i class="fa-solid fa-chevron-${pickerOpen ? 'up' : 'down'}"></i>`;
    }
    panel?.classList.toggle('iig-hidden', !pickerOpen);
}

async function renderEntityList(settings = getSettings()) {
    const host = document.getElementById('iig_library_entities');
    if (!host) return [];
    const entities = await getEntities(selectedKind, settings);
    const currentSelection = selectedKeys[selectedKind];
    if (!currentSelection || !entities.some((entity) => entity.key === currentSelection)) {
        selectedKeys[selectedKind] = entities.find((entity) => entity.active)?.key || entities[0]?.key || '';
    }
    const availableTags = [...new Set(entities.flatMap((entity) => entity.tags || []))]
        .sort((a, b) => a.localeCompare(b));
    if (tagFilter && !availableTags.includes(tagFilter)) tagFilter = '';
    const tagSelect = document.getElementById('iig_library_tag_filter');
    if (tagSelect instanceof HTMLSelectElement) {
        tagSelect.innerHTML = `<option value="">${t`All tags`}</option>${availableTags.map((tag) => `<option value="${sanitizeForHtml(tag)}">${sanitizeForHtml(tag)}</option>`).join('')}`;
        tagSelect.value = tagFilter;
    }
    const sourceSelect = document.getElementById('iig_library_source_filter');
    if (sourceSelect instanceof HTMLSelectElement) sourceSelect.value = sourceFilter;
    const query = searchQuery.trim().toLowerCase();
    const matchedEntities = entities.filter((entity) => {
        if (sourceFilter === 'custom' && !entity.custom) return false;
        if (sourceFilter === 'linked' && entity.custom) return false;
        if (tagFilter && !(entity.tags || []).includes(tagFilter)) return false;
        return !query || `${entity.title} ${entity.fallbackTitle} ${entity.key} ${(entity.tags || []).join(' ')}`.toLowerCase().includes(query);
    });
    const visibleEntities = matchedEntities.slice(0, MAX_RENDERED_ENTITIES);
    const limitNote = matchedEntities.length > visibleEntities.length
        ? `<div class="iig-library-list-note">${t`Showing ${visibleEntities.length} of ${matchedEntities.length}. Use search to narrow the list.`}</div>`
        : '';
    host.innerHTML = visibleEntities.length
        ? visibleEntities.map((entity) => buildEntityOptionHtml(entity, selectedKeys[selectedKind])).join('') + limitNote
        : `<div class="iig-library-empty">${selectedKind === 'char' ? t`No characters found.` : t`No personas found.`}</div>`;
    syncPickerUi(entities.find((entity) => entity.key === selectedKeys[selectedKind]) || null);
    return entities;
}

function scheduleSearchRender(settings) {
    clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(() => {
        renderEntityList(settings).catch((error) => console.warn('[IIG] Failed to filter character library:', error));
    }, 60);
}

async function renderEditor(settings = getSettings(), entities = null) {
    const host = document.getElementById('iig_library_editor_host');
    if (!host) return;
    const available = entities || await getEntities(selectedKind, settings);
    const entity = available.find((item) => item.key === selectedKeys[selectedKind]);
    const entry = entity
        ? getCharacterLibraryEntry(selectedKind, entity.key, settings, { create: false }) || emptyLibraryEntry()
        : emptyLibraryEntry();
    host.innerHTML = buildEditorHtml(entity, entry);
}

export async function renderCharacterLibrary(settings = getSettings()) {
    await migrateLegacyAvatarLibrary(settings);
    document.querySelectorAll('.iig-library-tab').forEach((tab) => {
        tab.classList.toggle('selected', tab.getAttribute('data-library-tab') === selectedKind);
    });
    const search = document.getElementById('iig_library_search');
    if (search instanceof HTMLInputElement && search.value !== searchQuery) search.value = searchQuery;
    const entities = await renderEntityList(settings);
    await renderEditor(settings, entities);
    lastContextSignature = await getContextSignature(settings);
    libraryRendered = true;
}

function getActiveEditor(settings = getSettings()) {
    const editor = document.querySelector('#iig_library_editor_host .iig-library-editor');
    if (!(editor instanceof HTMLElement)) return null;
    const kind = editor.getAttribute('data-library-kind') === 'user' ? 'user' : 'char';
    const key = String(editor.getAttribute('data-library-key') || '');
    const entry = getCharacterLibraryEntry(kind, key, settings);
    return { editor, kind, key, entry };
}

function findById(items, id) {
    return items.find((item) => item.id === id) || null;
}

async function saveUploadedImage(file, meta) {
    const dataUrl = await readFileAsDataUrl(file);
    return normalizeStoredImagePath(await saveImageToFile(dataUrl, meta));
}

async function replaceReferenceImage(editorState, target, imagePath) {
    if (target === 'primary') {
        editorState.entry.primary.imagePath = imagePath;
        return;
    }
    const item = findById(editorState.entry.appearanceItems, target);
    if (item?.type === 'image') item.imagePath = imagePath;
}

async function handleFileUpload(input, settings) {
    const file = input.files?.[0];
    if (!file) return;
    const state = getActiveEditor(settings);
    if (!state) return;
    const appearanceRow = input.closest('.iig-library-appearance-row.image');
    const target = appearanceRow?.getAttribute('data-appearance-id') || 'primary';
    try {
        const path = await saveUploadedImage(file, {
            mode: target === 'primary' ? 'character-primary-reference' : 'character-additional-reference',
            entityKind: state.kind,
            entityKey: state.key,
            referenceId: target,
        });
        await replaceReferenceImage(state, target, path);
        saveSettings();
        await renderCharacterLibrary(settings);
        toastr.success(t`Reference saved`, t`Image Generation`);
    } catch (error) {
        console.error('[IIG] Failed to save character reference:', error);
        toastr.error(t`Reference upload failed: ${error.message || error}`, t`Image Generation`);
    } finally {
        input.value = '';
    }
}

async function handleUrlUpload(target, settings) {
    const state = getActiveEditor(settings);
    if (!state) return;
    const url = await Popup.show.input(t`Load reference by URL`, t`Paste a direct link to the image:`);
    const trimmed = String(url || '').trim();
    if (!trimmed) return;
    try {
        const path = await downloadReferenceImageFromUrl(trimmed, {
            mode: target === 'primary' ? 'character-primary-reference-url' : 'character-additional-reference-url',
            entityKind: state.kind,
            entityKey: state.key,
            referenceId: target,
        });
        await replaceReferenceImage(state, target, path);
        saveSettings();
        await renderCharacterLibrary(settings);
        toastr.success(t`Reference saved`, t`Image Generation`);
    } catch (error) {
        console.error('[IIG] Failed to load character reference:', error);
        toastr.error(t`Reference upload failed: ${error.message || error}`, t`Image Generation`);
    }
}

async function handleReferenceVision(button, target, settings) {
    const state = getActiveEditor(settings);
    if (!state || !(button instanceof HTMLButtonElement)) return;
    const item = target === 'primary' ? null : findById(state.entry.appearanceItems, target);
    const previewImage = target === 'primary'
        ? state.editor.querySelector('.iig-library-primary-preview img')
        : button.closest('.iig-library-appearance-row')?.querySelector('.iig-library-appearance-preview img');
    const imagePath = target === 'primary'
        ? String(previewImage?.getAttribute('src') || '').trim()
        : normalizeStoredImagePath(item?.imagePath);
    if (!imagePath) {
        toastr.warning(t`No image for this reference`, t`Image Generation`);
        return;
    }

    const originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    try {
        const imageBase64 = await imageUrlToBase64(imagePath);
        if (!imageBase64) throw new Error(t`Failed to load reference image`);
        const description = await callVisionApi(imageBase64, DEFAULT_REFERENCE_APPEARANCE_VISION_PROMPT);
        if (target === 'primary') {
            state.entry.primary.description = description;
            const textarea = state.editor.querySelector('.iig-library-primary-description');
            if (textarea instanceof HTMLTextAreaElement) textarea.value = description;
        } else if (item?.type === 'image') {
            item.description = description;
            const textarea = button.closest('.iig-library-appearance-row')?.querySelector('.iig-library-appearance-description');
            if (textarea instanceof HTMLTextAreaElement) textarea.value = description;
        }
        saveSettings();
        toastr.success(t`Description generated`, t`Image Generation`);
    } catch (error) {
        console.error('[IIG] Character library Vision failed:', error);
        toastr.error(t`Vision generation error: ${error.message || error}`, t`Image Generation`);
    } finally {
        button.disabled = false;
        button.innerHTML = originalHtml;
    }
}

async function getContextSignature(settings = getSettings()) {
    const context = getContext();
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const activeUserKey = await getCurrentUserReferenceKey(settings);
    return JSON.stringify({
        characterId: context?.characterId ?? null,
        characters: characters.map((character) => [character?.name || '', character?.avatar || '']),
        activeUserKey,
        activeCustomChar: getActiveCustomCharacterLibraryProfileKey('char', settings),
        activeCustomUser: getActiveCustomCharacterLibraryProfileKey('user', settings),
        userAvatarFile: settings.userAvatarFile || '',
        useActiveUserPersonaAvatar: Boolean(settings.useActiveUserPersonaAvatar),
    });
}

async function refreshIfContextChanged(settings = getSettings(), { force = false } = {}) {
    const details = document.getElementById('iig_characters_section')?.closest('details');
    if (details && !details.open) {
        lastContextSignature = '';
        libraryRendered = false;
        return;
    }
    const signature = await getContextSignature(settings);
    if (!force && signature === lastContextSignature) return;
    const active = document.activeElement;
    if (!force && active instanceof HTMLElement && active.closest('#iig_characters_section')) return;
    await renderCharacterLibrary(settings);
}

async function syncLibrarySelectionToContext(settings, sync) {
    if (sync.character) {
        const characterKey = getActiveCustomCharacterLibraryProfileKey('char', settings) || getCurrentCharacterReferenceKey();
        selectedKeys.char = characterKey === 'no-character' ? '' : characterKey;
    }
    if (sync.user) {
        selectedKeys.user = getActiveCustomCharacterLibraryProfileKey('user', settings) || await getCurrentUserReferenceKey(settings);
    }
}

function scheduleRefresh(settings = getSettings(), sync = {}) {
    pendingContextSync.character ||= Boolean(sync.character);
    pendingContextSync.user ||= Boolean(sync.user);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
        const requestedSync = {
            character: pendingContextSync.character,
            user: pendingContextSync.user,
        };
        pendingContextSync.character = false;
        pendingContextSync.user = false;
        try {
            await syncLibrarySelectionToContext(settings, requestedSync);
            await refreshIfContextChanged(settings, {
                force: (requestedSync.character && selectedKind === 'char')
                    || (requestedSync.user && selectedKind === 'user'),
            });
        } catch (error) {
            console.warn('[IIG] Failed to refresh character library:', error);
        }
    }, 120);
}

function bindContextRefresh(settings) {
    if (contextEventsBound) return;
    const context = getContext();
    const eventNames = ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'CHARACTER_EDITED', 'CHARACTER_DELETED', 'CHARACTER_ADDED', 'USER_AVATAR_CHANGED', 'PERSONA_CHANGED'];
    if (typeof context?.eventSource?.on === 'function') {
        contextEventsBound = true;
        for (const name of eventNames) {
            const eventName = context?.event_types?.[name];
            if (!eventName) continue;
            const sync = {
                character: ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'CHARACTER_EDITED'].includes(name),
                user: ['CHAT_CHANGED', 'USER_AVATAR_CHANGED', 'PERSONA_CHANGED'].includes(name),
            };
            context.eventSource.on(eventName, () => scheduleRefresh(settings, sync));
        }
    }
}

export function bindCharacterLibraryEvents(settings = getSettings()) {
    const section = document.getElementById('iig_characters_section');
    if (!section || boundSections.has(section)) return;
    boundSections.add(section);
    const details = section.closest('details');

    details?.addEventListener('toggle', () => {
        if (details.open && !libraryRendered) {
            renderCharacterLibrary(settings).catch((error) => console.warn('[IIG] Failed to render character library:', error));
        }
    });

    section.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
        if (target.id === 'iig_library_search') {
            searchQuery = target.value;
            scheduleSearchRender(settings);
            return;
        }
        const state = getActiveEditor(settings);
        if (!state) return;
        if (target.classList.contains('iig-library-display-name')) state.entry.displayName = target.value;
        if (target.classList.contains('iig-library-trigger-keywords')) state.entry.triggerKeywords = target.value;
        if (target.classList.contains('iig-library-tags')) {
            state.entry.tags = [...new Set(target.value.split(',').map((tag) => tag.trim()).filter(Boolean))];
        }
        if (target.classList.contains('iig-library-primary-description')) state.entry.primary.description = target.value;

        const appearanceRow = target.closest('.iig-library-appearance-row');
        const item = findById(state.entry.appearanceItems, String(appearanceRow?.getAttribute('data-appearance-id') || ''));
        if (item && target.classList.contains('iig-library-appearance-description')) item.description = target.value;
        saveSettings();
        if (target.classList.contains('iig-library-display-name') || target.classList.contains('iig-library-tags')) {
            renderEntityList(settings).catch(() => {});
        }
    });

    section.addEventListener('change', async (event) => {
        const target = event.target;
        if (target instanceof HTMLSelectElement) {
            if (target.id === 'iig_library_source_filter') sourceFilter = ['linked', 'custom'].includes(target.value) ? target.value : 'all';
            if (target.id === 'iig_library_tag_filter') tagFilter = target.value;
            await renderEntityList(settings);
            return;
        }
        if (!(target instanceof HTMLInputElement)) return;
        if (target.id === 'iig_library_optional_send') {
            settings.optionalAvatarSending = target.checked;
            saveSettings();
            return;
        }
        if (target.type === 'file') {
            await handleFileUpload(target, settings);
            return;
        }
        const state = getActiveEditor(settings);
        if (!state) return;
        if (target.classList.contains('iig-library-primary-enabled')) state.entry.primary.enabled = target.checked;
        const appearanceRow = target.closest('.iig-library-appearance-row');
        const item = findById(state.entry.appearanceItems, String(appearanceRow?.getAttribute('data-appearance-id') || ''));
        if (item && target.classList.contains('iig-library-appearance-enabled')) {
            item.enabled = target.checked;
            if (!target.checked && getTemporaryCharacterPrimary(state.kind, state.key, settings)?.id === item.id) {
                setTemporaryCharacterPrimary(state.kind, state.key, '', settings);
                saveSettings();
                await renderEditor(settings);
                return;
            }
        }
        saveSettings();
        target.closest('.iig-library-primary-row, .iig-library-appearance-row')?.classList.toggle('disabled', !target.checked);
    });

    section.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const tab = target.closest('.iig-library-tab');
        if (tab) {
            selectedKind = tab.getAttribute('data-library-tab') === 'user' ? 'user' : 'char';
            searchQuery = '';
            pickerOpen = true;
            await renderCharacterLibrary(settings);
            document.getElementById('iig_library_search')?.focus();
            return;
        }
        if (target.closest('#iig_library_picker_toggle')) {
            pickerOpen = !pickerOpen;
            const entities = await getEntities(selectedKind, settings);
            syncPickerUi(entities.find((entity) => entity.key === selectedKeys[selectedKind]) || null);
            if (pickerOpen) document.getElementById('iig_library_search')?.focus();
            return;
        }
        if (target.closest('#iig_library_create_profile')) {
            const label = selectedKind === 'char' ? t`New character profile` : t`New persona profile`;
            const name = await Popup.show.input(t`Add custom profile`, t`Profile name:`, label);
            if (!String(name || '').trim()) return;
            const profile = createCustomCharacterLibraryProfile(selectedKind, name, settings);
            selectedKeys[selectedKind] = profile.key;
            sourceFilter = 'custom';
            tagFilter = '';
            searchQuery = '';
            pickerOpen = false;
            await renderCharacterLibrary(settings);
            return;
        }
        const entityButton = target.closest('.iig-library-entity');
        if (entityButton) {
            selectedKind = entityButton.getAttribute('data-library-kind') === 'user' ? 'user' : 'char';
            selectedKeys[selectedKind] = String(entityButton.getAttribute('data-library-key') || '');
            searchQuery = '';
            pickerOpen = false;
            await renderCharacterLibrary(settings);
            return;
        }

        const state = getActiveEditor(settings);
        if (!state) return;
        const activeProfileButton = target.closest('.iig-library-profile-active');
        if (activeProfileButton) {
            const isActive = getActiveCustomCharacterLibraryProfileKey(state.kind, settings) === state.key;
            setActiveCustomCharacterLibraryProfile(state.kind, isActive ? '' : state.key, settings);
            await renderCharacterLibrary(settings);
            return;
        }
        const primaryVision = target.closest('.iig-library-primary-vision');
        if (primaryVision) {
            await handleReferenceVision(primaryVision, 'primary', settings);
            return;
        }
        const appearanceVision = target.closest('.iig-library-reference-vision');
        if (appearanceVision) {
            const row = appearanceVision.closest('.iig-library-appearance-row.image');
            const id = String(row?.getAttribute('data-appearance-id') || '');
            if (id) await handleReferenceVision(appearanceVision, id, settings);
            return;
        }
        const addAppearanceButton = target.closest('.iig-library-appearance-add');
        if (addAppearanceButton) {
            const type = addAppearanceButton.getAttribute('data-appearance-type') === 'image' ? 'image' : 'text';
            addCharacterLibraryAppearanceItem(state.kind, state.key, type, settings);
            await renderEditor(settings);
            return;
        }
        const appearanceRow = target.closest('.iig-library-appearance-row');
        const appearancePrimary = target.closest('.iig-library-appearance-primary');
        if (appearancePrimary && appearanceRow?.getAttribute('data-appearance-type') === 'image') {
            const id = String(appearanceRow.getAttribute('data-appearance-id') || '');
            setTemporaryCharacterPrimary(state.kind, state.key, id, settings);
            await renderEditor(settings);
            return;
        }
        if (target.closest('.iig-library-appearance-remove') && appearanceRow) {
            const id = String(appearanceRow.getAttribute('data-appearance-id') || '');
            const removed = removeCharacterLibraryAppearanceItem(state.kind, state.key, id, settings);
            if (!removed) {
                console.warn('[IIG] Appearance item was not found for deletion:', id);
                return;
            }
            await renderEditor(settings);
            return;
        }
        const appearanceUrl = target.closest('.iig-library-appearance-url');
        if (appearanceUrl && appearanceRow?.getAttribute('data-appearance-type') === 'image') {
            await handleUrlUpload(String(appearanceRow.getAttribute('data-appearance-id') || ''), settings);
            return;
        }
        if (target.closest('.iig-library-primary-url')) {
            await handleUrlUpload('primary', settings);
            return;
        }
        if (target.closest('.iig-library-primary-reset')) {
            state.entry.primary.imagePath = '';
            saveSettings();
            await renderCharacterLibrary(settings);
            return;
        }
        if (target.closest('.iig-library-entry-delete')) {
            const confirmed = await Popup.show.confirm(
                state.entry.custom ? t`Delete this custom profile?` : t`Clear all reference settings for this entry?`,
                t`Confirm`,
            );
            if (!confirmed) return;
            deleteCharacterLibraryEntry(state.kind, state.key, settings);
            await renderCharacterLibrary(settings);
        }
    });

    bindContextRefresh(settings);
    if (details?.open) {
        renderCharacterLibrary(settings).catch((error) => console.warn('[IIG] Failed to render character library:', error));
    }
}
