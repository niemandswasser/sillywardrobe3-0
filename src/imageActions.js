/**
 * Inline corner buttons on generated chat images:
 *   - successful image: Download + Regenerate
 *   - error placeholder: Retry
 *
 * Each generated <img> is wrapped in <span class="iig-img-host"> with the
 * actions div as a sibling. Wrapping is runtime-only — message storage HTML
 * is untouched. MutationObserver re-attaches after ST re-renders messages.
 */

import { t } from './i18n.js';
import { downloadImageSrc, isErrorImageSrc } from './utils.js';
import { regenerateSingleTag } from './pipeline.js';
import { getSettings } from './settings.js';

const IMG_SELECTOR = 'img[data-iig-instruction]';

export function initImageActions() {
    const chat = document.getElementById('chat');
    if (!chat) return;

    scanAndAttach(chat);

    const observer = new MutationObserver((mutations) => {
        const dirty = new Set();
        for (const m of mutations) {
            if (m.type === 'childList') {
                for (const n of m.addedNodes) {
                    if (n instanceof Element) dirty.add(n);
                }
            }
            if (m.type === 'attributes' && m.target instanceof Element) {
                dirty.add(m.target);
            }
        }
        for (const el of dirty) {
            scanAndAttach(el);
        }
    });
    // `class` changes are extremely frequent in long/streaming chats and our
    // own censor state already synchronizes its button explicitly. Watching
    // only image source replacements keeps rerolls working without rescanning
    // messages for unrelated hover/animation/layout class changes.
    observer.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
}

function scanAndAttach(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    if (root instanceof HTMLImageElement && root.matches?.(IMG_SELECTOR)) {
        attachActions(root);
        return;
    }
    const imgs = root.querySelectorAll?.(IMG_SELECTOR);
    if (!imgs) return;
    for (const img of imgs) {
        attachActions(img);
    }
}

function attachActions(img) {
    if (!img.src || img.src.endsWith('[IMG:GEN]')) return;

    const messageEl = findMessageElement(img);
    const messageId = messageEl?.getAttribute('mesid');
    if (messageId !== null && messageId !== undefined && messageId !== '') {
        img.dataset.iigMessageId = messageId;
    }

    // Keep a stable source-tag index. When another image in the same message
    // is replaced by a loading placeholder, live DOM indexes shift.
    if (!img.dataset.iigTagIndex) {
        const media = messageEl
            ? Array.from(messageEl.querySelectorAll('img[data-iig-instruction], video[data-iig-instruction]'))
            : [];
        const stableIndex = media.indexOf(img);
        if (stableIndex >= 0) img.dataset.iigTagIndex = String(stableIndex);
    }

    const isError = img.classList.contains('iig-error-image') || isErrorImageSrc(img.getAttribute('src') || img.src);
    if (isError) img.classList.add('iig-error-image');
    let host = img.parentElement;

    if (host?.classList?.contains('iig-img-host')) {
        ensureCensorOverlay(host);
        const existing = host.querySelector(':scope > .iig-img-actions');
        if (existing && existing.dataset.iigError === (isError ? '1' : '0')) {
            applyAutoCensor(host, img, isError);
            return;
        }
        existing?.remove();
        host.appendChild(buildActions(img, isError));
        applyAutoCensor(host, img, isError);
        return;
    }

    host = document.createElement('span');
    host.className = 'iig-img-host';
    img.replaceWith(host);
    host.appendChild(img);
    ensureCensorOverlay(host);
    host.appendChild(buildActions(img, isError));
    applyAutoCensor(host, img, isError);
}

function applyAutoCensor(host, img, isError) {
    const sourceKey = String(img.getAttribute('src') || img.src || '');

    // Regeneration replaces the image inside the existing host. Track the
    // concrete result source rather than the host itself so every new result
    // is censored once, while MutationObserver passes after manual reveal do
    // not cover the same image again.
    if (host.dataset.iigCensorSrc === sourceKey) {
        syncCensorButton(host);
        return;
    }
    host.dataset.iigCensorSrc = sourceKey;
    setCensored(host, !isError && Boolean(getSettings().censorOnGenerate));
}

function setCensored(host, censored) {
    host.classList.toggle('iig-censored', censored);
    syncCensorButton(host);
}

function syncCensorButton(host) {
    const button = host.querySelector(':scope > .iig-img-actions .iig-img-censor');
    if (!(button instanceof HTMLButtonElement)) return;

    const censored = host.classList.contains('iig-censored');
    const label = censored ? t`Reveal image` : t`Blur image`;
    button.title = label;
    button.setAttribute('aria-label', label);
    const icon = button.querySelector('i');
    if (icon) icon.className = censored ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
}

