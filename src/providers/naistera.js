/**
 * Naistera: live model catalog + /api/generate endpoint for images and video.
 * /api/generate endpoint, умеет отдавать и картинки, и видео.
 */

import {
    getSettings,
    iigLog,
    MAX_GENERATION_REFERENCE_IMAGES,
    normalizeNaisteraModel,
    naisteraModelSupportsReferences,
    normalizeImageContextCount,
    normalizeNaisteraVideoFrequency,
    getEffectiveEndpoint,
    getEffectiveRefInstruction,
} from '../settings.js';
import {
    normalizeStoredImagePath,
    imageUrlToDataUrl,
    ProviderError,
    isRetryableHttpStatus,
} from '../utils.js';
import { buildFinalGenerationPrompt } from '../parser.js';
import { t } from '../i18n.js';
import {
    collectPreviousContextReferences,
    getReferenceImage,
    getReferenceDescription,
} from '../references.js';
import { collectAvatarReferences, collectExtraReferences, mergeAvatarReferenceGroups } from '../extras.js';
import { Provider, resolveLockedSetting } from './base.js';

export class NaisteraProvider extends Provider {
    constructor() {
        super();
        this.modelCatalog = new Map();
        this.modelCatalogStatus = { authenticated: false, tier: null, publicFallback: false };
    }

