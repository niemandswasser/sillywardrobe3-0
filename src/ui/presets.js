/**
 * Generic-фабрика секций пресетов (styles / prefixes / suffixes / NovelAI
 * presets): список с сортировкой, избранным, тегами, пагинацией и
 * инлайн-редактором. Инстансы секций создаются здесь же.
 */

import {
    getSettings,
    saveSettings,
    ensureStyles,
    createStyle,
    getActiveStyle,
    updateStyle,
    removeStyle,
    toggleStyleFavorite,
    ensureStyleTags,
    addStyleTag,
    removeStyleTag,
    ensurePrefixes,
    createPrefix,
    getActivePrefix,
    updatePrefix,
    removePrefix,
    togglePrefixFavorite,
    ensureSuffixes,
    createSuffix,
    getActiveSuffix,
    updateSuffix,
    removeSuffix,
    toggleSuffixFavorite,
    ensureNovelaiPresets,
    createNovelaiPreset,
    getActiveNovelaiPreset,
    updateNovelaiPreset,
    removeNovelaiPreset,
    toggleNovelaiPresetFavorite,
} from '../settings.js';
import { sanitizeForHtml } from '../utils.js';
import { t } from '../i18n.js';
import { buildSettingsSectionHtml } from './common.js';
import { openStylePickerModal } from './stylePicker.js';

const PRESETS_PER_PAGE = 8;

function truncatePresetValue(value, maxLen = 60) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + '…' : trimmed;
}

