// Read-only inventory and scoped batch edits. Never delete image files here.
const list = value => Array.isArray(value) ? value : [];
const id = value => value == null ? '' : String(value);
export const wardrobeEntryKey = (ownerKey, outfitId) => JSON.stringify([ownerKey, id(outfitId)]);

export function collectWardrobeCleanupOwners(settings, metadata = {}) {
    const owners = [];
    const add = (key, kind, side, name, path, activePaths) => {
        const outfits = path.reduce((value, key) => value?.[key], settings);
        const active = new Set();
        for (const path of activePaths) {
            const value = path.reduce((value, key) => value?.[key], settings);
            if (value && typeof value === 'object') {
                for (const v of Object.values(value)) if (id(v)) active.add(id(v));
            } else if (id(value)) active.add(id(value));
        }
        owners.push({ key, kind, side, name, path, activePaths, outfits: list(outfits), active });
    };
    add('shared:bot', 'shared', 'bot', 'Общий для ботов', ['sharedBotWardrobe'],
        [['sharedBotActive'], ['sharedBotActiveByChat']]);
    add('shared:user', 'shared', 'user', 'Общий для персон', ['sharedUserWardrobe'],
        [['sharedUserActive'], ['sharedUserActiveByChat'], ['sharedUserActiveByPersona']]);
    for (const [name, wardrobe] of Object.entries(settings.wardrobes || {})) {
        if (!wardrobe) continue;
        add(`character:${name}`, 'character', 'bot', `Бот — ${name}`, ['wardrobes', name, 'bot'],
            [['activeOutfits', name, 'bot']]);
        add(`legacy:${name}`, 'legacy', 'user', `Старый гардероб юзера — ${name}`, ['wardrobes', name, 'user'],
            [['activeOutfits', name, 'user']]);
    }
    for (const key of Object.keys(settings.personaWardrobes || {})) {
        const avatar = key.replace(/^persona:/, '');
        const fallback = avatar.startsWith('name:') ? avatar.slice(5) : avatar.replace(/\.[^.]+$/, '');
        const name = metadata.personas?.[avatar] || fallback || 'Без имени';
        add(key, 'persona', 'user', `Персона — ${name}`, ['personaWardrobes', key],
            [['personaActiveOutfits', key]]);
    }
    return owners.sort((a, b) => a.name.localeCompare(b.name));
}

export function wardrobeCleanupEntries(settings, metadata, filters = {}, types = []) {
    const knownTypes = new Set(types.map(type => type.id));
    const query = String(filters.search || '').trim().toLocaleLowerCase();
    const entries = [];
    for (const owner of collectWardrobeCleanupOwners(settings, metadata)) {
        if (filters.ownerKey && owner.key !== filters.ownerKey) continue;
        if (filters.kind === 'bot' && owner.side !== 'bot') continue;
        if (filters.kind === 'user' && !['persona', 'shared'].includes(owner.kind)) continue;
        if (filters.kind === 'user' && owner.side !== 'user') continue;
        if (filters.kind === 'shared' && owner.kind !== 'shared') continue;
        if (filters.kind === 'legacy' && owner.kind !== 'legacy') continue;
        for (const outfit of owner.outfits) {
            if (!id(outfit?.id)) continue;
            const category = knownTypes.has(outfit.type) ? outfit.type : 'other';
            if (filters.category && category !== filters.category) continue;
            const typeLabel = types.find(type => type.id === category)?.label || category;
            if (query && !`${outfit.name || ''} ${outfit.description || ''} ${owner.name} ${typeLabel}`
                .toLocaleLowerCase().includes(query)) continue;
            entries.push({ key: wardrobeEntryKey(owner.key, outfit.id), owner, outfit, category,
                active: owner.active.has(id(outfit.id)) });
        }
    }
    // Newer outfits first within each owner; no mutation of the saved arrays.
    return entries.sort((a, b) => a.owner.name.localeCompare(b.owner.name)
        || (Number(b.outfit.addedAt) || 0) - (Number(a.outfit.addedAt) || 0));
}

function atPath(settings, path) {
    return path.reduce((value, key) => value?.[key], settings);
}

export function deleteWardrobeSelection(settings, selection, { protectActive = true } = {}) {
    const journal = { removed: [], activeChanges: [], tombstonesAdded: [] };
    const added = { bot: new Set(), user: new Set() };
    for (const owner of collectWardrobeCleanupOwners(settings)) {
        const removedIds = new Set();
        const keep = [];
        owner.outfits.forEach((outfit, index) => {
            const key = wardrobeEntryKey(owner.key, outfit?.id);
            if (!id(outfit?.id) || !selection.has(key) || (protectActive && owner.active.has(id(outfit.id)))) {
                keep.push(outfit);
                return;
            }
            journal.removed.push({ ownerKey: owner.key, side: owner.side, index, outfit });
            removedIds.add(id(outfit.id));
            // Shared imports must not resurrect from a retained original.
            // Personal deletions also block an already-running shared import.
            const sourceId = owner.kind === 'shared' ? id(outfit.srcId) : id(outfit.id);
            if (sourceId) added[owner.side].add(sourceId);
        });
        if (!removedIds.size) continue;
        owner.outfits.splice(0, owner.outfits.length, ...keep);
        for (const path of owner.activePaths) {
            const value = atPath(settings, path);
            const targets = value && typeof value === 'object'
                ? Object.keys(value).map(key => [...path, key]) : [path];
            for (const target of targets) {
                const old = atPath(settings, target);
                if (!removedIds.has(id(old))) continue;
                journal.activeChanges.push({ ownerKey: owner.key, path: target, value: old });
                const parent = atPath(settings, target.slice(0, -1));
                parent[target.at(-1)] = null;
            }
        }
    }
    if (journal.removed.length) {
        settings.sharedDeletedSourceIds ||= { bot: [], user: [] };
        for (const side of ['bot', 'user']) {
            const previous = list(settings.sharedDeletedSourceIds[side]);
            const known = new Set(previous.map(id));
            for (const value of added[side]) {
                if (known.has(value)) continue;
                previous.push(value); known.add(value);
                journal.tombstonesAdded.push({ side, id: value });
            }
            settings.sharedDeletedSourceIds[side] = previous;
        }
    }
    return journal;
}

export function undoWardrobeDeletion(settings, journal) {
    if (!journal?.removed?.length) return 0;
    const owners = new Map(collectWardrobeCleanupOwners(settings).map(owner => [owner.key, owner]));
    const restored = [];
    for (const record of journal.removed) {
        const owner = owners.get(record.ownerKey);
        if (!owner || owner.outfits.some(outfit => id(outfit?.id) === id(record.outfit.id))) continue;
        owner.outfits.splice(Math.min(record.index, owner.outfits.length), 0, record.outfit);
        restored.push(record);
    }
    for (const change of journal.activeChanges) {
        if (!restored.some(record => record.ownerKey === change.ownerKey && id(record.outfit.id) === id(change.value))) continue;
        const parent = atPath(settings, change.path.slice(0, -1));
        const key = change.path.at(-1);
        // Do not override a different outfit chosen since the deletion.
        if (parent && parent[key] == null) parent[key] = change.value;
    }
    for (const marker of journal.tombstonesAdded) {
        if (!restored.some(record => record.side === marker.side
            && (id(record.outfit.id) === marker.id || id(record.outfit.srcId) === marker.id))) continue;
        const markers = list(settings.sharedDeletedSourceIds?.[marker.side]);
        const index = markers.indexOf(marker.id);
        if (index >= 0) markers.splice(index, 1);
    }
    journal.removed = journal.removed.filter(record => !restored.includes(record));
    return restored.length;
}
