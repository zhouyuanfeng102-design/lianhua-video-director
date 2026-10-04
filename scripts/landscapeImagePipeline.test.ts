import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  buildImagePromptConverterSystemPrompt,
  IMAGE_PROMPT_NAMED_IDENTITY_CONTRACT,
  IMAGE_PROMPT_VISIBLE_CHARACTER_IDENTITY_CONTRACT,
  resolveImagePromptSelection,
  type ImagePromptFormat,
} from '../src/imagePromptRules';
import { IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT, LANDSCAPE_IMAGE_NEGATIVE_PROMPT } from '../src/imageLocationScope';
import {
  buildImageRegenerationTask,
  executeImageRegeneration,
  imageTaskNeedsLandscapeScopeRepair,
  resolveImageAssetRegenerationTask,
  resolveImageRegenerationSource,
} from '../src/imageRegeneration';
import {
  MOSE_JIANGHU_NSFW_IMAGE_CONVERTER_RULE,
  MOSE_JIANGHU_NSFW_IMAGE_PROMPT_RULE,
  MOSE_JIANGHU_PRIVATE_IMAGE_PROMPT_RULE,
} from '../src/nsfwPromptRules';
import { hasNsfwDetailSignal } from '../src/promptConstraints';
import { requestImagePromptConverter } from '../src/services/llm';
import type { ImageGenerationTask, ImageVariant, Project, ReferenceAsset, TextApiConfig } from '../src/types';

// Only synthetic text is used. The real converter/HTTP adapter receives a
// fake fetch response; no project files, image service or real API is read.
const textConfig: TextApiConfig = {
  enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://landscape-text.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-landscape-key', model: 'synthetic-landscape-converter',
  temperature: 0, maxTokens: 4096, vision: false,
};
const identityContext = 'IDENTITY_CONTEXT_MUST_STAY_OUT：人物星岚来自《云港纪事》，当前剧情另有三位人物。';
const mixedSource = '地点：青石回廊。空间：两排石柱、磨砂地砖、东侧窗户、暖色吊灯。连续性备注：星岚曾在这里等候。NSFW';
const naturalReply = 'An unoccupied stone corridor with two rows of pillars and matte floor tiles extends toward an eastern window under warm pendant lights.';
const tagReply = 'scenery, unoccupied environment, no humans, stone corridor, stone pillars, matte floor tiles, eastern window, warm pendant lights';
type TextCall = { system: string; user: string };
const calls: TextCall[] = [];
let replies: string[] = [];
let fetchAttempts = 0;
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: undefined });
globalThis.fetch = async (input, init) => {
  fetchAttempts += 1;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  assert.equal(url, textConfig.baseUrl, 'the test must never contact a live or image endpoint');
  assert.equal(init?.method, 'POST');
  assert.equal(typeof init?.body, 'string');
  const body = JSON.parse(init!.body as string) as {
    model: string; messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, textConfig.model);
  calls.push({
    system: body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'),
    user: body.messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n'),
  });
  assert.ok(replies.length, 'unexpected text retry or background request');
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: replies.shift() } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
after(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  assert.ok(fetchAttempts > 0, 'the real browser HTTP path must have been exercised');
});

const reset = (...modelReplies: string[]): void => {
  calls.length = 0;
  replies = [...modelReplies];
};
const rulesFor = (format: ImagePromptFormat, imageVariant: ImageVariant): string => {
  const selection = resolveImagePromptSelection({
    backend: format === 'nai-tags' ? 'novelai' : format === 'sd-tags' ? 'sd-webui' : 'openai',
    assetKind: 'location', imageVariant,
  });
  assert.equal(selection.ruleSet.format, format);
  return buildImagePromptConverterSystemPrompt(selection, '', imageVariant);
};
const assertLandscapeRequest = (call: TextCall): void => {
  assert.ok(call.system.includes(IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT));
  assert.match(call.system, /\[LANDSCAPE_ENVIRONMENT_V1\]/u);
  assert.ok(!call.system.includes(IMAGE_PROMPT_NAMED_IDENTITY_CONTRACT));
  assert.ok(!call.system.includes(IMAGE_PROMPT_VISIBLE_CHARACTER_IDENTITY_CONTRACT));
  for (const rule of [MOSE_JIANGHU_NSFW_IMAGE_PROMPT_RULE, MOSE_JIANGHU_NSFW_IMAGE_CONVERTER_RULE, MOSE_JIANGHU_PRIVATE_IMAGE_PROMPT_RULE]) {
    assert.ok(!call.system.includes(rule), 'a mixed location source must not activate a private or NSFW converter');
  }
  assert.ok(!call.user.includes(identityContext));
  assert.doesNotMatch(call.user, /独立身份来源资料/u);
  assert.ok(!call.system.includes(mixedSource), 'source notes are data rather than system instructions');
  assert.ok(call.user.includes(mixedSource), 'original spatial notes stay intact for semantic environment extraction');
};

