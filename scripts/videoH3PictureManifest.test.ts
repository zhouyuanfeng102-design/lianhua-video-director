import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { prepareVideoH3ReferenceDraft, videoH3BindingForPrompt } from '../src/videoH3ReferenceBinding';
import { collectVideoPictureReferenceNumbers } from '../src/videoPictureReferences';
import { addVideoDraftAssets, applyVideoPromptChoice } from '../src/videoDirectorDraft';
import { prepareVideoTailCharacterDraft } from '../src/videoTailCharacters';
import type { Project, ReferenceAsset, Storyboard, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';

let groups = 0;
const test = (name: string, run: () => void) => { run(); console.log(`PASS ${++groups} ${name}`); };
const prompt = `subject_definitions:
<Subject 3> is 石门 referenced from <Picture 9>: 保留原样石门描述。
<Subject 8> is 木船 referenced from <Picture 8>: 保留原样木船描述。
<Subject 1> is 灯笼 referenced from <Picture 7>: 保留原样灯笼描述。
summary:
沿溪前行。
retention_analysis:
<Subject 3> reference <Picture 9>; <Subject 8> reference <Picture 8>; <Subject 1> reference <Picture 7>.
detailed_description:
[Shot 1] 船缓缓经过石门。<d>[Chinese] 保留字面量<Picture 99>。</d> <sound>原样<Picture 98></sound> 牌子写着“<Picture 97>”。
[Shot 2] At 00:07.500 镜头转向灯笼。
overall_soundscape: N/A
non_diegetic_music: N/A`;
const api: VideoTaskApiConfig = {
  enabled: true, provider: 'runninghub', model: 'minimax-h3', apiKey: '',
  endpoint: 'https://fixture.invalid/run', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url',
  runningHubMappedFields: Array.from({ length: 6 }, (_, imageIndex) => ({
    kind: 'image' as const, imageIndex, nodeId: `image-${imageIndex}`, fieldName: 'image',
  })),
};
const context = { backend: 'api' as const, api };
const fixture = (): { project: Project; board: Storyboard; draft: VideoGenerationDraft } => {
  const project = createInitialState().project;
  project.id = 'manifest-fixture'; project.characters = []; project.locations = []; project.props = [];
  project.assets = Array.from({ length: 7 }, (_, index): ReferenceAsset => ({
    id: `asset-${index + 1}`, name: `file-${index + 1}`, type: 'reference', role: 'general',
    dataUrl: 'data:image/png;base64,AAAA', tags: [], createdAt: 1, updatedAt: 1,
  }));
  const board = { id: 'manifest-board', sceneId: '', shots: [], officialPromptZh: prompt,
    h3IdentityBindings: { version: 1, characters: [] }, targetOutput: {
      targetId: 'minimax-h3', prompt, parameters: {}, warnings: [], generatedAt: 1,
      referenceManifest: [9, 8, 7].map((number, index) => ({ token: `<Picture ${number}>`, id: `asset-${index + 1}` })),
    }, createdAt: 1, updatedAt: 1 } as unknown as Storyboard;
  project.storyboards = [board];
  const draft: VideoGenerationDraft = { name: 'manifest fixture', backend: 'api', prompt,
    parameters: {}, references: [6, 1, 5, 2, 3, 4].map((index) => ({ assetId: `asset-${index}`, role: 'general' })),
    source: { storyboardId: board.id },
  };
  return { project, board, draft };
};

test('旧九图manifest按资产ID重排成实际六个输入，Subject/剧情/对白保持', () => {
  const { project, draft } = fixture(); const unchanged = structuredClone({ project, draft });
  const result = prepareVideoH3ReferenceDraft(project, draft, context);
  assert.equal(result.issue, undefined);
  assert.deepEqual(collectVideoPictureReferenceNumbers(result.draft.prompt), [2, 4, 5]);
  assert.equal(result.draft.prompt, prompt.replaceAll('<Picture 9>', '<Picture 2>').replaceAll('<Picture 8>', '<Picture 4>').replaceAll('<Picture 7>', '<Picture 5>'));
  assert.deepEqual({ project, draft }, unchanged);
  assert.equal(prepareVideoH3ReferenceDraft(project, result.draft, context).draft.prompt, result.draft.prompt);
});

test('缺失人物锚点不阻止已证明图片清单同步', () => {
  const { project, board, draft } = fixture();
  board.h3IdentityBindings = { version: 1, characters: {} } as unknown as Storyboard['h3IdentityBindings'];
  const result = prepareVideoH3ReferenceDraft(project, draft, context);
  assert.deepEqual(collectVideoPictureReferenceNumbers(result.draft.prompt), [2, 4, 5]);
  assert.ok(result.warnings.some((warning) => /人物锚点资料损坏/u.test(warning)));
  assert.deepEqual(result.draft.h3ReferenceBinding?.identities.characters, []);
});

test('旧assetId字段和[Pic]/[Picture]及大小写空格引用使用同一源映射', () => {
  const { project, board, draft } = fixture();
  draft.prompt = prompt.replaceAll('<Picture 9>', '[pIc 9]').replaceAll('<Picture 8>', '[Picture 8]').replaceAll('<Picture 7>', '<pICTURE   7>');
  board.officialPromptZh = draft.prompt; board.targetOutput!.prompt = draft.prompt;
  board.targetOutput!.referenceManifest = [
    { token: '[Pic9]', assetId: 'asset-1' }, { token: '[Picture 8]', assetId: 'asset-2' }, { token: '<picture   7>', assetId: 'asset-3' },
  ];
  const result = prepareVideoH3ReferenceDraft(project, draft, context);
  assert.deepEqual(collectVideoPictureReferenceNumbers(result.draft.prompt), [2, 4, 5]);
  assert.match(result.draft.prompt, /\[pIc 2\]/u); assert.match(result.draft.prompt, /<pICTURE   5>/u);
});

test('未写language的精确官方英文稿只借其已证明的中文来源manifest', () => {
  const { project, board, draft } = fixture();
  board.officialPromptEn = prompt.replace('沿溪前行。', 'Move along the stream.');
  board.officialPromptEnSource = board.officialPromptZh;
  board.h3IdentityBindingsEn = { version: 1, characters: {} } as unknown as Storyboard['h3IdentityBindingsEn'];
  draft.prompt = board.officialPromptEn;
  const result = prepareVideoH3ReferenceDraft(project, draft, context);
  assert.deepEqual(collectVideoPictureReferenceNumbers(result.draft.prompt), [2, 4, 5]);
  assert.match(result.draft.prompt, /Move along the stream\./u);
  assert.equal(result.draft.source?.language, 'en', 'the exact English provenance must reach the official submission guard');
  const explicitChinese = prepareVideoH3ReferenceDraft(project, { ...draft, source: { ...draft.source, language: 'zh' } }, context);
  assert.equal(explicitChinese.draft.source?.language, 'zh', 'an explicit language choice must not be replaced');
  board.officialPromptEnSource = 'a different historical source';
  assert.equal(videoH3BindingForPrompt(project, draft), undefined, 'a broken English source link cannot borrow a later manifest');
  board.h3IdentityBindingsEn = { version: 1, characters: [] };
  board.officialPromptEnSource = undefined;
  assert.equal(prepareVideoH3ReferenceDraft(project, draft, context).draft.source?.language, undefined, 'missing English provenance is not permission to fill the language');
});

test('服务会规范化的Image尖括号与裸Picture编号也按已证明图片来源同步', () => {
  const { project, board, draft } = fixture();
  draft.prompt = prompt.replaceAll('<Picture 9>', '<Image9>').replaceAll('<Picture 8>', 'Picture #8').replaceAll('<Picture 7>', 'Picture 7');
  board.officialPromptZh = draft.prompt; board.targetOutput!.prompt = draft.prompt;
  const result = prepareVideoH3ReferenceDraft(project, draft, context);
  assert.deepEqual(collectVideoPictureReferenceNumbers(result.draft.prompt), [2, 4, 5]);
  assert.match(result.draft.prompt, /<Image2>/u); assert.match(result.draft.prompt, /Picture #4/u); assert.match(result.draft.prompt, /Picture 5/u);
  assert.match(result.draft.prompt, /<d>\[Chinese\] 保留字面量<Picture 99>。<\/d>/u);
  assert.match(result.draft.prompt, /牌子写着“<Picture 97>”/u);
  assert.deepEqual(collectVideoPictureReferenceNumbers('前缀Picture7 UnicodeImage8 wordPicture9 Picture7后缀'), [], 'bare aliases need real Unicode word boundaries');
});

test('部分manifest缺项保留未知标签，仍同步已知项并明确混合编号问题', () => {
  const { project, board, draft } = fixture();
  board.targetOutput!.referenceManifest = board.targetOutput!.referenceManifest.slice(0, 1);
  const result = prepareVideoH3ReferenceDraft(project, draft, context);
  assert.deepEqual(collectVideoPictureReferenceNumbers(result.draft.prompt), [2, 8, 7]);
  assert.match(result.issue || '', /混合编号.*恢复原图片清单/u);
  assert.match(result.issue || '', /<Picture 8>.*<Picture 7>/u);
  assert.ok(result.warnings.some((warning) => /保留该原始标签/u.test(warning)));
});

test('手写无source正确H3可继续使用当前编号，未知标签不删除或猜测', () => {
  const { project, draft } = fixture();
  draft.source = undefined; draft.prompt = prompt.replaceAll('<Picture 9>', '<Picture 2>').replaceAll('<Picture 8>', '<Picture 4>').replaceAll('<Picture 7>', '<Picture 5>');
  const result = prepareVideoH3ReferenceDraft(project, draft, context);
  assert.equal(result.issue, undefined); assert.equal(result.draft.prompt, draft.prompt);
  draft.prompt = prompt;
  const unproven = prepareVideoH3ReferenceDraft(project, draft, context);
  assert.equal(unproven.draft.prompt, prompt); assert.equal(unproven.issue, undefined);
});

test('真冻结重试沿用源清单，不能借当前board新manifest重解释旧序号', () => {
  const { project, board, draft } = fixture();
  draft.h3ReferenceBinding = videoH3BindingForPrompt(project, draft);
  draft.reuseTaskId = 'frozen-original';
  board.targetOutput!.referenceManifest = [{ token: '<Picture 9>', id: 'asset-6' }];
  const unchanged = structuredClone(draft);
  const result = prepareVideoH3ReferenceDraft(project, draft, context);
  assert.equal(result.draft, draft); assert.deepEqual(result.draft, unchanged);
  assert.equal(result.draft.source?.language, undefined, 'frozen legacy metadata is not rewritten from the current board');
  const edited = { ...draft, reuseTaskId: undefined };
  const updated = prepareVideoH3ReferenceDraft(project, edited, context);
  assert.deepEqual(collectVideoPictureReferenceNumbers(updated.draft.prompt), [2, 4, 5], 'explicitly editing selections uses the frozen original provenance, not current board metadata');
});

test('人工改过原稿或冲突manifest ID不建立假对应', () => {
  const { project, board, draft } = fixture();
  const edited = { ...draft, prompt: `${prompt}\n人工新增原文。` };
  assert.equal(prepareVideoH3ReferenceDraft(project, edited, context).draft.prompt, edited.prompt);
  board.targetOutput!.referenceManifest = [{ token: '<Picture 9>', id: 'asset-1', assetId: 'asset-6' }];
  assert.deepEqual(videoH3BindingForPrompt(project, draft)?.sourcePictures, []);
  assert.equal(prepareVideoH3ReferenceDraft(project, draft, context).draft.prompt, prompt);
});

test('尾帧先插入真实槽，再按最终映射同步旧Picture，未预猜dense编号', () => {
  const { project, draft } = fixture();
  draft.references = [1, 2, 3].map((index) => ({ assetId: `asset-${index}`, role: 'general' }));
  const tail = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
  const finalDraft = { ...tail.draft, references: [
    { assetId: 'asset-6', role: 'first-frame' as const },
    ...tail.draft.references.map((reference) => ({ ...reference, slotIndex: undefined })),
  ] };
  assert.equal(tail.draft.prompt, prompt, 'tail preparation keeps the immutable source before final slot placement');
  assert.deepEqual(collectVideoPictureReferenceNumbers(prepareVideoH3ReferenceDraft(project, finalDraft, context).draft.prompt), [2, 3, 4]);
});

test('显式增加新图片解除冻结快照，重复选择和源任务本身不改写', () => {
  const { project, draft } = fixture(); draft.reuseTaskId = 'frozen-original';
  const unchanged = structuredClone(draft);
  assert.equal(addVideoDraftAssets(draft, ['asset-7'], project.assets).reuseTaskId, undefined);
  assert.equal(addVideoDraftAssets(draft, ['asset-1'], project.assets).reuseTaskId, 'frozen-original');
  assert.deepEqual(draft, unchanged);
});

test('不带图片选择新提示词也解除原任务冻结，保留当前选图', () => {
  const { project, board, draft } = fixture(); draft.reuseTaskId = 'frozen-original';
  const changed = applyVideoPromptChoice(draft, {
    id: `${board.id}:zh`, storyboardId: board.id, label: '新的选择', language: 'zh',
    prompt, durationSec: 15, updatedAt: 1, version: 'fixture',
  }, project, false);
  assert.equal(changed.reuseTaskId, undefined); assert.deepEqual(changed.references, draft.references);
  assert.deepEqual(changed.h3ReferenceBinding?.sourcePictures?.map((entry) => entry.number), [9, 8, 7]);
});

console.log(`H3 picture manifest synchronization tests passed: ${groups} groups`);
