// Parameter hints are read-only and never change generation settings.
const bound = new WeakSet();
let active = null;

export function renderParameterHelp(text) {
    const escaped = String(text).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
    return `<button type="button" class="iig-param-help" data-iig-param-help="${escaped}" title="${escaped}" aria-label="${escaped}" aria-expanded="false">?</button>`;
}

function closeHelp() {
    if (!active) return;
    active.owner.setAttribute('aria-expanded', 'false');
    active.owner.removeAttribute('aria-describedby');
    active.events.abort();
    active.bubble.remove();
    active = null;
}

function showHelp(owner, pinned = false) {
    if (active?.owner === owner) {
        active.pinned ||= pinned;
        return;
    }
    closeHelp();
    const doc = owner.ownerDocument;
    const win = doc.defaultView;
    const bubble = doc.createElement('div');
    bubble.className = 'iig-param-tooltip';
    bubble.id = 'iig-param-tooltip';
    bubble.setAttribute('role', 'tooltip');
    bubble.textContent = owner.dataset.iigParamHelp;
    // Top layer avoids clipping by the scrollable settings panel or a dialog.
    if (typeof bubble.showPopover === 'function') bubble.setAttribute('popover', 'manual');
    (owner.closest('dialog[open]') || doc.body).append(bubble);
    if (bubble.hasAttribute('popover')) bubble.showPopover();
    const viewport = win.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || win.innerWidth;
    const height = viewport?.height || win.innerHeight;
    bubble.style.maxWidth = `${Math.max(0, width - 24)}px`;
    bubble.style.maxHeight = `${Math.max(0, height - 24)}px`;
    const rect = owner.getBoundingClientRect();
    const box = bubble.getBoundingClientRect();
    bubble.style.left = `${Math.max(left + 12, Math.min(rect.right - box.width, left + width - box.width - 12))}px`;
    const below = rect.bottom + 8;
    const y = below + box.height <= top + height - 12 ? below : rect.top - box.height - 8;
    bubble.style.top = `${Math.max(top + 12, Math.min(y, top + height - box.height - 12))}px`;
    const events = new win.AbortController();
    active = { owner, bubble, events, pinned };
    owner.setAttribute('aria-expanded', 'true');
    owner.setAttribute('aria-describedby', bubble.id);
    const options = { signal: events.signal };
    doc.addEventListener('pointerdown', event => {
        if (!owner.contains(event.target) && !bubble.contains(event.target)) closeHelp();
    }, options);
    doc.addEventListener('keydown', event => { if (event.key === 'Escape') closeHelp(); }, options);
    doc.addEventListener('scroll', event => {
        if (!bubble.contains(event.target)) closeHelp();
    }, { ...options, capture: true });
    win.addEventListener('resize', closeHelp, options);
    viewport?.addEventListener('resize', closeHelp, options);
    viewport?.addEventListener('scroll', closeHelp, options);
}

export function bindParameterHelp(root = document) {
    closeHelp();
    root.querySelectorAll('[data-iig-param-help]').forEach(button => {
        if (bound.has(button)) return;
        bound.add(button);
        button.removeAttribute('title'); // Custom hover hint replaces the native one.
        button.addEventListener('pointerenter', event => {
            if (event.pointerType === 'mouse') showHelp(button);
        });
        const leave = () => { if (active?.owner === button && !active.pinned) closeHelp(); };
        button.addEventListener('pointerleave', leave);
        button.addEventListener('focus', () => showHelp(button));
        button.addEventListener('blur', leave);
        button.addEventListener('click', event => {
            // A help button inside a checkbox label must never toggle the option.
            event.preventDefault();
            event.stopPropagation();
            if (active?.owner === button && active.pinned) closeHelp();
            else showHelp(button, true);
        });
    });
}
