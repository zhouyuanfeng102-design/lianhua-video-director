import assert from 'node:assert/strict';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { prepareVideoH3ReferenceDraft } from '../src/videoH3ReferenceBinding';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { draftFromVideoTask, readVideoDirectorChapterDraft } from '../src/videoDirectorDraft';
import { videoBatchTailReferences } from '../src/videoBatch';
import { maskVideoPictureReferenceLiterals } from '../src/videoPictureReferences';
import { sourceContentHash } from '../src/sourceContentHash';
import { readSeedanceSections } from '../src/seedanceSections';
import { findSeedanceReferenceConflicts } from '../src/seedanceReferenceClaims';
import type { Character, Project, ReferenceAsset, Storyboard, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft, VideoImageReference } from '../src/videoGenerationTypes';

let groups = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); console.log(`PASS ${++groups} ${name}`); };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSfoAAAAASUVORK5CYII=';
const api: VideoTaskApiConfig = { enabled: true, provider: 'generic', model: 'connection-model-independent-of-prompt-format',
  endpoint: 'https://seedance-binding.test.invalid/generate', statusEndpointTemplate: 'https://seedance-binding.test.invalid/task/{id}',
  apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' };
const classicApi: VideoTaskApiConfig = { ...api, model: '特价2.5需要过人脸技术-可参考过人脸素材库',
  endpoint: 'https://video.laoliimage2.win/v1/videos', statusEndpointTemplate: 'https://video.laoliimage2.win/v1/videos/{id}' };
const dialogue = '夏提雅：“屏幕上写着 @Image 1 和 @图片2，不要改字。”';
const timeline = `【0s-30s】夏提雅连续向前两步，亚乌拉回头回应，两人停在门外。${dialogue}`;
const zh = `视频规格：时长30秒，16:9，720p，立体声。
参考素材与职责：本次 referenceManifest 为空，没有实际映射的图片、视频、音频或 Clay Render 素材；不使用参考素材，也不依据未提供的图像像素补充画面细节。
主体连续性：夏提雅保持红色全身铠甲，亚乌拉保持白袍。
一句话概述：两人来到门外。
连续时间轴（覆盖0–30秒）：
${timeline}
全局约束：保持动作与对白的原有先后。`;
const markdownZh = zh.replace(/^(视频规格|参考素材与职责|主体连续性|一句话概述|全局约束)：/gmu, '## $1\n\n')
  .replace(/^连续时间轴（覆盖0–30秒）：/mu, '## 连续时间轴（覆盖0–30秒）\n\n');
const en = `Video specification: duration 30 seconds, 16:9, 720p, stereo.
References and responsibilities: no external reference material is mapped; do not use reference material.
Subject continuity: 夏提雅 retains red full armor and 亚乌拉 retains the white robe.
One-sentence summary: the two arrive outside the gate.
Continuous timeline (covering 0–30 seconds):
${timeline}
Global constraints: retain the original sequence of actions and dialogue.`;
const character = (id: string, name: string, assetIds: string[]): Character => ({ id, name, assetIds, gender: '', race: '',
  apparentAge: '成年', appearance: '稳定身份', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' });
const image = (id: string, ownerId?: string): ReferenceAsset => ({ id, name: `无人物名的文件-${id}`, type: 'reference',
  role: 'character', referenceRole: 'character', mediaType: 'image', dataUrl: png, tags: [], createdAt: 1, updatedAt: 1,
  ...(ownerId ? { sourceEntityKind: 'character' as const, sourceEntityId: ownerId } : {}) });
const refs = (): VideoImageReference[] => [{ assetId: 'portrait-red', role: 'character', characterIds: ['red'] },
  { assetId: 'portrait-white', role: 'character', characterIds: ['white'] }];
const fixture = (prompt = zh, language: 'zh' | 'en' = 'zh'): { project: Project; board: Storyboard; draft: VideoGenerationDraft } => {
  const project = createInitialState().project;
  project.id = 'seedance-reference-project'; project.characters = [character('red', '夏提雅', ['portrait-red']), character('white', '亚乌拉', ['portrait-white'])];
  project.assets = [image('portrait-red', 'red'), image('portrait-white', 'white'), image('portrait-red-second', 'red'),
    image('group'), { ...image('scene'), role: 'scene', referenceRole: 'scene' }, { ...image('tail'), role: 'first-frame', referenceRole: 'first-frame' }];
  project.locations = []; project.props = []; project.generationTasks = []; project.sequencePlans = [];
  const board: Storyboard = { id: 'seedance-reference-board', sceneId: project.scenes[0].id, sourceStoryTitle: '门外会合', sourceStoryContent: timeline,
    workflow: 'drama', inputMode: 'text', durationSec: 30, durationPreset: 'custom', shotMode: 'exact', shotCount: 1, pace: 'standard',
    aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '',
    targetModelId: 'custom', finalPrompt: timeline, sequencePlanId: 'seedance-reference-plan', segmentId: 'segment-1', segmentIndex: 1,
    shots: [{ id: 'shot-1', index: 1, startSec: 0, endSec: 30, purpose: '会合', subject: '夏提雅与亚乌拉', action: '夏提雅前进，亚乌拉回应',
      camera: '中景', lighting: '自然光', sound: dialogue, transition: '连续', result: '门外停步', referenceAssetIds: [], prompt: timeline, locked: false }],
    seedance25Output: { targetId: 'seedance-2.5', promptZh: language === 'zh' ? prompt : zh, promptEn: language === 'en' ? prompt : en,
      durationSec: 30, sourceFingerprint: 'synthetic-source', englishSourceFingerprint: 'synthetic-source', referenceManifest: [], warnings: [], generatedAt: 3 },
    createdAt: 1, updatedAt: 2 };
  project.storyboards = [board];
  const draft: VideoGenerationDraft = { name: 'Seedance参考图合成测试', prompt, backend: 'api', parameters: { duration: 30, resolution: '720p', ratio: '16:9' },
    references: refs(), source: { storyboardId: board.id, sequencePlanId: board.sequencePlanId, segmentId: board.segmentId, segmentIndex: 1,
      language, promptFormat: 'seedance', sourceFingerprint: 'synthetic-source', promptFingerprint: sourceContentHash(prompt) } };
  return { project, board, draft };
};
const prepare = (project: Project, draft: VideoGenerationDraft, config = api) => prepareVideoH3ReferenceDraft(project, draft, { backend: draft.backend, api: config });
const section = (prompt: string): string => {
  const match = /^[ \t]*(?:#{1,6}[ \t]+)?(?:参考素材与职责|References and responsibilities)[ \t]*[：:]?([\s\S]*?)(?=^[ \t]*(?:#{1,6}[ \t]+)?(?:主体连续性|Subject continuity)[ \t]*(?:[：:]|$))/imu.exec(prompt);
  assert.ok(match, 'the reference section remains between its existing headings'); return match[1];
};
const tokens = (prompt: string): string[] => [...maskVideoPictureReferenceLiterals(prompt).matchAll(/@Image\s+\d+|@图片\s*\d+/gu)].map((match) => match[0]);
const stateFor = (result: ReturnType<typeof prepare>, id: string) => {
  const state = result.characterStates.find((entry) => entry.characterId === id); assert.ok(state, `missing character state for ${id}`); return state;
};
const assertStoryPreserved = (prompt: string, original: string) => {
  assert.ok(prompt.includes(timeline), 'actions, dialogue and their order remain exact');
  for (const value of original.split('\n').filter((line) => /^(?:主体连续性|Subject continuity|一句话概述|One-sentence summary|全局约束|Global constraints)/u.test(line))) {
    assert.ok(prompt.includes(value), `source prose was unexpectedly changed: ${value}`);
  }
};
const assertCurrentReferenceClaims = (prompt: string) => {
  assert.deepEqual(findSeedanceReferenceConflicts(section(prompt), { hasImages: true, hasAudio: false }), [], 'selected images cannot coexist with a current no-images or text-only directive');
  assert.doesNotMatch(prompt, /原稿写作时的素材说明|Reference notes at original authoring time/u);
};

await test('空manifest手选两张明确人物图，职责/状态与提交编号一致', () => {
  const { project, draft } = fixture(); const before = structuredClone({ project, draft });
  assert.equal(prepare(project, { ...draft, references: [] }).draft.prompt, draft.prompt, 'without selected images the saved source remains byte-for-byte unchanged');
  const result = prepare(project, draft); const references = section(result.draft.prompt);
  assert.deepEqual(tokens(references), ['@Image 1', '@Image 2']);
  assert.match(references, /夏提雅/u); assert.match(references, /亚乌拉/u); assert.match(references, /身份|外观|identity/iu);
  assertCurrentReferenceClaims(result.draft.prompt);
  assert.doesNotMatch(references, /referenceManifest|不使用参考素材|不依据未提供/u);
  assert.match(references, /本次提交的参考图片：/u);
  assert.equal(stateFor(result, 'red').status, 'bound'); assert.deepEqual(stateFor(result, 'red').slots, [1]);
  assert.equal(stateFor(result, 'white').status, 'bound'); assert.deepEqual(stateFor(result, 'white').slots, [2]);
  assert.equal(result.draft.source?.promptFingerprint, sourceContentHash(result.draft.prompt));
  assertStoryPreserved(result.draft.prompt, zh); assert.deepEqual({ project, draft }, before, 'rendering is read-only');
  const body = buildVideoApiBody(api, result.draft, ['https://example.invalid/red.png', 'https://example.invalid/white.png']);
  assert.equal(body.prompt, result.draft.prompt); assert.equal(body.model, api.model, 'the selected prompt format never replaces the configured API model');
  assert.deepEqual(body.images, ['https://example.invalid/red.png', 'https://example.invalid/white.png']);
});

await test('Markdown中文与英文Video specification/specs合法六节都只更新参考职责章节', () => {
  for (const [prompt, language] of [[markdownZh, 'zh'], [en, 'en'], [en.replace('Video specification:', 'Video specs:'), 'en']] as const) {
    const { project, draft } = fixture(prompt, language); const result = prepare(project, draft);
    assert.deepEqual(tokens(section(result.draft.prompt)), ['@Image 1', '@Image 2']);
    assert.equal(stateFor(result, 'red').status, 'bound'); assertStoryPreserved(result.draft.prompt, prompt);
    assert.equal(result.draft.prompt.split(/(?:##\s*)?连续时间轴|Continuous timeline/u).length, 2, 'the timeline heading is not duplicated');
  }
});

await test('真实后置规格与仅文字声明在同一预览提交中同步，原稿与时间轴保留', () => {
  const prompt = zh.replace('时长30秒，16:9，720p', '总时长30秒，16:9画幅，2K分辨率')
    .replace('本次 referenceManifest 为空，没有实际映射的图片、视频、音频或 Clay Render 素材；不使用参考素材，也不依据未提供的图像像素补充画面细节。',
      '本次未提供任何图片、视频或音频素材，全部人物与场景均以文字设定为准。');
  const { project, board, draft } = fixture(prompt);
  const parameters = { duration: 25, aspect_ratio: '9:16', resolution: '720p' };
  const request = { ...draft, parameters };
  const result = prepare(project, request);
  assert.equal(result.draft.prompt.split('\n')[0], '视频规格：总时长25秒，画面比例9:16，分辨率720p，立体声。');
  assertCurrentReferenceClaims(result.draft.prompt); assertStoryPreserved(result.draft.prompt, prompt);
  assert.equal(stateFor(result, 'red').status, 'bound'); assert.equal(stateFor(result, 'white').status, 'bound');
  const body = buildVideoApiBody({ ...api, endpoint: 'https://www.v6k.top/v1/videos' }, result.draft, [png, png]);
  assert.equal(body.prompt, result.draft.prompt); assert.equal(body.resolution, '720p'); assert.equal(body.duration, 25);
  assert.equal(body.aspect_ratio, '9:16'); assert.equal(board.seedance25Output?.promptZh, prompt);
  assert.equal(prepare(project, result.draft).draft.prompt, result.draft.prompt);
  const cleared = prepare(project, { ...result.draft, parameters: {} });
  assert.equal(cleared.draft.prompt.split('\n')[0], prompt.split('\n')[0], 'clearing overrides renders from the authored source');
  assertCurrentReferenceClaims(cleared.draft.prompt);
});

await test('共享六节定位保持UTF16坐标，兼容粗体并拒绝缺失、重复或乱序标题', () => {
  const quotedHeading = '“屏幕文字如下：\n参考素材与职责：只是台词，不是章节。”';
  const prompt = zh.replace('立体声。', '立体声。🌙').replace(dialogue, `${dialogue}${quotedHeading}`);
  const parsed = readSeedanceSections(prompt)!;
  assert.equal(parsed.language, 'zh');
  assert.equal(parsed.sections.references.start, prompt.indexOf('本次 referenceManifest'));
  assert.equal(parsed.sections.references.end, prompt.indexOf('主体连续性：'));
  assert.equal(prompt.slice(parsed.sections.timeline.start, parsed.sections.timeline.end).trimEnd(), `${timeline}${quotedHeading}`);
  assert.equal(parsed.sections.constraints.end, prompt.length);
  assert.equal(readSeedanceSections(`${zh}\n参考素材与职责：重复章节。`), undefined);
  assert.equal(readSeedanceSections(zh.replace('全局约束', '未识别的标题')), undefined);
  assert.equal(readSeedanceSections(zh.replace('主体连续性', '__SWAP__').replace('一句话概述', '主体连续性').replace('__SWAP__', '一句话概述')), undefined);
  for (const [source, language] of [[zh, 'zh'], [en.replace('Video specification:', 'Video specs:'), 'en']] as const) {
    const boldOutside = language === 'zh'
      ? source.replace(/^(视频规格|参考素材与职责|主体连续性|一句话概述|连续时间轴(?:（[^）]*）)?|全局约束)(?=：)/gmu, '**$1**')
      : source.replace(/^(Video specs|References and responsibilities|Subject continuity|One-sentence summary|Continuous timeline(?: \([^)]*\))?|Global constraints)(?=:)/gmu, '**$1**');
    for (const bold of [boldOutside, boldOutside.replace(/\*\*([^*\r\n]+)\*\*([:：])/gu, '**$1$2**')]) {
      const { project, draft } = fixture(bold, language); const result = prepare(project, draft);
      assert.equal(readSeedanceSections(bold)?.language, language);
      assert.equal(stateFor(result, 'red').status, 'bound'); assert.equal(stateFor(result, 'white').status, 'bound');
      assert.ok(result.draft.prompt.includes('@Image 1')); assert.ok(result.draft.prompt.includes('@Image 2'));
      assert.ok(result.draft.prompt.includes(timeline));
      assert.equal(readSeedanceSections(`${bold}\n${language === 'zh' ? '**参考素材与职责：**' : '**References and responsibilities:**'} duplicate`), undefined);
    }
  }
});

await test('空manifest参考段没有引号也保留原有空间和动作事实', () => {
  for (const [original, language] of [[zh, 'zh'], [en, 'en']] as const) {
    const fact = language === 'zh' ? '营地位于巨树旁的森林空地；光纹只是投影，能力尚未发动。'
      : 'The camp is in a forest clearing beside a giant tree; the light pattern is only a projection, not an activated power.';
    const prompt = original.replace(language === 'zh' ? '\n主体连续性' : '\nSubject continuity', `${fact}\n${language === 'zh' ? '主体连续性' : 'Subject continuity'}`);
    const { project, draft } = fixture(prompt, language); const result = prepare(project, draft);
    assertCurrentReferenceClaims(result.draft.prompt);
    assert.ok(result.draft.prompt.includes(fact)); assertStoryPreserved(result.draft.prompt, prompt);
    assert.equal(stateFor(result, 'red').status, 'bound'); assert.equal(stateFor(result, 'white').status, 'bound');
    assert.deepEqual(result.warnings, []);
  }
});

await test('已有manifest同样清理旧无图声明，参考章节中的剧情事实不因有无引号丢失', () => {
  for (const fact of ['营地位于巨树旁的森林空地；光纹只是投影，能力尚未发动。', '营地按“巨树旁的森林空地”建立空间；光纹只是投影，能力尚未发动。']) {
    const prompt = zh.replace('参考素材与职责：', '参考素材与职责：@Image 1：夏提雅身份参考。').replace('\n主体连续性', `${fact}\n主体连续性`);
    const { project, board, draft } = fixture(prompt);
    board.seedance25Output!.referenceManifest = [{ id: 'portrait-red', token: '@Image 1', responsibility: '夏提雅身份参考' }];
    const result = prepare(project, { ...draft, references: [...refs()].reverse() });
    assertCurrentReferenceClaims(result.draft.prompt);
    assert.doesNotMatch(section(result.draft.prompt), /referenceManifest|不使用参考素材|不依据未提供/u);
    assert.ok(result.draft.prompt.includes(fact));
    assert.ok(result.draft.prompt.includes('夏提雅身份参考。'));
    assert.deepEqual(tokens(section(result.draft.prompt)), ['@Image 1', '@Image 2'], 'current reference list owns the only image-entry ordinals');
    assert.deepEqual(stateFor(result, 'red').slots, [2]);
    assertStoryPreserved(result.draft.prompt, prompt);
    assert.equal(prepare(project, result.draft).draft.prompt, result.draft.prompt);
  }
});

await test('新增/调序/删除/清空从同一原稿重渲染，不累加或让旧号串到另一个人物', () => {
  const { project, draft } = fixture(); const first = prepare(project, { ...draft, references: refs().slice(0, 1) });
  const added = prepare(project, { ...first.draft, references: refs() });
  assert.deepEqual(tokens(section(added.draft.prompt)), ['@Image 1', '@Image 2']);
  const reordered = prepare(project, { ...added.draft, references: [...refs()].reverse() });
  assert.deepEqual(stateFor(reordered, 'red').slots, [2]); assert.deepEqual(stateFor(reordered, 'white').slots, [1]);
  const removed = prepare(project, { ...reordered.draft, references: [refs()[1]] });
  assert.deepEqual(tokens(section(removed.draft.prompt)), ['@Image 1']);
  assert.equal(stateFor(removed, 'red').status, 'unselected'); assert.deepEqual(stateFor(removed, 'white').slots, [1]);
  const cleared = prepare(project, { ...removed.draft, references: [] });
  assert.deepEqual(tokens(section(cleared.draft.prompt)), []); assert.equal(stateFor(cleared, 'white').status, 'unselected');
  assert.ok(cleared.draft.prompt.includes(dialogue), 'clearing selected pictures preserves literal tokens in dialogue');
  assert.equal(prepare(project, added.draft).draft.prompt, added.draft.prompt, 'repeated preview is idempotent');
  assert.deepEqual(prepare(project, added.draft).characterStates, added.characterStates);
});

await test('同角色多图、一图多人和显式解绑保持明确ID，不按文件名猜人物', () => {
  const { project, draft } = fixture();
  const multiple = prepare(project, { ...draft, references: [refs()[0], { assetId: 'portrait-red-second', role: 'character', characterIds: ['red'] }] });
  assert.deepEqual(stateFor(multiple, 'red').slots, [1, 2]); assert.equal(stateFor(multiple, 'red').status, 'bound');
  const group = prepare(project, { ...draft, references: [{ assetId: 'group', role: 'general', characterIds: ['red', 'white'] }] });
  assert.deepEqual(tokens(section(group.draft.prompt)), ['@Image 1']);
  assert.deepEqual(stateFor(group, 'red').slots, [1]); assert.deepEqual(stateFor(group, 'white').slots, [1]);
  assert.equal(stateFor(group, 'red').status, 'bound'); assert.equal(stateFor(group, 'white').status, 'bound');
  const unbound = prepare(project, { ...draft, references: [{ ...refs()[0], characterIds: [] }] });
  assert.equal(stateFor(unbound, 'red').status, 'unselected', 'explicit empty identities cannot fall back to the asset owner');
  assert.deepEqual(unbound.draft.references[0].characterIds, []);
  assert.equal(tokens(section(unbound.draft.prompt)).length, 1, 'an unbound picture still has its selected general image use');
});

await test('不明确的图片排序只警告待关联，不把物理node槽号当Seedance序号', () => {
  const { project, draft } = fixture();
  const runningHub: VideoTaskApiConfig = { ...api, provider: 'runninghub', runningHubImageRoles: ['character', 'character', 'character', 'character'],
    requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'p', fieldName: 'value', fieldValue: '' }, { nodeId: 'i', fieldName: 'image', fieldValue: '' }] }),
    runningHubMappedFields: [{ nodeId: 'p', fieldName: 'value', kind: 'prompt' }, { nodeId: 'i', fieldName: 'image', kind: 'image', imageIndex: 3 }] };
  for (const config of [runningHub, { ...api, requestTemplate: '{"prompt":"{{prompt}}","namedImage":"{{image_4}}"}' }]) {
    const result = prepare(project, { ...draft, references: [{ ...refs()[0], slotIndex: 3 }] }, config);
    assert.ok(result.warnings.length); assert.equal(stateFor(result, 'red').status, 'pending');
    assert.deepEqual(tokens(section(result.draft.prompt)), [], 'an unknown workflow order cannot fabricate @Image 4');
    assert.equal(result.issue, undefined, 'identity and ordering warnings do not add a semantic submission gate');
    assert.deepEqual(result.draft.references, [{ ...refs()[0], slotIndex: 3 }]);
  }
});

await test('非图片参考的原始职责保留并提示真实媒体上传边界', () => {
  const { project, board, draft } = fixture();
  const nonImage = '@Video 1：原始动作录像只约束抬手时序。\n@Audio 1：原始鼓点只约束声音节奏。\n@Clay Render 1：空间灰模只约束门的位置。';
  const prompt = zh.replace(/参考素材与职责：[\s\S]*?(?=\n主体连续性)/u, `参考素材与职责：\n${nonImage}`);
  board.seedance25Output!.promptZh = prompt;
  board.seedance25Output!.referenceManifest = [{ id: 'v', token: '@Video 1', mediaType: 'video', responsibility: '原始动作录像只约束抬手时序。' },
    { id: 'a', token: '@Audio 1', mediaType: 'audio', responsibility: '原始鼓点只约束声音节奏。' },
    { id: 'c', token: '@Clay Render 1', mediaType: 'clay-render', responsibility: '空间灰模只约束门的位置。' }];
  const result = prepare(project, { ...draft, prompt });
  for (const line of nonImage.split('\n')) assert.ok(result.draft.prompt.includes(line), `non-image responsibility was changed: ${line}`);
  for (const token of ['@Video 1', '@Audio 1', '@Clay Render 1']) assert.ok(result.warnings.some((warning) => warning.includes(token)));
  assert.deepEqual(tokens(section(result.draft.prompt)), ['@Image 1', '@Image 2']);
  assertStoryPreserved(result.draft.prompt, zh);
});

await test('手工修改保持原文，已证明来源不因缺六章而丢失人物关联', () => {
  const { project, draft } = fixture(); const first = prepare(project, draft);
  const manual = `${first.draft.prompt}\n我手工确认的补充要求。`;
  const edited = prepare(project, { ...first.draft, prompt: manual, references: [...refs()].reverse() });
  assert.equal(edited.draft.prompt, manual); assert.ok(edited.warnings.length); assert.equal(edited.issue, undefined);
  assert.notEqual(stateFor(edited, 'red').status, 'bound', 'a stale rendering is not reported as a current successful binding');
  for (const language of ['zh', 'en'] as const) {
    const missing = fixture(`${language === 'zh' ? '未按六节编排的Seedance原稿。' : 'Saved Seedance source without six headings.'}\n${timeline}`, language);
    const result = prepare(missing.project, missing.draft);
    assert.ok(result.draft.prompt.startsWith(missing.draft.prompt)); assert.equal(result.issue, undefined);
    assert.equal(stateFor(result, 'red').status, 'bound'); assert.equal(stateFor(result, 'white').status, 'bound');
    assert.deepEqual(stateFor(result, 'red').slots, [1]); assert.deepEqual(stateFor(result, 'white').slots, [2]);
    assert.ok(result.draft.prompt.includes(language === 'zh' ? '本次提交的参考图片：' : 'Reference images for this request:'));
    assert.equal(prepare(missing.project, result.draft).draft.prompt, result.draft.prompt);
    assert.equal(prepare(missing.project, { ...result.draft, references: [] }).draft.prompt, missing.draft.prompt);
    const reordered = prepare(missing.project, { ...result.draft, references: [...refs()].reverse() });
    assert.deepEqual(stateFor(reordered, 'red').slots, [2]); assert.deepEqual(stateFor(reordered, 'white').slots, [1]);
    assert.equal(buildVideoApiBody(api, result.draft, [png, png]).prompt, result.draft.prompt);
    assert.equal(missing.board.seedance25Output?.[language === 'zh' ? 'promptZh' : 'promptEn'], missing.draft.prompt);
  }
});

await test('没有来源清单的真实图片编号仍待确认，不能借新选图猜旧号', () => {
  const prompt = zh.replace('本次 referenceManifest 为空', '@Image 99：未证明对应的旧图。本次 referenceManifest 为空');
  const { project, draft } = fixture(prompt); const result = prepare(project, draft);
  assert.equal(result.draft.prompt, prompt);
  assert.equal(stateFor(result, 'red').status, 'pending'); assert.equal(stateFor(result, 'white').status, 'pending');
  assert.ok(result.warnings.some((warning) => warning.includes('@Image 99') && warning.includes('缺少可证明')));
  assert.deepEqual(tokens(section(result.draft.prompt)), ['@Image 99']);
});

await test('空参考章节含引号或对白时保留事实并按本次图片建立人物关联', () => {
  for (const [original, language] of [[zh, 'zh'], [en, 'en']] as const) {
    const prompt = language === 'zh'
      ? original.replace('不使用参考素材，也不依据未提供的图像像素补充画面细节。', '不使用参考素材，也不依据未提供的图像像素补充画面细节。营地按“巨树旁的森林空地”建立空间；光纹只是投影，能力尚未发动。备注：“@Image 99 只是屏幕文字，不可改字。”')
      : original.replace('do not use reference material.', 'do not use reference material. Establish the camp as “a forest clearing beside a giant tree”; the light pattern is only a projection, not an activated power. Note: “@Image 99 is literal screen text and must remain unchanged.”');
    const { project, draft } = fixture(prompt, language); const result = prepare(project, draft);
    assertCurrentReferenceClaims(result.draft.prompt);
    const fact = language === 'zh' ? '营地按“巨树旁的森林空地”建立空间；光纹只是投影，能力尚未发动。备注：“@Image 99 只是屏幕文字，不可改字。”'
      : 'Establish the camp as “a forest clearing beside a giant tree”; the light pattern is only a projection, not an activated power. Note: “@Image 99 is literal screen text and must remain unchanged.”';
    assert.ok(result.draft.prompt.includes(fact), 'authored reference facts and protected quotations survive exactly');
    assert.match(result.draft.prompt, /本次提交的参考图片：|Reference images for this request:/u);
    assert.deepEqual(tokens(section(result.draft.prompt)), ['@Image 1', '@Image 2'], 'a quoted media token remains literal, not an image binding');
    assert.equal(stateFor(result, 'red').status, 'bound'); assert.equal(stateFor(result, 'white').status, 'bound');
    assert.deepEqual(result.warnings, []); assert.equal(result.issue, undefined);
    assert.deepEqual(result.draft.references, draft.references); assert.ok(result.draft.prompt.includes(dialogue));
    assertStoryPreserved(result.draft.prompt, prompt);
    assert.equal(prepare(project, result.draft).draft.prompt, result.draft.prompt, 'repeated preview does not accumulate authoring notes or image lists');
    const reordered = prepare(project, { ...result.draft, references: [...refs()].reverse() });
    assert.deepEqual(stateFor(reordered, 'red').slots, [2]); assert.deepEqual(stateFor(reordered, 'white').slots, [1]);
    assert.equal(prepare(project, { ...result.draft, references: [] }).draft.prompt, prompt, 'clearing images restores the exact original prompt');
    const body = buildVideoApiBody(api, result.draft, ['https://example.invalid/red.png', 'https://example.invalid/white.png']);
    assert.equal(body.prompt, result.draft.prompt, 'submission uses the same bound reference list as preview');
    assert.deepEqual(body.images, ['https://example.invalid/red.png', 'https://example.invalid/white.png']);
    assert.equal(project.storyboards[0].seedance25Output?.[language === 'zh' ? 'promptZh' : 'promptEn'], prompt, 'request-only binding never rewrites the saved source');
  }
});

await test('空manifest九图选择中四个人物槽正确关联，旧待关联草稿可直接重算', () => {
  const prompt = zh.replace('不使用参考素材，也不依据未提供的图像像素补充画面细节。', '不使用参考素材，也不依据未提供的图像像素补充画面细节。营地按“巨树旁的森林空地”建立空间。');
  const { project, draft } = fixture(prompt);
  project.characters.push(character('third', '第三人物', ['portrait-third']), character('fourth', '第四人物', ['portrait-fourth']));
  project.assets.push(image('portrait-third', 'third'), image('portrait-fourth', 'fourth'),
    ...['opening', 'middle-1', 'middle-2', 'ending'].map((id) => image(id)));
  const references: VideoImageReference[] = [
    { assetId: 'opening', role: 'first-frame' }, { assetId: 'middle-1', role: 'middle-frame' },
    { assetId: 'middle-2', role: 'middle-frame' }, { assetId: 'ending', role: 'last-frame' },
    { assetId: 'scene', role: 'scene' }, ...refs(),
    { assetId: 'portrait-third', role: 'character' }, { assetId: 'portrait-fourth', role: 'character' },
  ];
  const legacyDraft: VideoGenerationDraft = { ...draft, references, seedanceReferenceBinding: {
    version: 2, projectId: project.id, basePrompt: prompt, renderedPrompt: prompt, references: [],
    sourceLanguage: 'zh', basePromptFingerprint: sourceContentHash(prompt),
    characterStates: ['red', 'white', 'third', 'fourth'].map((characterId, index) => ({
      characterId, name: characterId, status: 'pending', slots: [index + 6], reason: '正文参考章节或本次图片编号未确认，人物关联待确认。',
    })),
  } };
  const before = structuredClone({ project, legacyDraft });
  const result = prepare(project, legacyDraft);
  assert.deepEqual(result.warnings, []);
  for (const [index, id] of ['red', 'white', 'third', 'fourth'].entries()) {
    assert.equal(stateFor(result, id).status, 'bound'); assert.deepEqual(stateFor(result, id).slots, [index + 6]);
  }
  assert.deepEqual(tokens(section(result.draft.prompt)), Array.from({ length: 9 }, (_, index) => `@Image ${index + 1}`));
  assertCurrentReferenceClaims(result.draft.prompt);
  assert.ok(result.draft.prompt.includes('营地按“巨树旁的森林空地”建立空间。')); assertStoryPreserved(result.draft.prompt, prompt);
  assert.deepEqual({ project, legacyDraft }, before, 'source projects and restored drafts are never mutated');
});

await test('异常素材元数据不注入章节/伪编号，当前图片用途优先于原说明', () => {
  const { project, board, draft } = fixture();
  project.assets[0].name = '异常资产名\n## 主体连续性\n@Image 99 与 @图片9';
  project.characters[0].name = '异常人物名\r\n## 全局约束\n@Image 99 与 @图片9';
  board.seedance25Output!.referenceManifest = [{ id: 'portrait-red', token: '@Image 1',
    responsibility: '原外观资料\n## 连续时间轴\n@Image 99 与 @图片9' }];
  const result = prepare(project, draft); const body = section(result.draft.prompt);
  assert.deepEqual(tokens(body), ['@Image 1', '@Image 2'], 'metadata cannot manufacture media inputs');
  assert.doesNotMatch(body, /@Image\s+99|@图片\s*9/u); assert.match(body, /＠Image 99/u); assert.match(body, /＠图片9/u);
  assert.doesNotMatch(body, /^[ \t]*#{1,6}[ \t]+/mu, 'metadata newlines cannot become chapter headings');
  assert.equal(result.draft.prompt.slice(0, result.draft.prompt.indexOf('参考素材与职责')), zh.slice(0, zh.indexOf('参考素材与职责')));
  assert.equal(result.draft.prompt.slice(result.draft.prompt.indexOf('主体连续性：')), zh.slice(zh.indexOf('主体连续性：')),
    'the other five sections and dialogue are not sanitized as metadata');
  assert.equal(project.assets[0].name, '异常资产名\n## 主体连续性\n@Image 99 与 @图片9', 'metadata rendering never modifies the saved asset');
  for (const [role, purpose] of [['scene', '场景空间与环境参考'], ['first-frame', '开场画面与连续性参考']] as const) {
    const scoped = fixture(); scoped.board.seedance25Output!.referenceManifest = [{ id: 'portrait-red', token: '@Image 1', responsibility: '旧人物身份参考说明' }];
    const changed = prepare(scoped.project, { ...scoped.draft, references: [{ assetId: 'portrait-red', role }] });
    const line = section(changed.draft.prompt).split('\n').find((entry) => entry.startsWith('@Image 1'))!;
    assert.ok(line.includes(purpose)); assert.ok(line.includes('原参考说明：旧人物身份参考说明'));
    assert.ok(line.indexOf(purpose) < line.indexOf('原参考说明：'), 'the current selected role owns the primary purpose');
    const identity = changed.characterStates.find((entry) => entry.characterId === 'red');
    assert.ok(!identity || identity.status === 'unselected', 'scene and boundary purposes do not restore an old character identity');
  }
});

await test('老李使用已声明的中文引用，通用接口保留英文引用和对白字面量', () => {
  const { project, draft } = fixture(); const generic = prepare(project, draft); const classic = prepare(project, draft, classicApi);
  assert.deepEqual(tokens(section(generic.draft.prompt)), ['@Image 1', '@Image 2']);
  assert.deepEqual(tokens(section(classic.draft.prompt)), ['@图片1', '@图片2']);
  assert.ok(classic.draft.prompt.includes(dialogue)); assert.ok(generic.draft.prompt.includes(dialogue));
  const body = buildVideoApiBody(classicApi, classic.draft, [png, png]);
  assert.equal(body.prompt, classic.draft.prompt); assert.deepEqual(body.images, [png, png]);
  assert.equal(body.model, classicApi.model);
});

await test('密集API不因空物理槽跳号；加入真实或未来末帧时人物编号顺延', () => {
  const { project, draft } = fixture();
  const sparse = prepare(project, { ...draft, references: [{ ...refs()[0], slotIndex: 2 }, { ...refs()[1], slotIndex: 5 }] });
  assert.deepEqual(stateFor(sparse, 'red').slots, [1]); assert.deepEqual(stateFor(sparse, 'white').slots, [2]);
  for (const tailId of ['tail', '__future_tail_binding__']) {
    const selected = videoBatchTailReferences(draft.references, { mode: 'prepend', index: 0, role: 'first-frame' }, tailId);
    const result = prepare(project, { ...draft, references: selected });
    assert.deepEqual(stateFor(result, 'red').slots, [2]); assert.deepEqual(stateFor(result, 'white').slots, [3]);
    assert.deepEqual(tokens(section(result.draft.prompt)), ['@Image 1', '@Image 2', '@Image 3']);
    assertStoryPreserved(result.draft.prompt, zh);
  }
});

await test('新绑定可恢复，旧v1冻结重试不借用新源稿/人物资料', () => {
  const { project, draft } = fixture(); const result = prepare(project, draft);
  const restored = readVideoDirectorChapterDraft(JSON.parse(JSON.stringify({ draft: result.draft, parameterText: '{}', parameterDrafts: [], generationMode: 'single' })))!;
  assert.ok(restored); assert.deepEqual(restored.draft.seedanceReferenceBinding, result.draft.seedanceReferenceBinding);
  assert.equal(prepare(project, restored.draft).draft.prompt, result.draft.prompt);
  const changed = structuredClone(project); changed.characters[0].name = '后来更名'; changed.assets[0].sourceEntityId = 'white';
  changed.storyboards[0].seedance25Output!.promptZh = '后来重写的源稿'; changed.storyboards[0].seedance25Output!.referenceManifest = [];
  const frozen = { ...structuredClone(result.draft), reuseTaskId: 'old-frozen-task' };
  const retry = prepare(changed, frozen);
  assert.deepEqual(retry.draft, frozen); assert.deepEqual(retry.characterStates, result.characterStates, 'the current render status also remains frozen');
  const legacy: VideoGenerationDraft = { ...draft, prompt: `${zh}\n@Image 1：旧任务的可信来源。`, reuseTaskId: 'old-v1-task',
    seedanceReferenceBinding: { version: 1, projectId: project.id, basePrompt: zh, renderedPrompt: `${zh}\n@Image 1：旧任务的可信来源。`,
      references: [{ token: '@Image 1', assetId: 'portrait-red' }] }, h3ReferenceWarnings: ['旧任务原始提示'] };
  assert.deepEqual(prepare(changed, legacy).draft, legacy, 'legacy task snapshots are never upgraded by preview or retry');
});

await test('模拟任务提交/排队/保存重载与预览同稿，历史快照不随实时选图改变', async () => {
  const { project, draft } = fixture(); let state = createInitialState(); state.project = project; state.projects = [];
  state.settings.videoTaskApi = api; state.settings.videoExecutionMode = 'queue';
  const posts: Record<string, unknown>[] = [];
  const desktop = { videoRequest: async (payload: Parameters<VideoGenerationDesktop['videoRequest']>[0]) => {
    if (payload.method === 'POST') { posts.push(JSON.parse(payload.body!)); return { status: 200, body: JSON.stringify({ id: `seedance-remote-${posts.length}`, status: 'queued' }) }; }
    return { status: 200, body: JSON.stringify({ status: 'processing' }) };
  }, setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
  saveVideoTaskCheckpoint: async () => ({ persisted: true }), onVideoProgress: () => () => undefined } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); }, desktop,
    onRuntime: () => undefined, pollIntervalMs: 100000, persistState: async () => undefined });
  try {
    const preview = prepare(project, draft).draft; const first = await engine.start(preview);
    assert.equal(posts[0].prompt, preview.prompt); assert.deepEqual(posts[0].images, [png, png]);
    const secondDraft = { ...preview, name: '排队的独立稿', parameters: { ...preview.parameters, duration: 29 } };
    const secondPreview = prepare(project, secondDraft).draft;
    const second = await engine.start(secondDraft);
    const task = state.project.generationTasks.find((entry) => entry.id === second) as VideoGenerationTask;
    assert.equal(posts.length, 1); assert.equal(task.videoJob!.snapshot.draft.prompt, secondPreview.prompt);
    assert.match(secondPreview.prompt.split('\n')[0], /总时长29秒/u);
    assert.ok(secondPreview.prompt.includes(timeline), 'request duration never retimes the authored dialogue or shots');
    const frozen = structuredClone(task.videoJob!.snapshot);
    preview.references.reverse(); state.project.characters[0].name = '后改的人物名'; state.project.assets[0].sourceEntityId = 'white';
    state.project.storyboards[0].seedance25Output!.promptZh = '后改的原稿';
    assert.deepEqual(task.videoJob!.snapshot, frozen);
    const reloaded = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
    const restoredTask = reloaded.project.generationTasks.find((entry) => entry.id === second) as VideoGenerationTask;
    assert.deepEqual(restoredTask.videoJob!.snapshot.draft.seedanceReferenceBinding, frozen.draft.seedanceReferenceBinding);
    const retry = draftFromVideoTask(restoredTask)!;
    assert.equal(prepare(reloaded.project, retry).draft.prompt, frozen.draft.prompt);
    assert.ok(first && second);
  } finally { engine.dispose(); }
});

