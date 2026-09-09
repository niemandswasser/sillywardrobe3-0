/**
 * Shared literal keyword matching for lorebook references and NPCs.
 * Commas are the canonical separator. Semicolons, line breaks and sentence-like
 * dots are accepted too, so a small typo in an alias list does not disable refs.
 */

function escapePattern(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeMatchText(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

export function splitMatchKeywords(value) {
    const values = Array.isArray(value) ? value : [value];
    const source = values.flatMap((item) => String(item || '')
        .replace(/[;\r\n]+/g, ',')
        .replace(/(\p{L}{3,})\.\s+(?=\p{Lu})/gu, '$1,')
        .split(','));
    const seen = new Set();
    const result = [];

    for (const item of source) {
        const keyword = normalizeMatchText(item);
        if (!keyword || seen.has(keyword)) continue;
        seen.add(keyword);
        result.push(keyword);
    }

    return result;
}

export function textContainsMatchKeyword(text, keyword) {
    const normalizedText = normalizeMatchText(text);
    const normalizedKeyword = normalizeMatchText(keyword);
    if (!normalizedText || !normalizedKeyword) return false;

    const pattern = escapePattern(normalizedKeyword).replace(/\s+/g, '\\s+');
    try {
        return new RegExp(`(^|[^\\p{L}\\p{N}_])${pattern}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(normalizedText);
    } catch (_error) {
        return normalizedText.includes(normalizedKeyword);
    }
}

export function findFirstMatchKeyword(text, keywords) {
    return splitMatchKeywords(keywords).find((keyword) => textContainsMatchKeyword(text, keyword)) || null;
}