for (const format of ['natural-language', 'sd-tags', 'nai-tags'] as const) {
  test(`landscape ${format} conversion excludes story identity and automatic NSFW routing`, async () => {
    assert.equal(hasNsfwDetailSignal(mixedSource), true, 'the fixture must actually exercise the old automatic routing condition');
    const expected = format === 'natural-language' ? naturalReply : tagReply;
    reset(expected);
    const converted = await requestImagePromptConverter(textConfig, 'location', mixedSource, format,
      rulesFor(format, 'landscape'), identityContext, 'landscape');
    assert.equal(converted, expected, 'the exact AI environment result reaches the caller without a local character prefix');
    assert.equal(calls.length, 1);
    assert.equal(replies.length, 0);
    assertLandscapeRequest(calls[0]);
    assert.doesNotMatch(converted, /星岚|云港纪事|BREAK|\|/u, 'environment-only tags do not acquire a character section');
  });
}

test('landscape format repair keeps environment scope and cannot reacquire excluded identity evidence', async () => {
  reset('neutral corridor | wrong delimiter for this backend', tagReply);
  const converted = await requestImagePromptConverter(textConfig, 'location', mixedSource, 'sd-tags',
    rulesFor('sd-tags', 'landscape'), identityContext, 'landscape');
  assert.equal(converted, tagReply);
  assert.equal(calls.length, 2, 'only the existing technical format repair is needed');
  assert.equal(replies.length, 0);
  calls.forEach(assertLandscapeRequest);
});

for (const variant of ['snapshot', 'first-frame'] as const) {
  test(`${variant} retains its authored character identity context`, async () => {
    const source = '青石回廊中的一个静止瞬间：星岚穿蓝色外套站在东侧窗前。';
    const expected = 'Xing Lan stands beside the eastern window of a stone corridor in a blue coat under warm pendant lights.';
    reset(expected);
    const converted = await requestImagePromptConverter(textConfig, 'location', source, 'natural-language',
      rulesFor('natural-language', variant), identityContext, variant);
    assert.equal(converted, expected);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].user.includes(identityContext));
    assert.match(calls[0].user, /独立身份来源资料/u);
    assert.ok(calls[0].system.includes(IMAGE_PROMPT_NAMED_IDENTITY_CONTRACT));
    assert.ok(calls[0].system.includes(IMAGE_PROMPT_VISIBLE_CHARACTER_IDENTITY_CONTRACT));
    assert.doesNotMatch(calls[0].system, /\[LANDSCAPE_ENVIRONMENT_V1\]/u);
  });
}

test('legacy calls without the optional variant keep their previous identity and source routing', async () => {
  reset(naturalReply);
  await requestImagePromptConverter(textConfig, 'location', mixedSource, 'natural-language',
    rulesFor('natural-language', 'snapshot'), identityContext);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].user.includes(identityContext));
  assert.ok(calls[0].system.includes(MOSE_JIANGHU_NSFW_IMAGE_PROMPT_RULE));
  assert.ok(calls[0].system.includes(MOSE_JIANGHU_NSFW_IMAGE_CONVERTER_RULE));
  assert.doesNotMatch(calls[0].system, /\[LANDSCAPE_ENVIRONMENT_V1\]/u);
});