await test('批量未来末帧在入队时冻结最终关联，等待期间不再依据实时人物改写', async () => {
  const { project, board, draft } = fixture();
  const nextBoard: Storyboard = { ...structuredClone(board), id: 'seedance-reference-board-2', segmentId: 'segment-2', segmentIndex: 2 };
  project.storyboards.push(nextBoard);
  let state = createInitialState(); state.project = project; state.projects = []; state.settings.videoTaskApi = api;
  let extractions = 0;
  const desktop = { videoRequest: async () => ({ status: 200, body: JSON.stringify({ id: 'queued-first-seedance', status: 'queued' }) }),
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async () => ({ persisted: true }), onVideoProgress: () => () => undefined,
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'synthetic' }),
    extractWorkbenchFrames: async () => { extractions += 1; throw new Error('the queued predecessor has no completed video to extract'); },
    readManagedImageDataUrl: async () => ({ dataUrl: png }),
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); }, desktop,
    onRuntime: () => undefined, pollIntervalMs: 100000, persistState: async () => undefined });
  try {
    const second: VideoGenerationDraft = { ...structuredClone(draft), source: { ...draft.source,
      storyboardId: nextBoard.id, segmentId: nextBoard.segmentId, segmentIndex: 2 } };
    const expected = prepare(project, { ...second, references: videoBatchTailReferences(second.references,
      { mode: 'prepend', index: 0, role: 'first-frame' }, '__future_tail_binding__') });
    const batch = await engine.startBatch({ projectId: project.id, label: 'Seedance未来末帧冻结', items: [
      { itemKey: 'seedance-reference-board:zh', draft },
      { itemKey: 'seedance-reference-board-2:zh', draft: second,
        previousTail: { predecessorItemKey: 'seedance-reference-board:zh', placement: { mode: 'prepend', index: 0, role: 'first-frame' } } },
    ] });
    const task = state.project.generationTasks.find((entry) => entry.id === batch.taskIds[1]) as VideoGenerationTask;
    assert.equal(task.videoJob!.snapshot.draft.prompt, expected.draft.prompt, 'reserved tail asset identity cannot change displayed future-tail prose');
    assert.equal(task.videoJob!.snapshot.draft.references.length, 3);
    const actual = prepare(project, { ...task.videoJob!.snapshot.draft, reuseTaskId: task.id });
    assert.deepEqual(stateFor(actual, 'red').slots, [2]); assert.deepEqual(stateFor(actual, 'white').slots, [3]);
    assert.equal(extractions, 0);
    const frozen = structuredClone(task.videoJob!.snapshot.draft);
    second.references.reverse(); state.project.characters[0].name = '排队期间更名'; state.project.assets[0].sourceEntityId = 'white';
    assert.deepEqual(task.videoJob!.snapshot.draft, frozen);
    assert.deepEqual(prepare(state.project, { ...frozen, reuseTaskId: task.id }).characterStates, actual.characterStates);
  } finally { engine.dispose(); }
});

console.log(`Seedance reference binding: ${groups} focused groups passed (memory fixtures and mock video transport only).`);
