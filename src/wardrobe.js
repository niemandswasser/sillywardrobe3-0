/**
 * Wardrobe module — ported from SillyImages SillyWardrobe.
 *
 * Single outfit per side (bot / user), shared / per-character wardrobe,
 * outfit types (customizable categories), try-on (AI full-body generation),
 * pagination, sorting, NPC manager, quick settings, maintenance tools.
 */

import { getSettings, iigLog, MODULE_NAME, NAISTERA_MODELS, NOVELAI_MODELS } from './settings.js';
import {
    getAllProviders,
    resolveActiveProvider,
    validateSettings as validateProviderSettings,
} from './providers.js';
import {
    getCharacterAvatarBase64,
    getUserAvatarBase64,
    loadPersonasModule,
} from './references.js';
import {
    imageUrlToDataUrl,
    convertDataUrlToPng,
    downloadImageSrc,
    parseImageDataUrl,
} from './utils.js';
import { callVisionApi, DEFAULT_VISION_PROMPT } from './vision.js';

// ── Constants ──

const SW = 'silly_wardrobe';

function uid() { return Date.now().toString(36) + Math.random().toString(36).substring(2, 8); }
function esc(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }

function swSanitizeDesc(raw) {
    let s = String(raw || '');
    s = s.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '');
    s = s.replace(/<\/?think\b[^>]*>/gi, '');
    s = s.replace(/```(?:thinking|thought|reasoning)[\s\S]*?```/gi, '');
    s = s.replace(/\[(?:thinking|thought|reasoning)\][\s\S]*?\[\/(?:thinking|thought|reasoning)\]/gi, '');
    return s.replace(/\s+/g, ' ').trim();
}

const SW_DEFAULT_TYPES = [
    { id: 'casual', label: 'Повседневное',   icon: 'fa-shirt' },
    { id: 'formal', label: 'Формальное',     icon: 'fa-gem' },
    { id: 'sport',  label: 'Спортивное',     icon: 'fa-person-running' },
    { id: 'sleep',  label: 'Спальное',       icon: 'fa-bed' },
    { id: 'beach',  label: 'Пляж/купальник', icon: 'fa-umbrella-beach' },
    { id: 'work',   label: 'Работа',         icon: 'fa-briefcase' },
    { id: 'outer',  label: 'Верхняя',        icon: 'fa-mitten' },
    { id: 'other',  label: 'Другое',         icon: 'fa-tag' },
];
const SW_FALLBACK_TYPE = 'other';
const SW_TYPE_ICONS = [
    'fa-shirt', 'fa-gem', 'fa-person-running', 'fa-bed', 'fa-umbrella-beach',
    'fa-briefcase', 'fa-mitten', 'fa-tag', 'fa-crown', 'fa-hat-cowboy',
    'fa-vest', 'fa-socks', 'fa-shoe-prints', 'fa-glasses', 'fa-ring',
    'fa-user-tie', 'fa-user-ninja', 'fa-mask', 'fa-snowflake', 'fa-sun',
    'fa-heart', 'fa-star', 'fa-wand-magic-sparkles', 'fa-dragon',
];

const swDefaults = Object.freeze({
    wardrobes: {}, activeOutfits: {},
    personaWardrobes: {}, personaActiveOutfits: {}, personaMigrationByCharacter: {},
    sharedUserWardrobe: [], sharedUserActive: null, sharedUserActiveByChat: {}, useSharedUserWardrobe: false,
    sharedUserActiveByPersona: {},
    sharedBotWardrobe:  [], sharedBotActive:  null, sharedBotActiveByChat:  {}, useSharedBotWardrobe:  false,
    sharedDeletedSourceIds: { bot: [], user: [] },
    maxDimension: 512, showFloatingBtn: false,
    tryOnPrompt: '',
    genLookPrompt: '',
    tryOnAsAvatar: true,
    generationOverrideEnabled: false,
    generationProvider: '',
    generationProfileId: '',
    generationModel: '',
    generationImageSize: '',
});

// ── Settings ──

export function swGetSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings[SW]) ctx.extensionSettings[SW] = structuredClone(swDefaults);
    const s = ctx.extensionSettings[SW];
    for (const k of Object.keys(swDefaults)) if (!Object.hasOwn(s, k)) s[k] = structuredClone(swDefaults[k]);
    if (!Array.isArray(s.sharedUserWardrobe)) s.sharedUserWardrobe = [];
    if (!Array.isArray(s.sharedBotWardrobe)) s.sharedBotWardrobe = [];
    if (!s.personaWardrobes || typeof s.personaWardrobes !== 'object') s.personaWardrobes = {};
    if (!s.personaActiveOutfits || typeof s.personaActiveOutfits !== 'object') s.personaActiveOutfits = {};
    if (!s.personaMigrationByCharacter || typeof s.personaMigrationByCharacter !== 'object') s.personaMigrationByCharacter = {};
    if (!s.sharedUserActiveByChat || typeof s.sharedUserActiveByChat !== 'object') s.sharedUserActiveByChat = {};
    if (!s.sharedUserActiveByPersona || typeof s.sharedUserActiveByPersona !== 'object') s.sharedUserActiveByPersona = {};
    if (!s.sharedBotActiveByChat || typeof s.sharedBotActiveByChat !== 'object') s.sharedBotActiveByChat = {};
    if (!s.sharedDeletedSourceIds || typeof s.sharedDeletedSourceIds !== 'object') s.sharedDeletedSourceIds = { bot: [], user: [] };
    if (s.generationProvider === 'problembo') {
        s.generationOverrideEnabled = false;
        s.generationProvider = '';
        s.generationProfileId = '';
        s.generationModel = '';
        s.generationImageSize = '';
        ctx.saveSettingsDebounced();
    }
    for (const side of ['bot', 'user']) {
        if (!Array.isArray(s.sharedDeletedSourceIds[side])) s.sharedDeletedSourceIds[side] = [];
        s.sharedDeletedSourceIds[side] = [...new Set(s.sharedDeletedSourceIds[side].map(String).filter(Boolean))];
    }
    if (!Array.isArray(s.outfitTypes) || !s.outfitTypes.length) {
        s.outfitTypes = structuredClone(SW_DEFAULT_TYPES);
        swMigrateTypeId(s, 'underwear', 'work');
    }
    if (s.outfitTypes.some(t => !t || typeof t.id !== 'string' || !t.id)) {
        s.outfitTypes = s.outfitTypes.filter(t => t && typeof t.id === 'string' && t.id);
    }
    if (!s.outfitTypes.some(t => t.id === SW_FALLBACK_TYPE)) s.outfitTypes.push({ id: SW_FALLBACK_TYPE, label: 'Другое', icon: 'fa-tag' });
    return s;
}

function swProviderModel(settings, apiType = settings?.apiType) {
    if (apiType === 'novelai') {
        return settings?.novelaiModel === '__custom__'
            ? String(settings?.novelaiCustomModel || '')
            : String(settings?.novelaiModel || '');
    }
    if (apiType === 'naistera') return String(settings?.naisteraModel || settings?.model || '');
    return String(settings?.model || '');
}

function swSetProviderModel(settings, apiType, model) {
    const value = String(model || '').trim();
    if (apiType === 'novelai') {
        settings.novelaiModel = value;
        settings.novelaiCustomModel = '';
    } else if (apiType === 'naistera') {
        settings.naisteraModel = value;
        settings.model = value;
    } else {
        settings.model = value;
    }
}

function swConnectionProfiles() {
    const profiles = getSettings().connectionProfiles;
    return Array.isArray(profiles) ? profiles.filter(profile => profile && profile.id) : [];
}

function swKnownProviderModels(apiType) {
    if (apiType === 'naistera') return [...NAISTERA_MODELS];
    if (apiType === 'novelai') return NOVELAI_MODELS.map(item => item.value).filter(value => value !== '__custom__');
    return [];
}

function swResolveGenerationRoute() {
    const base = getSettings();
    const wardrobe = swGetSettings();
    if (!wardrobe.generationOverrideEnabled) {
        const provider = resolveActiveProvider(base);
        return { settings: base, provider, overridden: false, profile: null };
    }

    const apiType = wardrobe.generationProvider || base.apiType;
    const matchingProfiles = swConnectionProfiles().filter(profile => profile.apiType === apiType);
    let profile = matchingProfiles.find(item => item.id === wardrobe.generationProfileId) || null;
    if (!profile && base.apiType !== apiType) profile = matchingProfiles[0] || null;
    if (!profile && base.apiType !== apiType) {
        throw new Error(`Для провайдера «${apiType}» нет сохранённого профиля подключения. Создайте его в настройках API.`);
    }

    const routeSettings = { ...base, ...(profile || {}), apiType };
    const selectedModel = wardrobe.generationModel || swProviderModel(routeSettings, apiType);
    swSetProviderModel(routeSettings, apiType, selectedModel);
    const provider = resolveActiveProvider(routeSettings);
    return { settings: routeSettings, provider, overridden: true, profile };
}

function swGenerationRouteLabel() {
    try {
        const route = swResolveGenerationRoute();
        if (!route.provider) return 'провайдер не выбран';
        const model = swProviderModel(route.settings, route.settings.apiType) || 'модель не выбрана';
        const routeLabel = route.overridden
            ? `${route.provider.displayName}: ${model}`
            : `активная — ${route.provider.displayName}: ${model}`;
        const fixedSize = swGetSettings().generationImageSize;
        return fixedSize ? `${routeLabel} · ${fixedSize}` : routeLabel;
    } catch (error) {
        return String(error.message || error);
    }
}

function swGenerationControlsHtml(prefix, open = false) {
    const base = getSettings();
    const wardrobe = swGetSettings();
    const selectedProvider = wardrobe.generationProvider || base.apiType;
    const providers = getAllProviders();
    return `<details class="sw-generation-route" id="${prefix}-route" ${open ? 'open' : ''}>
        <summary><i class="fa-solid fa-microchip"></i> Модель примерки и сборки: <span class="sw-generation-route-summary">${esc(swGenerationRouteLabel())}</span></summary>
        <div class="sw-generation-route-body">
            <label class="sw-quick-check"><input type="checkbox" id="${prefix}-override" ${wardrobe.generationOverrideEnabled ? 'checked' : ''}><span>Переопределить активную модель</span></label>
            <div class="sw-quick-row sw-generation-size-row"><label>Размер результата</label><select class="text_pole" id="${prefix}-image-size">
                <option value="" ${!wardrobe.generationImageSize ? 'selected' : ''}>Как в настройках провайдера</option>
                ${['1K', '2K', '4K'].map(size => `<option value="${size}" ${wardrobe.generationImageSize === size ? 'selected' : ''}>Фиксированно ${size}</option>`).join('')}
            </select><div class="sw-quick-hint">Только для примерки, генерации образа и конструктора. Если модель не поддерживает выбранный размер, провайдер использует доступный.</div></div>
            <div class="sw-generation-route-fields" ${wardrobe.generationOverrideEnabled ? '' : 'hidden'}>
                <div class="sw-quick-row"><label>Провайдер</label><select class="text_pole" id="${prefix}-provider">${providers.map(provider => `<option value="${esc(provider.id)}" ${provider.id === selectedProvider ? 'selected' : ''}>${esc(provider.displayName)}</option>`).join('')}</select></div>
                <div class="sw-quick-row"><label>Профиль подключения</label><select class="text_pole" id="${prefix}-profile"></select></div>
                <div class="sw-quick-row"><label>Модель</label><div class="sw-quick-model-wrap"><input class="text_pole" id="${prefix}-model" list="${prefix}-models" value="${esc(wardrobe.generationModel)}" placeholder="Модель из профиля"><datalist id="${prefix}-models"></datalist><button type="button" class="sw-generation-model-refresh" id="${prefix}-refresh" title="Загрузить модели провайдера"><i class="fa-solid fa-rotate"></i></button></div></div>
                <div class="sw-quick-hint">Ключ и endpoint берутся из выбранного профиля подключения. Поле модели допускает и собственный ID.</div>
            </div>
        </div>
    </details>`;
}

function swBindGenerationControls(root, prefix) {
    const wardrobe = swGetSettings();
    const override = root.querySelector(`#${prefix}-override`);
    const fields = root.querySelector(`#${prefix}-route .sw-generation-route-fields`);
    const providerSelect = root.querySelector(`#${prefix}-provider`);
    const profileSelect = root.querySelector(`#${prefix}-profile`);
    const modelInput = root.querySelector(`#${prefix}-model`);
    const imageSizeSelect = root.querySelector(`#${prefix}-image-size`);
    const modelsList = root.querySelector(`#${prefix}-models`);
    const summary = root.querySelector(`#${prefix}-route .sw-generation-route-summary`);

    const updateSummary = () => { if (summary) summary.textContent = swGenerationRouteLabel(); };
    const profilesForProvider = () => swConnectionProfiles().filter(profile => profile.apiType === providerSelect.value);
    const renderProfiles = (preferId = wardrobe.generationProfileId) => {
        const profiles = profilesForProvider();
        profileSelect.innerHTML = '';
        if (getSettings().apiType === providerSelect.value) {
            const option = document.createElement('option');
            option.value = ''; option.textContent = 'Текущие активные настройки';
            profileSelect.appendChild(option);
        }
        for (const profile of profiles) {
            const option = document.createElement('option');
            option.value = profile.id; option.textContent = profile.name || profile.id;
            profileSelect.appendChild(option);
        }
        const available = [...profileSelect.options].some(option => option.value === preferId);
        profileSelect.value = available ? preferId : (profileSelect.options[0]?.value || '');
        wardrobe.generationProfileId = profileSelect.value;
    };
    const selectedSource = () => {
        const profile = swConnectionProfiles().find(item => item.id === profileSelect.value);
        return profile || (getSettings().apiType === providerSelect.value ? getSettings() : null);
    };
    const fillModelList = (models = []) => {
        const sourceModel = swProviderModel(selectedSource(), providerSelect.value);
        const values = [...new Set([...swKnownProviderModels(providerSelect.value), sourceModel, ...models].map(String).filter(Boolean))];
        modelsList.innerHTML = '';
        for (const model of values) {
            const option = document.createElement('option'); option.value = model; modelsList.appendChild(option);
        }
    };
    const adoptSourceModel = () => {
        if (wardrobe.generationModel) return;
        const source = selectedSource();
        if (source) modelInput.placeholder = swProviderModel(source, providerSelect.value) || 'Введите ID модели';
    };

    renderProfiles();
    adoptSourceModel();
    fillModelList();
    override?.addEventListener('change', () => {
        wardrobe.generationOverrideEnabled = override.checked;
        fields.hidden = !override.checked;
        swSave(); updateSummary();
    });
    providerSelect?.addEventListener('change', () => {
        wardrobe.generationProvider = providerSelect.value;
        wardrobe.generationProfileId = '';
        wardrobe.generationModel = '';
        modelInput.value = '';
        renderProfiles(''); adoptSourceModel(); fillModelList(); swSave(); updateSummary();
    });
    profileSelect?.addEventListener('change', () => {
        wardrobe.generationProfileId = profileSelect.value;
        wardrobe.generationModel = '';
        modelInput.value = '';
        adoptSourceModel(); fillModelList(); swSave(); updateSummary();
    });
    modelInput?.addEventListener('input', () => {
        wardrobe.generationModel = modelInput.value.trim();
        swSave(); updateSummary();
    });
    imageSizeSelect?.addEventListener('change', () => {
        wardrobe.generationImageSize = ['1K', '2K', '4K'].includes(imageSizeSelect.value) ? imageSizeSelect.value : '';
        swSave(); updateSummary();
    });
    root.querySelector(`#${prefix}-refresh`)?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.querySelector('i')?.classList.add('fa-spin');
        try {
            wardrobe.generationOverrideEnabled = true;
            wardrobe.generationProvider = providerSelect.value;
            wardrobe.generationProfileId = profileSelect.value;
            const route = swResolveGenerationRoute();
            if (!route.provider) throw new Error('Провайдер не выбран');
            if (route.settings.rawEndpoint) throw new Error('Для raw endpoint модель вводится вручную');
            const models = await route.provider.fetchModels(route.settings);
            fillModelList(models);
            toastr.success(`Загружено моделей: ${modelsList.children.length}`, 'Гардероб');
        } catch (error) {
            toastr.error(String(error.message || error), 'Модели гардероба');
        } finally {
            button.disabled = false;
            button.querySelector('i')?.classList.remove('fa-spin');
        }
    });
    updateSummary();
}

function swForEachOutfit(s, cb) {
    const arrays = [s.sharedBotWardrobe, s.sharedUserWardrobe];
    for (const w of Object.values(s.wardrobes || {})) if (w) arrays.push(w.bot, w.user);
    for (const arr of Object.values(s.personaWardrobes || {})) arrays.push(arr);
    for (const arr of arrays) if (Array.isArray(arr)) for (const o of arr) if (o) cb(o);
}

function swMigrateTypeId(s, oldId, newId) { swForEachOutfit(s, (o) => { if (o.type === oldId) o.type = newId; }); }

function swTypes() { return swGetSettings().outfitTypes; }
function swTypeIds() { return swTypes().map(t => t.id); }
function swTypeOf(o) { return (o && swTypeIds().includes(o.type)) ? o.type : SW_FALLBACK_TYPE; }
function swTypeMeta(id) { const ts = swTypes(); return ts.find(t => t.id === id) || ts.find(t => t.id === SW_FALLBACK_TYPE) || ts[ts.length - 1]; }

function swPlural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
}

function swImgSrc(o) {
    if (!o) return '';
    if (o.imagePath) return o.imagePath;
    if (o.base64) return 'data:image/png;base64,' + o.base64;
    return '';
}

// ── Tag manager ──

