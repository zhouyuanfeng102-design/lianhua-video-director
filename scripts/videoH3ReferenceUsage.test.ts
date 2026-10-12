import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { getH3PromptProtocolIssue, readH3PromptProtocol } from '../src/h3PromptProtocol';
import { prepareVideoH3ReferenceDraft } from '../src/videoH3ReferenceBinding';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { moveVideoReference, removeVideoReference, videoReferenceSelection } from '../src/videoReferenceSlots';
import type { Character, H3IdentityBindings, ReferenceAsset, Storyboard, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';

let groups = 0;
const test = (name: string, run: () => void) => { run(); console.log(`PASS ${++groups} ${name}`); };
const imageNodes = ['141', '142', '143', '161', '175', '176'];
const api: VideoTaskApiConfig = {
  enabled: true, provider: 'runninghub', endpoint: 'https://reference-usage.test.invalid/run',
  statusEndpointTemplate: 'https://reference-usage.test.invalid/task/{id}', apiKey: '',
  authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url',
  runningHubImageRoles: ['general', 'general', 'general', 'general', 'general', 'general'],
  requestTemplate: JSON.stringify({ nodeInfoList: [
    { nodeId: '150', fieldName: 'value', fieldValue: '{{prompt}}' },
    ...imageNodes.map((nodeId, index) => ({ nodeId, fieldName: 'image', fieldValue: `{{image_${index + 1}}}` })),
    { nodeId: '186', fieldName: 'value', fieldValue: 15 },
  ] }),
  runningHubMappedFields: [{ nodeId: '150', fieldName: 'value', kind: 'prompt' },
    ...imageNodes.map((nodeId, imageIndex) => ({ nodeId, fieldName: 'image', kind: 'image' as const, imageIndex }))],
};
const asset = (id: string, role: ReferenceAsset['role'], type: ReferenceAsset['type']): ReferenceAsset => ({
  id, name: id, role, type, tags: [], dataUrl: 'data:image/png;base64,AAAA', createdAt: 1, updatedAt: 1,
});
const person = (id: string, name: string): Character => ({ id, name, assetIds: [`${id}-image`],
  gender: '', race: '', apparentAge: '', appearance: '', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' });
const fixture = (language: 'zh' | 'en' = 'en') => {
  const project = createInitialState().project;
  project.id = 'reference-usage-project'; project.characters = [person('mare', '马雷'), person('zesshi', '绝死绝命')];
  project.assets = [asset('opening', 'first-frame', 'first-frame'), asset('ending', 'last-frame', 'last-frame'),
    asset('hall', 'scene', 'location'), ...project.characters.map((character) => ({
      ...asset(`${character.id}-image`, 'character', 'character'), sourceEntityKind: 'character' as const, sourceEntityId: character.id,
    }))];
  project.locations = []; project.props = []; project.generationTasks = [];
  const anchors = language === 'en' ? ['Identity: 马雷, holding a wooden staff.', 'Identity: 绝死绝命, holding a scythe.']
    : ['人物身份：马雷，手持木杖。', '人物身份：绝死绝命，手持镰刀。'];
  const action = language === 'en'
    ? 'Zesshi faces Mare across the doorway. Her gaze, chest and forward kick point toward him.'
    : '绝死绝命与马雷隔门相向，视线、胸口与向前踢出的右脚均朝向马雷。';
  const prompt = `integrated_multimodal_description:\n[Shot 1] ${anchors.join(' ')} ${action}\n[Shot 2] At 00:04.000 ${action}\n[Shot 3] At 00:10.000 ${language === 'en' ? 'Mare steadies himself.' : '马雷站稳。'} <sound>撞击声</sound>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
  const identities: H3IdentityBindings = { version: 1, characters: project.characters.map((character, index) => ({
    characterId: character.id, name: character.name, referenceAnchor: anchors[index],
  })) };
  const board = { id: 'saved-board', sceneId: '', shots: [], finalPrompt: prompt, officialPromptZh: prompt,
    officialPromptEn: prompt, officialPromptEnSource: prompt, h3IdentityBindings: identities, h3IdentityBindingsEn: identities,
    targetOutput: { targetModel: 'minimax-h3', prompt, referenceManifest: [], warnings: [] },
  } as unknown as Storyboard;
  project.storyboards = [board];
  const draft: VideoGenerationDraft = { name: '空清单五图', prompt, backend: 'api', parameters: {},
    source: { storyboardId: board.id, language },
    ...videoReferenceSelection(project.assets.map((entry) => ({ assetId: entry.id, role: entry.role }))),
  };
  return { project, draft, action, board };
};
const prepare = (input: ReturnType<typeof fixture>, draft = input.draft, connection = api) => (
  prepareVideoH3ReferenceDraft(input.project, draft, { backend: 'api', api: connection })
);
const nodesFor = (draft: VideoGenerationDraft) => {
  const body = buildVideoApiBody(api, draft, draft.references.map((reference) => `uploaded/${reference.assetId}.png`));
  return new Map((body.nodeInfoList as Array<{ nodeId: string; fieldValue: unknown }>).map((entry) => [entry.nodeId, entry.fieldValue]));
};

test('空manifest五图的用途与人物身份到达实际RunningHub提示词节点，双语与镜头保持', () => {
  for (const language of ['zh', 'en'] as const) {
    const input = fixture(language); const before = structuredClone(input);
    const result = prepare(input);
    assert.deepEqual(result.draft.h3ReferenceBinding?.sourcePictures, [], 'selected slots never fabricate historical provenance');
    assert.equal(result.draft.h3ReferenceBinding?.basePrompt, input.draft.prompt);
    assert.match(result.draft.prompt, language === 'en' ? /<Picture 1> opening composition reference/u : /<Picture 1> 开场构图参考/u);
    assert.match(result.draft.prompt, language === 'en' ? /<Picture 2> ending composition reference/u : /<Picture 2> 结束构图参考/u);
    assert.match(result.draft.prompt, language === 'en' ? /<Picture 3> environment layout and lighting reference/u : /<Picture 3> 场景空间与光照参考/u);
    assert.match(result.draft.prompt, /Visual identity reference for 马雷: <Picture 4>/u);
    assert.match(result.draft.prompt, /Visual identity reference for 绝死绝命: <Picture 5>/u);
    assert.equal(result.draft.prompt.split(input.action).length, 3, 'the authored actions are unchanged');
    assert.deepEqual(readH3PromptProtocol(result.draft.prompt)?.shots, readH3PromptProtocol(input.draft.prompt)?.shots);
    assert.equal(getH3PromptProtocolIssue(result.draft.prompt, input.draft.prompt, [1, 2, 3, 4, 5].map((n) => `<Picture ${n}>`)), undefined);
    assert.doesNotMatch(result.draft.prompt, /enforce.*frame|must match.*frame|强制.*关键帧|必须.*首帧/u);
    const nodes = nodesFor(result.draft);
    assert.equal(nodes.get('150'), result.draft.prompt);
    for (const [index, reference] of input.draft.references.entries()) assert.equal(nodes.get(imageNodes[index]), `uploaded/${reference.assetId}.png`);
    assert.equal(nodes.get('176'), ''); assert.equal(nodes.get('186'), 15);
    assert.equal(prepare(input, result.draft).draft.prompt, result.draft.prompt, 'preview and submit are idempotent');
    assert.equal(prepare(input, { ...result.draft, references: [] }).draft.prompt, input.draft.prompt, 'deselecting restores the authored text');
    assert.deepEqual(input, before, 'project, original prompt, references and source manifest are not rewritten');
  }
});

test('取消与重排按物理槽更新用途，通用数组仍使用实际发送序号', () => {
  const input = fixture(); const initial = prepare(input).draft;
  const removed = prepare(input, { ...initial, ...removeVideoReference(initial, 'opening') }).draft;
  assert.doesNotMatch(removed.prompt, /<Picture 1>/u);
  assert.match(removed.prompt, /<Picture 2> ending composition reference/u);
  assert.match(removed.prompt, /<Picture 3> environment layout and lighting reference/u);
  const nodes = nodesFor(removed);
  assert.equal(nodes.get('141'), ''); assert.equal(nodes.get('142'), 'uploaded/ending.png');
  assert.equal(nodes.get('143'), 'uploaded/hall.png'); assert.equal(nodes.get('150'), removed.prompt);
  const dense = prepare(input, removed, { ...api, provider: 'generic', requestTemplate: undefined }).draft;
  assert.match(dense.prompt, /<Picture 1> ending composition reference/u);
  assert.match(dense.prompt, /<Picture 2> environment layout and lighting reference/u);
  const swapped = prepare(input, { ...initial, ...videoReferenceSelection(moveVideoReference(initial.references, 0, 1)) }).draft;
  assert.match(swapped.prompt, /<Picture 1> ending composition reference/u);
  assert.match(swapped.prompt, /<Picture 2> opening composition reference/u);
  const reorderedNodes = nodesFor(swapped);
  assert.equal(reorderedNodes.get('141'), 'uploaded/ending.png'); assert.equal(reorderedNodes.get('142'), 'uploaded/opening.png');
  assert.equal(prepare(input, swapped).draft.prompt, swapped.prompt);
});

test('已有清单的用途保留并按资产重映射，未证明的旧编号不会叠加第二套用途', () => {
  const input = fixture();
  const original = input.draft.prompt.replace('[Shot 1]', '[Shot 1] Environment from <Picture 9>.');
  const prepared = prepare(input).draft;
  const draft: VideoGenerationDraft = { ...prepared, prompt: original, h3ReferenceBinding: { ...prepared.h3ReferenceBinding!,
    basePrompt: original, renderedPrompt: original, sourcePictures: [{ number: 9, assetId: 'hall' }] } };
  const result = prepare(input, draft).draft;
  assert.match(result.prompt, /Environment from <Picture 3>/u);
  assert.doesNotMatch(result.prompt, /<Picture 3> environment layout/u, 'do not duplicate an authored image use');
  assert.match(result.prompt, /<Picture 1> opening composition reference/u);
  assert.match(result.prompt, /<Picture 2> ending composition reference/u);
  assert.equal(nodesFor(result).get('150'), result.prompt);
  const unproven = prepare(input, { ...draft, h3ReferenceBinding: { ...draft.h3ReferenceBinding!, sourcePictures: [] } });
  assert.equal(unproven.draft.prompt, original, 'unknown old tags are not reinterpreted from today\'s image order');
  assert.ok(unproven.warnings.some((warning) => warning.includes('未附加冲突引用')));
});

test('手改、冻结重试、无来源及未声明图片槽顺序继续保留正文', () => {
  const input = fixture(); const rendered = prepare(input).draft;
  const manual = { ...rendered, prompt: `${rendered.prompt}\n用户手改保留。` };
  assert.equal(prepare(input, manual).draft.prompt, manual.prompt);
  const frozen = { ...input.draft, reuseTaskId: 'historical-task' };
  assert.equal(prepare(input, frozen).draft, frozen);
  const noSource = { ...input.draft, source: undefined };
  assert.equal(prepare(input, noSource).draft.prompt, noSource.prompt);
  assert.equal(prepare(input, input.draft, { ...api, runningHubMappedFields: undefined }).draft.prompt, input.draft.prompt);
});

test('六字段稿保持首镜与At切点，新增用途不污染对白或声音字面量', () => {
  const input = fixture('zh');
  const prepared = prepare(input).draft;
  const anchors = prepared.h3ReferenceBinding!.identities.characters.map((identity) => identity.referenceAnchor);
  const original = input.draft.prompt.replace('integrated_multimodal_description:',
    `subject_definitions:\n${anchors.join('\n')}\nsummary:\n人物交锋。\nretention_analysis:\n保留身份。\ndetailed_description:`)
    .replace(`[Shot 1] ${anchors.join(' ')}`, '[Shot 1]')
    .replace('撞击声', '原样<Picture 2>撞击声');
  const draft = { ...prepared, prompt: original, h3ReferenceBinding: { ...prepared.h3ReferenceBinding!, basePrompt: original, renderedPrompt: original } };
  const result = prepare(input, draft).draft;
  assert.equal(getH3PromptProtocolIssue(result.prompt, original, [1, 2, 3, 4, 5].map((n) => `<Picture ${n}>`)), undefined);
  assert.match(result.prompt, /<Picture 2> 结束构图参考/u, 'a protected literal is not an existing image binding');
  assert.match(result.prompt, /<sound>原样<Picture 2>撞击声<\/sound>/u);
  assert.deepEqual(readH3PromptProtocol(result.prompt)?.sections, readH3PromptProtocol(original)?.sections);
});

test('一图兼有明确人物身份与构图用途时两种职责都保留', () => {
  const input = fixture();
  input.draft.references[0].characterIds = ['mare', 'zesshi'];
  const result = prepare(input).draft;
  assert.match(result.prompt, /<Picture 1> opening composition reference/u);
  assert.match(result.prompt, /Visual identity reference for 马雷: <Picture 1>, <Picture 4>/u);
  assert.match(result.prompt, /Visual identity reference for 绝死绝命: <Picture 1>, <Picture 5>/u);
  assert.equal(prepare(input, result).draft.prompt, result.prompt);
});

console.log(`${groups} H3 reference-use groups passed (synthetic fixtures and local request serialization only).`);
