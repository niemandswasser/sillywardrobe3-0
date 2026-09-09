/**
 * Extras (порт из MG): библиотека аватаров (гриды с сортировкой/тегами/
 * пагинацией, панель описания внешности), список NPC и биндинг
 * wardrobe/vision/NPC-настроек.
 */

import {
    getSettings,
    saveSettings,
    iigLog,
    ensureAvatarTags,
    addAvatarTag,
    removeAvatarTag,
} from '../settings.js';
import { sanitizeForHtml } from '../utils.js';
import {
    ensureNpcList,
    addNpc,
    removeNpc,
    updateNpc,
    toggleNpc,
    updateWardrobeInjection,
    ensureAvatarItems,
    addAvatarItem,
    removeAvatarItem,
    setActiveAvatar,
    getActiveAvatarItem,
    updateAvatarItemName,
    updateAvatarItemAppearance,
    updateAvatarAppearanceInjection,
    toggleAvatarFavorite,
    updateAvatarItemTags,
    fileToResizedBase64,
} from '../extras.js';
import {
    fetchVisionModels,
    generateAvatarAppearanceDescription,
    generateNpcAppearanceDescription,
} from '../vision.js';
import { swOpenModal, swInjectBarBtn } from '../wardrobe.js';
import { t } from '../i18n.js';
import { Popup } from '../../../../../popup.js';

// ----- Avatar library view state -----

const AVATARS_PER_PAGE = 12;
const avatarVS = {
    char: { page: 0, sort: 'newest', filter: 'all', filterTag: '' },
    user: { page: 0, sort: 'newest', filter: 'all', filterTag: '' },
};

// ----- Render: Avatar Library grids -----

function getAvatarSortedFiltered(settings, target) {
    const vs = avatarVS[target] || avatarVS.char;
    let items = ensureAvatarItems(settings).filter((a) => a.target === target);
    if (vs.filter === 'favorites') items = items.filter((a) => a.favorite);
    if (vs.filterTag) items = items.filter((a) => (a.tags || []).includes(vs.filterTag));
    switch (vs.sort) {
        case 'oldest': items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); break;
        case 'az': items.sort((a, b) => a.name.localeCompare(b.name)); break;
        case 'za': items.sort((a, b) => b.name.localeCompare(a.name)); break;
        case 'favorites': items.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0)); break;
        default: items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    return items;
}

function buildAvatarSortBarHtml(target, settings) {
    const vs = avatarVS[target] || avatarVS.char;
    const totalCount = ensureAvatarItems(settings).filter((a) => a.target === target).length;
    const tags = ensureAvatarTags(settings);
    const tagChips = tags.map((tag) =>
        `<div class="iig-styles-filter-chip ${vs.filterTag === tag ? 'active' : ''}" data-ava-filter-tag="${sanitizeForHtml(tag)}">${sanitizeForHtml(tag)}</div>`).join('');
    return `
        <div class="iig-ava-sort-bar">
            <select class="text_pole" data-ava-sort="${target}">
                <option value="newest" ${vs.sort === 'newest' ? 'selected' : ''}>${t`Newest`}</option>
                <option value="oldest" ${vs.sort === 'oldest' ? 'selected' : ''}>${t`Oldest`}</option>
                <option value="az" ${vs.sort === 'az' ? 'selected' : ''}>A → Z</option>
                <option value="za" ${vs.sort === 'za' ? 'selected' : ''}>Z → A</option>
                <option value="favorites" ${vs.sort === 'favorites' ? 'selected' : ''}>★ ${t`first`}</option>
            </select>
            <div class="iig-styles-filter-chip ${vs.filter === 'all' ? 'active' : ''}" data-ava-filter-all>${t`All`} (${totalCount})</div>
            <div class="iig-styles-filter-chip ${vs.filter === 'favorites' ? 'active' : ''}" data-ava-filter-fav>★</div>
            ${tagChips}
        </div>`;
}

