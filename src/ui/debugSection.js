/**
 * Секция «Debug»: retries, экспорт логов, попапы «последний запрос»
 * и превью {{iig-book}} макроса.
 */

import {
    getSettings,
    saveSettings,
    exportLogs,
    getLastRequestSnapshot,
} from '../settings.js';
import { sanitizeForHtml } from '../utils.js';
import { renderIigBookMacro } from '../references.js';
import { t } from '../i18n.js';
import { Popup } from '../../../../../popup.js';
import { buildSettingsSectionHtml } from './common.js';

export function buildDebugSettingsSectionHtml(settings = getSettings()) {
    const bodyHtml = `
        <div class="iig-settings-card">
            <div class="iig-settings-card-nested">
                <div class="flex-row">
                    <label for="iig_max_retries">${t`Max retries`}</label>
                    <input type="number" id="iig_max_retries" class="text_pole flex1" value="${settings.maxRetries}" min="0" max="5">
                    <div></div>
                </div>
                <div class="flex-row">
                    <label for="iig_retry_delay">${t`Retry delay (ms)`}</label>
                    <input type="number" id="iig_retry_delay" class="text_pole flex1" value="${settings.retryDelay}" min="500" max="10000" step="500">
                    <div></div>
                </div>
            </div>
            <div class="iig-debug-actions">
                <div id="iig_export_logs" class="menu_button iig-button-inline">
                    <i class="fa-solid fa-download"></i> ${t`Export logs`}
                </div>
                <div id="iig_show_last_request" class="menu_button iig-button-inline" title="${t`View prompt and references sent in the most recent generation`}">
                    <i class="fa-solid fa-magnifying-glass"></i> ${t`Show last request`}
                </div>
                <div id="iig_show_book_macro" class="menu_button iig-button-inline" title="${t`Preview the rendered {{iig-book}} macro as the LLM will see it`}">
                    <i class="fa-solid fa-book"></i> ${t`Show {{iig-book}} preview`}
                </div>
            </div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_debug_section', t`Debug`, bodyHtml, false);
}

// ----- Last request popup -----

function formatTimestampLocal(ts) {
    if (!Number.isFinite(ts)) return '';
    try {
        return new Date(ts).toLocaleString();
    } catch (_e) {
        return new Date(ts).toISOString();
    }
}

function formatMatchReason(reason) {
    if (!reason || typeof reason !== 'object') return '';
    switch (reason.kind) {
        case 'always':
            return t`always`;
        case 'primary':
            return t`alias: ${reason.detail || ''}`;
        case 'regex':
            return t`regex: ${reason.detail || ''}`;
        case 'regex-fallback':
            return t`invalid regex, fell back to literal: ${reason.detail || ''}`;
        default:
            return reason.kind || '';
    }
}

function buildMatchedRefsSectionHtml(matched) {
    if (!Array.isArray(matched) || matched.length === 0) {
        return `<p class="hint">${t`No additional references were matched in this request.`}</p>`;
    }
    const rows = matched.map((m) => {
        const primary = String(m.name || '').split(',')[0].trim();
        const metaBits = [];
        if (m.lorebookName) metaBits.push(sanitizeForHtml(m.lorebookName));
        if (m.group) metaBits.push(`[${sanitizeForHtml(m.group)}]`);
        if (Number.isFinite(m.priority) && m.priority !== 0) metaBits.push(`p=${m.priority}`);
        const reasonText = sanitizeForHtml(formatMatchReason(m.reason));
        return `
            <div class="iig-matched-ref-row">
                <span class="iig-matched-ref-name">${sanitizeForHtml(primary || m.name || '')}</span>
                ${metaBits.length > 0 ? `<span class="iig-matched-ref-meta">${metaBits.join(' · ')}</span>` : ''}
                ${reasonText ? `<span class="iig-matched-ref-reason">${reasonText}</span>` : ''}
            </div>
        `;
    });
    return `<div class="iig-matched-refs">${rows.join('')}</div>`;
}

function buildLastRequestPopupHtml(snapshot) {
    const meta = snapshot.metadata || {};
    const rows = [];
    const pushRow = (labelText, value) => {
        if (value === undefined || value === null || value === '') return;
        rows.push(`<div class="iig-last-req-meta-row"><span class="iig-last-req-meta-label">${sanitizeForHtml(labelText)}</span><span class="iig-last-req-meta-value">${sanitizeForHtml(String(value))}</span></div>`);
    };
    pushRow(t`Time`, formatTimestampLocal(snapshot.timestamp));
    pushRow(t`Provider`, meta.provider);
    pushRow(t`API type`, meta.apiType);
    pushRow(t`Model`, meta.model);
    pushRow(t`Aspect ratio`, meta.aspectRatio);
    pushRow(t`Resolution`, meta.imageSize);
    pushRow(t`Size`, meta.size);
    pushRow(t`Quality`, meta.quality);
    pushRow(t`Reference instruction applied`, meta.refInstructionApplied ? t`yes` : t`no`);

    const refsHtml = Array.isArray(snapshot.references) && snapshot.references.length > 0
        ? snapshot.references.map((ref) => `
            <div class="iig-last-req-ref">
                <img class="iig-last-req-ref-thumb" src="${sanitizeForHtml(ref.dataUrl)}" alt="${sanitizeForHtml(ref.label || '')}">
                <span class="iig-last-req-ref-label">${sanitizeForHtml(ref.label || '')}</span>
            </div>`).join('')
        : `<p class="hint">${t`No references were sent.`}</p>`;

    const matchedCount = Array.isArray(snapshot.matchedRefs) ? snapshot.matchedRefs.length : 0;

    return `
        <div class="iig-last-req">
            <div class="iig-last-req-meta">${rows.join('')}</div>
            <h4>${t`Matched references`} (${matchedCount})</h4>
            ${buildMatchedRefsSectionHtml(snapshot.matchedRefs || [])}
            <h4>${t`Final prompt sent to provider`}</h4>
            <pre class="iig-last-req-prompt">${sanitizeForHtml(snapshot.prompt || '')}</pre>
            <h4>${t`References`} (${Array.isArray(snapshot.references) ? snapshot.references.length : 0})</h4>
            <div class="iig-last-req-refs">${refsHtml}</div>
        </div>
    `;
}

async function showLastRequestPopup() {
    const snapshot = getLastRequestSnapshot();
    if (!snapshot) {
        toastr.info(t`No request recorded yet. Generate an image first.`, t`Image Generation`);
        return;
    }
    const html = buildLastRequestPopupHtml(snapshot);
    await Popup.show.text(t`Last generation request`, html, { allowVerticalScrolling: true, wide: true });
}

// ----- {{iig-book}} macro preview popup -----

async function showIigBookPreviewPopup() {
    const rendered = renderIigBookMacro();
    const hintHtml = `<p class="hint">${t`Paste {{iig-book}} into a character card or preset to inject this text into the LLM's context. Only enabled lorebooks with active references are included.`}</p>`;
    const bodyHtml = rendered
        ? `${hintHtml}<pre class="iig-last-req-prompt">${sanitizeForHtml(rendered)}</pre>`
        : `${hintHtml}<p class="hint">${t`The macro is currently empty: no enabled lorebook has any references with a name.`}</p>`;
    await Popup.show.text(t`{{iig-book}} preview`, bodyHtml, { allowVerticalScrolling: true, wide: true });
}

// ----- Debug section events -----

export function bindDebugSectionEvents(settings) {
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        settings.maxRetries = parseInt(e.target.value) || 3;
        saveSettings();
    });

    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        settings.retryDelay = parseInt(e.target.value) || 1000;
        saveSettings();
    });

    document.getElementById('iig_export_logs')?.addEventListener('click', () => {
        exportLogs();
    });

    document.getElementById('iig_show_last_request')?.addEventListener('click', () => {
        showLastRequestPopup();
    });

    document.getElementById('iig_show_book_macro')?.addEventListener('click', () => {
        showIigBookPreviewPopup();
    });
}
