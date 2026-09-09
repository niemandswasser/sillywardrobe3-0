/**
 * Базовый класс Provider и общие request-хелперы, используемые всеми
 * провайдерами: построение URL, единый разбор ошибок, извлечение картинки
 * из OpenAI-совместимого ответа.
 */

import {
    getSettings,
    IMAGE_MODEL_KEYWORDS,
    VIDEO_MODEL_KEYWORDS,
    ENDPOINT_PLACEHOLDERS,
    MAX_GENERATION_REFERENCE_IMAGES,
    getEffectiveEndpoint,
} from '../settings.js';
import { ProviderError } from '../utils.js';
import { t } from '../i18n.js';

// ----- Endpoint URL builder (raw mode support) -----

/**
 * Возвращает URL для POST-запроса генерации с учётом флага `rawEndpoint`.
 * В raw-режиме суффикс игнорируется — используется endpoint целиком.
 *
 * @param {object} settings
 * @param {string} pathSuffix — путь, который дописывается в обычном режиме
 *   (например, `/v1/images/generations`). Должен начинаться со `/`.
 * @returns {string} абсолютный URL
 */
export function buildGenerationUrl(settings, pathSuffix) {
    const base = (getEffectiveEndpoint(settings) || String(settings.endpoint || '')).replace(/\/$/, '');
    if (settings.rawEndpoint) {
        return base;
    }
    return `${base}${pathSuffix}`;
}

// ----- Model detection -----

export function isImageModel(modelId) {
    const mid = String(modelId || '').toLowerCase();

    // Exclude video models
    for (const kw of VIDEO_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return false;
    }

    // Exclude vision models
    if (mid.includes('vision') && mid.includes('preview')) return false;

    // Check for image model keywords
    for (const kw of IMAGE_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return true;
    }

    return false;
}

// ----- Setting resolution -----

export function isAutoGenerationValue(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return !normalized || normalized === 'auto' || normalized === 'prompt';
}

export function resolveLockedSetting(value, fallback = '') {
    return isAutoGenerationValue(value) ? fallback : String(value).trim();
}

// ----- Error handling -----

/**
 * Парсит ответ-ошибку OpenAI-совместимого API в единообразный вид.
 */
export async function parseOpenAIError(response) {
    const raw = await response.text().catch(() => '');
    let payload = null;
    try {
        payload = raw ? JSON.parse(raw) : null;
    } catch (_e) {
        payload = null;
    }
    const err = payload?.error || {};
    const message = err.message || err.detail || raw || `HTTP ${response.status}`;
    const code = err.code || err.type || String(response.status);
    return { message: String(message).slice(0, 800), code, status: response.status };
}

/**
 * Переводит TypeError/AbortError, возникающие при `fetch` на сетевом уровне,
 * в ProviderError с понятным текстом и `retryable: true`. Вызывается
 * вокруг `fetchWithTimeout` в провайдерах.
 *
 * Если это уже ProviderError — пробрасывается как есть.
 *
 * @param {unknown} error
 * @param {string} endpointLabel — короткое имя endpoint-а для сообщения.
 * @param {string} providerId
 */
export function throwAsProviderError(error, endpointLabel, providerId) {
    if (error instanceof ProviderError) {
        throw error;
    }
    // AbortError = наш таймаут (fetchWithTimeout) или внешний abort.
    if (error?.name === 'AbortError') {
        throw new ProviderError({
            message: t`Request to ${endpointLabel} timed out. Check your connection and try regenerating.`,
            code: 'timeout',
            retryable: true,
            providerId,
            cause: error,
        });
    }
    // TypeError: Failed to fetch — DNS, CORS, сервер недоступен, ERR_CONNECTION_*.
    if (error?.name === 'TypeError') {
        throw new ProviderError({
            message: t`Connection problem with ${endpointLabel}. Server is unreachable or blocked. Try regenerating.`,
            code: 'network',
            retryable: true,
            providerId,
            cause: error,
        });
    }
    // Неожиданная ошибка — заворачиваем в ProviderError с retryable=false,
    // чтобы pipeline не ретраил подозрительное.
    throw new ProviderError({
        message: String(error?.message || error) || 'Unknown provider error',
        code: 'unknown',
        retryable: false,
        providerId,
        cause: error,
    });
}

