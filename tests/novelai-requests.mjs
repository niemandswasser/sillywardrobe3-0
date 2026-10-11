// No network or real API key: exercise both client requests and proxy output.
// Run: node --experimental-vm-modules tests/novelai-requests.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { Buffer } from 'node:buffer';
import { buildNovelaiImageRequest, getNovelaiModelCapabilities } from '../src/providers/novelaiParams.js';
import { renderParameterHelp } from '../src/ui/parameterHelp.js';

const defaults = {
    novelaiModel: 'nai-diffusion-5-full', novelaiSampler: 'k_dpmpp_2m',
    novelaiScheduler: 'native', novelaiSteps: 42, novelaiScale: 7,
    novelaiCfgRescale: 0.65, novelaiSize: 'Portrait', novelaiNegativePrompt: 'USER UC',
    novelaiDecrisper: true, novelaiVarietyBoost: true, novelaiSm: true,
    novelaiSmDyn: true, novelaiAnlasGuard: false, novelaiEnableReferences: true,
    sendCharAvatar: true, sendUserAvatar: true, imageContextEnabled: true,
};
const forbiddenV5 = ['sm', 'sm_dyn', 'dynamic_thresholding', 'skip_cfg_above_sigma',
    'reference_image_multiple', 'reference_strength_multiple', 'director_reference_images',
    'director_reference_descriptions', 'controlnet_condition', 'image', 'mask'];

const source = await fs.readFile(new URL('../src/providers/novelai.js', import.meta.url), 'utf8');
const rulesSource = await fs.readFile(new URL('../src/providers/novelaiParams.js', import.meta.url), 'utf8');
const uiSource = await fs.readFile(new URL('../src/ui/apiSection.js', import.meta.url), 'utf8');
let globalSettings = defaults;
let referenceFetches = 0;
const requests = [];
const nodes = new Map();
const makeNode = () => ({
    value: '', checked: false, disabled: false, textContent: '',
    hiddenClasses: new Set(),
    closest() { return this; },
    get classList() { return { toggle: (name, enabled) => {
        if (enabled) this.hiddenClasses.add(name); else this.hiddenClasses.delete(name);
    } }; },
});
const context = vm.createContext({
    console, Math, Number, String, Array, Object, Promise,
    SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
    document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id); } },
});
const rules = new vm.SourceTextModule(rulesSource, { context });
await rules.link(() => { throw new Error('pure rules have imports'); });
await rules.evaluate();
const stubs = {
    getSettings: () => globalSettings,
    renderParameterHelp,
    sanitizeForHtml: value => String(value ?? ''),
    ensureConnectionProfiles: () => [],
    ensureNovelaiNegativePresets: () => [],
    getActiveNovelaiNegativePreset: () => null,
    NOVELAI_SAMPLERS: ['k_euler_ancestral'], NOVELAI_SCHEDULERS: ['native'], NOVELAI_SIZES: [],
    normalizeNaisteraVideoFrequency: value => value || 1,
    normalizeNaisteraModel: value => value || '',
    buildSettingsSectionHtml: (_id, _title, body) => body,
    iigLog: () => {}, MAX_GENERATION_REFERENCE_IMAGES: 5, NOVELAI_MODELS: [],
    normalizeImageContextCount: value => value,
    getEffectiveRefInstruction: () => 'REFERENCE INSTRUCTION',
    resolveNovelaiSize: size => size === 'TestLarge'
        ? ({ width: 2048, height: 2048 }) : ({ width: 832, height: 1216 }),
    applyNovelaiPresets: value => value,
    buildFinalGenerationPrompt: (prompt, style, refs, settings, options) =>
        prompt + (options.includeReferencePromptBlocks ? '|REFERENCE TEXT|' : ''),
    collectPreviousContextReferences: async () => { referenceFetches++; return []; },
    collectAvatarReferences: async () => { referenceFetches++; return []; },
    collectExtraReferences: async () => { referenceFetches++; return []; },
    mergeAvatarReferenceGroups: groups => groups.flat(),
    imageUrlToBase64: async () => { referenceFetches++; return 'fake'; },
    normalizeStoredImagePath: path => path,
    fetchWithTimeout: async (url, options) => {
        requests.push(JSON.parse(options.body));
        return { ok: true, text: async () => 'FAKE_BASE64' };
    },
    Provider: class {}, ProviderError: class extends Error {},
    throwAsProviderError: error => { throw error; },
    t: (strings, ...values) => strings.reduce((text, part, i) => text + part + (values[i] ?? ''), ''),
};
async function loadWithStubs(code) {
    const module = new vm.SourceTextModule(code, { context });
    await module.link(async specifier => {
        if (specifier.endsWith('/novelaiParams.js')) return rules;
        const importMatch = [...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)]
            .find(match => match[2] === specifier);
        assert.ok(importMatch, `unhandled import ${specifier}`);
        const names = importMatch[1].split(',').map(name => name.trim()).filter(Boolean);
        return new vm.SyntheticModule(names, function () {
            for (const name of names) this.setExport(name, stubs[name]);
        }, { context });
    });
    await module.evaluate();
    return module;
}
const providerModule = await loadWithStubs(source);
const provider = new providerModule.namespace.NovelAIProvider();
const ui = await loadWithStubs(uiSource);
const snapshot = JSON.stringify(defaults);
const html = ui.namespace.buildApiSettingsSectionHtml(defaults);
assert.equal((html.match(/data-iig-param-help=/g) || []).length, 19);
assert.ok(html.includes('Prompt Guidance (CFG Scale)'));
assert.equal(JSON.stringify(defaults), snapshot, 'help must not mutate settings');

