import assert from 'node:assert/strict';
import {
  assertDirectStoryboardImageApiSupport,
  buildDirectStoryboardImageBatchRequests,
  buildDirectStoryboardImageRequests,
  directStoryboardImageSourceFingerprint,
  normalizeStoryboardImageToImageSettings,
  resolveDirectStoryboardReferenceImages,
  resolveStoryboardImageToImageReferences,
} from '../src/storyboardImageToImage';
import type { DirectStoryboardImagePromptConversion } from '../src/storyboardImageToImage';
import type { StoryboardImageFramePlan } from '../src/storyboardImagePlan';
import type { Character, ImageApiConfig, ReferenceAsset, Storyboard, VideoShot } from '../src/types';

const shot = (index: number): VideoShot => ({
  id: `shot-${index}`, index, startSec: (index - 1) * 3, endSec: index * 3,
  purpose: '镜头目的不是画面文字', subject: `第${index}镜原主体`, action: `第${index}镜原动作`,
  camera: '原机位', transition: 'cut', lighting: '原光线', sound: '不应发送的音效',
  dialogue: '不应发送的旧台词', result: '原结果', referenceAssetIds: ['automatic'],
  prompt: '旧视频稿：不要直接把这整段发给生图', locked: false,
});
const board: Storyboard = {
  id: 'board-1', sceneId: 'scene-1', workflow: 'drama', inputMode: 'reference',
  durationSec: 12, durationPreset: 'custom', shotMode: 'exact', pace: 'standard',
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'cinematic',
  ruleSetId: 'h3', converterPresetId: 'h3', globalLock: '历史全局外貌',
  globalReferenceAssetIds: ['global-reference'], shots: [1, 2, 3, 4].map(shot),
  finalPrompt: '源稿', createdAt: 1, updatedAt: 1,
};
const image = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: `完整参考图名称 ${id}`, type: 'reference', role: 'character',
  dataUrl: `data:image/png;base64,${id === 'a' ? 'QUFB' : 'QkJC'}`,
  tags: [], createdAt: 1, updatedAt: 1, ...patch,
});
const assets = [image('a'), image('b'), image('automatic'), image('global-reference')];
const context = { assets, characters: [], locations: [], props: [], scenes: [], projectName: '直接图生图' };
const selection = { shotIds: ['shot-4', 'shot-2'], referenceAssetIdsByShotId: { 'shot-2': ['a'], 'shot-4': ['b', 'a'] } };

const settings = normalizeStoryboardImageToImageSettings({
  referenceAssetIds: [' draft ', 'draft', null], selectedShotIds: ['shot-2', 'missing', 'shot-2'],
  referenceAssetIdsByShotId: { 'shot-2': ['a', 'a'], 'shot-4': ['b'], missing: ['a'] },
}, board.shots.map((item) => item.id));
assert.deepEqual(settings, {
  referenceAssetIds: ['draft'], selectedShotIds: ['shot-2'],
  referenceAssetIdsByShotId: { 'shot-2': ['a'], 'shot-4': ['b'] },
});
assert.deepEqual(normalizeStoryboardImageToImageSettings(undefined), {
  referenceAssetIds: [], selectedShotIds: [], referenceAssetIdsByShotId: {},
});
assert.deepEqual(resolveStoryboardImageToImageReferences(settings, 'shot-1'), [], 'draft is not a global fallback');
const selectedCopies = resolveStoryboardImageToImageReferences(settings, 'shot-2');
selectedCopies.push('other');
assert.deepEqual(settings.referenceAssetIdsByShotId['shot-2'], ['a'], 'reference bindings are immutable copies');

