import {
    collectWardrobeCleanupOwners, wardrobeCleanupEntries,
    deleteWardrobeSelection, undoWardrobeDeletion,
} from './wardrobeBulk.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function renderWardrobeBulkCleanup(body, adapters) {
    const { getSettings, getMetadata, getTypes, imageSrc, onChange } = adapters;
    const state = { kind: '', ownerKey: '', category: '', search: '', page: 0, pageSize: 6, protectActive: true };
    const selected = new Set();
    let entries = [], pageEntries = [], journal = null;
    body.innerHTML = `
        <section class="sw-bulk-cleanup">
            <div class="sw-bulk-filters">
                <label>Чьи наряды<select class="text_pole" data-bulk-kind>
                    <option value="">Все гардеробы</option><option value="bot">Боты</option>
                    <option value="user">Персоны</option><option value="shared">Общие</option>
                    <option value="legacy">Старые записи юзера</option>
                </select></label>
                <label>Гардероб<select class="text_pole" data-bulk-owner></select></label>
                <label>Категория<select class="text_pole" data-bulk-category>
                    <option value="">Все категории</option>
                    ${getTypes().map(type => `<option value="${esc(type.id)}">${esc(type.label)}</option>`).join('')}
                </select></label>
                <label>Поиск<input class="text_pole" type="search" data-bulk-search placeholder="Наряд, бот или персона"></label>
            </div>
            <label class="sw-bulk-protect"><input type="checkbox" data-bulk-protect checked>Не удалять надетые наряды</label>
            <p class="sw-bulk-hint">Удаляются выбранные записи, не файлы картинок. Копии в других гардеробах остаются. Смена фильтров сбрасывает выбор.</p>
            <div class="sw-bulk-tools">
                <button type="button" data-bulk-page-all>Выбрать страницу</button>
                <button type="button" data-bulk-all>Выбрать всё найденное</button>
                <button type="button" data-bulk-none>Снять выбор</button>
            </div>
            <div class="sw-bulk-summary" aria-live="polite" data-bulk-summary></div>
            <div class="sw-bulk-scroll"><div class="sw-bulk-grid" data-bulk-grid></div></div>
            <nav class="sw-bulk-pagination" aria-label="Страницы нарядов" data-bulk-pagination></nav>
            <div class="sw-bulk-footer">
                <span class="sw-bulk-status" role="status" data-bulk-status>Отмена последней чистки доступна до закрытия этой вкладки.</span>
                <div><button type="button" data-bulk-undo disabled><i class="fa-solid fa-rotate-left"></i> Отменить чистку</button>
                <button type="button" class="sw-bulk-delete" data-bulk-delete disabled><i class="fa-solid fa-trash-can"></i> Удалить (0)</button></div>
            </div>
        </section>`;
    const node = selector => body.querySelector(selector);
    const canSelect = entry => !state.protectActive || !entry.active;
    const status = message => { node('[data-bulk-status]').textContent = message; };
    const kindMatches = owner => !state.kind
        || (state.kind === 'bot' && owner.side === 'bot')
        || (state.kind === 'user' && owner.side === 'user' && ['persona', 'shared'].includes(owner.kind))
        || (state.kind === 'shared' && owner.kind === 'shared')
        || (state.kind === 'legacy' && owner.kind === 'legacy');

    function refreshOwners() {
        const owners = collectWardrobeCleanupOwners(getSettings(), getMetadata())
            .filter(owner => (owner.outfits.length || owner.key === state.ownerKey) && kindMatches(owner));
        if (!owners.some(owner => owner.key === state.ownerKey)) state.ownerKey = '';
        node('[data-bulk-owner]').innerHTML = '<option value="">Все в выбранной группе</option>'
            + owners.map(owner => `<option value="${esc(owner.key)}">${esc(owner.name)} (${owner.outfits.length})</option>`).join('');
        node('[data-bulk-owner]').value = state.ownerKey;
    }

    function paintSelection() {
        for (const card of body.querySelectorAll('[data-bulk-entry]')) {
            const checked = selected.has(card.dataset.bulkEntry);
            card.classList.toggle('sw-bulk-selected', checked);
            card.setAttribute('aria-pressed', String(checked));
        }
        const activeCount = entries.filter(entry => entry.active).length;
        node('[data-bulk-summary]').textContent = `Найдено: ${entries.length} · Выбрано: ${selected.size}`
            + (activeCount ? ` · ${state.protectActive ? 'Защищено надетых' : 'Надетых'}: ${activeCount}` : '');
        node('[data-bulk-delete]').disabled = !selected.size;
        node('[data-bulk-delete]').innerHTML = `<i class="fa-solid fa-trash-can"></i> Удалить (${selected.size})`;
        node('[data-bulk-none]').disabled = !selected.size;
        node('[data-bulk-page-all]').disabled = !pageEntries.some(canSelect);
        node('[data-bulk-all]').disabled = !entries.some(canSelect);
    }

    function render() {
        entries = wardrobeCleanupEntries(getSettings(), getMetadata(), state, getTypes());
        const selectable = new Set(entries.filter(canSelect).map(entry => entry.key));
        for (const key of selected) if (!selectable.has(key)) selected.delete(key);
        const totalPages = Math.max(1, Math.ceil(entries.length / state.pageSize));
        state.page = Math.max(0, Math.min(state.page, totalPages - 1));
        pageEntries = entries.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);
        node('[data-bulk-grid]').innerHTML = pageEntries.length ? pageEntries.map(entry => {
            const type = getTypes().find(type => type.id === entry.category)?.label || 'Другое';
            const disabled = !canSelect(entry);
            const src = imageSrc(entry.outfit);
            return `<button type="button" class="sw-bulk-card ${disabled ? 'sw-bulk-protected' : ''}" data-bulk-entry="${esc(entry.key)}"
                aria-pressed="false" ${disabled ? 'disabled' : ''} title="${esc(`${entry.outfit.name || 'Без названия'} · ${entry.owner.name} · ${type}`)}">
                <span class="sw-bulk-preview">${src ? `<img src="${esc(src)}" loading="lazy" alt="">` : '<i class="fa-solid fa-shirt"></i>'}
                    <i class="sw-bulk-check fa-solid fa-check"></i>${entry.active ? '<span class="sw-bulk-active">Надет</span>' : ''}</span>
                <b>${esc(entry.outfit.name || 'Без названия')}</b><small>${esc(entry.owner.name)}</small><small>${esc(type)}</small>
            </button>`;
        }).join('') : '<div class="sw-bulk-empty">Нарядов по этим фильтрам нет.</div>';
        const pages = new Set([0, totalPages - 1]);
        for (let p = state.page - 1; p <= state.page + 1; p++) if (p >= 0 && p < totalPages) pages.add(p);
        let previous = -1;
        const pageButtons = [...pages].sort((a, b) => a - b).map(p => {
            const gap = p - previous > 1 ? '<span>…</span>' : '';
            previous = p;
            return `${gap}<button type="button" data-bulk-page="${p}" ${p === state.page ? 'aria-current="page"' : ''}>${p + 1}</button>`;
        }).join('');
        node('[data-bulk-pagination]').innerHTML = `<div class="sw-bulk-pages">
            <button type="button" data-bulk-page="${state.page - 1}" aria-label="Предыдущая страница" ${state.page === 0 ? 'disabled' : ''}>‹</button>
            ${pageButtons}<button type="button" data-bulk-page="${state.page + 1}" aria-label="Следующая страница" ${state.page === totalPages - 1 ? 'disabled' : ''}>›</button>
            </div><label>На странице <select data-bulk-size>${[6, 12, 24].map(size => `<option ${size === state.pageSize ? 'selected' : ''}>${size}</option>`).join('')}</select></label>`;
        node('[data-bulk-undo]').disabled = !journal?.removed?.length;
        paintSelection();
        node('.sw-bulk-scroll').scrollTop = 0;
    }

    function filterChanged() {
        state.page = 0; selected.clear(); render();
    }
    node('[data-bulk-kind]').addEventListener('change', event => {
        state.kind = event.target.value; state.ownerKey = ''; refreshOwners(); filterChanged();
    });
    node('[data-bulk-owner]').addEventListener('change', event => { state.ownerKey = event.target.value; filterChanged(); });
    node('[data-bulk-category]').addEventListener('change', event => { state.category = event.target.value; filterChanged(); });
    node('[data-bulk-search]').addEventListener('input', event => { state.search = event.target.value; filterChanged(); });
    node('[data-bulk-protect]').addEventListener('change', event => { state.protectActive = event.target.checked; render(); });
    node('[data-bulk-page-all]').addEventListener('click', () => {
        for (const entry of pageEntries) if (canSelect(entry)) selected.add(entry.key);
        paintSelection();
    });
    node('[data-bulk-all]').addEventListener('click', () => {
        for (const entry of entries) if (canSelect(entry)) selected.add(entry.key);
        paintSelection();
    });
    node('[data-bulk-none]').addEventListener('click', () => { selected.clear(); paintSelection(); });
    node('[data-bulk-grid]').addEventListener('click', event => {
        const card = event.target.closest('[data-bulk-entry]');
        if (!card || card.disabled) return;
        const key = card.dataset.bulkEntry;
        if (selected.has(key)) selected.delete(key); else selected.add(key);
        paintSelection();
    });
    node('[data-bulk-pagination]').addEventListener('click', event => {
        const button = event.target.closest('[data-bulk-page]');
        if (!button || button.disabled) return;
        state.page = Number(button.dataset.bulkPage); render();
    });
    node('[data-bulk-pagination]').addEventListener('change', event => {
        if (!event.target.matches('[data-bulk-size]')) return;
        state.pageSize = Number(event.target.value); state.page = 0; render();
    });
    node('[data-bulk-delete]').addEventListener('click', () => {
        // Re-read active pointers immediately before the destructive operation.
        const picked = wardrobeCleanupEntries(getSettings(), getMetadata(), state, getTypes())
            .filter(entry => selected.has(entry.key) && canSelect(entry));
        if (!picked.length) { render(); return; }
        const groups = new Map();
        for (const entry of picked) groups.set(entry.owner.name, (groups.get(entry.owner.name) || 0) + 1);
        const details = [...groups].slice(0, 8).map(([name, count]) => `${name}: ${count}`).join('\n');
        const activeCount = picked.filter(entry => entry.active).length;
        const message = `Удалить выбранные наряды (${picked.length})?\n\n${details}`
            + (groups.size > 8 ? `\nИ ещё гардеробов: ${groups.size - 8}` : '')
            + (activeCount ? `\n\nВнимание: надетых нарядов — ${activeCount}. Они будут сняты.` : '')
            + '\n\nФайлы картинок и другие копии не удаляются.';
        if (!(adapters.confirm ? adapters.confirm(message) : window.confirm(message))) return;
        const result = deleteWardrobeSelection(getSettings(), new Set(picked.map(entry => entry.key)), state);
        if (result.removed.length) {
            journal = result;
            onChange();
            status(`Удалено: ${result.removed.length}. Можно отменить последнюю чистку.`);
        }
        selected.clear(); refreshOwners(); render();
    });
    node('[data-bulk-undo]').addEventListener('click', () => {
        const restored = undoWardrobeDeletion(getSettings(), journal);
        if (restored) onChange();
        status(`Восстановлено: ${restored}.`);
        selected.clear(); refreshOwners(); render();
    });
    refreshOwners(); render();
    // A previous maintenance tab may have left this container scrolled down.
    body.scrollTop = 0;
    body.scrollLeft = 0;
}