function swRenderTagManager(listEl) {
    if (!listEl) return;
    const types = swTypes();
    listEl.innerHTML = types.map(t => {
        const locked = t.id === SW_FALLBACK_TYPE;
        const icons = SW_TYPE_ICONS.map(ic => `<button type="button" class="sw-tag-ico-opt ${ic === t.icon ? 'sw-tag-ico-sel' : ''}" data-ico="${ic}" title="${ic}"><i class="fa-solid ${ic}"></i></button>`).join('');
        return `<div class="sw-tag-block">
            <div class="sw-tag-row" data-id="${esc(t.id)}">
                <button type="button" class="sw-tag-icon" title="Сменить иконку"><i class="fa-solid ${esc(t.icon || 'fa-tag')}"></i></button>
                <input type="text" class="sw-tag-name text_pole" value="${esc(t.label || '')}" maxlength="24" placeholder="Название тега">
                ${locked
                    ? '<span class="sw-tag-lock" title="Запасной тег — удалить нельзя"><i class="fa-solid fa-lock"></i></span>'
                    : '<button type="button" class="sw-tag-del" title="Удалить тег"><i class="fa-solid fa-trash-can"></i></button>'}
            </div>
            <div class="sw-tag-icons" hidden>${icons}</div>
        </div>`;
    }).join('');

    const refreshMain = () => { if (swOpen) swRender(); };

    for (const block of listEl.querySelectorAll('.sw-tag-block')) {
        const row = block.querySelector('.sw-tag-row');
        const id = row.dataset.id;
        const iconsBox = block.querySelector('.sw-tag-icons');
        const tag = () => swTypes().find(x => x.id === id);

        row.querySelector('.sw-tag-icon').addEventListener('click', () => {
            const willShow = iconsBox.hidden;
            for (const b of listEl.querySelectorAll('.sw-tag-icons')) b.hidden = true;
            iconsBox.hidden = !willShow;
        });
        for (const opt of iconsBox.querySelectorAll('.sw-tag-ico-opt')) {
            opt.addEventListener('click', () => {
                const t = tag(); if (!t) return;
                t.icon = opt.dataset.ico; swSave();
                swRenderTagManager(listEl); refreshMain();
            });
        }

        const nameInp = row.querySelector('.sw-tag-name');
        nameInp.addEventListener('input', () => { const t = tag(); if (t) { t.label = nameInp.value; swSave(); } });
        nameInp.addEventListener('change', () => {
            const t = tag(); if (!t) return;
            t.label = nameInp.value.trim() || t.label || 'Тег';
            nameInp.value = t.label; swSave(); refreshMain();
        });

        row.querySelector('.sw-tag-del')?.addEventListener('click', () => {
            const s = swGetSettings();
            let moved = 0;
            swForEachOutfit(s, (o) => { if (o.type === id) { o.type = SW_FALLBACK_TYPE; moved++; } });
            s.outfitTypes = s.outfitTypes.filter(x => x.id !== id);
            if (swFilter === id) swFilter = 'all';
            swSave();
            swRenderTagManager(listEl); refreshMain();
            toastr.info(`Тег удалён${moved ? ` · ${moved} ${swPlural(moved, 'наряд', 'наряда', 'нарядов')} → «Другое»` : ''}`, 'Гардероб', { timeOut: 2500 });
        });
    }
}

// ── State ──

let swOpen = false, swTab = 'bot';
let swFilter = 'all';
let swSort = 'added';
const SW_PAGE_SIZE = 11;
let swPage = 0;

function swSortOutfits(arr, activeId) {
    const a = arr.slice();
    if (swSort === 'name') {
        a.sort((x, y) => (x.name || '').localeCompare(y.name || '', undefined, { sensitivity: 'base', numeric: true }));
    } else if (swSort === 'worn') {
        a.sort((x, y) => (y.lastWorn || 0) - (x.lastWorn || 0) || (y.addedAt || 0) - (x.addedAt || 0));
    } else {
        a.sort((x, y) => (y.addedAt || 0) - (x.addedAt || 0));
    }
    if (activeId) {
        const i = a.findIndex(o => o.id === activeId);
        if (i > 0) a.unshift(a.splice(i, 1)[0]);
    }
    return a;
}

const swSharedCache = { bot: { b64: null, id: null }, user: { b64: null, id: null } };
let swPersonasModule = null;
function swSave() { SillyTavern.getContext().saveSettingsDebounced(); }
function swCharName() {
    const ctx = SillyTavern.getContext();
    return (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) ? (ctx.characters[ctx.characterId].name || '') : '';
}

function swPersonaAvatarId() {
    const fromModule = String(swPersonasModule?.user_avatar || '').trim();
    if (fromModule) return fromModule;
    const ctx = SillyTavern.getContext();
    const fromChat = String(ctx.chatMetadata?.persona || '').trim();
    if (fromChat) return fromChat;
    const matches = Object.entries(ctx.powerUserSettings?.personas || {})
        .filter(([, name]) => String(name || '') === String(ctx.name1 || ''))
        .map(([avatar]) => avatar);
    if (matches.length === 1) return String(matches[0]);
    return `name:${String(ctx.name1 || 'default').trim() || 'default'}`;
}

function swPersonaKey() { return `persona:${swPersonaAvatarId()}`; }
function swPersonaLabel() {
    const ctx = SillyTavern.getContext();
    return String(ctx.powerUserSettings?.personas?.[swPersonaAvatarId()] || ctx.name1 || 'Persona');
}

function swEnsurePersonaWardrobe() {
    const s = swGetSettings();
    const key = swPersonaKey();
    if (!Array.isArray(s.personaWardrobes[key])) s.personaWardrobes[key] = [];
    if (!Object.hasOwn(s.personaActiveOutfits, key)) s.personaActiveOutfits[key] = null;

    // Compatibility migration: the current character's legacy user wardrobe
    // is claimed once by the persona that is active when it is first opened.
    const cn = swCharName();
    if (cn && !s.personaMigrationByCharacter[cn]) {
        const legacy = swGetWardrobe(cn).user;
        const target = s.personaWardrobes[key];
        const known = new Set(target.map(item => item?.id).filter(Boolean));
        for (const outfit of legacy) {
            if (outfit?.id && !known.has(outfit.id)) {
                target.push(structuredClone(outfit));
                known.add(outfit.id);
            }
        }
        const legacyActive = s.activeOutfits?.[cn]?.user || null;
        if (!s.personaActiveOutfits[key] && legacyActive && known.has(legacyActive)) {
            s.personaActiveOutfits[key] = legacyActive;
        }
        s.personaMigrationByCharacter[cn] = key;
        swSave();
    }
    return { s, key, list: s.personaWardrobes[key] };
}

function swGetPersonalList(side) {
    if (side === 'user') return swEnsurePersonaWardrobe().list;
    return swGetWardrobe(swCharName()).bot;
}
function swGetPersonalActiveId(side) {
    if (side === 'user') {
        const { s, key } = swEnsurePersonaWardrobe();
        return s.personaActiveOutfits[key] || null;
    }
    return swGetActive().bot || null;
}
function swSetPersonalActiveId(side, id) {
    if (side === 'user') {
        const { s, key } = swEnsurePersonaWardrobe();
        s.personaActiveOutfits[key] = id || null;
        swSave();
        return true;
    }
    return swSetActive('bot', id);
}

function swGetWardrobe(cn) { const s = swGetSettings(); if (!s.wardrobes[cn]) s.wardrobes[cn] = { bot: [], user: [] }; return s.wardrobes[cn]; }
function swGetActive() { const cn = swCharName(); if (!cn) return { bot: null, user: null }; const s = swGetSettings(); if (!s.activeOutfits[cn]) s.activeOutfits[cn] = { bot: null, user: null }; return s.activeOutfits[cn]; }
function swSetActive(type, id) { const cn = swCharName(); if (!cn) { toastr.error('Персонаж не выбран', 'Гардероб'); return false; } const s = swGetSettings(); if (!s.activeOutfits[cn]) s.activeOutfits[cn] = { bot: null, user: null }; s.activeOutfits[cn][type] = id; swSave(); return true; }
function swFind(cn, type, id) { return swGetWardrobe(cn)[type].find(o => o.id === id) || null; }
function swAdd(cn, type, o) { swGetWardrobe(cn)[type].push(o); swSave(); }
function swRemove(cn, type, id) { const w = swGetWardrobe(cn); w[type] = w[type].filter(o => o.id !== id); swSave(); if (swGetActive()[type] === id) { swSetActive(type, null); swUpdatePromptInjection(); } }

// ── Shared wardrobe per side ──

function swSharedCfg(side) {
    const s = swGetSettings();
    const k = side === 'bot'
        ? { list: 'sharedBotWardrobe',  active: 'sharedBotActive',  byChat: 'sharedBotActiveByChat',  use: 'useSharedBotWardrobe' }
        : { list: 'sharedUserWardrobe', active: 'sharedUserActive', byChat: 'sharedUserActiveByChat', use: 'useSharedUserWardrobe' };
    return {
        use: () => !!s[k.use],
        setUse: (v) => { s[k.use] = !!v; },
        list: () => s[k.list],
        setList: (arr) => { s[k.list] = arr; },
        global: () => s[k.active] || null,
        setGlobal: (id) => { s[k.active] = id; },
        byChat: () => s[k.byChat],
        fileLabel: () => (side === 'bot' ? 'sw_bot_' : 'sw_user_'),
    };
}

function swCurrentChatId() {
    try {
        const ctx = SillyTavern.getContext();
        return (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : null) || null;
    } catch (e) { return null; }
}
function swGetSharedActiveId(side) {
    const cfg = swSharedCfg(side);
    if (side === 'user') {
        const s = swGetSettings();
        const key = swPersonaKey();
        if (Object.hasOwn(s.sharedUserActiveByPersona, key)) {
            const savedId = s.sharedUserActiveByPersona[key] || null;
            if (!savedId || cfg.list().some(item => item?.id === savedId)) return savedId;
            s.sharedUserActiveByPersona[key] = null;
            swSave();
            return null;
        }
        const legacyChatId = swCurrentChatId();
        let legacyId = null;
        if (legacyChatId && Object.hasOwn(cfg.byChat(), legacyChatId)) {
            legacyId = cfg.byChat()[legacyChatId] || null;
        } else {
            legacyId = cfg.global();
        }
        if (legacyId && !cfg.list().some(item => item?.id === legacyId)) legacyId = null;
        s.sharedUserActiveByPersona[key] = legacyId;
        swSave();
        return legacyId;
    }
    const cid = swCurrentChatId();
    if (cid) {
        const map = cfg.byChat();
        const savedId = Object.hasOwn(map, cid) ? (map[cid] || null) : null;
        if (!savedId || cfg.list().some(item => item?.id === savedId)) return savedId;
        map[cid] = null;
        swSave();
        return null;
    }
    const globalId = cfg.global();
    if (!globalId || cfg.list().some(item => item?.id === globalId)) return globalId;
    cfg.setGlobal(null);
    swSave();
    return null;
}
function swSetSharedActiveId(side, id) {
    const cfg = swSharedCfg(side);
    if (side === 'user') {
        const map = swGetSettings().sharedUserActiveByPersona;
        const key = swPersonaKey();
        map[key] = id || null;
        swSave();
        return;
    }
    const cid = swCurrentChatId();
    if (cid) { const m = cfg.byChat(); if (id == null) delete m[cid]; else m[cid] = id; }
    else cfg.setGlobal(id);
    swSave();
}

function swGetActiveSideOutfit(side) {
    const cfg = swSharedCfg(side);
    if (cfg.use()) {
        const id = swGetSharedActiveId(side);
        return id ? (cfg.list().find(o => o.id === id) || null) : null;
    }
    const id = swGetPersonalActiveId(side);
    return id ? (swGetPersonalList(side).find(o => o.id === id) || null) : null;
}
function swGetActiveBotOutfit()  { return swGetActiveSideOutfit('bot'); }
function swGetActiveUserOutfit() { return swGetActiveSideOutfit('user'); }

function swCurrentView() {
    const cfg = swSharedCfg(swTab);
    if (cfg.use()) {
        return {
            shared: true, side: swTab,
            list: () => cfg.list(),
            activeId: () => swGetSharedActiveId(swTab),
            setActive: (id) => { swSetSharedActiveId(swTab, id); return true; },
            find: (id) => cfg.list().find(o => o.id === id) || null,
            add: (o) => { cfg.list().push(o); swSave(); },
            remove: (id) => {
                const removed = cfg.list().find(o => o.id === id) || null;
                cfg.setList(cfg.list().filter(o => o.id !== id));
                if (cfg.global() === id) cfg.setGlobal(null);
                const m = cfg.byChat(); for (const key of Object.keys(m)) if (m[key] === id) m[key] = null;
                if (swTab === 'user') {
                    const byPersona = swGetSettings().sharedUserActiveByPersona;
                    for (const key of Object.keys(byPersona)) if (byPersona[key] === id) byPersona[key] = null;
                }
                if (removed?.srcId) {
                    const deleted = swGetSettings().sharedDeletedSourceIds[swTab];
                    if (!deleted.includes(String(removed.srcId))) deleted.push(String(removed.srcId));
                }
                swSave();
            },
        };
    }
    return {
        shared: false, side: swTab,
        list: () => swGetPersonalList(swTab),
        activeId: () => swGetPersonalActiveId(swTab),
        setActive: (id) => swSetPersonalActiveId(swTab, id),
        find: (id) => swGetPersonalList(swTab).find(o => o.id === id) || null,
        add: (o) => { swGetPersonalList(swTab).push(o); swSave(); },
        remove: (id) => {
            const list = swGetPersonalList(swTab);
            const index = list.findIndex(o => o.id === id);
            if (index >= 0) list.splice(index, 1);
            if (swGetPersonalActiveId(swTab) === id) swSetPersonalActiveId(swTab, null);
            swSave();
        },
    };
}

// ── Shared wardrobe preload ──

async function swLoadRefImageAsBase64(path) {
    try {
        const response = await fetch(path);
        if (!response.ok) return null;
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        iigLog('WARN', `swLoadRefImageAsBase64 failed: ${path}`, e.message);
        return null;
    }
}

async function swPreloadSharedActive(side) {
    try {
        const cfg = swSharedCfg(side);
        const c = swSharedCache[side];
        const id = cfg.use() ? swGetSharedActiveId(side) : null;
        if (!id) { c.b64 = null; c.id = null; return; }
        if (c.id === id && c.b64) return;
        const o = cfg.list().find(x => x.id === id);
        if (!o) { c.b64 = null; c.id = null; return; }
        let b64 = o.base64 || null;
        if (!b64 && o.imagePath) b64 = await swLoadRefImageAsBase64(o.imagePath);
        c.b64 = b64; c.id = b64 ? id : null;
    } catch (e) {
        iigLog('WARN', `preload shared active (${side}) failed:`, e.message);
        const c = swSharedCache[side]; c.b64 = null; c.id = null;
    }
}
function swPreloadAllShared() { swPreloadSharedActive('bot'); swPreloadSharedActive('user'); }

// ── Migration helpers ──

function swSharedHasSrc(side, srcId) {
    return swSharedCfg(side).list().some(x => x.srcId === srcId);
}
function swCollectPendingOutfits(side) {
    const s = swGetSettings();
    const out = [];
    const seen = new Set();
    const deleted = new Set(s.sharedDeletedSourceIds?.[side] || []);
    const collect = (o) => {
        if (!o?.id || deleted.has(String(o.id)) || seen.has(o.id) || (!o.base64 && !o.imagePath) || swSharedHasSrc(side, o.id)) return;
        out.push(o);
        seen.add(o.id);
    };
    for (const w of Object.values(s.wardrobes || {})) {
        if (!w || !Array.isArray(w[side])) continue;
        for (const o of w[side]) collect(o);
    }
    if (side === 'user') {
        for (const outfits of Object.values(s.personaWardrobes || {})) {
            if (!Array.isArray(outfits)) continue;
            for (const o of outfits) collect(o);
        }
    }
    return out;
}

const swSharedSyncPromises = { bot: null, user: null };

async function swMigrateToSharedUnlocked(side, { silent = false } = {}) {
    const s = swGetSettings();
    const cfg = swSharedCfg(side);
    const pending = swCollectPendingOutfits(side);
    if (!pending.length) {
        if (!silent) toastr.info('Все наряды уже добавлены в общий гардероб', 'Гардероб');
        return 0;
    }

    if (!silent) toastr.info(`Добавляю ${pending.length} ${swPlural(pending.length, 'наряд', 'наряда', 'нарядов')} в общий гардероб…`, 'Гардероб', { timeOut: 4000 });
    let done = 0;
    let failed = 0;
    for (const o of pending) {
        try {
            const item = {
                id: uid(), srcId: o.id, name: o.name || 'Без имени',
                description: o.description || '', type: swTypeOf(o),
                addedAt: o.addedAt || Date.now(),
            };
            if (o.tryOnSide) item.tryOnSide = o.tryOnSide;

            let stored = false;
            if (o.imagePath && !o.base64) {
                item.imagePath = o.imagePath;
                stored = true;
            } else if (o.base64) {
                try {
                    const image = await swCompressBase64Image(o.base64, s.maxDimension, 0.82);
                    item.imagePath = await swSaveRefImageToFile(image, cfg.fileLabel() + (o.name || 'item'));
                    stored = true;
                } catch (error) {
                    iigLog('WARN', 'shared wardrobe import file store failed, fallback to base64:', error.message);
                }
            }
            if (!stored) item.base64 = o.base64 || '';
            cfg.list().push(item);
            done++;
            if (done % 5 === 0) swSave();
        } catch (error) {
            failed++;
            iigLog('WARN', 'shared wardrobe import failed:', error.message);
        }
    }

    swSave();
    await swPreloadSharedActive(side);
    if (!silent) toastr.success(`Добавлено: ${done}${failed ? `, не удалось: ${failed}` : ''}. Оригиналы сохранены.`, 'Гардероб', { timeOut: 5000 });
    if (silent && failed) iigLog('WARN', `Automatic shared wardrobe sync: ${done} added, ${failed} failed`);
    return done;
}

async function swMigrateToShared(side, options = {}) {
    if (swSharedSyncPromises[side]) return swSharedSyncPromises[side];
    const promise = swMigrateToSharedUnlocked(side, options);
    swSharedSyncPromises[side] = promise;
    try { return await promise; }
    finally { swSharedSyncPromises[side] = null; }
}


async function swSaveRefImageToFile(base64, label) {
    const ctx = SillyTavern.getContext();
    const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
    const filename = `sw_${safeName}_${Date.now()}`;
    const response = await fetch('/api/images/upload', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ image: base64, format: 'png', ch_name: 'iig_refs', filename }),
    });
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    const result = await response.json();
    iigLog('INFO', `Wardrobe image saved: ${result.path}`);
    return result.path;
}

function swCompressBase64Image(base64, maxDim, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
                const s = maxDim / Math.max(w, h);
                w = Math.round(w * s); h = Math.round(h * s);
            }
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL('image/jpeg', quality).split(',')[1]);
        };
        img.onerror = () => reject(new Error('Failed to compress image'));
        img.src = 'data:image/png;base64,' + base64;
    });
}

// ── Image utilities ──

function swResize(file, maxDim) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = (e) => { const img = new Image(); img.onload = () => { let { width: w, height: h } = img; if (w > maxDim || h > maxDim) { const s = Math.min(maxDim / w, maxDim / h); w = Math.round(w * s); h = Math.round(h * s); } const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); res({ base64: c.toDataURL('image/png').split(',')[1] }); }; img.onerror = () => rej(new Error('decode')); img.src = e.target.result; };
        r.onerror = () => rej(new Error('read')); r.readAsDataURL(file);
    });
}

