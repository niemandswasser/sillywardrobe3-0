/**
 * Chat Image Gallery — modal overlay showing generated images
 * as a browseable grid with file-manager actions:
 * view (lightbox), select, bulk download, bulk delete,
 * pagination, sorting, and configurable page size.
 *
 * Two scopes, switchable in the header:
 *   'chat'      — images embedded in messages of the current chat (DOM-based);
 *   'character' — all image files saved for the current character
 *                 (user/images/<char name>/, via /api/images/list).
 */

import { t } from './i18n.js';
import { getSettings, iigLog } from './settings.js';
import { sanitizeForHtml, parseInstructionAttr, downloadImageSrc, escapeRegex } from './utils.js';
import { rerenderMessageHtml } from './parser.js';
import { openLightboxWithSrc } from './lightbox.js';

const GALLERY_OVERLAY_ID = 'iig_gallery_overlay';
const PAGE_SIZE_OPTIONS = [6, 12, 24, 48];
const DEFAULT_PER_PAGE = 12;
const THUMB_SIZE_OPTIONS = [100, 130, 160, 200];
const DEFAULT_THUMB_SIZE = 130;

// ── Collect images from current chat ──

function collectChatImages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return [];

    const results = [];
    const messageElements = document.querySelectorAll('#chat .mes');

    for (const mesEl of messageElements) {
        const mesId = mesEl.getAttribute('mesid');
        if (mesId === null) continue;
        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];
        if (!message) continue;

        const imgs = mesEl.querySelectorAll('img[data-iig-instruction]');
        for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            if (!img.src || img.src.endsWith('[IMG:GEN]')) continue;
            if (img.classList.contains('iig-error-image')) continue;

            const data = parseInstructionAttr(img.getAttribute('data-iig-instruction'));
            const prompt = data?.prompt || '';
            const style = data?.style || '';

            const src = img.src;
            const filename = src.includes('/') ? src.split('/').pop() : src;

            results.push({
                src,
                prompt,
                style,
                messageId,
                tagIndex: i,
                order: results.length,
                filename: filename || `image_${i}`,
                isUser: !!message.is_user,
                charName: message.name || '',
            });
        }
    }

    return results;
}

function findLiveChatImage(item) {
    if (!item || item.messageId === null || item.messageId === undefined) return null;
    const mesEl = document.querySelector(`#chat .mes[mesid="${item.messageId}"], #chat [mesid="${item.messageId}"]`);
    if (!mesEl) return null;
    const images = Array.from(mesEl.querySelectorAll('img[data-iig-instruction]'));
    return images.find((image) => Number.parseInt(image.dataset.iigTagIndex || '', 10) === item.tagIndex)
        || images[item.tagIndex]
        || null;
}

function getLiveDownloadData(item) {
    if (item?.messageId === null || item?.messageId === undefined) return item;
    const liveImage = findLiveChatImage(item);
    if (!liveImage?.src || liveImage.classList.contains('iig-error-image')) return null;
    const src = liveImage.src;
    const filename = src.includes('/') ? src.split('/').pop() : src;
    return { ...item, src, filename: filename || item.filename };
}

// ── Collect all images of the current character (from disk) ──

async function getCharacterFolder() {
    const context = SillyTavern.getContext();
    // Same folder-resolution logic as the upload path in utils.js
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
    try {
        const resp = await fetch('/api/files/sanitize-filename', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ fileName: charName }),
        });
        if (resp.ok) {
            const data = await resp.json();
            if (data.fileName) return data.fileName;
        }
    } catch { /* fall back to raw name */ }
    return charName;
}

async function collectCharacterImages() {
    const context = SillyTavern.getContext();
    const folder = await getCharacterFolder();
    const resp = await fetch('/api/images/list', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ folder, sortField: 'date', sortOrder: 'asc' }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const files = await resp.json();
    const list = Array.isArray(files) ? files.filter(f => typeof f === 'string') : [];

    return list.map((file, i) => ({
        src: `user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`,
        diskPath: `user/images/${folder}/${file}`,
        prompt: '',
        style: '',
        messageId: null,
        tagIndex: 0,
        order: i,
        filename: file,
        isUser: false,
        charName: folder,
    }));
}

