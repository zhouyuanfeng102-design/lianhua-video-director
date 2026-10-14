import assert from 'node:assert/strict';
import { generateSingleSegmentPrompt, type GenerateSingleSegmentPromptInput } from '../src/singleSegmentPrompt';
import { hasCurrentTextApiConversion } from '../src/appEffects';
import { buildOfficialSeedanceInput, hasCurrentSeedancePrompt } from '../src/seedanceSource';
import { createInitialState } from '../src/storage';
import { sourceContentHash } from '../src/sourceIntegrity';
import { buildSequencePromptHandoff, getSequencePromptHandoffStatus } from '../src/sequencePromptHandoff';
import type { ConverterPreset, Project, Storyboard, VideoSequencePlan } from '../src/types';

// Real shared pipeline, local text doubles only. No generation/video request.
const sourceStoryContent = '旅人甲抬手指向地图，然后放下手。';
const canonical = '【0s-5s】主体：@旅人甲（专注）[朝向：地图] 正在 [抬手指向地图→放下手]；空间：大厅；光影：自然光；镜头：固定中景；台词：无；音效：无';
const previousCanonical = canonical.replace('抬手指向地图→放下手', '站立查看地图');
const converter: ConverterPreset = { id: 'converter', name: '通用转换器', workflow: 'all', inputMode: 'all', scope: 'video',
  enabled: true, version: 'test', systemPrompt: '将剧情转换为可见视频动作。', outputRules: '保留六字段与镜头边界。', updatedAt: 1 };
const board: Storyboard = {
  id: 'board-1', sceneId: 'scene-1', chapterId: 'chapter-1', sourceStoryContent,
  workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1,
  pace: 'standard', aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo', stylePresetId: '',
  ruleSetId: '', converterPresetId: '', globalLock: '', finalPrompt: previousCanonical,
  shots: [{ id: 'shot-1', index: 1, startSec: 0, endSec: 5, subject: '旅人甲', action: '抬手指向地图→放下手', purpose: '看地图',
    camera: '固定中景', transition: '自然结束', lighting: '自然光', sound: '无', result: '手已放下',
    referenceAssetIds: ['map-reference'], locked: false, prompt: canonical,
    sourceStart: 0, sourceEnd: sourceStoryContent.length, sourceExcerpt: sourceStoryContent }],
  promptTrace: { mode: 'local-fallback', shotPlanMode: 'ai-complete', generatedAt: 1,
    modelRuleSetId: '', converterPresetId: '', sourceDocumentIds: [], referenceAssetIds: [] },
  // Unrelated saved H3 delivery is historical data, even when Seedance is first.
  officialPromptZh: 'OLD_H3_ZH', officialPromptEn: 'OLD_H3_EN', officialPromptSource: 'OLD_H3_SOURCE',
  englishPrompt: 'OLD_H3_EN', englishPromptSource: previousCanonical,
  targetModelId: 'minimax-h3', targetOutput: { targetId: 'minimax-h3', prompt: 'OLD_H3_ZH',
    parameters: {}, referenceManifest: [], warnings: [], generatedAt: 1 },
  createdAt: 1, updatedAt: 1,
};
const project: Project = { ...structuredClone(createInitialState().project), characters: [], locations: [], props: [],
  scenes: [], storyboards: [board], sequencePlans: [], assets: [{ id: 'map-reference', name: '地图',
    type: 'reference' as const, source: 'upload' as const, mediaType: 'image', referenceRole: 'scene' as const,
    role: 'scene' as const, visualAnchor: '大厅墙上的地图位置、纸张样式。', dataUrl: 'data:image/png;base64,AA==',
    tags: [], createdAt: 1, updatedAt: 1 }] };