    get id() { return 'naistera'; }
    get displayName() { return 'Naistera'; }

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
        const m = normalizeNaisteraModel(settings.naisteraModel);
        if (!m) {
            errors.push(t`Model is not selected`);
        }
        return errors;
    }

    supportsReferences(settings) {
        const modelId = normalizeNaisteraModel(settings.naisteraModel);
        const model = this.modelCatalog.get(modelId);
        return model ? model.references !== false : naisteraModelSupportsReferences(modelId);
    }

    getModelLabel(modelId) {
        return this.modelCatalog.get(String(modelId || ''))?.name || String(modelId || '');
    }

    getModelCatalogStatus() {
        return { ...this.modelCatalogStatus };
    }

    async fetchModels(settingsOverride = null) {
        const settings = settingsOverride || getSettings();
        const endpoint = getEffectiveEndpoint(settings).replace(/\/$/, '');
        const url = `${endpoint}/api/models`;
        const request = async (authenticated) => {
            const headers = { 'Accept': 'application/json' };
            if (authenticated && settings.apiKey) {
                headers.Authorization = `Bearer ${settings.apiKey}`;
            }
            return await fetch(url, { method: 'GET', headers });
        };

        let response;
        let publicFallback = false;
        try {
            response = await request(true);
        } catch (error) {
            if (!settings.apiKey || error?.name !== 'TypeError') throw error;
            iigLog('WARN', 'Naistera authenticated model discovery was blocked; retrying the public catalog');
            publicFallback = true;
            response = await request(false);
        }

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Naistera /api/models ${response.status}: ${String(detail).slice(0, 500)}`);
        }

        const payload = await response.json();
        const models = (Array.isArray(payload?.models) ? payload.models : [])
            .filter((model) => model?.id && model.visible !== false && model.deprecated !== true)
            .map((model) => ({
                id: String(model.id),
                name: String(model.name || model.id),
                references: model.references !== false,
            }));

        this.modelCatalog = new Map(models.map((model) => [model.id, model]));
        this.modelCatalogStatus = {
            authenticated: payload?.authenticated === true,
            tier: payload?.tier || null,
            publicFallback,
        };
        iigLog('INFO', `Naistera models loaded: ${models.length}; authenticated=${payload?.authenticated === true}; tier=${payload?.tier || 'public'}`);
        return models.map((model) => model.id);
    }

    async collectReferences({ prompt = '', messageId, matchedAdditionalRefs = [], providerOptions = {} }) {
        const settings = getSettings();
        const normalizedModel = normalizeNaisteraModel(providerOptions.model || settings.naisteraModel);
        if (!this.modelCatalog.has(normalizedModel)) {
            await this.fetchModels().catch((error) => {
                iigLog('WARN', `Naistera model metadata unavailable: ${error?.message || error}`);
            });
        }
        if (!this.supportsReferences({ ...settings, naisteraModel: normalizedModel })) {
            return [];
        }

        const refs = [];

        const avatarGroups = [];
        if (settings.naisteraSendCharAvatar) avatarGroups.push(await collectAvatarReferences('bot', 'dataUrl', prompt));
        if (settings.naisteraSendUserAvatar) avatarGroups.push(await collectAvatarReferences('user', 'dataUrl', prompt));
        refs.push(...mergeAvatarReferenceGroups(avatarGroups, MAX_GENERATION_REFERENCE_IMAGES));

        for (const extra of await collectExtraReferences(prompt, 'dataUrl')) {
            if (refs.length >= MAX_GENERATION_REFERENCE_IMAGES) break;
            refs.push(extra);
        }

        for (const ref of matchedAdditionalRefs) {
            if (refs.length >= MAX_GENERATION_REFERENCE_IMAGES) break;
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

        if (refs.length > MAX_GENERATION_REFERENCE_IMAGES) {
            refs.length = MAX_GENERATION_REFERENCE_IMAGES;
        }
        return refs;
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = options.providerSettings || getSettings();
        const endpoint = getEffectiveEndpoint(settings);
        const url = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;

        const aspectRatio = resolveLockedSetting(options.aspectRatio)
            || resolveLockedSetting(settings.naisteraAspectRatio)
            || 'auto';
        const model = normalizeNaisteraModel(options.model || settings.naisteraModel || 'nano-banana-2');
        const preset = options.preset || null;
        const wantsVideoTest = Boolean(options.videoTestMode);
        const videoEveryN = normalizeNaisteraVideoFrequency(options.videoEveryN ?? settings.naisteraVideoEveryN);
        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);

        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        const body = {
            prompt: fullPrompt,
            aspect_ratio: aspectRatio,
            model,
        };
        if (preset) body.preset = preset;
        if (references.length > 0) {
            body.reference_objects = references.slice(0, MAX_GENERATION_REFERENCE_IMAGES)
                .map((ref) => ({
                    image: getReferenceImage(ref),
                    description: getReferenceDescription(ref),
                }))
                .filter((ref) => ref.image);
        }
        if (wantsVideoTest) {
            body.video_test_mode = true;
            body.video_test_every_n_messages = videoEveryN;
        }

        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: options.signal,
            });
        } catch (error) {
            const pageOrigin = window.location.origin;
            let endpointOrigin = endpoint;
            try {
                endpointOrigin = new URL(url, window.location.href).origin;
            } catch (parseErr) {
                console.warn('[IIG] Failed to parse Naistera endpoint origin:', parseErr);
            }
            const rawMessage = String(error?.message || '').trim() || 'Failed to fetch';
            throw new ProviderError({
                message: `Network/CORS error while requesting ${endpointOrigin} from ${pageOrigin}. `
                    + `The browser blocked access to the response before the API could return JSON. `
                    + `Original error: ${rawMessage}`,
                code: 'network',
                retryable: true,
                providerId: 'naistera',
                cause: error,
            });
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new ProviderError({
                message: `API Error (${response.status}): ${String(text).slice(0, 800)}`,
                code: String(response.status),
                status: response.status,
                retryable: isRetryableHttpStatus(response.status),
                providerId: 'naistera',
            });
        }

        const result = await response.json();
        if (!result?.data_url) {
            throw new ProviderError({
                message: 'No data_url in response',
                code: 'empty_response',
                retryable: false,
                providerId: 'naistera',
            });
        }
        if (result.media_kind === 'video') {
            return {
                kind: 'video',
                dataUrl: result.data_url,
                posterDataUrl: result.poster_data_url || '',
                contentType: result.content_type || 'video/mp4',
            };
        }
        return result.data_url;
    }
}
