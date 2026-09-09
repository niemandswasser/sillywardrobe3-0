/**
 * AIGate — гибридный прокси: Gemini-модели через chat/completions,
 * GPT Image семейство через /v1/images/generations|edits.
 */

import {
    getSettings,
    iigLog,
    MAX_GENERATION_REFERENCE_IMAGES,
    normalizeImageContextCount,
    getEffectiveEndpoint,
    getEffectiveRefInstruction,
} from '../settings.js';
import {
    normalizeStoredImagePath,
    imageUrlToBase64,
    imageUrlToDataUrl,
    base64ToBlob,
    fetchWithTimeout,
    ProviderError,
    isRetryableHttpStatus,
} from '../utils.js';
import { buildFinalGenerationPrompt } from '../parser.js';
import { t } from '../i18n.js';
import {
    getCharacterAvatarBase64,
    getCharacterAvatarDataUrl,
    getUserAvatarBase64,
    getUserAvatarDataUrl,
    collectPreviousContextReferences,
} from '../references.js';
import { collectAvatarReferences, collectExtraReferences, mergeAvatarReferenceGroups } from '../extras.js';
import {
    Provider,
    buildGenerationUrl,
    resolveLockedSetting,
    parseOpenAIError,
    throwAsProviderError,
    extractImageFromResult,
    isImageModel,
} from './base.js';
import {
    isGeminiModel,
    getGeminiCapabilities,
    classifyOpenAIModel,
    isGptImageFamily,
    getOpenAIModelMaxReferences,
    aspectRatioToSize,
    normalizeQualityForModel,
} from './caps.js';
import { extractVoidImage } from './voidai.js';

const AIGATE_DEFAULT_ENDPOINT = 'https://api.aigate.shop';
const AIGATE_REQUEST_TIMEOUT_MS = 600_000;

function isAigateGeminiModel(modelId) {
    return isGeminiModel(modelId);
}

function isAigateGptImageModel(modelId) {
    const kind = classifyOpenAIModel(modelId);
    return kind !== 'unknown';
}

