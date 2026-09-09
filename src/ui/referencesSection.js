/**
 * Секция «References»: вкладки Avatars / Wardrobe / NPC / Lorebook,
 * avatar-refs блоки (общий + Naistera), lorebook-бар с импортом/экспортом,
 * additional references (список, drag-and-drop, vision) и reference
 * instruction.
 */

import {
    getSettings,
    saveSettings,
    ensureAdditionalReferencesArray,
    ensureLorebooks,
    getActiveLorebook,
    createLorebook,
    renameLorebook,
    removeLorebook,
    setLorebookEnabled,
    setActiveLorebook,
    DEFAULT_REF_INSTRUCTION,
    normalizeImageContextCount,
    MAX_CONTEXT_IMAGES,
    MAX_ADDITIONAL_REFERENCES,
} from '../settings.js';
import {
    normalizeStoredImagePath,
    readFileAsDataUrl,
    saveImageToFile,
    sanitizeForHtml,
} from '../utils.js';
import {
    renderAdditionalReferencesList,
    renderAdditionalReferencesStatus,
    buildUserAvatarDropdownControl,
    syncUserAvatarSelection,
    syncActivePersonaAvatarMode,
    refreshUserAvatarSelects,
    getUserAvatarDropdownConfigs,
    closeUserAvatarDropdowns,
    openReferenceImportModal,
    closeReferenceImportModal,
    importAdditionalReferencesFromUrls,
    downloadReferenceImageFromUrl,
    buildLorebookExportJson,
    lorebookFileNameFromTitle,
    triggerBrowserDownload,
    importLorebookFromUrl,
    importLorebookFromFile,
} from '../references.js';
import { resolveActiveProvider, getActiveProviderMaxReferences } from '../providers.js';
import { generateReferenceDescription } from '../vision.js';
import { t } from '../i18n.js';
import { Popup } from '../../../../../popup.js';
import { buildSettingsSectionHtml } from './common.js';
import { buildCharacterLibraryBodyHtml } from '../characterLibraryUi.js';

// ----- HTML -----

/**
 * Общая разметка одной "avatar references" подсекции.
 * Раньше в buildReferencesSettingsSectionHtml был дубликат этого блока
 * для Gemini и для Naistera. Теперь — одна фабрика.
 */
function buildAvatarReferencesBlockHtml({
    sectionId,
    hiddenClass,
    hidden,
    title,
    sendCharCheckboxId,
    sendCharEnabled,
    sendUserCheckboxId,
    sendUserEnabled,
    useActivePersonaRowId,
    useActivePersonaCheckboxId,
    useActivePersonaRowHidden,
    useActivePersonaHiddenClass,
    useActivePersonaEnabled,
    userAvatarRowId,
    userAvatarRowHidden,
    userAvatarRowHiddenClass,
    userAvatarDropdownHtml,
    refreshButtonId,
}) {
    return `
        <div id="${sectionId}" class="iig-settings-card-nested ${hidden ? hiddenClass : ''}">
            <h4>${title}</h4>
            <label class="checkbox_label">
                <input type="checkbox" id="${sendCharCheckboxId}" ${sendCharEnabled ? 'checked' : ''}>
                <span>${t`Send character avatar`}</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="${sendUserCheckboxId}" ${sendUserEnabled ? 'checked' : ''}>
                <span>${t`Send persona avatar`}</span>
            </label>
        </div>
    `;
}

function buildLorebookBarHtml(settings = getSettings()) {
    const lorebooks = ensureLorebooks(settings);
    const activeId = settings.activeLorebookId;
    const active = getActiveLorebook(settings);
    const optionsHtml = lorebooks.map((lb) =>
        `<option value="${sanitizeForHtml(lb.id)}" ${lb.id === activeId ? 'selected' : ''}>${sanitizeForHtml(lb.name)}${lb.enabled === false ? ' ' + t`(off)` : ''}</option>`,
    ).join('');
    return `
        <div class="iig-lorebook-bar">
            <div class="iig-lorebook-selector">
                <label for="iig_lorebook_select">${t`Lorebook`}</label>
                <select id="iig_lorebook_select" class="flex1">
                    ${optionsHtml}
                </select>
                <label class="checkbox_label" title="${t`Include this lorebook in matching`}">
                    <input type="checkbox" id="iig_lorebook_enabled" ${active?.enabled !== false ? 'checked' : ''}>
                    <span>${t`On`}</span>
                </label>
            </div>
            <div class="iig-lorebook-actions">
                <div id="iig_lorebook_add" class="menu_button" title="${t`Create new lorebook`}">
                    <i class="fa-solid fa-plus"></i>
                </div>
                <div id="iig_lorebook_rename" class="menu_button" title="${t`Rename lorebook`}">
                    <i class="fa-solid fa-pen"></i>
                </div>
                <div class="iig-lorebook-actions-divider"></div>
                <div id="iig_lorebook_import_url" class="menu_button" title="${t`Import lorebook from URL`}">
                    <i class="fa-solid fa-link"></i>
                </div>
                <label class="menu_button iig-lorebook-import-file" title="${t`Import lorebook from local file`}">
                    <i class="fa-solid fa-file-arrow-down"></i>
                    <input type="file" accept="application/json,.json" id="iig_lorebook_import_file_input" style="display:none">
                </label>
                <div id="iig_lorebook_export" class="menu_button" title="${t`Export current lorebook as JSON`}">
                    <i class="fa-solid fa-file-arrow-up"></i>
                </div>
                <div class="iig-lorebook-actions-divider"></div>
                <div id="iig_lorebook_remove" class="menu_button" title="${t`Delete lorebook`}">
                    <i class="fa-solid fa-trash"></i>
                </div>
            </div>
        </div>
    `;
}

