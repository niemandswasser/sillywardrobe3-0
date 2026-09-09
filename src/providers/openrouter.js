/**
 * OpenRouter: chat/completions с modalities=image, референсы — data URL
 * в image_url-частях сообщения.
 */

import {
    getSettings,
    iigLog,
    normalizeImageContextCount,
    getEffectiveRefInstruction,
} from '../settings.js';
import {
    normalizeStoredImagePath,
    imageUrlToDataUrl,
    fetchWithTimeout,
    ProviderError,
    isRetryableHttpStatus,
} from '../utils.js';
import { buildFinalGenerationPrompt } from '../parser.js';
import { t } from '../i18n.js';
import {
    getCharacterAvatarDataUrl,
    getUserAvatarDataUrl,
    collectPreviousContextReferences,
} from '../references.js';
import { collectAvatarReferences, collectExtraReferences, mergeAvatarReferenceGroups } from '../extras.js';
import {
    Provider,
    buildGenerationUrl,
    resolveLockedSetting,
    throwAsProviderError,
} from './base.js';
import {
    classifyOpenRouterModel,
    isGeminiOpenRouterModel,
    getOpenRouterCapabilities,
} from './caps.js';

const OPENROUTER_REQUEST_TIMEOUT_MS = 600_000;
const OPENROUTER_DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1';

/**
 * Парсит ошибку от OpenRouter. Формат — как у OpenAI (`{ error: { message, code, type } }`),
 * но иногда приходит просто `{ error: string }`.
 */
async function parseOpenRouterError(response) {
    const raw = await response.text().catch(() => '');
    let payload = null;
    try {
        payload = raw ? JSON.parse(raw) : null;
    } catch (_e) {
        payload = null;
    }
    const errField = payload?.error;
    let message;
    let code;
    if (typeof errField === 'string') {
        message = errField;
        code = String(response.status);
    } else {
        message = errField?.message || errField?.detail || raw || `HTTP ${response.status}`;
        code = errField?.code || errField?.type || String(response.status);
    }
    return { message: String(message).slice(0, 800), code, status: response.status };
}

export class OpenRouterProvider extends Provider {
    get id() { return 'openrouter'; }
    get displayName() { return 'OpenRouter'; }

    get capabilities() {
        return {
            ...super.capabilities,
            referencesFormat: 'dataUrl',
        };
    }

    validate(settings) {
        const errors = [];
        if (!settings.apiKey) {
            errors.push(t`API key is not configured`);
        }
        // Endpoint имеет дефолт (https://openrouter.ai/api/v1), поэтому не требуем.
        return errors;
    }

    async collectReferences({ prompt = '', messageId, matchedAdditionalRefs = [] }) {
        const settings = getSettings();
        const caps = getOpenRouterCapabilities(settings.model);
        const maxRefs = caps.maxReferences;
        const refs = [];

        // Референсы в формате dataUrl (OpenRouter принимает base64 data URL в image_url.url).
        const avatarGroups = [];
        if (settings.sendCharAvatar) avatarGroups.push(await collectAvatarReferences('bot', 'dataUrl', prompt));
        if (settings.sendUserAvatar) avatarGroups.push(await collectAvatarReferences('user', 'dataUrl', prompt));
        refs.push(...mergeAvatarReferenceGroups(avatarGroups, maxRefs));

        for (const extra of await collectExtraReferences(prompt, 'dataUrl')) {
            if (refs.length >= maxRefs) break;
            refs.push(extra);
        }

        for (const ref of matchedAdditionalRefs) {
            if (refs.length >= maxRefs) break;
            const imagePath = normalizeStoredImagePath(ref.imagePath);
            if (!imagePath) continue;
            const d = await imageUrlToDataUrl(imagePath);
            if (d) refs.push(d);
        }

        if (settings.imageContextEnabled) {
            const contextCount = normalizeImageContextCount(settings.imageContextCount);
            const contextRefs = await collectPreviousContextReferences(messageId, 'dataUrl', contextCount);
            refs.push(...contextRefs);
        }

        if (refs.length > maxRefs) {
            refs.length = maxRefs;
        }
        return refs;
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = options.providerSettings || getSettings();
        const url = buildGenerationUrl(settings, '/chat/completions');

        const model = settings.model;
        const caps = getOpenRouterCapabilities(model);
        const isGeminiOR = isGeminiOpenRouterModel(model);

        // aspect_ratio: валидируем по caps.
        let aspectRatio = resolveLockedSetting(options.aspectRatio)
            || resolveLockedSetting(settings.aspectRatio);
        if (aspectRatio && !caps.aspectRatios.includes(aspectRatio)) {
            iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}" for ${model}, falling back`);
            const configuredAspectRatio = resolveLockedSetting(settings.aspectRatio);
            aspectRatio = caps.aspectRatios.includes(configuredAspectRatio) ? configuredAspectRatio : '';
        }

