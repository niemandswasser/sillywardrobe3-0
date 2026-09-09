/**
 * Void / RouteMyAI (rout.my) — OpenAI-совместимый chat/completions прокси,
 * который возвращает картинку. Дефолтный endpoint — VoidAI; для RouteMyAI
 * (rout.my) юзер вписывает свой URL в поле endpoint. Запрос идёт на
 * `{endpoint}/v1/chat/completions`, ответ парсится в нескольких форматах
 * (data[], choices.message.images, content-parts, markdown/data-url в тексте).
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

const VOID_REQUEST_TIMEOUT_MS = 600_000;

async function parseVoidError(response) {
    let status = response.status;
    let message = response.statusText || '';
    let code = '';
    try {
        const data = await response.json();
        const err = data?.error || data;
        message = err?.message || message;
        code = err?.code || err?.type || code;
    } catch {
        try { message = (await response.text()) || message; } catch { /* ignore */ }
    }
    return { message, code, status };
}

/**
 * Конвертирует aspect_ratio + imageSize (1K/2K/4K) в конкретный WxH size
 * для VoidAI/RouteMyAI. Без аргументов — возвращает 1024x1024.
 */
function voidAspectToSize(aspect, imageSize) {
    const res = String(imageSize || '').toUpperCase();
    // Базовые размеры для каждого разрешения и aspect ratio.
    // 1K ≈ 1024 на длинной стороне, 2K ≈ 2048, 4K ≈ 4096.
    const tables = {
        '1K': {
            '1:1': '1024x1024',
            '2:3': '832x1216',
            '3:2': '1216x832',
            '3:4': '768x1024',
            '4:3': '1024x768',
            '4:5': '832x1024',
            '5:4': '1024x832',
            '9:16': '576x1024',
            '16:9': '1024x576',
            '21:9': '1024x448',
        },
        '2K': {
            '1:1': '2048x2048',
            '2:3': '1664x2432',
            '3:2': '2432x1664',
            '3:4': '1536x2048',
            '4:3': '2048x1536',
            '4:5': '1664x2048',
            '5:4': '2048x1664',
            '9:16': '1152x2048',
            '16:9': '2048x1152',
            '21:9': '2048x896',
        },
        '4K': {
            '1:1': '4096x4096',
            '2:3': '3328x4864',
            '3:2': '4864x3328',
            '3:4': '3072x4096',
            '4:3': '4096x3072',
            '4:5': '3328x4096',
            '5:4': '4096x3328',
            '9:16': '2304x4096',
            '16:9': '4096x2304',
            '21:9': '4096x1792',
        },
    };
    const table = tables[res] || tables['1K'];
    if (aspect && table[aspect]) return table[aspect];
    // Если aspect не задан или не найден — дефолт по разрешению.
    return table['1:1'];
}

/**
 * Робастное извлечение картинки из ответа Void/RouteMyAI. Покрывает форматы:
 * OpenAI data[], chat-completion choices (message.images / content-parts /
 * markdown/data-url в тексте), root-fallback и regex по сырому JSON.
 *
 * Экспортируется — AIGate использует как fallback-парсер.
 */