export function buildReferencesSettingsSectionHtml(settings = getSettings()) {
    const provider = resolveActiveProvider(settings);
    const refsSupported = provider ? provider.supportsReferences(settings) : false;
    const isGemini = settings.apiType === 'gemini';
    const isOpenAI = settings.apiType === 'openai';
    const isOpenRouter = settings.apiType === 'openrouter';
    const isElectronHub = settings.apiType === 'electronhub';
    const isVoid = settings.apiType === 'void';
    const isAIGate = settings.apiType === 'aigate';
    const commonAvatarRefsVisible = (isGemini || isOpenAI || isOpenRouter || isElectronHub || isVoid || isAIGate) && refsSupported;
    const naisteraRefsVisible = settings.apiType === 'naistera' && refsSupported;

    // Заголовок секции аватаров — по активному провайдеру. Provider-brand
    // имена не локализуются.
    let avatarRefsTitle;
    if (isOpenRouter) avatarRefsTitle = 'OpenRouter';
    else if (isElectronHub) avatarRefsTitle = 'Electron Hub';
    else if (isVoid) avatarRefsTitle = 'VoidAI / RouteMyAI';
    else if (isAIGate) avatarRefsTitle = 'AIGate';
    else if (isOpenAI) avatarRefsTitle = 'OpenAI / GPT Image';
    else avatarRefsTitle = 'Gemini / nano-banana';

    const geminiAvatarsBlock = buildAvatarReferencesBlockHtml({
        sectionId: 'iig_avatar_refs_section',
        hiddenClass: 'iig-hidden',
        hidden: !commonAvatarRefsVisible,
        title: avatarRefsTitle,
        sendCharCheckboxId: 'iig_send_char_avatar',
        sendCharEnabled: settings.sendCharAvatar,
        sendUserCheckboxId: 'iig_send_user_avatar',
        sendUserEnabled: settings.sendUserAvatar,
        useActivePersonaRowId: 'iig_use_active_persona_avatar_row',
        useActivePersonaCheckboxId: 'iig_use_active_persona_avatar',
        useActivePersonaRowHidden: !settings.sendUserAvatar,
        useActivePersonaHiddenClass: 'iig-hidden',
        useActivePersonaEnabled: settings.useActiveUserPersonaAvatar,
        userAvatarRowId: 'iig_user_avatar_row',
        userAvatarRowHidden: !settings.sendUserAvatar || settings.useActiveUserPersonaAvatar,
        userAvatarRowHiddenClass: 'iig-hidden',
        userAvatarDropdownHtml: buildUserAvatarDropdownControl('iig_user_avatar', settings.userAvatarFile),
        refreshButtonId: 'iig_refresh_avatars',
    });

    const naisteraAvatarsBlock = buildAvatarReferencesBlockHtml({
        sectionId: 'iig_naistera_refs_section',
        hiddenClass: 'iig-hidden',
        hidden: !naisteraRefsVisible,
        title: 'Naistera',
        sendCharCheckboxId: 'iig_naistera_send_char_avatar',
        sendCharEnabled: settings.naisteraSendCharAvatar,
        sendUserCheckboxId: 'iig_naistera_send_user_avatar',
        sendUserEnabled: settings.naisteraSendUserAvatar,
        useActivePersonaRowId: 'iig_naistera_use_active_persona_avatar_row',
        useActivePersonaCheckboxId: 'iig_naistera_use_active_persona_avatar',
        useActivePersonaRowHidden: !settings.naisteraSendUserAvatar,
        useActivePersonaHiddenClass: 'iig-hidden',
        useActivePersonaEnabled: settings.useActiveUserPersonaAvatar,
        userAvatarRowId: 'iig_naistera_user_avatar_row',
        userAvatarRowHidden: !settings.naisteraSendUserAvatar || settings.useActiveUserPersonaAvatar,
        userAvatarRowHiddenClass: 'iig-hidden',
        userAvatarDropdownHtml: buildUserAvatarDropdownControl('iig_naistera_user_avatar', settings.userAvatarFile),
        refreshButtonId: 'iig_naistera_refresh_avatars',
    });

    const refsSectionVisible = refsSupported;

    // ---- Tabs: Avatars / Wardrobe / NPC / Lorebook / Instruction ----
    // Avatars-таб включает: avatar refs (char/user) + кастомную Avatar Library
    // + Image Context. Wardrobe и NPC — отдельными вкладками. Lorebook —
    // существующие additional refs. Instruction — постоянный footer-блок.

    const avatarsTabHtml = `
        ${geminiAvatarsBlock}
        ${naisteraAvatarsBlock}

        <div id="iig_characters_section" class="iig-settings-card-nested">
            <h4>${t`Character library`}</h4>
            <p class="hint">${t`Manage the main appearance, additional image references, text descriptions, and generation history for every character and persona.`}</p>
            ${buildCharacterLibraryBodyHtml()}
        </div>

        <div class="iig-settings-card-nested iig-hidden" id="iig_avatar_library_block">
            <h4>${t`Custom avatar library`}</h4>
            <p class="hint">${t`Active item replaces the default avatar (from character card / user persona) wherever a reference is sent. Add an appearance description (manually or via Vision AI) to also inject it into prompts.`}</p>

            <div class="iig-wardrobe-inject-row">
                <label class="checkbox_label" title="${t`Appends "[Name looks like: ...]" blocks to every image generation prompt`}">
                    <input type="checkbox" id="iig_inject_avatar_appearance_gen" ${settings.injectAvatarAppearanceToGeneration ? 'checked' : ''}>
                    <span>${t`Inject appearance into image generation prompt`}</span>
                </label>
            </div>
            <div class="iig-wardrobe-inject-row">
                <label class="checkbox_label" title="${t`Injects "[Name looks like: ...]" into the LLM chat context via setExtensionPrompt`}">
                    <input type="checkbox" id="iig_inject_avatar_appearance_chat" ${settings.injectAvatarAppearanceToChatEnabled ? 'checked' : ''}>
                    <span>${t`Inject appearance into LLM chat context`}</span>
                </label>
                <div class="iig-wardrobe-inject-depth">
                    <label for="iig_avatar_appearance_depth">${t`Depth`}</label>
                    <input type="number" id="iig_avatar_appearance_depth" class="text_pole" value="${Number.isFinite(settings.avatarAppearanceInjectionDepth) ? settings.avatarAppearanceInjectionDepth : 1}" min="0" max="10">
                </div>
            </div>

            <div class="iig-extras-subhead">
                <span>${t`Character avatars`}</span>
            </div>
            <div id="iig_avatar_lib_char"></div>
            <div id="iig_avatar_desc_char"></div>
            <div class="iig-extras-add-row">
                <input type="text" id="iig_avatar_lib_char_name" class="text_pole flex1" placeholder="${t`Avatar name (optional)`}">
                <input type="file" id="iig_avatar_lib_char_file" accept="image/*" style="display:none">
                <div id="iig_avatar_lib_char_add" class="menu_button" title="${t`Add avatar`}">
                    <i class="fa-solid fa-plus"></i> ${t`Add`}
                </div>
            </div>

            <div class="iig-extras-subhead">
                <span>${t`User avatars`}</span>
            </div>
            <div id="iig_avatar_lib_user"></div>
            <div id="iig_avatar_desc_user"></div>
            <div class="iig-extras-add-row">
                <input type="text" id="iig_avatar_lib_user_name" class="text_pole flex1" placeholder="${t`Avatar name (optional)`}">
                <input type="file" id="iig_avatar_lib_user_file" accept="image/*" style="display:none">
                <div id="iig_avatar_lib_user_add" class="menu_button" title="${t`Add avatar`}">
                    <i class="fa-solid fa-plus"></i> ${t`Add`}
                </div>
            </div>

            <div class="iig-avatar-tags-toolbar">
                <div id="iig_avatar_tags_toggle" class="menu_button" title="${t`Manage avatar tags`}"><i class="fa-solid fa-tags"></i> ${t`Manage tags`}</div>
            </div>
            <div id="iig_avatar_tag_manager" class="iig-hidden"></div>
        </div>

        <div class="iig-settings-card-nested ${refsSectionVisible ? '' : 'iig-hidden'}" id="iig_image_context_section">
            <h4>${t`Image context`}</h4>
            <label class="checkbox_label">
                <input type="checkbox" id="iig_image_context_enabled" ${settings.imageContextEnabled ? 'checked' : ''}>
                <span>${t`Enable image context`}</span>
            </label>
            <div class="iig-video-frequency-row ${settings.imageContextEnabled ? '' : 'iig-hidden'}" id="iig_image_context_count_row">
                <div class="iig-video-frequency-input">
                    <span>${t`Use`}</span>
                    <input type="number" id="iig_image_context_count" class="text_pole" min="1" max="${MAX_CONTEXT_IMAGES}" step="1" value="${normalizeImageContextCount(settings.imageContextCount)}">
                    <span>${t`previous images.`}</span>
                </div>
            </div>
        </div>
    `;

    const wardrobeTabHtml = `
        <div class="iig-settings-card-nested">
            <h4>${t`Wardrobe (clothing)`}</h4>
            <p class="hint">${t`Manage outfits with categories, tags, and per-character slots. Click the button below to open the wardrobe modal.`}</p>

            <div id="iig_open_wardrobe_modal" class="menu_button iig-button-inline" style="width: 100%; margin-bottom: 12px;">
                <i class="fa-solid fa-shirt"></i> ${t`Open Wardrobe`}
            </div>

            <div class="iig-wardrobe-match-setting">
                <label class="checkbox_label">
                    <input type="checkbox" id="iig_optional_wardrobe_sending" ${settings.optionalWardrobeSending === true ? 'checked' : ''}>
                    <span>${t`Send outfits only on alias match`}</span>
                </label>
                <p class="hint">${t`Uses the avatar match keys of the outfit owner. Character and persona outfit references and image-prompt descriptions are sent only when one of their aliases appears in the image prompt.`}</p>
            </div>

            <div class="iig-wardrobe-inject-row">
                <label class="checkbox_label">
                    <input type="checkbox" id="iig_inject_wardrobe" ${settings.injectWardrobeToChat !== false ? 'checked' : ''}>
                    <span>${t`Inject outfit description into LLM prompt`}</span>
                </label>
                <div class="iig-wardrobe-inject-depth">
                    <label for="iig_wardrobe_injection_depth">${t`Depth`}</label>
                    <input type="number" id="iig_wardrobe_injection_depth" class="text_pole" value="${Number.isFinite(settings.wardrobeInjectionDepth) ? settings.wardrobeInjectionDepth : 1}" min="0" max="10">
                </div>
            </div>

            <div class="iig-wardrobe-button-placement">
                <label for="iig_wardrobe_button_placement">${t`Wardrobe button location`}</label>
                <select id="iig_wardrobe_button_placement" class="text_pole">
                    <option value="bar" ${settings.wardrobeButtonPlacement === 'bar' ? 'selected' : ''}>${t`Bottom input bar`}</option>
                    <option value="wand" ${settings.wardrobeButtonPlacement === 'wand' ? 'selected' : ''}>${t`Magic wand menu`}</option>
                    <option value="both" ${settings.wardrobeButtonPlacement === 'both' ? 'selected' : ''}>${t`Both locations`}</option>
                    <option value="hidden" ${settings.wardrobeButtonPlacement === 'hidden' ? 'selected' : ''}>${t`Hidden`}</option>
                </select>
            </div>
        </div>
    `;

    const npcTabHtml = `
        <div class="iig-settings-card-nested">
            <h4>${t`NPC / Extra characters`}</h4>
            <p class="hint">${t`When an NPC name (or alias) appears in the prompt, the avatar is added as a reference and the appearance text is added as a hint.`}</p>

            <label class="checkbox_label">
                <input type="checkbox" id="iig_auto_detect_names" ${settings.autoDetectNames !== false ? 'checked' : ''}>
                <span>${t`Auto-detect names in prompt`}</span>
            </label>

            <div id="iig_npc_list"></div>
            <div id="iig_add_npc" class="menu_button iig-button-inline" style="width: 100%; margin-top: 8px;">
                <i class="fa-solid fa-plus"></i> ${t`Add NPC`}
            </div>
        </div>
    `;

    const lorebookTabHtml = `
        <div class="iig-settings-card-nested ${refsSectionVisible ? '' : 'iig-hidden'}" id="iig_additional_refs_section">
            <h4>${t`Additional references (lorebook)`}</h4>

            ${buildLorebookBarHtml(settings)}

            <div class="iig-additional-ref-actions">
                <div id="iig_additional_refs_add" class="menu_button iig-button-inline">
                    <i class="fa-solid fa-plus"></i> ${t`Add reference`}
                </div>
                <div id="iig_additional_refs_import" class="menu_button iig-button-inline">
                    <i class="fa-solid fa-link"></i> ${t`Import reference`}
                </div>
            </div>
            <div id="iig_additional_refs_status" class="hint" style="margin-bottom: 8px;"></div>
            <div id="iig_additional_refs_list"></div>
        </div>
    `;

    const instructionFooterHtml = `
        <div class="iig-settings-card-nested ${refsSectionVisible ? '' : 'iig-hidden'}" id="iig_ref_instruction_section">
            <h4>${t`Reference instruction`}</h4>
            <p class="hint">${t`Prepended to the prompt whenever at least one reference image is sent to the provider. Helps the model copy appearance from refs.`}</p>
            <label class="checkbox_label">
                <input type="checkbox" id="iig_ref_instruction_enabled" ${settings.refInstructionEnabled !== false ? 'checked' : ''}>
                <span>${t`Send reference instruction`}</span>
            </label>
            <textarea
                id="iig_ref_instruction"
                class="text_pole flex1 iig-settings-textarea"
                rows="4"
                placeholder="${sanitizeForHtml(DEFAULT_REF_INSTRUCTION)}"
                ${settings.refInstructionEnabled === false ? 'disabled' : ''}
            >${sanitizeForHtml(settings.refInstruction ?? DEFAULT_REF_INSTRUCTION)}</textarea>
            <div class="iig-debug-actions">
                <div id="iig_ref_instruction_reset" class="menu_button iig-button-inline" title="${t`Restore default text`}">
                    <i class="fa-solid fa-rotate-left"></i> ${t`Reset to default`}
                </div>
            </div>
        </div>
    `;

    const tabsBarHtml = `
        <div class="iig-tabs" role="tablist">
            <div class="iig-tab iig-tab-active" data-iig-tab="avatars" role="tab">
                <i class="fa-solid fa-user"></i> ${t`Avatars`}
            </div>
            <div class="iig-tab" data-iig-tab="wardrobe" role="tab">
                <i class="fa-solid fa-shirt"></i> ${t`Wardrobe`}
            </div>
            <div class="iig-tab" data-iig-tab="npc" role="tab">
                <i class="fa-solid fa-people-group"></i> ${t`NPC`}
            </div>
            <div class="iig-tab" data-iig-tab="lorebook" role="tab">
                <i class="fa-solid fa-book"></i> ${t`Lorebook`}
            </div>
        </div>
    `;

    const bodyHtml = `
        <div class="iig-settings-card">
            ${tabsBarHtml}
            <div class="iig-tab-panels">
                <div class="iig-tab-panel iig-tab-panel-active" data-iig-tab-panel="avatars">${avatarsTabHtml}</div>
                <div class="iig-tab-panel" data-iig-tab-panel="wardrobe">${wardrobeTabHtml}</div>
                <div class="iig-tab-panel" data-iig-tab-panel="npc">${npcTabHtml}</div>
                <div class="iig-tab-panel" data-iig-tab-panel="lorebook">${lorebookTabHtml}</div>
            </div>
            ${instructionFooterHtml}
        </div>
    `;
    return buildSettingsSectionHtml('iig_references_section', t`References`, bodyHtml, true);
}