const original = JSON.stringify(board);
const requests = buildDirectStoryboardImageRequests(board, selection, context);
assert.deepEqual(requests.map((item) => item.shotId), ['shot-2', 'shot-4']);
assert.deepEqual(requests.map((item) => item.referenceAssetIds), [['a'], ['b', 'a']]);
assert.deepEqual(requests.map((item) => item.primaryReferenceAssetIds), [['a'], ['b', 'a']]);
assert.equal(requests[0].directPromptSource, 'shot-visual');
assert.match(requests[0].directPrompt, /第2镜原动作/u);
assert.doesNotMatch(requests[0].directPrompt, /不应发送|旧视频稿|历史全局外貌|第4镜原动作/u);
assert.deepEqual(requests[0].referenceAssetIds, requests[0].primaryReferenceAssetIds);
assert.equal(JSON.stringify(board), original, 'H3/video references/shots are never rewritten');
selection.referenceAssetIdsByShotId['shot-2'].push('b');
assert.deepEqual(requests[0].referenceAssetIds, ['a'], 'queued requests do not follow future selection mutations');
selection.referenceAssetIdsByShotId['shot-2'].pop();

const output = buildDirectStoryboardImageRequests(board, selection, context, {
  width: 4096, height: 2304, sizeOverride: true, issue: '', layoutNote: '4K',
});
assert.deepEqual([output[0].width, output[0].height, output[0].sizeOverride], [4096, 2304, true]);
assert.throws(() => buildDirectStoryboardImageRequests(board, { ...selection, shotIds: [] }, context), /选择一个目标分镜/u);
assert.throws(() => buildDirectStoryboardImageRequests(board, { ...selection, shotIds: ['missing'] }, context), /目标分镜已不存在/u);
assert.throws(() => buildDirectStoryboardImageRequests(board, { ...selection, referenceAssetIdsByShotId: {} }, context), /没有绑定参考图/u);
assert.throws(() => buildDirectStoryboardImageRequests(board, selection, { ...context, assets: [image('b')] }), /已丢失/u);
assert.throws(() => buildDirectStoryboardImageRequests(board, selection, { ...context, assets: [image('a', { type: 'video' }), image('b')] }), /不是可读取/u);
assert.throws(() => buildDirectStoryboardImageRequests(board, selection, context, {
  width: 0, height: 0, sizeOverride: true, issue: '规格错误', layoutNote: '',
}), /规格错误/u);

const h3 = [
  'subject_definitions: <Subject 1> 阿莲；<Subject 2> 守卫',
  'summary: 不应整段送给生图的剧情摘要',
  'retention_analysis: 保留人物',
  'detailed_description: Warm moonlight.',
  '[Shot 1] 原H3第一镜。',
  '[Shot 2] At 00:03.000, <Subject 1>在画面右侧，右手抬起，<Subject 2>在画面左侧。(S1)说<d>[Chinese] 请把“[Shot 99]”写在台词里。</d>，手掌仍朝上。',
  '[Shot 3] At 00:06.000, 原H3第三镜。',
  '[Shot 4] At 00:09.000, 原H3第四镜。',
  'overall_soundscape: 不应发送的风声雷声配乐',
  'non_diegetic_music: 不应发送的BGM',
].join('\n');
const h3Board = { ...board, officialPromptZh: h3 };
const h3Original = JSON.stringify(h3Board);
const h3Requests = buildDirectStoryboardImageRequests(h3Board, selection, context);
assert.equal(h3Requests[0].directPromptSource, 'confirmed-h3');
assert.match(h3Requests[0].directPrompt, /在画面右侧，右手抬起/u);
assert.match(h3Requests[0].directPrompt, /手掌仍朝上/u);
assert.match(h3Requests[0].directPrompt, /<Subject 1> 阿莲/u);
assert.doesNotMatch(h3Requests[0].directPrompt, /第2镜原动作|不应发送|剧情摘要|请把|Shot 99|<d>|\(S1\)/u);
assert.equal(JSON.stringify(h3Board), h3Original);
assert.equal(buildDirectStoryboardImageRequests({ ...h3Board, officialPromptSource: 'stale-canonical-source' }, selection, context)[0].directPromptSource,
  'shot-visual', 'canonically stale H3 is not used as current shot content');

