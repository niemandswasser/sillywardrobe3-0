/**
 * Классификация моделей и их capabilities: Gemini, OpenRouter, OpenAI.
 * Используется провайдерами и UI (getActiveProviderMaxReferences).
 */

import { getSettings, MAX_GENERATION_REFERENCE_IMAGES } from '../settings.js';

// ----- Gemini -----

export function isGeminiModel(modelId) {
    let mid = String(modelId || '').toLowerCase();
    // Убираем провайдер-префикс (google/ и т.п.).
    const slashIdx = mid.indexOf('/');
    if (slashIdx !== -1) mid = mid.slice(slashIdx + 1);
    // Принимаем как прокси-алиасы (nano-banana*), так и официальные id Google.
    return mid.includes('nano-banana')
        || mid.startsWith('gemini-2.5-flash-image')
        || mid.startsWith('gemini-3-pro-image')
        || mid.startsWith('gemini-3.1-flash-image');
}

/**
 * Классификация модели Gemini Image.
 *
 * Возвращает одну из:
 *   - `'gemini-3.1-flash-image'` (Nano Banana 2 Preview)
 *   - `'gemini-3-pro-image'`     (Nano Banana Pro Preview)
 *   - `'gemini-2.5-flash-image'` (Nano Banana — stable)
 *   - `'unknown'` — вернётся optimistic default для прокси с кастомными id.
 */
export function classifyGeminiModel(modelId) {
    let id = String(modelId || '').toLowerCase().trim();
    if (!id) return 'unknown';

    // Убираем провайдер-префикс (google/, openrouter/ и т.п.) для единообразной классификации.
    const slashIdx = id.indexOf('/');
    if (slashIdx !== -1) {
        id = id.slice(slashIdx + 1);
    }

    // Официальные id — проверяем точные префиксы.
    if (id.startsWith('gemini-3.1-flash-image')) return 'gemini-3.1-flash-image';
    if (id.startsWith('gemini-3-pro-image')) return 'gemini-3-pro-image';
    if (id.startsWith('gemini-2.5-flash-image')) return 'gemini-2.5-flash-image';

    // Прокси-алиасы. Проверяем по убыванию специфичности.
    if (id.includes('nano-banana-2') || id.includes('nano banana 2')) return 'gemini-3.1-flash-image';
    if (id.includes('nano-banana-pro') || id.includes('nano banana pro')) return 'gemini-3-pro-image';
    if (id.includes('nano-banana')) return 'gemini-2.5-flash-image';

    return 'unknown';
}

/**
 * Capabilities каждой Gemini-модели по официальным докам Google.
 *
 * - `maxReferences` — общее число входных картинок, которое модель обрабатывает
 *   с высокой точностью (3 / 11 / 14).
 * - `imageSizes` — whitelist значений для поля `imageConfig.imageSize`; для
 *   2.5 Flash Google игнорирует/не поддерживает параметр → `null`.
 * - `aspectRatios` — whitelist значений `imageConfig.aspectRatio`.
 */
const GEMINI_CAPS = Object.freeze({
    'gemini-3.1-flash-image': {
        maxReferences: 14,
        imageSizes: ['512', '1K', '2K', '4K'],
        aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'],
    },
    'gemini-3-pro-image': {
        maxReferences: 11,
        imageSizes: ['1K', '2K', '4K'],
        aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    },
    'gemini-2.5-flash-image': {
        maxReferences: 3,
        imageSizes: null, // модель не принимает imageSize, не отправляем
        aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    },
    'unknown': {
        maxReferences: MAX_GENERATION_REFERENCE_IMAGES,
        imageSizes: ['1K', '2K', '4K'],
        aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    },
});

export function getGeminiCapabilities(modelId) {
    return GEMINI_CAPS[classifyGeminiModel(modelId)] || GEMINI_CAPS.unknown;
}

// ----- OpenRouter -----

/**
 * Классификация OpenRouter image-модели по префиксу провайдера.
 *
 * Возвращает одну из:
 *   - `'gemini-3.1-flash-image'`
 *   - `'gemini-3-pro-image'`
 *   - `'gemini-2.5-flash-image'`
 *   - `'flux'`     — black-forest-labs/flux.*
 *   - `'sourceful'`
 *   - `'unknown'`
 */