// ----- Avatar section events (общая фабрика для Gemini и Naistera) -----

/**
 * Вешает обработчики на пару аватар-чекбоксов + на refresh.
 * Раньше этот код был продублирован для `iig_*` и `iig_naistera_*`.
 */
export function bindAvatarSectionEvents(settings, updateVisibility, config) {
    const {
        sendCharCheckboxId,
        sendCharKey,
        sendUserCheckboxId,
        sendUserKey,
        useActivePersonaCheckboxId,
        userAvatarSelectId,
        refreshButtonId,
        userAvatarDropdownId,
    } = config;

    document.getElementById(sendCharCheckboxId)?.addEventListener('change', (e) => {
        settings[sendCharKey] = e.target.checked;
        saveSettings();
    });

    document.getElementById(sendUserCheckboxId)?.addEventListener('change', (e) => {
        settings[sendUserKey] = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById(useActivePersonaCheckboxId)?.addEventListener('change', (e) => {
        settings.useActiveUserPersonaAvatar = e.target.checked;
        syncActivePersonaAvatarMode(settings.useActiveUserPersonaAvatar);
        saveSettings();
        updateVisibility();
    });

    document.getElementById(userAvatarSelectId)?.addEventListener('change', (e) => {
        settings.userAvatarFile = e.target.value;
        syncUserAvatarSelection(settings.userAvatarFile);
        saveSettings();
    });

    document.getElementById(refreshButtonId)?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        btn.classList.add('loading');

        try {
            const avatars = await refreshUserAvatarSelects();

            toastr.success(t`Avatars found: ${avatars.length}`, t`Image Generation`);
            document.getElementById(userAvatarDropdownId)?.classList.add('open');
        } catch (error) {
            toastr.error(t`Failed to load avatars`, t`Image Generation`);
        } finally {
            btn.classList.remove('loading');
        }
    });
}