const fingerprint = directStoryboardImageSourceFingerprint(h3Board, h3Requests[0], context);
const cached = buildDirectStoryboardImageRequests(h3Board, selection, {
  ...context, currentImagePromptsByShotId: { 'shot-2': { prompt: '已确认同版本图片提示词', sourceFingerprint: fingerprint } },
});
assert.equal(cached[0].directPrompt, '已确认同版本图片提示词');
assert.equal(cached[0].directPromptSource, 'current-image-prompt');
const staleCache = buildDirectStoryboardImageRequests(h3Board, selection, {
  ...context, currentImagePromptsByShotId: { 'shot-2': { prompt: '错误旧缓存', sourceFingerprint: 'stale' } },
});
assert.doesNotMatch(staleCache[0].directPrompt, /错误旧缓存/u);
const microConversion = {
  ruleSetId: 'image-rule-openai-gpt-image-2-5-micro-nsfw',
  ruleSetVersion: '1.0.0',
  presetId: 'image-preset-gpt-image-2-5-micro-nsfw-storyboard',
  presetVersion: '1.0.0',
  format: 'natural-language',
  mode: 'gpt-image-2-5-micro-nsfw' as const,
  version: 2 as const,
};
const microContext = {
  ...context, directPromptConversion: microConversion,
  conversionIdentityContext: '作品《晨星巡航》世界观中的阿莲。',
};
const microFingerprint = directStoryboardImageSourceFingerprint(h3Board, h3Requests[0], microContext);
assert.match(microFingerprint, /^direct-storyboard-image-v2-/u);
assert.notEqual(microFingerprint, fingerprint, 'micro NSFW converter provenance invalidates old plain direct prompt caches');
const stalePlainCacheUnderMicro = buildDirectStoryboardImageRequests(h3Board, selection, {
  ...microContext, currentImagePromptsByShotId: { 'shot-2': { prompt: '旧直通缓存不应复用', sourceFingerprint: fingerprint } },
});
assert.doesNotMatch(stalePlainCacheUnderMicro[0].directPrompt, /旧直通缓存不应复用/u);
const cachedMicro = buildDirectStoryboardImageRequests(h3Board, selection, {
  ...microContext, currentImagePromptsByShotId: { 'shot-2': { prompt: '已转换微NSFW缓存', sourceFingerprint: microFingerprint } },
});
assert.equal(cachedMicro[0].directPrompt, '已转换微NSFW缓存');
const specificIdentityContext = {
  ...microContext,
  directPromptConversion: { ...microConversion, version: 3 as const },
};
const specificIdentityFingerprint = directStoryboardImageSourceFingerprint(h3Board, h3Requests[0], specificIdentityContext);
assert.match(specificIdentityFingerprint, /^direct-storyboard-image-v3-/u);
assert.notEqual(specificIdentityFingerprint, microFingerprint,
  'specific-work conversion must invalidate v2 generic-world caches even when the source and evidence are unchanged');
const oldGenericWorldCache = buildDirectStoryboardImageRequests(h3Board, selection, {
  ...specificIdentityContext,
  currentImagePromptsByShotId: { 'shot-2': { prompt: '来自游戏世界的阿莲', sourceFingerprint: microFingerprint } },
});
assert.notEqual(oldGenericWorldCache[0].directPromptSource, 'current-image-prompt');
assert.doesNotMatch(oldGenericWorldCache[0].directPrompt, /来自游戏世界的阿莲|晨星巡航/u,
  'invalidating an old conversion cache still does not locally append identity evidence');