for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-5-full-medium',
    'nai-diffusion-4-5-full', 'nai-diffusion-4-full', 'nai-diffusion-3']) {
    const settings = { ...defaults, novelaiModel: model };
    const caps = getNovelaiModelCapabilities(model);
    referenceFetches = 0;
    const refs = await provider.collectReferences({ prompt: 'scene', matchedAdditionalRefs: [{ imagePath: 'ref.png' }],
        providerOptions: { providerSettings: settings } });
    if (!caps.preciseReference) { assert.equal(referenceFetches, 0); assert.equal(refs.length, 0); }
    await provider.generate({ prompt: 'scene', references: ['SHOULD_NOT_LEAK'], options: { providerSettings: settings } });
    const body = requests.at(-1);
    const request = buildNovelaiImageRequest(body, { random: () => 0.5, calculateSkipCfgAboveSigma: () => 58 });
    const p = request.parameters;
    assert.equal(request.model, model);
    assert.equal(p.scale, 7);
    assert.equal(p.width, 832);
    assert.equal(p.height, 1216);
    if (caps.v5) {
        assert.equal(p.params_version, 4);
        assert.equal(p.noise_schedule, 'native');
        assert.equal(request.input, 'scene');
        for (const field of forbiddenV5) assert.equal(Object.hasOwn(p, field), false, `${model}: ${field}`);
    }
    if (caps.medium) {
        assert.equal(p.steps, 14);
        assert.equal(p.sampler, 'k_euler_ancestral');
        assert.equal(p.cfg_rescale, 0);
        assert.equal(Object.hasOwn(body, 'negative_prompt'), false);
        assert.equal(Object.hasOwn(p, 'negative_prompt'), false);
        assert.equal(p.v4_negative_prompt.caption.base_caption, '');
    } else {
        assert.equal(p.steps, 42);
        assert.equal(p.negative_prompt, 'USER UC');
        assert.equal(p.cfg_rescale, 0.65);
    }
    if (caps.preciseReference) assert.equal(p.director_reference_images[0], 'SHOULD_NOT_LEAK');
    ui.namespace.syncNovelaiModelControls(settings);
    assert.equal(nodes.get('iig_novelai_steps').disabled, caps.medium);
    assert.equal(nodes.get('iig_novelai_scheduler').disabled, false);
    assert.equal(nodes.get('iig_novelai_scheduler').value, 'native');
    assert.equal(nodes.get('iig_novelai_steps').value, caps.medium ? '14' : '42');
    assert.equal(nodes.get('iig_novelai_cfg_rescale').disabled, caps.medium);
    assert.equal(nodes.get('iig_novelai_negative_presets').hiddenClasses.has('iig-hidden'), caps.medium);
    assert.equal(settings.novelaiSteps, 42, 'UI must preserve stored values');
}

// Both the selector and a custom ID must enforce Medium's constraints.
const custom = { ...defaults, novelaiModel: '__custom__', novelaiCustomModel: 'nai-diffusion-5-full-medium' };
await provider.generate({ prompt: 'custom', references: ['REF'], options: { providerSettings: custom } });
assert.equal(requests.at(-1).steps, 14);
for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-5-full-medium',
    'nai-diffusion-4-5-full', 'nai-diffusion-4-full', 'nai-diffusion-3']) {
    const p = buildNovelaiImageRequest({ model, prompt: 'defaults' }).parameters;
    assert.equal(p.sampler, 'k_euler_ancestral');
    assert.equal(p.noise_schedule, 'native');
}
assert.equal(requests.at(-1).sampler, 'k_euler_ancestral');
ui.namespace.syncNovelaiModelControls(custom);
assert.equal(nodes.get('iig_novelai_steps').value, '14');
ui.namespace.syncNovelaiModelControls({ ...defaults, novelaiModel: 'nai-diffusion-5-full' });
assert.equal(nodes.get('iig_novelai_steps').value, '42');