const legacyTask = (overrides: Partial<ImageGenerationTask> = {}): ImageGenerationTask => ({
  id: 'original-landscape', kind: 'image', name: '旧回廊风景', assetKind: 'location', imageVariant: 'landscape',
  status: 'succeeded', backend: 'openai', model: 'frozen-landscape-model', sourceEntityId: 'corridor',
  prompt: 'OLD_POLLUTED_FINAL_PROMPT: Xing Lan stands beside the stone pillars in a blue coat.',
  conversionSource: 'ORIGINAL_FROZEN_CORRIDOR：石柱、暖色吊灯，星岚曾在这里等候。',
  conversionIdentityContext: identityContext, converterSystemPrompt: '旧规则：场景资料中的人物可以出镜。',
  imagePromptFormat: 'natural-language', imagePromptRuleSetId: 'image-rule-openai-gpt-image',
  imagePromptPresetId: 'image-preset-location', negativePrompt: 'CUSTOM_NO_OVEREXPOSURE',
  width: 1536, height: 864, sizeOverride: true, referenceAssetIds: ['reference-b', 'reference-a'],
  primaryReferenceAssetIds: ['reference-a'],
  referenceAssetSnapshots: [{
    id: 'reference-a', name: '原回廊参考图', type: 'location', role: 'scene',
    relativePath: 'assets/original-corridor.png', checksum: 'a'.repeat(64), managed: true, mediaType: 'image',
    width: 1536, height: 864,
  }],
  imageApiSnapshot: {
    version: 1, profileId: 'original-image-profile', connectionFingerprint: 'frozen-connection-digest',
    executionFingerprint: 'frozen-execution-digest', config: { enabled: true, backend: 'openai', model: 'frozen-landscape-model' },
  },
  createdAt: 1, updatedAt: 2, ...overrides,
});
const projectFor = (task: ImageGenerationTask): Project => ({
  id: 'landscape-test-project', name: 'Synthetic landscape project', description: 'UNRELATED_NEW_PROJECT_DESCRIPTION',
  sourceDocuments: [{ id: 'unrelated-story', name: '新剧情', content: 'UNRELATED_NEW_STORY', createdAt: 3, updatedAt: 3 }],
  characters: [], locations: [{
    id: 'corridor', name: '已改成海滩', description: 'CURRENT_EDITED_LOCATION_MUST_STAY_OUT', timeWeather: '',
    lighting: '', palette: '', fixedProps: '', anchor: '', assetIds: ['new-current-reference'],
  }], props: [], scenes: [], storyboards: [], sequencePlans: [], assets: [], generationTasks: [task], createdAt: 1, updatedAt: 3,
});

for (const status of ['succeeded', 'failed'] as const) {
  test(`legacy ${status} landscape retry re-converts frozen facts before one image submission`, async () => {
    const original = legacyTask({ status });
    const project = projectFor(original);
    const originalBytes = JSON.stringify(original);
    const projectBytes = JSON.stringify(project);
    assert.equal(imageTaskNeedsLandscapeScopeRepair(original), true);
    const source = resolveImageRegenerationSource(original, project);
    assert.match(source.conversionSource, /ORIGINAL_FROZEN_CORRIDOR/u);
    assert.doesNotMatch(source.conversionSource, /OLD_POLLUTED_FINAL_PROMPT|CURRENT_EDITED_LOCATION|UNRELATED_NEW/u);
    assert.equal(source.conversionIdentityContext, '');
    assert.equal(source.converterSystemPrompt, '', 'old narrative converter instructions must be rebuilt');
    assert.deepEqual(source.referenceAssetIds, original.referenceAssetIds);
    assert.deepEqual(source.primaryReferenceAssetIds, original.primaryReferenceAssetIds);
    assert.deepEqual(source.referenceAssetSnapshots, original.referenceAssetSnapshots);
    // App rebuilds the selected system before enqueueing the new task. Even
    // though that new source is current, the old final prompt must be cleared.
    source.converterSystemPrompt = rulesFor('natural-language', 'landscape');
    const child = buildImageRegenerationTask(original, project, {
      id: `retry-${status}`, timestamp: 4, backend: original.backend, model: original.model, source,
    });
    assert.equal(child.prompt, '');
    assert.equal(child.status, 'queued');
    assert.equal(child.regenerationSourceTaskId, original.id);
    assert.deepEqual(child.imageApiSnapshot, original.imageApiSnapshot);
    assert.notStrictEqual(child.imageApiSnapshot, original.imageApiSnapshot);
    assert.notStrictEqual(child.imageApiSnapshot!.config, original.imageApiSnapshot!.config);
    assert.deepEqual([child.width, child.height, child.sizeOverride, child.backend, child.model],
      [1536, 864, true, original.backend, original.model]);
    assert.deepEqual(child.referenceAssetIds, original.referenceAssetIds);
    assert.deepEqual(child.primaryReferenceAssetIds, original.primaryReferenceAssetIds);
    assert.deepEqual(child.referenceAssetSnapshots, original.referenceAssetSnapshots);
    assert.equal(child.conversionIdentityContext, '');
    assert.ok(child.negativePrompt?.includes('CUSTOM_NO_OVEREXPOSURE'));
    assert.ok(child.negativePrompt?.includes(LANDSCAPE_IMAGE_NEGATIVE_PROMPT));
    const events: string[] = [];
    const references = ['data:image/png;base64,QQ==', 'data:image/png;base64,Qg=='];
    reset(naturalReply);
    const result = await executeImageRegeneration(child, {
      referenceImages: references, primaryReferenceImageCount: 1,
      convertPrompt: async () => {
        events.push('convert');
        return requestImagePromptConverter(textConfig, 'location', child.conversionSource!, 'natural-language',
          child.converterSystemPrompt!, child.conversionIdentityContext, child.imageVariant);
      },
      persistPrompt: async (prompt) => {
        events.push('persist');
        assert.equal(prompt, naturalReply);
      },
      generateImage: async (input) => {
        events.push('image');
        assert.equal(input.prompt, naturalReply);
        assert.doesNotMatch(input.prompt, /OLD_POLLUTED_FINAL_PROMPT|Xing Lan/u);
        assert.deepEqual([input.width, input.height, input.sizeOverride], [1536, 864, true]);
        assert.deepEqual(input.referenceImages, references);
        assert.notStrictEqual(input.referenceImages, references);
        assert.equal(input.primaryReferenceImageCount, 1);
        assert.equal(input.negativePrompt, child.negativePrompt);
        return 'synthetic-generated-image';
      },
    });
    assert.deepEqual(events, ['convert', 'persist', 'image']);
    assert.deepEqual(result, { finalPrompt: naturalReply, generated: 'synthetic-generated-image' });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].system.includes(IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT));
    assert.ok(!calls[0].user.includes(identityContext));
    assert.equal(JSON.stringify(original), originalBytes);
    assert.equal(JSON.stringify(project), projectBytes, 'retry cannot rewrite the source task or current location');
  });
}