// ── AI describe via rakk-joppie vision.js (callVisionApi) ──

async function swAnalyzeOutfit(base64) {
    toastr.info('Анализ образа…', 'Гардероб', { timeOut: 15000 });
    try {
        const raw = await callVisionApi(base64, DEFAULT_VISION_PROMPT);
        const desc = swSanitizeDesc(raw);
        if (desc && desc.length > 10) {
            iigLog('INFO', 'Auto-described outfit:', desc.substring(0, 100));
            return desc;
        }
        iigLog('WARN', `Vision response rejected (len=${desc.length})`);
        return null;
    } catch (e) {
        iigLog('WARN', 'Vision callVisionApi failed:', e.message);
        toastr.error('Vision API: ' + e.message, 'Гардероб', { timeOut: 5000 });
        return null;
    }
}

// ══════════════════════════════════════════════════════════════
//  TRY-ON: full-body generation using rakk-joppie's providers
// ══════════════════════════════════════════════════════════════

async function swGetPersonRefB64(side) {
    if (side === 'bot') return await getCharacterAvatarBase64();
    return await getUserAvatarBase64();
}

const SW_DEFAULT_TRYON_PROMPT =
    'Virtual outfit try-on. Generate a FULL-BODY, head-to-toe image of {{name}} — the exact person from the {{personRef}} image — wearing EXACTLY the outfit from the {{outfitRef}} image.'
    + ' Keep the face, hairstyle, hair color, eye color, skin tone and body proportions identical to the person reference.'
    + ' Replace ALL of their clothing with the referenced outfit: same garments, colors, fabrics, patterns, accessories and footwear.'
    + ' CRITICAL — keep the same art style: render the result in the EXACT SAME art style, medium, line work, shading, color palette and overall aesthetic as the {{personRef}} image, as if drawn by the same artist. Do NOT switch to photography, 3D render or any different illustration style.'
    + ' Natural relaxed standing pose facing the viewer, the entire figure visible from head to shoes, simple uncluttered background that does not distract from the character.'
    + ' {{outfit}}';

const SW_DEFAULT_GENLOOK_PROMPT =
    'Virtual outfit design. Generate a FULL-BODY, head-to-toe image of {{name}} — the exact person from the {{personRef}} image — wearing a NEW outfit that matches the text description below.'
    + ' Keep the face, hairstyle, hair color, eye color, skin tone and body proportions identical to the person reference.'
    + ' Replace ALL of their clothing with the described outfit: follow the description for garments, colors, fabrics, patterns, accessories and footwear; tastefully fill in any unspecified details so the outfit looks complete and coherent.'
    + ' CRITICAL — keep the same art style: render the result in the EXACT SAME art style, medium, line work, shading, color palette and overall aesthetic as the {{personRef}} image, as if drawn by the same artist. Do NOT switch to photography, 3D render or any different illustration style.'
    + ' Natural relaxed standing pose facing the viewer, the entire figure visible from head to shoes, simple uncluttered background that does not distract from the character.'
    + ' {{outfit}}';

const SW_DEFAULT_BUILD_SLOTS = ['Причёска', 'Верх наряда', 'Низ наряда', 'Обувь', 'Аксессуары'];

function swBuildTryOnPrompt(side, outfitDesc, { fromDescription = false } = {}) {
    const ctx = SillyTavern.getContext();
    const name = side === 'bot' ? (swCharName() || 'the character') : (ctx.name1 || 'the user');
    const personRef = side === 'bot' ? 'CHARACTER REFERENCE' : 'USER REFERENCE';
    const outfitRef = side === 'bot' ? 'CHARACTER OUTFIT REFERENCE' : 'USER OUTFIT REFERENCE';
    const s = swGetSettings();
    const template = fromDescription
        ? ((s.genLookPrompt || '').trim() || SW_DEFAULT_GENLOOK_PROMPT)
        : ((s.tryOnPrompt || '').trim() || SW_DEFAULT_TRYON_PROMPT);
    const d = swSanitizeDesc(outfitDesc);
    const outfit = d ? `${fromDescription ? 'Outfit description' : 'Outfit details'}: ${d}` : '';
    return template
        .replaceAll('{{name}}', () => name)
        .replaceAll('{{personRef}}', personRef)
        .replaceAll('{{outfitRef}}', outfitRef)
        .replaceAll('{{outfit}}', () => outfit)
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function swCropGeneratedImage(base64) {
    return new Promise((resolve) => {
        const existingOverlay = document.getElementById('sw-crop-overlay');
        if (typeof existingOverlay?._swCropCancel === 'function') existingOverlay._swCropCancel();
        else existingOverlay?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'sw-crop-overlay';
        // Do not lock document.body here. Mobile Safari may clip fixed children of a
        // body with overflow:hidden, which made the cropper exist but stay invisible.
        const formBody = document.querySelector('#sw-form .sw-form-body');
        const previousFormOverflow = formBody?.style.overflow || '';
        if (formBody) formBody.style.overflow = 'hidden';
        const formOverlay = document.getElementById('sw-form-overlay');
        const formPanel = formOverlay?.querySelector('#sw-form');
        const previousPanelVisibility = formPanel?.style.visibility || '';
        if (formPanel) formPanel.style.visibility = 'hidden';
        // Keep the cropper in the same stacking context as the already visible
        // wardrobe modal. This is required by iOS/WebKit when ST itself is shown
        // inside a transformed or top-layer container.
        Object.assign(overlay.style, {
            position: 'fixed',
            inset: 'auto',
            top: '0px',
            left: '0px',
            zIndex: '2147483647',
            display: 'flex',
            visibility: 'visible',
            opacity: '1',
            pointerEvents: 'auto',
            background: '#070707',
        });
        const fitCropToViewport = () => {
            const viewport = window.visualViewport;
            const width = Math.max(viewport?.width || 0, window.innerWidth || 0, document.documentElement.clientWidth || 0);
            const height = Math.max(viewport?.height || 0, window.innerHeight || 0, document.documentElement.clientHeight || 0);
            overlay.style.width = `${Math.max(1, Math.round(width))}px`;
            overlay.style.height = `${Math.max(1, Math.round(height))}px`;
            overlay.style.maxWidth = 'none';
            overlay.style.maxHeight = 'none';
        };
        fitCropToViewport();
        window.addEventListener('resize', fitCropToViewport);
        window.visualViewport?.addEventListener('resize', fitCropToViewport);
        overlay.innerHTML = `
            <div id="sw-crop-panel" role="dialog" aria-modal="true" aria-label="Кадрирование изображения">
                <div class="sw-crop-header"><strong><i class="fa-solid fa-crop-simple"></i> Кадрирование</strong><button type="button" class="sw-crop-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button></div>
                <div class="sw-crop-stage"><div class="sw-crop-image-wrap"><img alt="Кадрируемое изображение"><div class="sw-crop-shade"></div><div class="sw-crop-box"><i data-handle="nw"></i><i data-handle="ne"></i><i data-handle="sw"></i><i data-handle="se"></i></div></div></div>
                <div class="sw-crop-ratios" aria-label="Формат кадра">
                    <button type="button" data-ratio="free" class="selected">Свободно</button>
                    <button type="button" data-ratio="1">1:1</button>
                    <button type="button" data-ratio="0.6666667">2:3</button>
                    <button type="button" data-ratio="0.75">3:4</button>
                    <button type="button" data-ratio="1.7777778">16:9</button>
                </div>
                <div class="sw-crop-actions"><button type="button" class="sw-crop-cancel">Отмена</button><button type="button" class="sw-crop-apply"><i class="fa-solid fa-check"></i> Применить</button></div>
            </div>`;
        (formOverlay || document.body).appendChild(overlay);

        const image = overlay.querySelector('.sw-crop-image-wrap img');
        const box = overlay.querySelector('.sw-crop-box');
        const openedAt = performance.now();
        // Some mobile WebViews emit a delayed synthetic click after the tap that
        // opened the cropper. It lands on the freshly mounted Cancel/background.
        const acceptsUserInput = () => performance.now() - openedAt > 700;
        let state = { x: 0, y: 0, w: 0, h: 0 };
        let lastSize = null;
        let finished = false;

        const size = () => ({ w: image.clientWidth, h: image.clientHeight });
        const draw = () => {
            box.style.left = `${state.x}px`;
            box.style.top = `${state.y}px`;
            box.style.width = `${state.w}px`;
            box.style.height = `${state.h}px`;
        };
        const initSelection = () => {
            const current = size();
            if (!current.w || !current.h) return;
            state = { x: current.w * 0.05, y: current.h * 0.05, w: current.w * 0.9, h: current.h * 0.9 };
            lastSize = current;
            draw();
        };
        const fitRatio = (ratio) => {
            const current = size();
            if (!current.w || !current.h || !Number.isFinite(ratio) || ratio <= 0) return;
            let w = current.w * 0.9;
            let h = w / ratio;
            if (h > current.h * 0.9) { h = current.h * 0.9; w = h * ratio; }
            state = { x: (current.w - w) / 2, y: (current.h - h) / 2, w, h };
            draw();
        };
        const finish = (value) => {
            if (finished) return;
            finished = true;
            resizeObserver?.disconnect();
            document.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('resize', fitCropToViewport);
            window.visualViewport?.removeEventListener('resize', fitCropToViewport);
            if (formBody?.isConnected) formBody.style.overflow = previousFormOverflow;
            if (formPanel?.isConnected) formPanel.style.visibility = previousPanelVisibility;
            overlay.remove();
            resolve(value);
        };
        const cancelFromUser = (reason) => {
            if (!acceptsUserInput()) {
                iigLog('INFO', `Wardrobe crop ignored early mobile click: ${reason}`);
                return;
            }
            iigLog('INFO', `Wardrobe crop cancelled: ${reason}`);
            finish(null);
        };
        overlay._swCropCancel = () => finish(null);
        const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopImmediatePropagation();
            finish(null);
        };
        document.addEventListener('keydown', onKeyDown, true);
        // Never let mobile synthetic events escape into #sw-form-overlay: its
        // backdrop handler would tear down this cropper and reveal the form.
        overlay.addEventListener('click', (event) => event.stopPropagation());
        overlay.addEventListener('pointerup', (event) => event.stopPropagation());
        overlay.addEventListener('touchend', (event) => event.stopPropagation(), { passive: true });
        overlay.querySelector('.sw-crop-close').addEventListener('click', () => cancelFromUser('close'));
        overlay.querySelector('.sw-crop-cancel').addEventListener('click', () => cancelFromUser('cancel'));

        for (const button of overlay.querySelectorAll('.sw-crop-ratios button')) {
            button.addEventListener('click', () => {
                if (!acceptsUserInput()) return;
                overlay.querySelectorAll('.sw-crop-ratios button').forEach((item) => item.classList.toggle('selected', item === button));
                const ratio = Number(button.dataset.ratio);
                if (Number.isFinite(ratio)) fitRatio(ratio);
            });
        }

        box.addEventListener('pointerdown', (event) => {
            if (!acceptsUserInput()) return;
            event.preventDefault(); event.stopPropagation();
            const handle = event.target?.dataset?.handle || 'move';
            const start = {
                pointerX: event.clientX,
                pointerY: event.clientY,
                boxX: state.x,
                boxY: state.y,
                boxW: state.w,
                boxH: state.h,
            };
            const minSize = 36;
            box.setPointerCapture?.(event.pointerId);
            const move = (nextEvent) => {
                const bounds = size();
                const dx = nextEvent.clientX - start.pointerX;
                const dy = nextEvent.clientY - start.pointerY;
                if (handle === 'move') {
                    state.x = Math.max(0, Math.min(bounds.w - start.boxW, start.boxX + dx));
                    state.y = Math.max(0, Math.min(bounds.h - start.boxH, start.boxY + dy));
                } else {
                    let left = start.boxX;
                    let top = start.boxY;
                    let right = start.boxX + start.boxW;
                    let bottom = start.boxY + start.boxH;
                    if (handle.includes('w')) left = Math.max(0, Math.min(right - minSize, start.boxX + dx));
                    if (handle.includes('e')) right = Math.min(bounds.w, Math.max(left + minSize, start.boxX + start.boxW + dx));
                    if (handle.includes('n')) top = Math.max(0, Math.min(bottom - minSize, start.boxY + dy));
                    if (handle.includes('s')) bottom = Math.min(bounds.h, Math.max(top + minSize, start.boxY + start.boxH + dy));
                    state = { x: left, y: top, w: right - left, h: bottom - top };
                }
                draw();
            };
            const up = () => {
                box.removeEventListener('pointermove', move);
                box.removeEventListener('pointerup', up);
                box.removeEventListener('pointercancel', up);
            };
            box.addEventListener('pointermove', move);
            box.addEventListener('pointerup', up);
            box.addEventListener('pointercancel', up);
        });

        overlay.querySelector('.sw-crop-apply').addEventListener('click', () => {
            if (!acceptsUserInput()) return;
            const current = size();
            if (!current.w || !current.h || state.w < 2 || state.h < 2) return;
            const scaleX = image.naturalWidth / current.w;
            const scaleY = image.naturalHeight / current.h;
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(state.w * scaleX));
            canvas.height = Math.max(1, Math.round(state.h * scaleY));
            canvas.getContext('2d').drawImage(
                image,
                Math.round(state.x * scaleX), Math.round(state.y * scaleY),
                Math.round(state.w * scaleX), Math.round(state.h * scaleY),
                0, 0, canvas.width, canvas.height,
            );
            finish(canvas.toDataURL('image/png').split(',')[1]);
        });

        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
            const current = size();
            if (!current.w || !current.h) return;
            if (!lastSize) { initSelection(); return; }
            state = {
                x: state.x * current.w / lastSize.w,
                y: state.y * current.h / lastSize.h,
                w: state.w * current.w / lastSize.w,
                h: state.h * current.h / lastSize.h,
            };
            lastSize = current;
            draw();
        }) : null;
        image.addEventListener('load', () => {
            initSelection();
            resizeObserver?.observe(image);
        }, { once: true });
        requestAnimationFrame(() => {
            const rect = overlay.getBoundingClientRect();
            iigLog('INFO', `Wardrobe crop overlay mounted: connected=${overlay.isConnected} size=${Math.round(rect.width)}x${Math.round(rect.height)}`);
        });
        image.src = `data:image/png;base64,${base64}`;
    });
}
async function swTryOnGenerate(side, outfitB64, outfitDesc) {
    const prompt = swBuildTryOnPrompt(side, outfitDesc, { fromDescription: !outfitB64 });
    return swGenerateWardrobeImage(side, outfitB64 ? [outfitB64] : [], prompt);
}

async function swGenerateWardrobeImage(side, extraReferences, prompt) {
    const route = swResolveGenerationRoute();
    const settings = route.settings;
    const provider = route.provider;
    if (!provider) throw new Error('Провайдер генерации не настроен');
    validateProviderSettings(settings);

    const personB64 = await swGetPersonRefB64(side);
    if (!personB64) {
        throw new Error(side === 'bot'
            ? 'Нет референса персонажа: откройте чат с персонажем или загрузите аватар'
            : 'Нет референса персоны: выберите аватар персоны в ST');
    }

    const rawReferences = [personB64, ...extraReferences.filter(Boolean)];
    const dataUrlProviders = new Set(['openrouter', 'void', 'aigate', 'naistera']);
    const references = dataUrlProviders.has(provider.id)
        ? rawReferences.map((value) => value.startsWith('data:') ? value : `data:image/png;base64,${value}`)
        : rawReferences.map((value) => value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value);

    const generated = await provider.generate({
        prompt,
        style: '',
        references,
        options: {
            aspectRatio: '2:3',
            imageSize: swGetSettings().generationImageSize || undefined,
            providerSettings: settings,
        },
    });

    let output = generated;
    if (typeof output === 'string' && /^https?:\/\//i.test(output)) output = await imageUrlToDataUrl(output);
    if (typeof output !== 'string' || !output.startsWith('data:image/')) {
        throw new Error('API вернул не картинку (примерка поддерживает только изображения)');
    }
    const png = await convertDataUrlToPng(output);
    return parseImageDataUrl(png).base64Data;
}

function swLoadBase64Image(base64) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Не удалось прочитать изображение слота'));
        img.src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
    });
}

async function swBuildReferenceSheet(slots) {
    const filled = slots.filter(slot => slot.base64);
    if (!filled.length) throw new Error('Добавьте хотя бы одну картинку в слоты');
    const columns = filled.length === 1 ? 1 : 2;
    const cellW = 560, imageH = 470, labelH = 70, gap = 18, pad = 24;
    const rows = Math.ceil(filled.length / columns);
    const canvas = document.createElement('canvas');
    canvas.width = pad * 2 + columns * cellW + (columns - 1) * gap;
    canvas.height = pad * 2 + rows * (imageH + labelH) + (rows - 1) * gap;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let index = 0; index < filled.length; index++) {
        const slot = filled[index];
        const col = index % columns, row = Math.floor(index / columns);
        const x = pad + col * (cellW + gap), y = pad + row * (imageH + labelH + gap);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, cellW, imageH + labelH);
        const img = await swLoadBase64Image(slot.base64);
        const scale = Math.min(cellW / img.width, imageH / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        ctx.drawImage(img, x + (cellW - w) / 2, y + (imageH - h) / 2, w, h);
        ctx.fillStyle = '#202020'; ctx.fillRect(x, y + imageH, cellW, labelH);
        ctx.fillStyle = '#ffffff'; ctx.font = '600 27px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const label = `${index + 1}. ${String(slot.label || 'Деталь образа').slice(0, 42)}`;
        ctx.fillText(label, x + cellW / 2, y + imageH + labelH / 2, cellW - 24);
    }
    return canvas.toDataURL('image/jpeg', 0.9);
}

