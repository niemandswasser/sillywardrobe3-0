/**
 * Пикер стилей с сайта (slayimagespromts): загрузка и парсинг HTML-каталога,
 * localStorage-кэш с ETag/Last-Modified, модалка выбора с фильтрами по тегам.
 */

import {
    getSettings,
    saveSettings,
    iigLog,
    ensureStyles,
    getActiveStyle,
    createStyle,
    updateStyle,
} from '../settings.js';
import { sanitizeForHtml } from '../utils.js';
import { t } from '../i18n.js';
import { renderStyleSettings } from './presets.js';

const IIG_STYLE_SOURCE_URL = 'https://wewwaistyping.github.io/slayimagespromts/';
const IIG_STYLE_CACHE_KEY = 'iig_site_styles_cache_v1';
const IIG_STYLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function readSiteStyleCache() {
    try {
        const raw = localStorage.getItem(IIG_STYLE_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed?.styles)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeSiteStyleCache(styles, meta = {}) {
    try {
        localStorage.setItem(IIG_STYLE_CACHE_KEY, JSON.stringify({
            styles,
            etag: meta.etag || '',
            lastModified: meta.lastModified || '',
            ts: Date.now(),
        }));
    } catch {
        // localStorage may be full or unavailable in embedded WebViews.
    }
}

function parseSiteStyles(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const styles = [];
    for (const card of doc.querySelectorAll('article.style-card')) {
        const name = card.querySelector('h2.card-title')?.textContent?.trim() || '';
        const tags = String(card.getAttribute('data-tags') || '')
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean);
        const descEl = card.querySelector('p.card-desc');
        const description = (descEl?.getAttribute('data-ru') || descEl?.textContent || '').trim();
        const images = Array.from(card.querySelectorAll('.carousel-track img'))
            .map((img) => {
                const src = img.getAttribute('src') || '';
                if (!src) return '';
                try {
                    return new URL(src, IIG_STYLE_SOURCE_URL).href;
                } catch {
                    return '';
                }
            })
            .filter(Boolean);
        const stableBadge = card.querySelector('.badge-green');
        const experimentalBadge = card.querySelector('.badge-yellow');
        const badgeEl = stableBadge || experimentalBadge;
        const badge = (badgeEl?.getAttribute('data-ru') || badgeEl?.textContent || '').trim();
        const promptRaw = card.querySelector('.prompt-panel[data-panel="direct"] .prompt-code')?.textContent?.trim() || '';
        const prompt = promptRaw.replace(/^\[Describe your scene here\]\.\s*/i, '').trim();
        if (name && prompt) {
            styles.push({ name, tags, description, images, badge, prompt });
        }
    }
    return styles;
}

async function fetchSiteStyles(cached = null, force = false) {
    const headers = {};
    if (!force && cached?.etag) headers['If-None-Match'] = cached.etag;
    if (!force && cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

    const response = await fetch(IIG_STYLE_SOURCE_URL, { headers });
    if (response.status === 304 && cached) {
        return { styles: cached.styles, notModified: true };
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const styles = parseSiteStyles(html);
    writeSiteStyleCache(styles, {
        etag: response.headers.get('ETag') || '',
        lastModified: response.headers.get('Last-Modified') || '',
    });
    return { styles, notModified: false };
}

function activateSiteStyle(styleName, stylePrompt) {
    const settings = getSettings();
    const prompt = String(stylePrompt || '').trim();
    if (!prompt) {
        settings.activeStyleId = '';
        saveSettings();
        renderStyleSettings();
        return;
    }

    const styles = ensureStyles(settings);
    const name = String(styleName || '').trim() || t`Imported style`;
    let style = styles.find((item) => item.value === prompt)
        || styles.find((item) => item.name === name);

    if (!style) {
        style = createStyle(name);
    }

    updateStyle(style.id, { name, value: prompt });
    settings.activeStyleId = style.id;
    saveSettings();
    renderStyleSettings();
}

export async function openStylePickerModal() {
    const settings = getSettings();
    const activeStyle = getActiveStyle(settings);
    const overlay = document.createElement('div');
    overlay.className = 'iig-style-overlay';
    overlay.innerHTML = `
        <div class="iig-style-modal">
            <div class="iig-style-modal-head">
                <span class="iig-style-modal-title"><i class="fa-solid fa-palette"></i> ${t`Choose style`}</span>
                <a class="iig-style-source-link" href="${IIG_STYLE_SOURCE_URL}" target="_blank" rel="noopener" title="${t`Open source site`}">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> ${t`Site`}
                </a>
                <div class="iig-style-refresh menu_button" title="${t`Refresh styles`}"><i class="fa-solid fa-rotate"></i></div>
                <div class="iig-style-modal-close menu_button" title="${t`Close`}"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="iig-style-filters"></div>
            <div class="iig-style-body"><div class="iig-style-loading">${t`Loading styles...`}</div></div>
        </div>
    `;
    document.body.appendChild(overlay);

    const modal = overlay.querySelector('.iig-style-modal');
    const bodyEl = overlay.querySelector('.iig-style-body');
    const filtersEl = overlay.querySelector('.iig-style-filters');
    const closeOverlay = (event = null) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        overlay.remove();
    };

    overlay.querySelector('.iig-style-modal-close')?.addEventListener('click', closeOverlay);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) closeOverlay(event); });
    modal?.addEventListener('click', (event) => event.stopPropagation());
    modal?.addEventListener('mousedown', (event) => event.stopPropagation());
    modal?.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
    modal?.addEventListener('touchend', (event) => event.stopPropagation(), { passive: true });
    modal?.addEventListener('pointerdown', (event) => event.stopPropagation());
    modal?.addEventListener('pointerup', (event) => event.stopPropagation());

    let styles = [];
    let activeTag = '';

    const renderFilters = () => {
        const tags = Array.from(new Set(styles.flatMap((style) => style.tags))).sort();
        const labels = {
            painting: t`Painting`,
            illustration: t`Illustration`,
            film: t`Film/photo`,
            game: t`Games`,
            cartoon: t`Cartoons`,
            anime: t`Anime`,
            print: t`Print`,
            '3d': '3D',
        };
        filtersEl.innerHTML = ['', ...tags].map((tag) => `
            <button class="iig-style-chip ${activeTag === tag ? 'active' : ''}" data-tag="${sanitizeForHtml(tag)}">${tag ? sanitizeForHtml(labels[tag] || tag) : t`All`}</button>
        `).join('');
        filtersEl.querySelectorAll('.iig-style-chip').forEach((button) => {
            button.addEventListener('click', () => {
                activeTag = button.getAttribute('data-tag') || '';
                renderFilters();
                renderGrid();
            });
        });
    };

    const makeCard = (style, selected, noReplace = false) => {
        if (noReplace) {
            return `
                <article class="iig-site-style-card ${selected ? 'selected' : ''}">
                    <div class="iig-site-style-preview iig-site-style-empty"><i class="fa-solid fa-ban"></i></div>
                    <button class="iig-site-style-body" data-style-prompt="" data-style-name="" type="button">
                        <span class="iig-site-style-name">${t`Do not replace`}</span>
                        <span class="iig-site-style-desc">${t`Use style from the prompt or no style.`}</span>
                    </button>
                </article>
            `;
        }

        const image = style.images?.[0] || '';
        return `
            <article class="iig-site-style-card ${selected ? 'selected' : ''}">
                <div class="iig-site-style-preview">
                    ${image ? `<img src="${sanitizeForHtml(image)}" alt="" loading="lazy">` : `<i class="fa-solid fa-image"></i>`}
                </div>
                <button class="iig-site-style-body" data-style-prompt="${encodeURIComponent(style.prompt)}" data-style-name="${encodeURIComponent(style.name)}" type="button">
                    <span class="iig-site-style-head">
                        <span class="iig-site-style-name">${sanitizeForHtml(style.name)}</span>
                        ${style.badge ? `<span class="iig-site-style-badge">${sanitizeForHtml(style.badge)}</span>` : ''}
                    </span>
                    ${style.description ? `<span class="iig-site-style-desc">${sanitizeForHtml(style.description)}</span>` : ''}
                </button>
            </article>
        `;
    };

    const renderGrid = () => {
        const visible = activeTag ? styles.filter((style) => style.tags.includes(activeTag)) : styles;
        bodyEl.innerHTML = `
            <div class="iig-style-grid">
                ${makeCard(null, !activeStyle, true)}
                ${visible.map((style) => makeCard(style, activeStyle?.value === style.prompt)).join('')}
            </div>
        `;

        bodyEl.querySelectorAll('.iig-site-style-body').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const prompt = button.getAttribute('data-style-prompt')
                    ? decodeURIComponent(button.getAttribute('data-style-prompt'))
                    : '';
                const name = button.getAttribute('data-style-name')
                    ? decodeURIComponent(button.getAttribute('data-style-name'))
                    : '';
                activateSiteStyle(name, prompt);
                setTimeout(() => closeOverlay(), 0);
            });
        });
    };

    const showStyles = (nextStyles) => {
        styles = nextStyles;
        renderFilters();
        renderGrid();
    };

    const cached = readSiteStyleCache();
    const cacheAge = cached ? Date.now() - (cached.ts || 0) : Infinity;
    if (cached?.styles?.length) {
        showStyles(cached.styles);
        fetchSiteStyles(cached, cacheAge > IIG_STYLE_CACHE_TTL_MS)
            .then((result) => {
                if (overlay.isConnected && !result.notModified) showStyles(result.styles);
            })
            .catch((error) => iigLog('WARN', `Style background refresh failed: ${error.message || error}`));
    } else {
        try {
            const result = await fetchSiteStyles(null, true);
            showStyles(result.styles);
        } catch (error) {
            bodyEl.innerHTML = `<p class="hint" style="padding: 16px;">${t`Failed to load styles`}: ${sanitizeForHtml(error.message || error)}</p>`;
        }
    }

    overlay.querySelector('.iig-style-refresh')?.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const button = event.currentTarget;
        if (!(button instanceof HTMLElement) || button.classList.contains('is-loading')) return;
        button.classList.add('is-loading');
        const icon = button.querySelector('i');
        const originalClass = icon?.className || '';
        if (icon) icon.className = 'fa-solid fa-spinner iig-spin-anim';
        try {
            const result = await fetchSiteStyles(null, true);
            showStyles(result.styles);
            toastr.success(t`Styles refreshed`, t`Image Generation`, { timeOut: 2000 });
        } catch (error) {
            toastr.error(t`Failed to refresh styles: ${error.message || error}`, t`Image Generation`);
        } finally {
            if (icon) icon.className = originalClass;
            button.classList.remove('is-loading');
        }
    });
}