const legacyMicroFingerprint = directStoryboardImageSourceFingerprint(h3Board, h3Requests[0], {
  ...context,
  directPromptConversion: { ...microConversion, version: 1 } as unknown as DirectStoryboardImagePromptConversion,
});
assert.notEqual(microFingerprint, legacyMicroFingerprint, 'the updated converter contract does not reuse old anonymous micro prompts');
const legacyMicroCache = buildDirectStoryboardImageRequests(h3Board, selection, {
  ...microContext, currentImagePromptsByShotId: { 'shot-2': { prompt: '旧微NSFW匿名提示词', sourceFingerprint: legacyMicroFingerprint } },
});
assert.notEqual(legacyMicroCache[0].directPromptSource, 'current-image-prompt');
assert.doesNotMatch(legacyMicroCache[0].directPrompt, /旧微NSFW匿名提示词|晨星巡航/u,
  'identity evidence invalidates conversion caches without being concatenated into the image prompt');
assert.notEqual(microFingerprint, directStoryboardImageSourceFingerprint(h3Board, h3Requests[0], {
  ...microContext, conversionIdentityContext: '修改后的原创世界观中的阿莲。',
}), 'a changed authored world context invalidates only converter-dependent caches');
assert.equal(fingerprint, directStoryboardImageSourceFingerprint(h3Board, h3Requests[0], {
  ...context, conversionIdentityContext: '普通直通路径不会采用这段身份上下文。',
}), 'ordinary direct fingerprints remain byte-compatible even if unrelated identity context exists');
assert.equal(fingerprint, directStoryboardImageSourceFingerprint({ ...h3Board, globalReferenceAssetIds: ['b'] }, h3Requests[0], {
  ...context, assets: [...assets, image('new-output')],
}), 'other selections and generated assets do not invalidate direct-source snapshots');
assert.notEqual(fingerprint, directStoryboardImageSourceFingerprint(h3Board, h3Requests[0], {
  ...context, assets: assets.map((asset) => asset.id === 'a' ? { ...asset, dataUrl: 'data:image/png;base64,RENF' } : asset),
}));

// The reference panel only picks the segment's images. The original result
// controls select the output moments, without per-shot bindings or old refs.
const sharedBoard: Storyboard = {
  ...h3Board,
  imageToImage: {
    referenceAssetIds: ['a', 'b'], selectedShotIds: ['shot-3'],
    referenceAssetIdsByShotId: { 'shot-1': ['automatic'], 'shot-3': ['global-reference'] },
  },
};
const sharedOriginal = JSON.stringify(sharedBoard);
const sharedReferenceIds = ['b', 'a'];
const commonRequests = buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'storyboard-shots', referenceAssetIds: sharedReferenceIds,
}, context, { width: 2560, height: 1440, sizeOverride: true, issue: '', layoutNote: 'custom' });
assert.deepEqual(commonRequests.map((request) => request.shotId), board.shots.map((item) => item.id));
assert.ok(commonRequests.every((request) => JSON.stringify(request.referenceAssetIds) === '["b","a"]'));
assert.ok(commonRequests.every((request) => JSON.stringify(request.primaryReferenceAssetIds) === '["b","a"]'));
assert.ok(commonRequests.every((request) => request.width === 2560 && request.height === 1440 && request.sizeOverride));
assert.ok(commonRequests.every((request) => request.purpose === 'storyboard-shot' && request.imageVariant === 'storyboard-frame'));
assert.ok(commonRequests.every((request) => !/automatic|global-reference/u.test(request.directPrompt)),
  'historical per-shot, video and global references never become direct image inputs');
assert.equal(directStoryboardImageSourceFingerprint(sharedBoard, commonRequests[0], context),
  directStoryboardImageSourceFingerprint(sharedBoard, {
    shotId: commonRequests[0].shotId, referenceAssetIds: commonRequests[0].referenceAssetIds,
  }, context), 'ordinary request fingerprints retain compatibility with the old direct path');
assert.equal(JSON.stringify(sharedBoard), sharedOriginal);
sharedReferenceIds.push('automatic');
assert.deepEqual(commonRequests[0].referenceAssetIds, ['b', 'a']);
commonRequests[0].referenceAssetIds.push('independent-mutation');
assert.deepEqual(commonRequests[1].referenceAssetIds, ['b', 'a'], 'each queued reference list is independently copied');
assert.deepEqual(commonRequests[0].primaryReferenceAssetIds, ['b', 'a']);
assert.equal(JSON.stringify(sharedBoard), sharedOriginal);