function createPresetSectionUI(cfg) {
    const {
        p,
        sectionTitle,
        valuePlaceholder,
        showBrowse,
        multiActive,
        ensureFn, createFn, getActiveFn, updateFn, removeFn, toggleFavoriteFn,
        activeIdKey,
    } = cfg;

    const vs = { page: 0, sort: 'newest', filter: 'all', filterTag: '' };

    function id(suffix) { return `iig_${p}_${suffix}`; }

    function getSortedFiltered(settings) {
        let items = ensureFn(settings).slice();
        if (vs.filter === 'favorites') items = items.filter((s) => s.favorite);
        if (vs.filterTag) items = items.filter((s) => s.tags.includes(vs.filterTag));
        const favFirst = (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
        switch (vs.sort) {
            case 'name-asc':  items.sort((a, b) => favFirst(a, b) || a.name.localeCompare(b.name)); break;
            case 'name-desc': items.sort((a, b) => favFirst(a, b) || b.name.localeCompare(a.name)); break;
            case 'oldest':    items.sort((a, b) => favFirst(a, b) || (a.createdAt || 0) - (b.createdAt || 0)); break;
            default:          items.sort((a, b) => favFirst(a, b) || (b.createdAt || 0) - (a.createdAt || 0)); break;
        }
        return items;
    }

    function buildSortBarHtml(totalCount, settings) {
        const sortOpts = [
            { value: 'newest', label: t`Newest` }, { value: 'oldest', label: t`Oldest` },
            { value: 'name-asc', label: 'A→Z' }, { value: 'name-desc', label: 'Z→A' },
        ];
        const sortHtml = sortOpts.map((o) =>
            `<option value="${o.value}" ${vs.sort === o.value ? 'selected' : ''}>${o.label}</option>`,
        ).join('');
        const allItems = ensureFn(settings);
        const favCount = allItems.filter((s) => s.favorite).length;
        const tags = ensureStyleTags(settings);
        const tagChipsHtml = tags.map((tag) => {
            const count = allItems.filter((s) => s.tags.includes(tag)).length;
            return `<div class="iig-styles-filter-chip iig-styles-tag-chip ${vs.filterTag === tag ? 'active' : ''}" data-ps-filter-tag="${sanitizeForHtml(tag)}">${sanitizeForHtml(tag)} <span class="iig-styles-filter-count">${count}</span></div>`;
        }).join('');
        return `<div class="iig-styles-sort-bar">
            <select class="text_pole iig-styles-sort-select" data-ps-sort title="${t`Sort`}">${sortHtml}</select>
            <div class="iig-styles-filter-chip ${vs.filter === 'all' && !vs.filterTag ? 'active' : ''}" data-ps-filter-all>${t`All`} <span class="iig-styles-filter-count">${totalCount}</span></div>
            <div class="iig-styles-filter-chip ${vs.filter === 'favorites' ? 'active' : ''}" data-ps-filter-fav><i class="fa-solid fa-star"></i> <span class="iig-styles-filter-count">${favCount}</span></div>
            ${tagChipsHtml}
        </div>`;
    }

    function buildPaginationHtml(totalPages) {
        if (totalPages <= 1) return '';
        const pages = [];
        for (let i = 0; i < totalPages; i++) {
            pages.push(`<div class="iig-styles-page-btn ${i === vs.page ? 'active' : ''}" data-ps-page="${i}">${i + 1}</div>`);
        }
        return `<div class="iig-styles-pagination">
            <div class="iig-styles-page-btn ${vs.page <= 0 ? 'disabled' : ''}" data-ps-page-prev><i class="fa-solid fa-chevron-left"></i></div>
            ${pages.join('')}
            <div class="iig-styles-page-btn ${vs.page >= totalPages - 1 ? 'disabled' : ''}" data-ps-page-next><i class="fa-solid fa-chevron-right"></i></div>
        </div>`;
    }

    function buildItemTagsHtml(item) {
        if (!item.tags || item.tags.length === 0) return '';
        return `<div class="iig-style-item-tags">${item.tags.map((tag) =>
            `<span class="iig-style-item-tag">${sanitizeForHtml(tag)}</span>`).join('')}</div>`;
    }

    function buildListHtml(settings) {
        const allSorted = getSortedFiltered(settings);
        const totalCount = ensureFn(settings).length;
        const totalPages = Math.max(1, Math.ceil(allSorted.length / PRESETS_PER_PAGE));
        if (vs.page >= totalPages) vs.page = Math.max(0, totalPages - 1);
        const pageItems = allSorted.slice(vs.page * PRESETS_PER_PAGE, (vs.page + 1) * PRESETS_PER_PAGE);
        const activeId = settings[activeIdKey];
        const sortBar = buildSortBarHtml(totalCount, settings);
        let emptyMsg;
        if (vs.filter === 'favorites' && vs.filterTag) emptyMsg = t`No favorites with this tag.`;
        else if (vs.filter === 'favorites') emptyMsg = t`No favorites yet.`;
        else if (vs.filterTag) emptyMsg = t`No items with this tag.`;
        else emptyMsg = t`No presets yet. Add one above.`;
        let listHtml;
        if (allSorted.length === 0) {
            listHtml = `<p class="hint">${emptyMsg}</p>`;
        } else {
            listHtml = pageItems.map((item) => {
                const isEditing = item.id === activeId;
                const isFav = item.favorite;
                const preview = truncatePresetValue(item.value);
                const isEnabled = multiActive ? item.enabled !== false : isEditing;
                const indicatorIcon = multiActive
                    ? `fa-${isEnabled ? 'solid fa-square-check' : 'regular fa-square'}`
                    : `fa-solid ${isEditing ? 'fa-circle-check' : 'fa-circle'}`;
                const indicatorAttr = multiActive ? `data-ps-toggle-enabled="${item.id}"` : '';
                return `<div class="iig-style-item ${isEditing ? 'iig-style-item-active' : ''}" data-ps-id="${item.id}">
                    <div class="iig-style-item-fav" data-ps-fav="${item.id}" title="${isFav ? t`Remove from favorites` : t`Add to favorites`}"><i class="fa-${isFav ? 'solid' : 'regular'} fa-star"></i></div>
                    <div class="iig-style-item-main" data-ps-activate="${item.id}">
                        <div class="iig-style-item-indicator" ${indicatorAttr}><i class="${indicatorIcon}"></i></div>
                        <div class="iig-style-item-info">
                            <span class="iig-style-item-name">${sanitizeForHtml(item.name)}</span>
                            ${preview ? `<span class="iig-style-item-preview">${sanitizeForHtml(preview)}</span>` : ''}
                            ${buildItemTagsHtml(item)}
                        </div>
                    </div>
                    <div class="iig-style-item-actions">
                        ${!multiActive && isEditing ? `<div class="menu_button iig-style-item-action" data-ps-deactivate><i class="fa-solid fa-power-off"></i></div>` : ''}
                        <div class="menu_button iig-style-item-action iig-style-item-delete" data-ps-remove="${item.id}"><i class="fa-solid fa-trash"></i></div>
                    </div>
                </div>`;
            }).join('');
        }
        return sortBar + listHtml + buildPaginationHtml(totalPages);
    }

    function buildEditorHtml(settings) {
        const active = getActiveFn(settings);
        if (!active) return '';
        const allTags = ensureStyleTags(settings);
        const editorTagsHtml = allTags.map((tag) => {
            const on = (active.tags || []).includes(tag);
            return `<div class="iig-style-editor-tag ${on ? 'active' : ''}" data-ps-editor-tag="${sanitizeForHtml(tag)}">${sanitizeForHtml(tag)}</div>`;
        }).join('');
        return `<div class="iig-style-editor">
            <div class="iig-style-editor-row">
                <input type="text" data-ps-name class="text_pole flex1" value="${sanitizeForHtml(active.name)}" placeholder="${t`Name`}">
            </div>
            <textarea data-ps-value class="text_pole iig-style-editor-textarea" rows="3" placeholder="${valuePlaceholder}">${sanitizeForHtml(active.value)}</textarea>
            ${editorTagsHtml ? `<div class="iig-style-editor-tags">${editorTagsHtml}</div>` : ''}
        </div>`;
    }

    function buildTagManagerHtml(settings) {
        const tags = ensureStyleTags(settings);
        const tagsHtml = tags.map((tag) =>
            `<div class="iig-styles-tag-manage-item"><span>${sanitizeForHtml(tag)}</span><div class="iig-styles-tag-manage-remove" data-ps-remove-tag="${sanitizeForHtml(tag)}"><i class="fa-solid fa-xmark"></i></div></div>`).join('');
        return `<div class="iig-styles-tag-manager">
            <div class="iig-styles-tag-manager-list">${tagsHtml}</div>
            <div class="iig-styles-tag-manager-add">
                <input type="text" data-ps-new-tag class="text_pole flex1" placeholder="${t`New tag…`}">
                <div class="menu_button" data-ps-add-tag><i class="fa-solid fa-plus"></i></div>
            </div>
        </div>`;
    }

    function render() {
        const settings = getSettings();
        const list = document.getElementById(id('presets'));
        const editor = document.getElementById(id('editor'));
        const tagMgr = document.getElementById(id('tag_manager'));
        if (list) list.innerHTML = buildListHtml(settings);
        if (editor) editor.innerHTML = buildEditorHtml(settings);
        if (tagMgr && !tagMgr.classList.contains('iig-hidden')) {
            tagMgr.innerHTML = buildTagManagerHtml(settings);
        }
    }

    function buildSectionHtml() {
        const browseBtn = showBrowse
            ? `<div id="${id('pick_site')}" class="menu_button iig-styles-toolbar-btn" title="${t`Browse styles from site`}"><i class="fa-solid fa-globe"></i> ${t`Browse`}</div>`
            : '';
        const bodyHtml = `<div class="iig-settings-card iig-styles-card">
            <div class="iig-styles-toolbar">
                ${browseBtn}
                <input type="text" id="${id('new_name')}" class="text_pole flex1" placeholder="${t`New preset name…`}">
                <div id="${id('add_btn')}" class="menu_button iig-styles-toolbar-btn"><i class="fa-solid fa-plus"></i></div>
                <div id="${id('tags_toggle')}" class="menu_button iig-styles-toolbar-btn" title="${t`Manage tags`}"><i class="fa-solid fa-tags"></i></div>
            </div>
            <div id="${id('tag_manager')}" class="iig-hidden"></div>
            <div id="${id('presets')}" class="iig-style-list"></div>
            <div id="${id('editor')}"></div>
        </div>`;
        return buildSettingsSectionHtml(id('section'), sectionTitle, bodyHtml, false);
    }

    function bindEvents(settings) {
        if (showBrowse) {
            document.getElementById(id('pick_site'))?.addEventListener('click', () => openStylePickerModal());
        }

        document.getElementById(id('add_btn'))?.addEventListener('click', () => {
            const input = document.getElementById(id('new_name'));
            createFn(input?.value || '');
            if (input) input.value = '';
            vs.page = 0; vs.sort = 'newest'; vs.filter = 'all'; vs.filterTag = '';
            saveSettings(); render();
        });

        document.getElementById(id('new_name'))?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); document.getElementById(id('add_btn'))?.click(); }
        });

        document.getElementById(id('tags_toggle'))?.addEventListener('click', () => {
            const mgr = document.getElementById(id('tag_manager'));
            if (!mgr) return;
            const wasHidden = mgr.classList.contains('iig-hidden');
            mgr.classList.toggle('iig-hidden', !wasHidden);
            if (wasHidden) mgr.innerHTML = buildTagManagerHtml(settings);
        });

        document.getElementById(id('tag_manager'))?.addEventListener('click', (e) => {
            const tgt = e.target instanceof Element ? e.target : null;
            if (!tgt) return;
            const rmBtn = tgt.closest('[data-ps-remove-tag]');
            if (rmBtn) {
                const tagName = rmBtn.getAttribute('data-ps-remove-tag') || '';
                removeStyleTag(tagName, settings);
                if (vs.filterTag === tagName) vs.filterTag = '';
                saveSettings(); render();
                const mgr = document.getElementById(id('tag_manager'));
                if (mgr) mgr.innerHTML = buildTagManagerHtml(settings);
                return;
            }
            if (tgt.closest('[data-ps-add-tag]')) {
                const input = document.getElementById(id('tag_manager'))?.querySelector('[data-ps-new-tag]');
                if (input instanceof HTMLInputElement && input.value.trim()) {
                    addStyleTag(input.value.trim(), settings);
                    input.value = '';
                    saveSettings(); render();
                    const mgr = document.getElementById(id('tag_manager'));
                    if (mgr) mgr.innerHTML = buildTagManagerHtml(settings);
                }
                return;
            }
        });

        document.getElementById(id('tag_manager'))?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.hasAttribute('data-ps-new-tag')) {
                e.preventDefault();
                document.getElementById(id('tag_manager'))?.querySelector('[data-ps-add-tag]')?.click();
            }
        });

        const listEl = document.getElementById(id('presets'));

        listEl?.addEventListener('click', (e) => {
            const tgt = e.target instanceof Element ? e.target : null;
            if (!tgt) return;

            const fav = tgt.closest('[data-ps-fav]');
            if (fav) { toggleFavoriteFn(fav.getAttribute('data-ps-fav')); saveSettings(); render(); return; }

            const tog = tgt.closest('[data-ps-toggle-enabled]');
            if (tog) {
                const tid = tog.getAttribute('data-ps-toggle-enabled') || '';
                const item = ensureFn(settings).find(x => x.id === tid);
                if (item) { updateFn(tid, { enabled: !item.enabled }); saveSettings(); render(); }
                return;
            }

            const act = tgt.closest('[data-ps-activate]');
            if (act) {
                const aid = act.getAttribute('data-ps-activate') || '';
                settings[activeIdKey] = aid === settings[activeIdKey] ? '' : aid;
                saveSettings(); render(); return;
            }

            if (tgt.closest('[data-ps-deactivate]')) { settings[activeIdKey] = ''; saveSettings(); render(); return; }

            const rm = tgt.closest('[data-ps-remove]');
            if (rm) { removeFn(rm.getAttribute('data-ps-remove')); saveSettings(); render(); return; }

            const pg = tgt.closest('[data-ps-page]');
            if (pg) { vs.page = parseInt(pg.getAttribute('data-ps-page'), 10) || 0; render(); return; }
            if (tgt.closest('[data-ps-page-prev]')) { if (vs.page > 0) { vs.page--; render(); } return; }
            if (tgt.closest('[data-ps-page-next]')) {
                const tp = Math.max(1, Math.ceil(getSortedFiltered(settings).length / PRESETS_PER_PAGE));
                if (vs.page < tp - 1) { vs.page++; render(); } return;
            }
            if (tgt.closest('[data-ps-filter-all]')) { vs.filter = 'all'; vs.filterTag = ''; vs.page = 0; render(); return; }
            if (tgt.closest('[data-ps-filter-fav]')) { vs.filter = vs.filter === 'favorites' ? 'all' : 'favorites'; vs.page = 0; render(); return; }
            const tagC = tgt.closest('[data-ps-filter-tag]');
            if (tagC) { const tn = tagC.getAttribute('data-ps-filter-tag') || ''; vs.filterTag = vs.filterTag === tn ? '' : tn; vs.page = 0; render(); return; }
        });

        listEl?.addEventListener('change', (e) => {
            if (e.target instanceof HTMLSelectElement && e.target.hasAttribute('data-ps-sort')) {
                vs.sort = e.target.value; vs.page = 0; render();
            }
        });

        document.getElementById(id('editor'))?.addEventListener('input', (e) => {
            const active = getActiveFn(settings);
            if (!active) return;
            const tgt = e.target;
            if (!(tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement)) return;
            if (tgt.hasAttribute('data-ps-name')) {
                updateFn(active.id, { name: tgt.value }); saveSettings();
                const nameEl = document.querySelector(`[data-ps-id="${active.id}"] .iig-style-item-name`);
                if (nameEl) nameEl.textContent = getActiveFn(settings)?.name || tgt.value.trim() || active.name;
                return;
            }
            if (tgt.hasAttribute('data-ps-value')) {
                updateFn(active.id, { value: tgt.value }); saveSettings();
                const prev = document.querySelector(`[data-ps-id="${active.id}"] .iig-style-item-preview`);
                if (prev) prev.textContent = truncatePresetValue(tgt.value);
                return;
            }
        });

        document.getElementById(id('editor'))?.addEventListener('click', (e) => {
            const tgt = e.target instanceof Element ? e.target : null;
            if (!tgt) return;
            const edTag = tgt.closest('[data-ps-editor-tag]');
            if (edTag) {
                const active = getActiveFn(settings);
                if (!active) return;
                const tagName = edTag.getAttribute('data-ps-editor-tag') || '';
                const tags = (active.tags || []).slice();
                const idx = tags.indexOf(tagName);
                if (idx === -1) tags.push(tagName); else tags.splice(idx, 1);
                updateFn(active.id, { tags }); saveSettings(); render();
            }
        });
    }

    return { render, buildSectionHtml, bindEvents, viewState: vs };
}