// ----- Result extraction -----

/**
 * Распаковывает результат /generations или /edits.
 * OpenAI: `data[0].b64_json` (для gpt-image-* всегда) или `data[0].url`.
 */
export function extractImageFromResult(result) {
    const dataList = Array.isArray(result?.data) ? result.data : [];
    if (dataList.length === 0) {
        if (result?.url) return result.url;
        throw new Error('No image data in response');
    }
    const imageObj = dataList[0];
    if (imageObj?.b64_json) {
        return `data:image/png;base64,${imageObj.b64_json}`;
    }
    if (imageObj?.url) {
        return imageObj.url;
    }
    throw new Error('Response data[0] has no b64_json or url');
}

// ----- Base Provider -----

/**
 * @typedef {object} ProviderCapabilities
 * @property {string} endpointPlaceholder
 * @property {boolean} requiresApiKey
 * @property {number} referencesMaxCount
 * @property {'base64' | 'dataUrl' | 'none'} referencesFormat
 */

export class Provider {
    /** @type {string} */
    get id() { throw new Error('Provider.id not implemented'); }
    /** @type {string} */
    get displayName() { return this.id; }
    /** @type {ProviderCapabilities} */
    get capabilities() {
        return {
            endpointPlaceholder: ENDPOINT_PLACEHOLDERS[this.id] || 'https://api.example.com',
            requiresApiKey: true,
            referencesMaxCount: MAX_GENERATION_REFERENCE_IMAGES,
            referencesFormat: 'base64',
        };
    }

    /**
     * Pre-run validation. Вызывается из pipeline перед generate.
     * @param {object} settings
     * @returns {string[]} список ошибок (пустой — всё ок)
     */
    validate(settings) {
        const errors = [];
        const caps = this.capabilities;
        if (!settings.endpoint && this.id !== 'naistera') {
            errors.push(t`Endpoint URL is not configured`);
        }
        if (caps.requiresApiKey && !settings.apiKey) {
            errors.push(t`API key is not configured`);
        }
        return errors;
    }

    /**
     * Поддерживает ли текущая конфигурация (apiType + model) референсы.
     * UI использует это чтобы показать/скрыть блоки «Аватары», «Контекст
     * картинок», «Дополнительные референсы». По умолчанию — да, каждый
     * провайдер может переопределить.
     */
    supportsReferences(_settings) {
        return true;
    }

    /**
     * Собирает referenceImages в формате, который ожидает `generate`.
     * Возвращаемое значение отдаётся `generate` как-есть, pipeline не вмешивается.
     *
     * @param {{ prompt: string, messageId?: number, matchedAdditionalRefs?: any[] }} ctx
     * @returns {Promise<any[]>}
     */
    async collectReferences(_ctx) {
        return [];
    }

    /**
     * Главная функция — делает сетевой запрос и возвращает либо data URL строкой,
     * либо `{ kind: 'video', dataUrl, posterDataUrl?, contentType }`.
     *
     * @param {{ prompt: string, style: string, references: any[], options: object }} request
     */
    async generate(_request) {
        throw new Error(`Provider[${this.id}].generate() not implemented`);
    }

    /**
     * Возвращает список id моделей, доступных для генерации.
     *
     * Базовая реализация — OpenAI-совместимый `GET {endpoint}/v1/models`
     * + фильтр по `isImageModel`. Провайдеры, у которых формат другой
     * (OpenRouter, hypothetical custom endpoints), переопределяют.
     *
     * @returns {Promise<string[]>}
     */
    async fetchModels(settingsOverride = null) {
        const settings = settingsOverride || getSettings();
        const endpoint = getEffectiveEndpoint(settings);

        if (!endpoint || !settings.apiKey) {
            console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
            return [];
        }

        const url = `${endpoint}/v1/models`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const models = data.data || [];
        return models.filter(m => isImageModel(m.id)).map(m => m.id);
    }
}