test('execution itself cannot reuse a legacy landscape final prompt if the enqueue repair was missed', async () => {
  const original = legacyTask();
  const events: string[] = [];
  await executeImageRegeneration(original, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => { events.push('convert'); return naturalReply; },
    persistPrompt: (prompt) => { events.push('persist'); assert.equal(prompt, naturalReply); },
    generateImage: async ({ prompt }) => { events.push('image'); assert.equal(prompt, naturalReply); return 'image'; },
  });
  assert.deepEqual(events, ['convert', 'persist', 'image']);
});

test('legacy source fallback prefers the saved final prompt to an edited location and tolerates a deleted location', () => {
  const original = legacyTask({ conversionSource: undefined });
  const project = projectFor(original);
  const source = resolveImageRegenerationSource(original, project);
  assert.match(source.conversionSource, /OLD_POLLUTED_FINAL_PROMPT/u);
  assert.doesNotMatch(source.conversionSource, /CURRENT_EDITED_LOCATION|UNRELATED_NEW/u);
  assert.equal(source.conversionIdentityContext, '');
  assert.equal(source.converterSystemPrompt, '');
  assert.deepEqual(resolveImageRegenerationSource(original, { ...project, locations: [] }), source);
  const noSavedText = legacyTask({ conversionSource: undefined, prompt: '' });
  const recovered = resolveImageRegenerationSource(noSavedText, projectFor(noSavedText));
  assert.match(recovered.conversionSource, /CURRENT_EDITED_LOCATION_MUST_STAY_OUT/u,
    'live entity recovery is allowed only when no original source or final prompt exists');
  assert.equal(recovered.conversionIdentityContext, '');
  assert.throws(() => resolveImageRegenerationSource(noSavedText, { ...projectFor(noSavedText), locations: [] }), /无法恢复风景场景资料/u);
});

