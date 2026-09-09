/**
 * Секция «API settings»: connection profiles, провайдер/endpoint/ключ/модель,
 * параметры генерации (size/quality/aspect), Naistera / ElectronHub / NovelAI
 * подсекции и Vision-блок. Плюс биндинг всех обработчиков секции.
 */

import {
    getSettings,
    saveSettings,
    iigLog,
    normalizeNaisteraModel,
    normalizeNaisteraVideoFrequency,
    normalizeImageContextCount,
    normalizeConfiguredEndpoint,
    shouldReplaceEndpointForApiType,
    NOVELAI_MODELS,
    NOVELAI_SAMPLERS,
    NOVELAI_SCHEDULERS,
    NOVELAI_SIZES,
    ensureConnectionProfiles,
    getActiveConnectionProfile,
    createConnectionProfile,
    saveCurrentIntoProfile,
    loadConnectionProfile,
    renameConnectionProfile,
    removeConnectionProfile,
    ensureNovelaiNegativePresets,
    createNovelaiNegativePreset,
    getActiveNovelaiNegativePreset,
    updateNovelaiNegativePreset,
    removeNovelaiNegativePreset,
} from '../settings.js';
import { sanitizeForHtml } from '../utils.js';
import {
    syncUserAvatarSelection,
    syncActivePersonaAvatarMode,
} from '../references.js';
import { isGeminiModel, fetchModels, resolveActiveProvider } from '../providers.js';
import { DEFAULT_VISION_PROMPT } from '../vision.js';
import { t } from '../i18n.js';
import { Popup } from '../../../../../popup.js';
import { buildSettingsSectionHtml } from './common.js';
import { novelaiPresetSection } from './presets.js';

// ----- HTML -----

function buildNovelaiNegativePresetBlockHtml(settings) {
    const presets = ensureNovelaiNegativePresets(settings);
    const active = getActiveNovelaiNegativePreset(settings);
    const options = presets.map((preset) =>
        `<option value="${sanitizeForHtml(preset.id)}" ${preset.id === settings.activeNovelaiNegativePresetId ? 'selected' : ''}>${sanitizeForHtml(preset.name)}</option>`,
    ).join('');

    return `
        <div class="iig-settings-card-nested" id="iig_novelai_negative_presets">
            <h5>${t`NovelAI negative presets`}</h5>
            <div class="flex-row">
                <label for="iig_novelai_negative_preset_select">${t`Preset`}</label>
                <select id="iig_novelai_negative_preset_select" class="flex1">
                    ${options || `<option value="">${t`(no presets)`}</option>`}
                </select>
                <div></div>
            </div>
            <div class="flex-row">
                <label for="iig_novelai_negative_preset_name">${t`Preset name`}</label>
                <input type="text" id="iig_novelai_negative_preset_name" class="text_pole flex1" value="${sanitizeForHtml(active?.name || '')}" placeholder="${t`Preset name`}">
                <div></div>
            </div>
            <div class="flex-col" style="margin-top: 8px;">
                <label for="iig_novelai_negative_prompt">${t`Negative prompt`}</label>
                <textarea id="iig_novelai_negative_prompt" class="text_pole iig-settings-textarea" rows="4" placeholder="${t`Things to avoid in the image`}">${sanitizeForHtml(settings.novelaiNegativePrompt || '')}</textarea>
            </div>
            <div class="iig-debug-actions" style="margin-top: 8px;">
                <div id="iig_novelai_negative_preset_new" class="menu_button iig-button-inline"><i class="fa-solid fa-plus"></i> ${t`New`}</div>
                <div id="iig_novelai_negative_preset_save" class="menu_button iig-button-inline ${active ? '' : 'disabled'}"><i class="fa-solid fa-floppy-disk"></i> ${t`Save`}</div>
                <div id="iig_novelai_negative_preset_delete" class="menu_button iig-button-inline ${active ? '' : 'disabled'}"><i class="fa-solid fa-trash"></i> ${t`Delete`}</div>
            </div>
            <p class="hint">${t`These presets are used only by the NovelAI provider.`}</p>
        </div>`;
}

function syncNovelaiNegativePresetControls(settings) {
    const presets = ensureNovelaiNegativePresets(settings);
    const active = getActiveNovelaiNegativePreset(settings);
    const select = document.getElementById('iig_novelai_negative_preset_select');
    const nameInput = document.getElementById('iig_novelai_negative_preset_name');
    const promptInput = document.getElementById('iig_novelai_negative_prompt');
    if (select) {
        select.innerHTML = presets.length
            ? presets.map((preset) => `<option value="${sanitizeForHtml(preset.id)}">${sanitizeForHtml(preset.name)}</option>`).join('')
            : `<option value="">${t`(no presets)`}</option>`;
        select.value = active?.id || '';
    }
    if (nameInput) nameInput.value = active?.name || '';
    if (promptInput) promptInput.value = settings.novelaiNegativePrompt || '';
    document.getElementById('iig_novelai_negative_preset_save')?.classList.toggle('disabled', !active);
    document.getElementById('iig_novelai_negative_preset_delete')?.classList.toggle('disabled', !active);
}

function buildConnectionProfilesBlockHtml(settings = getSettings()) {
    const profiles = ensureConnectionProfiles(settings);
    const activeId = settings.activeConnectionProfileId;
    const optionsHtml = profiles.map((p) =>
        `<option value="${sanitizeForHtml(p.id)}" ${p.id === activeId ? 'selected' : ''}>${sanitizeForHtml(p.name)}</option>`,
    ).join('');
    return `
        <div class="iig-settings-card-nested iig-profile-bar">
            <div class="flex-row">
                <label for="iig_profile_select">${t`Profile`}</label>
                <select id="iig_profile_select" class="flex1">
                    ${optionsHtml || `<option value="">${t`(no profiles)`}</option>`}
                </select>
                <div class="iig-profile-buttons">
                    <div id="iig_profile_save" class="menu_button" title="${t`Save current settings into active profile`}">
                        <i class="fa-solid fa-floppy-disk"></i>
                    </div>
                    <div id="iig_profile_save_as" class="menu_button" title="${t`Save as new profile`}">
                        <i class="fa-solid fa-plus"></i>
                    </div>
                    <div id="iig_profile_rename" class="menu_button" title="${t`Rename active profile`}">
                        <i class="fa-solid fa-pen"></i>
                    </div>
                    <div id="iig_profile_remove" class="menu_button" title="${t`Delete active profile`}">
                        <i class="fa-solid fa-trash"></i>
                    </div>
                </div>
            </div>
        </div>
    `;
}

