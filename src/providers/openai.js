/**
 * OpenAI (и OpenAI-совместимые прокси): /v1/images/generations (JSON)
 * и /v1/images/edits (multipart, с референсами).
 */

import {
    getSettings,
    iigLog,
    MAX_GENERATION_REFERENCE_IMAGES,
    normalizeImageContextCount,
    getEffectiveRefInstruction,
} from '../settings.js';
import {
    normalizeStoredImagePath,
    imageUrlToBase64,
    base64ToBlob,
    fetchWithTimeout,
    ProviderError,
    isRetryableHttpStatus,
} from '../utils.js';
import { buildFinalGenerationPrompt } from '../parser.js';
import {
    getCharacterAvatarBase64,
    getUserAvatarBase64,
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
} from './base.js';
import {
    classifyOpenAIModel,
    isGptImageFamily,
    getOpenAIModelMaxReferences,
    aspectRatioToSize,
    normalizeQualityForModel,
} from './caps.js';

// Таймаут для image-запросов. OpenAI допускает долгую генерацию на сложных
// промптах, особенно gpt-image-*.
const OPENAI_REQUEST_TIMEOUT_MS = 600_000;

export class OpenAIProvider extends Provider {
    get id() { return 'openai'; }
    get displayName() { return 'OpenAI'; }

    supportsReferences(settings) {
        // Референсы работают только там, где есть `/v1/images/edits`
        // с multi-image входом: семейство gpt-image-* и flux-1-kontext-*.
        // dall-e-2 формально умеет /edits с одним image, но мы не делаем
        // под него исключение — UI проще.
        const kind = classifyOpenAIModel(settings.model);
        return isGptImageFamily(kind) || kind === 'flux-kontext';
    }

    async collectReferences({ prompt = '', messageId, matchedAdditionalRefs = [] }) {
        const settings = getSettings();
        const modelKind = classifyOpenAIModel(settings.model);
        // Flux Kontext принимает только 1 reference; gpt-image-* — до MAX.
        const maxRefs = getOpenAIModelMaxReferences(modelKind) || MAX_GENERATION_REFERENCE_IMAGES;
        const refs = [];

        const avatarGroups = [];
        if (settings.sendCharAvatar) avatarGroups.push(await collectAvatarReferences('bot', 'base64', prompt));
        if (settings.sendUserAvatar) avatarGroups.push(await collectAvatarReferences('user', 'base64', prompt));
        refs.push(...mergeAvatarReferenceGroups(avatarGroups, maxRefs));

        // Extras (NPC + wardrobe) — добавляем до matchedAdditionalRefs, чтобы
        // приоритет важных контекстных рефов был выше чем у lorebook-матчей.
        for (const extra of await collectExtraReferences(prompt, 'base64')) {
            if (refs.length >= maxRefs) break;
            refs.push(extra);
        }

        for (const ref of matchedAdditionalRefs) {
            if (refs.length >= maxRefs) break;
            const imagePath = normalizeStoredImagePath(ref.imagePath);
            if (!imagePath) continue;
            const b64 = await imageUrlToBase64(imagePath);
            if (b64) refs.push(b64);
        }

        if (settings.imageContextEnabled) {
            const contextCount = normalizeImageContextCount(settings.imageContextCount);
            const contextRefs = await collectPreviousContextReferences(messageId, 'base64', contextCount);
            refs.push(...contextRefs);
        }

        if (refs.length > maxRefs) {
            refs.length = maxRefs;
        }
        return refs;
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = options.providerSettings || getSettings();
        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

        // Префикс refInstruction — только когда реально уходит хотя бы один
        // ref в /v1/images/edits. Без рефов /generations не нуждается в нём.
        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        const modelKind = classifyOpenAIModel(settings.model);
        const optionAspectRatio = resolveLockedSetting(options.aspectRatio);
        const configuredSize = resolveLockedSetting(settings.size, isGptImageFamily(modelKind) ? 'auto' : '');
        const requestedSize = optionAspectRatio
            ? (aspectRatioToSize(optionAspectRatio, modelKind) || configuredSize)
            : configuredSize;
        const quality = normalizeQualityForModel(options.quality || settings.quality, modelKind);

        iigLog(
            'INFO',
            `OpenAI generate: model=${settings.model} kind=${modelKind} refs=${references.length} size=${requestedSize} quality=${quality} raw=${!!settings.rawEndpoint}`
        );

        // Роутинг: есть референсы → /v1/images/edits (multipart),
        // иначе → /v1/images/generations (JSON). В raw-режиме оба пути шлются
        // на один URL (settings.endpoint целиком) — юзер сам отвечает за
        // корректность настройки.
        if (references.length > 0) {
            return await this._generateWithEdits({
                url: buildGenerationUrl(settings, '/v1/images/edits'),
                apiKey: settings.apiKey,
                model: settings.model,
                modelKind,
                prompt: fullPrompt,
                size: requestedSize,
                quality,
                references,
                signal: options.signal,
            });
        }

        return await this._generateWithGenerations({
            url: buildGenerationUrl(settings, '/v1/images/generations'),
            apiKey: settings.apiKey,
            model: settings.model,
            modelKind,
            prompt: fullPrompt,
            size: requestedSize,
            quality,
            signal: options.signal,
        });
    }

    async _generateWithGenerations({ url, apiKey, model, modelKind, prompt, size, quality, signal }) {

        const body = {
            model,
            prompt,
            n: 1,
        };
        if (size) body.size = size;
        if (quality) body.quality = quality;

        // response_format=b64_json поддерживается dall-e-*. Для gpt-image-* OpenAI
        // возвращает b64 всегда, параметр игнорируется/отклоняется — не отправляем
        // его для семейства gpt-image-*, чтобы не словить 400 на строгих прокси.
        if (!isGptImageFamily(modelKind)) {
            body.response_format = 'b64_json';
        }

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, OPENAI_REQUEST_TIMEOUT_MS, signal);
        } catch (error) {
            throwAsProviderError(error, `OpenAI /v1/images/generations (${url})`, 'openai');
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `OpenAI /generations ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'openai',
            });
        }

        const result = await response.json();
        return extractImageFromResult(result);
    }

    async _generateWithEdits({ url, apiKey, model, modelKind, prompt, size, quality, references, signal }) {
        const form = new FormData();

        form.append('model', model);
        form.append('prompt', prompt);
        form.append('n', '1');
        if (size) form.append('size', size);
        if (quality) form.append('quality', quality);

        // GPT Image family: поле `image[]` для множественных референсов
        // (OpenAI gpt-image-1 / 1.5 / 2 поддерживает multi-image edit).
        // Остальные (dall-e-2, unknown): одиночный `image`.
        if (isGptImageFamily(modelKind) && references.length > 1) {
            references.forEach((ref, idx) => {
                const blob = base64ToBlob(ref, 'image/png');
                // OpenAI принимает повторный `image[]` как массив.
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
                headers: {
                    // Content-Type с boundary FormData проставит сам.
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: form,
            }, OPENAI_REQUEST_TIMEOUT_MS, signal);
        } catch (error) {
            throwAsProviderError(error, `OpenAI /v1/images/edits (${url})`, 'openai');
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `OpenAI /edits ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'openai',
            });
        }

        const result = await response.json();
        return extractImageFromResult(result);
    }
}