// ── Gallery state ──

let gs = {
    images: [],
    selected: new Set(),
    selectMode: false,
    page: 0,
    sort: 'newest',
    scope: 'chat', // 'chat' | 'character'
    perPage: DEFAULT_PER_PAGE,
    thumbSize: DEFAULT_THUMB_SIZE,
    showThumbSlider: false,
};

function resetState() {
    const perPage = gs.perPage || DEFAULT_PER_PAGE;
    const thumbSize = gs.thumbSize || DEFAULT_THUMB_SIZE;
    const scope = gs.scope || 'chat';
    gs = { images: [], selected: new Set(), selectMode: false, page: 0, sort: 'newest', scope, perPage, thumbSize, showThumbSlider: false };
}

function getSorted() {
    const imgs = gs.images.slice();
    switch (gs.sort) {
        case 'oldest':
            imgs.sort((a, b) => a.order - b.order);
            break;
        case 'name-asc':
            imgs.sort((a, b) => a.filename.localeCompare(b.filename));
            break;
        case 'name-desc':
            imgs.sort((a, b) => b.filename.localeCompare(a.filename));
            break;
        default: // newest
            imgs.sort((a, b) => b.order - a.order);
            break;
    }
    return imgs;
}

function getTotalPages() {
    return Math.max(1, Math.ceil(getSorted().length / gs.perPage));
}

function getPageImages() {
    const sorted = getSorted();
    const start = gs.page * gs.perPage;
    return sorted.slice(start, start + gs.perPage);
}

function clampPage() {
    const tp = getTotalPages();
    if (gs.page >= tp) gs.page = Math.max(0, tp - 1);
}

// ── Refresh helper ──

let loadToken = 0;

async function refreshGallery() {
    const overlay = document.getElementById(GALLERY_OVERLAY_ID);
    if (!overlay) return;
    const bodyEl = overlay.querySelector('#iig_gallery_body');
    const token = ++loadToken;
    gs.selected.clear();

    if (gs.scope === 'character' && bodyEl) {
        bodyEl.innerHTML = `<div class="iig-gallery-empty"><i class="fa-solid fa-spinner fa-spin"></i><p>${t`Loading images`}</p></div>`;
    }

    let images;
    try {
        images = gs.scope === 'character' ? await collectCharacterImages() : collectChatImages();
    } catch (err) {
        iigLog('ERROR', 'Gallery: failed to load images:', err);
        if (token === loadToken && bodyEl) {
            bodyEl.innerHTML = `<div class="iig-gallery-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>${t`Failed to load images`}</p></div>`;
        }
        return;
    }

    if (token !== loadToken || !document.getElementById(GALLERY_OVERLAY_ID)) return;
    gs.images = images;
    clampPage();
    updateSelectionUI(overlay);
    if (bodyEl) renderContent(bodyEl);
}

// ── Gallery modal ──