const context = { assets: project.assets, characters: [], locations: [], props: [] };
const buildSeedanceInput = (candidate: Storyboard) => buildOfficialSeedanceInput(project, candidate);
const written = (candidate: Storyboard) => [
  '视频规格：时长5秒；画面比例16:9；分辨率720p；声音stereo。',
  '参考素材与职责：\n@Image 1：大厅地图的纸张样式与墙面位置。',
  '主体连续性：\n旅人甲保持在地图前。',
  '一句话概述：\n旅人甲指向地图后放下手。',
  `连续时间轴：\n${candidate.finalPrompt.replace('@旅人甲', '旅人甲')}`,
  '全局约束：\n保持地图位置和旅人甲的站位连续，不添加对白。',
].join('\n\n');
const english = [
  'Video specification: 5 seconds; 16:9; 720p; stereo.',
  'References and responsibilities:\n@Image 1: the map, its paper and placement in the hall.',
  'Subject continuity:\nThe traveler stays beside the map.',
  'One-sentence summary:\nThe traveler points at the map and lowers their hand.',
  'Continuous timeline:\n【0s-5s】The traveler raises one hand toward the map and lowers it; fixed medium shot; natural light; no dialogue or sound.',
  'Global constraints:\nKeep the map and the traveler in the same hall.',
].join('\n\n');
const initial = JSON.stringify({ board, project });
const options: GenerateSingleSegmentPromptInput = { board, context, converter, targetPromptFormat: 'seedance',
  buildSeedanceInput, clean: (value) => value.trim(), hasImageInputs: true, now: () => 100 };
let canonicalCheckpoint: Storyboard | undefined;
let chineseCheckpoint: Storyboard | undefined;
const stages: string[] = [];
const generated = await generateSingleSegmentPrompt({ ...options,
  onQualifiedCanonical: async (value) => {
    await Promise.resolve();
    canonicalCheckpoint = value;
    assert.ok(hasCurrentTextApiConversion(value));
    assert.equal(value.promptTrace?.convertedPromptFingerprint, sourceContentHash(canonical));
    assert.equal(value.seedance25Output, undefined);
    stages.push('canonical-saved');
  },
  onQualifiedChinese: async (value) => {
    await Promise.resolve();
    chineseCheckpoint = value;
    assert.ok(hasCurrentSeedancePrompt(project, value));
    assert.equal(value.seedance25Output?.promptEn, undefined);
    stages.push('chinese-saved');
  },
  request: async (system, user, stage) => {
    stages.push(stage);
    if (stage === 'convert') return canonical;
    if (stage === 'review') {
      assert.ok(canonicalCheckpoint, 'canonical save must finish before target writing');
      assert.match(system, /Seedance 2\.5 专属/u);
      assert.match(system, /本次附有参考图真实像素/u);
      assert.doesNotMatch(system, /H3字段职责必须分开|必须.*integrated_multimodal_description|h3Prompt与identityBindings/u);
      const evidence = JSON.parse(user.match(/<seedance_source_data>\s*([\s\S]*?)\s*<\/seedance_source_data>/u)![1]);
      assert.equal(evidence.canonicalPrompt, canonical);
      assert.equal(evidence.sourceEvidence.sourceStoryContent, sourceStoryContent);
      assert.equal(evidence.sourceEvidence.shots[0].sourceExcerpt, sourceStoryContent);
      assert.equal(evidence.referenceManifest[0].id, 'map-reference');
      assert.ok(!JSON.stringify(evidence).includes('data:image/png'), 'binary data belongs to image transport');
      return written(canonicalCheckpoint);
    }
    assert.ok(chineseCheckpoint, 'async Chinese checkpoint must finish before translation');
    assert.match(system, /Seedance/u);
    return english;
  },
});
assert.deepEqual(stages, ['convert', 'canonical-saved', 'review', 'chinese-saved', 'translate']);
assert.equal(generated.finalPrompt, canonical);
assert.ok(hasCurrentSeedancePrompt(project, generated, 'en'), generated.seedance25Output?.englishError);
assert.equal(generated.seedance25Output?.promptEn, english);
assert.equal(generated.seedance25Output?.englishError, '');
for (const key of ['officialPromptZh', 'officialPromptEn', 'officialPromptSource', 'englishPrompt', 'englishPromptSource', 'targetModelId', 'targetOutput'] as const) {
  assert.deepEqual(generated[key], board[key], `Seedance must preserve saved H3 field ${key}`);
}
assert.equal(JSON.stringify({ board, project }), initial, 'source, refs and old delivery stay immutable');

