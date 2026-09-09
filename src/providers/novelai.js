/**
 * NovelAI — генерация через серверный прокси SillyTavern
 * (/api/novelai/generate-image), без референсов.
 */

import {
    getSettings,
    iigLog,
    NOVELAI_MODELS,
    MAX_GENERATION_REFERENCE_IMAGES,
    normalizeImageContextCount,
    getEffectiveRefInstruction,
    resolveNovelaiSize,
    applyNovelaiPresets,
} from '../settings.js';
import {
    fetchWithTimeout,
    normalizeStoredImagePath,
    imageUrlToBase64,
    ProviderError,
    isRetryableHttpStatus,
} from '../utils.js';
import { buildFinalGenerationPrompt } from '../parser.js';
import { collectPreviousContextReferences } from '../references.js';
import { collectAvatarReferences, collectExtraReferences, mergeAvatarReferenceGroups } from '../extras.js';
import { Provider, throwAsProviderError } from './base.js';

const NOVELAI_ANLAS_GUARD_MAX_PIXELS = 1024 * 1024;
const NOVELAI_ANLAS_GUARD_MAX_STEPS = 28;

function getNovelaiModel(settings) {
    return settings.novelaiModel === '__custom__'
        ? String(settings.novelaiCustomModel || '').trim()
        : String(settings.novelaiModel || '').trim();
}

function clampReferenceValue(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(-1, number)) : fallback;
}

function detectImageMime(base64) {
    const value = String(base64 || '');
    if (value.startsWith('/9j/')) return 'image/jpeg';
    if (value.startsWith('UklGR')) return 'image/webp';
    if (value.startsWith('R0lGO')) return 'image/gif';
    return 'image/png';
}

/** Fit a reference to one of the three canvases accepted by Precise Reference. */
async function normalizePreciseReference(base64) {
    const source = String(base64 || '').replace(/^data:[^,]+,/, '');
    if (!source || typeof document === 'undefined' || typeof Image === 'undefined') return source;

    try {
        const image = new Image();
        image.src = `data:${detectImageMime(source)};base64,${source}`;
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
        });

        const candidates = [[1024, 1536], [1472, 1472], [1536, 1024]];
        const ratio = image.naturalWidth / image.naturalHeight;
        const [width, height] = candidates.reduce((best, candidate) => {
            const bestDelta = Math.abs(Math.log(ratio / (best[0] / best[1])));
            const candidateDelta = Math.abs(Math.log(ratio / (candidate[0] / candidate[1])));
            return candidateDelta < bestDelta ? candidate : best;
        });

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return source;
        context.fillStyle = '#000';
        context.fillRect(0, 0, width, height);
        const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
        const drawWidth = Math.round(image.naturalWidth * scale);
        const drawHeight = Math.round(image.naturalHeight * scale);
        context.drawImage(image, Math.round((width - drawWidth) / 2), Math.round((height - drawHeight) / 2), drawWidth, drawHeight);
        return canvas.toDataURL('image/png').split(',')[1] || source;
    } catch (error) {
        iigLog('WARN', `NovelAI reference normalization failed: ${error?.message || error}`);
        return source;
    }
}

export class NovelAIProvider extends Provider {
    get id() { return 'novelai'; }
    get displayName() { return 'NovelAI'; }

    get capabilities() {
        return {
            endpointPlaceholder: '',
            requiresApiKey: false,
            referencesMaxCount: MAX_GENERATION_REFERENCE_IMAGES,
            referencesFormat: 'base64',
        };
    }

    validate(settings) {
        return getNovelaiModel(settings) ? [] : ['NovelAI model ID is not configured'];
    }

    supportsReferences(settings) {
        const model = getNovelaiModel(settings);
        const supportsPreciseReference = settings.novelaiModel === '__custom__'
            || model.includes('nai-diffusion-4-5')
            || /^nai-diffusion-[5-9]/.test(model);
        return settings.novelaiEnableReferences !== false && supportsPreciseReference;
    }

