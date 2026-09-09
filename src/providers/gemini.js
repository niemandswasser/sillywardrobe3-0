/**
 * Gemini (nano-banana, gemini-*-image): нативный :generateContent API
 * с inlineData-референсами. Поддерживает RouteMyAI-прокси (/compatible).
 */

import {
    getSettings,
    iigLog,
    normalizeImageContextCount,
    getEffectiveEndpoint,
    getEffectiveRefInstruction,
} from '../settings.js';
import {
    normalizeStoredImagePath,
    imageUrlToBase64,
    fetchWithTimeout,
    ProviderError,
    isRetryableHttpStatus,
} from '../utils.js';
import { buildFinalGenerationPrompt } from '../parser.js';
import {
    getCharacterAvatarBase64,
    getUserAvatarBase64,
    collectPreviousContextReferences,
    makeReferenceObject,
    getReferenceImage,
    getReferenceDescription,
    getReferenceSource,
    collectCharacterLibraryReferences,
    getEffectiveCharacterLibraryDisplayName,
    shouldSendCharacterLibraryReference,
} from '../references.js';
import { collectExtraReferenceObjects, getWardrobeAvatarOverrideBase64, mergeAvatarReferenceGroups } from '../extras.js';
import {
    Provider,
    buildGenerationUrl,
    resolveLockedSetting,
    throwAsProviderError,
    isImageModel,
} from './base.js';
import { getGeminiCapabilities } from './caps.js';

const GEMINI_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Диагностика содержимого референса: формат по магическим байтам,
 * размер в KB, для PNG — пиксельные габариты из IHDR. Нужна, чтобы в логах
 * было видно, ЧТО реально уходит в inlineData (а не «4 каких-то картинки»).
 */
function describeBase64Image(b64) {
    const s = String(b64 || '');
    if (!s) return 'EMPTY';
    const sizeKb = Math.round((s.length * 3) / 4 / 1024);
    let format = 'unknown';
    if (s.startsWith('iVBOR')) format = 'png';
    else if (s.startsWith('/9j/')) format = 'jpeg';
    else if (s.startsWith('UklGR')) format = 'webp';
    else if (s.startsWith('R0lGO')) format = 'gif';
    else if (s.startsWith('Qk')) format = 'bmp';
    else if (/^(PHN2Z|PD94|PCFET|PGh0)/.test(s)) format = 'TEXT/HTML(!)';
    let dims = '';
    if (format === 'png') {
        try {
            const head = atob(s.slice(0, 44));
            const be32 = (off) => (head.charCodeAt(off) << 24 | head.charCodeAt(off + 1) << 16 | head.charCodeAt(off + 2) << 8 | head.charCodeAt(off + 3)) >>> 0;
            dims = ` ${be32(16)}x${be32(20)}px`;
        } catch (_e) { /* не критично */ }
    }
    return `format=${format}${dims} size=${sizeKb}KB b64head=${s.slice(0, 12)}`;
}

/**
 * Определяет, указывает ли endpoint на RouteMyAI (rout.my).
 * Используется для авто-добавления /compatible в Gemini-пути.
 */
function isRoutMyEndpoint(settings) {
    const ep = String(getEffectiveEndpoint(settings) || settings.endpoint || '').toLowerCase();
    return ep.includes('rout.my');
}

/**
 * Парсит ошибку от Gemini-ответа в единообразный вид.
 * Формат Google: `{ error: { code, message, status } }`.
 */
async function parseGeminiError(response) {
    const raw = await response.text().catch(() => '');
    let payload = null;
    try {
        payload = raw ? JSON.parse(raw) : null;
    } catch (_e) {
        payload = null;
    }
    const err = payload?.error || {};
    const message = err.message || raw || `HTTP ${response.status}`;
    const code = err.status || err.code || String(response.status);
    return { message: String(message).slice(0, 800), code, status: response.status };
}

export class GeminiProvider extends Provider {
    get id() { return 'gemini'; }
    get displayName() { return 'Gemini / nano-banana'; }