async function swBuildOutfitGenerate(side, slots, extraDescription) {
    const filled = slots.filter(slot => slot.base64);
    const sheet = await swBuildReferenceSheet(filled);
    const ctx = SillyTavern.getContext();
    const name = side === 'bot' ? (swCharName() || 'the character') : (ctx.name1 || 'the user');
    const componentList = filled.map((slot, index) => `${index + 1}. ${slot.label || 'outfit component'}`).join('\n');
    const prompt = `Virtual outfit assembly and try-on. Generate a polished FULL-BODY, head-to-toe image of ${name}, preserving the exact identity, face, body proportions and art style from the first PERSON REFERENCE. The second reference is a labeled OUTFIT COMPONENT BOARD. Combine its separate references into one coherent finished look.\n\nComponents:\n${componentList}\n\nUse every supplied component in its labeled role. A hairstyle reference changes hair styling only while preserving identity and facial features. Clothing references define garments, cut, colors, fabrics and patterns. Footwear and accessories must remain clearly represented. Harmonize fit and small unspecified transitions without replacing or redesigning the referenced items. Do not reproduce the board, labels, text, borders, collage layout, extra people or mannequins. Show one person only, naturally standing, entire figure visible from hair to shoes, with a simple unobtrusive background.${extraDescription ? `\n\nAdditional direction: ${extraDescription}` : ''}`;
    return swGenerateWardrobeImage(side, [sheet], prompt);
}

async function swShrinkForStore(b64) {
    try { return await swCompressBase64Image(b64, swGetSettings().maxDimension, 0.85); }
    catch (e) { iigLog('WARN', 'try-on shrink failed, storing as is:', e.message); return b64; }
}

// ── Modal ──

export function swOpenModal() {
    swCloseModal();
    swOpen = true;
    const cn = swCharName();
    if (!cn) { toastr.warning('Выберите персонажа', 'Гардероб'); swOpen = false; return; }

    const ov = document.createElement('div'); ov.id = 'sw-modal-overlay';
    ov.addEventListener('click', (e) => { if (e.target === ov) swCloseModal(); });

    const m = document.createElement('div'); m.id = 'sw-modal';
    m.innerHTML = `
        <div class="sw-modal-header">
            <span class="sw-modal-title">Гардероб — <b>${esc(cn)}</b></span>
            <div class="sw-modal-header-btns">
                <div class="sw-header-btn sw-btn-maint" title="Управление гардеробом: распределение, дубликаты и чистка"><i class="fa-solid fa-toolbox"></i></div>
                <div class="sw-header-btn sw-btn-quick" title="Быстрые настройки"><i class="fa-solid fa-sliders"></i></div>
                <div class="sw-modal-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></div>
            </div>
        </div>
        <div class="sw-tabs">
            <div class="sw-tab ${swTab === 'bot' ? 'sw-tab-active' : ''}" data-tab="bot">Бот</div>
            <div class="sw-tab ${swTab === 'user' ? 'sw-tab-active' : ''}" data-tab="user">Юзер</div>
        </div>
        <div class="sw-active-info" id="sw-active-info"></div>
        <div class="sw-tab-content" id="sw-tab-content"></div>`;

    ov.appendChild(m);
    document.body.appendChild(ov);
    m.querySelector('.sw-modal-close').addEventListener('click', swCloseModal);
    m.querySelector('.sw-btn-quick').addEventListener('click', swOpenQuickSettings);
    m.querySelector('.sw-btn-maint').addEventListener('click', () => swOpenMaintenance('dedup'));
    for (const t of m.querySelectorAll('.sw-tab')) t.addEventListener('click', () => {
        swTab = t.dataset.tab; swFilter = 'all'; swPage = 0;
        m.querySelectorAll('.sw-tab').forEach(x => x.classList.toggle('sw-tab-active', x.dataset.tab === swTab)); swRender();
    });
    swFilter = 'all'; swPage = 0;
    swRender();
    document.addEventListener('keydown', swEsc);
}

function swEsc(e) { if (e.key === 'Escape') swCloseModal(); }
function swCloseModal() { swOpen = false; document.getElementById('sw-modal-overlay')?.remove(); document.removeEventListener('keydown', swEsc); }

// ── Render ──