function buildAvatarPaginationHtml(target, totalPages) {
    const vs = avatarVS[target] || avatarVS.char;
    if (totalPages <= 1) return '';
    let html = '<div class="iig-styles-pagination">';
    html += `<div class="iig-styles-page-btn ${vs.page <= 0 ? 'disabled' : ''}" data-ava-page-prev><i class="fa-solid fa-chevron-left"></i></div>`;
    for (let i = 0; i < totalPages; i++) {
        html += `<div class="iig-styles-page-btn ${i === vs.page ? 'active' : ''}" data-ava-page="${i}">${i + 1}</div>`;
    }
    html += `<div class="iig-styles-page-btn ${vs.page >= totalPages - 1 ? 'disabled' : ''}" data-ava-page-next><i class="fa-solid fa-chevron-right"></i></div>`;
    html += '</div>';
    return html;
}

export function renderAvatarGrid(target) {
    const settings = getSettings();
    const containerId = target === 'user' ? 'iig_avatar_lib_user' : 'iig_avatar_lib_char';
    const container = document.getElementById(containerId);
    if (!container) return;

    const vs = avatarVS[target] || avatarVS.char;
    const allSorted = getAvatarSortedFiltered(settings, target);
    const totalPages = Math.max(1, Math.ceil(allSorted.length / AVATARS_PER_PAGE));
    if (vs.page >= totalPages) vs.page = Math.max(0, totalPages - 1);
    const pageItems = allSorted.slice(vs.page * AVATARS_PER_PAGE, (vs.page + 1) * AVATARS_PER_PAGE);
    const activeId = target === 'user' ? settings.activeAvatarUser : settings.activeAvatarChar;

    const sortBar = buildAvatarSortBarHtml(target, settings);

    let gridHtml;
    if (allSorted.length === 0) {
        const totalItems = ensureAvatarItems(settings).filter((a) => a.target === target).length;
        let emptyMsg;
        if (totalItems === 0) emptyMsg = t`No avatars yet. Add one below.`;
        else if (vs.filter === 'favorites' && vs.filterTag) emptyMsg = t`No favorites with this tag.`;
        else if (vs.filter === 'favorites') emptyMsg = t`No favorites yet.`;
        else if (vs.filterTag) emptyMsg = t`No items with this tag.`;
        else emptyMsg = t`No results.`;
        gridHtml = `<div class="iig-extras-empty">${emptyMsg}</div>`;
    } else {
        gridHtml = `<div class="iig-extras-grid">${pageItems.map((item) => {
            const isActive = item.id === activeId;
            return `
            <div class="iig-extras-card ${isActive ? 'iig-extras-active' : ''}" data-ava-id="${sanitizeForHtml(item.id)}" data-ava-target="${target}">
                <img src="data:image/png;base64,${item.imageData}" class="iig-extras-img" alt="${sanitizeForHtml(item.name)}">
                <div class="iig-extras-fav" data-ava-fav="${sanitizeForHtml(item.id)}" title="${item.favorite ? t`Remove from favorites` : t`Add to favorites`}"><i class="fa-${item.favorite ? 'solid' : 'regular'} fa-star"></i></div>
                ${isActive ? '<div class="iig-extras-check"><i class="fa-solid fa-check"></i></div>' : ''}
                <div class="iig-extras-overlay">
                    <span class="iig-extras-name" title="${sanitizeForHtml(item.name)}">${sanitizeForHtml(item.name)}</span>
                    <i class="fa-solid fa-trash iig-extras-delete" data-ava-del="${sanitizeForHtml(item.id)}" title="${t`Delete`}"></i>
                </div>
            </div>`;
        }).join('')}</div>`;
    }

    const pagination = buildAvatarPaginationHtml(target, totalPages);
    container.innerHTML = sortBar + gridHtml + pagination;

    renderAvatarAppearancePanel(target);
}

