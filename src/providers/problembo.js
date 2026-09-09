/**
 * Problembo native client API.
 *
 * Generation is asynchronous: create a task, poll it until ready, then
 * download the signed result URL. Reference images are uploaded to Problembo
 * File Store first because task payloads do not accept inline Base64 images.
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
    imageUrlToDataUrl,
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
import { Provider } from './base.js';

const DEFAULT_MODEL = 'waifu-studio-2.6';
const POLL_INTERVAL_MS = 4_000;
const TASK_TIMEOUT_MS = 15 * 60_000;
const MAX_PROMPT_LENGTH = 1_300;
const MAX_PROBLEMBO_REFERENCES = 4;
const PROBLEMBO_ASPECT_RATIOS = new Set([
    'SQUARE',
    'VERTICAL',
    'HORIZONTAL',
    'VERTICAL_16_9',
    'HORIZONTAL_16_9',
]);
const PROBLEMBO_RESOLUTIONS = new Set(['1K', '2K', '4K']);
let catalogCache = null;

function getClientApiBase(settings) {
    let endpoint = String(getEffectiveEndpoint(settings) || settings.endpoint || 'https://problembo.com')
        .trim()
        .replace(/\/+$/, '');
    endpoint = endpoint.replace(/\/image-gen\/tasks$/i, '');
    if (!/\/apis\/v1\/client$/i.test(endpoint)) {
        endpoint += '/apis/v1/client';
    }
    return endpoint;
}

function isCrossOrigin(url) {
    try {
        return new URL(url, window.location.href).origin !== window.location.origin;
    } catch (_error) {
        return false;
    }
}

/**
 * Problembo's client API does not expose browser CORS headers. Route its JSON
 * requests through SillyTavern's authenticated CORS proxy. Same-origin custom
 * endpoints are still called directly.
 */
function problemboFetch(url, options = {}) {
    if (!isCrossOrigin(url)) return fetch(url, options);
    const context = SillyTavern.getContext();
    const stHeaders = context.getRequestHeaders?.() || {};
    return fetch(`/proxy/${url}`, {
        ...options,
        headers: {
            ...stHeaders,
            ...(options.headers || {}),
        },
    });
}

function corsProxyUrl(url) {
    // Encode the complete external URL so Express keeps signed query params
    // inside req.params.url instead of treating them as the proxy request's
    // own query string.
    return `/proxy/${encodeURIComponent(url)}`;
}

