/**
 * Lightbox-оверлей для просмотра сгенерированных картинок (.iig-generated-image)
 * в полноэкранном размере. Клик по картинке в чате открывает её в оверлее
 * поверх всего UI; закрытие — клик по бэкдропу / крестику / Esc.
 *
 * Фичи: zoom (wheel + pinch), pan (drag), показ промпта, скачивание.
 *
 * Критичный момент — все pointer/touch/click события внутри оверлея
 * останавливаем (stopPropagation), иначе ST-драуеры ловят клик «снаружи
 * своей области» и закрываются.
 */

import { t } from './i18n.js';
import { parseInstructionAttr, downloadImageSrc } from './utils.js';

const OVERLAY_ID = 'iig_lightbox';
const MIN_SCALE = 1;
const MAX_SCALE = 8;

/** Устанавливается в initLightbox; позволяет открывать лайтбокс напрямую по src (галерея). */
let openWithDataFn = null;

/**
 * Открывает лайтбокс для произвольного изображения (не привязанного к сообщению чата).
 * @param {string} src - URL изображения
 * @param {string} [prompt] - Промпт (если известен)
 * @param {string} [style] - Стиль (если известен)
 */
export function openLightboxWithSrc(src, prompt = '', style = '', navigation = null) {
    if (!src) return;
    openWithDataFn?.({ src, prompt, style, navigation });
}

let state = {
    scale: 1,
    translateX: 0,
    translateY: 0,
    isDragging: false,
    didDrag: false,
    startX: 0,
    startY: 0,
    lastTranslateX: 0,
    lastTranslateY: 0,
    initialPinchDist: 0,
    initialPinchScale: 1,
    prompt: '',
    style: '',
    imgSrc: '',
    onPrevious: null,
    onNext: null,
};

function resetState() {
    state.scale = 1;
    state.translateX = 0;
    state.translateY = 0;
    state.isDragging = false;
    state.didDrag = false;
    state.prompt = '';
    state.style = '';
    state.imgSrc = '';
    state.onPrevious = null;
    state.onNext = null;
}

function applyTransform(imgEl) {
    imgEl.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
}

function getChatImageData(img) {
    if (!(img instanceof HTMLImageElement)) return null;
    if (!img.isConnected || !img.src || img.classList.contains('iig-error-image')) return null;
    const rawSrc = String(img.getAttribute('src') || '');
    if (!rawSrc || rawSrc.endsWith('[IMG:GEN]')) return null;

    const instruction = parseInstructionAttr(img.getAttribute('data-iig-instruction'));
    return {
        element: img,
        src: img.src,
        alt: img.alt || '',
        prompt: instruction ? (instruction.prompt || '') : (img.alt || ''),
        style: instruction?.style || '',
    };
}

/** Returns generated chat images in their current visual/message order. */
function collectChatLightboxImages() {
    const chat = document.getElementById('chat');
    if (!chat) return [];
    return Array.from(chat.querySelectorAll('img[data-iig-instruction], img.iig-generated-image'))
        .map(getChatImageData)
        .filter(Boolean);
}


/**
 * Инициализирует lightbox один раз. Повторный вызов — no-op.
 */