const selectedShared = buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'selected-shots', shotIds: ['shot-4', 'shot-2', 'shot-4'], referenceAssetIds: ['a'],
}, context);
assert.deepEqual(selectedShared.map((request) => request.shotId), ['shot-2', 'shot-4'],
  'selected-shot output retains storyboard order and does not duplicate the same shot');
assert.deepEqual(selectedShared.map((request) => request.referenceAssetIds), [['a'], ['a']]);
assert.throws(() => buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'selected-shots', shotIds: [], referenceAssetIds: ['a'],
}, context), /至少选择一个目标分镜/u);
assert.throws(() => buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'selected-shots', shotIds: ['missing'], referenceAssetIds: ['a'],
}, context), /目标分镜已不存在/u);
assert.throws(() => buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'storyboard-shots', referenceAssetIds: [],
}, context), /参考图栏选择图片/u);
assert.throws(() => buildDirectStoryboardImageBatchRequests({ ...sharedBoard, shots: [] }, {
  mode: 'storyboard-shots', referenceAssetIds: ['a'],
}, context), /没有可生成图片的视频分镜/u);

const makeFrames = (count: number): StoryboardImageFramePlan[] => Array.from({ length: count }, (_, index) => ({
  sourceShotId: index < Math.ceil(count / 2) ? 'shot-2' : 'shot-4',
  description: `原机位下的独立动作瞬间 ${index + 1}，画面右侧人物手掌朝上。`,
  timeSec: index < Math.ceil(count / 2) ? 3 + index * 0.01 : 9 + index * 0.01,
}));
const customPlan = makeFrames(9);
const customPlanOriginal = JSON.stringify(customPlan);
const customShared = buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'storyboard-shots', referenceAssetIds: ['b', 'a'], frames: customPlan,
}, context, { width: 4096, height: 2304, sizeOverride: true, issue: '', layoutNote: '4K' });
assert.equal(customShared.length, 9, 'nine images total, not nine variants of every video shot');
assert.deepEqual(customShared.map((request) => request.shotId), customPlan.map((frame) => frame.sourceShotId));
assert.deepEqual(customShared.map((request) => request.imageFrameIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.ok(customShared.every((request) => request.imageFrameCount === 9));
assert.deepEqual(customShared.map((request) => request.imageFrameDescription), customPlan.map((frame) => frame.description));
assert.deepEqual(customShared.map((request) => request.imageFrameTimeSec), customPlan.map((frame) => frame.timeSec));
assert.ok(customShared.every((request) => JSON.stringify(request.referenceAssetIds) === '["b","a"]'));
assert.ok(customShared.every((request) => request.width === 4096 && request.height === 2304 && request.sizeOverride));
assert.equal(new Set(customShared.map((request) => request.name)).size, 9);
assert.match(customShared[0].name, /第 1\/9 张分镜图片/u);
assert.match(customShared[8].name, /第 9\/9 张分镜图片/u);
assert.match(customShared[0].directPrompt, /已选定的本张静帧：原机位下的独立动作瞬间 1/u);
assert.match(customShared[0].directPrompt, /不能把多个时刻拼在一张图里/u);
assert.match(customShared[0].directPrompt, /本段画面时刻：3 秒/u);
assert.match(customShared[0].directPrompt, /在画面右侧，右手抬起/u);
assert.doesNotMatch(customShared[0].directPrompt, /原H3第四镜|请把|Shot 99|<d>|不应发送/u);
assert.equal(JSON.stringify(customPlan), customPlanOriginal);
assert.equal(JSON.stringify(sharedBoard), sharedOriginal, 'custom image count never changes H3, shot count or timing');
assert.deepEqual(buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'storyboard-shots', referenceAssetIds: ['a'], frames: [...customPlan].reverse(),
}, context).map((request) => request.imageFrameDescription), customPlan.map((frame) => frame.description).reverse(),
'the domain builder preserves the supplied plan order instead of re-planning or sorting moments');
for (const count of [1, 100]) {
  const batch = buildDirectStoryboardImageBatchRequests(sharedBoard, {
    mode: 'storyboard-shots', referenceAssetIds: ['a'], frames: makeFrames(count),
  }, context);
  assert.equal(batch.length, count);
  assert.equal(new Set(batch.map((request) => request.name)).size, count);
}
for (const count of [0, 101]) {
  assert.throws(() => buildDirectStoryboardImageBatchRequests(sharedBoard, {
    mode: 'storyboard-shots', referenceAssetIds: ['a'], frames: makeFrames(count),
  }, context), /1–100/u);
}
for (const frame of [
  { sourceShotId: 'missing', description: '独立画面' },
  { sourceShotId: 'shot-2', description: '  ' },
  { sourceShotId: 'shot-2', description: '独立画面', timeSec: Number.NaN },
  { sourceShotId: 'shot-2', description: '独立画面', timeSec: Number.POSITIVE_INFINITY },
]) {
  assert.throws(() => buildDirectStoryboardImageBatchRequests(sharedBoard, {
    mode: 'storyboard-shots', referenceAssetIds: ['a'], frames: [frame],
  }, context), /sourceShotId|description|timeSec/u);
}
assert.equal(buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'storyboard-shots', referenceAssetIds: ['a'], frames: [{ sourceShotId: 'shot-2', description: '不确定精确时间的静帧' }],
}, context)[0].imageFrameTimeSec, undefined, 'the builder never fabricates an absent frame timestamp');
assert.throws(() => buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'boundary-frames', referenceAssetIds: ['a'], frames: customPlan,
}, context), /自定义图片规划仅用于分镜图片生成/u);
assert.throws(() => buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'selected-shots', shotIds: ['shot-2'], referenceAssetIds: ['a'], frames: customPlan,
}, context), /自定义图片规划仅用于分镜图片生成/u);

