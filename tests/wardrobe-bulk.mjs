// Pure inventory/deletion tests plus the real wardrobe's shared-sync collector.
// Run: node --experimental-vm-modules tests/wardrobe-bulk.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {
    collectWardrobeCleanupOwners, wardrobeCleanupEntries, wardrobeEntryKey,
    deleteWardrobeSelection, undoWardrobeDeletion,
} from '../src/wardrobeBulk.js';

const types = [{ id: 'casual', label: 'Повседневное' }, { id: 'other', label: 'Другое' }];
const outfit = (id, type = 'casual') => ({ id, name: `Наряд ${id}`, type, imagePath: '/shared.png' });
const makeSettings = () => ({
    wardrobes: { Ethan: { bot: [outfit('same'), outfit('b2')], user: [outfit('old')] },
        Other: { bot: [outfit('same')], user: [] } },
    activeOutfits: { Ethan: { bot: 'same', user: 'old' }, Other: { bot: 'same' } },
    personaWardrobes: { 'persona:z.png': [outfit('p1', 'unknown'), outfit('p2')] },
    personaActiveOutfits: { 'persona:z.png': 'p1' },
    personaMigrationByCharacter: { Ethan: 'persona:z.png' },
    sharedBotWardrobe: [{ ...outfit('s1'), srcId: 'b2' }, outfit('s2')],
    sharedUserWardrobe: [{ ...outfit('u1'), srcId: 'p2' }],
    sharedBotActive: 's1', sharedUserActive: 'u1',
    sharedBotActiveByChat: { a: 's1', b: 's2' },
    sharedUserActiveByChat: { a: 'u1' }, sharedUserActiveByPersona: { 'persona:z.png': 'u1' },
    sharedDeletedSourceIds: { bot: ['already-deleted'], user: [] },
});
const metadata = { personas: { 'z.png': 'Zach' } };
let settings = makeSettings();
const baseline = structuredClone(settings);
const all = wardrobeCleanupEntries(settings, metadata, {}, types);
assert.equal(all.length, 9);
assert.deepEqual(settings, baseline, 'inventory must not mutate settings');
assert.ok(collectWardrobeCleanupOwners(settings, metadata).some(owner => owner.kind === 'legacy'));
assert.equal(wardrobeCleanupEntries(settings, metadata, { kind: 'bot' }, types).length, 5);
assert.equal(wardrobeCleanupEntries(settings, metadata, { kind: 'user' }, types).length, 3);
assert.equal(wardrobeCleanupEntries(settings, metadata, { kind: 'legacy' }, types).length, 1);
assert.equal(wardrobeCleanupEntries(settings, metadata, { category: 'other' }, types)[0].outfit.id, 'p1');
assert.equal(wardrobeCleanupEntries(settings, metadata, { search: 'ZACH' }, types).length, 2);
assert.equal(wardrobeCleanupEntries(settings, metadata, { ownerKey: 'character:Ethan' }, types).length, 2);

// IDs may collide between owners. Deleting one must not delete the other's copy.
let journal = deleteWardrobeSelection(settings, new Set([wardrobeEntryKey('character:Ethan', 'same')]));
assert.equal(journal.removed.length, 0, 'active protection is also enforced in the storage layer');
journal = deleteWardrobeSelection(settings, new Set([wardrobeEntryKey('character:Ethan', 'same')]), { protectActive: false });
assert.equal(journal.removed.length, 1);
assert.equal(settings.wardrobes.Other.bot[0].id, 'same');
assert.equal(settings.activeOutfits.Ethan.bot, null);
assert.equal(settings.activeOutfits.Other.bot, 'same');
assert.equal(undoWardrobeDeletion(settings, journal), 1);
assert.deepEqual(settings, baseline, 'undo restores order, active pointers and only newly-added markers');