// Writer failure preserves a usable canonical checkpoint; retry skips converter.
let savedAfterFailure: Storyboard | undefined;
await assert.rejects(generateSingleSegmentPrompt({ ...options,
  onQualifiedCanonical: async (value) => { savedAfterFailure = value; },
  request: async (_system, _user, stage) => {
    if (stage === 'convert') return canonical;
    throw new Error('mock Seedance writer unavailable');
  },
}), /mock Seedance writer unavailable/u);
assert.ok(savedAfterFailure && hasCurrentTextApiConversion(savedAfterFailure));
let retryStages: string[] = [];
const partial = await generateSingleSegmentPrompt({ ...options, board: savedAfterFailure!, skipConversion: true,
  onQualifiedChinese: async (value) => { chineseCheckpoint = value; },
  request: async (_system, _user, stage) => {
    retryStages.push(stage);
    if (stage === 'review') return written(savedAfterFailure!);
    assert.ok(chineseCheckpoint?.seedance25Output?.promptZh);
    throw new Error('mock English unavailable');
  },
});
assert.deepEqual(retryStages, ['review', 'translate']);
assert.ok(hasCurrentSeedancePrompt(project, partial));
assert.equal(partial.seedance25Output?.promptEn, undefined);
assert.match(partial.seedance25Output?.englishError || '', /mock English unavailable/u);
retryStages = [];
const recovered = await generateSingleSegmentPrompt({ ...options, board: partial, mode: 'translate-english',
  onQualifiedCanonical: () => assert.fail('English-only retry must not reconvert'),
  onQualifiedChinese: () => assert.fail('English-only retry must not rewrite Chinese'),
  request: async (_system, _user, stage) => { retryStages.push(stage); return english; },
});
assert.deepEqual(retryStages, ['translate']);
assert.ok(hasCurrentSeedancePrompt(project, recovered, 'en'));
assert.deepEqual(recovered.shots, partial.shots);
assert.equal(recovered.seedance25Output?.promptZh, partial.seedance25Output?.promptZh);