export function extractVoidImage(result) {
    const toStr = (v) => (typeof v === 'string' ? v : null);
    const normalize = (val) => {
        if (!val || typeof val !== 'string') return null;
        if (val.startsWith('http://') || val.startsWith('https://') || val.startsWith('data:')) return val;
        if (/^[A-Za-z0-9+/=\s]+$/.test(val) && val.length > 100) return `data:image/png;base64,${val.replace(/\s+/g, '')}`;
        return null;
    };
    const extractFromImgObj = (img) => {
        if (!img) return null;
        if (typeof img === 'string') return normalize(img);
        const candidates = [
            toStr(img.b64_json) && `data:image/png;base64,${img.b64_json}`,
            toStr(img.image_url?.url),
            toStr(typeof img.image_url === 'string' ? img.image_url : null),
            toStr(img.url),
            toStr(img.base64) && `data:image/png;base64,${img.base64}`,
            toStr(img.data) && (img.data.startsWith('data:') || img.data.startsWith('http') ? img.data : `data:image/png;base64,${img.data}`),
            toStr(img.src),
        ].filter(Boolean);
        for (const c of candidates) { const n = normalize(c) || c; if (n) return n; }
        return null;
    };
    const extractFromText = (text) => {
        if (!text || typeof text !== 'string') return null;
        const md = text.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/i);
        if (md) return md[1];
        const data = text.match(/data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+/);
        if (data) return data[0];
        const url = text.match(/https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/i);
        if (url) return url[0];
        return null;
    };

    if (result?.data?.length > 0) {
        const got = extractFromImgObj(result.data[0]);
        if (got) return got;
    }
    const choice = result?.choices?.[0];
    if (choice) {
        const imgList = choice.message?.images || choice.images || result.images || [];
        if (imgList.length > 0) {
            const got = extractFromImgObj(imgList[0]);
            if (got) return got;
        }
        const content = choice.message?.content;
        if (Array.isArray(content)) {
            for (const part of content) {
                if (!part) continue;
                if (part.type === 'image_url') {
                    const got = extractFromImgObj(part);
                    if (got) return got;
                }
                if (part.type === 'image' && part.source?.data) {
                    return `data:${part.source.media_type || 'image/png'};base64,${part.source.data}`;
                }
                if (typeof part.text === 'string') {
                    const got = extractFromText(part.text);
                    if (got) return got;
                }
            }
        } else if (typeof content === 'string') {
            const got = extractFromText(content);
            if (got) return got;
        }
    }
    const rootCandidate = extractFromImgObj(result) || extractFromText(toStr(result?.text) || toStr(result?.message));
    if (rootCandidate) return rootCandidate;

    const raw = JSON.stringify(result);
    const b64match = raw.match(/"b64_json"\s*:\s*"([^"]+)"/);
    if (b64match) return `data:image/png;base64,${b64match[1]}`;
    const dataUrlMatch = raw.match(/"(data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+)"/);
    if (dataUrlMatch) return dataUrlMatch[1];
    const urlmatch = raw.match(/"(https?:\/\/[^"\s]+\.(?:png|jpe?g|webp|gif)(?:\?[^"\s]*)?)"/i);
    if (urlmatch) return urlmatch[1];

    return null;
}

export class VoidProvider extends Provider {
    get id() { return 'void'; }
    get displayName() { return 'VoidAI / RouteMyAI'; }

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

    async collectReferences({ prompt = '', messageId, matchedAdditionalRefs = [] }) {
        const settings = getSettings();
        const maxRefs = MAX_GENERATION_REFERENCE_IMAGES;
        const refs = [];

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
        const url = buildGenerationUrl(settings, '/v1/chat/completions');
        const model = settings.model;

        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);
        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        let content;
        if (references.length > 0) {
            const parts = [{ type: 'text', text: fullPrompt }];
            for (const dataUrl of references.slice(0, MAX_GENERATION_REFERENCE_IMAGES)) {
                parts.push({ type: 'image_url', image_url: { url: dataUrl } });
            }
            content = parts;
        } else {
            content = fullPrompt;
        }

        const aspectRatio = resolveLockedSetting(options.aspectRatio)
            || resolveLockedSetting(settings.aspectRatio);
        const imageSize = resolveLockedSetting(options.imageSize)
            || resolveLockedSetting(settings.imageSize);
        const size = voidAspectToSize(aspectRatio, imageSize);

        const body = {
            model,
            messages: [{ role: 'user', content }],
            size,
            n: 1,
        };

        iigLog('INFO', `Void request: model=${model} refs=${references.length} aspect=${aspectRatio || 'auto'} res=${imageSize || 'auto'} size=${size} raw=${!!settings.rawEndpoint}`);

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                credentials: 'omit',
                cache: 'no-store',
                mode: 'cors',
                body: JSON.stringify(body),
            }, VOID_REQUEST_TIMEOUT_MS, options.signal);
        } catch (error) {
            throwAsProviderError(error, `Void ${model}`, 'void');
        }

        if (!response.ok) {
            const { message, code, status } = await parseVoidError(response);
            throw new ProviderError({
                message: `Void ${model} ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'void',
            });
        }

        const result = await response.json();
        const got = extractVoidImage(result);
        if (got) return got;

        const raw = JSON.stringify(result);
        iigLog('ERROR', `Void response had no image. Raw (first 2000 chars): ${raw.slice(0, 2000)}`);
        throw new ProviderError({
            message: 'No image in Void/RouteMyAI response',
            code: 'no_image',
            retryable: false,
            providerId: 'void',
        });
    }
}