function bindAvatarGridEvents(target) {
    const containerId = target === 'user' ? 'iig_avatar_lib_user' : 'iig_avatar_lib_char';
    const container = document.getElementById(containerId);
    if (!container) return;

    container.addEventListener('click', (e) => {
        const tgt = e.target instanceof Element ? e.target : null;
        if (!tgt) return;
        const vs = avatarVS[target] || avatarVS.char;

        if (tgt.closest('[data-ava-filter-all]')) { vs.filter = 'all'; vs.filterTag = ''; vs.page = 0; renderAvatarGrid(target); return; }
        if (tgt.closest('[data-ava-filter-fav]')) { vs.filter = vs.filter === 'favorites' ? 'all' : 'favorites'; vs.page = 0; renderAvatarGrid(target); return; }
        const tagC = tgt.closest('[data-ava-filter-tag]');
        if (tagC) { const tn = tagC.getAttribute('data-ava-filter-tag') || ''; vs.filterTag = vs.filterTag === tn ? '' : tn; vs.page = 0; renderAvatarGrid(target); return; }
        const pg = tgt.closest('[data-ava-page]');
        if (pg) { vs.page = parseInt(pg.getAttribute('data-ava-page'), 10) || 0; renderAvatarGrid(target); return; }
        if (tgt.closest('[data-ava-page-prev]')) { if (vs.page > 0) { vs.page--; renderAvatarGrid(target); } return; }
        if (tgt.closest('[data-ava-page-next]')) {
            const sorted = getAvatarSortedFiltered(getSettings(), target);
            const tp = Math.max(1, Math.ceil(sorted.length / AVATARS_PER_PAGE));
            if (vs.page < tp - 1) { vs.page++; renderAvatarGrid(target); } return;
        }

        const fav = tgt.closest('[data-ava-fav]');
        if (fav) { e.stopPropagation(); toggleAvatarFavorite(fav.getAttribute('data-ava-fav')); renderAvatarGrid(target); return; }

        const del = tgt.closest('[data-ava-del]');
        if (del) { e.stopPropagation(); removeAvatarItem(del.getAttribute('data-ava-del')); renderAvatarGrid(target); toastr.info(t`Avatar deleted`, t`Image Generation`); return; }

        const card = tgt.closest('[data-ava-id]');
        if (card) { setActiveAvatar(card.getAttribute('data-ava-id'), target); renderAvatarGrid(target); return; }
    });

    container.addEventListener('change', (e) => {
        if (e.target instanceof HTMLSelectElement && e.target.hasAttribute('data-ava-sort')) {
            const vs = avatarVS[target] || avatarVS.char;
            vs.sort = e.target.value; vs.page = 0; renderAvatarGrid(target);
        }
    });
}

// ----- Render: Avatar appearance panels -----