// Shared deletion tombstones the imported source, not the shared copy ID.
journal = deleteWardrobeSelection(settings, new Set([wardrobeEntryKey('shared:bot', 's1')]), { protectActive: false });
assert.equal(settings.sharedBotActive, null);
assert.equal(settings.sharedBotActiveByChat.a, null);
assert.equal(settings.sharedBotActiveByChat.b, 's2');
assert.ok(settings.sharedDeletedSourceIds.bot.includes('b2'));
assert.equal(settings.sharedDeletedSourceIds.bot.includes('s1'), false);
assert.equal(settings.wardrobes.Ethan.bot.length, 2, 'originals remain unless selected');
const persisted = JSON.parse(JSON.stringify(settings));
assert.ok(persisted.sharedDeletedSourceIds.bot.includes('b2'), 'markers survive persistence');
assert.equal(undoWardrobeDeletion(settings, journal), 1);
assert.deepEqual(settings, baseline);

// Delete every bucket: all corresponding equipped pointers must be cleared.
journal = deleteWardrobeSelection(settings, new Set(all.map(entry => entry.key)), { protectActive: false });
assert.equal(journal.removed.length, 9);
assert.equal(wardrobeCleanupEntries(settings, metadata, {}, types).length, 0);
assert.equal(settings.personaActiveOutfits['persona:z.png'], null);
assert.equal(settings.sharedUserActiveByPersona['persona:z.png'], null);
assert.equal(settings.sharedUserActiveByChat.a, null);
assert.equal(settings.activeOutfits.Ethan.user, null);
assert.equal(settings.sharedBotActiveByChat.b, null);
assert.equal(undoWardrobeDeletion(settings, journal), 9);
assert.deepEqual(settings, baseline);
assert.equal(undoWardrobeDeletion(settings, journal), 0, 'undo is idempotent');

// Undo must not replace an outfit equipped after the deletion.
journal = deleteWardrobeSelection(settings, new Set([wardrobeEntryKey('character:Ethan', 'same')]), { protectActive: false });
settings.activeOutfits.Ethan.bot = 'b2';
undoWardrobeDeletion(settings, journal);
assert.equal(settings.activeOutfits.Ethan.bot, 'b2');

// Load the real shared-sync collector and test reload/resurrection and an await race.
const source = await fs.readFile(new URL('../src/wardrobe.js', import.meta.url), 'utf8');
let live = makeSettings();
const context = vm.createContext({ structuredClone, console, setTimeout, clearTimeout,
    SillyTavern: { getContext: () => ({ extensionSettings: { silly_wardrobe: live },
        saveSettingsDebounced() {}, characterId: 0, characters: [{ name: 'Ethan' }],
        name1: 'Zach', powerUserSettings: { personas: metadata.personas }, chatMetadata: {} }) },
});
const module = new vm.SourceTextModule(source + `
export { swCollectPendingOutfits, swMigrateToSharedUnlocked };
export function mockCompression(fn) {
    swCompressBase64Image = fn;
    swSaveRefImageToFile = async () => '/mock-image.png';
    swPreloadSharedActive = async () => {};
}`, { context });
await module.link(specifier => {
    const names = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)]
        .find(match => match[2] === specifier)[1].split(',').map(name => name.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    return new vm.SyntheticModule(names, function () {
        for (const name of names) this.setExport(name, name === 'iigLog' ? () => {} : undefined);
    }, { context });
});
await module.evaluate();
deleteWardrobeSelection(live, new Set([wardrobeEntryKey('shared:bot', 's1')]), { protectActive: false });
live = JSON.parse(JSON.stringify(live));
assert.equal(module.namespace.swCollectPendingOutfits('bot').some(item => item.id === 'b2'), false);
// Pause import before storing its base64, then delete that source.
live = makeSettings();
live.sharedBotWardrobe = [];
live.wardrobes = { Ethan: { bot: [{ ...outfit('race'), base64: 'mock' }], user: [] } };
let resolveCompression;
module.namespace.mockCompression(() => new Promise(resolve => { resolveCompression = resolve; }));
const importing = module.namespace.swMigrateToSharedUnlocked('bot', { silent: true });
assert.ok(resolveCompression);
deleteWardrobeSelection(live, new Set([wardrobeEntryKey('character:Ethan', 'race')]), { protectActive: false });
resolveCompression('mock-compressed');
await importing;
assert.equal(live.sharedBotWardrobe.length, 0, 'in-flight import must not resurrect a deleted source');
console.log('PASS: inventory, filters, scoped IDs, protection, active pointers, undo, persistence and import race');