export function openGallery() {
    if (document.getElementById(GALLERY_OVERLAY_ID)) return;

    resetState();

    const overlay = document.createElement('div');
    overlay.id = GALLERY_OVERLAY_ID;
    overlay.className = 'iig-gallery-overlay';

    overlay.innerHTML = `
        <div class="iig-gallery-modal">
            <div class="iig-gallery-header">
                <span class="iig-gallery-title"><i class="fa-solid fa-images"></i> ${t`Chat Gallery`}</span>
                <span class="iig-gallery-count" id="iig_gallery_count"></span>
                <button class="iig-gallery-btn iig-gallery-close iig-gallery-close-mobile" id="iig_gallery_close_mobile" type="button" title="${t`Close`}">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <div class="iig-gallery-header-actions">
                    <div class="iig-gallery-scope" id="iig_gallery_scope">
                        <button class="iig-gallery-scope-btn ${gs.scope === 'chat' ? 'active' : ''}" data-gallery-scope="chat" type="button" title="${t`Images from current chat`}">
                            <i class="fa-solid fa-comment"></i> ${t`Chat`}
                        </button>
                        <button class="iig-gallery-scope-btn ${gs.scope === 'character' ? 'active' : ''}" data-gallery-scope="character" type="button" title="${t`All images of this character`}">
                            <i class="fa-solid fa-user"></i> ${t`All`}
                        </button>
                    </div>
                    <select class="iig-gallery-sort" id="iig_gallery_sort" title="${t`Sort`}">
                        <option value="newest" selected>${t`Newest`}</option>
                        <option value="oldest">${t`Oldest`}</option>
                        <option value="name-asc">A → Z</option>
                        <option value="name-desc">Z → A</option>
                    </select>
                    <select class="iig-gallery-perpage" id="iig_gallery_perpage" title="${t`Per page`}">
                        ${PAGE_SIZE_OPTIONS.map(n => `<option value="${n}" ${n === gs.perPage ? 'selected' : ''}>${n}</option>`).join('')}
                    </select>
                    <button class="iig-gallery-btn" id="iig_gallery_select_toggle" type="button" title="${t`Selection mode`}">
                        <i class="fa-regular fa-square-check"></i>
                    </button>
                    <button class="iig-gallery-btn" id="iig_gallery_select_all" type="button" title="${t`Select all`}" style="display:none">
                        <i class="fa-solid fa-check-double"></i>
                    </button>
                    <button class="iig-gallery-btn iig-gallery-btn-danger" id="iig_gallery_delete_selected" type="button" title="${t`Delete selected`}" style="display:none">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                    <button class="iig-gallery-btn" id="iig_gallery_download_selected" type="button" title="${t`Download selected`}" style="display:none">
                        <i class="fa-solid fa-download"></i>
                    </button>
                    <button class="iig-gallery-btn" id="iig_gallery_thumbsize_toggle" type="button" title="${t`Thumb size`}">
                        <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                    </button>
                    <button class="iig-gallery-btn iig-gallery-close" id="iig_gallery_close" type="button" title="${t`Close`}">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="iig-gallery-body" id="iig_gallery_body"></div>
            <div class="iig-gallery-footer" id="iig_gallery_footer"></div>
        </div>
    `;

    document.body.appendChild(overlay);

    const modal = overlay.querySelector('.iig-gallery-modal');
    const bodyEl = overlay.querySelector('#iig_gallery_body');

    // Close
    const close = () => {
        if (!overlay.isConnected) return;
        overlay._chatObserver?.disconnect();
        if (overlay._chatRefreshTimer) clearTimeout(overlay._chatRefreshTimer);
        resetState();
        overlay.remove();
    };
    const closeFromControl = (event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
    };
    for (const closeButton of overlay.querySelectorAll('.iig-gallery-close')) {
        closeButton.addEventListener('click', closeFromControl);
        closeButton.addEventListener('pointerup', closeFromControl);
        closeButton.addEventListener('touchend', closeFromControl, { passive: false });
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape' && document.getElementById(GALLERY_OVERLAY_ID)) {
            e.stopPropagation();
            close();
            document.removeEventListener('keydown', escHandler, true);
        }
    }, true);

    // Stop bubbling
    for (const ev of ['click', 'mousedown', 'pointerdown']) {
        modal.addEventListener(ev, (e) => e.stopPropagation());
    }

    // Keep the chat gallery in sync with completed rerolls. We intentionally
    // ignore removal of the old image/loading-placeholder insertion and only
    // refresh when a generated image is added or its src changes.
    const chat = document.getElementById('chat');
    if (chat) {
        const scheduleChatRefresh = () => {
            if (!overlay.isConnected || gs.scope !== 'chat') return;
            if (overlay._chatRefreshTimer) clearTimeout(overlay._chatRefreshTimer);
            overlay._chatRefreshTimer = setTimeout(() => {
                overlay._chatRefreshTimer = null;
                if (!overlay.isConnected || gs.scope !== 'chat') return;
                gs.images = collectChatImages();
                gs.selected.clear();
                clampPage();
                updateSelectionUI(overlay);
                renderContent(bodyEl);
            }, 120);
        };
        overlay._chatObserver = new MutationObserver((mutations) => {
            const changed = mutations.some((mutation) => {
                if (mutation.type === 'attributes') {
                    return mutation.target instanceof HTMLImageElement
                        && mutation.target.matches('img[data-iig-instruction]');
                }
                return Array.from(mutation.addedNodes).some((node) => node instanceof Element
                    && (node.matches?.('img[data-iig-instruction]') || node.querySelector?.('img[data-iig-instruction]')));
            });
            if (changed) scheduleChatRefresh();
        });
        overlay._chatObserver.observe(chat, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src'],
        });
    }

    // Scope toggle (chat / all character images)
    overlay.querySelectorAll('[data-gallery-scope]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const scope = btn.getAttribute('data-gallery-scope');
            if (scope === gs.scope) return;
            gs.scope = scope;
            gs.page = 0;
            gs.selected.clear();
            overlay.querySelectorAll('[data-gallery-scope]').forEach((b) => {
                b.classList.toggle('active', b.getAttribute('data-gallery-scope') === gs.scope);
            });
            refreshGallery();
        });
    });

    // Sort
    overlay.querySelector('#iig_gallery_sort').addEventListener('change', (e) => {
        gs.sort = e.target.value;
        gs.page = 0;
        gs.selected.clear();
        updateSelectionUI(overlay);
        renderContent(bodyEl);
    });

    // Per page
    overlay.querySelector('#iig_gallery_perpage').addEventListener('change', (e) => {
        gs.perPage = parseInt(e.target.value, 10) || DEFAULT_PER_PAGE;
        gs.page = 0;
        gs.selected.clear();
        updateSelectionUI(overlay);
        renderContent(bodyEl);
    });

    applyThumbSize(overlay);

    // Thumb size toggle
    overlay.querySelector('#iig_gallery_thumbsize_toggle').addEventListener('click', () => {
        gs.showThumbSlider = !gs.showThumbSlider;
        overlay.querySelector('#iig_gallery_thumbsize_toggle').classList.toggle('iig-gallery-btn-active', gs.showThumbSlider);
        const footerEl = overlay.querySelector('#iig_gallery_footer');
        if (footerEl) renderFooter(footerEl);
    });

    // Selection mode toggle
    overlay.querySelector('#iig_gallery_select_toggle').addEventListener('click', () => {
        gs.selectMode = !gs.selectMode;
        gs.selected.clear();
        updateSelectionUI(overlay);
        renderContent(bodyEl);
    });

    // Select all (on current page)
    overlay.querySelector('#iig_gallery_select_all').addEventListener('click', () => {
        const pageImgs = getPageImages();
        const allOnPage = pageImgs.every((_, i) => gs.selected.has(gs.page * gs.perPage + i));
        if (allOnPage) {
            pageImgs.forEach((_, i) => gs.selected.delete(gs.page * gs.perPage + i));
        } else {
            pageImgs.forEach((_, i) => gs.selected.add(gs.page * gs.perPage + i));
        }
        updateSelectionUI(overlay);
        renderContent(bodyEl);
    });

    // Download selected
    overlay.querySelector('#iig_gallery_download_selected').addEventListener('click', async () => {
        const selected = getSelectedImages();
        for (const img of selected) {
            await downloadGalleryImage(img);
        }
        toastr.success(`${t`Download`}: ${selected.length}`, t`Gallery`, { timeOut: 2000 });
    });

    // Delete selected
    overlay.querySelector('#iig_gallery_delete_selected').addEventListener('click', async () => {
        const selected = getSelectedImages();
        if (selected.length === 0) return;
        const confirmed = confirm(`${t`Delete selected`} (${selected.length})? ${t`This cannot be undone.`}`);
        if (!confirmed) return;

        for (const img of selected) {
            await deleteGalleryImage(img);
        }

        await refreshGallery();
        toastr.success(`${t`Delete selected`}: ${selected.length}`, t`Gallery`, { timeOut: 2000 });
    });

    refreshGallery();
    updateCount(overlay);
}