function renderAvatarAppearancePanel(target) {
    const panelId = target === 'user' ? 'iig_avatar_desc_user' : 'iig_avatar_desc_char';
    const panel = document.getElementById(panelId);
    if (!panel) return;

    const settings = getSettings();
    const activeItem = getActiveAvatarItem(target);
    if (!activeItem) {
        panel.innerHTML = '';
        return;
    }

    const allTags = ensureAvatarTags(settings);
    const itemTags = activeItem.tags || [];
    const editorTagsHtml = allTags.length > 0
        ? `<div class="iig-style-editor-tags">${allTags.map((tag) => {
            const on = itemTags.includes(tag);
            return `<div class="iig-style-editor-tag ${on ? 'active' : ''}" data-ava-editor-tag="${sanitizeForHtml(tag)}">${sanitizeForHtml(tag)}</div>`;
        }).join('')}</div>`
        : '';

    panel.innerHTML = `
        <div class="iig-wardrobe-desc-panel">
            <div class="iig-wardrobe-desc-header">
                <i class="fa-solid fa-pen"></i>
                <input type="text" class="text_pole iig-avatar-name-input" value="${sanitizeForHtml(activeItem.name)}"
                    data-ava-id="${sanitizeForHtml(activeItem.id)}" placeholder="${t`Avatar name`}">
            </div>
            ${editorTagsHtml
                ? `<div class="iig-avatar-tags-section"><span class="iig-avatar-tags-label"><i class="fa-solid fa-tags"></i> ${t`Tags`}</span>${editorTagsHtml}</div>`
                : `<div class="iig-avatar-tags-section"><span class="iig-avatar-tags-hint">${t`Use "Manage tags" below to create tags`}</span></div>`}
            <textarea class="text_pole iig-avatar-desc-textarea" rows="3"
                placeholder="${t`Enter appearance description manually or generate via Vision AI...`}"
                data-ava-id="${sanitizeForHtml(activeItem.id)}">${sanitizeForHtml(activeItem.appearance || '')}</textarea>
            <div class="iig-wardrobe-desc-actions">
                <div class="menu_button iig-avatar-desc-generate" data-ava-id="${sanitizeForHtml(activeItem.id)}" title="${t`Generate via Vision AI`}">
                    <i class="fa-solid fa-robot"></i> ${t`Generate`}
                </div>
                <div class="menu_button iig-avatar-desc-save" data-ava-id="${sanitizeForHtml(activeItem.id)}" title="${t`Save description`}">
                    <i class="fa-solid fa-floppy-disk"></i> ${t`Save`}
                </div>
                <div class="menu_button iig-avatar-desc-clear" data-ava-id="${sanitizeForHtml(activeItem.id)}" title="${t`Clear description`}">
                    <i class="fa-solid fa-eraser"></i>
                </div>
            </div>
            <div class="iig-wardrobe-desc-status" style="display:none;"></div>
        </div>
    `;

    const nameInput = panel.querySelector('.iig-avatar-name-input');
    nameInput?.addEventListener('blur', () => {
        const avaId = nameInput.getAttribute('data-ava-id');
        if (avaId) {
            updateAvatarItemName(avaId, nameInput.value);
            renderAvatarGrid(target);
        }
    });
    nameInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

    const textarea = panel.querySelector('.iig-avatar-desc-textarea');

    textarea?.addEventListener('blur', () => {
        const avaId = textarea.getAttribute('data-ava-id');
        if (avaId) updateAvatarItemAppearance(avaId, textarea.value);
    });

    panel.querySelector('.iig-avatar-desc-save')?.addEventListener('click', () => {
        const avaId = textarea?.getAttribute('data-ava-id');
        if (!avaId) return;
        updateAvatarItemAppearance(avaId, textarea.value);
        toastr.success(t`Appearance saved`, t`Image Generation`);
    });

    panel.querySelector('.iig-avatar-desc-clear')?.addEventListener('click', () => {
        if (!textarea) return;
        const avaId = textarea.getAttribute('data-ava-id');
        if (!avaId) return;
        textarea.value = '';
        updateAvatarItemAppearance(avaId, '');
        toastr.info(t`Appearance cleared`, t`Image Generation`);
    });

    panel.querySelector('.iig-avatar-desc-generate')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (!(btn instanceof HTMLElement)) return;
        const avaId = btn.getAttribute('data-ava-id');
        if (!avaId) return;
        const statusEl = panel.querySelector('.iig-wardrobe-desc-status');

        btn.classList.add('disabled');
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + t`Generating...`;
        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.textContent = t`Sending image to vision model...`;
            statusEl.classList.remove('iig-desc-error', 'iig-desc-success');
        }

        try {
            const description = await generateAvatarAppearanceDescription(avaId);
            if (textarea instanceof HTMLTextAreaElement) textarea.value = description;
            if (statusEl) {
                statusEl.textContent = t`Appearance description generated.`;
                statusEl.classList.add('iig-desc-success');
            }
            toastr.success(t`Appearance generated`, t`Image Generation`);
        } catch (error) {
            iigLog('ERROR', 'Avatar appearance generation failed:', error);
            if (statusEl) {
                statusEl.textContent = t`Error: ${error.message || error}`;
                statusEl.classList.add('iig-desc-error');
            }
            toastr.error(t`Vision generation error: ${error.message || error}`, t`Image Generation`);
        } finally {
            btn.classList.remove('disabled');
            btn.innerHTML = originalHtml;
            setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 5000);
        }
    });

    panel.querySelectorAll('[data-ava-editor-tag]').forEach((chip) => {
        chip.addEventListener('click', () => {
            const tagName = chip.getAttribute('data-ava-editor-tag') || '';
            const current = activeItem.tags || [];
            const newTags = current.includes(tagName) ? current.filter((t2) => t2 !== tagName) : [...current, tagName];
            updateAvatarItemTags(activeItem.id, newTags);
            chip.classList.toggle('active');
        });
    });
}

