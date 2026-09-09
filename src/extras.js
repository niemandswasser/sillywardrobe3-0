/**
 * Extras (порт из MG/Test):
 *   - NPC список с аватарками (триггер по имени в промпте);
 *   - Гардероб (одежда) персонажа/юзера с превью+описанием;
 *   - Avatar Library — кастомные аватарки персонажа/юзера, заменяющие дефолт;
 *   - Утилита resize изображений и инжект описания одежды в LLM-контекст.
 *
 * Все коллекции живут в `settings.extensionSettings[MODULE_NAME]`. Дефолты
 * добавлены в settings.js.
 */

import {
    getSettings,
    saveSettings,
    iigLog,
    MODULE_NAME,
} from './settings.js';
import {
    swUpdatePromptInjection,
    swBuildDescription,
    swGetSettings as _swGetSettings,
    swFindItem,
    getActiveOutfitBase64,
    getActiveOutfitDescription,
    getCollageBase64,
    getActiveOutfitData,
    isActiveOutfitTryOn,
} from './wardrobe.js';
import { findFirstMatchKeyword } from './matching.js';
import {
    collectCharacterLibraryReferences,
    getReferenceImage,
    shouldSendCharacterLibraryReference,
    activeCharacterLibraryEntryMatchesPrompt,
    activeCharacterLibraryEntryMatchesPromptAsync,
    getActiveCustomCharacterLibraryProfileKey,
} from './references.js';

// ----- ID generators -----

function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ----- Image resize (для аплоада в гардероб/avatar lib) -----

/**
 * Уменьшает картинку до maxSize по большей стороне, возвращает чистый base64
 * (без data: префикса). Если она меньше — возвращает исходный base64.
 */
export function resizeImageBase64(base64, maxSize = 512) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            if (width <= maxSize && height <= maxSize) {
                resolve(base64);
                return;
            }
            const ratio = Math.min(maxSize / width, maxSize / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = () => resolve(base64);
        img.src = `data:image/png;base64,${base64}`;
    });
}

/**
 * Читает File → base64 (без префикса), опционально уменьшает.
 */
export async function fileToResizedBase64(file, maxSize = 512) {
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
    const base64 = String(dataUrl).split(',')[1] || '';
    return await resizeImageBase64(base64, maxSize);
}

// ============================================================
// NPC
// ============================================================

export function ensureNpcList(settings = getSettings()) {
    if (!Array.isArray(settings.npcList)) settings.npcList = [];
    return settings.npcList;
}

export function addNpc() {
    const settings = getSettings();
    const list = ensureNpcList(settings);
    const npc = {
        id: makeId('npc'),
        name: '',
        aliases: [],
        avatarData: null,
        appearance: '',
        enabled: true,
    };
    list.push(npc);
    saveSettings();
    return npc;
}

export function removeNpc(npcId) {
    const settings = getSettings();
    settings.npcList = ensureNpcList(settings).filter((n) => n.id !== npcId);
    saveSettings();
}

export function updateNpc(npcId, patch) {
    const settings = getSettings();
    const npc = ensureNpcList(settings).find((n) => n.id === npcId);
    if (!npc) return null;
    Object.assign(npc, patch);
    saveSettings();
    return npc;
}

export function toggleNpc(npcId) {
    const settings = getSettings();
    const npc = ensureNpcList(settings).find((n) => n.id === npcId);
    if (!npc) return null;
    npc.enabled = npc.enabled === false ? true : false;
    saveSettings();
    return npc;
}

/**
 * Detection of mentions of {{char}}/{{user}}/NPC по имени и алиасам.
 * Возвращает { charMentioned, userMentioned, npcIds }. Регистр не важен.
 */
export function detectMentionedEntities(prompt) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    const result = { charMentioned: false, userMentioned: false, npcIds: [] };

    const charName = context.characters?.[context.characterId]?.name;
    if (charName && findFirstMatchKeyword(prompt, [charName])) {
        result.charMentioned = true;
    }
    const userName = context.name1;
    if (userName && findFirstMatchKeyword(prompt, [userName])) {
        result.userMentioned = true;
    }

    for (const npc of ensureNpcList(settings)) {
        if (!npc.name || npc.enabled === false) continue;
        const names = [npc.name, ...(Array.isArray(npc.aliases) ? npc.aliases : [])].filter(Boolean);
        if (findFirstMatchKeyword(prompt, names)) {
            // One NPC/reference is included once even if several aliases occur.
            result.npcIds.push(npc.id);
        }
    }

    return result;
}