function getSelectedImages() {
    const sorted = getSorted();
    return Array.from(gs.selected)
        .sort((a, b) => b - a)
        .map(idx => sorted[idx])
        .filter(Boolean);
}

function updateSelectionUI(overlay) {
    const toggleBtn = overlay.querySelector('#iig_gallery_select_toggle');
    const selectAllBtn = overlay.querySelector('#iig_gallery_select_all');
    const deleteBtn = overlay.querySelector('#iig_gallery_delete_selected');
    const downloadBtn = overlay.querySelector('#iig_gallery_download_selected');

    toggleBtn.classList.toggle('iig-gallery-btn-active', gs.selectMode);
    selectAllBtn.style.display = gs.selectMode ? '' : 'none';
    deleteBtn.style.display = gs.selectMode ? '' : 'none';
    downloadBtn.style.display = gs.selectMode ? '' : 'none';

    deleteBtn.disabled = gs.selected.size === 0;
    downloadBtn.disabled = gs.selected.size === 0;

    updateCount(overlay);
}

function updateCount(overlay) {
    const countEl = overlay.querySelector('#iig_gallery_count');
    if (!countEl) return;
    const total = gs.images.length;
    const selCount = gs.selected.size;
    if (gs.selectMode && selCount > 0) {
        countEl.textContent = `${selCount} / ${total}`;
    } else {
        countEl.textContent = `${total}`;
    }
}

