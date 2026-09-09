/**
 * Inline Image Generation — entry point.
 *
 * Catches `[IMG:GEN:{json}]` tags in AI messages and `<img data-iig-instruction>`
 * and generates images via configured API.
 *
 * Вся логика вынесена в `src/`. Этот файл — только импорт + init.
 */

import {
    getSettings,
    migrateRemovedProviders,
    migrateConnectionProfilesFromLegacy,
    migrateAdditionalReferencesToLorebook,
    saveSettings,
} from './src/settings.js';
import { createSettingsUI } from './src/ui.js';
import { addButtonsToExistingMessages, subscribeEvents } from './src/events.js';
import { registerIigBookMacro } from './src/references.js';
import { initLightbox } from './src/lightbox.js';
import { updateAvatarAppearanceInjection } from './src/extras.js';
import { initWardrobe } from './src/wardrobe.js';
import { initImageActions } from './src/imageActions.js';
import { initGallery } from './src/gallery.js';

(function init() {
    const context = SillyTavern.getContext();

    // Load/seed settings eagerly so getSettings() сразу возвращает валидный объект.
    const settings = getSettings();

    // One-time migrations: заполняем connection profiles и переносим
    // старые additionalReferences в lorebooks[0] (идемпотентно).
    migrateRemovedProviders(settings);
    migrateConnectionProfilesFromLegacy(settings);
    migrateAdditionalReferencesToLorebook(settings);
    saveSettings();

    // Register {{iig-book}} macro — делает refs-список доступным для вставки
    // в карточки / пресеты, чтобы LLM видела какие триггеры можно ставить.
    registerIigBookMacro();

    // Wardrobe v4 — init early so settings are seeded and event hooks registered.
    initWardrobe();

    // Gallery — wand menu button.
    initGallery();

    // Create settings UI when app is ready.
    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        // Add buttons to any messages already in chat.
        addButtonsToExistingMessages();
        // Lightbox: делегированный click-handler на #chat, оверлей один на страницу.
        initLightbox();
        // Avatar appearance injection — поднимает описания внешности активных аватаров.
        updateAvatarAppearanceInjection();
        // Image action buttons (Download / Regenerate / Retry) on generated images.
        initImageActions();
        console.log('[IIG] Inline Image Generation extension loaded');
    });

    // На смену чата — пересинхронизируем avatar appearance injection.
    // (Wardrobe handles its own CHAT_CHANGED in initWardrobe.)
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            updateAvatarAppearanceInjection();
        }, 100);
    });

    subscribeEvents();

    console.log('[IIG] Inline Image Generation extension initialized');
})();
