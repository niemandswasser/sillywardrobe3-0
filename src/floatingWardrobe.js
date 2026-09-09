/**
 * Legacy floating wardrobe button — replaced by bar button in wardrobe.js v4.
 * These exports are kept as no-ops so existing imports don't break.
 */

import { swInjectBarBtn } from './wardrobe.js';

export function mountFloatingButton() { swInjectBarBtn(); }
export function unmountFloatingButton() { /* bar btn managed by wardrobe.js */ }
export function syncFloatingButton() { swInjectBarBtn(); }
