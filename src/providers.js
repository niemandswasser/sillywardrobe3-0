/**
 * Реестр провайдеров генерации + публичный API модуля.
 *
 * Реализации разнесены по src/providers/:
 *   base.js        — базовый класс Provider и общие request-хелперы
 *   caps.js        — классификация моделей и capabilities
 *   openai.js      — OpenAI и совместимые прокси
 *   gemini.js      — Gemini / nano-banana (нативный API)
 *   openrouter.js  — OpenRouter (chat/completions + modalities)
 *   electronhub.js — Electron Hub (наследует OpenAIProvider)
 *   naistera.js    — Naistera (картинки + видео)
 *   voidai.js      — VoidAI / RouteMyAI
 *   aigate.js      — AIGate (гибрид Gemini + GPT Image)
 *   novelai.js     — NovelAI через ST-прокси
 *
 * Внешние модули (pipeline, ui, wardrobe) импортируют всё отсюда —
 * этот файл сохраняет прежний публичный API.
 */

import { getSettings, iigLog } from './settings.js';
import { t } from './i18n.js';
import { Provider, buildGenerationUrl, isImageModel } from './providers/base.js';
import {
    isGeminiModel,
    classifyGeminiModel,
    getGeminiCapabilities,
    classifyOpenRouterModel,
    getOpenRouterCapabilities,
    getActiveProviderMaxReferences,
} from './providers/caps.js';
import { OpenAIProvider } from './providers/openai.js';
import { GeminiProvider } from './providers/gemini.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { ElectronHubProvider } from './providers/electronhub.js';
import { NaisteraProvider } from './providers/naistera.js';
import { VoidProvider } from './providers/voidai.js';
import { AIGateProvider } from './providers/aigate.js';
import { NovelAIProvider } from './providers/novelai.js';

// Re-exports — сохраняем прежний публичный API providers.js.
export {
    Provider,
    buildGenerationUrl,
    isImageModel,
    isGeminiModel,
    classifyGeminiModel,
    getGeminiCapabilities,
    classifyOpenRouterModel,
    getOpenRouterCapabilities,
    getActiveProviderMaxReferences,
    OpenAIProvider,
    GeminiProvider,
    OpenRouterProvider,
    ElectronHubProvider,
    NaisteraProvider,
    VoidProvider,
    AIGateProvider,
    NovelAIProvider,
};

// ----- Registry -----

const providers = new Map();

/** @param {Provider} provider */
export function registerProvider(provider) {
    providers.set(provider.id, provider);
}

/** @returns {Provider | undefined} */
export function getProviderById(id) {
    return providers.get(id);
}

export function getAllProviders() {
    return Array.from(providers.values());
}

/**
 * Резолвит активного провайдера с учётом model-detection для nano-banana моделей
 * поверх apiType='openai'.
 */
export function resolveActiveProvider(settings = getSettings()) {
    if (settings.apiType === 'openai' && isGeminiModel(settings.model)) {
        return providers.get('gemini');
    }
    return providers.get(settings.apiType);
}

// Default registration.
registerProvider(new OpenAIProvider());
registerProvider(new GeminiProvider());
registerProvider(new OpenRouterProvider());
registerProvider(new ElectronHubProvider());
registerProvider(new NaisteraProvider());
registerProvider(new VoidProvider());
registerProvider(new AIGateProvider());
registerProvider(new NovelAIProvider());

// ----- Models fetcher (делегируется провайдеру) -----

export async function fetchModels() {
    const settings = getSettings();
    const provider = resolveActiveProvider(settings);
    if (!provider) {
        console.warn('[IIG] fetchModels: no active provider for apiType=', settings.apiType);
        return [];
    }

    // Raw endpoint mode: юзер дал полный URL генерации; дискавери моделей
    // не производится — юзер вводит имя модели вручную.
    if (settings.rawEndpoint) {
        iigLog('INFO', 'fetchModels skipped: raw endpoint mode (enter model name manually)');
        toastr.info(t`Raw endpoint mode: enter model name manually`, t`Image Generation`, { timeOut: 3000 });
        return [];
    }

    try {
        return await provider.fetchModels();
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error(t`Failed to load models: ${error.message}`, t`Image Generation`);
        return [];
    }
}

// ----- Validation (общий entry, используется pipeline) -----

export function validateSettings(settings = getSettings()) {
    const provider = resolveActiveProvider(settings);
    if (!provider) {
        throw new Error(t`Settings error: unknown API (${settings.apiType})`);
    }
    const errors = provider.validate(settings);

    // Общий чек: для openai/gemini требуется model.
    if (provider.id !== 'naistera' && provider.id !== 'novelai' && !settings.model) {
        errors.push(t`Model is not selected`);
    }

    if (errors.length > 0) {
        throw new Error(t`Settings error: ${errors.join(', ')}`);
    }
}