const guarded = { ...defaults, novelaiAnlasGuard: true };
await provider.generate({ prompt: 'guard', options: { providerSettings: guarded } });
assert.equal(requests.at(-1).steps, 28);
await provider.generate({ prompt: 'guard', options: { providerSettings: { ...guarded, novelaiModel: 'nai-diffusion-5-full-medium' } } });
assert.equal(requests.at(-1).steps, 14);
const large = { ...guarded, novelaiSize: 'TestLarge' };
await provider.generate({ prompt: 'large guard', options: { providerSettings: large } });
assert.ok(requests.at(-1).width * requests.at(-1).height <= 1024 * 1024);
assert.equal(requests.at(-1).width % 64, 0);
assert.equal(requests.at(-1).height % 64, 0);
await provider.generate({ prompt: 'unguarded large', options: { providerSettings: { ...large, novelaiAnlasGuard: false } } });
assert.equal(requests.at(-1).width, 2048);
assert.equal(requests.at(-1).height, 2048);
assert.equal(requests.at(-1).steps, 42);
await provider.generate({ prompt: 'no refs', references: ['REF'], options: { providerSettings: {
    ...defaults, novelaiModel: 'nai-diffusion-4-5-full', novelaiEnableReferences: false,
} } });
assert.equal(Object.hasOwn(requests.at(-1), 'reference_images'), false);
assert.equal(requests.at(-1).prompt, 'no refs');

// API enforcement must survive clients that still submit all old fields.
const contaminated = { prompt: 'scene', model: 'nai-diffusion-5-full-medium', steps: 50,
    sampler: 'ddim', scheduler: 'native', cfg_rescale: 0.8, negative_prompt: 'USER UC',
    decrisper: true, variety_boost: true, sm: true, sm_dyn: true,
    references_enabled: true, reference_images: ['REF'], seed: 123 };
const cleaned = buildNovelaiImageRequest(contaminated).parameters;
assert.equal(cleaned.steps, 14);
assert.equal(cleaned.seed, 123);
assert.equal(cleaned.v4_negative_prompt.caption.base_caption, '');
for (const field of forbiddenV5) assert.equal(Object.hasOwn(cleaned, field), false);

// Exercise the real staged Express route with a mocked upstream fetch.
const routes = new Map();
let upstream;
const serverContext = vm.createContext({ console: { debug() {}, warn() {}, error() {}, info() {} }, Buffer, Math });
const serverRules = new vm.SourceTextModule(rulesSource, { context: serverContext });
await serverRules.link(() => { throw new Error('unexpected import'); });
await serverRules.evaluate();
const server = new vm.SourceTextModule(await fs.readFile(new URL('../server-patch/novelai.js', import.meta.url), 'utf8'), { context: serverContext });
const serverExports = {
    'node:util': { default: {} }, 'node:buffer': { Buffer },
    'node-fetch': { default: async (url, options) => { upstream = JSON.parse(options.body); return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; } },
    express: { default: { Router: () => ({ post: (path, fn) => routes.set(path, fn) }) } },
    './secrets.js': { readSecret: () => 'fake-key', SECRET_KEYS: { NOVEL: 'novel' } },
    '../util.js': { readAllChunks() {}, forwardFetchResponse() {}, extractFileFromZipBuffer: async () => Buffer.from('fake-png') },
};
await server.link(specifier => {
    if (specifier === './novelai-image-params.js') return serverRules;
    const exports = serverExports[specifier];
    assert.ok(exports, `server import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context: serverContext });
});
await server.evaluate();
let sent;
await routes.get('/generate-image')({ body: contaminated, user: { directories: {} } }, {
    send: value => { sent = value; }, sendStatus: code => { throw new Error(`route failed: ${code}`); },
});
assert.equal(sent, Buffer.from('fake-png').toString('base64'));
assert.equal(upstream.model, contaminated.model);
assert.equal(upstream.parameters.params_version, 4);
assert.equal(upstream.parameters.steps, 14);
for (const field of forbiddenV5) assert.equal(Object.hasOwn(upstream.parameters, field), false);
console.log('PASS: model matrix, client requests, reference isolation, UI switching and real proxy route');