export function classifyOpenRouterModel(modelId) {
    const id = String(modelId || '').toLowerCase().trim();
    if (!id) return 'unknown';

    // Gemini через OpenRouter: префикс `google/`.
    if (id.startsWith('google/')) {
        const stripped = id.slice('google/'.length);
        const geminiKind = classifyGeminiModel(stripped);
        if (geminiKind !== 'unknown') return geminiKind;
    }

    if (id.startsWith('black-forest-labs/')) return 'flux';
    if (id.startsWith('sourceful/')) return 'sourceful';
    return 'unknown';
}

export function isGeminiOpenRouterModel(modelId) {
    const kind = classifyOpenRouterModel(modelId);
    return kind === 'gemini-3.1-flash-image'
        || kind === 'gemini-3-pro-image'
        || kind === 'gemini-2.5-flash-image';
}

/**
 * Общий whitelist aspect ratios для generic OpenRouter моделей (flux и др.)
 * Документация OpenRouter: эти пресеты маппятся в конкретные размеры на
 * их стороне. 1:4/4:1/1:8/8:1 поддерживает только gemini-3.1-flash-image.
 */
const OPENROUTER_GENERIC_ASPECTS = Object.freeze(
    ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
);

/**
 * Capabilities OpenRouter-модели. Для gemini-* делегируется в GEMINI_CAPS,
 * иначе — generic (без image_size, общий aspect whitelist).
 */
export function getOpenRouterCapabilities(modelId) {
    const kind = classifyOpenRouterModel(modelId);
    if (kind === 'gemini-3.1-flash-image' || kind === 'gemini-3-pro-image' || kind === 'gemini-2.5-flash-image') {
        return GEMINI_CAPS[kind];
    }
    // flux / sourceful / unknown — aspect_ratio допустим, image_size не передаём.
    return {
        maxReferences: MAX_GENERATION_REFERENCE_IMAGES,
        imageSizes: null,
        aspectRatios: OPENROUTER_GENERIC_ASPECTS,
    };
}

// ----- OpenAI -----

/**
 * Классификация модели OpenAI-совместимого API.
 * Возвращает строку-идентификатор семейства.
 */
export function classifyOpenAIModel(modelId) {
    const id = String(modelId || '').toLowerCase().trim();
    // Сначала специфичные подстроки, потом общие.
    if (id.includes('gpt-image-2')) return 'gpt-image-2';
    if (id.includes('gpt-image-1.5') || id.includes('gpt-image-1-5')) return 'gpt-image-1.5';
    if (id.includes('gpt-image-1-mini')) return 'gpt-image-1-mini';
    if (id.includes('gpt-image-1')) return 'gpt-image-1';
    if (id.includes('gpt-image')) return 'gpt-image'; // generic prefix
    if (id.includes('flux-1-kontext')) return 'flux-kontext';
    if (id.includes('dall-e-3')) return 'dall-e-3';
    if (id.includes('dall-e-2')) return 'dall-e-2';
    return 'unknown';
}

/**
 * Считается ли модель «GPT Image семейством» — для них /edits поддерживает
 * множественные референсы через `image[]`.
 */
export function isGptImageFamily(kind) {
    return kind === 'gpt-image-2' || kind === 'gpt-image-1.5' || kind === 'gpt-image-1-mini'
        || kind === 'gpt-image-1' || kind === 'gpt-image';
}

/**
 * Максимум референсов, поддерживаемых конкретной моделью в `/v1/images/edits`:
 *   - gpt-image-*: до `MAX_GENERATION_REFERENCE_IMAGES` (мультиреф `image[]`).
 *   - flux-1-kontext-*: 1 (у Flux Kontext дизайн — один reference).
 *   - dall-e-2: 1.
 *   - dall-e-3 / unknown: 0 — через /edits они не ходят.
 */
export function getOpenAIModelMaxReferences(kind) {
    if (isGptImageFamily(kind)) return MAX_GENERATION_REFERENCE_IMAGES;
    if (kind === 'flux-kontext') return 1;
    if (kind === 'dall-e-2') return 1;
    return 0;
}