test('current-contract landscape retry reuses its final prompt and preserves custom negatives once', async () => {
  const original = legacyTask({
    prompt: naturalReply, converterSystemPrompt: rulesFor('natural-language', 'landscape'),
    conversionSource: 'FROZEN_EMPTY_CORRIDOR', conversionIdentityContext: '',
    negativePrompt: `CUSTOM_NO_OVEREXPOSURE, ${LANDSCAPE_IMAGE_NEGATIVE_PROMPT}`,
  });
  const before = JSON.stringify(original);
  assert.equal(imageTaskNeedsLandscapeScopeRepair(original), false);
  const project = projectFor(original);
  const source = resolveImageRegenerationSource(original, project);
  assert.equal(source.conversionSource, original.conversionSource);
  assert.equal(source.converterSystemPrompt, original.converterSystemPrompt);
  const child = buildImageRegenerationTask(original, project, {
    id: 'current-contract-retry', timestamp: 4, backend: original.backend, model: original.model, source,
  });
  assert.equal(child.prompt, naturalReply);
  assert.equal(child.negativePrompt, original.negativePrompt);
  let generated = 0;
  await executeImageRegeneration(child, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => assert.fail('current environment prompt must not incur another conversion'),
    persistPrompt: () => assert.fail('a reused final prompt does not need another conversion write'),
    generateImage: async ({ prompt, negativePrompt }) => {
      generated += 1;
      assert.equal(prompt, naturalReply);
      assert.equal(negativePrompt, original.negativePrompt);
      return 'image';
    },
  });
  assert.equal(generated, 1);
  assert.equal(JSON.stringify(original), before);
});

for (const variant of ['snapshot', 'first-frame'] as const) {
  test(`${variant} regeneration still reuses frozen people and does not read an edited location`, async () => {
    const original = legacyTask({ imageVariant: variant });
    assert.equal(imageTaskNeedsLandscapeScopeRepair(original), false);
    const project = projectFor(original);
    const source = resolveImageRegenerationSource(original, project);
    assert.equal(source.conversionSource, original.conversionSource);
    assert.equal(source.conversionIdentityContext, identityContext);
    assert.equal(source.converterSystemPrompt, original.converterSystemPrompt);
    const child = buildImageRegenerationTask(original, project, {
      id: `${variant}-retry`, timestamp: 4, backend: original.backend, model: original.model, source,
    });
    assert.equal(child.prompt, original.prompt);
    await executeImageRegeneration(child, {
      referenceImages: [], primaryReferenceImageCount: 0,
      convertPrompt: async () => assert.fail('narrative image reuse is outside the landscape repair'),
      persistPrompt: () => assert.fail('the original narrative final prompt is already saved'),
      generateImage: async ({ prompt }) => { assert.equal(prompt, original.prompt); return 'image'; },
    });
  });
}

test('repair detection requires the whole current contract and the exact location/landscape scope', () => {
  assert.equal(imageTaskNeedsLandscapeScopeRepair(legacyTask({ converterSystemPrompt: '[LANDSCAPE_ENVIRONMENT_V1]' })), true,
    'a marker mention alone is not a completed environment conversion contract');
  assert.equal(imageTaskNeedsLandscapeScopeRepair(legacyTask({ assetKind: 'character' })), false);
  assert.equal(imageTaskNeedsLandscapeScopeRepair(legacyTask({ assetKind: 'storyboard' })), false);
  assert.equal(imageTaskNeedsLandscapeScopeRepair(legacyTask({ imageVariant: 'snapshot' })), false);
  assert.equal(imageTaskNeedsLandscapeScopeRepair(legacyTask({ converterSystemPrompt: IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT })), false);
});

test('failed landscape conversion or persistence never submits an image', async () => {
  let generated = 0;
  let persisted = 0;
  const original = legacyTask();
  await assert.rejects(executeImageRegeneration(original, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => { throw new Error('synthetic-conversion-failure'); },
    persistPrompt: () => { persisted += 1; },
    generateImage: async () => { generated += 1; return 'image'; },
  }), /synthetic-conversion-failure/u);
  assert.equal(persisted, 0);
  assert.equal(generated, 0);
  await assert.rejects(executeImageRegeneration(original, {
    referenceImages: [], primaryReferenceImageCount: 0,
    convertPrompt: async () => naturalReply,
    persistPrompt: () => { persisted += 1; throw new Error('synthetic-persistence-failure'); },
    generateImage: async () => { generated += 1; return 'image'; },
  }), /synthetic-persistence-failure/u);
  assert.equal(persisted, 1);
  assert.equal(generated, 0);
});

