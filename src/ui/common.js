/**
 * Общие UI-примитивы секций настроек: обёртка со сворачиваемым заголовком
 * и биндинг тогглов.
 */

export function buildSettingsSectionHtml(sectionId, title, bodyHtml, expanded = true) {
    return `
        <div class="iig-section" data-section-id="${sectionId}">
            <div class="iig-section-toggle" data-section-toggle="${sectionId}">
                <span class="iig-section-title">${title}</span>
                <i class="fa-solid fa-chevron-down iig-section-chevron ${expanded ? '' : 'iig-section-chevron-collapsed'}"></i>
            </div>
            <div class="iig-section-body ${expanded ? '' : 'iig-hidden'}" id="${sectionId}">
                ${bodyHtml}
            </div>
        </div>
    `;
}

export function bindSectionToggles() {
    document.querySelectorAll('[data-section-toggle]').forEach((toggle) => {
        toggle.addEventListener('click', () => {
            const sectionId = toggle.getAttribute('data-section-toggle');
            const body = sectionId ? document.getElementById(sectionId) : null;
            const chevron = toggle.querySelector('.iig-section-chevron');
            if (!body) {
                return;
            }

            body.classList.toggle('iig-hidden');
            chevron?.classList.toggle('iig-section-chevron-collapsed', body.classList.contains('iig-hidden'));
        });
    });
}