// ----- Render: NPC list -----

export function renderNpcList() {
    const settings = getSettings();
    const container = document.getElementById('iig_npc_list');
    if (!container) return;

    const list = ensureNpcList(settings);
    container.innerHTML = '';

    if (list.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = t`No NPCs yet. Click "Add NPC" to create one.`;
        container.appendChild(empty);
        return;
    }

    for (const npc of list) {
        const isEnabled = npc.enabled !== false;
        const npcEl = document.createElement('div');
        npcEl.className = `iig-npc-item ${isEnabled ? '' : 'iig-npc-disabled'}`;
        npcEl.dataset.npcId = npc.id;

        const avatarPreview = npc.avatarData
            ? `<img src="data:image/png;base64,${npc.avatarData}" class="iig-npc-avatar-preview" alt="">`
            : `<div class="iig-npc-avatar-preview iig-npc-no-avatar"><i class="fa-solid fa-user-plus"></i></div>`;

        npcEl.innerHTML = `
            <div class="iig-npc-header">
                <div class="iig-npc-avatar-container">
                    ${avatarPreview}
                    <input type="file" class="iig-npc-avatar-input" accept="image/*" style="display:none">
                    <div class="iig-npc-avatar-upload-btn menu_button" title="${t`Upload avatar`}">
                        <i class="fa-solid fa-upload"></i>
                    </div>
                </div>
                <div class="iig-npc-fields">
                    <input type="text" class="text_pole iig-npc-name" placeholder="${t`NPC name`}" value="${sanitizeForHtml(npc.name || '')}">
                    <input type="text" class="text_pole iig-npc-aliases" placeholder="${t`Aliases (comma-separated)`}" value="${sanitizeForHtml((npc.aliases || []).join(', '))}">
                </div>
                <div class="iig-npc-btn-group">
                    <div class="iig-npc-toggle menu_button ${isEnabled ? 'iig-npc-on' : 'iig-npc-off'}" title="${isEnabled ? t`Disable NPC` : t`Enable NPC`}">
                        <i class="fa-solid ${isEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                    </div>
                    <div class="iig-npc-remove menu_button" title="${t`Remove NPC`}">
                        <i class="fa-solid fa-trash"></i>
                    </div>
                </div>
            </div>
            <textarea class="text_pole iig-npc-appearance" rows="2" placeholder="${t`Appearance description (optional)`}">${sanitizeForHtml(npc.appearance || '')}</textarea>
            <div class="iig-npc-appearance-row">
                <div class="menu_button iig-npc-appearance-vision ${npc.avatarData ? '' : 'iig-hidden'}" title="${t`Generate appearance description via Vision AI`}">
                    <i class="fa-solid fa-robot"></i> ${t`Generate with Vision`}
                </div>
            </div>
        `;

        npcEl.querySelector('.iig-npc-name')?.addEventListener('input', (e) => {
            updateNpc(npc.id, { name: e.target.value });
        });
        npcEl.querySelector('.iig-npc-aliases')?.addEventListener('input', (e) => {
            updateNpc(npc.id, { aliases: e.target.value.split(',').map((a) => a.trim()).filter(Boolean) });
        });
        npcEl.querySelector('.iig-npc-appearance')?.addEventListener('input', (e) => {
            updateNpc(npc.id, { appearance: e.target.value });
        });

        npcEl.querySelector('.iig-npc-toggle')?.addEventListener('click', () => {
            toggleNpc(npc.id);
            renderNpcList();
        });

        const uploadBtn = npcEl.querySelector('.iig-npc-avatar-upload-btn');
        const fileInput = npcEl.querySelector('.iig-npc-avatar-input');
        uploadBtn?.addEventListener('click', () => fileInput?.click());
        npcEl.querySelector('.iig-npc-avatar-container')?.addEventListener('click', (e) => {
            if (e.target instanceof Element && !e.target.closest('.iig-npc-avatar-upload-btn')) {
                fileInput?.click();
            }
        });
        fileInput?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const resized = await fileToResizedBase64(file, 512);
                updateNpc(npc.id, { avatarData: resized });
                renderNpcList();
                toastr.success(t`Avatar uploaded for ${npc.name || 'NPC'}`, t`Image Generation`);
            } catch (error) {
                toastr.error(t`Failed to upload avatar: ${error.message || error}`, t`Image Generation`);
            }
        });

        npcEl.querySelector('.iig-npc-remove')?.addEventListener('click', async () => {
            const confirmed = await Popup.show.confirm(
                t`Remove NPC`,
                t`Remove this NPC? This cannot be undone.`,
            );
            if (!confirmed) return;
            removeNpc(npc.id);
            renderNpcList();
        });

        const npcVisionBtn = npcEl.querySelector('.iig-npc-appearance-vision');
        npcVisionBtn?.addEventListener('click', async () => {
            if (!(npcVisionBtn instanceof HTMLElement)) return;
            const originalHtml = npcVisionBtn.innerHTML;
            npcVisionBtn.classList.add('disabled');
            npcVisionBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            try {
                const description = await generateNpcAppearanceDescription(npc.id);
                const appearanceTextarea = npcEl.querySelector('.iig-npc-appearance');
                if (appearanceTextarea instanceof HTMLTextAreaElement) {
                    appearanceTextarea.value = description;
                }
                toastr.success(t`Appearance generated`, t`Image Generation`);
            } catch (error) {
                iigLog('ERROR', 'NPC appearance generation failed:', error);
                toastr.error(t`Vision generation error: ${error.message || error}`, t`Image Generation`);
            } finally {
                npcVisionBtn.classList.remove('disabled');
                npcVisionBtn.innerHTML = originalHtml;
            }
        });

        container.appendChild(npcEl);
    }
}