async function loadCatalog(settings, force = false) {
    if (catalogCache && !force) return catalogCache;
    const apiBase = getClientApiBase(settings);
    const origin = apiBase.replace(/\/apis\/v1\/client$/i, '');
    const response = await problemboFetch(`${origin}/api/v1/image-gen/catalog`, {
        method: 'GET',
    });
    if (!response.ok) throw new Error(`Problembo catalog HTTP ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload?.models) ? payload.models : [];
    catalogCache = models.filter(model => model?.id && !model.disabled);
    return catalogCache;
}

async function getCatalogModel(settings) {
    try {
        const models = await loadCatalog(settings);
        return models.find(model => model.id === settings.model) || null;
    } catch (error) {
        iigLog('WARN', `Problembo catalog unavailable: ${error?.message || error}`);
        return null;
    }
}

function normalizeProblemboEnum(value, prefix, allowed) {
    let normalized = String(value || '').trim().toUpperCase();
    if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
    return allowed.has(normalized) ? normalized : '';
}

function abortError(signal) {
    return signal?.reason || new DOMException(t`Generation cancelled by user`, 'AbortError');
}

async function delay(ms, signal) {
    if (signal?.aborted) throw abortError(signal);
    await new Promise((resolve, reject) => {
        const finish = () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(abortError(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

async function readResponse(response) {
    const raw = await response.text().catch(() => '');
    let data = null;
    try {
        data = raw ? JSON.parse(raw) : null;
    } catch (_error) {
        data = null;
    }
    return { raw, data };
}

function errorMessage(data, raw, fallback) {
    return String(
        data?.error?.text
        || data?.error?.message
        || data?.message
        || data?.detail
        || raw
        || fallback,
    ).slice(0, 800);
}

function extensionForBlob(blob) {
    const type = String(blob?.type || '').toLowerCase();
    if (type.includes('jpeg')) return 'jpg';
    if (type.includes('webp')) return 'webp';
    if (type.includes('gif')) return 'gif';
    return 'png';
}

async function putBlob(url, blob, signal) {
    const response = await fetch(url, {
        method: 'PUT',
        body: blob,
        signal,
    });
    if (!response.ok) {
        throw new ProviderError({
            message: `Problembo file upload failed: HTTP ${response.status}`,
            code: `upload_${response.status}`,
            status: response.status,
            retryable: isRetryableHttpStatus(response.status),
            providerId: 'problembo',
        });
    }
    return response;
}

export class ProblemboProvider extends Provider {
    get id() { return 'problembo'; }
    get displayName() { return 'Problembo'; }

    get capabilities() {
        return {
            ...super.capabilities,
            referencesFormat: 'dataUrl',
            referencesMaxCount: MAX_PROBLEMBO_REFERENCES,
        };
    }

    validate(settings) {
        const errors = [];
        if (!settings.apiKey) errors.push(t`API key is not configured`);
        return errors;
    }

    supportsReferences(settings) {
        if (settings.problemboEnableReferences === false) return false;
        const model = catalogCache?.find(item => item.id === settings.model);
        return model ? model.supportInitImage === true : true;
    }

    async collectReferences({ prompt = '', messageId, matchedAdditionalRefs = [] }) {
        const settings = getSettings();
        if (!this.supportsReferences(settings)) return [];

        const refs = [];
        const avatarGroups = [];
        if (settings.sendCharAvatar) avatarGroups.push(await collectAvatarReferences('bot', 'dataUrl', prompt));
        if (settings.sendUserAvatar) avatarGroups.push(await collectAvatarReferences('user', 'dataUrl', prompt));
        refs.push(...mergeAvatarReferenceGroups(avatarGroups, MAX_PROBLEMBO_REFERENCES));

        for (const extra of await collectExtraReferences(prompt, 'dataUrl')) {
            if (refs.length >= MAX_PROBLEMBO_REFERENCES) break;
            refs.push(extra);
        }

        for (const ref of matchedAdditionalRefs) {
            if (refs.length >= MAX_PROBLEMBO_REFERENCES) break;
            const imagePath = normalizeStoredImagePath(ref.imagePath);
            if (!imagePath) continue;
            const dataUrl = await imageUrlToDataUrl(imagePath);
            if (dataUrl) refs.push(dataUrl);
        }

        if (settings.imageContextEnabled && refs.length < MAX_PROBLEMBO_REFERENCES) {
            const count = normalizeImageContextCount(settings.imageContextCount);
            const contextRefs = await collectPreviousContextReferences(messageId, 'dataUrl', count);
            refs.push(...contextRefs);
        }

        return refs.slice(0, MAX_PROBLEMBO_REFERENCES);
    }

    async uploadReference(dataUrl, index, settings, signal) {
        if (signal?.aborted) throw abortError(signal);
        const blobResponse = await fetch(dataUrl, { signal });
        const blob = await blobResponse.blob();
        if (!String(blob.type || '').startsWith('image/')) {
            throw new ProviderError({
                message: `Problembo reference ${index + 1} is not an image`,
                code: 'invalid_reference',
                retryable: false,
                providerId: 'problembo',
            });
        }

        const apiBase = getClientApiBase(settings);
        const headers = {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
        };
        const fileName = `novarakk-reference-${Date.now()}-${index}.${extensionForBlob(blob)}`;
        const initResponse = await problemboFetch(`${apiBase}/files/upload-url-for-src`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                origFileName: fileName,
                fileSizeBytes: String(blob.size),
            }),
            signal,
        });
        const initPayload = await readResponse(initResponse);
        if (!initResponse.ok || !initPayload.data?.fileId) {
            throw new ProviderError({
                message: `Problembo upload initialization failed: ${errorMessage(initPayload.data, initPayload.raw, `HTTP ${initResponse.status}`)}`,
                code: `upload_init_${initResponse.status}`,
                status: initResponse.status,
                retryable: isRetryableHttpStatus(initResponse.status),
                providerId: 'problembo',
            });
        }

        const { fileId, uploadUrl, multipartPlan } = initPayload.data;
        if (multipartPlan?.parts?.length) {
            const partSize = Number(multipartPlan.partSizeBytes || multipartPlan.partSize || 0);
            if (!partSize) {
                throw new ProviderError({
                    message: 'Problembo returned an invalid multipart upload plan',
                    code: 'invalid_multipart_plan',
                    retryable: false,
                    providerId: 'problembo',
                });
            }
            const completedParts = [];
            for (const part of multipartPlan.parts) {
                const partNumber = Number(part.partNumber);
                const start = (partNumber - 1) * partSize;
                const partResponse = await putBlob(part.uploadUrl, blob.slice(start, start + partSize), signal);
                completedParts.push({
                    partNumber,
                    etag: String(partResponse.headers.get('etag') || '').replace(/^"|"$/g, ''),
                });
            }
            const completeResponse = await problemboFetch(`${apiBase}/files/upload-multipart-complete`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ fileId, parts: completedParts }),
                signal,
            });
            if (!completeResponse.ok) {
                const payload = await readResponse(completeResponse);
                throw new ProviderError({
                    message: `Problembo multipart confirmation failed: ${errorMessage(payload.data, payload.raw, `HTTP ${completeResponse.status}`)}`,
                    code: `upload_complete_${completeResponse.status}`,
                    status: completeResponse.status,
                    retryable: isRetryableHttpStatus(completeResponse.status),
                    providerId: 'problembo',
                });
            }
        } else {
            if (!uploadUrl) {
                throw new ProviderError({
                    message: 'Problembo did not return an upload URL',
                    code: 'missing_upload_url',
                    retryable: false,
                    providerId: 'problembo',
                });
            }
            await putBlob(uploadUrl, blob, signal);
            const completeResponse = await problemboFetch(`${apiBase}/files/upload-complete`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ fileId }),
                signal,
            });
            if (!completeResponse.ok) {
                const payload = await readResponse(completeResponse);
                throw new ProviderError({
                    message: `Problembo upload confirmation failed: ${errorMessage(payload.data, payload.raw, `HTTP ${completeResponse.status}`)}`,
                    code: `upload_complete_${completeResponse.status}`,
                    status: completeResponse.status,
                    retryable: isRetryableHttpStatus(completeResponse.status),
                    providerId: 'problembo',
                });
            }
        }
        return fileId;
    }

    async generate({ prompt, style, references = [], options = {} }) {
        const settings = options.providerSettings || getSettings();
        const signal = options.signal;
        const apiBase = getClientApiBase(settings);
        const headers = {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
        };

        try {
            const modelInfo = await getCatalogModel(settings);
            let fullPrompt = buildFinalGenerationPrompt(
                prompt,
                style,
                options.matchedAdditionalRefs || [],
                settings,
            );
            if (references.length > 0) {
                const instruction = getEffectiveRefInstruction(settings);
                if (instruction) fullPrompt = `${instruction}\n\n${fullPrompt}`;
            }
            const originalPromptLength = fullPrompt.length;
            if (fullPrompt.length > MAX_PROMPT_LENGTH) {
                fullPrompt = fullPrompt.slice(0, MAX_PROMPT_LENGTH).trimEnd();
                iigLog(
                    'WARN',
                    `Problembo prompt truncated: ${originalPromptLength} -> ${fullPrompt.length} characters (API limit ${MAX_PROMPT_LENGTH})`,
                );
            }

            const initImageFileIds = [];
            const usableReferences = modelInfo?.supportInitImage === false
                ? []
                : references.slice(0, MAX_PROBLEMBO_REFERENCES);
            if (references.length > usableReferences.length) {
                iigLog(
                    'WARN',
                    `Problembo references reduced: ${references.length} -> ${usableReferences.length} for model ${settings.model}`,
                );
            }
            for (let index = 0; index < usableReferences.length; index++) {
                initImageFileIds.push(
                    await this.uploadReference(usableReferences[index], index, settings, signal),
                );
            }

            const body = {
                modelId: settings.model || DEFAULT_MODEL,
                prompt: fullPrompt,
                imageCount: modelInfo && modelInfo.isCountChange === false
                    ? Math.max(1, Number(modelInfo.count) || 1)
                    : 1,
                idempotencyKey: globalThis.crypto?.randomUUID?.()
                    || `novarakk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            };
            if (settings.problemboNegativePrompt && modelInfo?.supportNegPrompt !== false) {
                body.negativePrompt = String(settings.problemboNegativePrompt)
                    .trim()
                    .slice(0, MAX_PROMPT_LENGTH);
            }
            if (settings.problemboStyle) body.style = String(settings.problemboStyle).trim();
            if (String(settings.problemboSeed ?? '').trim()) {
                const seed = Number.parseInt(String(settings.problemboSeed), 10);
                if (Number.isSafeInteger(seed)) body.seed = seed;
            }
            const aspectRatio = normalizeProblemboEnum(
                settings.problemboAspectRatio,
                'PR_ASPECT_RATIO_',
                PROBLEMBO_ASPECT_RATIOS,
            );
            if (aspectRatio) body.aspectRatio = aspectRatio;
            const resolution = normalizeProblemboEnum(
                settings.problemboResolution,
                'PR_IMAGE_RESOLUTION_',
                PROBLEMBO_RESOLUTIONS,
            );
            if (resolution && (!modelInfo || modelInfo.supportedResolutions?.includes(resolution))) {
                body.resolution = resolution;
            }
            if (initImageFileIds.length > 0) body.initImageFileIds = initImageFileIds;

            iigLog(
                'INFO',
                `Problembo submit: model=${body.modelId} promptLength=${body.prompt.length} refs=${initImageFileIds.length} aspect=${body.aspectRatio || '(model default)'} resolution=${body.resolution || '(model default)'}`,
            );

            const submitResponse = await problemboFetch(`${apiBase}/image-gen/tasks`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal,
            });
            const submitPayload = await readResponse(submitResponse);
            if (!submitResponse.ok || !submitPayload.data?.taskId) {
                throw new ProviderError({
                    message: `Problembo task creation failed: ${errorMessage(submitPayload.data, submitPayload.raw, `HTTP ${submitResponse.status}`)}`,
                    code: submitPayload.data?.error?.errorKey || `submit_${submitResponse.status}`,
                    status: submitResponse.status,
                    retryable: isRetryableHttpStatus(submitResponse.status),
                    providerId: 'problembo',
                });
            }

            const taskId = submitPayload.data.taskId;
            const startedAt = Date.now();
            while (Date.now() - startedAt < TASK_TIMEOUT_MS) {
                await delay(POLL_INTERVAL_MS, signal);
                const statusResponse = await problemboFetch(
                    `${apiBase}/tasks/${encodeURIComponent(taskId)}`,
                    { method: 'GET', headers: { 'Authorization': `Bearer ${settings.apiKey}` }, signal },
                );
                if (statusResponse.status === 429) {
                    const retryAfterSeconds = Number(statusResponse.headers.get('retry-after') || 4);
                    await delay(Math.max(1, retryAfterSeconds) * 1_000, signal);
                    continue;
                }
                const statusPayload = await readResponse(statusResponse);
                if (!statusResponse.ok) {
                    throw new ProviderError({
                        message: `Problembo task polling failed: ${errorMessage(statusPayload.data, statusPayload.raw, `HTTP ${statusResponse.status}`)}`,
                        code: `poll_${statusResponse.status}`,
                        status: statusResponse.status,
                        retryable: isRetryableHttpStatus(statusResponse.status),
                        providerId: 'problembo',
                    });
                }

                const task = statusPayload.data || {};
                if (!task.ready) continue;
                if (task.status !== 'END_SUCCESS') {
                    throw new ProviderError({
                        message: `Problembo generation failed: ${errorMessage(task, '', task.status || 'Unknown task error')}`,
                        code: task?.error?.errorKey || task.status || 'task_failed',
                        retryable: ['BUSY', 'TIMEOUT', 'SERVICE_DISABLED', 'MAINTENANCE', 'END_TIMEOUT']
                            .includes(task?.error?.errorKey || task.status),
                        providerId: 'problembo',
                    });
                }

                const resultUrl = task?.result?.taskResult?.[0]?.url;
                if (!resultUrl) {
                    throw new ProviderError({
                        message: 'Problembo task finished without an image URL',
                        code: 'empty_result',
                        retryable: false,
                        providerId: 'problembo',
                    });
                }
                const downloadUrl = isCrossOrigin(resultUrl) ? corsProxyUrl(resultUrl) : resultUrl;
                let dataUrl = null;
                for (let attempt = 0; attempt < 3 && !dataUrl; attempt++) {
                    dataUrl = await imageUrlToDataUrl(downloadUrl);
                    if (!dataUrl && attempt < 2) await delay(1_000, signal);
                }
                if (!dataUrl) {
                    throw new ProviderError({
                        message: 'Could not download the generated image from Problembo',
                        code: 'result_download_failed',
                        // The remote generation already succeeded and may have
                        // been billed. Never submit another task just because
                        // downloading that existing result failed.
                        retryable: false,
                        providerId: 'problembo',
                    });
                }
                return dataUrl;
            }

            throw new ProviderError({
                message: 'Problembo generation timed out after 15 minutes',
                code: 'task_timeout',
                retryable: true,
                providerId: 'problembo',
            });
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw abortError(signal);
            if (error instanceof ProviderError) throw error;
            throw new ProviderError({
                message: `Problembo request failed: ${String(error?.message || error)}`,
                code: 'network',
                retryable: true,
                providerId: 'problembo',
                cause: error,
            });
        }
    }

    async fetchModels(settingsOverride = null) {
        const settings = settingsOverride || getSettings();
        try {
            const models = await loadCatalog(settings, true);
            return models.map(model => model.id);
        } catch (error) {
            iigLog('WARN', `Problembo model catalog failed: ${error?.message || error}`);
            const current = String(settings.model || '').trim();
            return [...new Set([DEFAULT_MODEL, current].filter(Boolean))];
        }
    }
}