const sharedBoundary = buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'boundary-frames', referenceAssetIds: ['b', 'a'],
}, context);
assert.equal(sharedBoundary.length, 2);
assert.deepEqual(sharedBoundary.map((request) => request.shotId), ['shot-1', 'shot-4']);
for (const field of ['purpose', 'imageVariant', 'assetType', 'assetRole', 'referenceRole'] as const) {
  assert.deepEqual(sharedBoundary.map((request) => request[field]), ['first-frame', 'last-frame']);
}
assert.deepEqual(sharedBoundary.map((request) => request.referenceAssetIds), [['b', 'a'], ['b', 'a']]);
assert.match(sharedBoundary[0].directPrompt, /第一镜的开始或动作刚开始的状态/u);
assert.match(sharedBoundary[0].directPrompt, /原H3第一镜/u);
assert.doesNotMatch(sharedBoundary[0].directPrompt, /原H3第四镜/u);
assert.match(sharedBoundary[1].directPrompt, /最后一镜结束时的最终可见状态/u);
assert.match(sharedBoundary[1].directPrompt, /原H3第四镜/u);
assert.doesNotMatch(sharedBoundary[1].directPrompt, /原H3第一镜/u);
const singleShotBoard = { ...board, shots: [board.shots[0]] };
const singleBoundary = buildDirectStoryboardImageBatchRequests(singleShotBoard, {
  mode: 'boundary-frames', referenceAssetIds: ['a'],
}, context);
assert.equal(singleBoundary.length, 2, 'even a one-shot video still needs both first and last frames');
assert.deepEqual(singleBoundary.map((request) => request.shotId), ['shot-1', 'shot-1']);
assert.equal(new Set(singleBoundary.map((request) => request.name)).size, 2);
assert.match(singleBoundary[0].name, /首帧/u);
assert.match(singleBoundary[1].name, /尾帧/u);