export function initLightbox() {
    if (document.getElementById(OVERLAY_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'iig-lightbox';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
        <div class="iig-lightbox-backdrop"></div>
        <button class="iig-lightbox-nav iig-lightbox-nav-prev" type="button" title="${t`Previous image`}" aria-label="${t`Previous image`}">
            <i class="fa-solid fa-chevron-left"></i>
        </button>
        <button class="iig-lightbox-nav iig-lightbox-nav-next" type="button" title="${t`Next image`}" aria-label="${t`Next image`}">
            <i class="fa-solid fa-chevron-right"></i>
        </button>
        <div class="iig-lightbox-toolbar">
            <button class="iig-lightbox-btn iig-lightbox-zoom-in" type="button" title="${t`Zoom in`}" aria-label="${t`Zoom in`}">
                <i class="fa-solid fa-magnifying-glass-plus"></i>
            </button>
            <button class="iig-lightbox-btn iig-lightbox-zoom-out" type="button" title="${t`Zoom out`}" aria-label="${t`Zoom out`}">
                <i class="fa-solid fa-magnifying-glass-minus"></i>
            </button>
            <span class="iig-lightbox-zoom-level">100%</span>
            <button class="iig-lightbox-btn iig-lightbox-download" type="button" title="${t`Download`}" aria-label="${t`Download`}">
                <i class="fa-solid fa-download"></i>
            </button>
            <button class="iig-lightbox-btn iig-lightbox-prompt-toggle" type="button" title="${t`Show prompt`}" aria-label="${t`Show prompt`}">
                <i class="fa-solid fa-file-lines"></i>
            </button>
            <button class="iig-lightbox-btn iig-lightbox-close" type="button" title="${t`Close`}" aria-label="${t`Close`}">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="iig-lightbox-content">
            <img class="iig-lightbox-img" src="" alt="">
        </div>
        <div class="iig-lightbox-prompt-panel" aria-hidden="true">
            <div class="iig-lightbox-prompt-header">
                <span>${t`Prompt`}</span>
                <button class="iig-lightbox-btn iig-lightbox-prompt-copy" type="button" title="${t`Copy`}" aria-label="${t`Copy`}">
                    <i class="fa-solid fa-copy"></i>
                </button>
            </div>
            <div class="iig-lightbox-prompt-style"></div>
            <pre class="iig-lightbox-prompt-text"></pre>
        </div>
    `;
    document.body.appendChild(overlay);

    const imgEl = /** @type {HTMLImageElement} */ (overlay.querySelector('.iig-lightbox-img'));
    const zoomLevelEl = /** @type {HTMLElement} */ (overlay.querySelector('.iig-lightbox-zoom-level'));
    const promptPanel = /** @type {HTMLElement} */ (overlay.querySelector('.iig-lightbox-prompt-panel'));
    const promptTextEl = /** @type {HTMLElement} */ (overlay.querySelector('.iig-lightbox-prompt-text'));
    const promptStyleEl = /** @type {HTMLElement} */ (overlay.querySelector('.iig-lightbox-prompt-style'));
    const contentEl = /** @type {HTMLElement} */ (overlay.querySelector('.iig-lightbox-content'));
    const previousButton = /** @type {HTMLButtonElement} */ (overlay.querySelector('.iig-lightbox-nav-prev'));
    const nextButton = /** @type {HTMLButtonElement} */ (overlay.querySelector('.iig-lightbox-nav-next'));

    function updateNavigation() {
        previousButton.hidden = typeof state.onPrevious !== 'function';
        nextButton.hidden = typeof state.onNext !== 'function';
    }

    function updateZoomLevel() {
        zoomLevelEl.textContent = `${Math.round(state.scale * 100)}%`;
        imgEl.style.cursor = state.scale > 1 ? 'grab' : 'zoom-in';
    }

    function zoom(delta, centerX, centerY) {
        const oldScale = state.scale;
        state.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state.scale * delta));
        if (state.scale === oldScale) return;

        if (centerX !== undefined && centerY !== undefined) {
            const rect = contentEl.getBoundingClientRect();
            const cx = centerX - rect.left - rect.width / 2;
            const cy = centerY - rect.top - rect.height / 2;
            state.translateX = cx - (cx - state.translateX) * (state.scale / oldScale);
            state.translateY = cy - (cy - state.translateY) * (state.scale / oldScale);
        }

        if (state.scale <= 1) {
            state.translateX = 0;
            state.translateY = 0;
        }

        applyTransform(imgEl);
        updateZoomLevel();
    }

    const close = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
        promptPanel.setAttribute('aria-hidden', 'true');
        promptPanel.classList.remove('open');
        document.body.style.overflow = '';
        imgEl.src = '';
        imgEl.style.transform = '';
        imgEl.style.transition = '';
        imgEl.style.opacity = '';
        resetState();
        updateNavigation();
        updateZoomLevel();
    };

    // --- Close ---
    overlay.querySelector('.iig-lightbox-backdrop')?.addEventListener('click', close);
    overlay.querySelector('.iig-lightbox-close')?.addEventListener('click', close);

    // --- Gallery navigation ---
    previousButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.onPrevious?.();
    });
    nextButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.onNext?.();
    });

    // --- Zoom buttons ---
    overlay.querySelector('.iig-lightbox-zoom-in')?.addEventListener('click', (e) => {
        e.stopPropagation();
        zoom(1.4);
    });
    overlay.querySelector('.iig-lightbox-zoom-out')?.addEventListener('click', (e) => {
        e.stopPropagation();
        zoom(1 / 1.4);
    });

    // --- Download ---
    overlay.querySelector('.iig-lightbox-download')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!state.imgSrc) return;
        await downloadImageSrc(state.imgSrc);
    });

    // --- Prompt toggle ---
    overlay.querySelector('.iig-lightbox-prompt-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = promptPanel.classList.toggle('open');
        promptPanel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    });

    // --- Prompt copy ---
    overlay.querySelector('.iig-lightbox-prompt-copy')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = state.style
            ? `Style: ${state.style}\n\n${state.prompt}`
            : state.prompt;
        navigator.clipboard.writeText(text).then(() => {
            toastr.success(t`Copied to clipboard`, '', { timeOut: 1500 });
        });
    });

    // --- Wheel zoom ---
    contentEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        zoom(delta, e.clientX, e.clientY);
    }, { passive: false });

    let suppressImageClickUntil = 0;

    // --- Click on image: zoom in if scale=1, reset if zoomed (but NOT after drag/swipe) ---
    imgEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() < suppressImageClickUntil) return;
        if (state.didDrag) {
            state.didDrag = false;
            return;
        }
        if (state.scale > 1) {
            state.scale = 1;
            state.translateX = 0;
            state.translateY = 0;
            applyTransform(imgEl);
            updateZoomLevel();
        } else {
            zoom(2.5, e.clientX, e.clientY);
        }
    });

    // --- Drag/pan ---
    const DRAG_THRESHOLD = 5;

    contentEl.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (state.scale <= 1) return;
        state.isDragging = true;
        state.didDrag = false;
        state.startX = e.clientX;
        state.startY = e.clientY;
        state.lastTranslateX = state.translateX;
        state.lastTranslateY = state.translateY;
        imgEl.style.cursor = 'grabbing';
        imgEl.setPointerCapture(e.pointerId);
    });

    contentEl.addEventListener('pointermove', (e) => {
        if (!state.isDragging) return;
        e.stopPropagation();
        const dx = e.clientX - state.startX;
        const dy = e.clientY - state.startY;
        if (!state.didDrag && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
            state.didDrag = true;
        }
        state.translateX = state.lastTranslateX + dx;
        state.translateY = state.lastTranslateY + dy;
        applyTransform(imgEl);
    });

    const endDrag = (e) => {
        if (!state.isDragging) return;
        e?.stopPropagation();
        state.isDragging = false;
        imgEl.style.cursor = state.scale > 1 ? 'grab' : 'zoom-in';
    };
    contentEl.addEventListener('pointerup', endDrag);
    contentEl.addEventListener('pointercancel', endDrag);

    // --- Pinch-to-zoom + one-finger chat/gallery swipe (touch) ---
    let activeTouches = [];
    let swipeGesture = null;

    const resetSwipeVisual = (animated = true) => {
        imgEl.style.transition = animated ? 'transform 160ms ease, opacity 160ms ease' : 'none';
        imgEl.style.transform = '';
        imgEl.style.opacity = '';
        if (animated) {
            setTimeout(() => {
                if (!swipeGesture) imgEl.style.transition = '';
            }, 180);
        }
    };

    contentEl.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        activeTouches = Array.from(e.touches);
        if (activeTouches.length === 2) {
            swipeGesture = null;
            resetSwipeVisual(false);
            e.preventDefault();
            state.initialPinchDist = getTouchDist(activeTouches);
            state.initialPinchScale = state.scale;
        } else if (activeTouches.length === 1 && state.scale <= 1 && (state.onPrevious || state.onNext)) {
            const touch = activeTouches[0];
            swipeGesture = {
                id: touch.identifier,
                startX: touch.clientX,
                startY: touch.clientY,
                currentX: touch.clientX,
                currentY: touch.clientY,
                startedAt: Date.now(),
                axis: null,
            };
        }
    }, { passive: false });

    contentEl.addEventListener('touchmove', (e) => {
        e.stopPropagation();
        if (e.touches.length === 2) {
            swipeGesture = null;
            resetSwipeVisual(false);
            e.preventDefault();
            const dist = getTouchDist(Array.from(e.touches));
            const delta = dist / state.initialPinchDist;
            const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state.initialPinchScale * delta));
            if (newScale !== state.scale) {
                state.scale = newScale;
                if (state.scale <= 1) {
                    state.translateX = 0;
                    state.translateY = 0;
                }
                applyTransform(imgEl);
                updateZoomLevel();
            }
            return;
        }

        if (!swipeGesture || e.touches.length !== 1 || state.scale > 1) return;
        const touch = Array.from(e.touches).find((item) => item.identifier === swipeGesture.id);
        if (!touch) return;
        swipeGesture.currentX = touch.clientX;
        swipeGesture.currentY = touch.clientY;
        const dx = swipeGesture.currentX - swipeGesture.startX;
        const dy = swipeGesture.currentY - swipeGesture.startY;

        if (!swipeGesture.axis && Math.abs(dx) + Math.abs(dy) >= 10) {
            swipeGesture.axis = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'horizontal' : 'vertical';
        }
        if (swipeGesture.axis !== 'horizontal') return;

        e.preventDefault();
        suppressImageClickUntil = Date.now() + 500;
        const canNavigate = dx < 0 ? typeof state.onNext === 'function' : typeof state.onPrevious === 'function';
        const displayDx = canNavigate ? dx : dx * 0.24;
        const width = Math.max(1, contentEl.clientWidth);
        imgEl.style.transition = 'none';
        imgEl.style.transform = `translate3d(${displayDx}px, 0, 0)`;
        imgEl.style.opacity = String(1 - Math.min(0.22, Math.abs(displayDx) / (width * 2.2)));
    }, { passive: false });

    const finishSwipe = (e, cancelled = false) => {
        e?.stopPropagation();
        activeTouches = Array.from(e?.touches || []);
        const gesture = swipeGesture;
        swipeGesture = null;
        if (!gesture) return;
        if (gesture.axis !== 'horizontal') {
            resetSwipeVisual(true);
            return;
        }

        e?.preventDefault();
        suppressImageClickUntil = Date.now() + 600;
        const dx = gesture.currentX - gesture.startX;
        const duration = Date.now() - gesture.startedAt;
        const width = Math.max(1, contentEl.clientWidth);
        const threshold = Math.min(90, Math.max(48, width * 0.14));
        const committed = !cancelled && (Math.abs(dx) >= threshold || (duration < 350 && Math.abs(dx) >= 32));
        const navigate = dx < 0 ? state.onNext : state.onPrevious;

        if (!committed || typeof navigate !== 'function') {
            resetSwipeVisual(true);
            return;
        }

        imgEl.style.transition = 'transform 150ms ease-out, opacity 150ms ease-out';
        imgEl.style.transform = `translate3d(${dx < 0 ? -width : width}px, 0, 0)`;
        imgEl.style.opacity = '0';
        setTimeout(() => {
            resetSwipeVisual(false);
            if (overlay.classList.contains('open')) navigate();
        }, 145);
    };

    contentEl.addEventListener('touchend', (e) => finishSwipe(e, false), { passive: false });
    contentEl.addEventListener('touchcancel', (e) => finishSwipe(e, true), { passive: false });

    // --- Block native drag so ST doesn't try to import the image ---
    imgEl.draggable = false;
    imgEl.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
    const blockDrag = (e) => { e.preventDefault(); e.stopPropagation(); };
    overlay.addEventListener('dragstart', blockDrag);
    overlay.addEventListener('dragover', blockDrag);
    overlay.addEventListener('dragenter', blockDrag);
    overlay.addEventListener('dragleave', blockDrag);
    overlay.addEventListener('drop', blockDrag);

    // --- Stop all bubbles to protect ST drawers ---
    const stopBubble = (e) => e.stopPropagation();
    overlay.addEventListener('touchstart', stopBubble, { passive: true });
    overlay.addEventListener('touchend', stopBubble, { passive: true });
    overlay.addEventListener('pointerdown', stopBubble);
    overlay.addEventListener('pointerup', stopBubble);
    overlay.addEventListener('mousedown', stopBubble);

    // --- Esc ---
    document.addEventListener('keydown', (e) => {
        if (!overlay.classList.contains('open')) return;
        if (e.key === 'Escape') {
            close(e);
        } else if (e.key === 'ArrowLeft' && state.onPrevious) {
            e.preventDefault();
            state.onPrevious();
        } else if (e.key === 'ArrowRight' && state.onNext) {
            e.preventDefault();
            state.onNext();
        }
    });

    // --- Open with arbitrary data (chat click + gallery) ---
    function openWithData({ src, alt = '', prompt = '', style = '', navigation = null }) {
        resetState();
        state.imgSrc = src;
        state.prompt = prompt;
        state.style = style;
        state.onPrevious = navigation?.onPrevious || null;
        state.onNext = navigation?.onNext || null;
        imgEl.src = src;
        imgEl.alt = alt;
        imgEl.style.transform = '';
        imgEl.style.transition = '';
        imgEl.style.opacity = '';

        promptTextEl.textContent = state.prompt || t`No prompt available`;
        if (state.style) {
            promptStyleEl.textContent = `Style: ${state.style}`;
            promptStyleEl.style.display = '';
        } else {
            promptStyleEl.textContent = '';
            promptStyleEl.style.display = 'none';
        }

        promptPanel.classList.remove('open');
        promptPanel.setAttribute('aria-hidden', 'true');

        updateZoomLevel();
        updateNavigation();

        overlay.classList.add('open');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
    }
    openWithDataFn = openWithData;

    // --- Delegation: click on chat images ---
    const chatEl = document.getElementById('chat');
    chatEl?.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const img = /** @type {HTMLImageElement|null} */ (
            target?.closest('.iig-generated-image') || target?.closest('img[data-iig-instruction]')
        );
        if (!img) return;
        if (img.classList.contains('iig-error-image')) return;

        e.preventDefault();
        e.stopPropagation();

        const images = collectChatLightboxImages();
        const initialIndex = images.findIndex((item) => item.element === img);
        if (initialIndex < 0) return;

        const showChatImage = (index) => {
            const item = images[index];
            if (!item) return;

            // Read the live element again so a completed reroll updates the image
            // even if it happened while the lightbox was already open.
            const liveItem = getChatImageData(item.element) || item;
            openWithData({
                src: liveItem.src,
                alt: liveItem.alt,
                prompt: liveItem.prompt,
                style: liveItem.style,
                navigation: {
                    onPrevious: index > 0 ? () => showChatImage(index - 1) : null,
                    onNext: index < images.length - 1 ? () => showChatImage(index + 1) : null,
                },
            });
        };

        showChatImage(initialIndex);
    });
}

function getTouchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}