// Changed workspace at either checkpoint prevents all following requests.
for (const checkpoint of ['canonical', 'chinese']) {
  let current = true;
  const called: string[] = [];
  await assert.rejects(generateSingleSegmentPrompt({ ...options, isCurrent: () => current,
    onQualifiedCanonical: async (value) => { canonicalCheckpoint = value; if (checkpoint === 'canonical') current = false; },
    onQualifiedChinese: async () => { current = false; },
    request: async (_system, _user, stage) => { called.push(stage); return stage === 'convert' ? canonical : written(canonicalCheckpoint!); },
  }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.deepEqual(called, checkpoint === 'canonical' ? ['convert'] : ['convert', 'review']);
}
await assert.rejects(generateSingleSegmentPrompt({ ...options, buildSeedanceInput: undefined,
  request: async () => assert.fail('missing Seedance source must fail before any model request') }), /缺少来源/u);
await assert.rejects(generateSingleSegmentPrompt({ ...options, board: recovered, mode: 'translate-english',
  buildSeedanceInput: (value) => ({ ...buildSeedanceInput(value), references: [] }),
  request: async () => assert.fail('changed refs must reject old Seedance source before translation') }), /来源已变化/u);

// Existing callers default to H3 and never require a Seedance builder.
const h3Stages: string[] = [];
const h3 = await generateSingleSegmentPrompt({ board, context, converter, clean: (value) => value.trim(),
  request: async (_system, _user, stage) => { h3Stages.push(stage); if (stage === 'convert') return canonical;
    throw new Error('mock H3 English unavailable'); },
});
assert.deepEqual(h3Stages, ['convert', 'translate']);
assert.match(h3.officialPromptZh || '', /integrated_multimodal_description|detailed_description/u);
assert.equal(h3.seedance25Output, undefined);

// A selected-format continuity repair really traverses the public converter;
// the request authority remains limited even though a complete body returns.
const twoShotCanonical = [canonical.replace('0s-5s', '0s-2s').replace('抬手指向地图→放下手', '抬手指向地图'),
  canonical.replace('0s-5s', '2s-5s').replace('抬手指向地图→放下手', '放下手')].join('\n');
const repairedCanonical = twoShotCanonical.replace('抬手指向地图]', '前0.5秒接续上段手部末态→随后抬手指向地图]');
const plan: VideoSequencePlan = { id: 'continuity-plan', chapterId: 'chapter-1', title: '地图', sourceStoryTitle: '地图',
  sourceStoryContent, requestedTotalDurationSec: 10, totalDurationSec: 10, durationMode: 'fixed', segmentDurationSec: 5,
  segmentationMode: 'fixed', fitStatus: 'balanced', createdAt: 1, updatedAt: 1,
  segments: [1, 2].map((index) => ({ id: `segment-${index}`, index, title: `段${index}`, globalStartSec: (index - 1) * 5,
    globalEndSec: index * 5, durationSec: 5, content: sourceStoryContent, summary: '查看地图', sourceSceneIds: [],
    sourceBeatIds: [], narrativePurpose: '查看地图', entryState: '手放下', exitState: '手放下', transitionHint: '连续',
    continuityPack: '保持地图前站位', status: 'ready' as const, storyboardId: `continuity-${index}` })) };
const previous = { ...generated, id: 'continuity-1', sequencePlanId: plan.id, segmentId: 'segment-1', segmentIndex: 1 };
const current: Storyboard = { ...generated, id: 'continuity-2', sequencePlanId: plan.id, segmentId: 'segment-2', segmentIndex: 2,
  finalPrompt: twoShotCanonical, shotCount: 2,
  shots: [0, 1].map((index) => ({ ...generated.shots[0], id: `repair-shot-${index}`, index: index + 1,
    startSec: index ? 2 : 0, endSec: index ? 5 : 2, action: index ? '放下手' : '抬手指向地图', prompt: twoShotCanonical.split('\n')[index] })),
  promptTrace: { ...generated.promptTrace!, convertedPromptFingerprint: sourceContentHash(twoShotCanonical) } };
const continuityProject: Project = { ...project, sequencePlans: [plan], storyboards: [previous, current] };
const continuityBuilder = (candidate: Storyboard) => buildOfficialSeedanceInput(continuityProject, candidate);
const handoff = buildSequencePromptHandoff(continuityProject, plan.id, 'segment-2', 'seedance').context;
assert.ok(handoff);
const continuityCalls: string[] = [];
const repaired = await generateSingleSegmentPrompt({ ...options, board: current, purpose: 'continuity-repair',
  sequenceHandoff: handoff, buildSeedanceInput: continuityBuilder,
  request: async (system, user, stage) => {
    continuityCalls.push(stage);
    if (stage === 'convert') {
      const evidence = JSON.parse(user.match(/<video_conversion_data>\s*([\s\S]*?)\s*<\/video_conversion_data>/u)![1]);
      assert.equal(evidence.conversionPurpose, 'continuity-repair');
      assert.equal(evidence.revisionScope, 'adjacent-segment-continuity-only');
      assert.equal(evidence.taskAuthority, 'preserve-confirmed-schedule');
      assert.equal(evidence.voiceFactScope, 'preserve-confirmed-source');
      assert.equal(evidence.savedCanonicalPrompt, twoShotCanonical);
      assert.equal(evidence.sequenceHandoff.previousPromptKind, 'seedance');
      assert.match(system, /只修改首镜[\s\S]*不从完整剧情重新编写整段/u);
      assert.doesNotMatch(system, /新生成或主动重新生成时默认仅保留剧情内对白/u);
      return repairedCanonical;
    }
    if (stage === 'review') {
      assert.match(system, /衔接修复后的 Seedance 同步/u);
      assert.match(user, /seedance_existing_delivery_data/u);
      return written({ ...current, finalPrompt: repairedCanonical });
    }
    return english.replace('【0s-5s】', '【0s-2s】').replace('fixed medium shot;', 'fixed medium shot;\n【2s-5s】The hand lowers;');
  },
});
assert.deepEqual(continuityCalls, ['convert', 'review', 'translate']);
assert.equal(repaired.finalPrompt.split('\n')[1], twoShotCanonical.split('\n')[1]);
assert.deepEqual(repaired.shots.map(({ startSec, endSec }) => [startSec, endSec]), [[0, 2], [2, 5]]);
assert.equal(repaired.seedance25Output?.sequencePromptHandoff?.promptFormat, 'seedance');
assert.equal(repaired.sequencePromptHandoff, current.sequencePromptHandoff);
continuityProject.storyboards[1] = repaired;
assert.equal(getSequencePromptHandoffStatus(repaired, continuityProject, 'seedance').kind, 'current');
await assert.rejects(generateSingleSegmentPrompt({ ...options, board: generated, purpose: 'continuity-repair',
  request: async () => assert.fail('continuity repair without previous delivery cannot issue requests') }), /缺少上一段/u);
console.log('Seedance-first pipeline: source/reference fidelity, async canonical/Chinese checkpoints, writer and English recovery, cancellation, H3 preservation and legacy default passed (local text doubles only).');
