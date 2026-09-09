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
import { downloadImageSrc } from './utils.js';
import { regenerateSingleTag } from './pipeline.js';

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
    observer.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
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

    const isError = img.classList.contains('iig-error-image');
    let host = img.parentElement;

    if (host?.classList?.contains('iig-img-host')) {
        const existing = host.querySelector(':scope > .iig-img-actions');
        if (existing && existing.dataset.iigError === (isError ? '1' : '0')) return;
        existing?.remove();
        host.appendChild(buildActions(img, isError));
        return;
    }

    host = document.createElement('span');
    host.className = 'iig-img-host';
    img.replaceWith(host);
    host.appendChild(img);
    host.appendChild(buildActions(img, isError));
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
    actions.innerHTML = isError
        ? `<button class="iig-img-action iig-img-retry" type="button" title="${t`Retry`}" aria-label="${t`Retry`}"><i class="fa-solid fa-rotate-right"></i></button>`
        : `<button class="iig-img-action iig-img-download" type="button" title="${t`Download`}" aria-label="${t`Download`}"><i class="fa-solid fa-download"></i></button>`
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
