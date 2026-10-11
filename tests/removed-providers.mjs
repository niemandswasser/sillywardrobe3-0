// Offline migration regression: do not send retired-service keys to another provider.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const code = await fs.readFile(new URL('../src/settings.js', import.meta.url), 'utf8');
const context = vm.createContext({ console: { log() {} }, structuredClone });
const module = new vm.SourceTextModule(code, { context });
await module.link(() => new vm.SyntheticModule(['t'], function () {
    this.setExport('t', (parts, ...values) => parts.reduce((out, part, i) => out + part + (values[i] ?? ''), ''));
}, { context }));
await module.evaluate();
const { migrateRemovedProviders, defaultSettings, CONNECTION_FIELDS } = module.namespace;
const make = () => ({ ...structuredClone(defaultSettings), apiType: 'wellflow',
    endpoint: 'https://api.wellflow.dev', apiKey: 'wf_FAKE_ONLY', model: 'nano-banana-2',
    wellflowSize: '2048x2048', wellflowUseProxy: true, activeConnectionProfileId: 'removed',
    connectionProfiles: [
        { id: 'removed', apiType: 'wellflow', apiKey: 'wf_FAKE_ONLY' },
        { id: 'keep', name: 'NovelAI', apiType: 'novelai', model: '', endpoint: '', apiKey: '', novelaiScale: 6 },
        { id: 'old', apiType: 'aigate', apiKey: 'OLD_FAKE' },
        { id: 'other', apiType: 'gemini', model: 'nano-banana-2', apiKey: 'KEEP_FAKE' },
    ], extBlocksProfileBindings: { big: 'removed', medium: 'keep', small: 'old' },
    lorebooks: [{ id: 'book', refs: [{ imagePath: '/ref.png' }] }],
    characterLibrary: { user: { aliases: 'Zach' } },
});
let settings = make();
const refsBefore = JSON.stringify([settings.lorebooks, settings.characterLibrary]);
assert.equal(migrateRemovedProviders(settings), true);
assert.deepEqual(settings.connectionProfiles.map(profile => profile.id), ['keep', 'other']);
assert.equal(settings.apiType, 'novelai'); assert.equal(settings.novelaiScale, 6);
assert.equal(settings.apiKey, ''); assert.equal(settings.endpoint, '');
assert.equal(settings.activeConnectionProfileId, 'keep');
assert.equal(settings.extBlocksProfileBindings.big, ''); assert.equal(settings.extBlocksProfileBindings.small, '');
assert.equal(settings.extBlocksProfileBindings.medium, 'keep');
assert.equal('wellflowSize' in settings, false); assert.equal('wellflowUseProxy' in settings, false);
assert.equal(JSON.stringify([settings.lorebooks, settings.characterLibrary]), refsBefore);
assert.equal(settings.connectionProfiles[1].apiKey, 'KEEP_FAKE');
assert.equal(migrateRemovedProviders(settings), false);
settings = make(); settings.connectionProfiles = [];
assert.equal(migrateRemovedProviders(settings), true);
assert.equal(settings.apiType, 'openai'); assert.equal(settings.apiKey, '');
assert.equal(settings.endpoint, ''); assert.equal(settings.model, '');
assert.equal(migrateRemovedProviders(settings), false);
settings = make(); settings.apiType = 'gemini'; settings.apiKey = 'KEEP_ACTIVE'; settings.model = 'KEEP_MODEL';
settings.activeConnectionProfileId = 'other';
assert.equal(migrateRemovedProviders(settings), true);
assert.equal(settings.apiType, 'gemini'); assert.equal(settings.apiKey, 'KEEP_ACTIVE');
assert.equal(settings.model, 'KEEP_MODEL');
assert.equal(CONNECTION_FIELDS.includes('wellflowSize'), false);
assert.equal(CONNECTION_FIELDS.includes('wellflowUseProxy'), false);
for (const file of ['../src/providers.js', '../src/ui/apiSection.js', '../src/ui.js', '../index.js']) {
    assert.doesNotMatch(await fs.readFile(new URL(file, import.meta.url), 'utf8'), /WellFlowProvider|migrateAigateToWellflow|iig_wellflow|value="(?:wellflow|aigate)"/);
}
console.log('PASS: removed providers, safe fallback, profile routing cleanup, idempotence, reference preservation and UI removal');