export class AIGateProvider extends Provider {
    get id() { return 'aigate'; }
    get displayName() { return 'AIGate'; }

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
        return errors;
    }

    supportsReferences(settings) {
        if (isAigateGeminiModel(settings.model)) return true;
        if (isAigateGptImageModel(settings.model)) {
            const kind = classifyOpenAIModel(settings.model);
            return isGptImageFamily(kind) || kind === 'flux-kontext';
        }
        return true;
    }

    async collectReferences({ prompt = '', messageId, matchedAdditionalRefs = [] }) {
        const settings = getSettings();
        const model = settings.model;
        let maxRefs;
        let format;

        if (isAigateGeminiModel(model)) {
            maxRefs = getGeminiCapabilities(model).maxReferences;
            format = 'dataUrl';
        } else if (isAigateGptImageModel(model)) {
            const kind = classifyOpenAIModel(model);
            maxRefs = getOpenAIModelMaxReferences(kind) || MAX_GENERATION_REFERENCE_IMAGES;
            format = 'base64';
        } else {
            maxRefs = MAX_GENERATION_REFERENCE_IMAGES;
            format = 'dataUrl';
        }

        const refs = [];
        const toImg = format === 'dataUrl' ? imageUrlToDataUrl : imageUrlToBase64;
        const avatarGroups = [];
        if (settings.sendCharAvatar) avatarGroups.push(await collectAvatarReferences('bot', format, prompt));
        if (settings.sendUserAvatar) avatarGroups.push(await collectAvatarReferences('user', format, prompt));
        refs.push(...mergeAvatarReferenceGroups(avatarGroups, maxRefs));

        for (const extra of await collectExtraReferences(prompt, format)) {
            if (refs.length >= maxRefs) break;
            refs.push(extra);
        }

        for (const ref of matchedAdditionalRefs) {
            if (refs.length >= maxRefs) break;
            const imagePath = normalizeStoredImagePath(ref.imagePath);
            if (!imagePath) continue;
            const d = await toImg(imagePath);
            if (d) refs.push(d);
        }

        if (settings.imageContextEnabled) {
            const contextCount = normalizeImageContextCount(settings.imageContextCount);
            const contextRefs = await collectPreviousContextReferences(messageId, format, contextCount);
            refs.push(...contextRefs);
        }

        if (refs.length > maxRefs) refs.length = maxRefs;
        return refs;
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = options.providerSettings || getSettings();
        const model = settings.model;

        if (isAigateGeminiModel(model)) {
            return this._generateGeminiChatCompletions({ prompt, style, references, options, settings });
        }
        if (isAigateGptImageModel(model)) {
            return this._generateGptImage({ prompt, style, references, options, settings });
        }
        return this._generateGeminiChatCompletions({ prompt, style, references, options, settings });
    }

    async _generateGeminiChatCompletions({ prompt, style, references, options, settings }) {
        const model = settings.model;
        const caps = getGeminiCapabilities(model);
        const url = buildGenerationUrl(settings, '/v1/chat/completions');

        let aspectRatio = resolveLockedSetting(options.aspectRatio)
            || resolveLockedSetting(settings.aspectRatio);
        if (aspectRatio && !caps.aspectRatios.includes(aspectRatio)) {
            iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}" for AIGate ${model}, falling back`);
            const configuredAspectRatio = resolveLockedSetting(settings.aspectRatio);
            aspectRatio = caps.aspectRatios.includes(configuredAspectRatio) ? configuredAspectRatio : '';
        }

        let imageSize = null;
        if (Array.isArray(caps.imageSizes)) {
            imageSize = resolveLockedSetting(options.imageSize)
                || resolveLockedSetting(settings.imageSize);
            if (imageSize && !caps.imageSizes.includes(imageSize)) {
                iigLog('WARN', `Invalid image_size "${imageSize}" for AIGate ${model}, falling back`);
                const configuredImageSize = resolveLockedSetting(settings.imageSize);
                imageSize = caps.imageSizes.includes(configuredImageSize) ? configuredImageSize : null;
            }
        }

        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);
        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
        }

        let content;
        if (references.length > 0) {
            const parts = [{ type: 'text', text: fullPrompt }];
            for (const dataUrl of references.slice(0, caps.maxReferences)) {
                parts.push({ type: 'image_url', image_url: { url: dataUrl } });
            }
            content = parts;
        } else {
            content = fullPrompt;
        }

        const body = {
            model,
            messages: [{ role: 'user', content }],
            modalities: ['image', 'text'],
        };

        const imageConfig = {};
        if (aspectRatio) imageConfig.aspect_ratio = aspectRatio;
        if (imageSize) imageConfig.image_size = imageSize;
        if (Object.keys(imageConfig).length > 0) body.image_config = imageConfig;

        iigLog('INFO', `AIGate (Gemini) request: model=${model} refs=${references.length} aspect=${aspectRatio} size=${imageSize || '(default)'}`);

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, AIGATE_REQUEST_TIMEOUT_MS, options.signal);
        } catch (error) {
            throwAsProviderError(error, `AIGate ${model}`, 'aigate');
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `AIGate ${model} ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'aigate',
            });
        }

        const result = await response.json();
        const message = result?.choices?.[0]?.message;
        const images = Array.isArray(message?.images) ? message.images : [];
        const imageUrl = images[0]?.image_url?.url;

        if (imageUrl && typeof imageUrl === 'string') return imageUrl;

        const got = extractVoidImage(result);
        if (got) return got;

        iigLog('ERROR', `AIGate (Gemini) response had no image. Raw: ${JSON.stringify(result).slice(0, 2000)}`);
        throw new ProviderError({
            message: 'No image in AIGate response',
            code: 'no_image',
            retryable: false,
            providerId: 'aigate',
        });
    }

    async _generateGptImage({ prompt, style, references, options, settings }) {
        const model = settings.model;
        const modelKind = classifyOpenAIModel(model);

        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);
        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
        }

        const optionAspectRatio = resolveLockedSetting(options.aspectRatio);
        const configuredSize = resolveLockedSetting(settings.size, isGptImageFamily(modelKind) ? 'auto' : '');
        const requestedSize = optionAspectRatio
            ? (aspectRatioToSize(optionAspectRatio, modelKind) || configuredSize)
            : configuredSize;
        const quality = normalizeQualityForModel(options.quality || settings.quality, modelKind);

        iigLog('INFO', `AIGate (GPT Image) generate: model=${model} kind=${modelKind} refs=${references.length} size=${requestedSize} quality=${quality}`);

        if (references.length > 0) {
            return this._aigateGptEdits({ settings, model, modelKind, prompt: fullPrompt, size: requestedSize, quality, references });
        }
        return this._aigateGptGenerations({ settings, model, modelKind, prompt: fullPrompt, size: requestedSize, quality });
    }

    async _aigateGptGenerations({ settings, model, modelKind, prompt, size, quality }) {
        const url = buildGenerationUrl(settings, '/v1/images/generations');
        const body = { model, prompt, n: 1 };
        if (size) body.size = size;
        if (quality) body.quality = quality;

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, AIGATE_REQUEST_TIMEOUT_MS, options.signal);
        } catch (error) {
            throwAsProviderError(error, `AIGate /v1/images/generations`, 'aigate');
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `AIGate /generations ${status} ${code}: ${message}`,
                code, status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'aigate',
            });
        }

        const result = await response.json();
        return extractImageFromResult(result);
    }

    async _aigateGptEdits({ settings, model, modelKind, prompt, size, quality, references }) {
        const url = buildGenerationUrl(settings, '/v1/images/edits');
        const form = new FormData();
        form.append('model', model);
        form.append('prompt', prompt);
        form.append('n', '1');
        if (size) form.append('size', size);
        if (quality) form.append('quality', quality);

        if (isGptImageFamily(modelKind) && references.length > 1) {
            references.forEach((ref, idx) => {
                const blob = base64ToBlob(ref, 'image/png');
                form.append('image[]', blob, `reference-${idx}.png`);
            });
        } else {
            const blob = base64ToBlob(references[0], 'image/png');
            form.append('image', blob, 'reference-0.png');
        }

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${settings.apiKey}` },
                body: form,
            }, AIGATE_REQUEST_TIMEOUT_MS, options.signal);
        } catch (error) {
            throwAsProviderError(error, `AIGate /v1/images/edits`, 'aigate');
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `AIGate /edits ${status} ${code}: ${message}`,
                code, status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'aigate',
            });
        }

        const result = await response.json();
        return extractImageFromResult(result);
    }

    async fetchModels(settingsOverride = null) {
        const settings = settingsOverride || getSettings();
        const endpoint = (getEffectiveEndpoint(settings) || AIGATE_DEFAULT_ENDPOINT).replace(/\/$/, '');
        if (!settings.apiKey) {
            console.warn('[IIG] AIGate fetchModels: API key not set');
            return [];
        }

        const url = `${endpoint}/v1/models`;
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${settings.apiKey}` },
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const models = Array.isArray(data?.data) ? data.data : [];
        return models.map(m => m.id).filter(id => id && isImageModel(id));
    }
}
