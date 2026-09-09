/**
 * Оркестратор UI настроек: собирает секции из src/ui/*, вешает обработчики
 * и держит общую логику пересчёта видимости (updateVisibility).
 *
 * Секции:
 *   ui/common.js            — обёртка секций + тогглы
 *   ui/apiSection.js        — API settings (провайдер/ключ/модель/параметры)
 *   ui/presets.js           — фабрика пресетов: стили/префиксы/суффиксы/NAI
 *   ui/stylePicker.js       — модалка выбора стиля с сайта
 *   ui/referencesSection.js — референсы: вкладки, lorebook, instruction
 *   ui/debugSection.js      — debug: retries, логи, last request
 *   ui/extrasSection.js     — библиотека аватаров, NPC, vision-события
 */

import { getSettings, getEndpointPlaceholder } from './settings.js';
import {
    renderAdditionalReferencesStatus,
    syncUserAvatarSelection,
    syncActivePersonaAvatarMode,
    buildReferenceImportModalHtml,
} from './references.js';
import { resolveActiveProvider, getActiveProviderMaxReferences } from './providers.js';
import { t } from './i18n.js';
import { bindSectionToggles } from './ui/common.js';
import {
    styleSection,
    prefixSection,
    suffixSection,
    novelaiPresetSection,
    renderStyleSettings,
} from './ui/presets.js';
import {
    buildApiSettingsSectionHtml,
    bindConnectionProfilesEvents,
    bindApiSectionEvents,
} from './ui/apiSection.js';
import {
    buildReferencesSettingsSectionHtml,
    bindAvatarSectionEvents,
    bindAvatarDropdownToggles,
    bindLorebookBarEvents,
    bindAdditionalReferencesEvents,
    bindRefInstructionEvents,
    refreshAdditionalReferencesList,
    bindReferencesTabs,
} from './ui/referencesSection.js';
import {
    buildDebugSettingsSectionHtml,
    bindDebugSectionEvents,
} from './ui/debugSection.js';
import {
    renderAvatarGrid,
    renderNpcList,
    bindExtrasEvents,
    bindVisionCollapse,
} from './ui/extrasSection.js';
import { bindCharacterLibraryEvents } from './characterLibraryUi.js';

export { renderStyleSettings };

// ----- Visibility recomputation -----