test('an asset whose original task was deleted repairs its saved prompt and retains custom negatives and request size', async () => {
  for (const negativePrompt of ['CUSTOM_ASSET_NEGATIVE', `CUSTOM_ASSET_NEGATIVE, ${LANDSCAPE_IMAGE_NEGATIVE_PROMPT}`]) {
    const asset: ReferenceAsset = {
      id: 'orphaned-landscape-asset', name: '旧风景成图', type: 'location', role: 'scene',
      dataUrl: 'data:image/png;base64,QQ==', tags: [], source: 'generated',
      sourceEntityId: 'corridor', sourceEntityKind: 'location', imageVariant: 'landscape', imageBackend: 'openai',
      prompt: 'ORPHANED_OLD_PROMPT: Xing Lan waits beside a stone pillar.', negativePrompt,
      width: 2048, height: 2048, imageRequestSize: { width: 1536, height: 864, sizeOverride: true },
      createdAt: 1, updatedAt: 2,
    };
    const project: Project = { ...projectFor(legacyTask()), generationTasks: [], assets: [asset] };
    const before = JSON.stringify(project);
    const task = resolveImageAssetRegenerationTask(asset, project, {
      enabled: true, backend: 'openai', model: 'synthetic-asset-retry-model', baseUrl: '', apiKey: '',
    });
    assert.ok(task);
    assert.equal(imageTaskNeedsLandscapeScopeRepair(task), true);
    assert.equal(task.prompt, asset.prompt);
    assert.deepEqual([task.width, task.height, task.sizeOverride], [1536, 864, true],
      'saved requested size takes precedence over returned image pixel dimensions');
    assert.equal(task.negativePrompt, `CUSTOM_ASSET_NEGATIVE, ${LANDSCAPE_IMAGE_NEGATIVE_PROMPT}`);
    const source = resolveImageRegenerationSource(task, project);
    assert.match(source.conversionSource, /ORPHANED_OLD_PROMPT/u);
    assert.doesNotMatch(source.conversionSource, /CURRENT_EDITED_LOCATION|UNRELATED_NEW/u);
    assert.equal(source.conversionIdentityContext, '');
    source.converterSystemPrompt = rulesFor('natural-language', 'landscape');
    const child = buildImageRegenerationTask(task, project, {
      id: 'orphaned-landscape-retry', timestamp: 5, backend: task.backend, model: task.model, source,
    });
    assert.equal(child.prompt, '');
    assert.equal(child.negativePrompt, task.negativePrompt, 'construction must not append the same environment negative twice');
    const events: string[] = [];
    await executeImageRegeneration(child, {
      referenceImages: [], primaryReferenceImageCount: 0,
      convertPrompt: async () => { events.push('convert'); return naturalReply; },
      persistPrompt: (prompt) => { events.push('persist'); assert.equal(prompt, naturalReply); },
      generateImage: async (input) => {
        events.push('image');
        assert.equal(input.prompt, naturalReply);
        assert.equal(input.negativePrompt, task.negativePrompt);
        assert.equal(input.negativePrompt?.split(LANDSCAPE_IMAGE_NEGATIVE_PROMPT).length, 2);
        assert.deepEqual([input.width, input.height, input.sizeOverride], [1536, 864, true]);
        return 'image';
      },
    });
    assert.deepEqual(events, ['convert', 'persist', 'image']);
    assert.equal(JSON.stringify(project), before, 'asset repair must preserve the original asset and project records');
  }
});

test('orphaned story-snapshot and prop assets keep their existing prompt and negative behavior', () => {
  const variants: Array<Pick<ReferenceAsset, 'type' | 'role' | 'sourceEntityKind' | 'imageVariant'>> = [
    { type: 'location', role: 'scene', sourceEntityKind: 'location', imageVariant: 'snapshot' },
    { type: 'prop', role: 'prop', sourceEntityKind: 'prop', imageVariant: 'showcase' },
  ];
  for (const variant of variants) {
    const asset: ReferenceAsset = {
      id: 'orphaned-other-asset', name: '原素材', dataUrl: 'data:image/png;base64,QQ==', tags: [],
      prompt: 'Original final prompt with authored scene content.', negativePrompt: 'CUSTOM_NON_LANDSCAPE_NEGATIVE',
      width: 1200, height: 800, createdAt: 1, updatedAt: 2, ...variant,
    };
    const project: Project = { ...projectFor(legacyTask()), generationTasks: [], assets: [asset] };
    const task = resolveImageAssetRegenerationTask(asset, project, {
      enabled: true, backend: 'openai', model: 'synthetic-asset-retry-model', baseUrl: '', apiKey: '',
    });
    assert.ok(task);
    assert.equal(imageTaskNeedsLandscapeScopeRepair(task), false);
    assert.equal(task.prompt, asset.prompt);
    assert.equal(task.negativePrompt, asset.negativePrompt);
    assert.deepEqual([task.width, task.height], [1200, 800]);
  }
});