function ensureCensorOverlay(host) {
    if (host.querySelector(':scope > .iig-censor-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'iig-censor-overlay';
    overlay.title = t`Click to reveal`;
    overlay.innerHTML = '<span class="iig-censor-reveal"><i class="fa-solid fa-eye"></i></span>';
    overlay.addEventListener('pointerdown', (event) => event.stopPropagation());
    overlay.addEventListener('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        setCensored(host, false);
    });
    host.appendChild(overlay);
}

function findMessageElement(element) {
    if (!element) return null;
    const direct = element.closest?.('.mes[mesid], [mesid]');
    if (direct) return direct;

    const hostDirect = element.parentElement?.closest?.('.mes[mesid], [mesid]');
    if (hostDirect) return hostDirect;

    for (const candidate of document.querySelectorAll('#chat [mesid]')) {
        if (candidate.contains(element)) return candidate;
    }
    return null;
}

function buildActions(img, isError) {
    const actions = document.createElement('div');
    actions.className = 'iig-img-actions';
    actions.dataset.iigError = isError ? '1' : '0';
    actions.dataset.position = normalizeActionPosition(getSettings().imageActionPosition);
    actions.innerHTML = isError
        ? `<button class="iig-img-action iig-img-retry" type="button" title="${t`Retry`}" aria-label="${t`Retry`}"><i class="fa-solid fa-rotate-right"></i></button>`
        : `<button class="iig-img-action iig-img-download" type="button" title="${t`Download`}" aria-label="${t`Download`}"><i class="fa-solid fa-download"></i></button>`
          + `<button class="iig-img-action iig-img-censor" type="button" title="${t`Blur image`}" aria-label="${t`Blur image`}"><i class="fa-solid fa-eye-slash"></i></button>`
          + `<button class="iig-img-action iig-img-regen" type="button" title="${t`Regenerate this image`}" aria-label="${t`Regenerate this image`}"><i class="fa-solid fa-rotate-right"></i></button>`;

    const stopAll = (e) => { e.stopPropagation(); e.preventDefault(); };
    actions.addEventListener('pointerdown', (e) => e.stopPropagation());
    actions.addEventListener('click', (e) => e.stopPropagation());

    // SillyTavern may replace only the <img> when switching a swipe while
    // preserving our host and action buttons. Resolve the live image at click
    // time instead of retaining a reference to the detached previous swipe.
    const getCurrentImage = () => actions.parentElement
        ?.querySelector(':scope > img[data-iig-instruction]') || img;

    actions.querySelector('.iig-img-download')?.addEventListener('click', async (e) => {
        stopAll(e);
        await downloadImage(getCurrentImage());
    });
    actions.querySelector('.iig-img-censor')?.addEventListener('click', (e) => {
        stopAll(e);
        const host = actions.parentElement;
        if (host) setCensored(host, !host.classList.contains('iig-censored'));
    });
    actions.querySelector('.iig-img-regen')?.addEventListener('click', async (e) => {
        stopAll(e);
        await regenerateOne(getCurrentImage());
    });
    actions.querySelector('.iig-img-retry')?.addEventListener('click', async (e) => {
        stopAll(e);
        await regenerateOne(getCurrentImage());
    });

    return actions;
}

function normalizeActionPosition(value) {
    return ['top-right', 'top-left', 'bottom-right', 'bottom-left'].includes(value)
        ? value
        : 'top-right';
}

async function downloadImage(img) {
    const ok = await downloadImageSrc(img.src);
    if (!ok) {
        toastr.error(t`Failed to download image`, t`Image Generation`);
    }
}

async function regenerateOne(img) {
    const messageEl = findMessageElement(img);
    const storedMessageId = Number.parseInt(img.dataset.iigMessageId || '', 10);
    const domMessageId = Number.parseInt(messageEl?.getAttribute('mesid') || '', 10);
    const messageId = Number.isInteger(storedMessageId) ? storedMessageId : domMessageId;
    if (!Number.isInteger(messageId)) {
        toastr.error(t`Could not locate message`, t`Image Generation`);
        return;
    }

    // tagIndex must match regenerateSingleTag's selector (img + video) so we
    // don't regenerate the wrong tag when a Naistera video precedes the image.
    const storedIndex = Number.parseInt(img.dataset.iigTagIndex || '', 10);
    const allMedia = messageEl
        ? Array.from(messageEl.querySelectorAll('img[data-iig-instruction], video[data-iig-instruction]'))
        : [];
    const tagIndex = Number.isInteger(storedIndex) && storedIndex >= 0 ? storedIndex : allMedia.indexOf(img);
    if (tagIndex < 0) return;

    const instruction = img.getAttribute('data-iig-instruction') || '';
    await regenerateSingleTag(messageId, tagIndex, instruction);
}