export function bindAvatarDropdownToggles() {
    for (const { rootId, selectedId, listId } of getUserAvatarDropdownConfigs()) {
        document.getElementById(selectedId)?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const dropdown = document.getElementById(rootId);
            if (!dropdown) {
                return;
            }

            const willOpen = !dropdown.classList.contains('open');
            closeUserAvatarDropdowns();
            dropdown.classList.toggle('open', willOpen);

            if (willOpen) {
                const list = document.getElementById(listId);
                if (list && list.children.length === 0) {
                    await refreshUserAvatarSelects();
                }
            }
        });
    }

    document.addEventListener('click', (e) => {
        const clickedInsideDropdown = getUserAvatarDropdownConfigs().some(({ rootId }) => {
            const root = document.getElementById(rootId);
            return root?.contains(e.target);
        });
        if (!clickedInsideDropdown) {
            closeUserAvatarDropdowns();
        }
    });
}

// ----- Lorebook bar events -----

function refreshLorebookBar(settings) {
    const bar = document.querySelector('.iig-lorebook-bar');
    if (!bar) return;
    bar.outerHTML = buildLorebookBarHtml(settings);
    // После replace — элемент в DOM заменился, перевешиваем обработчики.
    bindLorebookBarEvents(settings);
}

export function bindLorebookBarEvents(settings) {
    document.getElementById('iig_lorebook_select')?.addEventListener('change', (e) => {
        const id = e.target instanceof HTMLSelectElement ? e.target.value : '';
        if (!id) return;
        const lb = setActiveLorebook(id, settings);
        if (!lb) return;
        saveSettings();
        refreshLorebookBar(settings);
        refreshAdditionalReferencesList();
    });

    document.getElementById('iig_lorebook_enabled')?.addEventListener('change', (e) => {
        const active = getActiveLorebook(settings);
        if (!active || !(e.target instanceof HTMLInputElement)) return;
        setLorebookEnabled(active.id, e.target.checked, settings);
        saveSettings();
        refreshLorebookBar(settings);
    });

    document.getElementById('iig_lorebook_add')?.addEventListener('click', async () => {
        const name = await Popup.show.input(t`New lorebook`, t`Enter a name for the new lorebook:`);
        if (!name) return;
        const lb = createLorebook(name, settings);
        saveSettings();
        refreshLorebookBar(settings);
        refreshAdditionalReferencesList();
        toastr.success(t`Lorebook "${lb.name}" created`, t`Image Generation`, { timeOut: 1500 });
    });

    document.getElementById('iig_lorebook_rename')?.addEventListener('click', async () => {
        const active = getActiveLorebook(settings);
        if (!active) return;
        const newName = await Popup.show.input(t`Rename lorebook`, t`Enter a new name:`, active.name);
        if (!newName) return;
        renameLorebook(active.id, newName, settings);
        saveSettings();
        refreshLorebookBar(settings);
    });

    async function afterLorebookImport(stats) {
        refreshLorebookBar(settings);
        refreshAdditionalReferencesList();
        const tail = stats.imagesFailed > 0
            ? ` (${t`${stats.imagesFailed} images failed to download`})`
            : '';
        toastr.success(
            t`Imported ${stats.refsCount} refs, ${stats.imagesDownloaded} images downloaded${tail}`,
            t`Image Generation`,
            { timeOut: 4000 },
        );
    }

    document.getElementById('iig_lorebook_import_url')?.addEventListener('click', async () => {
        const url = await Popup.show.input(
            t`Import lorebook from URL`,
            t`Paste a direct URL to a JSON lorebook file:`,
        );
        if (typeof url !== 'string') return;
        const trimmed = url.trim();
        if (!trimmed) return;
        try {
            const stats = await importLorebookFromUrl(trimmed);
            await afterLorebookImport(stats);
        } catch (error) {
            console.error('[IIG] Lorebook import failed:', error);
            toastr.error(t`Import error: ${error.message || error}`, t`Image Generation`);
        }
    });

    document.getElementById('iig_lorebook_import_file_input')?.addEventListener('change', async (e) => {
        const input = e.target;
        if (!(input instanceof HTMLInputElement)) return;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        try {
            const stats = await importLorebookFromFile(file);
            await afterLorebookImport(stats);
        } catch (error) {
            console.error('[IIG] Lorebook import failed:', error);
            toastr.error(t`Import error: ${error.message || error}`, t`Image Generation`);
        }
    });

    document.getElementById('iig_lorebook_export')?.addEventListener('click', async () => {
        const active = getActiveLorebook(settings);
        if (!active) return;

        // Перед скачиванием показываем предупреждение про картинки.
        const proceed = await Popup.show.confirm(
            t`Export lorebook`,
            t`Images are NOT included in the JSON. To share this lorebook, fill the empty "imageUrl" field of each reference with a direct link to its image. Continue?`,
        );
        if (!proceed) return;

        const payload = buildLorebookExportJson(active);
        const json = JSON.stringify(payload, null, 2);
        const fileName = lorebookFileNameFromTitle(active.name);
        triggerBrowserDownload(fileName, json);
        toastr.success(t`Lorebook "${active.name}" exported`, t`Image Generation`, { timeOut: 2000 });
    });

    document.getElementById('iig_lorebook_remove')?.addEventListener('click', async () => {
        const active = getActiveLorebook(settings);
        if (!active) return;
        const confirmed = await Popup.show.confirm(
            t`Delete lorebook`,
            t`Delete lorebook "${active.name}"? All its references will be lost. This cannot be undone.`,
        );
        if (!confirmed) return;
        const ok = removeLorebook(active.id, settings);
        if (!ok) {
            toastr.warning(t`Cannot delete the last lorebook`, t`Image Generation`);
            return;
        }
        saveSettings();
        refreshLorebookBar(settings);
        refreshAdditionalReferencesList();
    });
}