function swRender() {
    const c = document.getElementById('sw-tab-content'), ib = document.getElementById('sw-active-info');
    if (!c) return;
    const v = swCurrentView();
    const outfits = v.list() || [], aid = v.activeId();

    if (ib) {
        const ao = aid ? v.find(aid) : null;
        const aoDesc = ao ? swSanitizeDesc(ao.description) : '';
        ib.innerHTML = ao ? `Активно: <b>${esc(ao.name)}</b>${aoDesc ? ` — <i>${esc(aoDesc.length > 60 ? aoDesc.slice(0, 60) + '...' : aoDesc)}</i>` : ''}` : 'Ничего не надето';
        ib.classList.toggle('sw-active-visible', !!ao);
    }

    let h = '';

    // Mode: Personal / Shared
    {
        const useShared = v.shared;
        const personalLabel = swTab === 'user' ? 'Персона' : 'Персонаж';
        const personalTitle = swTab === 'user'
            ? `Гардероб персоны ${esc(swPersonaLabel())} во всех чатах`
            : 'Гардероб текущего персонажа';
        const sortOpt = (val, label) => `<option value="${val}" ${swSort === val ? 'selected' : ''}>${label}</option>`;
        h += `<div class="sw-mode-row">
            <div class="sw-mode-btn ${!useShared ? 'sw-mode-active' : ''}" data-mode="perc" title="${personalTitle}"><i class="fa-solid fa-user"></i> ${personalLabel}</div>
            <div class="sw-mode-btn ${useShared ? 'sw-mode-active' : ''}" data-mode="shared"><i class="fa-solid fa-earth-americas"></i> Общий</div>
            <div class="sw-sort-wrap" title="Сортировка">
                <i class="fa-solid fa-arrow-down-wide-short"></i>
                <select class="sw-sort-select">${sortOpt('added', 'Недавно добавленные')}${sortOpt('worn', 'Недавно надетые')}${sortOpt('name', 'По имени')}</select>
            </div>
        </div>`;
    }

    // Type filter
    const counts = {};
    for (const o of outfits) { const t = swTypeOf(o); counts[t] = (counts[t] || 0) + 1; }
    if (swFilter !== 'all' && !counts[swFilter]) swFilter = 'all';
    h += `<div class="sw-filter-row"><div class="sw-filter-chip ${swFilter === 'all' ? 'sw-filter-active' : ''}" data-type="all">Все <span class="sw-chip-count">${outfits.length}</span></div>`;
    for (const t of swTypes()) {
        if (!counts[t.id]) continue;
        h += `<div class="sw-filter-chip ${swFilter === t.id ? 'sw-filter-active' : ''}" data-type="${t.id}"><i class="fa-solid ${t.icon}"></i> ${esc(t.label)} <span class="sw-chip-count">${counts[t.id]}</span></div>`;
    }
    h += '</div>';

    const filtered = swFilter === 'all' ? outfits : outfits.filter(o => swTypeOf(o) === swFilter);
    const shown = swSortOutfits(filtered, aid);

    // Pagination
    const totalPages = Math.max(1, Math.ceil(shown.length / SW_PAGE_SIZE));
    if (swPage > totalPages - 1) swPage = totalPages - 1;
    if (swPage < 0) swPage = 0;
    const pageItems = shown.slice(swPage * SW_PAGE_SIZE, (swPage + 1) * SW_PAGE_SIZE);

    h += '<div class="sw-outfit-grid"><div class="sw-outfit-card sw-upload-card" id="sw-upload-trigger"><div class="sw-upload-icon"><i class="fa-solid fa-plus"></i></div><span>Загрузить</span></div>'
        + '<div class="sw-outfit-card sw-upload-card" id="sw-gen-trigger" title="Сгенерировать образ по текстовому описанию (ИИ): референсом уходит только аватар"><div class="sw-upload-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></div><span>Сгенерировать</span></div>'
        + '<div class="sw-outfit-card sw-upload-card" id="sw-build-trigger" title="Собрать единый образ из нескольких референсов: причёска, верх, низ, обувь и аксессуары"><div class="sw-upload-icon"><i class="fa-solid fa-layer-group"></i></div><span>Собрать образ</span></div>';
    for (const o of pageItems) {
        const a = o.id === aid;
        const oDesc = swSanitizeDesc(o.description);
        const tm = swTypeMeta(swTypeOf(o));
        const opts = swTypes().map(t => `<option value="${t.id}" ${swTypeOf(o) === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
        const tryOnBadge = o.tryOnSide ? `<div class="sw-tryon-badge" title="Примерка на ${o.tryOnSide === 'bot' ? 'персонажа' : 'персону'}"><i class="fa-solid fa-person-rays"></i></div>` : '';
        h += `<div class="sw-outfit-card ${a ? 'sw-outfit-active' : ''}" data-id="${o.id}">
            <div class="sw-outfit-img-wrap"><img src="${esc(swImgSrc(o))}" alt="${esc(o.name)}" class="sw-outfit-img" loading="lazy">${a ? '<div class="sw-active-badge"><i class="fa-solid fa-check"></i></div>' : ''}<div class="sw-type-badge" title="${esc(tm.label)}"><i class="fa-solid ${tm.icon}"></i></div>${tryOnBadge}</div>
            <div class="sw-outfit-footer"><span class="sw-outfit-name" title="${esc(oDesc || o.name)}">${esc(o.name)}</span>
                <div class="sw-outfit-btns">
                    <div class="sw-btn-activate" title="${a ? 'Снять' : 'Надеть'}"><i class="fa-solid ${a ? 'fa-toggle-on' : 'fa-toggle-off'}"></i></div>
                    <div class="sw-btn-tryon ${o.tryOnSide ? 'sw-tryon-on' : ''}" title="${o.tryOnSide ? 'Сделать обычным нарядом' : 'Пометить как ИИ-примерку'}"><i class="fa-solid fa-person-rays"></i></div>
                    <div class="sw-btn-edit" title="Редактировать"><i class="fa-solid fa-pen"></i></div>
                    <div class="sw-btn-delete" title="Удалить"><i class="fa-solid fa-trash-can"></i></div>
                </div></div>
            <select class="sw-type-select" title="Тип одежды">${opts}</select></div>`;
    }
    h += '</div>';

    // Paginator
    if (totalPages > 1) {
        h += `<div class="sw-pager">
            <div class="sw-pager-btn ${swPage === 0 ? 'sw-pager-dim' : ''}" data-pg="prev" title="Назад"><i class="fa-solid fa-chevron-left"></i></div>
            <span class="sw-pager-info">Стр. ${swPage + 1} / ${totalPages} <small>(${shown.length})</small></span>
            <div class="sw-pager-btn ${swPage >= totalPages - 1 ? 'sw-pager-dim' : ''}" data-pg="next" title="Вперёд"><i class="fa-solid fa-chevron-right"></i></div>
        </div>`;
    }

    c.innerHTML = h;

    // Paginator events
    for (const b of c.querySelectorAll('.sw-pager-btn')) {
        b.addEventListener('click', () => {
            if (b.dataset.pg === 'prev' && swPage > 0) { swPage--; swRender(); }
            else if (b.dataset.pg === 'next' && swPage < totalPages - 1) { swPage++; swRender(); }
        });
    }

    // Mode buttons
    for (const b of c.querySelectorAll('.sw-mode-btn')) {
        b.addEventListener('click', async () => {
            const wantShared = b.dataset.mode === 'shared';
            const cfg = swSharedCfg(swTab);
            if (cfg.use() === wantShared) return;
            cfg.setUse(wantShared); swSave();
            swFilter = 'all'; swPage = 0;
            if (wantShared) await swMigrateToShared(swTab, { silent: true });
            swPreloadSharedActive(swTab);
            swRender(); swUpdatePromptInjection(); swInjectBarBtn();
            const sideName = swTab === 'bot' ? 'Бот' : 'Юзер';
            const personalMode = swTab === 'user'
                ? `гардероб персоны ${swPersonaLabel()} (во всех чатах)`
                : 'гардероб текущего персонажа';
            toastr.info(`${sideName}: ${wantShared ? 'общий гардероб (для всех персонажей)' : personalMode}`, 'Гардероб', { timeOut: 2000 });
            if (wantShared) {
                swPage = 0; swRender(); swUpdatePromptInjection(); swInjectBarBtn();
            }
        });
    }

    // Filter chips
    for (const chip of c.querySelectorAll('.sw-filter-chip')) {
        chip.addEventListener('click', () => { swFilter = chip.dataset.type; swPage = 0; swRender(); });
    }

    // Sort
    c.querySelector('.sw-sort-select')?.addEventListener('change', (e) => {
        swSort = e.target.value; swPage = 0; swRender();
    });

    document.getElementById('sw-upload-trigger')?.addEventListener('click', swUpload);
    document.getElementById('sw-gen-trigger')?.addEventListener('click', () => swOpenOutfitForm({ mode: 'gen', view: swCurrentView() }));
    document.getElementById('sw-build-trigger')?.addEventListener('click', () => swOpenOutfitForm({ mode: 'build', view: swCurrentView() }));
    for (const card of c.querySelectorAll('.sw-outfit-card[data-id]')) {
        const id = card.dataset.id;
        card.querySelector('.sw-outfit-img')?.addEventListener('click', (e) => { e.preventDefault(); e.stopImmediatePropagation(); swToggle(id); });
        card.querySelector('.sw-btn-activate')?.addEventListener('click', (e) => { e.preventDefault(); e.stopImmediatePropagation(); swToggle(id); });
        card.querySelector('.sw-btn-tryon')?.addEventListener('click', (e) => {
            e.preventDefault(); e.stopImmediatePropagation();
            const o = v.find(id); if (!o) return;
            if (o.tryOnSide) delete o.tryOnSide;
            else o.tryOnSide = v.side;
            swSave(); swRender();
        });
        card.querySelector('.sw-btn-edit')?.addEventListener('click', (e) => { e.preventDefault(); e.stopImmediatePropagation(); swEdit(id); });
        card.querySelector('.sw-btn-delete')?.addEventListener('click', (e) => {
            e.preventDefault(); e.stopImmediatePropagation();
            if (!confirm('Удалить?')) return;
            v.remove(id);
            if (v.shared) swPreloadSharedActive(v.side);
            swUpdatePromptInjection(); swInjectBarBtn(); swRender();
            toastr.info('Удалён', 'Гардероб');
        });
        card.querySelector('.sw-type-select')?.addEventListener('change', (e) => {
            e.stopImmediatePropagation();
            const o = v.find(id);
            if (o) { o.type = e.target.value; swSave(); swRender(); }
        });
    }
}

function swToggle(id) {
    const v = swCurrentView();
    const o = v.find(id), nm = o?.name || id;
    const off = v.activeId() === id;
    if (v.setActive(off ? null : id) === false) return;
    if (!off && o) { o.lastWorn = Date.now(); swSave(); }
    if (v.shared) swPreloadSharedActive(v.side);
    swRender();
    swUpdatePromptInjection();
    swInjectBarBtn();
    off ? toastr.info(`«${nm}» снят`, 'Гардероб', { timeOut: 2000 }) : toastr.success(`«${nm}» надет`, 'Гардероб', { timeOut: 2000 });
}

// ── Upload / Edit ──

async function swUpload() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.addEventListener('change', async () => {
        const f = inp.files?.[0]; if (!f) return;
        const v = swCurrentView();
        try {
            const { base64 } = await swResize(f, swGetSettings().maxDimension);
            swOpenOutfitForm({ mode: 'add', view: v, base64, defaultName: f.name.replace(/\.[^.]+$/, '') });
        } catch (e) { toastr.error('Ошибка: ' + e.message, 'Гардероб'); }
    });
    inp.click();
}

function swEdit(id) {
    const v = swCurrentView();
    const o = v.find(id); if (!o) return;
    swOpenOutfitForm({ mode: 'edit', view: v, item: o });
}

function swOpenOutfitForm({ mode, view, base64 = null, item = null, defaultName = '' }) {
    document.getElementById('sw-form-overlay')?.remove();
    const isEdit = mode === 'edit';
    const isGen = mode === 'gen';
    const isBuild = mode === 'build';
    const isGeneratedMode = isGen || isBuild;
    const buildSlots = isBuild ? SW_DEFAULT_BUILD_SLOTS.map(label => ({ id: uid(), label, base64: null, fileName: '' })) : [];
    const curType = isEdit ? swTypeOf(item) : (swTypeIds().includes(swFilter) ? swFilter : 'other');
    let previewSrc = isEdit ? swImgSrc(item) : (base64 ? 'data:image/png;base64,' + base64 : '');
    const curName = isEdit ? (item.name || '') : (defaultName || '');
    const curDesc = isEdit ? swSanitizeDesc(item.description) : '';

    const stCtx = SillyTavern.getContext();
    const charNm = swCharName() || 'персонаж';
    const userNm = stCtx.name1 || 'персона';

    const ov = document.createElement('div'); ov.id = 'sw-form-overlay';
    ov.addEventListener('click', (e) => {
        if (e.target === ov && !ov.querySelector('#sw-crop-overlay')) close();
    });
    const panel = document.createElement('div'); panel.id = 'sw-form';
    if (isBuild) panel.classList.add('sw-form-build');
    panel.innerHTML = `
        <div class="sw-form-header"><span>${isEdit ? 'Редактировать образ' : (isBuild ? 'Конструктор образа' : (isGen ? 'Образ по описанию' : 'Новый образ'))}</span><div class="sw-form-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></div></div>
        <div class="sw-form-body">
            ${isBuild ? '<div class="sw-build-intro">Добавьте референсы деталей. Название слота подскажет ИИ, какую роль играет картинка.</div><div class="sw-build-slots" id="sw-build-slots"></div><div class="sw-build-add" id="sw-build-add"><i class="fa-solid fa-plus"></i> Добавить слот</div>' : ''}
            <div class="sw-form-preview"><img src="${esc(previewSrc)}" alt="preview" ${isGeneratedMode ? 'hidden' : ''}>${isGeneratedMode ? `<div class="sw-form-preview-empty" id="sw-gen-empty"><i class="fa-solid ${isBuild ? 'fa-layer-group' : 'fa-wand-magic-sparkles'}"></i><span>${isBuild ? 'Заполните слоты и нажмите «Собрать»' : 'Опишите образ и нажмите «Сгенерировать»'}</span></div>` : ''}</div>
            <div class="sw-generated-actions" ${previewSrc ? '' : 'hidden'}>
                <button type="button" id="sw-generated-crop" title="Откадрировать текущую картинку"><i class="fa-solid fa-crop-simple"></i><span>Обрезать</span></button>
                <button type="button" id="sw-generated-download" title="Сохранить текущую картинку как PNG"><i class="fa-solid fa-download"></i><span>Сохранить изображение</span></button>
            </div>
            <div class="sw-tryon-row">
                <select class="text_pole sw-tryon-select" id="sw-tryon-target" title="${isGeneratedMode ? 'Для кого создать образ' : 'На кого примерить наряд'}">
                    <option value="bot" ${view.side === 'bot' ? 'selected' : ''}>На персонажа — ${esc(charNm)}</option>
                    <option value="user" ${view.side === 'user' ? 'selected' : ''}>На персону — ${esc(userNm)}</option>
                </select>
                <div class="sw-tryon-btn" id="sw-tryon-btn"><i class="fa-solid ${isBuild ? 'fa-layer-group' : (isGen ? 'fa-wand-magic-sparkles' : 'fa-person-rays')}"></i> ${isBuild ? 'Собрать' : (isGen ? 'Сгенерировать' : 'Примерить')}</div>
            </div>
            <div class="sw-tryon-status" id="sw-tryon-status" hidden></div>
            ${swGenerationControlsHtml('sw-form-gen')}
            <div class="sw-tryon-pick" id="sw-tryon-pick" hidden>
                <div class="sw-tryon-opt" data-pick="orig" title="Сохранить исходную картинку наряда"><img alt="оригинал"><span>Оригинал</span></div>
                <div class="sw-tryon-opt" data-pick="gen" title="Сохранить сгенерированную примерку"><img alt="примерка"><span>Примерка</span></div>
            </div>
            ${isBuild ? '<label class="sw-form-label">Сохранить итог</label><select class="text_pole sw-form-input" id="sw-build-result-kind"><option value="avatar">Как примерку / аватар (человек уже в образе)</option><option value="outfit">Как обычный наряд (референс одежды)</option></select>' : ''}
            <label class="sw-form-label">Название</label>
            <input type="text" class="text_pole sw-form-input" id="sw-form-name" value="${esc(curName)}" placeholder="Название образа">
            <label class="sw-form-label">Тип одежды</label>
            <select class="text_pole sw-form-input" id="sw-form-type">${swTypes().map(t => `<option value="${t.id}" ${curType === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
            <label class="sw-form-label">Описание <span class="sw-form-ai" id="sw-form-ai" title="Сгенерировать описание по картинке (ИИ)"><i class="fa-solid fa-wand-magic-sparkles"></i> ИИ</span></label>
            <textarea class="text_pole sw-form-textarea" id="sw-form-desc" rows="4" placeholder="${isBuild ? 'Дополнительные пожелания к итоговому образу (необязательно)…' : (isGen ? 'Опишите образ: одежда, цвета, ткани, аксессуары, обувь…' : 'Что на образе: одежда, цвета, ткани, аксессуары…')}">${esc(curDesc)}</textarea>
            <div class="sw-form-actions">
                <div class="sw-form-btn sw-form-cancel">Отмена</div>
                <div class="sw-form-btn sw-form-save">${isEdit ? 'Сохранить' : 'Добавить'}</div>
            </div>
        </div>`;
    ov.appendChild(panel); document.body.appendChild(ov);
    swBindGenerationControls(panel, 'sw-form-gen');

    function formEsc(e) { if (e.key === 'Escape' && !document.getElementById('sw-crop-overlay')) { e.stopImmediatePropagation(); close(); } }
    function close() {
        document.removeEventListener('keydown', formEsc, true);
        const cropOverlay = document.getElementById('sw-crop-overlay');
        if (typeof cropOverlay?._swCropCancel === 'function') cropOverlay._swCropCancel();
        else cropOverlay?.remove();
        ov.remove();
    }
    document.addEventListener('keydown', formEsc, true);
    panel.querySelector('.sw-form-close').addEventListener('click', close);
    panel.querySelector('.sw-form-cancel').addEventListener('click', close);

    function renderBuildSlots() {
        if (!isBuild) return;
        const container = panel.querySelector('#sw-build-slots');
        container.innerHTML = buildSlots.map((slot, index) => `
            <div class="sw-build-slot ${slot.base64 ? 'sw-build-slot-filled' : ''}" data-slot-id="${slot.id}">
                <div class="sw-build-slot-preview" title="Выбрать картинку">
                    ${slot.base64 ? `<img src="data:image/png;base64,${slot.base64}" alt="${esc(slot.label)}">` : '<i class="fa-solid fa-image"></i><span>Картинка</span>'}
                </div>
                <div class="sw-build-slot-fields">
                    <input class="text_pole sw-build-slot-label" value="${esc(slot.label)}" placeholder="Что это за часть образа?">
                    <div class="sw-build-slot-file">${esc(slot.fileName || 'Файл не выбран')}</div>
                </div>
                <div class="sw-build-slot-remove" title="Удалить слот"><i class="fa-solid fa-xmark"></i></div>
                <span class="sw-build-slot-number">${index + 1}</span>
            </div>`).join('');

        for (const row of container.querySelectorAll('.sw-build-slot')) {
            const slot = buildSlots.find(value => value.id === row.dataset.slotId);
            if (!slot) continue;
            row.querySelector('.sw-build-slot-label').addEventListener('input', event => { slot.label = event.target.value; });
            row.querySelector('.sw-build-slot-remove').addEventListener('click', () => {
                const index = buildSlots.findIndex(value => value.id === slot.id);
                if (index >= 0) buildSlots.splice(index, 1);
                renderBuildSlots();
            });
            row.querySelector('.sw-build-slot-preview').addEventListener('click', () => {
                const input = document.createElement('input');
                input.type = 'file'; input.accept = 'image/*';
                input.addEventListener('change', async () => {
                    const file = input.files?.[0]; if (!file) return;
                    try {
                        const resized = await swResize(file, 900);
                        slot.base64 = resized.base64; slot.fileName = file.name;
                        renderBuildSlots();
                    } catch (error) { toastr.error('Не удалось загрузить слот: ' + error.message, 'Конструктор образа'); }
                });
                input.click();
            });
        }
    }

    if (isBuild) {
        panel.querySelector('#sw-build-add').addEventListener('click', () => {
            buildSlots.push({ id: uid(), label: `Деталь ${buildSlots.length + 1}`, base64: null, fileName: '' });
            renderBuildSlots();
        });
        renderBuildSlots();
    }

    let origB64 = base64;
    let origChanged = false;
    async function getFormImageB64() {
        if (origB64) return origB64;
        if (item) origB64 = item.base64 || (item.imagePath ? await swLoadRefImageAsBase64(item.imagePath) : null);
        return origB64;
    }

    // AI describe
    panel.querySelector('#sw-form-ai').addEventListener('click', async () => {
        const aiBtn = panel.querySelector('#sw-form-ai');
        if (aiBtn.classList.contains('sw-form-ai-loading')) return;
        aiBtn.classList.add('sw-form-ai-loading');
        try {
            const b64 = isGeneratedMode ? genB64 : await getFormImageB64();
            if (!b64) { toastr.warning(isGeneratedMode ? 'Сначала создайте образ' : 'Нет картинки для анализа', 'Гардероб'); return; }
            const desc = await swAnalyzeOutfit(b64);
            if (desc) panel.querySelector('#sw-form-desc').value = desc;
            else toastr.warning('Не удалось получить описание', 'Гардероб');
        } catch (e) { toastr.error('Ошибка ИИ: ' + e.message, 'Гардероб'); }
        finally { aiBtn.classList.remove('sw-form-ai-loading'); }
    });

    // Try-on
    let genB64 = null;
    let picked = 'orig';
    let genSide = null;
    const previewImg = panel.querySelector('.sw-form-preview img');
    const tryBtn = panel.querySelector('#sw-tryon-btn');
    const tryStatus = panel.querySelector('#sw-tryon-status');
    const tryPick = panel.querySelector('#sw-tryon-pick');
    const generatedActions = panel.querySelector('.sw-generated-actions');

    function refreshTryOnUI() {
        tryPick.hidden = !genB64 || isGeneratedMode;
        generatedActions.hidden = !(genB64 || previewSrc);
        if (genB64) {
            if (!isGeneratedMode) tryPick.querySelector('[data-pick="orig"] img').src = previewSrc;
            tryPick.querySelector('[data-pick="gen"] img').src = 'data:image/png;base64,' + genB64;
            for (const o of tryPick.querySelectorAll('.sw-tryon-opt')) o.classList.toggle('sw-tryon-sel', o.dataset.pick === picked);
        }
        previewImg.src = (picked === 'gen' && genB64) ? ('data:image/png;base64,' + genB64) : previewSrc;
        previewImg.hidden = !previewImg.src;
        panel.querySelector('#sw-gen-empty')?.toggleAttribute('hidden', !!genB64);
    }

    for (const o of tryPick.querySelectorAll('.sw-tryon-opt')) {
        o.addEventListener('click', () => { picked = o.dataset.pick === 'gen' ? 'gen' : 'orig'; refreshTryOnUI(); });
    }

    const cropButton = panel.querySelector('#sw-generated-crop');
    const openCrop = async (event) => {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        const button = cropButton;
        if (button.disabled) return;
        button.disabled = true;
        try {
            const editingGenerated = picked === 'gen' && !!genB64;
            const currentB64 = editingGenerated ? genB64 : await getFormImageB64();
            if (!currentB64) throw new Error('нет картинки для кадрирования');
            iigLog('INFO', `Wardrobe crop opened: event=${event.type} source=${editingGenerated ? 'generated' : 'uploaded'} base64Length=${currentB64.length}`);
            const cropped = await swCropGeneratedImage(currentB64);
            if (!cropped || !document.body.contains(panel)) return;
            if (editingGenerated) {
                genB64 = cropped;
                picked = 'gen';
            } else {
                origB64 = cropped;
                origChanged = true;
                previewSrc = `data:image/png;base64,${cropped}`;
                picked = 'orig';
            }
            refreshTryOnUI();
            toastr.success('Кадрирование применено', 'Гардероб', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', 'wardrobe crop failed:', error);
            toastr.error('Не удалось обрезать изображение: ' + String(error.message || error), 'Гардероб');
        } finally {
            if (document.body.contains(panel)) button.disabled = false;
        }
    };
    // Safari/WebView must be handled on touchend. Waiting for its synthesized
    // click lets the modal/navigation layer consume the gesture first.
    cropButton.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
    cropButton.addEventListener('touchend', openCrop, { passive: false });
    cropButton.addEventListener('click', openCrop);

    panel.querySelector('#sw-generated-download').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        if (button.disabled) return;
        button.disabled = true;
        try {
            const downloadingGenerated = picked === 'gen' && !!genB64;
            const currentB64 = downloadingGenerated ? genB64 : await getFormImageB64();
            if (!currentB64) throw new Error('нет картинки для сохранения');
            iigLog('INFO', `Wardrobe image download requested: source=${downloadingGenerated ? 'generated' : 'uploaded'} base64Length=${currentB64.length}`);
            const rawName = panel.querySelector('#sw-form-name').value.trim() || (isBuild ? 'assembled-outfit' : isGen ? 'generated-outfit' : 'outfit-try-on');
            const fileName = `${rawName.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.png`;
            const downloaded = await downloadImageSrc(`data:image/png;base64,${currentB64}`, fileName);
            if (!downloaded) throw new Error('браузер не смог сохранить файл');
            toastr.success('Изображение сохранено', 'Гардероб', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', 'wardrobe result download failed:', error);
            toastr.error('Не удалось сохранить изображение: ' + String(error.message || error), 'Гардероб');
        } finally {
            if (document.body.contains(panel)) button.disabled = false;
        }
    });

    tryBtn.addEventListener('click', async () => {
        if (tryBtn.classList.contains('sw-tryon-busy')) return;
        const side = panel.querySelector('#sw-tryon-target').value === 'user' ? 'user' : 'bot';
        tryBtn.classList.add('sw-tryon-busy');
        tryBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Генерация…';
        tryStatus.hidden = false; tryStatus.textContent = 'Готовим референсы…';
        try {
            const descNow = panel.querySelector('#sw-form-desc').value.trim();
            if (isGen && !descNow) throw new Error('Сначала опишите образ');
            const srcB64 = isGeneratedMode ? null : await getFormImageB64();
            if (!isGeneratedMode && !srcB64) throw new Error('Не удалось получить картинку наряда');
            if (isBuild && !buildSlots.some(slot => slot.base64)) throw new Error('Добавьте хотя бы одну картинку в слоты');
            tryStatus.textContent = `${isBuild ? 'Сборка образа' : (isGen ? 'Генерация образа' : 'Генерация примерки')}… (обычно 15–60 секунд)`;
            const out = isBuild
                ? await swBuildOutfitGenerate(side, buildSlots, descNow)
                : await swTryOnGenerate(side, srcB64, descNow);
            if (!document.body.contains(panel)) return;
            genB64 = out; genSide = side; picked = 'gen';
            refreshTryOnUI();
            tryStatus.hidden = true;
            toastr.success(isGeneratedMode ? 'Образ готов — заполните название и сохраните его' : 'Примерка готова. Выберите картинку для сохранения', 'Гардероб', { timeOut: 4000 });
        } catch (e) {
            iigLog('ERROR', 'try-on failed:', e);
            if (document.body.contains(panel)) { tryStatus.hidden = false; tryStatus.textContent = '⚠ ' + String(e.message || e); }
            toastr.error(String(e.message || e).slice(0, 300), 'Примерка не удалась', { timeOut: 6000 });
        } finally {
            if (document.body.contains(panel)) {
                tryBtn.classList.remove('sw-tryon-busy');
                tryBtn.innerHTML = `<i class="fa-solid ${isBuild ? 'fa-layer-group' : (isGen ? 'fa-wand-magic-sparkles' : 'fa-person-rays')}"></i> ${isBuild ? 'Собрать' : (isGen ? 'Сгенерировать' : 'Примерить')}`;
            }
        }
    });

    // Save
    panel.querySelector('.sw-form-save').addEventListener('click', async () => {
        const name = panel.querySelector('#sw-form-name').value.trim();
        if (!name) { toastr.warning('Введите название', 'Гардероб'); return; }
        const type = panel.querySelector('#sw-form-type').value;
        const desc = panel.querySelector('#sw-form-desc').value.trim();
        const saveBtn = panel.querySelector('.sw-form-save');
        if (isGeneratedMode && !genB64) { toastr.warning('Сначала создайте образ', 'Гардероб'); return; }
        saveBtn.classList.add('sw-form-btn-busy'); saveBtn.textContent = 'Сохранение…';
        try {
            const useGen = picked === 'gen' && !!genB64;
            const saveAsTryOn = !isBuild || panel.querySelector('#sw-build-result-kind')?.value !== 'outfit';
            if (isEdit) {
                item.name = name; item.type = type; item.description = desc;
                const replacementB64 = useGen ? genB64 : (origChanged ? origB64 : null);
                if (replacementB64) {
                    let stored = false;
                    if (view.shared) {
                        try {
                            const jpeg = await swCompressBase64Image(replacementB64, swGetSettings().maxDimension, 0.85);
                            const prefix = view.side === 'bot' ? 'sw_bot_' : 'sw_user_';
                            item.imagePath = await swSaveRefImageToFile(jpeg, prefix + name);
                            delete item.base64;
                            stored = true;
                        } catch (err) { iigLog('WARN', 'try-on file store failed, fallback to base64:', err.message); }
                    }
                    if (!stored) { item.base64 = await swShrinkForStore(replacementB64); delete item.imagePath; }
                    if (useGen && genSide) item.tryOnSide = genSide;
                    swSharedCache[view.side].b64 = null; swSharedCache[view.side].id = null;
                }
                swSave();
                if (view.shared) swPreloadSharedActive(view.side);
            } else {
                const newItem = { id: uid(), name, type, description: desc, addedAt: Date.now() };
                const imgB64 = useGen ? genB64 : origB64;
                if (useGen && genSide && saveAsTryOn) newItem.tryOnSide = genSide;
                if (view.shared) {
                    let stored = false;
                    try {
                        const jpeg = await swCompressBase64Image(imgB64, swGetSettings().maxDimension, 0.82);
                        const prefix = view.side === 'bot' ? 'sw_bot_' : 'sw_user_';
                        newItem.imagePath = await swSaveRefImageToFile(jpeg, prefix + name);
                        stored = true;
                    } catch (err) { iigLog('WARN', 'shared file store failed, fallback to base64:', err.message); }
                    if (!stored) newItem.base64 = useGen ? await swShrinkForStore(imgB64) : imgB64;
                } else {
                    newItem.base64 = useGen ? await swShrinkForStore(imgB64) : imgB64;
                }
                view.add(newItem);
                if (view.shared) swPreloadSharedActive(view.side);
                else await swMigrateToShared(view.side, { silent: true });
                swSort = 'added'; swPage = 0;
            }
            close();
            swRender(); swUpdatePromptInjection(); swInjectBarBtn();
            toastr.success(isEdit ? 'Обновлён' : `«${name}» добавлен`, 'Гардероб', { timeOut: 2000 });
        } catch (e) {
            toastr.error('Ошибка: ' + e.message, 'Гардероб');
            saveBtn.classList.remove('sw-form-btn-busy'); saveBtn.textContent = isEdit ? 'Сохранить' : 'Добавить';
        }
    });
}

// ── Quick settings ──

function swOpenQuickSettings() {
    document.getElementById('sw-quick-overlay')?.remove();
    const ctx = SillyTavern.getContext();
    const iig = ctx.extensionSettings[MODULE_NAME];
    if (!iig) { toastr.error('Настройки расширения не готовы', 'Быстрые настройки'); return; }

    const ov = document.createElement('div'); ov.id = 'sw-quick-overlay';
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });

    const panel = document.createElement('div'); panel.id = 'sw-quick-panel';
    panel.innerHTML = `
        <div class="sw-quick-header">
            <span><i class="fa-solid fa-sliders"></i> Быстрые настройки</span>
            <div class="sw-quick-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="sw-quick-body">
            <label class="sw-quick-check">
                <input type="checkbox" id="sw-q-enabled" ${iig.enabled ? 'checked' : ''}>
                <span>Генерация включена</span>
            </label>

            <div class="sw-quick-row">
                <label>Тип API</label>
                <select id="sw-q-api-type" class="text_pole">
                    <option value="openai" ${iig.apiType === 'openai' ? 'selected' : ''}>OpenAI</option>
                    <option value="gemini" ${iig.apiType === 'gemini' ? 'selected' : ''}>Gemini / nano-banana</option>
                    <option value="custom" ${iig.apiType === 'custom' ? 'selected' : ''}>Custom (свой URL + формат)</option>
                </select>
            </div>

            <div class="sw-quick-row">
                <label>Эндпоинт</label>
                <input type="text" id="sw-q-endpoint" class="text_pole" value="${esc(iig.endpoint || '')}" placeholder="https://api.example.com">
            </div>

            <div class="sw-quick-row">
                <label>API ключ</label>
                <div class="sw-quick-key-wrap">
                    <input type="password" id="sw-q-key" class="text_pole" value="${esc(iig.apiKey || '')}">
                    <div class="sw-quick-key-toggle" title="Показать/Скрыть"><i class="fa-solid fa-eye"></i></div>
                </div>
            </div>

            <div class="sw-quick-row" id="sw-q-model-row">
                <label>Модель</label>
                <div class="sw-quick-model-wrap">
                    <select id="sw-q-model" class="text_pole">
                        ${iig.model ? `<option value="${esc(iig.model)}" selected>${esc(iig.model)}</option>` : '<option value="">-- Не выбрана --</option>'}
                    </select>
                    <div class="sw-quick-refresh" title="Обновить модели"><i class="fa-solid fa-sync"></i></div>
                </div>
            </div>

            <div class="sw-quick-tags">
                <label class="sw-quick-tags-title"><i class="fa-solid fa-tags"></i> Теги одежды</label>
                <div class="sw-tags-list" id="sw-tags-list"></div>
                <div class="sw-tags-add" id="sw-tags-add"><i class="fa-solid fa-plus"></i> Добавить тег</div>
                <div class="sw-quick-hint">«Другое» удалить нельзя — это запасной тег. При удалении тега все его наряды переносятся в «Другое».</div>
            </div>

            <div class="sw-quick-tryon">
                <label class="sw-quick-tags-title"><i class="fa-solid fa-person-rays"></i> Промт примерки <span class="sw-tryon-prompt-reset" id="sw-q-tryon-reset"><i class="fa-solid fa-rotate-left"></i> Сбросить</span></label>
                <textarea id="sw-q-tryon-prompt" class="text_pole sw-tryon-prompt-area" rows="7">${esc(swGetSettings().tryOnPrompt || SW_DEFAULT_TRYON_PROMPT)}</textarea>
                <div class="sw-quick-hint sw-tryon-prompt-hint">Плейсхолдеры: <code>{{name}}</code>, <code>{{personRef}}</code>, <code>{{outfitRef}}</code>, <code>{{outfit}}</code>.</div>
                <label class="sw-quick-tags-title" style="margin-top:10px;"><i class="fa-solid fa-wand-magic-sparkles"></i> Промт образа по описанию <span class="sw-tryon-prompt-reset" id="sw-q-genlook-reset"><i class="fa-solid fa-rotate-left"></i> Сбросить</span></label>
                <textarea id="sw-q-genlook-prompt" class="text_pole sw-tryon-prompt-area" rows="7">${esc(swGetSettings().genLookPrompt || SW_DEFAULT_GENLOOK_PROMPT)}</textarea>
                <div class="sw-quick-hint sw-tryon-prompt-hint">Образ создаётся по описанию, референсом служит аватар выбранной стороны.</div>
                <label class="sw-quick-check" style="margin-top:8px;"><input type="checkbox" id="sw-q-tryon-avatar" ${swGetSettings().tryOnAsAvatar ? 'checked' : ''}><span>Примерка → аватар-референс</span></label>
            </div>

            ${swGenerationControlsHtml('sw-quick-gen', true)}

            <div class="sw-quick-hint">Настройки сохраняются автоматически и синхронизируются с панелью расширения.</div>
        </div>`;

    ov.appendChild(panel); document.body.appendChild(ov);
    swBindGenerationControls(panel, 'sw-quick-gen');
    panel.querySelector('.sw-quick-close').addEventListener('click', () => ov.remove());

    const tagsList = panel.querySelector('#sw-tags-list');
    swRenderTagManager(tagsList);
    panel.querySelector('#sw-tags-add')?.addEventListener('click', () => {
        const s = swGetSettings();
        const tag = { id: uid(), label: 'Новый тег', icon: 'fa-tag' };
        const fb = s.outfitTypes.findIndex(t => t.id === SW_FALLBACK_TYPE);
        if (fb >= 0) s.outfitTypes.splice(fb, 0, tag); else s.outfitTypes.push(tag);
        swSave();
        swRenderTagManager(tagsList);
        if (swOpen) swRender();
        tagsList.querySelector(`.sw-tag-row[data-id="${tag.id}"] .sw-tag-name`)?.focus();
    });

    const bindPrompt = (areaId, resetId, key, fallback, message) => {
        const area = panel.querySelector(areaId);
        area?.addEventListener('input', () => {
            const value = area.value;
            swGetSettings()[key] = value.trim() && value.trim() !== fallback.trim() ? value : '';
            swSave();
        });
        panel.querySelector(resetId)?.addEventListener('click', () => {
            swGetSettings()[key] = ''; swSave();
            if (area) area.value = fallback;
            toastr.info(message, 'Гардероб', { timeOut: 2000 });
        });
    };
    bindPrompt('#sw-q-tryon-prompt', '#sw-q-tryon-reset', 'tryOnPrompt', SW_DEFAULT_TRYON_PROMPT, 'Промт примерки сброшен');
    bindPrompt('#sw-q-genlook-prompt', '#sw-q-genlook-reset', 'genLookPrompt', SW_DEFAULT_GENLOOK_PROMPT, 'Промт образа сброшен');
    panel.querySelector('#sw-q-tryon-avatar')?.addEventListener('change', (e) => {
        swGetSettings().tryOnAsAvatar = e.target.checked; swSave();
    });

    const save = () => ctx.saveSettingsDebounced();
    const syncMain = (id, value, isCheck = false) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (isCheck) el.checked = !!value;
        else el.value = value;
        try { el.dispatchEvent(new Event(isCheck ? 'change' : 'input', { bubbles: true })); } catch(e) {}
    };

    panel.querySelector('#sw-q-enabled').addEventListener('change', (e) => {
        iig.enabled = e.target.checked; save();
        syncMain('iig_enabled', iig.enabled, true);
    });
    panel.querySelector('#sw-q-api-type').addEventListener('change', (e) => {
        iig.apiType = e.target.value; save();
        syncMain('iig_api_type', iig.apiType);
    });
    panel.querySelector('#sw-q-endpoint').addEventListener('input', (e) => {
        iig.endpoint = e.target.value; save();
        syncMain('iig_endpoint', iig.endpoint);
    });
    panel.querySelector('#sw-q-key').addEventListener('input', (e) => {
        iig.apiKey = e.target.value; save();
        syncMain('iig_api_key', iig.apiKey);
    });
    panel.querySelector('.sw-quick-key-toggle').addEventListener('click', () => {
        const inp = panel.querySelector('#sw-q-key');
        const icon = panel.querySelector('.sw-quick-key-toggle i');
        if (inp.type === 'password') { inp.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { inp.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });
    panel.querySelector('#sw-q-model').addEventListener('change', (e) => {
        iig.model = e.target.value; save();
        syncMain('iig_model', iig.model);
    });

    // Refresh models
    panel.querySelector('.sw-quick-refresh').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        try {
            const provider = resolveActiveProvider(getSettings());
            if (!provider) throw new Error('Провайдер не выбран');
            const models = await provider.fetchModels();
            const select = panel.querySelector('#sw-q-model');
            const cur = iig.model;
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === cur;
                select.appendChild(opt);
            }
            toastr.success(`Найдено моделей: ${models.length}`, 'Быстрые настройки');
        } catch (err) {
            toastr.error('Ошибка: ' + err.message, 'Быстрые настройки');
        } finally { btn.classList.remove('loading'); }
    });
}