const batchCacheContext = {
  ...context,
  currentImagePromptsByShotId: Object.fromEntries(board.shots.map((item) => [item.id, {
    prompt: `不应跨时刻复用的全镜缓存 ${item.id}`,
    sourceFingerprint: directStoryboardImageSourceFingerprint(sharedBoard, { shotId: item.id, referenceAssetIds: ['b', 'a'] }, context),
  }])),
};
assert.equal(buildDirectStoryboardImageBatchRequests(sharedBoard, {
  mode: 'storyboard-shots', referenceAssetIds: ['b', 'a'],
}, batchCacheContext)[0].directPromptSource, 'current-image-prompt');
for (const batch of [
  buildDirectStoryboardImageBatchRequests(sharedBoard, { mode: 'boundary-frames', referenceAssetIds: ['b', 'a'] }, batchCacheContext),
  buildDirectStoryboardImageBatchRequests(sharedBoard, { mode: 'storyboard-shots', referenceAssetIds: ['b', 'a'], frames: customPlan }, batchCacheContext),
]) {
  assert.ok(batch.every((request) => request.directPromptSource === 'confirmed-h3'));
  assert.ok(batch.every((request) => !request.directPrompt.includes('不应跨时刻复用的全镜缓存')));
}
const customFingerprint = directStoryboardImageSourceFingerprint(sharedBoard, customShared[0], context);
assert.notEqual(customFingerprint, directStoryboardImageSourceFingerprint(sharedBoard, customShared[1], context));
assert.notEqual(customFingerprint, directStoryboardImageSourceFingerprint(sharedBoard, {
  ...customShared[0], imageFrameDescription: '同镜同序号但已选静帧内容变了',
}, context));
assert.notEqual(customFingerprint, directStoryboardImageSourceFingerprint(sharedBoard, {
  ...customShared[0], imageFrameTimeSec: 4.5,
}, context));
assert.equal(customFingerprint, directStoryboardImageSourceFingerprint(sharedBoard, {
  ...customShared[0], imageFrameBatchId: 'retry-new-batch',
}, context), 'batch execution identity does not invalidate an unchanged frozen visual request');
assert.notEqual(directStoryboardImageSourceFingerprint(singleShotBoard, singleBoundary[0], context),
  directStoryboardImageSourceFingerprint(singleShotBoard, singleBoundary[1], context));
assert.equal(JSON.stringify(sharedBoard), sharedOriginal);