// ----- Additional references events -----

let selectedAdditionalReferenceId = '';
let additionalReferenceSearchQuery = '';
let additionalReferenceFilter = 'all';

function getAdditionalReferenceIndex(element) {
    const container = element?.closest?.('[data-ref-index]');
    const index = Number.parseInt(String(container?.getAttribute('data-ref-index') || ''), 10);
    return Number.isInteger(index) ? index : -1;
}

function filterAdditionalReferenceRows() {
    const query = additionalReferenceSearchQuery.trim().toLowerCase();
    const rows = [...document.querySelectorAll('.iig-additional-ref-list-row')];
    let visibleCount = 0;
    for (const row of rows) {
        const matchesQuery = !query || String(row.getAttribute('data-ref-search') || '').includes(query);
        const matchesFilter = additionalReferenceFilter === 'all'
            || (additionalReferenceFilter === 'enabled' && row.getAttribute('data-ref-enabled') === 'true')
            || row.getAttribute('data-ref-match-mode') === additionalReferenceFilter;
        const visible = matchesQuery && matchesFilter;
        row.classList.toggle('iig-hidden', !visible);
        if (visible) visibleCount += 1;
    }
    document.getElementById('iig_additional_refs_no_results')?.classList.toggle('iig-hidden', rows.length === 0 || visibleCount > 0);
}