// ── Maintenance ──

function swCollectReferencedFiles() {
    const ctx = SillyTavern.getContext();
    const referenced = new Set();
    let dir = '/user/images/iig_refs/';
    const addRef = (p) => {
        if (!p || typeof p !== 'string') return;
        const i = p.lastIndexOf('/');
        const base = i >= 0 ? p.slice(i + 1) : p;
        if (base) referenced.add(base);
        if (i > 0 && p.includes('iig_refs')) dir = p.slice(0, i + 1);
    };
    const sw = ctx.extensionSettings?.[SW];
    if (sw) {
        for (const o of (sw.sharedUserWardrobe || [])) addRef(o.imagePath);
        for (const o of (sw.sharedBotWardrobe || [])) addRef(o.imagePath);
        for (const w of Object.values(sw.wardrobes || {})) {
            if (!w) continue;
            for (const side of ['bot', 'user']) for (const o of (w[side] || [])) addRef(o.imagePath);
        }
        for (const outfits of Object.values(sw.personaWardrobes || {})) {
            for (const o of (outfits || [])) addRef(o.imagePath);
        }
    }

    const iig = ctx.extensionSettings?.[MODULE_NAME];
    if (iig) {
        addRef(iig.charRef?.imagePath);
        addRef(iig.userRef?.imagePath);
        for (const n of (iig.npcReferences || [])) addRef(n?.imagePath);
    }
    return { referenced, dir };
}

async function swScanOrphans() {
    const ctx = SillyTavern.getContext();
    const { referenced, dir } = swCollectReferencedFiles();
    const resp = await fetch('/api/images/list', {
        method: 'POST',
        headers: ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: 'iig_refs', sortField: 'date', sortOrder: 'desc' }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const files = await resp.json();
    const list = Array.isArray(files) ? files.filter(f => typeof f === 'string') : [];
    const orphans = list.filter(f => !referenced.has(f));
    return { orphans, totalFiles: list.length, referencedCount: referenced.size, dir };
}

async function swDeleteFiles(dir, filenames) {
    const ctx = SillyTavern.getContext();
    let ok = 0, fail = 0;
    for (const f of filenames) {
        try {
            const r = await fetch('/api/images/delete', {
                method: 'POST',
                headers: ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: dir + f }),
            });
            if (r.ok) ok++; else fail++;
        } catch (e) { fail++; iigLog('WARN', 'delete file failed:', f, e.message); }
    }
    return { ok, fail };
}

function swMaintenanceOwners() {
    const ctx = SillyTavern.getContext();
    const settings = swGetSettings();
    const owners = [];
    const add = (owner) => { if (!owners.some(item => item.key === owner.key)) owners.push(owner); };

    add({
        key: 'shared:bot', kind: 'shared', side: 'bot', name: 'Общий для ботов',
        label: 'Общий гардероб ботов', detail: 'Все карточки персонажей', avatarUrl: '',
        list: () => settings.sharedBotWardrobe,
        clearActive(ids) {
            if (ids.has(settings.sharedBotActive)) settings.sharedBotActive = null;
            for (const map of [settings.sharedBotActiveByChat]) {
                for (const key of Object.keys(map || {})) if (ids.has(map[key])) map[key] = null;
            }
        },
    });
    add({
        key: 'shared:user', kind: 'shared', side: 'user', name: 'Общий для персон',
        label: 'Общий гардероб персон', detail: 'Все пользовательские персоны', avatarUrl: '',
        list: () => settings.sharedUserWardrobe,
        clearActive(ids) {
            if (ids.has(settings.sharedUserActive)) settings.sharedUserActive = null;
            for (const map of [settings.sharedUserActiveByChat, settings.sharedUserActiveByPersona]) {
                for (const key of Object.keys(map || {})) if (ids.has(map[key])) map[key] = null;
            }
        },
    });

    const characterNames = new Set([
        ...Object.keys(settings.wardrobes || {}),
        ...(Array.isArray(ctx.characters) ? ctx.characters.map(character => String(character?.name || '').trim()) : []),
    ]);
    for (const name of [...characterNames].filter(Boolean).sort((a, b) => a.localeCompare(b))) {
        const character = Array.isArray(ctx.characters) ? ctx.characters.find(item => String(item?.name || '').trim() === name) : null;
        const avatarUrl = character?.avatar ? `/characters/${encodeURIComponent(character.avatar)}` : '';
        add({
            key: `character:${name}`, kind: 'character', side: 'bot', name,
            label: `Бот — ${name}`, detail: name === swCharName() ? 'Активная карточка персонажа' : 'Карточка персонажа', avatarUrl,
            list() {
                if (!settings.wardrobes[name]) settings.wardrobes[name] = { bot: [], user: [] };
                if (!Array.isArray(settings.wardrobes[name].bot)) settings.wardrobes[name].bot = [];
                return settings.wardrobes[name].bot;
            },
            clearActive(ids) {
                if (settings.activeOutfits?.[name] && ids.has(settings.activeOutfits[name].bot)) settings.activeOutfits[name].bot = null;
            },
        });
    }

    const personas = ctx.powerUserSettings?.personas || {};
    const personaKeys = new Set([
        ...Object.keys(settings.personaWardrobes || {}),
        ...Object.keys(personas).map(avatar => `persona:${avatar}`),
    ]);
    for (const key of [...personaKeys].filter(value => value.startsWith('persona:')).sort((a, b) => a.localeCompare(b))) {
        const avatar = key.slice('persona:'.length);
        const fallback = avatar.startsWith('name:') ? avatar.slice(5) : avatar.replace(/\.[^.]+$/, '');
        const name = String(personas[avatar] || fallback || 'Persona');
        add({
            key, kind: 'persona', side: 'user', name,
            label: `Персона — ${name}`,
            detail: `${key === swPersonaKey() ? 'Активная персона · ' : ''}${avatar.startsWith('name:') ? avatar.slice(5) : avatar}`,
            avatarUrl: avatar.startsWith('name:') ? '' : `/User Avatars/${encodeURIComponent(avatar)}`,
            list() {
                if (!Array.isArray(settings.personaWardrobes[key])) settings.personaWardrobes[key] = [];
                return settings.personaWardrobes[key];
            },
            clearActive(ids) {
                if (ids.has(settings.personaActiveOutfits?.[key])) settings.personaActiveOutfits[key] = null;
            },
        });
    }
    return owners;
}

function swRenderDistributionLegacy(body) {
    const owners = swMaintenanceOwners();
    let sourceKey = owners.find(owner => owner.list().length)?.key || owners[0]?.key || '';
    let targetKind = 'all';
    let targetQuery = '';
    const selectedOutfits = new Set();
    const selectedTargets = new Set();

    const source = () => owners.find(owner => owner.key === sourceKey) || owners[0];
    const filteredTargets = () => {
        const query = targetQuery.trim().toLocaleLowerCase();
        return owners.filter(owner => {
            if (owner.key === sourceKey) return false;
            if (targetKind !== 'all' && owner.kind !== targetKind) return false;
            if (!query) return true;
            return `${owner.name || ''} ${owner.label || ''} ${owner.detail || ''}`.toLocaleLowerCase().includes(query);
        });
    };
    const sourceOptions = () => {
        const groups = [
            ['shared', 'Общие гардеробы'],
            ['character', 'Боты / карточки персонажей'],
            ['persona', 'Персоны'],
        ];
        return groups.map(([kind, label]) => {
            const items = owners.filter(owner => owner.kind === kind);
            if (!items.length) return '';
            return `<optgroup label="${label}">${items.map(owner => `<option value="${esc(owner.key)}" ${owner.key === sourceKey ? 'selected' : ''}>${esc(owner.name || owner.label)} — ${esc(owner.detail || owner.label)} (${owner.list().length})</option>`).join('')}</optgroup>`;
        }).join('');
    };
    const targetCard = (owner) => {
        const icon = owner.kind === 'persona' ? 'fa-user' : owner.kind === 'character' ? 'fa-address-card' : 'fa-box-archive';
        return `<label class="sw-distribute-target" title="${esc(owner.label)}">
            <input type="checkbox" value="${esc(owner.key)}" ${selectedTargets.has(owner.key) ? 'checked' : ''}>
            <span class="sw-dist-target-card">
                <span class="sw-dist-avatar"><i class="fa-solid ${icon}"></i>${owner.avatarUrl ? `<img src="${esc(owner.avatarUrl)}" loading="lazy" alt="" onerror="this.remove()">` : ''}</span>
                <span class="sw-dist-target-meta"><b>${esc(owner.name || owner.label)}</b><small>${esc(owner.detail || owner.label)} · ${owner.list().length} ${swPlural(owner.list().length, 'наряд', 'наряда', 'нарядов')}</small></span>
                <i class="fa-solid fa-check sw-dist-target-check"></i>
            </span>
        </label>`;
    };
    const render = () => {
        const current = source();
        const outfits = current?.list() || [];
        for (const id of [...selectedOutfits]) if (!outfits.some(outfit => outfit?.id === id)) selectedOutfits.delete(id);
        selectedTargets.delete(sourceKey);
        const visibleTargets = filteredTargets();
        body.innerHTML = `<div class="sw-distribute">
            <section class="sw-dist-section">
                <div class="sw-dist-heading"><span>1</span><div><b>Откуда взять</b><small>Выбери гардероб и наряды</small></div></div>
                <select class="text_pole sw-distribute-source">${sourceOptions()}</select>
                <div class="sw-cleanup-tools"><span class="sw-cleanup-link sw-dist-all">Выбрать все</span><span class="sw-cleanup-link sw-dist-none">Снять выбор</span><span class="sw-distribute-count">${selectedOutfits.size} из ${outfits.length}</span></div>
                ${outfits.length ? `<div class="sw-distribute-outfits">${outfits.map(outfit => `<button type="button" class="sw-distribute-outfit ${selectedOutfits.has(outfit.id) ? 'sw-dist-selected' : ''}" data-outfit="${esc(outfit.id)}" title="${esc(outfit.name || 'Без названия')}"><img src="${esc(swImgSrc(outfit))}" loading="lazy"><span>${esc(outfit.name || 'Без названия')}</span><i class="fa-solid fa-check"></i></button>`).join('')}</div>` : '<div class="sw-cleanup-empty">В этом гардеробе пока нет нарядов.</div>'}
            </section>
            <section class="sw-dist-section sw-dist-recipients">
                <div class="sw-dist-heading"><span>2</span><div><b>Куда отправить</b><small>Можно выбрать несколько ботов и персон</small></div></div>
                <div class="sw-dist-filterbar">
                    <div class="sw-dist-kind-tabs">
                        <button type="button" data-kind="all" class="${targetKind === 'all' ? 'active' : ''}">Все</button>
                        <button type="button" data-kind="character" class="${targetKind === 'character' ? 'active' : ''}">Боты</button>
                        <button type="button" data-kind="persona" class="${targetKind === 'persona' ? 'active' : ''}">Персоны</button>
                        <button type="button" data-kind="shared" class="${targetKind === 'shared' ? 'active' : ''}">Общие</button>
                    </div>
                    <label class="sw-dist-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" class="text_pole" value="${esc(targetQuery)}" placeholder="Найти получателя"></label>
                </div>
                <div class="sw-cleanup-tools"><span class="sw-cleanup-link sw-target-all">Выбрать показанных</span><span class="sw-cleanup-link sw-target-none">Очистить выбор</span><span class="sw-distribute-count">Выбрано: ${selectedTargets.size}</span></div>
                <div class="sw-distribute-targets">${visibleTargets.length ? visibleTargets.map(targetCard).join('') : '<div class="sw-dist-no-targets">Ничего не найдено</div>'}</div>
            </section>
            <div class="sw-distribute-actions">
                <div class="sw-dist-action-summary"><b>${selectedOutfits.size} ${swPlural(selectedOutfits.size, 'наряд', 'наряда', 'нарядов')}</b><i class="fa-solid fa-arrow-right"></i><b>${selectedTargets.size} ${swPlural(selectedTargets.size, 'получатель', 'получателя', 'получателей')}</b></div>
                <button type="button" class="menu_button sw-dist-copy" ${!selectedOutfits.size || !selectedTargets.size ? 'disabled' : ''}><i class="fa-solid fa-copy"></i><span>Копировать</span></button>
                <button type="button" class="menu_button sw-dist-move" ${!selectedOutfits.size || !selectedTargets.size ? 'disabled' : ''}><i class="fa-solid fa-arrow-right-arrow-left"></i><span>Перенести</span></button>
            </div>
        </div>`;

        body.querySelector('.sw-distribute-source')?.addEventListener('change', event => { sourceKey = event.target.value; selectedOutfits.clear(); render(); });
        body.querySelector('.sw-dist-all')?.addEventListener('click', () => { for (const outfit of outfits) if (outfit?.id) selectedOutfits.add(outfit.id); render(); });
        body.querySelector('.sw-dist-none')?.addEventListener('click', () => { selectedOutfits.clear(); render(); });
        for (const card of body.querySelectorAll('.sw-distribute-outfit')) card.addEventListener('click', () => {
            const id = card.dataset.outfit;
            selectedOutfits.has(id) ? selectedOutfits.delete(id) : selectedOutfits.add(id);
            render();
        });
        const syncTargets = () => {
            for (const input of body.querySelectorAll('.sw-distribute-target input')) {
                input.checked ? selectedTargets.add(input.value) : selectedTargets.delete(input.value);
            }
            const count = body.querySelector('.sw-dist-recipients .sw-distribute-count');
            if (count) count.textContent = `Выбрано: ${selectedTargets.size}`;
            const summary = body.querySelector('.sw-dist-action-summary');
            if (summary) summary.innerHTML = `<b>${selectedOutfits.size} ${swPlural(selectedOutfits.size, 'наряд', 'наряда', 'нарядов')}</b><i class="fa-solid fa-arrow-right"></i><b>${selectedTargets.size} ${swPlural(selectedTargets.size, 'получатель', 'получателя', 'получателей')}</b>`;
            for (const button of body.querySelectorAll('.sw-dist-copy, .sw-dist-move')) button.disabled = !selectedOutfits.size || !selectedTargets.size;
        };
        for (const input of body.querySelectorAll('.sw-distribute-target input')) input.addEventListener('change', syncTargets);
        for (const tab of body.querySelectorAll('.sw-dist-kind-tabs button')) tab.addEventListener('click', () => { targetKind = tab.dataset.kind; render(); });
        body.querySelector('.sw-dist-search input')?.addEventListener('input', event => {
            targetQuery = event.target.value;
            render();
            const search = body.querySelector('.sw-dist-search input');
            search?.focus(); search?.setSelectionRange(targetQuery.length, targetQuery.length);
        });
        body.querySelector('.sw-target-all')?.addEventListener('click', () => { for (const owner of visibleTargets) selectedTargets.add(owner.key); render(); });
        body.querySelector('.sw-target-none')?.addEventListener('click', () => { selectedTargets.clear(); render(); });

        const distribute = (move) => {
            const targets = owners.filter(owner => selectedTargets.has(owner.key) && owner.key !== sourceKey);
            const picked = outfits.filter(outfit => selectedOutfits.has(outfit?.id));
            if (!picked.length) { toastr.info('Выберите хотя бы один наряд', 'Обслуживание гардероба'); return; }
            if (!targets.length) { toastr.info('Выберите хотя бы одного получателя', 'Обслуживание гардероба'); return; }
            if (move && !confirm(`Перенести ${picked.length} ${swPlural(picked.length, 'наряд', 'наряда', 'нарядов')} в ${targets.length} ${swPlural(targets.length, 'гардероб', 'гардероба', 'гардеробов')}?`)) return;

            const now = Date.now();
            for (const target of targets) {
                const targetList = target.list();
                for (const outfit of picked) {
                    const clone = structuredClone(outfit);
                    clone.id = uid();
                    clone.addedAt = now;
                    delete clone.lastWorn;
                    targetList.push(clone);
                }
            }
            if (move) {
                const movedIds = new Set(picked.map(outfit => outfit.id));
                const currentList = current.list();
                currentList.splice(0, currentList.length, ...currentList.filter(outfit => !movedIds.has(outfit?.id)));
                current.clearActive(movedIds);
                selectedOutfits.clear();
            }
            swSave();
            swUpdatePromptInjection();
            if (swOpen) swRender();
            toastr.success(`${move ? 'Перенесено' : 'Скопировано'}: ${picked.length} × ${targets.length}`, 'Обслуживание гардероба');
            render();
        };
        body.querySelector('.sw-dist-copy')?.addEventListener('click', () => distribute(false));
        body.querySelector('.sw-dist-move')?.addEventListener('click', () => distribute(true));
    };
    render();
}