// ----- Bind: extras section events -----

export function bindExtrasEvents(settings) {
    // ---- Avatar Library ----
    const bindAvatarLibAdd = (target) => {
        const addBtn = document.getElementById(`iig_avatar_lib_${target}_add`);
        const fileInput = document.getElementById(`iig_avatar_lib_${target}_file`);
        const nameInput = document.getElementById(`iig_avatar_lib_${target}_name`);

        addBtn?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', async (e) => {
            const file = e.target?.files?.[0];
            if (!file) return;
            try {
                const resized = await fileToResizedBase64(file, 512);
                const name = (nameInput instanceof HTMLInputElement ? nameInput.value.trim() : '')
                    || file.name.replace(/\.[^.]+$/, '')
                    || 'Avatar';
                addAvatarItem(name, resized, target);
                if (nameInput instanceof HTMLInputElement) nameInput.value = '';
                if (fileInput instanceof HTMLInputElement) fileInput.value = '';
                const vs = avatarVS[target] || avatarVS.char;
                vs.page = 0; vs.sort = 'newest'; vs.filter = 'all'; vs.filterTag = '';
                renderAvatarGrid(target);
                toastr.success(t`Avatar "${name}" added`, t`Image Generation`);
            } catch (error) {
                toastr.error(t`Failed to add avatar: ${error.message || error}`, t`Image Generation`);
            }
        });
    };
    bindAvatarLibAdd('char');
    bindAvatarLibAdd('user');
    bindAvatarGridEvents('char');
    bindAvatarGridEvents('user');

    // ---- Avatar tag manager ----
    function buildAvatarTagManagerHtml() {
        const tags = ensureAvatarTags(settings);
        const tagsHtml = tags.map((tag) =>
            `<div class="iig-styles-tag-manage-item"><span>${sanitizeForHtml(tag)}</span><div class="iig-styles-tag-manage-remove" data-ava-rm-tag="${sanitizeForHtml(tag)}"><i class="fa-solid fa-xmark"></i></div></div>`).join('');
        return `<div class="iig-styles-tag-manager">
            <div class="iig-styles-tag-manager-list">${tagsHtml}</div>
            <div class="iig-styles-tag-manager-add">
                <input type="text" class="text_pole flex1" id="iig_avatar_new_tag" placeholder="${t`New tag…`}">
                <div class="menu_button" id="iig_avatar_add_tag"><i class="fa-solid fa-plus"></i></div>
            </div>
        </div>`;
    }

    function refreshAvatarTagManager() {
        const mgr = document.getElementById('iig_avatar_tag_manager');
        if (mgr && !mgr.classList.contains('iig-hidden')) mgr.innerHTML = buildAvatarTagManagerHtml();
    }

    document.getElementById('iig_avatar_tags_toggle')?.addEventListener('click', () => {
        const mgr = document.getElementById('iig_avatar_tag_manager');
        if (!mgr) return;
        const wasHidden = mgr.classList.contains('iig-hidden');
        mgr.classList.toggle('iig-hidden', !wasHidden);
        if (wasHidden) mgr.innerHTML = buildAvatarTagManagerHtml();
    });

    document.getElementById('iig_avatar_tag_manager')?.addEventListener('click', (e) => {
        const tgt = e.target instanceof Element ? e.target : null;
        if (!tgt) return;
        const rmBtn = tgt.closest('[data-ava-rm-tag]');
        if (rmBtn) {
            const tagName = rmBtn.getAttribute('data-ava-rm-tag') || '';
            removeAvatarTag(tagName, settings);
            for (const t2 of ['char', 'user']) { if (avatarVS[t2].filterTag === tagName) avatarVS[t2].filterTag = ''; }
            saveSettings(); renderAvatarGrid('char'); renderAvatarGrid('user'); refreshAvatarTagManager();
            return;
        }
        if (tgt.closest('#iig_avatar_add_tag')) {
            const input = document.getElementById('iig_avatar_new_tag');
            if (input instanceof HTMLInputElement && input.value.trim()) {
                addAvatarTag(input.value.trim(), settings);
                input.value = '';
                saveSettings(); renderAvatarGrid('char'); renderAvatarGrid('user'); refreshAvatarTagManager();
            }
        }
    });

    document.getElementById('iig_avatar_tag_manager')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.id === 'iig_avatar_new_tag') {
            e.preventDefault();
            document.getElementById('iig_avatar_add_tag')?.click();
        }
    });

    // ---- Wardrobe ----
    document.getElementById('iig_inject_avatar_appearance_gen')?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.injectAvatarAppearanceToGeneration = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_inject_avatar_appearance_chat')?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.injectAvatarAppearanceToChatEnabled = e.target.checked;
        saveSettings();
        updateAvatarAppearanceInjection();
    });

    document.getElementById('iig_avatar_appearance_depth')?.addEventListener('input', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        const v = Number.parseInt(e.target.value, 10);
        settings.avatarAppearanceInjectionDepth = Number.isFinite(v) && v >= 0 ? v : 1;
        saveSettings();
        updateAvatarAppearanceInjection();
    });

    document.getElementById('iig_inject_wardrobe')?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.injectWardrobeToChat = e.target.checked;
        saveSettings();
        updateWardrobeInjection();
    });

    document.getElementById('iig_wardrobe_injection_depth')?.addEventListener('input', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        const v = Number.parseInt(e.target.value, 10);
        settings.wardrobeInjectionDepth = Number.isFinite(v) && v >= 0 ? v : 1;
        saveSettings();
        updateWardrobeInjection();
    });

    document.getElementById('iig_wardrobe_button_placement')?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLSelectElement)) return;
        const allowed = new Set(['bar', 'wand', 'both', 'hidden']);
        settings.wardrobeButtonPlacement = allowed.has(e.target.value) ? e.target.value : 'bar';
        saveSettings();
        swInjectBarBtn();
    });

    document.getElementById('iig_optional_wardrobe_sending')?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.optionalWardrobeSending = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_open_wardrobe_modal')?.addEventListener('click', () => {
        swOpenModal();
    });

    // ---- Vision ----
    document.getElementById('iig_vision_endpoint')?.addEventListener('input', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.visionEndpoint = e.target.value;
        saveSettings();
    });
    document.getElementById('iig_vision_api_key')?.addEventListener('input', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.visionApiKey = e.target.value;
        saveSettings();
    });
    document.getElementById('iig_vision_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_vision_api_key');
        const icon = document.querySelector('#iig_vision_key_toggle i');
        if (!(input instanceof HTMLInputElement)) return;
        if (input.type === 'password') {
            input.type = 'text';
            icon?.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
            input.type = 'password';
            icon?.classList.replace('fa-eye-slash', 'fa-eye');
        }
    });
    document.getElementById('iig_vision_model_select')?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLSelectElement)) return;
        settings.visionModel = e.target.value;
        saveSettings();
    });
    document.getElementById('iig_refresh_vision_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn instanceof HTMLElement) btn.classList.add('loading');
        try {
            const models = await fetchVisionModels();
            const select = document.getElementById('iig_vision_model_select');
            if (select instanceof HTMLSelectElement) {
                const current = settings.visionModel || '';
                const inList = current && models.includes(current);
                const optionsHtml = [
                    `<option value="">${t`-- Select a model --`}</option>`,
                    ...models.map((m) => `<option value="${sanitizeForHtml(m)}" ${m === current ? 'selected' : ''}>${sanitizeForHtml(m)}</option>`),
                    ...(!inList && current ? [`<option value="${sanitizeForHtml(current)}" selected>${sanitizeForHtml(current)} ${t`(custom)`}</option>`] : []),
                ];
                select.innerHTML = optionsHtml.join('');
            }
            toastr.success(t`Vision models found: ${models.length}`, t`Image Generation`);
        } catch (_e) {
            // toastr уже выведен из fetchVisionModels
        } finally {
            if (btn instanceof HTMLElement) btn.classList.remove('loading');
        }
    });
    document.getElementById('iig_vision_prompt')?.addEventListener('input', (e) => {
        if (!(e.target instanceof HTMLTextAreaElement)) return;
        settings.visionPrompt = e.target.value;
        saveSettings();
    });

    // ---- NPC ----
    document.getElementById('iig_auto_detect_names')?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.autoDetectNames = e.target.checked;
        saveSettings();
    });
    document.getElementById('iig_add_npc')?.addEventListener('click', () => {
        addNpc();
        renderNpcList();
    });
}

// ----- Vision collapse toggle (inside API section) -----

export function bindVisionCollapse() {
    const head = document.querySelector('[data-iig-vision-toggle]');
    const body = document.getElementById('iig_vision_body');
    const chev = document.getElementById('iig_vision_chev');
    if (!head || !body) return;
    head.addEventListener('click', () => {
        const willHide = !body.classList.contains('iig-hidden');
        body.classList.toggle('iig-hidden', willHide);
        chev?.classList.toggle('iig-section-chevron-collapsed', willHide);
    });
}
