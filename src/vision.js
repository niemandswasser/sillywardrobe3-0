/**
 * Vision API для авто-генерации текстовых описаний одежды по картинке.
 *
 * Использует свой эндпоинт/ключ/модель (settings.vision*). Если они пусты —
 * фолбэк на основные настройки API. Совместимо с OpenAI-style chat
 * completions (image_url + text в одном messages[0].content[]).
 */

import { getSettings, saveSettings, iigLog, ensureLorebooks } from './settings.js';
import {
    ensureAvatarItems,
    updateAvatarItemAppearance,
    ensureNpcList,
    updateNpc,
} from './extras.js';
import { normalizeStoredImagePath, imageUrlToBase64 } from './utils.js';
import { t } from './i18n.js';

export const DEFAULT_VISION_PROMPT = 'Describe this clothing outfit in detail for a character in a roleplay. Focus on: type of garment, color, material/texture, style, notable features, accessories. Be concise but thorough (2-4 sentences). Write in English.';

function getEffectiveVisionConfig(settings = getSettings()) {
    const endpoint = String(settings.visionEndpoint || '').trim() || String(settings.endpoint || '').trim();
    const apiKey = String(settings.visionApiKey || '').trim() || String(settings.apiKey || '').trim();
    const model = String(settings.visionModel || '').trim();
    const promptText = String(settings.visionPrompt || '').trim() || DEFAULT_VISION_PROMPT;
    return { endpoint, apiKey, model, promptText };
}

/**
 * Тянет список моделей через OpenAI-совместимый /v1/models с эндпоинта,
 * настроенного для vision (или основного), без фильтра по image-keywords —
 * наоборот, отбираем не-image (text/vision/multimodal) модели.
 */
export async function fetchVisionModels() {
    const { endpoint, apiKey } = getEffectiveVisionConfig();
    if (!endpoint || !apiKey) return [];

    const url = `${endpoint.replace(/\/+$/, '')}/v1/models`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const list = Array.isArray(data?.data) ? data.data : [];
        // Эвристика: не отбрасываем по imageModel — отдаём всё, пользователь
        // выберет vision-capable. Только сортировка по id для удобства.
        return list.map((m) => String(m?.id || '')).filter(Boolean).sort();
    } catch (error) {
        iigLog('ERROR', `Vision fetchModels failed: ${error.message || error}`);
        toastr.error(t`Failed to load vision models: ${error.message || error}`, t`Image Generation`);
        return [];
    }
}

// ----- Shared low-level helper -----

export const DEFAULT_APPEARANCE_VISION_PROMPT = 'Describe this character\'s physical appearance in detail. Focus on: face features, eye color, hair color and style, skin tone, body type, distinctive features. Be concise but thorough (2-4 sentences). Write in English.';
export const DEFAULT_REFERENCE_APPEARANCE_VISION_PROMPT = 'Describe the visible character appearance or appearance detail in this reference image. Include relevant face, hair, body, clothing, colors, materials, accessories, and distinctive features, but only what is actually visible. Be concise but thorough (2-4 sentences). Write in English.';

export async function callVisionApi(imageBase64, promptText) {
    const settings = getSettings();
    const { endpoint, apiKey, model } = getEffectiveVisionConfig(settings);
    if (!endpoint) throw new Error(t`Vision endpoint not configured`);
    if (!apiKey) throw new Error(t`Vision API key not configured`);
    if (!model) throw new Error(t`Vision model not selected`);

    const url = `${endpoint.replace(/\/+$/, '')}/v1/chat/completions`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
                    { type: 'text', text: promptText },
                ],
            }],
            max_tokens: 500,
            temperature: 0.3,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`API ${response.status}: ${String(errorText).slice(0, 400)}`);
    }

    const result = await response.json();
    const description = String(result?.choices?.[0]?.message?.content || '').trim();
    if (!description) throw new Error(t`Vision model returned empty response`);
    return description;
}

// ----- Avatar appearance -----

/**
 * Генерирует описание внешности аватара (не одежды) через vision API.
 * Сохраняет в `item.appearance` и возвращает текст.
 */
export async function generateAvatarAppearanceDescription(itemId) {
    const settings = getSettings();
    const item = ensureAvatarItems(settings).find((a) => a.id === itemId);
    if (!item?.imageData) throw new Error(t`No image data for this avatar`);

    const description = await callVisionApi(item.imageData, DEFAULT_APPEARANCE_VISION_PROMPT);
    iigLog('INFO', `Vision generated appearance for avatar "${item.name}": ${description.slice(0, 100)}`);
    updateAvatarItemAppearance(itemId, description);
    return description;
}

// ----- NPC appearance -----

/**
 * Генерирует описание внешности NPC по его аватарке через vision API.
 * Сохраняет в `npc.appearance` и возвращает текст.
 */
export async function generateNpcAppearanceDescription(npcId) {
    const settings = getSettings();
    const npc = ensureNpcList(settings).find((n) => n.id === npcId);
    if (!npc?.avatarData) throw new Error(t`No avatar image for this NPC`);

    const description = await callVisionApi(npc.avatarData, DEFAULT_APPEARANCE_VISION_PROMPT);
    iigLog('INFO', `Vision generated appearance for NPC "${npc.name}": ${description.slice(0, 100)}`);
    updateNpc(npcId, { appearance: description });
    return description;
}

// ----- Lorebook reference description -----

/**
 * Генерирует описание для ref-записи лорбука по её изображению через vision API.
 * Сохраняет в `ref.description` и возвращает текст.
 */
export async function generateReferenceDescription(refId) {
    const settings = getSettings();

    let targetRef = null;
    for (const lb of ensureLorebooks(settings)) {
        const found = lb.refs.find((r) => r.id === refId);
        if (found) { targetRef = found; break; }
    }
    if (!targetRef) throw new Error(t`Reference not found`);

    const imagePath = normalizeStoredImagePath(targetRef.imagePath);
    if (!imagePath) throw new Error(t`No image for this reference`);

    const imageBase64 = await imageUrlToBase64(imagePath);
    if (!imageBase64) throw new Error(t`Failed to load reference image`);

    const refPrompt = 'Describe what is shown in this reference image. Focus on the appearance, features, colors, and distinctive characteristics. Be concise but thorough (2-4 sentences). Write in English.';
    const description = await callVisionApi(imageBase64, refPrompt);
    iigLog('INFO', `Vision generated description for ref "${targetRef.name}": ${description.slice(0, 100)}`);

    targetRef.description = description;
    saveSettings();
    return description;
}