    /**
     * Собирает референсы как объекты `{ image, description, source }`.
     * `description` — готовая подпись без префикса «Image N» (он добавляется
     * в generate), например `is Ethan's FACE — preserve this face exactly`.
     * Подписи критичны: с 3-4 безымянными картинками (лицо + аутфиты) модель
     * нестабильно понимает, кто есть кто, и «теряет» референсы.
     */
    async collectReferences({ prompt = '', messageId, matchedAdditionalRefs = [] }) {
        const settings = getSettings();
        const context = SillyTavern.getContext();
        const caps = getGeminiCapabilities(settings.model);
        const maxRefs = caps.maxReferences;
        const charName = await getEffectiveCharacterLibraryDisplayName(
            'char',
            context.characters?.[context.characterId]?.name || 'the character',
            settings,
        );
        const userName = await getEffectiveCharacterLibraryDisplayName('user', context.name1 || 'the user', settings);
        const refs = [];

        const avatarGroups = [];
        if (settings.sendCharAvatar && await shouldSendCharacterLibraryReference('char', prompt, settings)) {
            const override = await getWardrobeAvatarOverrideBase64('bot');
            const libraryRefs = override
                ? [makeReferenceObject(override, '', 'char')]
                : await collectCharacterLibraryReferences('char', 'base64', settings);
            avatarGroups.push(libraryRefs.map((ref) => {
                const description = [`is ${charName}'s FACE and appearance — preserve this identity exactly`, getReferenceDescription(ref)].filter(Boolean).join('. ');
                return makeReferenceObject(getReferenceImage(ref), description, 'char-avatar');
            }));
        }
        if (settings.sendUserAvatar && await shouldSendCharacterLibraryReference('user', prompt, settings)) {
            const override = await getWardrobeAvatarOverrideBase64('user');
            const libraryRefs = override
                ? [makeReferenceObject(override, '', 'user')]
                : await collectCharacterLibraryReferences('user', 'base64', settings);
            avatarGroups.push(libraryRefs.map((ref) => {
                const description = [`is ${userName}'s FACE and appearance — preserve this identity exactly`, getReferenceDescription(ref)].filter(Boolean).join('. ');
                return makeReferenceObject(getReferenceImage(ref), description, 'user-avatar');
            }));
        }
        refs.push(...mergeAvatarReferenceGroups(avatarGroups, maxRefs));

        for (const extra of await collectExtraReferenceObjects(prompt, 'base64')) {
            if (refs.length >= maxRefs) break;
            let description = '';
            if (extra.kind === 'npc') {
                description = `is ${extra.name} — preserve this appearance exactly`;
            } else if (extra.kind === 'outfit-char') {
                description = `shows ${charName}'s current OUTFIT — dress the character in this exact clothing`;
            } else if (extra.kind === 'outfit-user') {
                description = `shows ${userName}'s current OUTFIT — dress them in this exact clothing`;
            }
            refs.push(makeReferenceObject(extra.image, description, extra.kind));
        }

        for (const ref of matchedAdditionalRefs) {
            if (refs.length >= maxRefs) break;
            const imagePath = normalizeStoredImagePath(ref.imagePath);
            if (!imagePath) continue;
            const b64 = await imageUrlToBase64(imagePath);
            if (b64) {
                const desc = String(ref.description || '').trim();
                refs.push(makeReferenceObject(b64, `is "${ref.name}"${desc ? ` — ${desc}` : ' — preserve this appearance exactly'}`, 'lorebook'));
            }
        }

        if (settings.imageContextEnabled) {
            const contextCount = normalizeImageContextCount(settings.imageContextCount);
            const contextRefs = await collectPreviousContextReferences(messageId, 'base64', contextCount);
            for (const contextRef of contextRefs) {
                refs.push(makeReferenceObject(contextRef, 'is style/mood context from a previous scene', 'context'));
            }
        }

        if (refs.length > maxRefs) {
            refs.length = maxRefs;
        }
        return refs;
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = options.providerSettings || getSettings();
        const model = settings.model;
        const caps = getGeminiCapabilities(model);
        // Провайдер-префикс (vertex/, google/ и т.п.) стрипаем ТОЛЬКО для
        // нативного Google API — он принимает голое имя модели. Прокси
        // (kult.wtf и др.) используют полный id как ключ маршрутизации:
        // голое имя уходит на другой бэкенд, который игнорирует
        // inlineData-референсы. Сегменты кодируем по отдельности, чтобы
        // сохранить `/` в пути.
        const isGoogleNativeEndpoint = String(getEffectiveEndpoint(settings) || '').toLowerCase().includes('googleapis.com');
        const bareModel = isGoogleNativeEndpoint && model.includes('/')
            ? model.slice(model.indexOf('/') + 1)
            : model;
        const pathModel = bareModel.split('/').map(encodeURIComponent).join('/');
        // RouteMyAI (rout.my) требует /compatible перед /v1beta для Gemini-формата.
        const geminiPathPrefix = isRoutMyEndpoint(settings) ? '/compatible' : '';
        const url = buildGenerationUrl(settings, `${geminiPathPrefix}/v1beta/models/${pathModel}:generateContent`);

        // aspect ratio: tag > settings > дефолт `1:1`, с валидацией по модели.
        let aspectRatio = resolveLockedSetting(options.aspectRatio)
            || resolveLockedSetting(settings.aspectRatio);
        if (aspectRatio && !caps.aspectRatios.includes(aspectRatio)) {
            iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}" for ${model}, falling back`);
            const configuredAspectRatio = resolveLockedSetting(settings.aspectRatio);
            aspectRatio = caps.aspectRatios.includes(configuredAspectRatio) ? configuredAspectRatio : '';
        }

        // imageSize: только если модель поддерживает (у 2.5 Flash — нет).
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

        iigLog(
            'INFO',
            `Gemini ${model} (caps maxRefs=${caps.maxReferences}): aspect=${aspectRatio} size=${imageSize || '(default)'}`
        );

        const parts = [];

