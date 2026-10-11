/** Pure model rules shared by the extension and the SillyTavern image proxy. */
export function resolveNovelaiModel(settings) {
    return String(settings.novelaiModel === '__custom__'
        ? (settings.novelaiCustomModel || '')
        : (settings.novelaiModel || '')).trim();
}

export function getNovelaiModelCapabilities(model) {
    const id = String(model || '').trim().toLowerCase();
    const v5 = /^nai-diffusion-5(?:-|$)/.test(id);
    const medium = v5 && /-medium(?:-|$)/.test(id);
    const v45 = /^nai-diffusion-4-5(?:-|$)/.test(id);
    const v4 = /^nai-diffusion-4(?:-|$)/.test(id);
    return {
        v5,
        medium,
        structuredPrompt: v5 || v4,
        paramsVersion: v5 ? 4 : 3,
        fixedSteps: medium ? 14 : null,
        fixedSampler: medium ? 'k_euler_ancestral' : null,
        fixedScheduler: null,
        negativePrompt: !medium,
        cfgRescale: !medium,
        decrisper: !v5,
        varietyBoost: !v5,
        smea: !v5 && !v4,
        // Precise Reference is supported on V4.5, not V5 or V3/V4.
        // Unknown custom IDs retain the previous experimental behaviour.
        preciseReference: v45 || (Boolean(id) && !/^nai-diffusion-\d/.test(id)),
    };
}

export function clampNovelaiNumber(value, fallback, min, max) {
    if (value === '' || value == null) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/** Builds the actual upstream API request; never forwards arbitrary fields. */
export function buildNovelaiImageRequest(body, options = {}) {
    const model = String(body.model || 'nai-diffusion').trim();
    const caps = getNovelaiModelCapabilities(model);
    const prompt = String(body.prompt ?? '');
    const negative = caps.negativePrompt ? String(body.negative_prompt ?? '') : '';
    const sampler = caps.fixedSampler || body.sampler || 'k_euler_ancestral';
    const seed = Number(body.seed);
    const parameters = {
        params_version: caps.paramsVersion,
        width: clampNovelaiNumber(body.width, 512, 64, 4096),
        height: clampNovelaiNumber(body.height, 512, 64, 4096),
        scale: clampNovelaiNumber(body.scale, 9, 0, 30),
        seed: Number.isInteger(seed) && seed >= 0
            ? seed
            : Math.floor((options.random || Math.random)() * 9999999999),
        sampler,
        noise_schedule: body.scheduler || 'native',
        steps: caps.fixedSteps || Math.round(clampNovelaiNumber(body.steps, 28, 1, 50)),
        n_samples: 1,
        cfg_rescale: caps.cfgRescale ? clampNovelaiNumber(body.cfg_rescale, 0, 0, 1) : 0,
    };

    if (caps.negativePrompt) parameters.negative_prompt = negative;
    if (caps.structuredPrompt) {
        parameters.v4_prompt = {
            caption: { base_caption: prompt, char_captions: [] },
            use_coords: caps.v5,
            use_order: true,
        };
        // Medium cannot carry user UC. Empty structured UC is the compatible
        // wire form; the model's built-in UC is left to NovelAI's server.
        parameters.v4_negative_prompt = {
            caption: { base_caption: negative, char_captions: [] },
            legacy_uc: false,
        };
    }

    if (!caps.v5) {
        Object.assign(parameters, {
            prefer_brownian: true,
            ucPreset: 0,
            qualityToggle: false,
            add_original_image: false,
            controlnet_strength: 1,
            deliberate_euler_ancestral_bug: false,
            dynamic_thresholding: body.decrisper ?? false,
            legacy: false,
            legacy_v3_extend: false,
            sm: caps.smea && sampler !== 'ddim' ? Boolean(body.sm) : false,
            sm_dyn: caps.smea && sampler !== 'ddim' ? Boolean(body.sm_dyn) : false,
            uncond_scale: 1,
            skip_cfg_above_sigma: body.variety_boost && options.calculateSkipCfgAboveSigma
                ? options.calculateSkipCfgAboveSigma(parameters.width, parameters.height, model)
                : null,
            use_coords: false,
            characterPrompts: [],
            reference_image_multiple: [],
            reference_information_extracted_multiple: [],
            reference_strength_multiple: [],
        });
    }

    const images = caps.preciseReference && body.references_enabled === true
        && Array.isArray(body.reference_images)
        ? body.reference_images.filter(image => typeof image === 'string' && image).slice(0, 5)
        : [];
    if (images.length) {
        const type = ['character', 'style', 'character&style'].includes(body.reference_type)
            ? body.reference_type : 'character&style';
        parameters.director_reference_images = images;
        parameters.director_reference_descriptions = images.map(() => ({
            caption: { base_caption: type, char_captions: [] },
            legacy_uc: false,
        }));
        parameters.director_reference_information_extracted = images.map(() => 1);
        parameters.director_reference_strength_values = images.map(() =>
            clampNovelaiNumber(body.reference_strength, 1, -1, 1));
        parameters.director_reference_secondary_strength_values = images.map(() =>
            clampNovelaiNumber(body.reference_fidelity, 0.75, -1, 1));
    }

    return { action: 'generate', input: prompt, model, parameters };
}