// ── Render grid + pagination ──

function applyThumbSize(overlay) {
    overlay.style.setProperty('--iig-gallery-thumb-min', gs.thumbSize + 'px');
}

function renderContent(bodyEl) {
    clampPage();
    const sorted = getSorted();
    const overlay = document.getElementById(GALLERY_OVERLAY_ID);

    if (sorted.length === 0) {
        const emptyText = gs.scope === 'character' ? t`No images found for this character` : t`No generated images in this chat`;
        bodyEl.innerHTML = `<div class="iig-gallery-empty"><i class="fa-regular fa-image"></i><p>${emptyText}</p></div>`;
        if (overlay) renderFooter(overlay.querySelector('#iig_gallery_footer'));
        return;
    }

    const pageImages = getPageImages();
    const startIdx = gs.page * gs.perPage;

    const cardsHtml = pageImages.map((img, i) => {
        const globalIdx = startIdx + i;
        const isSelected = gs.selected.has(globalIdx);
        const promptShort = (img.prompt || '').slice(0, 80) + ((img.prompt || '').length > 80 ? '…' : '');

        return `
            <div class="iig-gallery-card ${isSelected ? 'iig-gallery-card-selected' : ''}" data-gallery-idx="${globalIdx}">
                <div class="iig-gallery-thumb-wrap">
                    <img class="iig-gallery-thumb" src="${sanitizeForHtml(img.src)}" alt="" loading="lazy">
                    ${gs.selectMode ? `<div class="iig-gallery-checkbox ${isSelected ? 'checked' : ''}"><i class="fa-${isSelected ? 'solid fa-square-check' : 'regular fa-square'}"></i></div>` : ''}
                </div>
                <div class="iig-gallery-card-info">
                    ${img.messageId !== null ? `<span class="iig-gallery-card-msg" title="${t`Message`} #${img.messageId}">#${img.messageId} · ${sanitizeForHtml(img.charName)}</span>` : ''}
                    <span class="iig-gallery-card-filename" title="${sanitizeForHtml(img.filename)}">${sanitizeForHtml(img.filename)}</span>
                    ${promptShort ? `<span class="iig-gallery-card-prompt" title="${sanitizeForHtml(img.prompt)}">${sanitizeForHtml(promptShort)}</span>` : ''}
                </div>
                <div class="iig-gallery-card-actions">
                    <button class="iig-gallery-card-btn" data-gallery-action="download" data-gallery-idx="${globalIdx}" title="${t`Download`}"><i class="fa-solid fa-download"></i></button>
                    <button class="iig-gallery-card-btn iig-gallery-card-btn-danger" data-gallery-action="delete" data-gallery-idx="${globalIdx}" title="${t`Delete`}"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        `;
    }).join('');

    bodyEl.innerHTML = `<div class="iig-gallery-grid">${cardsHtml}</div>`;

    if (overlay) {
        applyThumbSize(overlay);
        renderFooter(overlay.querySelector('#iig_gallery_footer'));
    }

    bodyEl.removeEventListener('click', handleBodyClick);
    bodyEl.addEventListener('click', handleBodyClick);
}

function renderFooter(footerEl) {
    if (!footerEl) return;
    const paginationHtml = buildPaginationHtml();
    const thumbSliderHtml = gs.showThumbSlider ? `
        <div class="iig-gallery-thumb-size-wrap">
            <i class="fa-solid fa-image" style="font-size:10px;opacity:0.5"></i>
            <input type="range" class="iig-gallery-thumb-slider" id="iig_gallery_thumb_size"
                min="${THUMB_SIZE_OPTIONS[0]}" max="${THUMB_SIZE_OPTIONS[THUMB_SIZE_OPTIONS.length - 1]}"
                step="10" value="${gs.thumbSize}">
            <i class="fa-solid fa-image" style="font-size:16px;opacity:0.5"></i>
        </div>
    ` : '';
    const hasContent = paginationHtml || thumbSliderHtml;
    footerEl.innerHTML = hasContent ? `<div class="iig-gallery-footer-row">${paginationHtml}${thumbSliderHtml}</div>` : '';
    footerEl.style.display = hasContent ? '' : 'none';
    const slider = footerEl.querySelector('#iig_gallery_thumb_size');
    if (slider) {
        slider.addEventListener('input', (e) => {
            gs.thumbSize = parseInt(e.target.value, 10) || DEFAULT_THUMB_SIZE;
            const overlay = document.getElementById(GALLERY_OVERLAY_ID);
            if (overlay) applyThumbSize(overlay);
        });
    }
    footerEl.removeEventListener('click', handleBodyClick);
    footerEl.addEventListener('click', handleBodyClick);
}

function buildPaginationHtml() {
    const totalPages = getTotalPages();
    if (totalPages <= 1) return '';

    const pages = [];
    for (let i = 0; i < totalPages; i++) {
        if (totalPages > 7) {
            const show = i === 0 || i === totalPages - 1
                || (i >= gs.page - 1 && i <= gs.page + 1);
            if (!show) {
                if (pages.length && pages[pages.length - 1] !== '…') pages.push('…');
                continue;
            }
        }
        pages.push(i);
    }

    const btns = pages.map(p => {
        if (p === '…') return `<span class="iig-gallery-page-ellipsis">…</span>`;
        return `<button class="iig-gallery-page-btn ${p === gs.page ? 'active' : ''}" data-gallery-page="${p}" type="button">${p + 1}</button>`;
    }).join('');

    return `
        <div class="iig-gallery-pagination">
            <button class="iig-gallery-page-btn" data-gallery-page-prev type="button" ${gs.page <= 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>
            ${btns}
            <button class="iig-gallery-page-btn" data-gallery-page-next type="button" ${gs.page >= totalPages - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>
        </div>
    `;
}

// ── Delegated click handler ──

function handleBodyClick(e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    // Pagination
    const pageBtn = target.closest('[data-gallery-page]');
    if (pageBtn) {
        gs.page = parseInt(pageBtn.getAttribute('data-gallery-page'), 10);
        gs.selected.clear();
        const overlay = document.getElementById(GALLERY_OVERLAY_ID);
        const bodyEl = overlay?.querySelector('#iig_gallery_body');
        if (overlay) updateSelectionUI(overlay);
        if (bodyEl) renderContent(bodyEl);
        bodyEl?.scrollTo({ top: 0, behavior: 'smooth' });
        return;
    }
    if (target.closest('[data-gallery-page-prev]')) {
        if (gs.page > 0) { gs.page--; gs.selected.clear(); }
        const overlay = document.getElementById(GALLERY_OVERLAY_ID);
        const bodyEl = overlay?.querySelector('#iig_gallery_body');
        if (overlay) updateSelectionUI(overlay);
        if (bodyEl) renderContent(bodyEl);
        bodyEl?.scrollTo({ top: 0, behavior: 'smooth' });
        return;
    }
    if (target.closest('[data-gallery-page-next]')) {
        if (gs.page < getTotalPages() - 1) { gs.page++; gs.selected.clear(); }
        const overlay = document.getElementById(GALLERY_OVERLAY_ID);
        const bodyEl = overlay?.querySelector('#iig_gallery_body');
        if (overlay) updateSelectionUI(overlay);
        if (bodyEl) renderContent(bodyEl);
        bodyEl?.scrollTo({ top: 0, behavior: 'smooth' });
        return;
    }

    // Card action buttons
    const actionBtn = target.closest('[data-gallery-action]');
    if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.getAttribute('data-gallery-action');
        const idx = parseInt(actionBtn.getAttribute('data-gallery-idx'), 10);
        const sorted = getSorted();
        const img = sorted[idx];
        if (!img) return;

        if (action === 'download') {
            downloadGalleryImage(img);
        } else if (action === 'delete') {
            handleSingleDelete(idx);
        }
        return;
    }

    // Card click — select mode or lightbox
    const card = target.closest('.iig-gallery-card[data-gallery-idx]');
    if (card) {
        const idx = parseInt(card.getAttribute('data-gallery-idx'), 10);
        if (gs.selectMode) {
            if (gs.selected.has(idx)) gs.selected.delete(idx);
            else gs.selected.add(idx);
            const overlay = document.getElementById(GALLERY_OVERLAY_ID);
            const bodyEl = overlay?.querySelector('#iig_gallery_body');
            if (overlay) updateSelectionUI(overlay);
            if (bodyEl) renderContent(bodyEl);
        } else {
            openGalleryLightbox(idx);
        }
    }
}

// ── Single delete ──

async function handleSingleDelete(idx) {
    const sorted = getSorted();
    const img = sorted[idx];
    if (!img) return;
    const confirmText = img.messageId === null ? t`Delete this image file from disk?` : t`Delete this image from chat?`;
    const confirmed = confirm(confirmText);
    if (!confirmed) return;

    await deleteGalleryImage(img);
    await refreshGallery();
    toastr.success(t`Image deleted`, t`Gallery`, { timeOut: 2000 });
}

async function deleteGalleryImage(img) {
    if (img.messageId === null) {
        await deleteImageFile(img);
    } else {
        await deleteImageFromChat(img);
    }
}

// ── Lightbox from gallery ──

function restoreOverlayWhenLightboxCloses(overlay) {
    const lightbox = document.getElementById('iig_lightbox');
    if (lightbox && lightbox.classList.contains('open')) {
        const observer = new MutationObserver(() => {
            if (!lightbox.classList.contains('open')) {
                observer.disconnect();
                if (overlay) overlay.style.display = '';
            }
        });
        observer.observe(lightbox, { attributes: true, attributeFilter: ['class'] });
    } else {
        if (overlay) overlay.style.display = '';
    }
}

function showGalleryLightboxImage(idx) {
    const sorted = getSorted();
    const img = sorted[idx];
    if (!img) return false;

    const current = getLiveDownloadData(img);
    if (!current) return false;

    openLightboxWithSrc(current.src, current.prompt, current.style, {
        onPrevious: idx > 0 ? () => showGalleryLightboxImage(idx - 1) : null,
        onNext: idx < sorted.length - 1 ? () => showGalleryLightboxImage(idx + 1) : null,
    });
    return true;
}

function openGalleryLightbox(idx) {
    const sorted = getSorted();
    if (!sorted[idx]) return;

    const overlay = document.getElementById(GALLERY_OVERLAY_ID);
    if (overlay) overlay.style.display = 'none';

    // Disk files (character scope) aren't tied to a chat message — open directly
    if (showGalleryLightboxImage(idx)) {
        restoreOverlayWhenLightboxCloses(overlay);
    } else {
        if (overlay) overlay.style.display = '';
    }
}

// ── Download ──

async function downloadGalleryImage(img) {
    const current = getLiveDownloadData(img);
    if (!current) {
        toastr.info(t`Image is still being regenerated`, t`Gallery`, { timeOut: 2500 });
        return;
    }
    await downloadImageSrc(current.src, current.filename || null);
}

// ── Delete image from chat message ──

async function deleteImageFromChat(img) {
    const context = SillyTavern.getContext();
    const message = context.chat[img.messageId];
    if (!message) return;

    // В message.mes src хранится относительным путём ("user/images/...") без
    // percent-encoding, а DOM img.src — абсолютный закодированный URL.
    // Матчим все варианты записи.
    const variants = new Set([img.src]);
    if (!img.src.startsWith('data:')) {
        try {
            const pathname = new URL(img.src, location.origin).pathname;
            const decoded = decodeURIComponent(pathname);
            for (const p of [pathname, decoded]) {
                variants.add(p);
                variants.add(p.replace(/^\//, ''));
            }
        } catch { /* оставляем только абсолютный src */ }
    }
    const srcPattern = Array.from(variants).map(escapeRegex).join('|');
    const imgTagRegex = new RegExp(
        `<img\\s[^>]*src\\s*=\\s*["'](?:${srcPattern})["'][^>]*>`,
        'i',
    );

    const stripTag = (text) => String(text).replace(imgTagRegex, '');
    if (message.mes) message.mes = stripTag(message.mes);
    if (message.extra?.display_text) message.extra.display_text = stripTag(message.extra.display_text);
    if (message.extra?.extblocks) message.extra.extblocks = stripTag(message.extra.extblocks);

    // Зеркала текущего свайпа — иначе картинка «воскресает» после свайпа туда-обратно
    const swipeId = message.swipe_id;
    if (swipeId !== undefined) {
        if (Array.isArray(message.swipes) && typeof message.swipes[swipeId] === 'string') {
            message.swipes[swipeId] = stripTag(message.swipes[swipeId]);
        }
        const swipeExtra = message.swipe_info?.[swipeId]?.extra;
        if (swipeExtra?.extblocks) swipeExtra.extblocks = stripTag(swipeExtra.extblocks);
        if (swipeExtra?.display_text) swipeExtra.display_text = stripTag(swipeExtra.display_text);
    }

    const mesEl = document.querySelector(`#chat .mes[mesid="${img.messageId}"]`);
    const mesTextEl = mesEl?.querySelector('.mes_text');
    if (mesTextEl) {
        const settings = getSettings();
        rerenderMessageHtml(context, message, settings, img.messageId, mesTextEl);
    }

    await context.saveChat();

    if (img.src && !img.src.startsWith('data:')) {
        try {
            const path = img.src.startsWith('/') ? img.src : new URL(img.src, location.origin).pathname;
            await fetch('/api/images/delete', {
                method: 'POST',
                headers: context.getRequestHeaders(),
                body: JSON.stringify({ path }),
            });
        } catch (err) {
            iigLog('WARN', 'Gallery: failed to delete image file:', err);
        }
    }
}

// ── Delete image file from disk (character scope) ──

async function deleteImageFile(img) {
    if (!img.diskPath) return;
    const context = SillyTavern.getContext();
    try {
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ path: img.diskPath }),
        });
    } catch (err) {
        iigLog('WARN', 'Gallery: failed to delete image file:', err);
    }
}

// ── Wand menu button ──

export function addGalleryWandButton() {
    if (document.getElementById('iig_gallery_wand_button')) return;

    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;

    const btn = document.createElement('div');
    btn.id = 'iig_gallery_wand_button';
    btn.className = 'list-group-item flex-container flexGap5';
    btn.innerHTML = `<div class="fa-solid fa-images extensionsMenuExtensionButton"></div><span>${t`Chat Gallery`}</span>`;
    btn.addEventListener('click', () => openGallery());
    menu.appendChild(btn);
}

// ── Init ──

export function initGallery() {
    const context = SillyTavern.getContext();
    context.eventSource.on(context.event_types.APP_READY, () => {
        addGalleryWandButton();
    });
}