export function buildApiSettingsSectionHtml(settings = getSettings()) {
    const profilesHtml = buildConnectionProfilesBlockHtml(settings);
    const bodyHtml = `
        <div class="iig-settings-card">
            ${profilesHtml}
            <label class="checkbox_label">
                <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                <span>${t`Enable image generation`}</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="iig_external_blocks" ${settings.externalBlocks ? 'checked' : ''}>
                <span>${t`Process external blocks`}</span>
            </label>

            <div class="flex-row">
                <label for="iig_api_type">${t`API type`}</label>
                <select id="iig_api_type" class="flex1">
                    <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>${t`OpenAI-compatible (/v1/images/generations)`}</option>
                    <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>${t`Gemini-compatible (nano-banana)`}</option>
                    <option value="openrouter" ${settings.apiType === 'openrouter' ? 'selected' : ''}>${t`OpenRouter (chat/completions)`}</option>
                    <option value="electronhub" ${settings.apiType === 'electronhub' ? 'selected' : ''}>${t`Electron Hub (/v1/images/*)`}</option>
                    <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>${t`Naistera (naistera.org)`}</option>
                    <option value="void" ${settings.apiType === 'void' ? 'selected' : ''}>${t`VoidAI / RouteMyAI (chat-completions)`}</option>
                    <option value="aigate" ${settings.apiType === 'aigate' ? 'selected' : ''}>${t`AIGate (GPT Image + Gemini)`}</option>
                    <option value="novelai" ${settings.apiType === 'novelai' ? 'selected' : ''}>${t`NovelAI (via ST proxy)`}</option>
                </select>
                <div></div>
            </div>

            <div class="flex-row">
                <label for="iig_endpoint">${t`Endpoint URL`}</label>
                <input type="text" id="iig_endpoint" class="text_pole flex1" value="${settings.endpoint}" placeholder="https://api.example.com">
                <div></div>
            </div>

            <label class="checkbox_label" title="${t`Use endpoint URL as-is: do not append /v1/images/generations, /chat/completions, etc. Model list refresh is disabled — enter model name manually.`}">
                <input type="checkbox" id="iig_raw_endpoint" ${settings.rawEndpoint ? 'checked' : ''}>
                <span>${t`Raw endpoint (do not append paths)`}</span>
            </label>

            <div class="flex-row">
                <label for="iig_api_key">${t`API key`}</label>
                <input type="password" id="iig_api_key" class="text_pole flex1" value="${settings.apiKey}">
                <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="${t`Show / hide`}">
                    <i class="fa-solid fa-eye"></i>
                </div>
            </div>

            <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">${t`For Naistera: paste the token from the Telegram bot. Available models are loaded from the API.`}</p>

            <div class="flex-row ${settings.apiType === 'naistera' || settings.apiType === 'novelai' ? 'iig-hidden' : ''}" id="iig_model_row">
                <label for="iig_model_select">${t`Model`}</label>
                <input type="text" id="iig_model" class="text_pole flex1" value="${sanitizeForHtml(settings.model || '')}" placeholder="${t`Enter model name`}">
                <select id="iig_model_select" class="flex1 ${settings.rawEndpoint ? 'iig-hidden' : ''}">
                    ${settings.model ? `<option value="${sanitizeForHtml(settings.model)}" selected>${sanitizeForHtml(settings.model)}</option>` : `<option value="" selected disabled>${t`-- Select a model --`}</option>`}
                </select>
                <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="${t`Refresh list`}">
                    <i class="fa-solid fa-sync"></i>
                </div>
            </div>

            <div class="flex-row ${settings.apiType !== 'openai' && settings.apiType !== 'electronhub' ? 'iig-hidden' : ''}" id="iig_size_row">
                <label for="iig_size">${t`Size`}</label>
                <select id="iig_size" class="flex1">
                    <option value="auto" ${settings.size === 'auto' ? 'selected' : ''}>${t`Auto / from prompt`}</option>
                    <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>${t`1024x1024 (Square)`}</option>
                    <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>${t`1792x1024 (Landscape)`}</option>
                    <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>${t`1024x1792 (Portrait)`}</option>
                    <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>${t`512x512 (Small)`}</option>
                </select>
                <div></div>
            </div>

            <div class="flex-row ${settings.apiType !== 'openai' && settings.apiType !== 'electronhub' ? 'iig-hidden' : ''}" id="iig_quality_row">
                <label for="iig_quality">${t`Quality`}</label>
                <select id="iig_quality" class="flex1">
                    <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>${t`Standard`}</option>
                    <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>${t`HD`}</option>
                </select>
                <div></div>
            </div>

            <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_model_row">
                <label for="iig_naistera_model">${t`Model`}</label>
                <select id="iig_naistera_model" class="flex1">
                    ${normalizeNaisteraModel(settings.naisteraModel)
                        ? `<option value="${sanitizeForHtml(normalizeNaisteraModel(settings.naisteraModel))}" selected>${sanitizeForHtml(normalizeNaisteraModel(settings.naisteraModel))}</option>`
                        : `<option value="" selected disabled>${t`-- Select a model --`}</option>`}
                </select>
                <div id="iig_refresh_naistera_models" class="menu_button iig-refresh-btn" title="${t`Refresh list`}">
                    <i class="fa-solid fa-sync"></i>
                </div>
            </div>

            <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row">
                <label for="iig_naistera_aspect_ratio">${t`Aspect ratio`}</label>
                <select id="iig_naistera_aspect_ratio" class="flex1">
                    <option value="auto" ${settings.naisteraAspectRatio === 'auto' ? 'selected' : ''}>${t`Auto / from prompt`}</option>
                    <option value="1:1" ${settings.naisteraAspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                    <option value="16:9" ${settings.naisteraAspectRatio === '16:9' ? 'selected' : ''}>16:9</option>
                    <option value="9:16" ${settings.naisteraAspectRatio === '9:16' ? 'selected' : ''}>9:16</option>
                    <option value="3:2" ${settings.naisteraAspectRatio === '3:2' ? 'selected' : ''}>3:2</option>
                    <option value="2:3" ${settings.naisteraAspectRatio === '2:3' ? 'selected' : ''}>2:3</option>
                </select>
                <div></div>
            </div>

            <div id="iig_avatar_section" class="iig-settings-card-nested ${settings.apiType !== 'gemini' && settings.apiType !== 'openrouter' && settings.apiType !== 'void' ? 'iig-hidden' : ''}">
                <div class="flex-row">
                    <label for="iig_aspect_ratio">${t`Aspect ratio`}</label>
                    <select id="iig_aspect_ratio" class="flex1">
                        <option value="auto" ${settings.aspectRatio === 'auto' ? 'selected' : ''}>${t`Auto / from prompt`}</option>
                        <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>${t`1:1 (Square)`}</option>
                        <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>${t`2:3 (Portrait)`}</option>
                        <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>${t`3:2 (Landscape)`}</option>
                        <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>${t`3:4 (Portrait)`}</option>
                        <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>${t`4:3 (Landscape)`}</option>
                        <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>${t`4:5 (Portrait)`}</option>
                        <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>${t`5:4 (Landscape)`}</option>
                        <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>${t`9:16 (Vertical)`}</option>
                        <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>${t`16:9 (Wide)`}</option>
                        <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>${t`21:9 (Ultra-wide)`}</option>
                    </select>
                    <div id="iig_override_aspect_ratio_btn" class="menu_button iig-override-btn ${settings.overrideAspectRatio ? 'iig-override-active' : ''}" title="${t`Force override: always use this value, ignore AI prompt`}">
                        <i class="fa-solid fa-lock${settings.overrideAspectRatio ? '' : '-open'}"></i>
                    </div>
                </div>
                <div class="flex-row">
                    <label for="iig_image_size">${t`Resolution`}</label>
                    <select id="iig_image_size" class="flex1">
                        <option value="auto" ${settings.imageSize === 'auto' ? 'selected' : ''}>${t`Auto / from prompt`}</option>
                        <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>${t`1K (default)`}</option>
                        <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                        <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                    </select>
                    <div id="iig_override_image_size_btn" class="menu_button iig-override-btn ${settings.overrideImageSize ? 'iig-override-active' : ''}" title="${t`Force override: always use this value, ignore AI prompt`}">
                        <i class="fa-solid fa-lock${settings.overrideImageSize ? '' : '-open'}"></i>
                    </div>
                </div>
            </div>

            <div class="iig-settings-card-nested ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_video_section">
                <h4>${t`Video`}</h4>
                <label class="checkbox_label">
                    <input type="checkbox" id="iig_naistera_video_test" ${settings.naisteraVideoTest ? 'checked' : ''}>
                    <span>${t`Enable video generation`}</span>
                </label>
                <div class="iig-video-frequency-row ${settings.naisteraVideoTest ? '' : 'iig-hidden'}" id="iig_naistera_video_frequency_row">
                    <div class="iig-video-frequency-input">
                        <span>${t`Every`}</span>
                        <input type="number" id="iig_naistera_video_every_n" class="text_pole" min="1" max="999" step="1" value="${normalizeNaisteraVideoFrequency(settings.naisteraVideoEveryN)}">
                        <span>${t`messages.`}</span>
                    </div>
                </div>
            </div>

            <div class="iig-settings-card-nested ${settings.apiType === 'electronhub' ? '' : 'iig-hidden'}" id="iig_electronhub_section">
                <h4>${t`ElectronHub Advanced`}</h4>
                <p class="hint">${t`Optional parameters for ElectronHub API. Leave empty to use model defaults.`}</p>

                <div class="flex-row">
                    <label for="iig_electronhub_style">${t`Style`}</label>
                    <select id="iig_electronhub_style" class="flex1">
                        <option value="" ${!settings.electronhubStyle ? 'selected' : ''}>${t`Auto / model default`}</option>
                        <option value="vivid" ${settings.electronhubStyle === 'vivid' ? 'selected' : ''}>${t`Vivid`}</option>
                        <option value="natural" ${settings.electronhubStyle === 'natural' ? 'selected' : ''}>${t`Natural`}</option>
                    </select>
                    <div></div>
                </div>

                <div class="flex-col" style="margin-top: 8px;">
                    <label for="iig_electronhub_negative_prompt">${t`Negative prompt`}</label>
                    <textarea id="iig_electronhub_negative_prompt" class="text_pole iig-settings-textarea" rows="2" placeholder="${t`Things to avoid in the image`}">${sanitizeForHtml(settings.electronhubNegativePrompt || '')}</textarea>
                </div>

                <div class="flex-row" style="margin-top: 8px;">
                    <label for="iig_electronhub_guidance_scale">${t`Guidance scale`}</label>
                    <input type="number" id="iig_electronhub_guidance_scale" class="text_pole flex1" min="1" max="20" step="0.5" value="${settings.electronhubGuidanceScale || 7.5}" placeholder="7.5">
                    <div></div>
                </div>

                <div class="flex-row">
                    <label for="iig_electronhub_steps">${t`Steps`}</label>
                    <input type="number" id="iig_electronhub_steps" class="text_pole flex1" min="1" max="150" step="1" value="${settings.electronhubSteps || 50}" placeholder="50">
                    <div></div>
                </div>

                <div style="margin-top: 12px;">
                    <label class="checkbox_label" title="${t`Experimental: try sending reference images to models that support them`}">
                        <input type="checkbox" id="iig_electronhub_enable_references" ${settings.electronhubEnableReferences ? 'checked' : ''}>
                        <span>${t`Enable reference images (experimental)`}</span>
                    </label>
                    <p class="hint" style="margin-top: 4px;">${t`Most ElectronHub models don't support references. Enable this only if your model supports /v1/images/edits endpoint.`}</p>
                </div>
            </div>

            <div class="iig-settings-card-nested ${settings.apiType === 'novelai' ? '' : 'iig-hidden'}" id="iig_novelai_section">
                <h4>NovelAI</h4>
                <p class="hint">${t`Uses NovelAI API key from SillyTavern's API settings (NovelAI section).`}</p>

                <div class="flex-row">
                    <label for="iig_novelai_model">${t`Model`}</label>
                    <select id="iig_novelai_model" class="flex1">
                        ${NOVELAI_MODELS.map(m => `<option value="${m.value}" ${settings.novelaiModel === m.value ? 'selected' : ''}>${m.text}</option>`).join('')}
                    </select>
                    <div></div>
                </div>

                <div class="flex-row ${settings.novelaiModel === '__custom__' ? '' : 'iig-hidden'}" id="iig_novelai_custom_model_row">
                    <label for="iig_novelai_custom_model">${t`Custom model ID`}</label>
                    <input type="text" id="iig_novelai_custom_model" class="text_pole flex1" value="${sanitizeForHtml(settings.novelaiCustomModel || '')}" placeholder="nai-diffusion-5-...">
                    <div></div>
                </div>

                <div class="flex-row">
                    <label for="iig_novelai_sampler">${t`Sampler`}</label>
                    <select id="iig_novelai_sampler" class="flex1">
                        ${NOVELAI_SAMPLERS.map(s => `<option value="${s}" ${settings.novelaiSampler === s ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                    <div></div>
                </div>

                <div class="flex-row">
                    <label for="iig_novelai_scheduler">${t`Scheduler`}</label>
                    <select id="iig_novelai_scheduler" class="flex1">
                        ${NOVELAI_SCHEDULERS.map(s => `<option value="${s}" ${settings.novelaiScheduler === s ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                    <div></div>
                </div>

                <div class="flex-row">
                    <label for="iig_novelai_steps">${t`Steps`}</label>
                    <input type="number" id="iig_novelai_steps" class="text_pole flex1" min="1" max="50" step="1" value="${settings.novelaiSteps || 28}">
                    <div></div>
                </div>

                <div class="flex-row">
                    <label for="iig_novelai_scale">${t`CFG Scale`}</label>
                    <input type="number" id="iig_novelai_scale" class="text_pole flex1" min="1" max="30" step="0.5" value="${settings.novelaiScale || 5}">
                    <div></div>
                </div>

                <div class="flex-row">
                    <label for="iig_novelai_size">${t`Size`}</label>
                    <select id="iig_novelai_size" class="flex1">
                        ${NOVELAI_SIZES.map(s => `<option value="${s.value}" ${settings.novelaiSize === s.value ? 'selected' : ''}>${s.text}</option>`).join('')}
                    </select>
                    <div></div>
                </div>

                ${buildNovelaiNegativePresetBlockHtml(settings)}

                <label class="checkbox_label" style="margin-top: 8px;" title="${t`Automatically adjust parameters to ensure free image generation (Opus tier). Max 1024x1024 px, max 28 steps.`}">
                    <input type="checkbox" id="iig_novelai_anlas_guard" ${settings.novelaiAnlasGuard ? 'checked' : ''}>
                    <span>${t`Anlas Guard (free generation)`}</span>
                </label>

                <label class="checkbox_label">
                    <input type="checkbox" id="iig_novelai_decrisper" ${settings.novelaiDecrisper ? 'checked' : ''}>
                    <span>${t`Decrisper (dynamic thresholding)`}</span>
                </label>

                <label class="checkbox_label" style="margin-top: 8px;" title="${t`When disabled, NovelAI receives no images and all reference tabs are hidden.`}">
                    <input type="checkbox" id="iig_novelai_enable_references" ${settings.novelaiEnableReferences !== false ? 'checked' : ''}>
                    <span>${t`Send references to NovelAI`}</span>
                </label>

                <div class="flex-row">
                    <label for="iig_novelai_reference_type">${t`Reference type`}</label>
                    <select id="iig_novelai_reference_type" class="flex1">
                        <option value="character" ${settings.novelaiReferenceType === 'character' ? 'selected' : ''}>${t`Character`}</option>
                        <option value="style" ${settings.novelaiReferenceType === 'style' ? 'selected' : ''}>${t`Style`}</option>
                        <option value="character&style" ${settings.novelaiReferenceType === 'character&style' ? 'selected' : ''}>${t`Character and style`}</option>
                    </select>
                    <div></div>
                </div>

                <div class="flex-row">
                    <label for="iig_novelai_reference_strength">${t`Reference strength`}</label>
                    <input type="number" id="iig_novelai_reference_strength" class="text_pole flex1" min="-1" max="1" step="0.05" value="${settings.novelaiReferenceStrength ?? 1}">
                    <div></div>
                </div>

                <div class="flex-row">
                    <label for="iig_novelai_reference_fidelity">${t`Reference fidelity`}</label>
                    <input type="number" id="iig_novelai_reference_fidelity" class="text_pole flex1" min="-1" max="1" step="0.05" value="${settings.novelaiReferenceFidelity ?? 0.75}">
                    <div></div>
                </div>

                <p class="hint">${t`NovelAI Precise Reference is officially available for V4.5. Each reference adds Anlas cost; multiple character references may blend together.`}</p>

                <label class="checkbox_label">
                    <input type="checkbox" id="iig_novelai_variety_boost" ${settings.novelaiVarietyBoost ? 'checked' : ''}>
                    <span>${t`Variety+ (skip CFG above sigma)`}</span>
                </label>

                <label class="checkbox_label">
                    <input type="checkbox" id="iig_novelai_sm" ${settings.novelaiSm ? 'checked' : ''}>
                    <span>SMEA</span>
                </label>

                <label class="checkbox_label">
                    <input type="checkbox" id="iig_novelai_sm_dyn" ${settings.novelaiSmDyn ? 'checked' : ''}>
                    <span>${t`SMEA Dynamic`}</span>
                </label>

                <div class="iig-debug-actions" style="margin-top: 8px;">
                    <div id="iig_novelai_view_anlas" class="menu_button iig-button-inline">
                        <i class="fa-solid fa-coins"></i> ${t`View Anlas`}
                    </div>
                </div>
            </div>

            <div class="iig-settings-card-nested" id="iig_vision_section">
                <div class="iig-vision-head" data-iig-vision-toggle>
                    <h4>${t`Vision (outfit descriptions)`}</h4>
                    <i class="fa-solid fa-chevron-down iig-section-chevron iig-section-chevron-collapsed" id="iig_vision_chev"></i>
                </div>
                <div class="iig-vision-body iig-hidden" id="iig_vision_body">
                    <p class="hint">${t`Vision-capable model used to auto-generate outfit descriptions in the Wardrobe tab. If endpoint/key are empty, the main API settings are used.`}</p>

                    <div class="flex-row">
                        <label for="iig_vision_endpoint">${t`Vision endpoint`}</label>
                        <input type="text" id="iig_vision_endpoint" class="text_pole flex1" value="${sanitizeForHtml(settings.visionEndpoint || '')}" placeholder="${t`(empty = use main endpoint)`}">
                        <div></div>
                    </div>
                    <div class="flex-row">
                        <label for="iig_vision_api_key">${t`Vision API key`}</label>
                        <input type="password" id="iig_vision_api_key" class="text_pole flex1" value="${sanitizeForHtml(settings.visionApiKey || '')}" placeholder="${t`(empty = use main key)`}">
                        <div id="iig_vision_key_toggle" class="menu_button iig-key-toggle" title="${t`Show / hide`}">
                            <i class="fa-solid fa-eye"></i>
                        </div>
                    </div>
                    <div class="flex-row">
                        <label for="iig_vision_model_select">${t`Vision model`}</label>
                        <select id="iig_vision_model_select" class="flex1">
                            ${settings.visionModel
                                ? `<option value="${sanitizeForHtml(settings.visionModel)}" selected>${sanitizeForHtml(settings.visionModel)}</option>`
                                : `<option value="">${t`-- Select a model --`}</option>`}
                        </select>
                        <div id="iig_refresh_vision_models" class="menu_button iig-refresh-btn" title="${t`Refresh list`}">
                            <i class="fa-solid fa-sync"></i>
                        </div>
                    </div>
                    <div class="flex-col" style="margin-top: 8px;">
                        <label for="iig_vision_prompt">${t`Description prompt`}</label>
                        <textarea id="iig_vision_prompt" class="text_pole iig-settings-textarea" rows="3" placeholder="${sanitizeForHtml(DEFAULT_VISION_PROMPT)}">${sanitizeForHtml(settings.visionPrompt || '')}</textarea>
                    </div>
                </div>
            </div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_api_section', t`API settings`, bodyHtml, true);
}

// ----- Connection profiles -----

/**
 * После `loadConnectionProfile` в settings подменены все connection-поля.
 * Эта функция синхронизирует значения в уже отрисованных DOM-элементах
 * (input / select / checkbox), чтобы юзер увидел актуальное состояние
 * без полного re-render'а секции.
 */
function applyProfileValuesToInputs(settings) {
    const setVal = (id, value) => {
        const el = document.getElementById(id);
        if (el && 'value' in el) el.value = value ?? '';
    };
    const setChk = (id, value) => {
        const el = document.getElementById(id);
        if (el && 'checked' in el) el.checked = Boolean(value);
    };

    setVal('iig_api_type', settings.apiType);
    setVal('iig_endpoint', settings.endpoint);
    setChk('iig_raw_endpoint', settings.rawEndpoint);
    setVal('iig_api_key', settings.apiKey);
    setVal('iig_model', settings.model);
    // Select holds model too — add option on-the-fly if profile's model isn't
    // in the currently loaded list.
    const modelSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('iig_model_select'));
    if (modelSelect) {
        const hasOption = Array.from(modelSelect.options).some((o) => o.value === settings.model);
        if (!hasOption && settings.model) {
            const opt = document.createElement('option');
            opt.value = settings.model;
            opt.textContent = settings.model;
            modelSelect.appendChild(opt);
        }
        modelSelect.value = settings.model || '';
    }
    setVal('iig_size', settings.size);
    setVal('iig_quality', settings.quality);
    setVal('iig_aspect_ratio', settings.aspectRatio);
    setVal('iig_image_size', settings.imageSize);
    // Override lock buttons
    const arBtn = document.getElementById('iig_override_aspect_ratio_btn');
    if (arBtn) {
        arBtn.classList.toggle('iig-override-active', settings.overrideAspectRatio);
        const arIcon = arBtn.querySelector('i');
        if (arIcon) arIcon.className = `fa-solid fa-lock${settings.overrideAspectRatio ? '' : '-open'}`;
    }
    const isBtn = document.getElementById('iig_override_image_size_btn');
    if (isBtn) {
        isBtn.classList.toggle('iig-override-active', settings.overrideImageSize);
        const isIcon = isBtn.querySelector('i');
        if (isIcon) isIcon.className = `fa-solid fa-lock${settings.overrideImageSize ? '' : '-open'}`;
    }
    const naisteraModel = normalizeNaisteraModel(settings.naisteraModel);
    const naisteraSelect = document.getElementById('iig_naistera_model');
    if (naisteraSelect instanceof HTMLSelectElement && naisteraModel
        && !Array.from(naisteraSelect.options).some((option) => option.value === naisteraModel)) {
        naisteraSelect.add(new Option(naisteraModel, naisteraModel));
    }
    setVal('iig_naistera_model', naisteraModel);
    setVal('iig_naistera_aspect_ratio', settings.naisteraAspectRatio);
    setChk('iig_naistera_video_test', settings.naisteraVideoTest);
    setVal('iig_naistera_video_every_n', settings.naisteraVideoEveryN);
    // NovelAI fields
    setVal('iig_novelai_model', settings.novelaiModel);
    setVal('iig_novelai_custom_model', settings.novelaiCustomModel);
    setVal('iig_novelai_sampler', settings.novelaiSampler);
    setVal('iig_novelai_scheduler', settings.novelaiScheduler);
    setVal('iig_novelai_steps', settings.novelaiSteps);
    setVal('iig_novelai_scale', settings.novelaiScale);
    setVal('iig_novelai_size', settings.novelaiSize);
    setVal('iig_novelai_negative_prompt', settings.novelaiNegativePrompt);
    setChk('iig_novelai_anlas_guard', settings.novelaiAnlasGuard);
    setChk('iig_novelai_decrisper', settings.novelaiDecrisper);
    setChk('iig_novelai_variety_boost', settings.novelaiVarietyBoost);
    setChk('iig_novelai_sm', settings.novelaiSm);
    setChk('iig_novelai_sm_dyn', settings.novelaiSmDyn);
    setChk('iig_novelai_enable_references', settings.novelaiEnableReferences !== false);
    setVal('iig_novelai_reference_type', settings.novelaiReferenceType);
    setVal('iig_novelai_reference_strength', settings.novelaiReferenceStrength);
    setVal('iig_novelai_reference_fidelity', settings.novelaiReferenceFidelity);
    syncNovelaiNegativePresetControls(settings);

    // Re-render presets list (it's data-driven, not simple value sync).
    novelaiPresetSection.render();

    setChk('iig_send_char_avatar', settings.sendCharAvatar);
    setChk('iig_send_user_avatar', settings.sendUserAvatar);
    setChk('iig_use_active_persona_avatar', settings.useActiveUserPersonaAvatar);
    setChk('iig_naistera_send_char_avatar', settings.naisteraSendCharAvatar);
    setChk('iig_naistera_send_user_avatar', settings.naisteraSendUserAvatar);
    setChk('iig_naistera_use_active_persona_avatar', settings.useActiveUserPersonaAvatar);

    // Пересинхронизация avatar-дропдаунов (custom-элемент, не <select>).
    syncUserAvatarSelection(settings.userAvatarFile);
    syncActivePersonaAvatarMode(settings.useActiveUserPersonaAvatar);
}

function refreshProfileSelectOptions(settings) {
    const select = document.getElementById('iig_profile_select');
    if (!(select instanceof HTMLSelectElement)) return;
    const profiles = ensureConnectionProfiles(settings);
    select.innerHTML = profiles.map((p) =>
        `<option value="${p.id}" ${p.id === settings.activeConnectionProfileId ? 'selected' : ''}>${sanitizeForHtml(p.name)}</option>`,
    ).join('') || `<option value="">${t`(no profiles)`}</option>`;
}

export function bindConnectionProfilesEvents(settings, updateVisibility) {
    document.getElementById('iig_profile_select')?.addEventListener('change', (e) => {
        const id = e.target instanceof HTMLSelectElement ? e.target.value : '';
        if (!id) return;
        const profile = loadConnectionProfile(id, settings);
        if (!profile) return;
        saveSettings();
        applyProfileValuesToInputs(settings);
        updateVisibility();
        iigLog('INFO', `Loaded connection profile: ${profile.name} (${profile.apiType})`);
    });

    document.getElementById('iig_profile_save')?.addEventListener('click', () => {
        const profile = saveCurrentIntoProfile(null, settings);
        if (!profile) {
            toastr.warning(t`No active profile`, t`Image Generation`);
            return;
        }
        saveSettings();
        toastr.success(t`Profile "${profile.name}" saved`, t`Image Generation`, { timeOut: 1500 });
    });

    document.getElementById('iig_profile_save_as')?.addEventListener('click', async () => {
        const name = await Popup.show.input(t`New profile`, t`Enter a name for the new profile:`);
        if (!name) return;
        const profile = createConnectionProfile(name, settings);
        saveSettings();
        refreshProfileSelectOptions(settings);
        toastr.success(t`Created profile "${profile.name}"`, t`Image Generation`, { timeOut: 1500 });
    });

    document.getElementById('iig_profile_rename')?.addEventListener('click', async () => {
        const profile = getActiveConnectionProfile(settings);
        if (!profile) {
            toastr.warning(t`No active profile`, t`Image Generation`);
            return;
        }
        const newName = await Popup.show.input(t`Rename profile`, t`Enter a new name:`, profile.name);
        if (!newName) return;
        renameConnectionProfile(profile.id, newName, settings);
        saveSettings();
        refreshProfileSelectOptions(settings);
    });

    document.getElementById('iig_profile_remove')?.addEventListener('click', async () => {
        const profile = getActiveConnectionProfile(settings);
        if (!profile) return;
        const confirmed = await Popup.show.confirm(t`Delete profile`, t`Delete profile "${profile.name}"? This cannot be undone.`);
        if (!confirmed) return;
        const ok = removeConnectionProfile(profile.id, settings);
        if (!ok) {
            toastr.warning(t`Cannot delete the last profile`, t`Image Generation`);
            return;
        }
        // Загружаем новый активный в settings чтобы синхронизировать DOM.
        if (settings.activeConnectionProfileId) {
            loadConnectionProfile(settings.activeConnectionProfileId, settings);
        }
        saveSettings();
        refreshProfileSelectOptions(settings);
        applyProfileValuesToInputs(settings);
        updateVisibility();
    });
}

// ----- API section events -----

export function bindApiSectionEvents(settings, updateVisibility) {
    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_external_blocks')?.addEventListener('change', (e) => {
        settings.externalBlocks = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_image_context_enabled')?.addEventListener('change', (e) => {
        settings.imageContextEnabled = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_image_context_count')?.addEventListener('input', (e) => {
        const normalized = normalizeImageContextCount(e.target.value);
        settings.imageContextCount = normalized;
        e.target.value = String(normalized);
        saveSettings();
    });

    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        const nextApiType = e.target.value;
        const endpointInput = document.getElementById('iig_endpoint');
        if (shouldReplaceEndpointForApiType(nextApiType, settings.endpoint)) {
            settings.endpoint = normalizeConfiguredEndpoint(nextApiType, '');
            if (endpointInput) {
                endpointInput.value = settings.endpoint;
            }
        } else if (nextApiType === 'naistera') {
            settings.endpoint = normalizeConfiguredEndpoint(nextApiType, settings.endpoint);
            if (endpointInput) {
                endpointInput.value = settings.endpoint;
            }
        }
        settings.apiType = nextApiType;
        saveSettings();
        updateVisibility();

        // Switching providers → модель из прошлого провайдера скорее всего
        // невалидна. Подтягиваем список нового провайдера, если это не raw
        // NovelAI uses SillyTavern's own selector/proxy and has no discovery here.
        if (!settings.rawEndpoint && nextApiType !== 'novelai') {
            reloadModelList({ announce: false }).catch(() => { /* silent */ });
        }
    });

    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => {
        settings.endpoint = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_api_key')?.addEventListener('input', (e) => {
        settings.apiKey = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.replace('fa-eye-slash', 'fa-eye');
        }
    });

    // Две формы ввода модели: <select> для обычного режима (с fetchModels)
    // и <input> для raw-режима (свободный ввод). Видимость переключается
    // по rawEndpoint. Оба держим синхронно, чтобы юзер не терял значение
    // при переключении.
    const syncModelInputs = (value) => {
        const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('iig_model_select'));
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById('iig_model'));
        if (input && input.value !== value) input.value = value ?? '';
        if (select) {
            const hasOption = Array.from(select.options).some((o) => o.value === value);
            if (!hasOption && value) {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = `${value} ${t`(custom)`}`;
                select.appendChild(opt);
            }
            if (select.value !== value) select.value = value ?? '';
        }
    };

    const modelApplyChange = (value) => {
        settings.model = value;
        saveSettings();
        syncModelInputs(value);

        // Auto-switch API type на 'gemini' применим только если сейчас
        // выбран OpenAI (legacy — когда юзер через OpenAI endpoint выбрал
        // nano-banana). Для openrouter/gemini/naistera не трогаем.
        if (settings.apiType === 'openai' && isGeminiModel(value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
        }

        // Модель влияет на поддержку референсов (gpt-image-* vs dall-e-*),
        // поэтому перестраиваем видимость секций при любой смене.
        updateVisibility();
    };
    document.getElementById('iig_model_select')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLSelectElement) modelApplyChange(e.target.value);
    });
    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement) modelApplyChange(e.target.value);
    });
    document.getElementById('iig_model')?.addEventListener('input', (e) => {
        if (e.target instanceof HTMLInputElement) modelApplyChange(e.target.value);
    });

    /**
     * Populates the model <select> from provider.fetchModels. Preserves the
     * currently selected value: if settings.model is not in the fetched list,
     * it is appended as a "(custom)" option so the user doesn't lose it.
     * announce=true shows a toastr with model count / error.
     */
    async function reloadModelList({ announce = false } = {}) {
        const isNaistera = settings.apiType === 'naistera';
        const select = /** @type {HTMLSelectElement|null} */ (document.getElementById(
            isNaistera ? 'iig_naistera_model' : 'iig_model_select',
        ));
        const btn = document.getElementById(isNaistera ? 'iig_refresh_naistera_models' : 'iig_refresh_models');
        btn?.classList.add('loading');
        try {
            const models = await fetchModels();
            if (select) {
                let current = isNaistera ? normalizeNaisteraModel(settings.naisteraModel) : (settings.model || '');
                if (isNaistera && models.length > 0 && !models.includes(current)) {
                    current = models[0];
                    settings.naisteraModel = current;
                    saveSettings();
                    updateVisibility();
                }
                const provider = resolveActiveProvider(settings);
                const inList = current && models.includes(current);
                const optionsHtml = [
                    ...models.map((m) => `<option value="${sanitizeForHtml(m)}" ${m === current ? 'selected' : ''}>${sanitizeForHtml(provider?.getModelLabel?.(m) || m)}</option>`),
                    ...(!inList && current ? [`<option value="${sanitizeForHtml(current)}" selected>${sanitizeForHtml(current)}${isNaistera ? '' : ` ${t`(custom)`}`}</option>`] : []),
                    ...(models.length === 0 && !current ? [`<option value="" selected disabled>${t`-- Select a model --`}</option>`] : []),
                ];
                select.innerHTML = optionsHtml.join('');
                if (isNaistera) updateVisibility();
            }
            if (announce && models.length > 0) {
                toastr.success(t`Models found: ${models.length}`, t`Image Generation`);
            } else if (announce && models.length === 0) {
                toastr.warning(t`No models returned by endpoint`, t`Image Generation`);
            }
            return models;
        } catch (error) {
            if (announce) {
                toastr.error(t`Failed to load models`, t`Image Generation`);
            }
            return [];
        } finally {
            btn?.classList.remove('loading');
        }
    }

    document.getElementById('iig_refresh_models')?.addEventListener('click', () => {
        reloadModelList({ announce: true });
    });
    document.getElementById('iig_refresh_naistera_models')?.addEventListener('click', () => {
        reloadModelList({ announce: true });
    });

    document.getElementById('iig_raw_endpoint')?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.rawEndpoint = e.target.checked;
        saveSettings();

        const select = document.getElementById('iig_model_select');
        if (settings.rawEndpoint) {
            select?.classList.add('iig-hidden');
        } else {
            select?.classList.remove('iig-hidden');
            reloadModelList({ announce: true });
        }
    });

    document.getElementById('iig_size')?.addEventListener('change', (e) => {
        settings.size = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_quality')?.addEventListener('change', (e) => {
        settings.quality = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => {
        settings.aspectRatio = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_override_aspect_ratio_btn')?.addEventListener('click', () => {
        settings.overrideAspectRatio = !settings.overrideAspectRatio;
        const btn = document.getElementById('iig_override_aspect_ratio_btn');
        btn?.classList.toggle('iig-override-active', settings.overrideAspectRatio);
        const icon = btn?.querySelector('i');
        if (icon) icon.className = `fa-solid fa-lock${settings.overrideAspectRatio ? '' : '-open'}`;
        saveSettings();
    });

    document.getElementById('iig_image_size')?.addEventListener('change', (e) => {
        settings.imageSize = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_override_image_size_btn')?.addEventListener('click', () => {
        settings.overrideImageSize = !settings.overrideImageSize;
        const btn = document.getElementById('iig_override_image_size_btn');
        btn?.classList.toggle('iig-override-active', settings.overrideImageSize);
        const icon = btn?.querySelector('i');
        if (icon) icon.className = `fa-solid fa-lock${settings.overrideImageSize ? '' : '-open'}`;
        saveSettings();
    });

    document.getElementById('iig_naistera_model')?.addEventListener('change', (e) => {
        settings.naisteraModel = normalizeNaisteraModel(e.target.value);
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_naistera_aspect_ratio')?.addEventListener('change', (e) => {
        settings.naisteraAspectRatio = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_naistera_video_test')?.addEventListener('change', (e) => {
        settings.naisteraVideoTest = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_naistera_video_every_n')?.addEventListener('input', (e) => {
        const normalized = normalizeNaisteraVideoFrequency(e.target.value);
        settings.naisteraVideoEveryN = normalized;
        e.target.value = String(normalized);
        saveSettings();
    });

    // ElectronHub specific parameters
    document.getElementById('iig_electronhub_style')?.addEventListener('change', (e) => {
        settings.electronhubStyle = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_electronhub_negative_prompt')?.addEventListener('input', (e) => {
        settings.electronhubNegativePrompt = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_electronhub_guidance_scale')?.addEventListener('input', (e) => {
        const value = parseFloat(e.target.value);
        settings.electronhubGuidanceScale = isNaN(value) ? 7.5 : value;
        saveSettings();
    });

    document.getElementById('iig_electronhub_steps')?.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        settings.electronhubSteps = isNaN(value) ? 50 : value;
        saveSettings();
    });

    document.getElementById('iig_electronhub_enable_references')?.addEventListener('change', (e) => {
        settings.electronhubEnableReferences = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    // NovelAI specific parameters
    document.getElementById('iig_novelai_model')?.addEventListener('change', (e) => {
        settings.novelaiModel = e.target.value;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_novelai_custom_model')?.addEventListener('input', (e) => {
        settings.novelaiCustomModel = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_novelai_sampler')?.addEventListener('change', (e) => {
        settings.novelaiSampler = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_novelai_scheduler')?.addEventListener('change', (e) => {
        settings.novelaiScheduler = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_novelai_steps')?.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        settings.novelaiSteps = isNaN(value) ? 28 : Math.min(Math.max(value, 1), 50);
        saveSettings();
    });

    document.getElementById('iig_novelai_scale')?.addEventListener('input', (e) => {
        const value = parseFloat(e.target.value);
        settings.novelaiScale = isNaN(value) ? 5 : value;
        saveSettings();
    });

    document.getElementById('iig_novelai_size')?.addEventListener('change', (e) => {
        settings.novelaiSize = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_novelai_negative_prompt')?.addEventListener('input', (e) => {
        settings.novelaiNegativePrompt = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_novelai_negative_preset_select')?.addEventListener('change', (e) => {
        settings.activeNovelaiNegativePresetId = e.target.value;
        const active = getActiveNovelaiNegativePreset(settings);
        settings.novelaiNegativePrompt = active?.value || '';
        syncNovelaiNegativePresetControls(settings);
        saveSettings();
    });

    document.getElementById('iig_novelai_negative_preset_new')?.addEventListener('click', async () => {
        const name = await Popup.show.input(t`New negative preset`, t`Enter a preset name:`);
        if (!name) return;
        const item = createNovelaiNegativePreset(name);
        const promptInput = document.getElementById('iig_novelai_negative_prompt');
        updateNovelaiNegativePreset(item.id, { value: promptInput?.value || '' });
        settings.novelaiNegativePrompt = promptInput?.value || '';
        syncNovelaiNegativePresetControls(settings);
        saveSettings();
    });

    document.getElementById('iig_novelai_negative_preset_save')?.addEventListener('click', () => {
        const active = getActiveNovelaiNegativePreset(settings);
        if (!active) return;
        const name = document.getElementById('iig_novelai_negative_preset_name')?.value || active.name;
        const value = document.getElementById('iig_novelai_negative_prompt')?.value || '';
        updateNovelaiNegativePreset(active.id, { name, value });
        settings.novelaiNegativePrompt = value;
        syncNovelaiNegativePresetControls(settings);
        saveSettings();
        toastr.success(t`Negative preset saved`, 'NovelAI');
    });

    document.getElementById('iig_novelai_negative_preset_delete')?.addEventListener('click', async () => {
        const active = getActiveNovelaiNegativePreset(settings);
        if (!active) return;
        const confirmed = await Popup.show.confirm(t`Delete negative preset`, t`Delete preset "${active.name}"?`);
        if (!confirmed) return;
        removeNovelaiNegativePreset(active.id);
        const next = getActiveNovelaiNegativePreset(settings);
        settings.novelaiNegativePrompt = next?.value || '';
        syncNovelaiNegativePresetControls(settings);
        saveSettings();
    });

    document.getElementById('iig_novelai_anlas_guard')?.addEventListener('change', (e) => {
        settings.novelaiAnlasGuard = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_novelai_decrisper')?.addEventListener('change', (e) => {
        settings.novelaiDecrisper = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_novelai_variety_boost')?.addEventListener('change', (e) => {
        settings.novelaiVarietyBoost = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_novelai_sm')?.addEventListener('change', (e) => {
        settings.novelaiSm = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_novelai_sm_dyn')?.addEventListener('change', (e) => {
        settings.novelaiSmDyn = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_novelai_enable_references')?.addEventListener('change', (e) => {
        settings.novelaiEnableReferences = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_novelai_reference_type')?.addEventListener('change', (e) => {
        settings.novelaiReferenceType = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_novelai_reference_strength')?.addEventListener('input', (e) => {
        const value = Number.parseFloat(e.target.value);
        settings.novelaiReferenceStrength = Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 1;
        saveSettings();
    });

    document.getElementById('iig_novelai_reference_fidelity')?.addEventListener('input', (e) => {
        const value = Number.parseFloat(e.target.value);
        settings.novelaiReferenceFidelity = Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0.75;
        saveSettings();
    });

    document.getElementById('iig_novelai_view_anlas')?.addEventListener('click', async () => {
        const { getRequestHeaders } = SillyTavern.getContext();
        try {
            const result = await fetch('/api/novelai/status', {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            if (!result.ok) {
                toastr.warning(t`Could not load NovelAI subscription data. Is the API key set in SillyTavern settings?`, 'NovelAI');
                return;
            }
            const data = await result.json();
            if (data.error) {
                toastr.warning(t`Could not load NovelAI subscription data. Is the API key set in SillyTavern settings?`, 'NovelAI');
                return;
            }
            const anlas = data?.trainingStepsLeft?.fixedTrainingStepsLeft ?? 0;
            const unlimited = data?.perks?.unlimitedImageGeneration ?? false;
            toastr.info(`${t`Free image generation`}: ${unlimited ? t`Yes` : t`No`}`, `Anlas: ${anlas}`);
        } catch (error) {
            toastr.error(String(error?.message || error), 'NovelAI');
        }
    });

    // Auto-populate model list on init so the <select> isn't empty when the
    // user first opens settings. In raw mode the select is hidden anyway,
    // Naistera uses the same discovery flow with its own selector.
    if (!settings.rawEndpoint && settings.apiType !== 'novelai') {
        reloadModelList({ announce: false }).catch(() => { /* silent on init */ });
    }
}