        // image_size: только для Gemini 3 pro / 3.1 flash (список не null).
        let imageSize = null;
        if (Array.isArray(caps.imageSizes)) {
            imageSize = resolveLockedSetting(options.imageSize)
                || resolveLockedSetting(settings.imageSize);
            if (imageSize && !caps.imageSizes.includes(imageSize)) {
                iigLog('WARN', `Invalid image_size "${imageSize}" for ${model}, falling back`);
                const configuredImageSize = resolveLockedSetting(settings.imageSize);
                imageSize = caps.imageSizes.includes(configuredImageSize) ? configuredImageSize : null;
            }
        }

        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        // messages.content: строка если нет refs, массив частей — если есть.
        // По докам OpenRouter text должен идти первым, далее картинки.
        let content;
        if (references.length > 0) {
            const parts = [{ type: 'text', text: fullPrompt }];
            for (const dataUrl of references.slice(0, caps.maxReferences)) {
                parts.push({
                    type: 'image_url',
                    image_url: { url: dataUrl },
                });
            }
            content = parts;
        } else {
            content = fullPrompt;
        }

        // modalities: Gemini отдаёт и текст и картинку; Flux/Sourceful — только картинку.
        const modalities = isGeminiOR ? ['image', 'text'] : ['image'];

        const body = {
            model,
            messages: [{ role: 'user', content }],
            modalities,
        };

        const imageConfig = {};
        if (aspectRatio) imageConfig.aspect_ratio = aspectRatio;
        if (imageSize) imageConfig.image_size = imageSize;
        if (Object.keys(imageConfig).length > 0) body.image_config = imageConfig;

        iigLog(
            'INFO',
            `OpenRouter request: model=${model} kind=${classifyOpenRouterModel(model)} refs=${references.length} aspect=${aspectRatio} size=${imageSize || '(default)'} modalities=${modalities.join(',')}`
        );

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                    // OpenRouter приветствует эти два, но не требует.
                    'HTTP-Referer': window.location.origin,
                    'X-Title': 'SillyTavern Inline Image Generation',
                },
                body: JSON.stringify(body),
            }, OPENROUTER_REQUEST_TIMEOUT_MS, options.signal);
        } catch (error) {
            throwAsProviderError(error, `OpenRouter ${model}`, 'openrouter');
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenRouterError(response);
            throw new ProviderError({
                message: `OpenRouter ${model} ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'openrouter',
            });
        }

        const result = await response.json();
        const message = result?.choices?.[0]?.message;
        const images = Array.isArray(message?.images) ? message.images : [];
        const imageUrl = images[0]?.image_url?.url;

        if (!imageUrl || typeof imageUrl !== 'string') {
            throw new ProviderError({
                message: 'No image in OpenRouter response (message.images empty)',
                code: 'no_image',
                retryable: false,
                providerId: 'openrouter',
            });
        }

        // OpenRouter возвращает полный data URL с base64 — отдаём как есть.
        return imageUrl;
    }

    /**
     * Свой fetchModels: фильтры `input_modalities=image,text` + `output_modalities=image`.
     */
    async fetchModels(settingsOverride = null) {
        const settings = settingsOverride || getSettings();
        const endpoint = (String(settings.endpoint || '').trim() || OPENROUTER_DEFAULT_ENDPOINT)
            .replace(/\/$/, '');

        if (!settings.apiKey) {
            console.warn('[IIG] OpenRouter fetchModels: API key not set');
            return [];
        }

        const url = `${endpoint}/models?input_modalities=image%2Ctext&output_modalities=image`;
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
        return models.map(m => m.id).filter(Boolean);
    }
}