        // Лимит референсов — по модели, а не по глобальной константе.
        // Каждой картинке — подпись «Image N is/shows ...» в промпте: без
        // явного маппинга модель на сложных промптах игнорирует референсы.
        const labelLines = [];
        references.slice(0, caps.maxReferences).forEach((ref, refIdx) => {
            const imgB64 = getReferenceImage(ref);
            iigLog('INFO', `Gemini ref[${refIdx}]: ${describeBase64Image(imgB64)} source=${getReferenceSource(ref) || 'n/a'}`);
            parts.push({
                inlineData: {
                    mimeType: 'image/png',
                    data: imgB64,
                },
            });
            const description = getReferenceDescription(ref);
            if (description) {
                labelLines.push(`Image ${refIdx + 1} ${description}.`);
            }
        });

        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

        if (references.length > 0) {
            const labelBlock = labelLines.length > 0
                ? `${labelLines.join('\n')}\nGenerate the scene below. Keep all faces and outfits faithful to the references.`
                : '';
            const refInstruction = getEffectiveRefInstruction(settings);
            fullPrompt = [refInstruction, labelBlock, fullPrompt].filter(Boolean).join('\n\n');
        }

        parts.push({ text: fullPrompt });

        console.log(`[IIG] Gemini request: ${references.length} reference image(s) + prompt (${fullPrompt.length} chars)`);

        const imageConfig = {};
        if (aspectRatio) {
            imageConfig.aspectRatio = aspectRatio;
        }
        if (imageSize) {
            imageConfig.imageSize = imageSize;
        }

        const body = {
            contents: [{
                role: 'user',
                parts: parts,
            }],
            generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
                ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
            },
        };

        const bodyJson = JSON.stringify(body);
        iigLog('INFO', `Gemini request config: model=${model}, url=${url}, aspectRatio=${aspectRatio}, imageSize=${imageSize || '(default)'}, promptLength=${fullPrompt.length}, refImages=${references.length}, bodyKB=${Math.round(bodyJson.length / 1024)}`);
        iigLog('INFO', `Gemini prompt head: ${fullPrompt.slice(0, 300)}`);

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: bodyJson,
            }, GEMINI_REQUEST_TIMEOUT_MS, options.signal);
        } catch (error) {
            throwAsProviderError(error, `Gemini ${model}`, 'gemini');
        }

        if (!response.ok) {
            const { message, code, status } = await parseGeminiError(response);
            throw new ProviderError({
                message: `Gemini ${model} ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'gemini',
            });
        }

        const result = await response.json();

        const candidates = result.candidates || [];
        if (candidates.length === 0) {
            throw new ProviderError({
                message: 'No candidates in Gemini response',
                code: 'empty_response',
                retryable: false,
                providerId: 'gemini',
            });
        }

        const responseParts = candidates[0].content?.parts || [];

        for (const part of responseParts) {
            // Check both camelCase and snake_case variants
            if (part.inlineData) {
                return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            }
            if (part.inline_data) {
                return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
            }
        }

        throw new ProviderError({
            message: 'No image found in Gemini response',
            code: 'no_image',
            retryable: false,
            providerId: 'gemini',
        });
    }

    /**
     * Gemini models listing. Стратегия двух попыток:
     *   1) Нативный Google API: `GET {endpoint}/v1beta/models?key={apiKey}`
     *      — ответ формата `{ models: [{ name: 'models/gemini-...', ...supportedGenerationMethods }] }`.
     *   2) OpenAI-совместимый прокси: `GET {endpoint}/v1/models` с `Authorization: Bearer`
     *      — ответ формата `{ data: [{ id }] }`.
     *
     * Если первая попытка провалилась (4xx/5xx/network) — пробуем вторую.
     * Фильтруем только image-генеративные модели (см. isImageModel).
     */
    async fetchModels(settingsOverride = null) {
        const settings = settingsOverride || getSettings();
        const endpoint = getEffectiveEndpoint(settings);

        if (!endpoint || !settings.apiKey) {
            console.warn('[IIG] Gemini fetchModels: endpoint or API key not set');
            return [];
        }

        // Attempt 1 — native Google API.
        const routMyPrefix = isRoutMyEndpoint(settings) ? '/compatible' : '';
        try {
            const url = `${endpoint}${routMyPrefix}/v1beta/models?key=${encodeURIComponent(settings.apiKey)}`;
            const response = await fetch(url, { method: 'GET' });
            if (response.ok) {
                const data = await response.json();
                const models = Array.isArray(data?.models) ? data.models : [];
                // name = 'models/gemini-2.5-flash-image' → вырезаем 'models/'.
                return models
                    .map(m => String(m?.name || '').replace(/^models\//, ''))
                    .filter(id => id && isImageModel(id));
            }
            console.debug('[IIG] Gemini native /v1beta/models failed, status', response.status);
        } catch (e) {
            console.debug('[IIG] Gemini native /v1beta/models error', e?.message || e);
        }

        // Attempt 2 — OpenAI-compatible proxy fallback.
        try {
            const url = `${endpoint}/v1/models`;
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${settings.apiKey}` },
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            const models = Array.isArray(data?.data) ? data.data : [];
            return models.map(m => m.id).filter(id => id && isImageModel(id));
        } catch (e) {
            throw new Error(`Gemini fetchModels: both /v1beta/models and /v1/models failed (${e?.message || e})`);
        }
    }
}