export function getMatchedNpcs(prompt) {
    const settings = getSettings();
    const { npcIds } = detectMentionedEntities(prompt);
    const list = ensureNpcList(settings);
    return npcIds
        .map((id) => list.find((n) => n.id === id))
        .filter((n) => n && n.enabled !== false);
}

// ============================================================
// Wardrobe (delegated to wardrobe.js v4 module)
// ============================================================

export { swUpdatePromptInjection as updateWardrobeInjection };

export async function getWardrobeAvatarOverrideBase64(side) {
    const normalized = side === 'bot' ? 'bot' : 'user';
    const libraryKind = normalized === 'bot' ? 'char' : 'user';
    if (getActiveCustomCharacterLibraryProfileKey(libraryKind, getSettings())) return null;
    if (!isActiveOutfitTryOn(normalized)) return null;
    return await getActiveOutfitBase64(normalized);
}

/**
 * Avatar references for providers. A worn try-on remains the highest-priority
 * temporary avatar; otherwise every enabled image from the master character
 * library is returned in its provider-specific format.
 */
export async function collectAvatarReferences(side, format = 'base64', prompt = '') {
    const normalized = side === 'bot' ? 'bot' : 'user';
    const kind = normalized === 'bot' ? 'char' : 'user';
    const settings = getSettings();
    if (!await shouldSendCharacterLibraryReference(kind, prompt, settings)) return [];
    const override = await getWardrobeAvatarOverrideBase64(normalized);
    if (override) {
        return [format === 'dataUrl' ? `data:image/png;base64,${override}` : override];
    }
    const refs = await collectCharacterLibraryReferences(kind, format, settings);
    return refs.map(getReferenceImage).filter(Boolean);
}

export function mergeAvatarReferenceGroups(groups, maxCount = Number.POSITIVE_INFINITY) {
    const normalized = groups.filter(Array.isArray);
    const merged = [];
    const append = (value) => {
        if (value && merged.length < maxCount) merged.push(value);
    };
    // Preserve the main reference for every enabled participant first.
    for (const group of normalized) append(group[0]);
    // Then append their extra appearances in stable group order.
    for (const group of normalized) for (const value of group.slice(1)) append(value);
    return merged;
}

// ============================================================
// Avatar Library (кастомные аватарки персонажа/юзера)
// ============================================================

export function ensureAvatarItems(settings = getSettings()) {
    if (!Array.isArray(settings.avatarItems)) settings.avatarItems = [];
    for (const item of settings.avatarItems) {
        if (!Object.hasOwn(item, 'appearance')) item.appearance = '';
        if (!Object.hasOwn(item, 'favorite')) item.favorite = false;
        if (!Array.isArray(item.tags)) item.tags = [];
    }
    return settings.avatarItems;
}

export function addAvatarItem(name, imageData, target = 'char') {
    const settings = getSettings();
    const items = ensureAvatarItems(settings);
    const item = {
        id: makeId('ava'),
        name: String(name || '').trim() || 'Avatar',
        imageData,
        target: target === 'user' ? 'user' : 'char',
        createdAt: Date.now(),
        favorite: false,
        tags: [],
    };
    items.push(item);
    saveSettings();
    return item;
}

export function removeAvatarItem(itemId) {
    const settings = getSettings();
    if (settings.activeAvatarChar === itemId) settings.activeAvatarChar = null;
    if (settings.activeAvatarUser === itemId) settings.activeAvatarUser = null;
    settings.avatarItems = ensureAvatarItems(settings).filter((a) => a.id !== itemId);
    saveSettings();
}

export function setActiveAvatar(itemId, target) {
    const settings = getSettings();
    const key = target === 'user' ? 'activeAvatarUser' : 'activeAvatarChar';
    settings[key] = settings[key] === itemId ? null : itemId;
    saveSettings();
    return settings[key];
}

export function getActiveAvatarItem(target, settings = getSettings()) {
    const id = target === 'user' ? settings.activeAvatarUser : settings.activeAvatarChar;
    if (!id) return null;
    return ensureAvatarItems(settings).find((a) => a.id === id) || null;
}