function swRenderDistribution(body) {
    const owners = swMaintenanceOwners();
    let sourceKey = owners.find(owner => owner.list().length)?.key || owners[0]?.key || '';
    let sourcePage = 0;
    let targetKind = 'all';
    let targetQuery = '';
    const selectedOutfits = new Set();
    const selectedTargets = new Set();
    const source = () => owners.find(owner => owner.key === sourceKey) || owners[0];

    const groupedOptions = ({ targets = false } = {}) => [
        ['shared', 'Общие гардеробы'],
        ['character', 'Боты / карточки персонажей'],
        ['persona', 'Персоны'],
    ].map(([kind, label]) => {
        const items = owners.filter(owner => owner.kind === kind
            && (!targets || (owner.key !== sourceKey && !selectedTargets.has(owner.key))));
        if (!items.length) return '';
        return `<optgroup label="${label}">${items.map(owner => `<option value="${esc(owner.key)}" ${!targets && owner.key === sourceKey ? 'selected' : ''}>${esc(owner.name || owner.label)} — ${esc(owner.detail || owner.label)} (${owner.list().length})</option>`).join('')}</optgroup>`;
    }).join('');

    const render = () => {
        const current = source();
        const outfits = current?.list() || [];
        const pageSize = 6;
        const totalPages = Math.max(1, Math.ceil(outfits.length / pageSize));
        sourcePage = Math.max(0, Math.min(sourcePage, totalPages - 1));
        const pageOutfits = outfits.slice(sourcePage * pageSize, sourcePage * pageSize + pageSize);
        const pageButtons = Array.from({ length: totalPages }, (_, index) => index)
            .filter(index => totalPages <= 7 || index === 0 || index === totalPages - 1 || Math.abs(index - sourcePage) <= 2);
        const pageNav = [];
        let previousPage = -1;
        for (const page of pageButtons) {
            if (page - previousPage > 1) pageNav.push('<span class="sw-dist-page-gap">…</span>');
            pageNav.push(`<button type="button" class="sw-dist-page-number ${page === sourcePage ? 'active' : ''}" data-page="${page}">${page + 1}</button>`);
            previousPage = page;
        }
        for (const id of [...selectedOutfits]) if (!outfits.some(outfit => outfit?.id === id)) selectedOutfits.delete(id);
        selectedTargets.delete(sourceKey);
        const selectedOwners = owners.filter(owner => selectedTargets.has(owner.key));
        const selectableBots = owners.filter(owner => owner.kind === 'character' && owner.key !== sourceKey);
        const selectablePersonas = owners.filter(owner => owner.kind === 'persona' && owner.key !== sourceKey);
        const allBotsSelected = selectableBots.length > 0 && selectableBots.every(owner => selectedTargets.has(owner.key));
        const allPersonasSelected = selectablePersonas.length > 0 && selectablePersonas.every(owner => selectedTargets.has(owner.key));
        const compactOwners = selectedOwners.filter(owner => !(allBotsSelected && owner.kind === 'character') && !(allPersonasSelected && owner.kind === 'persona'));
        const chipParts = [];
        if (allBotsSelected) chipParts.push(`<button type="button" class="sw-dist-target-chip sw-dist-target-group" data-group="character"><span>Все боты</span><small>${selectableBots.length}</small><i class="fa-solid fa-xmark"></i></button>`);
        if (allPersonasSelected) chipParts.push(`<button type="button" class="sw-dist-target-chip sw-dist-target-group" data-group="persona"><span>Все персоны</span><small>${selectablePersonas.length}</small><i class="fa-solid fa-xmark"></i></button>`);
        chipParts.push(...compactOwners.slice(0, 10).map(owner => `<button type="button" class="sw-dist-target-chip" data-owner="${esc(owner.key)}"><span>${esc(owner.name || owner.label)}</span><small>${owner.kind === 'character' ? 'бот' : owner.kind === 'persona' ? 'персона' : 'общий'}</small><i class="fa-solid fa-xmark"></i></button>`));
        if (compactOwners.length > 10) chipParts.push(`<span class="sw-dist-target-more">+ ещё ${compactOwners.length - 10}</span>`);

        body.innerHTML = `<div class="sw-distribute sw-distribute-compact">
            <section class="sw-dist-section">
                <div class="sw-dist-heading"><span>1</span><div><b>Откуда взять</b><small>Выбери гардероб и наряды</small></div></div>
                <select class="text_pole sw-distribute-source">${groupedOptions()}</select>
                <div class="sw-cleanup-tools"><span class="sw-cleanup-link sw-dist-page-all">Выбрать страницу</span><span class="sw-cleanup-link sw-dist-all">Выбрать все</span><span class="sw-cleanup-link sw-dist-none">Снять выбор</span><span class="sw-distribute-count">${selectedOutfits.size} из ${outfits.length}</span></div>
                ${outfits.length ? `<div class="sw-distribute-outfits sw-distribute-outfits-paged">${pageOutfits.map(outfit => `<button type="button" class="sw-distribute-outfit ${selectedOutfits.has(outfit.id) ? 'sw-dist-selected' : ''}" data-outfit="${esc(outfit.id)}" title="${esc(outfit.name || 'Без названия')}"><img src="${esc(swImgSrc(outfit))}" loading="lazy"><span>${esc(outfit.name || 'Без названия')}</span><i class="fa-solid fa-check"></i></button>`).join('')}</div><div class="sw-dist-pagination"><button type="button" class="sw-dist-page-arrow" data-page="${sourcePage - 1}" ${sourcePage === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>${pageNav.join('')}<button type="button" class="sw-dist-page-arrow" data-page="${sourcePage + 1}" ${sourcePage >= totalPages - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button></div>` : '<div class="sw-cleanup-empty">В этом гардеробе пока нет нарядов.</div>'}
            </section>
            <section class="sw-dist-section">
                <div class="sw-dist-heading"><span>2</span><div><b>Куда отправить</b><small>Добавь одного или несколько получателей</small></div></div>
                <div class="sw-dist-target-search"><div class="sw-dist-kind-tabs"><button type="button" data-kind="all" class="${targetKind === 'all' ? 'active' : ''}">Все</button><button type="button" data-kind="character" class="${targetKind === 'character' ? 'active' : ''}">Боты</button><button type="button" data-kind="persona" class="${targetKind === 'persona' ? 'active' : ''}">Персоны</button><button type="button" data-kind="shared" class="${targetKind === 'shared' ? 'active' : ''}">Общие</button></div><label class="sw-dist-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" class="text_pole" value="${esc(targetQuery)}" placeholder="Начни вводить имя"></label><div class="sw-dist-search-results"></div></div>
                <div class="sw-cleanup-tools"><span class="sw-cleanup-link sw-target-bots">Добавить всех ботов</span><span class="sw-cleanup-link sw-target-personas">Добавить все персоны</span><span class="sw-cleanup-link sw-target-none">Очистить</span><span class="sw-distribute-count">Выбрано: ${selectedTargets.size}</span></div>
                <div class="sw-dist-selected-targets">${chipParts.length ? chipParts.join('') : '<span class="sw-dist-target-empty">Получатели пока не выбраны</span>'}</div>
            </section>
            <div class="sw-distribute-actions">
                <div class="sw-dist-action-summary"><b>${selectedOutfits.size} ${swPlural(selectedOutfits.size, 'наряд', 'наряда', 'нарядов')}</b><i class="fa-solid fa-arrow-right"></i><b>${selectedTargets.size} ${swPlural(selectedTargets.size, 'получатель', 'получателя', 'получателей')}</b></div>
                <button type="button" class="menu_button sw-dist-copy" ${!selectedOutfits.size || !selectedTargets.size ? 'disabled' : ''}><i class="fa-solid fa-copy"></i><span>Копировать</span></button>
                <button type="button" class="menu_button sw-dist-move" ${!selectedOutfits.size || !selectedTargets.size ? 'disabled' : ''}><i class="fa-solid fa-arrow-right-arrow-left"></i><span>Перенести</span></button>
            </div>
        </div>`;

        body.querySelector('.sw-distribute-source')?.addEventListener('change', event => { sourceKey = event.target.value; sourcePage = 0; selectedOutfits.clear(); render(); });
        body.querySelector('.sw-dist-page-all')?.addEventListener('click', () => { for (const outfit of pageOutfits) if (outfit?.id) selectedOutfits.add(outfit.id); render(); });
        body.querySelector('.sw-dist-all')?.addEventListener('click', () => { for (const outfit of outfits) if (outfit?.id) selectedOutfits.add(outfit.id); render(); });
        body.querySelector('.sw-dist-none')?.addEventListener('click', () => { selectedOutfits.clear(); render(); });
        for (const button of body.querySelectorAll('.sw-dist-page-number, .sw-dist-page-arrow')) button.addEventListener('click', () => { const page = Number(button.dataset.page); if (Number.isInteger(page) && page >= 0 && page < totalPages) { sourcePage = page; render(); } });
        for (const card of body.querySelectorAll('.sw-distribute-outfit')) card.addEventListener('click', () => { selectedOutfits.has(card.dataset.outfit) ? selectedOutfits.delete(card.dataset.outfit) : selectedOutfits.add(card.dataset.outfit); render(); });
        const paintTargetResults = () => {
            const resultBox = body.querySelector('.sw-dist-search-results');
            if (!resultBox) return;
            const query = targetQuery.trim().toLocaleLowerCase();
            const matches = owners.filter(owner => owner.key !== sourceKey
                && !selectedTargets.has(owner.key)
                && (targetKind === 'all' || owner.kind === targetKind)
                && (!query || `${owner.name || ''} ${owner.label || ''} ${owner.detail || ''}`.toLocaleLowerCase().includes(query)))
                .slice(0, 10);
            resultBox.innerHTML = matches.length ? matches.map(owner => `<button type="button" class="sw-dist-search-result" data-owner="${esc(owner.key)}"><span class="sw-dist-avatar"><i class="fa-solid ${owner.kind === 'persona' ? 'fa-user' : owner.kind === 'character' ? 'fa-address-card' : 'fa-box-archive'}"></i>${owner.avatarUrl ? `<img src="${esc(owner.avatarUrl)}" loading="lazy" alt="" onerror="this.remove()">` : ''}</span><span><b>${esc(owner.name || owner.label)}</b><small>${esc(owner.detail || owner.label)}</small></span><i class="fa-solid fa-plus"></i></button>`).join('') : '<span class="sw-dist-search-empty">Ничего не найдено</span>';
            for (const result of resultBox.querySelectorAll('.sw-dist-search-result')) result.addEventListener('click', () => { selectedTargets.add(result.dataset.owner); targetQuery = ''; render(); });
        };
        const searchInput = body.querySelector('.sw-dist-search input');
        searchInput?.addEventListener('input', () => { targetQuery = searchInput.value; paintTargetResults(); });
        searchInput?.addEventListener('focus', paintTargetResults);
        for (const tab of body.querySelectorAll('.sw-dist-kind-tabs button')) tab.addEventListener('click', () => { targetKind = tab.dataset.kind; for (const item of body.querySelectorAll('.sw-dist-kind-tabs button')) item.classList.toggle('active', item === tab); paintTargetResults(); });
        for (const chip of body.querySelectorAll('.sw-dist-target-chip:not(.sw-dist-target-group)')) chip.addEventListener('click', () => { selectedTargets.delete(chip.dataset.owner); render(); });
        for (const chip of body.querySelectorAll('.sw-dist-target-group')) chip.addEventListener('click', () => { for (const owner of owners) if (owner.kind === chip.dataset.group) selectedTargets.delete(owner.key); render(); });
        body.querySelector('.sw-target-bots')?.addEventListener('click', () => { if (selectableBots.length > 20 && !confirm(`Добавить всех ботов (${selectableBots.length}) в получатели?`)) return; for (const owner of selectableBots) selectedTargets.add(owner.key); render(); });
        body.querySelector('.sw-target-personas')?.addEventListener('click', () => { if (selectablePersonas.length > 20 && !confirm(`Добавить все персоны (${selectablePersonas.length}) в получатели?`)) return; for (const owner of selectablePersonas) selectedTargets.add(owner.key); render(); });
        body.querySelector('.sw-target-none')?.addEventListener('click', () => { selectedTargets.clear(); render(); });

        const distribute = (move) => {
            const targets = owners.filter(owner => selectedTargets.has(owner.key) && owner.key !== sourceKey);
            const picked = outfits.filter(outfit => selectedOutfits.has(outfit?.id));
            if (!picked.length || !targets.length) return;
            if (move && !confirm(`Перенести ${picked.length} ${swPlural(picked.length, 'наряд', 'наряда', 'нарядов')} в ${targets.length} ${swPlural(targets.length, 'гардероб', 'гардероба', 'гардеробов')}?`)) return;
            const now = Date.now();
            for (const target of targets) for (const outfit of picked) {
                const clone = structuredClone(outfit); clone.id = uid(); clone.addedAt = now; delete clone.lastWorn; target.list().push(clone);
            }
            if (move) {
                const ids = new Set(picked.map(outfit => outfit.id));
                const list = current.list(); list.splice(0, list.length, ...list.filter(outfit => !ids.has(outfit?.id)));
                current.clearActive(ids); selectedOutfits.clear();
            }
            swSave(); swUpdatePromptInjection(); if (swOpen) swRender();
            toastr.success(`${move ? 'Перенесено' : 'Скопировано'}: ${picked.length} × ${targets.length}`, 'Обслуживание гардероба');
            render();
        };
        body.querySelector('.sw-dist-copy')?.addEventListener('click', () => distribute(false));
        body.querySelector('.sw-dist-move')?.addEventListener('click', () => distribute(true));
    };
    render();
}

function swOpenMaintenance(tab) {
    const previous = document.getElementById('sw-maint-overlay');
    if (typeof previous?._swClose === 'function') previous._swClose();
    else previous?.remove();
    const ov = document.createElement('dialog'); ov.id = 'sw-maint-overlay';
    const panel = document.createElement('div'); panel.id = 'sw-maint-panel';
    panel.innerHTML = `
        <div class="sw-cleanup-header"><span><i class="fa-solid fa-broom"></i> Обслуживание гардероба</span><div class="sw-cleanup-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></div></div>
        <div class="sw-maint-tabs">
            <div class="sw-maint-tab" data-mt="dedup"><i class="fa-solid fa-clone"></i> Дубликаты</div>
            <div class="sw-maint-tab" data-mt="distribution"><i class="fa-solid fa-people-arrows"></i> Распределение</div>
            <div class="sw-maint-tab" data-mt="cleanup"><i class="fa-solid fa-broom"></i> Чистка файлов</div>
        </div>
        <div class="sw-cleanup-body" id="sw-maint-body"></div>`;
    ov.appendChild(panel); document.body.appendChild(ov);
    if (typeof ov.showModal === 'function') ov.showModal();
    else ov.setAttribute('open', '');
    const body = panel.querySelector('#sw-maint-body');

    function close() {
        document.removeEventListener('keydown', maintEsc, true);
        if (ov.open && typeof ov.close === 'function') ov.close();
        ov.remove();
    }
    ov._swClose = close;
    function maintEsc(e) { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); } }
    document.addEventListener('keydown', maintEsc, true);
    ov.addEventListener('cancel', event => { event.preventDefault(); close(); });
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    panel.querySelector('.sw-cleanup-close').addEventListener('click', close);

    let curTab = null;
    function show(which) {
        if (which === curTab) return;
        curTab = which;
        for (const t of panel.querySelectorAll('.sw-maint-tab')) t.classList.toggle('sw-maint-tab-active', t.dataset.mt === which);
        if (which === 'cleanup') swRenderCleanup(body);
        else if (which === 'distribution') swRenderDistribution(body);
        else swRenderDedup(body);
    }
    for (const t of panel.querySelectorAll('.sw-maint-tab')) t.addEventListener('click', () => show(t.dataset.mt));
    show(['cleanup', 'distribution'].includes(tab) ? tab : 'dedup');
}