function updateAdditionalReferenceListPreview(ref) {
    const row = [...document.querySelectorAll('.iig-additional-ref-list-row')]
        .find((item) => item.getAttribute('data-ref-id') === ref.id);
    if (!row) return;
    const title = String(ref.name || '').trim() || t`Untitled reference`;
    const description = String(ref.description || '').replace(/\s+/g, ' ').trim() || t`No description`;
    const titleElement = row.querySelector('.iig-additional-ref-list-copy strong');
    const descriptionElement = row.querySelector('.iig-additional-ref-list-copy small');
    if (titleElement) titleElement.textContent = title;
    if (descriptionElement) descriptionElement.textContent = description;
    row.setAttribute('data-ref-search', `${ref.name || ''} ${ref.description || ''} ${ref.group || ''}`.toLowerCase());
    const editorTitle = document.querySelector('.iig-additional-ref-editor-heading strong');
    if (editorTitle) editorTitle.textContent = title;
    filterAdditionalReferenceRows();
}

/**
 * Обёртка над `renderAdditionalReferencesList`, пробрасывающая текущий
 * provider-лимит референсов. Нужна чтобы references.js не зависел от
 * providers.js (иначе ESM-цикл).
 */
export function refreshAdditionalReferencesList() {
    const settings = getSettings();
    const refs = ensureAdditionalReferencesArray(settings);
    if (!refs.some((ref) => ref.id === selectedAdditionalReferenceId)) {
        selectedAdditionalReferenceId = refs[0]?.id || '';
    }
    renderAdditionalReferencesList(getActiveProviderMaxReferences(settings), {
        selectedId: selectedAdditionalReferenceId,
        query: additionalReferenceSearchQuery,
        filter: additionalReferenceFilter,
    });
    filterAdditionalReferenceRows();
}