export function updateAvatarItemName(itemId, name) {
    const settings = getSettings();
    const item = ensureAvatarItems(settings).find((a) => a.id === itemId);
    if (!item) return null;
    item.name = String(name || '').trim() || 'Avatar';
    saveSettings();
    return item;
}

export function updateAvatarItemAppearance(itemId, appearance) {
    const settings = getSettings();
    const item = ensureAvatarItems(settings).find((a) => a.id === itemId);
    if (!item) return null;
    item.appearance = String(appearance || '');
    saveSettings();
    updateAvatarAppearanceInjection();
    return item;
}

export function toggleAvatarFavorite(itemId) {
    const settings = getSettings();
    const item = ensureAvatarItems(settings).find((a) => a.id === itemId);
    if (!item) return;
    item.favorite = !item.favorite;
    saveSettings();
}

export function updateAvatarItemTags(itemId, tags) {
    const settings = getSettings();
    const item = ensureAvatarItems(settings).find((a) => a.id === itemId);
    if (!item) return;
    item.tags = Array.isArray(tags) ? tags : [];
    saveSettings();
}

/**
 * Инжектит описания внешности активных аватаров (char + user) в LLM-промпт через
 * setExtensionPrompt. Вызывается при изменении активного аватара/описания
 * и на init / CHAT_CHANGED.
 *
 * Если injectAvatarAppearanceToChatEnabled выключен, инжект очищается.
 */
export function updateAvatarAppearanceInjection() {
    try {
        const context = SillyTavern.getContext();
        const settings = getSettings();
        const injectionKey = `${MODULE_NAME}_avatar_appearance`;

        if (typeof context.setExtensionPrompt !== 'function') {
            iigLog('WARN', 'setExtensionPrompt not available — avatar appearance injection skipped');
            return;
        }

        if (!settings.injectAvatarAppearanceToChatEnabled) {
            context.setExtensionPrompt(injectionKey, '', 0, 0);
            return;
        }

        const parts = [];

        const charItem = getActiveAvatarItem('char', settings);
        if (charItem?.appearance) {
            const charName = context.characters?.[context.characterId]?.name || 'Character';
            parts.push(`[${charName} looks like: ${charItem.appearance}]`);
        }

        const userItem = getActiveAvatarItem('user', settings);
        if (userItem?.appearance) {
            const userName = context.name1 || 'User';
            parts.push(`[${userName} looks like: ${userItem.appearance}]`);
        }

        const text = parts.join('\n');
        const depth = Number.isFinite(settings.avatarAppearanceInjectionDepth) ? settings.avatarAppearanceInjectionDepth : 1;
        context.setExtensionPrompt(injectionKey, text, 1, depth);
        iigLog('INFO', `Avatar appearance injection updated (${text.length} chars, depth=${depth})`);
    } catch (error) {
        iigLog('ERROR', 'Avatar appearance injection error:', error);
    }
}

// ============================================================
// Reference helpers (приводят активную одежду + матчнутых NPC к base64/dataUrl)
// ============================================================

/**
 * Собирает дополнительные референсы (NPC + активная одежда) в нужном формате
 * провайдера: 'base64' (OpenAI/Gemini/Naistera) или 'dataUrl' (OpenRouter/...).
 *
 * Возвращает массив строк готовых к push в `references` массив провайдера.
 */
export async function collectExtraReferences(prompt, format = 'base64') {
    const objects = await collectExtraReferenceObjects(prompt, format);
    return objects.map((ref) => ref.image);
}

/**
 * Как collectExtraReferences, но с метаданными о происхождении каждой
 * картинки: `{ image, kind, name }`, где kind — 'npc' | 'outfit-char' |
 * 'outfit-user'. Нужно провайдерам, которые подписывают референсы в промпте
 * («Image N is X's FACE...») — без подписей модель путает аутфиты с лицами.
 */