    async collectReferences({ prompt = '', messageId, matchedAdditionalRefs = [] }) {
        const settings = getSettings();
        if (settings.novelaiEnableReferences === false) return [];

        const maxRefs = MAX_GENERATION_REFERENCE_IMAGES;
        const refs = [];
        const avatarGroups = [];
        if (settings.sendCharAvatar) avatarGroups.push(await collectAvatarReferences('bot', 'base64', prompt));
        if (settings.sendUserAvatar) avatarGroups.push(await collectAvatarReferences('user', 'base64', prompt));
        refs.push(...mergeAvatarReferenceGroups(avatarGroups, maxRefs));

        for (const extra of await collectExtraReferences(prompt, 'base64')) {
            if (refs.length >= maxRefs) break;
            refs.push(extra);
        }

        for (const ref of matchedAdditionalRefs) {
            if (refs.length >= maxRefs) break;
            const imagePath = normalizeStoredImagePath(ref.imagePath);
            if (!imagePath) continue;
            const base64 = await imageUrlToBase64(imagePath);
            if (base64) refs.push(base64);
        }

        if (settings.imageContextEnabled && refs.length < maxRefs) {
            const contextCount = normalizeImageContextCount(settings.imageContextCount);
            refs.push(...await collectPreviousContextReferences(messageId, 'base64', contextCount));
        }

        if (refs.length > maxRefs) refs.length = maxRefs;
        return await Promise.all(refs.map(normalizePreciseReference));
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = options.providerSettings || getSettings();
        const { getRequestHeaders } = SillyTavern.getContext();

        const referencesEnabled = settings.novelaiEnableReferences !== false;
        let fullPrompt = buildFinalGenerationPrompt(
            prompt,
            style,
            referencesEnabled ? (options.matchedAdditionalRefs || []) : [],
            settings,
            { includeReferencePromptBlocks: referencesEnabled },
        );
        fullPrompt = applyNovelaiPresets(fullPrompt, settings);
        if (references.length > 0) {
            const instruction = getEffectiveRefInstruction(settings);
            if (instruction) fullPrompt = `${instruction}\n\n${fullPrompt}`;
        }

        let { steps, width, height, sm, smDyn } = this._getParams(settings);
        const model = getNovelaiModel(settings);

        iigLog(
            'INFO',
            `NovelAI generate: model=${model} ${width}x${height} refsEnabled=${referencesEnabled} refs=${references.length} referencePromptBlocks=${referencesEnabled ? 'on' : 'off'} steps=${steps} sampler=${settings.novelaiSampler} scheduler=${settings.novelaiScheduler} scale=${settings.novelaiScale} anlasGuard=${settings.novelaiAnlasGuard}`
        );

        const body = {
            prompt: fullPrompt,
            model,
            sampler: settings.novelaiSampler,
            scheduler: settings.novelaiScheduler,
            steps,
            scale: settings.novelaiScale,
            width,
            height,
            negative_prompt: settings.novelaiNegativePrompt || '',
            decrisper: settings.novelaiDecrisper,
            variety_boost: settings.novelaiVarietyBoost,
            sm,
            sm_dyn: smDyn,
            seed: -1,
            references_enabled: referencesEnabled,
            reference_images: referencesEnabled ? references : [],
            reference_type: ['character', 'style', 'character&style'].includes(settings.novelaiReferenceType)
                ? settings.novelaiReferenceType
                : 'character&style',
            reference_strength: clampReferenceValue(settings.novelaiReferenceStrength, 1),
            reference_fidelity: clampReferenceValue(settings.novelaiReferenceFidelity, 0.75),
        };

        let response;
        try {
            response = await fetchWithTimeout('/api/novelai/generate-image', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            }, 600_000, options.signal);
        } catch (error) {
            throwAsProviderError(error, 'NovelAI (ST proxy)', 'novelai');
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new ProviderError({
                message: `NovelAI ${response.status}: ${String(text).slice(0, 800)}`,
                code: String(response.status),
                status: response.status,
                retryable: isRetryableHttpStatus(response.status),
                providerId: 'novelai',
            });
        }

        const base64 = await response.text();
        return `data:image/png;base64,${base64}`;
    }

    async fetchModels() {
        return NOVELAI_MODELS.map(m => m.value);
    }

    _getParams(settings) {
        let steps = Math.min(settings.novelaiSteps || 28, 50);
        const sizeEntry = resolveNovelaiSize(settings.novelaiSize);
        let width = sizeEntry.width;
        let height = sizeEntry.height;
        let sm = settings.novelaiSm || false;
        let smDyn = settings.novelaiSmDyn || false;

        const model = getNovelaiModel(settings);
        if (settings.novelaiSampler === 'ddim'
            || ['nai-diffusion-4-curated-preview', 'nai-diffusion-4-full',
                'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'].includes(model)
            || /^nai-diffusion-[5-9]/.test(model)) {
            sm = false;
            smDyn = false;
        }

        if (!settings.novelaiAnlasGuard) {
            return { steps, width, height, sm, smDyn };
        }

        if (width * height > NOVELAI_ANLAS_GUARD_MAX_PIXELS) {
            const ratio = Math.sqrt(NOVELAI_ANLAS_GUARD_MAX_PIXELS / (width * height));
            let newWidth = Math.round(width * ratio);
            let newHeight = Math.round(height * ratio);
            newWidth -= newWidth % 64;
            newHeight -= newHeight % 64;
            while (newWidth * newHeight > NOVELAI_ANLAS_GUARD_MAX_PIXELS) {
                if (newWidth > newHeight) newWidth -= 64;
                else newHeight -= 64;
            }
            iigLog('INFO', `Anlas Guard: ${width}x${height} -> ${newWidth}x${newHeight}`);
            width = newWidth;
            height = newHeight;
        }

        if (steps > NOVELAI_ANLAS_GUARD_MAX_STEPS) {
            iigLog('INFO', `Anlas Guard: steps ${steps} -> ${NOVELAI_ANLAS_GUARD_MAX_STEPS}`);
            steps = NOVELAI_ANLAS_GUARD_MAX_STEPS;
        }

        return { steps, width, height, sm, smDyn };
    }
}