export function bindAdditionalReferencesEvents(settings) {
    document.querySelectorAll('input[name="iig_additional_refs_mode"]').forEach((input) => {
        input.addEventListener('change', (e) => {
            if (!(e.target instanceof HTMLInputElement) || !e.target.checked) return;
            settings.additionalReferencesMode = e.target.value === 'power' ? 'power' : 'simple';
            saveSettings();
            refreshAdditionalReferencesList();
        });
    });

    document.getElementById('iig_additional_refs_add')?.addEventListener('click', () => {
        const refs = ensureAdditionalReferencesArray(settings);
        if (refs.length >= MAX_ADDITIONAL_REFERENCES) {
            toastr.warning(t`Maximum additional references: ${MAX_ADDITIONAL_REFERENCES}`, t`Image Generation`);
            return;
        }

        refs.unshift({
            name: '',
            description: '',
            imagePath: '',
            matchMode: 'match',
            enabled: true,
            group: '',
            priority: 0,
            useRegex: false,
            secondaryKeys: '',
        });
        selectedAdditionalReferenceId = ensureAdditionalReferencesArray(settings)[0]?.id || '';
        saveSettings();
        refreshAdditionalReferencesList();
    });

    document.getElementById('iig_additional_refs_import')?.addEventListener('click', () => {
        openReferenceImportModal();
    });

    document.getElementById('iig_ref_import_close')?.addEventListener('click', () => {
        closeReferenceImportModal();
    });

    document.querySelector('#iig_ref_import_modal [data-iig-modal-close="true"]')?.addEventListener('click', () => {
        closeReferenceImportModal();
    });

    document.getElementById('iig_ref_import_submit')?.addEventListener('click', async () => {
        const button = document.getElementById('iig_ref_import_submit');
        const input = document.getElementById('iig_ref_import_urls');
        if (!(button instanceof HTMLDivElement) || !(input instanceof HTMLTextAreaElement)) {
            return;
        }

        button.classList.add('loading');
        try {
            const result = await importAdditionalReferencesFromUrls(input.value);
            closeReferenceImportModal();
            refreshAdditionalReferencesList();
            const tail = result.skippedCount > 0 ? t`, skipped: ${result.skippedCount}` : '';
            toastr.success(t`Imported: ${result.importedCount}` + tail, t`Image Generation`);
        } catch (error) {
            toastr.error(t`Import error: ${error.message || error}`, t`Image Generation`);
        } finally {
            button.classList.remove('loading');
        }
    });

    document.getElementById('iig_ref_import_urls')?.addEventListener('keydown', async (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('iig_ref_import_submit')?.click();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            closeReferenceImportModal();
        }
    });

    document.getElementById('iig_additional_refs_list')?.addEventListener('input', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
            return;
        }

        if (target.id === 'iig_additional_refs_search') {
            additionalReferenceSearchQuery = target.value;
            filterAdditionalReferenceRows();
            return;
        }

        const isNameField = target.classList.contains('iig-additional-ref-name');
        const isDescriptionField = target.classList.contains('iig-additional-ref-description');
        const isGroupField = target.classList.contains('iig-additional-ref-group');
        const isSecondaryField = target.classList.contains('iig-additional-ref-secondary');
        const isPriorityField = target.classList.contains('iig-additional-ref-priority');
        if (!isNameField && !isDescriptionField && !isGroupField && !isSecondaryField && !isPriorityField) {
            return;
        }

        const index = getAdditionalReferenceIndex(target);
        if (index < 0) return;

        const refs = ensureAdditionalReferencesArray(settings);
        if (!refs[index]) {
            return;
        }

        if (isNameField) refs[index].name = target.value;
        if (isDescriptionField) refs[index].description = target.value;
        if (isGroupField) refs[index].group = target.value;
        if (isSecondaryField) refs[index].secondaryKeys = target.value;
        if (isPriorityField) {
            const parsed = Number.parseInt(target.value, 10);
            refs[index].priority = Number.isFinite(parsed) ? parsed : 0;
        }
        saveSettings();
        updateAdditionalReferenceListPreview(refs[index]);
        // Обновляем только статус (ссылок на provider-limit warning), не
        // ре-рендерим карточки — иначе слетает фокус.
        renderAdditionalReferencesStatus(getActiveProviderMaxReferences(settings));
    });

    document.getElementById('iig_additional_refs_list')?.addEventListener('change', async (e) => {
        const target = e.target;
        if (target instanceof HTMLSelectElement && target.id === 'iig_additional_refs_filter') {
            additionalReferenceFilter = ['enabled', 'match', 'always'].includes(target.value) ? target.value : 'all';
            filterAdditionalReferenceRows();
            return;
        }
        if (target instanceof HTMLInputElement && target.classList.contains('iig-additional-ref-enabled')) {
            const index = getAdditionalReferenceIndex(target);
            if (index < 0) return;

            const refs = ensureAdditionalReferencesArray(settings);
            if (!refs[index]) {
                return;
            }

            refs[index].enabled = target.checked;
            saveSettings();
            refreshAdditionalReferencesList();
            return;
        }

        if (target instanceof HTMLSelectElement && target.classList.contains('iig-additional-ref-match-mode')) {
            const index = getAdditionalReferenceIndex(target);
            const refs = ensureAdditionalReferencesArray(settings);
            if (index < 0 || !refs[index]) return;
            refs[index].matchMode = target.value === 'always' ? 'always' : 'match';
            saveSettings();
            refreshAdditionalReferencesList();
            return;
        }

        if (target instanceof HTMLInputElement && target.classList.contains('iig-additional-ref-regex')) {
            const index = getAdditionalReferenceIndex(target);
            const refs = ensureAdditionalReferencesArray(settings);
            if (index < 0 || !refs[index]) return;
            refs[index].useRegex = target.checked;
            saveSettings();
            refreshAdditionalReferencesList();
            return;
        }

        if (!(target instanceof HTMLInputElement) || !target.classList.contains('iig-additional-ref-file')) {
            return;
        }

        const index = getAdditionalReferenceIndex(target);
        if (index < 0) {
            target.value = '';
            return;
        }

        const file = target.files?.[0];
        if (!file) {
            target.value = '';
            return;
        }

        const refs = ensureAdditionalReferencesArray(settings);
        if (!refs[index]) {
            target.value = '';
            return;
        }

        try {
            if (!refs[index].name) {
                refs[index].name = file.name.replace(/\.[^.]+$/, '');
            }

            const dataUrl = await readFileAsDataUrl(file);
            const savedPath = await saveImageToFile(dataUrl, {
                mode: 'additional-reference-upload',
                refIndex: index,
                refName: refs[index].name,
            });

            refs[index].imagePath = normalizeStoredImagePath(savedPath);
            saveSettings();
            refreshAdditionalReferencesList();
            toastr.success(t`Additional reference saved`, t`Image Generation`);
        } catch (error) {
            console.error('[IIG] Failed to upload additional reference:', error);
            toastr.error(t`Reference upload failed: ${error.message || error}`, t`Image Generation`);
        } finally {
            target.value = '';
        }
    });

    document.getElementById('iig_additional_refs_list')?.addEventListener('click', async (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;

        const selectButton = target.closest('[data-ref-select]');
        if (selectButton) {
            selectedAdditionalReferenceId = String(selectButton.getAttribute('data-ref-select') || '');
            refreshAdditionalReferencesList();
            return;
        }

        const urlBtn = target.closest('.iig-additional-ref-upload-url');
        const removeBtn = !urlBtn ? target.closest('.iig-additional-ref-remove') : null;
        const upBtn = !urlBtn && !removeBtn ? target.closest('.iig-additional-ref-move-up') : null;
        const downBtn = !urlBtn && !removeBtn && !upBtn ? target.closest('.iig-additional-ref-move-down') : null;
        const visionBtn = !urlBtn && !removeBtn && !upBtn && !downBtn ? target.closest('.iig-additional-ref-vision') : null;
        const button = urlBtn || removeBtn || upBtn || downBtn || visionBtn;
        if (!button) return;

        const index = getAdditionalReferenceIndex(button);
        if (index < 0) return;

        const refs = ensureAdditionalReferencesArray(settings);

        if (visionBtn && visionBtn instanceof HTMLElement) {
            const refId = refs[index]?.id;
            if (!refId) return;
            const originalHtml = visionBtn.innerHTML;
            visionBtn.classList.add('disabled');
            visionBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            try {
                const description = await generateReferenceDescription(refId);
                const descInput = document.querySelector('.iig-additional-ref-editor-content .iig-additional-ref-description');
                if (descInput instanceof HTMLTextAreaElement) descInput.value = description;
                updateAdditionalReferenceListPreview(refs[index]);
                toastr.success(t`Description generated`, t`Image Generation`);
            } catch (error) {
                toastr.error(t`Vision generation error: ${error.message || error}`, t`Image Generation`);
            } finally {
                visionBtn.classList.remove('disabled');
                visionBtn.innerHTML = originalHtml;
            }
            return;
        }

        if (urlBtn) {
            if (!refs[index]) return;
            const url = await Popup.show.input(t`Upload image by URL`, t`Paste a direct link to the image:`);
            const trimmed = String(url || '').trim();
            if (!trimmed) return;
            try {
                const savedPath = await downloadReferenceImageFromUrl(trimmed, {
                    mode: 'additional-reference-upload-url',
                    refIndex: index,
                    refName: refs[index].name,
                });
                refs[index].imagePath = savedPath;
                saveSettings();
                refreshAdditionalReferencesList();
                toastr.success(t`Additional reference saved`, t`Image Generation`);
            } catch (error) {
                console.error('[IIG] Failed to upload reference by URL:', error);
                toastr.error(t`Reference upload failed: ${error.message || error}`, t`Image Generation`);
            }
            return;
        }

        if (removeBtn) {
            const name = String(refs[index]?.name || '').trim() || t`Reference ${index + 1}`;
            const confirmed = await Popup.show.confirm(
                t`Delete reference`,
                t`Delete reference "${name}"? This cannot be undone.`,
            );
            if (!confirmed) return;
            refs.splice(index, 1);
            selectedAdditionalReferenceId = refs[index]?.id || refs[index - 1]?.id || '';
        } else if (upBtn && index > 0) {
            [refs[index - 1], refs[index]] = [refs[index], refs[index - 1]];
        } else if (downBtn && index < refs.length - 1) {
            [refs[index], refs[index + 1]] = [refs[index + 1], refs[index]];
        } else {
            return; // no-op (edge)
        }
        saveSettings();
        refreshAdditionalReferencesList();
    });

    // ---- Drag-and-drop reordering ----
    const refListEl = document.getElementById('iig_additional_refs_list');
    let dragFromIndex = -1;

    refListEl?.addEventListener('dragstart', (e) => {
        const handle = (e.target instanceof Element) ? e.target.closest('.iig-ref-drag-handle') : null;
        if (!handle) return;
        const row = handle.closest('.iig-additional-ref-row');
        if (!row) return;
        dragFromIndex = parseInt(row.getAttribute('data-ref-index') || '', 10);
        e.dataTransfer.setData('text/plain', String(dragFromIndex));
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setDragImage(row, 20, 20);
        setTimeout(() => row.classList.add('iig-ref-dragging'), 0);
    });

    refListEl?.addEventListener('dragover', (e) => {
        if (dragFromIndex < 0) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const row = (e.target instanceof Element) ? e.target.closest('.iig-additional-ref-row') : null;
        refListEl.querySelectorAll('.iig-ref-drop-above, .iig-ref-drop-below').forEach((el) => {
            el.classList.remove('iig-ref-drop-above', 'iig-ref-drop-below');
        });
        if (!row || row.classList.contains('iig-ref-dragging')) return;
        const rect = row.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) {
            row.classList.add('iig-ref-drop-above');
        } else {
            row.classList.add('iig-ref-drop-below');
        }
    });

    refListEl?.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromIndex = dragFromIndex;
        dragFromIndex = -1;
        refListEl.querySelectorAll('.iig-ref-drop-above, .iig-ref-drop-below, .iig-ref-dragging').forEach((el) => {
            el.classList.remove('iig-ref-drop-above', 'iig-ref-drop-below', 'iig-ref-dragging');
        });
        const targetRow = (e.target instanceof Element) ? e.target.closest('.iig-additional-ref-row') : null;
        if (!targetRow) return;
        let toIndex = parseInt(targetRow.getAttribute('data-ref-index') || '', 10);
        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) return;
        const rect = targetRow.getBoundingClientRect();
        const belowMid = e.clientY >= rect.top + rect.height / 2;
        const refs = ensureAdditionalReferencesArray(settings);
        const [moved] = refs.splice(fromIndex, 1);
        let insertAt = toIndex;
        if (fromIndex < toIndex) insertAt--;
        if (belowMid) insertAt++;
        insertAt = Math.max(0, Math.min(refs.length, insertAt));
        refs.splice(insertAt, 0, moved);
        saveSettings();
        refreshAdditionalReferencesList();
    });

    refListEl?.addEventListener('dragend', () => {
        dragFromIndex = -1;
        refListEl.querySelectorAll('.iig-ref-drop-above, .iig-ref-drop-below, .iig-ref-dragging').forEach((el) => {
            el.classList.remove('iig-ref-drop-above', 'iig-ref-drop-below', 'iig-ref-dragging');
        });
    });
}