/**
 * aspect ratio → size для конкретного семейства модели.
 * Таблица из PLAN.md (раздел про OpenAI). Где размер не определён,
 * возвращает null — вызывающий код берёт settings.size либо 'auto'.
 */
export function aspectRatioToSize(aspect, modelKind) {
    if (!aspect) return null;

    // gpt-image-2: можно любые WxH, но для готовых пресетов из тега — таблица PLAN.
    if (modelKind === 'gpt-image-2') {
        const map = {
            '1:1': '1024x1024',
            '16:9': '2048x1152',
            '9:16': '1152x2048',
            '3:2': '1536x1024',
            '2:3': '1024x1536',
            '4:3': '1536x1152',
            '3:4': '1152x1536',
        };
        return map[aspect] || null;
    }

    // gpt-image-1.5 и gpt-image-1-mini и gpt-image-1: фиксированный список.
    if (modelKind === 'gpt-image-1.5' || modelKind === 'gpt-image-1-mini' || modelKind === 'gpt-image-1' || modelKind === 'gpt-image') {
        const map = {
            '1:1': '1024x1024',
            '16:9': '1536x1024',
            '9:16': '1024x1536',
            '3:2': '1536x1024',
            '2:3': '1024x1536',
            '4:3': '1536x1024',
            '3:4': '1024x1536',
        };
        return map[aspect] || null;
    }

    // dall-e-3
    if (modelKind === 'dall-e-3') {
        const map = {
            '1:1': '1024x1024',
            '16:9': '1792x1024',
            '9:16': '1024x1792',
        };
        return map[aspect] || null;
    }

    // dall-e-2 — только квадраты
    if (modelKind === 'dall-e-2') {
        return '1024x1024';
    }

    // unknown / flux-kontext — возвращаем null, используем settings.size.
    return null;
}

/**
 * Разрешённые значения `quality` для модели. Возвращает null если параметр
 * не поддерживается и его не нужно передавать.
 */
export function normalizeQualityForModel(userQuality, modelKind) {
    const q = String(userQuality || '').toLowerCase().trim();

    if (isGptImageFamily(modelKind)) {
        // gpt-image-*: low / medium / high / auto
        const allowed = new Set(['low', 'medium', 'high', 'auto']);
        if (allowed.has(q)) return q;
        // legacy значения UI: standard/hd → high
        if (q === 'hd') return 'high';
        if (q === 'standard') return 'medium';
        return 'auto';
    }

    if (modelKind === 'dall-e-3') {
        const allowed = new Set(['standard', 'hd']);
        return allowed.has(q) ? q : 'standard';
    }

    if (modelKind === 'dall-e-2') {
        return 'standard'; // единственное валидное значение
    }

    // unknown — передаём как есть, пусть прокси решает.
    return q || null;
}

// ----- Max references helper -----

/**
 * Возвращает максимальное число референсных картинок, которое принимает
 * активный провайдер для текущей модели. Используется в UI (warning об
 * усечении matched refs) и в провайдерских `collectReferences` (clipping).
 *
 * В случае provider/модели без поддержки референсов возвращает 0.
 */
export function getActiveProviderMaxReferences(settings = getSettings()) {
    const apiType = settings.apiType;
    if (apiType === 'openai' || apiType === 'electronhub') {
        const kind = classifyOpenAIModel(settings.model);
        return getOpenAIModelMaxReferences(kind) || 0;
    }
    if (apiType === 'gemini') {
        return getGeminiCapabilities(settings.model).maxReferences || 0;
    }
    if (apiType === 'openrouter') {
        return getOpenRouterCapabilities(settings.model).maxReferences || 0;
    }
    if (apiType === 'aigate') {
        if (isGeminiModel(settings.model)) {
            return getGeminiCapabilities(settings.model).maxReferences || 0;
        }
        const kind = classifyOpenAIModel(settings.model);
        return getOpenAIModelMaxReferences(kind) || 0;
    }
    if (apiType === 'naistera' || apiType === 'void') {
        return MAX_GENERATION_REFERENCE_IMAGES;
    }
    return 0;
}
