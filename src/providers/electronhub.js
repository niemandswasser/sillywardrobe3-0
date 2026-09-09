/**
 * Electron Hub — OpenAI-совместимый прокси с 200+ моделями.
 *
 * Особенности:
 *   - Поддерживает стандартные OpenAI endpoints (/v1/images/generations, /v1/images/edits)
 *   - Добавляет расширенные параметры: style, negative_prompt, guidance_scale, steps
 *   - `/v1/images/edits` принимает только один `image` (без `image[]`)
 *   - `/v1/models` возвращает модели с полем `endpoints` для фильтрации
 *
 * Документация: https://docs.electronhub.ai/examples/image-examples
 */

import {
    getSettings,
    iigLog,
    getEffectiveEndpoint,
    getEffectiveRefInstruction,
} from '../settings.js';
import {
    fetchWithTimeout,
    ProviderError,
    isRetryableHttpStatus,
} from '../utils.js';
import { buildFinalGenerationPrompt } from '../parser.js';
import { t } from '../i18n.js';
import {
    buildGenerationUrl,
    resolveLockedSetting,
    parseOpenAIError,
    throwAsProviderError,
    extractImageFromResult,
    isImageModel,
} from './base.js';
import { OpenAIProvider } from './openai.js';

const ELECTRONHUB_DEFAULT_ENDPOINT = 'https://api.electronhub.ai';
const ELECTRONHUB_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Конвертирует aspect_ratio в size для ElectronHub моделей.
 * Разные модели поддерживают разные размеры.
 *
 * @param {string} aspect - aspect ratio (например, "3:2", "16:9")
 * @param {string} modelId - ID модели ElectronHub
 * @returns {string|null} - размер в формате WxH или null
 */
function electronHubAspectToSize(aspect, modelId) {
    if (!aspect) return null;

    const mid = String(modelId || '').toLowerCase();

    // NAI Diffusion models (nai-diffusion-*)
    // Доступные размеры: 1024x1024, 512x1024, 1024x512, 832x1216, 1216x832, 704x1280, 1280x704, 768x1024, 1024x768
    if (mid.includes('nai-diffusion')) {
        const map = {
            '1:1': '1024x1024',
            '1:2': '512x1024',
            '2:1': '1024x512',
            '2:3': '832x1216',
            '3:2': '1216x832',
            '9:16': '704x1280',
            '16:9': '1280x704',
            '3:4': '768x1024',
            '4:3': '1024x768',
        };
        return map[aspect] || '1024x1024';
    }

    // Stable Diffusion models (sd-*, sdxl-*)
    // Обычно поддерживают стандартные размеры
    if (mid.includes('sd-') || mid.includes('sdxl-') || mid.includes('stable-diffusion')) {
        const map = {
            '1:1': '1024x1024',
            '16:9': '1536x864',
            '9:16': '864x1536',
            '3:2': '1536x1024',
            '2:3': '1024x1536',
            '4:3': '1536x1152',
            '3:4': '1152x1536',
            '21:9': '1792x768',
        };
        return map[aspect] || '1024x1024';
    }

    // Flux models
    if (mid.includes('flux')) {
        const map = {
            '1:1': '1024x1024',
            '16:9': '1344x768',
            '9:16': '768x1344',
            '3:2': '1216x832',
            '2:3': '832x1216',
            '4:3': '1152x896',
            '3:4': '896x1152',
        };
        return map[aspect] || '1024x1024';
    }

    // Generic fallback - стандартные размеры
    const map = {
        '1:1': '1024x1024',
        '16:9': '1536x864',
        '9:16': '864x1536',
        '3:2': '1536x1024',
        '2:3': '1024x1536',
        '4:3': '1536x1152',
        '3:4': '1152x1536',
    };
    return map[aspect] || '1024x1024';
}

export class ElectronHubProvider extends OpenAIProvider {
    get id() { return 'electronhub'; }
    get displayName() { return 'Electron Hub'; }

    /**
     * Валидация: endpoint опционален (есть дефолт), apiKey обязателен.
     */
    validate(settings) {
        const errors = [];
        if (!settings.apiKey) {
            errors.push(t`API key is not configured`);
        }
        return errors;
    }