// ----- Preset section instances -----

export const styleSection = createPresetSectionUI({
    p: 'style', sectionTitle: t`Styles`,
    valuePlaceholder: 'masterpiece, cinematic lighting, painterly',
    showBrowse: true,
    ensureFn: ensureStyles, createFn: createStyle, getActiveFn: getActiveStyle,
    updateFn: updateStyle, removeFn: removeStyle, toggleFavoriteFn: toggleStyleFavorite,
    activeIdKey: 'activeStyleId',
});

export const prefixSection = createPresetSectionUI({
    p: 'prefix', sectionTitle: t`Prefixes`,
    valuePlaceholder: 'photorealistic 8K RAW photo, ',
    showBrowse: false,
    ensureFn: ensurePrefixes, createFn: createPrefix, getActiveFn: getActivePrefix,
    updateFn: updatePrefix, removeFn: removePrefix, toggleFavoriteFn: togglePrefixFavorite,
    activeIdKey: 'activePrefixId',
});

export const suffixSection = createPresetSectionUI({
    p: 'suffix', sectionTitle: t`Suffixes`,
    valuePlaceholder: ', sharp focus, ultra detailed, no artifacts',
    showBrowse: false,
    ensureFn: ensureSuffixes, createFn: createSuffix, getActiveFn: getActiveSuffix,
    updateFn: updateSuffix, removeFn: removeSuffix, toggleFavoriteFn: toggleSuffixFavorite,
    activeIdKey: 'activeSuffixId',
});

export const novelaiPresetSection = createPresetSectionUI({
    p: 'nai_preset', sectionTitle: t`NovelAI Presets`,
    valuePlaceholder: '1girl, long white hair, purple eyes, school uniform',
    showBrowse: false, multiActive: true,
    ensureFn: ensureNovelaiPresets, createFn: createNovelaiPreset, getActiveFn: getActiveNovelaiPreset,
    updateFn: updateNovelaiPreset, removeFn: removeNovelaiPreset, toggleFavoriteFn: toggleNovelaiPresetFavorite,
    activeIdKey: 'activeNovelaiPresetId',
});

export function renderStyleSettings() {
    styleSection.render();
    prefixSection.render();
    suffixSection.render();
    novelaiPresetSection.render();
}