function swRenderCleanup(body) {
    const selected = new Set();
    let state = null;

    async function scan() {
        body.innerHTML = `<div class="sw-cleanup-loading"><i class="fa-solid fa-spinner fa-spin"></i> Сканирование…</div>`;
        try { state = await swScanOrphans(); selected.clear(); for (const f of state.orphans) selected.add(f); render(); }
        catch (e) { body.innerHTML = `<div class="sw-cleanup-err">Ошибка: ${esc(e.message)}</div>`; }
    }

    function render() {
        const { orphans, totalFiles, referencedCount, dir } = state;
        let h = `<div class="sw-cleanup-info">Используется: <b>${referencedCount}</b> · Лишних: <b>${orphans.length}</b> · Всего в папке: ${totalFiles}</div>`;
        if (orphans.length === 0) { h += `<div class="sw-cleanup-empty"><i class="fa-solid fa-circle-check"></i> Лишних файлов нет — всё используется.</div>`; body.innerHTML = h; return; }
        h += `<div class="sw-cleanup-hint">На эти файлы не ссылается ни один наряд или референс. Удалятся только выбранные.</div>`;
        h += `<div class="sw-cleanup-tools"><span class="sw-cleanup-link" id="sw-cl-all">Выбрать все</span><span class="sw-cleanup-link" id="sw-cl-none">Снять все</span></div>`;
        h += '<div class="sw-cleanup-grid">';
        for (const f of orphans) {
            h += `<div class="sw-cleanup-item ${selected.has(f) ? 'sw-cl-sel' : ''}" data-f="${esc(f)}"><img src="${esc(dir + f)}" loading="lazy" onerror="this.style.opacity=0.15"><div class="sw-cl-check"><i class="fa-solid fa-check"></i></div></div>`;
        }
        h += '</div>';
        h += `<div class="sw-cleanup-actions"><div class="sw-cleanup-btn sw-cleanup-del">Удалить выбранные (<span id="sw-cl-count">${selected.size}</span>)</div></div>`;
        body.innerHTML = h;

        body.querySelector('#sw-cl-all').addEventListener('click', () => { for (const f of orphans) selected.add(f); render(); });
        body.querySelector('#sw-cl-none').addEventListener('click', () => { selected.clear(); render(); });
        for (const it of body.querySelectorAll('.sw-cleanup-item')) {
            it.addEventListener('click', () => { const f = it.dataset.f; if (selected.has(f)) selected.delete(f); else selected.add(f); it.classList.toggle('sw-cl-sel'); const cnt = body.querySelector('#sw-cl-count'); if (cnt) cnt.textContent = selected.size; });
        }
        body.querySelector('.sw-cleanup-del').addEventListener('click', async () => {
            if (selected.size === 0) { toastr.info('Ничего не выбрано', 'Чистка'); return; }
            if (!confirm(`Удалить ${selected.size} файлов с сервера? Это необратимо.`)) return;
            const delBtn = body.querySelector('.sw-cleanup-del');
            delBtn.style.pointerEvents = 'none'; delBtn.textContent = 'Удаление…';
            const res = await swDeleteFiles(state.dir, [...selected]);
            toastr.success(`Удалено: ${res.ok}${res.fail ? `, ошибок: ${res.fail}` : ''}`, 'Чистка', { timeOut: 4000 });
            scan();
        });
    }
    scan();
}

function swRenderDedup(body) {
    const view = swCurrentView();
    const sideName = swTab === 'bot' ? 'Бот' : 'Юзер';
    const modeName = view.shared ? 'общий' : 'персональный';

    const dupKey = (o) => {
        const nm = (o.name || '').trim().toLowerCase();
        if (nm && nm !== 'без имени') return 'n:' + nm + '|' + swTypeOf(o);
        if (o.srcId) return 's:' + o.srcId;
        if (o.imagePath) return 'p:' + o.imagePath;
        return 'u:' + o.id;
    };

    const selected = new Set();
    let dupItems = [];

    function compute() {
        const list = view.list() || [];
        const groups = new Map();
        for (const o of list) { const k = dupKey(o); if (k[0] === 'u') continue; let arr = groups.get(k); if (!arr) groups.set(k, arr = []); arr.push(o); }
        const activeId = view.activeId();
        dupItems = []; selected.clear();
        let groupCount = 0;
        for (const g of groups.values()) {
            if (g.length < 2) continue;
            groupCount++;
            const keep = g.find(o => o.id === activeId) || g.reduce((a, b) => ((a.addedAt || 0) <= (b.addedAt || 0) ? a : b));
            for (const o of g) if (o.id !== keep.id) { dupItems.push(o); selected.add(o.id); }
        }
        return groupCount;
    }

    function paint() {
        for (const it of body.querySelectorAll('.sw-cleanup-item')) it.classList.toggle('sw-cl-sel', selected.has(it.dataset.id));
        const cnt = body.querySelector('#sw-dd-count'); if (cnt) cnt.textContent = selected.size;
    }

    function render() {
        const groupCount = compute();
        const total = (view.list() || []).length;
        let h = `<div class="sw-cleanup-info">Гардероб: <b>${esc(sideName)}</b> (${esc(modeName)}) · дубликатов: <b>${dupItems.length}</b> в ${groupCount} группах · всего: ${total}</div>`;
        if (dupItems.length === 0) { h += `<div class="sw-cleanup-empty"><i class="fa-solid fa-circle-check"></i> Дубликатов не найдено.</div>`; body.innerHTML = h; return; }
        h += `<div class="sw-cleanup-hint">По одному образу из каждой группы остаётся, остальные ниже и помечены на удаление.</div>`;
        h += `<div class="sw-cleanup-tools"><span class="sw-cleanup-link" id="sw-dd-all">Выбрать все</span><span class="sw-cleanup-link" id="sw-dd-none">Снять все</span></div>`;
        h += '<div class="sw-cleanup-grid">';
        for (const o of dupItems) {
            h += `<div class="sw-cleanup-item ${selected.has(o.id) ? 'sw-cl-sel' : ''}" data-id="${esc(o.id)}" title="${esc(o.name || '')}"><img src="${esc(swImgSrc(o))}" loading="lazy" onerror="this.style.opacity=0.15"><div class="sw-cl-check"><i class="fa-solid fa-check"></i></div></div>`;
        }
        h += '</div>';
        h += `<div class="sw-cleanup-actions"><div class="sw-cleanup-btn sw-dd-del">Удалить дубли (<span id="sw-dd-count">${selected.size}</span>)</div></div>`;
        body.innerHTML = h;

        body.querySelector('#sw-dd-all').addEventListener('click', () => { for (const o of dupItems) selected.add(o.id); paint(); });
        body.querySelector('#sw-dd-none').addEventListener('click', () => { selected.clear(); paint(); });
        for (const it of body.querySelectorAll('.sw-cleanup-item')) {
            it.addEventListener('click', () => { const id = it.dataset.id; if (selected.has(id)) selected.delete(id); else selected.add(id); paint(); });
        }
        body.querySelector('.sw-dd-del').addEventListener('click', () => {
            if (selected.size === 0) { toastr.info('Ничего не выбрано', 'Дубликаты'); return; }
            if (!confirm(`Удалить ${selected.size} дубликатов?`)) return;
            const ids = [...selected];
            for (const id of ids) view.remove(id);
            swSave();
            toastr.success(`Удалено дубликатов: ${ids.length}`, 'Дубликаты', { timeOut: 4000 });
            swPage = 0; swRender(); swUpdatePromptInjection(); swInjectBarBtn();
            render();
        });
    }
    render();
}

// ── Prompt injection ──

const SW_PROMPT_KEY = 'sillywardrobe_outfit';
const SW_INJECT_POSITION = 1;
const SW_INJECT_DEPTH = 0;
const SW_INJECT_ROLE = 0;
const SW_INJECT_SCAN = false;

function swBuildInjectionText(cn) {
    const botData = swGetActiveBotOutfit();
    const userData = swGetActiveUserOutfit();
    if (!botData && !userData) return '';

    const parts = [];
    if (botData) {
        const desc = swSanitizeDesc(botData.description);
        const label = desc || botData.name || 'неизвестный наряд';
        parts.push(`${cn}: ${label}`);
    }
    if (userData) {
        const desc = swSanitizeDesc(userData.description);
        const label = desc || userData.name || 'неизвестный наряд';
        parts.push(`{{user}}: ${label}`);
    }

    if (parts.length === 0) return '';
    return `[Текущая одежда]\n${parts.join('\n')}`;
}

export function swUpdatePromptInjection() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.setExtensionPrompt !== 'function') {
            iigLog('WARN', 'setExtensionPrompt not available');
            return;
        }
        const cn = swCharName();
        if (!cn) { ctx.setExtensionPrompt(SW_PROMPT_KEY, '', SW_INJECT_POSITION, SW_INJECT_DEPTH, SW_INJECT_SCAN, SW_INJECT_ROLE); return; }
        const injectionText = swBuildInjectionText(cn);
        ctx.setExtensionPrompt(SW_PROMPT_KEY, injectionText, SW_INJECT_POSITION, SW_INJECT_DEPTH, SW_INJECT_SCAN, SW_INJECT_ROLE);
        if (injectionText) iigLog('INFO', `Prompt injection set: ${injectionText.replace(/\s+/g, ' ').slice(0, 160)}…`);
        else iigLog('INFO', 'Prompt injection cleared');
    } catch (e) { iigLog('ERROR', 'Failed to update prompt injection:', e.message); }
}

// ── Wardrobe launch buttons ──

const SW_BUTTON_PLACEMENTS = new Set(['bar', 'wand', 'both', 'hidden']);

function swButtonPlacement() {
    const value = getSettings().wardrobeButtonPlacement;
    return SW_BUTTON_PLACEMENTS.has(value) ? value : 'bar';
}

function swActiveCount() {
    return (swGetActiveBotOutfit() ? 1 : 0) + (swGetActiveUserOutfit() ? 1 : 0);
}

function swSyncWandBtn(show) {
    let btn = document.getElementById('iig_wardrobe_wand_button');
    if (!show) { btn?.remove(); return; }

    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;

    if (!btn) {
        btn = document.createElement('div');
        btn.id = 'iig_wardrobe_wand_button';
        btn.className = 'list-group-item flex-container flexGap5';
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            swOpenModal();
        });
        menu.appendChild(btn);
    }

    const count = swActiveCount();
    btn.classList.toggle('sw-wand-active', count > 0);
    btn.innerHTML = `<div class="fa-solid fa-shirt extensionsMenuExtensionButton"></div><span>Гардероб${count ? ` (${count})` : ''}</span>`;
}

export function swInjectBarBtn() {
    const placement = swButtonPlacement();
    const wantBar = placement === 'bar' || placement === 'both';
    const wantWand = placement === 'wand' || placement === 'both';

    swSyncWandBtn(wantWand);

    if (!wantBar) {
        $('#sw-bar-btn').remove();
        $('#sw-float-btn').remove();
        return;
    }

    // Remove the deprecated free-floating button: placement is now governed
    // exclusively by wardrobeButtonPlacement.
    $('#sw-float-btn').remove();

    let $btn = $('#sw-bar-btn');
    if ($btn.length === 0) {
        $btn = $('<div id="sw-bar-btn" title="Гардероб"><i class="fa-solid fa-shirt"></i></div>');
        $btn.on('click touchend', function(e) { e.preventDefault(); e.stopPropagation(); swOpenModal(); });
        const $left = $('#leftSendForm');
        if ($left.length) $left.append($btn); else $('body').append($btn);
    }
    const count = swActiveCount();
    const hasActive = count > 0;
    $btn.toggleClass('sw-bar-active', hasActive);
    if (hasActive) {
        $btn.html(`<i class="fa-solid fa-shirt"></i><span class="sw-bar-count">${count}</span>`);
    } else {
        $btn.html('<i class="fa-solid fa-shirt"></i>');
    }
    $btn.show();
}

function swInjectFloatBtn() {
    const show = !!swGetSettings().showFloatingBtn;
    let $fb = $('#sw-float-btn');
    if (!show) { if ($fb.length) $fb.remove(); return; }
    if ($fb.length === 0) {
        $fb = $('<div id="sw-float-btn" title="Гардероб"><i class="fa-solid fa-shirt"></i></div>');
        $fb.on('click touchend', function (e) { e.preventDefault(); e.stopPropagation(); swOpenModal(); });
        $('body').append($fb);
    }
    const hasBot = !!swGetActiveBotOutfit();
    const hasUser = !!swGetActiveUserOutfit();
    const count = (hasBot ? 1 : 0) + (hasUser ? 1 : 0);
    $fb.toggleClass('sw-float-active', count > 0);
    $fb.html(`<i class="fa-solid fa-shirt"></i>${count > 0 ? `<span class="sw-bar-count">${count}</span>` : ''}`);
    $fb.show();
}

// ── Public API (for extras.js / pipeline) ──

export function swFindItem(id) {
    const s = swGetSettings();
    for (const arr of [s.sharedBotWardrobe, s.sharedUserWardrobe]) {
        const found = arr.find(o => o.id === id);
        if (found) return found;
    }
    for (const w of Object.values(s.wardrobes || {})) {
        if (!w) continue;
        for (const side of ['bot', 'user']) {
            const found = (w[side] || []).find(o => o.id === id);
            if (found) return found;
        }
    }
    for (const outfits of Object.values(s.personaWardrobes || {})) {
        const found = (outfits || []).find(o => o.id === id);
        if (found) return found;
    }
    return null;
}

export function swBuildDescription(type) {
    const outfit = swGetActiveSideOutfit(type);
    if (!outfit) return '';
    return swSanitizeDesc(outfit.description) || '';
}

export async function getActiveOutfitBase64(type) {
    const side = type === 'bot' ? 'bot' : 'user';
    if (swSharedCfg(side).use()) {
        await swPreloadSharedActive(side);
        return swSharedCache[side].b64;
    }
    const outfit = swGetActiveSideOutfit(side);
    return outfit?.base64 || null;
}

export function getActiveOutfitDescription(type) {
    return swBuildDescription(type);
}

export async function getCollageBase64(_type) {
    return null;
}

export function getActiveOutfitData(type) {
    const side = type === 'bot' ? 'bot' : 'user';
    return swGetActiveSideOutfit(side);
}

export function isActiveOutfitTryOn(type) {
    const side = type === 'bot' ? 'bot' : 'user';
    if (!swGetSettings().tryOnAsAvatar) return false;
    return swGetActiveSideOutfit(side)?.tryOnSide === side;
}

// ── Init ──

export function initWardrobe() {
    swGetSettings();
    const ctx = SillyTavern.getContext();

    loadPersonasModule().then((module) => {
        swPersonasModule = module;
        swEnsurePersonaWardrobe();
        swPreloadSharedActive('user');
        swUpdatePromptInjection();
        if (swOpen) swRender();
    }).catch((error) => iigLog('WARN', 'Wardrobe persona module unavailable:', error?.message || error));

    ctx.eventSource.on(ctx.event_types.APP_READY, () => {
        setTimeout(() => { swPreloadAllShared(); swUpdatePromptInjection(); swInjectBarBtn(); }, 500);
    });

    ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
        setTimeout(() => { swPreloadAllShared(); swUpdatePromptInjection(); swInjectBarBtn(); }, 300);
    });

    if (ctx.event_types.PERSONA_CHANGED) {
        ctx.eventSource.on(ctx.event_types.PERSONA_CHANGED, () => {
            setTimeout(() => {
                swEnsurePersonaWardrobe();
                swPreloadSharedActive('user');
                swUpdatePromptInjection();
                swInjectBarBtn();
                if (swOpen) { swPage = 0; swRender(); }
            }, 100);
        });
    }

    const _genEvents = ['GENERATION_STARTED', 'GENERATE_BEFORE_COMBINE_PROMPTS', 'GENERATION_AFTER_COMMANDS', 'MESSAGE_SENT'];
    for (const evName of _genEvents) {
        const ev = ctx.event_types?.[evName];
        if (ev) {
            ctx.eventSource.on(ev, () => {
                try { swUpdatePromptInjection(); } catch (e) { iigLog('WARN', `re-inject on ${evName} failed:`, e.message); }
            });
        }
    }

    iigLog('INFO', 'SillyWardrobe initialized');
}