    /**
     * ElectronHub не поддерживает референсы - большинство моделей не поддерживают /v1/images/edits.
     * Используем только /v1/images/generations без референсов.
     * Но пользователь может включить экспериментальную поддержку через настройку.
     */
    supportsReferences(settings) {
        return settings.electronhubEnableReferences === true;
    }

    /**
     * Переопределяем generate для добавления ElectronHub-специфичных параметров.
     */
    async generate({ prompt, style, references = [], options = {} }) {
        const settings = options.providerSettings || getSettings();
        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

        // Префикс refInstruction только когда есть референсы
        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        // ElectronHub использует свою систему размеров, зависящую от модели
        const optionAspectRatio = resolveLockedSetting(options.aspectRatio);
        const configuredAspectRatio = resolveLockedSetting(settings.aspectRatio);
        const aspectRatio = optionAspectRatio || configuredAspectRatio;

        // Конвертируем aspect_ratio в size для конкретной модели ElectronHub
        const requestedSize = aspectRatio
            ? electronHubAspectToSize(aspectRatio, settings.model)
            : (resolveLockedSetting(settings.size) || '1024x1024');

        // ElectronHub-специфичные параметры
        const electronhubStyle = resolveLockedSetting(settings.electronhubStyle || options.electronhubStyle);
        const negativePrompt = String(settings.electronhubNegativePrompt || '').trim();
        const guidanceScale = parseFloat(settings.electronhubGuidanceScale) || null;
        const steps = parseInt(settings.electronhubSteps) || null;

        iigLog(
            'INFO',
            `ElectronHub generate: model=${settings.model} aspect=${aspectRatio || '(none)'} size=${requestedSize} style=${electronhubStyle || '(none)'} refs=${references.length} raw=${!!settings.rawEndpoint}`
        );

        // ElectronHub: всегда используем /v1/images/generations (большинство моделей не поддерживают /edits)
        return await this._generateWithGenerationsElectronHub({
            url: buildGenerationUrl(settings, '/v1/images/generations'),
            apiKey: settings.apiKey,
            model: settings.model,
            prompt: fullPrompt,
            size: requestedSize,
            electronhubStyle,
            negativePrompt,
            guidanceScale,
            steps,
            signal: options.signal,
        });
    }

    /**
     * /v1/images/generations с ElectronHub-специфичными параметрами.
     */
    async _generateWithGenerationsElectronHub({ url, apiKey, model, prompt, size, electronhubStyle, negativePrompt, guidanceScale, steps, signal }) {
        const body = {
            model,
            prompt,
            n: 1,
        };

        // ElectronHub использует параметр size в формате WxH (например, "1536x1024")
        if (size) body.size = size;

        // ElectronHub расширенные параметры
        if (electronhubStyle) body.style = electronhubStyle;
        if (negativePrompt) body.negative_prompt = negativePrompt;
        if (guidanceScale !== null && guidanceScale > 0) body.guidance_scale = guidanceScale;
        if (steps !== null && steps > 0) body.steps = steps;

        // response_format=b64_json всегда для ElectronHub
        body.response_format = 'b64_json';

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, ELECTRONHUB_REQUEST_TIMEOUT_MS, signal);
        } catch (error) {
            throwAsProviderError(error, `ElectronHub /v1/images/generations (${url})`, 'electronhub');
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `ElectronHub /generations ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'electronhub',
            });
        }

        const result = await response.json();
        return extractImageFromResult(result);
    }

    /**
     * Список image-моделей через фильтр по полю `endpoints`.
     */
    async fetchModels(settingsOverride = null) {
        const settings = settingsOverride || getSettings();
        const endpoint = (getEffectiveEndpoint(settings) || ELECTRONHUB_DEFAULT_ENDPOINT).replace(/\/$/, '');

        if (!settings.apiKey) {
            console.warn('[IIG] Electron Hub fetchModels: API key not set');
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
        const models = Array.isArray(data?.data) ? data.data : [];

        return models.filter((m) => {
            const eps = Array.isArray(m?.endpoints) ? m.endpoints.map(String) : null;
            if (eps && eps.length > 0) {
                return eps.some((e) =>
                    e.includes('/images/generations') || e.includes('/images/edits'),
                );
            }
            return isImageModel(m.id);
        }).map((m) => m.id).filter(Boolean);
    }
}