export async function collectExtraReferenceObjects(prompt, format = 'base64') {
    const settings = getSettings();
    const refs = [];

    const wrap = (b64) => format === 'dataUrl' ? `data:image/png;base64,${b64}` : b64;

    if (settings.autoDetectNames !== false) {
        for (const npc of getMatchedNpcs(prompt)) {
            if (!npc?.avatarData) continue;
            refs.push({ image: wrap(npc.avatarData), kind: 'npc', name: String(npc.name || 'NPC') });
        }
    }

    // Wardrobe v4: send active outfit images as references
    const [botOutfitAllowed, userOutfitAllowed] = settings.optionalWardrobeSending !== true
        ? [true, true]
        : await Promise.all([
            activeCharacterLibraryEntryMatchesPromptAsync('char', prompt, settings),
            activeCharacterLibraryEntryMatchesPromptAsync('user', prompt, settings),
        ]);
    if (settings.optionalWardrobeSending === true) {
        iigLog('INFO', `Wardrobe alias match: character=${botOutfitAllowed}, persona=${userOutfitAllowed}`);
    }

    if (settings.swSendOutfitImageBot !== false && botOutfitAllowed) {
        const botTryOnUsedAsAvatar = isActiveOutfitTryOn('bot')
            && (settings.apiType === 'naistera' ? settings.naisteraSendCharAvatar : settings.sendCharAvatar)
            && await shouldSendCharacterLibraryReference('char', prompt, settings);
        const botImg = botTryOnUsedAsAvatar ? null : (await getActiveOutfitBase64('bot') || await getCollageBase64('bot'));
        if (botImg) refs.push({ image: wrap(botImg), kind: 'outfit-char', name: '' });
    }
    if (settings.swSendOutfitImageUser !== false && userOutfitAllowed) {
        const userTryOnUsedAsAvatar = isActiveOutfitTryOn('user')
            && (settings.apiType === 'naistera' ? settings.naisteraSendUserAvatar : settings.sendUserAvatar)
            && await shouldSendCharacterLibraryReference('user', prompt, settings);
        const userImg = userTryOnUsedAsAvatar ? null : (await getActiveOutfitBase64('user') || await getCollageBase64('user'));
        if (userImg) refs.push({ image: wrap(userImg), kind: 'outfit-user', name: '' });
    }

    return refs;
}

/**
 * Возвращает дополнительные текстовые блоки для встройки в финальный промпт
 * (NPC внешности + одежда). Используется в parser.buildFinalGenerationPrompt.
 *
 * Возвращает массив строк (каждая — отдельный блок), готовых к join('\n\n').
 */
export function buildExtraPromptBlocks(prompt) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const blocks = [];

    if (settings.autoDetectNames !== false) {
        for (const npc of getMatchedNpcs(prompt)) {
            if (!npc?.appearance) continue;
            blocks.push(`[NPC Reference: ${npc.name}'s appearance: ${npc.appearance}]`);
        }
    }

    if (settings.injectAvatarAppearanceToGeneration) {
        const charAva = getActiveAvatarItem('char', settings);
        if (charAva?.appearance) {
            const charName = context.characters?.[context.characterId]?.name || 'Character';
            blocks.push(`[${charName} looks like: ${charAva.appearance}]`);
        }

        const userAva = getActiveAvatarItem('user', settings);
        if (userAva?.appearance) {
            const userName = context.name1 || 'User';
            blocks.push(`[${userName} looks like: ${userAva.appearance}]`);
        }
    }

    // Wardrobe v4: add outfit descriptions
    const charName = context.characters?.[context.characterId]?.name || 'Character';
    const userName = context.name1 || 'User';
    const botOutfitAllowed = settings.optionalWardrobeSending !== true
        || activeCharacterLibraryEntryMatchesPrompt('char', prompt, settings);
    const userOutfitAllowed = settings.optionalWardrobeSending !== true
        || activeCharacterLibraryEntryMatchesPrompt('user', prompt, settings);
    const botDesc = botOutfitAllowed ? getActiveOutfitDescription('bot') : '';
    if (botDesc) {
        blocks.push(`[OUTFIT LOCK — keep unchanged: ${charName} is currently wearing: ${botDesc}. Always use this exact outfit when writing image prompts for ${charName}.]`);
    }
    const userDesc = userOutfitAllowed ? getActiveOutfitDescription('user') : '';
    if (userDesc) {
        blocks.push(`[OUTFIT LOCK — keep unchanged: ${userName} is currently wearing: ${userDesc}. Always use this exact outfit when writing image prompts for ${userName}.]`);
    }

    return blocks;
}