const baseApi: ImageApiConfig = { enabled: true, backend: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: '', model: 'images' };
assert.doesNotThrow(() => assertDirectStoryboardImageApiSupport(baseApi, 2));
assert.throws(() => assertDirectStoryboardImageApiSupport(baseApi, 0), /至少一张/u);
assert.throws(() => assertDirectStoryboardImageApiSupport({ ...baseApi, enabled: false }, 1), /尚未启用/u);
assert.throws(() => assertDirectStoryboardImageApiSupport({ ...baseApi, backend: 'novelai' }, 1), /NovelAI/u);
assert.doesNotThrow(() => assertDirectStoryboardImageApiSupport({ ...baseApi, backend: 'sd_webui' }, 1));
assert.throws(() => assertDirectStoryboardImageApiSupport({ ...baseApi, backend: 'sd_webui' }, 2), /不支持将 2 张/u);
const workflow = JSON.stringify({
  1: { class_type: 'LoadImage', inputs: { image: '__REFERENCE_IMAGE_1__' } },
  2: { class_type: 'IPAdapterAdvanced', inputs: { image: ['1', 0] } },
  3: { class_type: 'KSampler', inputs: { model: ['2', 0] } },
  4: { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
});
assert.doesNotThrow(() => assertDirectStoryboardImageApiSupport({ ...baseApi, backend: 'comfyui', workflowJson: workflow }, 1));
assert.throws(() => assertDirectStoryboardImageApiSupport({ ...baseApi, backend: 'comfyui', workflowJson: workflow }, 2), /参考图/u);
const twoInputWorkflow = JSON.stringify({
  1: { class_type: 'LoadImage', inputs: { image: '__REFERENCE_IMAGE_1__' } },
  2: { class_type: 'LoadImage', inputs: { image: '__REFERENCE_IMAGE_2__' } },
  3: { class_type: 'IPAdapterAdvanced', inputs: { image: ['1', 0], image2: ['2', 0] } },
  4: { class_type: 'KSampler', inputs: { model: ['3', 0] } },
  5: { class_type: 'SaveImage', inputs: { images: ['4', 0] } },
});
assert.doesNotThrow(() => assertDirectStoryboardImageApiSupport({
  ...baseApi, backend: 'comfyui', workflowJson: workflow, activeComfyuiWorkflowId: 'two-refs',
  comfyuiWorkflows: [{ id: 'two-refs', name: '双图工作流', workflowJson: twoInputWorkflow, createdAt: 1, updatedAt: 1 }],
}, 2), 'preflight checks the selected workflow, not a stale workflowJson mirror');

const performer: Character = {
  id: 'performer', name: '阿莲', gender: '女', apparentAge: '25', race: '人类', appearance: '', outfit: '',
  signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [],
};
const privateReference = image('a', {
  referenceScope: 'nsfw-private-profile', nsfwPrivatePart: 'full-body',
  imageVariant: 'private-full-body', sourceEntityId: performer.id,
});
const privateContext = { ...context, characters: [performer], assets: [privateReference, image('b')] };
assert.throws(() => buildDirectStoryboardImageRequests(board, selection, privateContext), /现有私密资料使用范围/u,
  'direct selections must not bypass existing private profile routing');
const scopedBoard: Storyboard = {
  ...board, shots: board.shots.map((item) => ({ ...item, visiblePrivatePartsByCharacter: { performer: ['full-body'] } })),
};
assert.deepEqual(buildDirectStoryboardImageRequests(scopedBoard, selection, privateContext)[0].referenceAssetIds, ['a'],
  'the pre-existing explicit per-shot private scope remains usable without a new review');
assert.equal(performer.nsfwProfile, undefined, 'direct image requests never enrich or create private character data');

assert.deepEqual(await resolveDirectStoryboardReferenceImages(['b', 'a'], assets, {}), [assets[1].dataUrl, assets[0].dataUrl]);
const identical = [image('one', { dataUrl: assets[0].dataUrl }), image('two', { dataUrl: assets[0].dataUrl })];
assert.equal((await resolveDirectStoryboardReferenceImages(['one', 'two'], identical, {})).length, 2,
  'identical pixels under two explicitly chosen asset IDs do not silently reduce the upload count');
const managed = image('managed', { dataUrl: undefined, relativePath: 'images/managed.png' });
const loadedPaths: string[] = [];
const loaded = await resolveDirectStoryboardReferenceImages(['managed'], [managed], {
  readManagedImageDataUrl: async ({ relativePath }) => { loadedPaths.push(relativePath); return assets[0].dataUrl!; },
});
assert.deepEqual(loadedPaths, ['images/managed.png']);
assert.equal(loaded[0], assets[0].dataUrl);
await assert.rejects(resolveDirectStoryboardReferenceImages(['managed'], [managed], {}), /无法读取托管/u);
await assert.rejects(resolveDirectStoryboardReferenceImages(['managed'], [managed], {
  readManagedImageDataUrl: async () => 'data:image/gif;base64,QUFB',
}), /数据无效/u);
await assert.rejects(resolveDirectStoryboardReferenceImages(['a', 'missing'], assets, {}), /无法读取/u);
await assert.rejects(resolveDirectStoryboardReferenceImages([], assets, {}), /不会改为文生图/u);

console.log('Direct storyboard image-to-image: explicit binding, H3 isolation, request size, API capabilities and real pixels passed.');