function buildUpdateVisibility(settings) {
    return () => {
        const apiType = settings.apiType;
        const isNaistera = apiType === 'naistera';
        const isGemini = apiType === 'gemini';
        const isOpenAI = apiType === 'openai';
        const isOpenRouter = apiType === 'openrouter';
        const isElectronHub = apiType === 'electronhub';
        const isVoid = apiType === 'void';
        const isAIGate = apiType === 'aigate';
        const isNovelAI = apiType === 'novelai';

        // Поддерживает ли активный провайдер референсы (учитывая модель).
        const provider = resolveActiveProvider(settings);
        const refsSupported = provider ? provider.supportsReferences(settings) : false;
        const naisteraRefsSupported = isNaistera && refsSupported;

        // «Общий» avatar refs блок (char/user аватар с чекбоксами) — теперь
        // показывается не только для Gemini, но и для любого OpenAI-семейства,
        // которое поддерживает /edits, и для OpenRouter/Electron Hub. Naistera
        // использует свой отдельный блок.
        const commonAvatarRefsVisible = (isGemini || isOpenAI || isOpenRouter || isElectronHub || isVoid || isAIGate || isNovelAI) && refsSupported;

        // Model is used for OpenAI and Gemini; Naistera and NovelAI have their own selectors.
        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isNaistera || isNovelAI);
        document.getElementById('iig_image_context_section')?.classList.toggle('iig-hidden', !refsSupported);
        document.getElementById('iig_image_context_count_row')?.classList.toggle('iig-hidden', !(refsSupported && settings.imageContextEnabled));
        document.getElementById('iig_additional_refs_section')?.classList.toggle('iig-hidden', !refsSupported);
        document.getElementById('iig_ref_instruction_section')?.classList.toggle('iig-hidden', !refsSupported);

        // Обновляем provider-limit warning в status-строке без ре-рендера
        // карточек (чтобы не терять фокус в inputs).
        renderAdditionalReferencesStatus(getActiveProviderMaxReferences(settings));

        // OpenAI + Electron Hub params (size / quality) — Electron Hub
        // принимает тот же формат JSON на /v1/images/{generations,edits}.
        document.getElementById('iig_size_row')?.classList.toggle('iig-hidden', !(isOpenAI || isElectronHub));
        document.getElementById('iig_quality_row')?.classList.toggle('iig-hidden', !(isOpenAI || isElectronHub));

        // ElectronHub-only section
        document.getElementById('iig_electronhub_section')?.classList.toggle('iig-hidden', !isElectronHub);

        // NovelAI-only section; also hide endpoint/key/raw — NovelAI uses ST proxy.
        document.getElementById('iig_novelai_section')?.classList.toggle('iig-hidden', !isNovelAI);
        document.getElementById('iig_endpoint')?.closest('.flex-row')?.classList.toggle('iig-hidden', isNovelAI);
        document.getElementById('iig_api_key')?.closest('.flex-row')?.classList.toggle('iig-hidden', isNovelAI);
        document.getElementById('iig_raw_endpoint')?.closest('.checkbox_label')?.classList.toggle('iig-hidden', isNovelAI);

        // NovelAI's own master switch controls the whole References section.
        const referencesSection = document.querySelector('[data-section-toggle="iig_references_section"]')?.closest('.iig-section');
        if (isNovelAI) referencesSection?.classList.toggle('iig-hidden', !refsSupported);
        else referencesSection?.classList.remove('iig-hidden');
        document.getElementById('iig_presets_section_wrapper')?.classList.toggle('iig-hidden', !isNovelAI);

        document.getElementById('iig_novelai_custom_model_row')?.classList.toggle(
            'iig-hidden',
            !(isNovelAI && settings.novelaiModel === '__custom__')
        );

        // Naistera-only params
        document.getElementById('iig_naistera_model_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_aspect_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_video_section')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_video_frequency_row')?.classList.toggle('iig-hidden', !(isNaistera && settings.naisteraVideoTest));
        document.getElementById('iig_naistera_refs_section')?.classList.toggle('iig-hidden', !naisteraRefsSupported);
        document.getElementById('iig_naistera_use_active_persona_avatar_row')?.classList.toggle('iig-hidden', !(naisteraRefsSupported && settings.naisteraSendUserAvatar));
        document.getElementById('iig_naistera_user_avatar_row')?.classList.toggle(
            'iig-hidden',
            !(naisteraRefsSupported && settings.naisteraSendUserAvatar && !settings.useActiveUserPersonaAvatar)
        );

        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isNaistera);

        const endpointInput = document.getElementById('iig_endpoint');
        if (endpointInput) {
            endpointInput.placeholder = getEndpointPlaceholder(apiType);
        }

        const avatarSection = document.getElementById('iig_avatar_section');
        if (avatarSection) {
            avatarSection.classList.toggle('iig-hidden', !(isGemini || isOpenRouter || isVoid || isAIGate));
        }

        // «Общий» avatar refs блок — для Gemini / OpenAI-c-refs / OpenRouter.
        const avatarRefsSection = document.getElementById('iig_avatar_refs_section');
        if (avatarRefsSection) {
            avatarRefsSection.classList.toggle('iig-hidden', !commonAvatarRefsVisible);

            // Обновляем заголовок при смене провайдера.
            const titleEl = avatarRefsSection.querySelector('h4');
            if (titleEl) {
                if (isOpenRouter) titleEl.textContent = 'OpenRouter';
                else if (isElectronHub) titleEl.textContent = 'Electron Hub';
                else if (isVoid) titleEl.textContent = 'VoidAI / RouteMyAI';
                else if (isAIGate) titleEl.textContent = 'AIGate';
                else if (isOpenAI) titleEl.textContent = 'OpenAI / GPT Image';
                else titleEl.textContent = 'Gemini / nano-banana';
            }
        }
        document.getElementById('iig_use_active_persona_avatar_row')?.classList.toggle(
            'iig-hidden',
            !(commonAvatarRefsVisible && settings.sendUserAvatar),
        );
        document.getElementById('iig_user_avatar_row')?.classList.toggle(
            'iig-hidden',
            !(commonAvatarRefsVisible && settings.sendUserAvatar && !settings.useActiveUserPersonaAvatar),
        );
    };
}