// ----- Reference instruction events -----

export function bindRefInstructionEvents(settings) {
    const checkbox = document.getElementById('iig_ref_instruction_enabled');
    const textarea = document.getElementById('iig_ref_instruction');
    const resetBtn = document.getElementById('iig_ref_instruction_reset');

    checkbox?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.refInstructionEnabled = e.target.checked;
        if (textarea instanceof HTMLTextAreaElement) {
            textarea.disabled = !e.target.checked;
        }
        saveSettings();
    });

    textarea?.addEventListener('input', (e) => {
        if (!(e.target instanceof HTMLTextAreaElement)) return;
        settings.refInstruction = e.target.value;
        saveSettings();
    });

    resetBtn?.addEventListener('click', () => {
        if (!(textarea instanceof HTMLTextAreaElement)) return;
        textarea.value = DEFAULT_REF_INSTRUCTION;
        settings.refInstruction = DEFAULT_REF_INSTRUCTION;
        saveSettings();
        toastr.success(t`Reference instruction reset to default`, t`Image Generation`, { timeOut: 1500 });
    });
}

// ----- Tabs (References section) -----

export function bindReferencesTabs() {
    const tabs = document.querySelectorAll('#iig_references_section .iig-tab');
    const panels = document.querySelectorAll('#iig_references_section .iig-tab-panel');
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const target = tab.getAttribute('data-iig-tab');
            if (!target) return;
            tabs.forEach((t2) => t2.classList.toggle('iig-tab-active', t2 === tab));
            panels.forEach((p) => p.classList.toggle('iig-tab-panel-active', p.getAttribute('data-iig-tab-panel') === target));
        });
    });
}