// ----- Main bind -----

function bindSettingsEvents() {
    const settings = getSettings();
    const updateVisibility = buildUpdateVisibility(settings);

    bindSectionToggles();
    bindConnectionProfilesEvents(settings, updateVisibility);
    bindApiSectionEvents(settings, updateVisibility);

    // Gemini avatar section
    bindAvatarSectionEvents(settings, updateVisibility, {
        sendCharCheckboxId: 'iig_send_char_avatar',
        sendCharKey: 'sendCharAvatar',
        sendUserCheckboxId: 'iig_send_user_avatar',
        sendUserKey: 'sendUserAvatar',
        useActivePersonaCheckboxId: 'iig_use_active_persona_avatar',
        userAvatarSelectId: 'iig_user_avatar_file',
        refreshButtonId: 'iig_refresh_avatars',
        userAvatarDropdownId: 'iig_user_avatar_dropdown',
    });

    // Naistera avatar section
    bindAvatarSectionEvents(settings, updateVisibility, {
        sendCharCheckboxId: 'iig_naistera_send_char_avatar',
        sendCharKey: 'naisteraSendCharAvatar',
        sendUserCheckboxId: 'iig_naistera_send_user_avatar',
        sendUserKey: 'naisteraSendUserAvatar',
        useActivePersonaCheckboxId: 'iig_naistera_use_active_persona_avatar',
        userAvatarSelectId: 'iig_naistera_user_avatar_file',
        refreshButtonId: 'iig_naistera_refresh_avatars',
        userAvatarDropdownId: 'iig_naistera_user_avatar_dropdown',
    });

    bindAvatarDropdownToggles();
    styleSection.bindEvents(settings);
    prefixSection.bindEvents(settings);
    suffixSection.bindEvents(settings);
    bindLorebookBarEvents(settings);
    bindAdditionalReferencesEvents(settings);
    bindRefInstructionEvents(settings);
    novelaiPresetSection.bindEvents(settings);
    bindDebugSectionEvents(settings);

    // Apply initial state
    syncUserAvatarSelection(settings.userAvatarFile);
    syncActivePersonaAvatarMode(settings.useActiveUserPersonaAvatar);
    refreshAdditionalReferencesList();
    updateVisibility();
}

// ----- Public entry -----

export function createSettingsUI() {
    const settings = getSettings();

    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[IIG] Settings container not found');
        return;
    }

    // The reference modal must live directly under <body>. On mobile Safari,
    // a fixed element inside SillyTavern's transformed settings drawer is
    // positioned relative to that drawer and can end up above the viewport.
    document.getElementById('iig_ref_import_modal')?.remove();

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${t`Image Generation`}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    ${buildApiSettingsSectionHtml(settings)}
                    ${styleSection.buildSectionHtml()}
                    ${prefixSection.buildSectionHtml()}
                    ${suffixSection.buildSectionHtml()}
                    ${buildReferencesSettingsSectionHtml(settings)}
                    <div id="iig_presets_section_wrapper" class="${settings.apiType === 'novelai' ? '' : 'iig-hidden'}">
                        <p class="hint" style="margin: 8px 0 4px;">${t`Name = trigger word, Value = replacement tags. Case-insensitive whole-word match.`}</p>
                        ${novelaiPresetSection.buildSectionHtml()}
                    </div>
                    ${buildDebugSettingsSectionHtml(settings)}
                </div>
            </div>
        </div>
        ${buildReferenceImportModalHtml()}
    `;

    container.insertAdjacentHTML('beforeend', html);

    const referenceModal = document.getElementById('iig_ref_import_modal');
    if (referenceModal && referenceModal.parentElement !== document.body) {
        document.body.appendChild(referenceModal);
    }

    bindSettingsEvents();
    bindExtrasEvents(settings);
    bindCharacterLibraryEvents(settings);
    bindReferencesTabs();
    bindVisionCollapse();
    renderStyleSettings();
    renderAvatarGrid('char');
    renderAvatarGrid('user');
    renderNpcList();
}
