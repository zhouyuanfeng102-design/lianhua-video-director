import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { getH3PromptProtocolIssue, readH3PromptProtocol } from '../src/h3PromptProtocol';
import { isVideoH3ReferenceInfo, prepareVideoH3ReferenceDraft, videoH3PictureNumbers, videoH3ReferenceCharacterIds, videoReferenceCharacterOwners, videoReferenceLocationOwners } from '../src/videoH3ReferenceBinding';
import { prepareVideoTailCharacterDraft } from '../src/videoTailCharacters';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { addVideoReference, removeVideoReference } from '../src/videoReferenceSlots';
import { videoBatchTailReferences } from '../src/videoBatch';
import type { Character, H3IdentityBindings, Project, ReferenceAsset, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

let groups = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); console.log(`PASS ${++groups} ${name}`); };
const api: VideoTaskApiConfig = { enabled: true, provider: 'generic', endpoint: 'https://h3-binding.test.invalid/generate',
  statusEndpointTemplate: 'https://h3-binding.test.invalid/task/{id}', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', model: 'mock-model' };
const character = (id: string, name: string, assetIds: string[]): Character => ({ id, name, assetIds,
  gender: '', race: '人类', apparentAge: '成年', appearance: '稳定身份', outfit: '蓝衣', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' });
const image = (id: string, characterId?: string): ReferenceAsset => ({ id, name: `任意文件名${id}`, role: 'character', type: 'character',
  sourceEntityId: characterId, sourceEntityKind: characterId ? 'character' : undefined, dataUrl: 'data:image/png;base64,AAAA',
  tags: [], createdAt: 1, updatedAt: 1 });
const anchorA = 'Identity: 甲 (S2), black hair and blue robe.';
const anchorB = 'Identity: 乙 (S1), brown hair and white robe.';
const originalPrompt = `integrated_multimodal_description:\n[Shot 1] ${anchorA} ${anchorB}\n本段0–4秒：乙 (S1) 画内发话 <d>[Chinese] 请把地图给我。</d>，甲倾听。\n[Shot 2] At 00:07.500 本段8–12秒：甲 (S2) 回答 <d>[Chinese] 好，我们一起走。</d>，乙倾听。<sound>脚步声</sound>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const identities: H3IdentityBindings = { version: 1, characters: [
  { characterId: 'a', name: '甲', speakerToken: '(S2)', referenceAnchor: anchorA },
  { characterId: 'b', name: '乙', speakerToken: '(S1)', referenceAnchor: anchorB },
] };
const fixture = (): { project: Project; draft: VideoGenerationDraft } => {
  const project = createInitialState().project;
  project.id = 'binding-project'; project.characters = [character('a', '甲', ['a-image']), character('b', '乙', ['b-image'])];
  project.assets = [image('a-image', 'a'), image('b-image', 'b'), { ...image('tail'), type: 'first-frame', role: 'first-frame' }];
  project.locations = []; project.props = []; project.storyboards = []; project.generationTasks = [];
  const draft: VideoGenerationDraft = { name: '合成绑定测试', prompt: originalPrompt, backend: 'api', parameters: { duration: 15, seed: 9 },
    references: [{ assetId: 'tail', role: 'first-frame' }, { assetId: 'a-image', role: 'character', slotIndex: 2 }, { assetId: 'b-image', role: 'character', slotIndex: 4 }],
    h3ReferenceBinding: { version: 1, projectId: project.id, basePrompt: originalPrompt, renderedPrompt: originalPrompt, identities: structuredClone(identities) } };
  return { project, draft };
};
const cloud = (): VideoTaskApiConfig => ({ ...api, provider: 'runninghub', runningHubImageRoles: ['first-frame', 'character', 'character', 'character', 'character'],
  requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'p', fieldName: 'value', fieldValue: '' }, ...Array.from({ length: 5 }, (_, index) => ({ nodeId: `i${index}`, fieldName: 'image', fieldValue: '' }))] }),
  runningHubMappedFields: [{ nodeId: 'p', fieldName: 'value', kind: 'prompt' }, ...Array.from({ length: 5 }, (_, imageIndex) => ({ nodeId: `i${imageIndex}`, fieldName: 'image', kind: 'image' as const, imageIndex }))] });
const literals = (value: string): string[] => [...value.matchAll(/<(?:d|sound)>[\s\S]*?<\/(?:d|sound)>/gu)].map((match) => match[0]);
const scenePrompt = (scene: number | null = 9, person: number | null = 8, prop: number | null = 7): string => {
  const source = (number: number | null) => number === null ? 'defined by the canonical prompt' : `referenced from <Picture ${number}>`;
  const retention = (number: number | null) => number === null ? '' : `reference <Picture ${number}>`;
  return `subject_definitions:\n<Subject 9> is 山门 ${source(scene)}: 原样石门描述。\n<Subject 2> is 甲 ${source(person)}: ${anchorA}\n<Subject 7> is 剑 ${source(prop)}: 原样木剑描述。\nsummary:\n沿路前行。\nretention_analysis:\n<Subject 9> ${retention(scene)}; <Subject 2> ${retention(person)}; <Subject 7> ${retention(prop)}.\ndetailed_description:\n[Shot 1] 甲走过石门；<d>[Chinese] 保留<Picture 9>和[Pic8]。</d>。他说“<Picture 7>”，<sound>原样<Picture 9></sound>。\n[Shot 2] At 00:07.500 甲看向远方。\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
};
const sceneFixture = () => {
  const { project, draft } = fixture();
  project.locations = [{ id: 'gate', name: '山门', description: '', timeWeather: '', lighting: '', palette: '', fixedProps: '', anchor: '', assetIds: ['scene-old'] }];
  project.assets.push(
    { ...image('scene-old'), name: '山门', type: 'location', role: 'scene' },
    { ...image('scene-new'), name: '另一文件名', type: 'location', role: 'scene', sourceEntityKind: 'location', sourceEntityId: 'gate' },
    { ...image('prop-old'), type: 'prop', role: 'prop' },
  );
  draft.prompt = scenePrompt();
  draft.h3ReferenceBinding = { version: 1, projectId: project.id, basePrompt: draft.prompt, renderedPrompt: draft.prompt,
    identities: { version: 1, characters: [structuredClone(identities.characters[0])] },
    sourcePictures: [{ number: 9, assetId: 'scene-old' }, { number: 8, assetId: 'a-image' }, { number: 7, assetId: 'prop-old' }] };
  return { project, draft };
};

await test('稀疏RunningHub按明确物理槽引用，而通用数组使用真实发送序号', () => {
  const { project, draft } = fixture();
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
  assert.ok(result.warnings.some((warning) => warning.includes('不能由本地映射核实')));
  assert.match(result.draft.prompt, /甲 \(S2\): <Picture 3>/u);
  assert.match(result.draft.prompt, /乙 \(S1\): <Picture 5>/u);
  const dense = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assert.match(dense.draft.prompt, /甲 \(S2\): <Picture 2>/u);
  assert.match(dense.draft.prompt, /乙 \(S1\): <Picture 3>/u);
  const body = buildVideoApiBody(cloud(), { ...result.draft, parameters: {} }, ['tail.png', 'a.png', 'b.png']);
  const fields = body.nodeInfoList as Array<{ nodeId: string; fieldValue: string }>;
  assert.equal(fields.find((field) => field.nodeId === 'p')?.fieldValue, result.draft.prompt);
  assert.equal(fields.find((field) => field.nodeId === 'i2')?.fieldValue, 'a.png');
  assert.equal(fields.find((field) => field.nodeId === 'i4')?.fieldValue, 'b.png');
  assert.equal(fields.find((field) => field.nodeId === 'i1')?.fieldValue, '');
});

await test('选图只增显式身份引用，镜数切点对白动作声音逐字不动且可逆幂等', () => {
  const { project, draft } = fixture(); const before = structuredClone({ project, draft });
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  const protocol = readH3PromptProtocol(result.draft.prompt)!;
  assert.deepEqual(protocol.sections, readH3PromptProtocol(originalPrompt)!.sections);
  assert.deepEqual(protocol.shots, readH3PromptProtocol(originalPrompt)!.shots);
  assert.deepEqual(literals(result.draft.prompt), literals(originalPrompt));
  assert.equal(result.draft.prompt.slice(result.draft.prompt.indexOf('本段0')), originalPrompt.slice(originalPrompt.indexOf('本段0')));
  assert.equal(prepareVideoH3ReferenceDraft(project, result.draft, { backend: 'api', api }).draft.prompt, result.draft.prompt);
  assert.equal(prepareVideoH3ReferenceDraft(project, { ...result.draft, references: [] }, { backend: 'api', api }).draft.prompt, originalPrompt);
  assert.deepEqual({ project, draft }, before);
});

await test('只报告本次选图涉及的人物；无选图不逐人刷警告，映射说明与失效区分', () => {
  const { project, draft } = fixture();
  draft.h3ReferenceBinding!.identities.characters.forEach((identity) => { identity.referenceAnchor += '已脱节'; });
  const noPictures = prepareVideoH3ReferenceDraft(project, { ...draft, references: [] }, { backend: 'api', api: cloud() });
  assert.deepEqual(noPictures.warnings, []);
  const selected = prepareVideoH3ReferenceDraft(project, { ...draft, references: [{ assetId: 'a-image', role: 'character' }] }, { backend: 'api', api: cloud() });
  const failures = selected.warnings.filter((message) => !isVideoH3ReferenceInfo(message));
  assert.equal(failures.length, 1); assert.match(failures[0], /人物“甲”.*不在当前语言的正文中/u); assert.doesNotMatch(failures[0], /人物“乙”/u);
  assert.equal(selected.warnings.filter(isVideoH3ReferenceInfo).length, 1);
  assert.equal(selected.draft.prompt, draft.prompt);
  const missing = prepareVideoH3ReferenceDraft(project, { ...draft, h3ReferenceBinding: undefined }, { backend: 'api', api });
  assert.ok(missing.warnings.some((message) => message.includes('没有可信的可定位人物绑定')));
});

await test('语义分段沿用冻结人物原名，以同ID当前图片归属绑定，不受live改名误报', () => {
  const { project, draft } = fixture();
  const frozenCharacters = structuredClone(project.characters);
  project.sequencePlans = [{ id: 'frozen-plan', planningMode: 'semantic-segments', semanticPlanningSnapshot: { version: 1, characterContinuity: frozenCharacters } } as unknown as Project['sequencePlans'][number]];
  project.storyboards = [{ id: 'frozen-board', sequencePlanId: 'frozen-plan', sceneId: '', officialPromptZh: draft.prompt, h3IdentityBindings: structuredClone(identities) } as Project['storyboards'][number]];
  draft.source = { storyboardId: 'frozen-board', language: 'zh' };
  project.characters[0].name = '甲后来修改的名字'; project.characters[1].name = '乙后来修改的名字';
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assert.deepEqual(result.warnings, []);
  assert.match(result.draft.prompt, /甲 \(S2\): <Picture 2>/u);
  assert.match(result.draft.prompt, /乙 \(S1\): <Picture 3>/u);
  assert.deepEqual(videoH3ReferenceCharacterIds(project, draft), ['a', 'b']);
  const explicit = { ...draft, references: [{ assetId: 'a-image', role: 'general' as const, characterIds: ['b'] }] };
  assert.deepEqual(videoH3ReferenceCharacterIds(project, explicit), ['b']);
  assert.match(prepareVideoH3ReferenceDraft(project, explicit, { backend: 'api', api }).draft.prompt, /乙 \(S1\): <Picture 1>/u);
});

await test('多人合照与同一人物多图都按明确资产归属，不构造一图一人', () => {
  const { project, draft } = fixture(); project.assets.push(image('group'), image('a-second', 'a'));
  project.characters[0].assetIds.push('group', 'a-second'); project.characters[1].assetIds.push('group');
  draft.references = [{ assetId: 'group', role: 'character' }, { assetId: 'a-second', role: 'character' }];
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assert.match(result.draft.prompt, /甲 \(S2\): <Picture 1>, <Picture 2>/u);
  assert.match(result.draft.prompt, /乙 \(S1\): <Picture 1>/u);
  assert.equal((result.draft.prompt.match(/Identity:/gu) || []).length, 2);
});

await test('姓名和形态不猜测，显式sourceEntity证据优先并排除跨类型碰撞', () => {
  const { project } = fixture(); project.characters.push({ ...character('a-form', '甲的兽形', ['form']), baseName: '甲', formLabel: '兽形', variantOf: '甲' });
  project.assets.push(image('form', 'a-form'), { ...image('filename-only'), name: '甲的兽形参考图.png' });
  assert.deepEqual(videoReferenceCharacterOwners(project, project.assets.at(-2)!).map((owner) => owner.id), ['a-form']);
  assert.deepEqual(videoReferenceCharacterOwners(project, project.assets.at(-1)!), []);
  project.assets[0].sourceEntityKind = undefined;
  assert.deepEqual(videoReferenceCharacterOwners(project, project.assets[0]).map((owner) => owner.id), ['a']);
  project.locations.push({ id: 'a', name: '同ID错误场景', description: '', timeWeather: '', lighting: '', palette: '', fixedProps: '', anchor: '', assetIds: [] });
  assert.deepEqual(videoReferenceCharacterOwners(project, project.assets[0]), []);
  project.assets[0].sourceEntityKind = 'location';
  assert.deepEqual(videoReferenceCharacterOwners(project, project.assets[0]), []);
});

await test('归档旧人物不参与当前归属或隐式补图，已冻结任务正文与图片快照保持', () => {
  const { project, draft } = fixture();
  const frozen = { ...structuredClone(draft), reuseTaskId: 'original-frozen-task', h3ReferenceWarnings: ['原提示'] };
  project.characters[0].dossier = { archivedIntoCharacterId: 'a-custom' };
  project.characters.push({ ...character('a-custom', '甲', ['a-image']), appearance: '用户外貌' });
  const before = structuredClone({ project, frozen });
  assert.deepEqual(videoReferenceCharacterOwners(project, project.assets[0]), [], 'stale sourceEntityId is not guessed into a replacement');
  assert.deepEqual(videoReferenceCharacterOwners(project, project.assets[0], { assetId: 'a-image', role: 'character', characterIds: ['a'] }), []);
  assert.deepEqual(videoReferenceCharacterOwners(project, project.assets[0], { assetId: 'a-image', role: 'character', characterIds: ['a-custom'] }).map((item) => item.id), ['a-custom']);
  const noProvenance = image('shared-no-provenance');
  project.assets.push(noProvenance);
  project.characters[0].assetIds.push(noProvenance.id);
  project.characters[2].assetIds.push(noProvenance.id);
  assert.deepEqual(videoReferenceCharacterOwners(project, noProvenance).map((item) => item.id), ['a-custom']);
  const retry = prepareVideoH3ReferenceDraft(project, frozen, { backend: 'api', api });
  assert.deepEqual(retry.draft, before.frozen);
  assert.equal(retry.draft, frozen, 'valid retries return the existing frozen draft');
  assert.deepEqual(project.characters[0].dossier, before.project.characters[0].dossier);
});

await test('本段可明确为未归属合照选择多个人物，空选择不借用资产旧归属', () => {
  const { project, draft } = fixture(); project.assets.push(image('anonymous'));
  draft.references = [{ assetId: 'anonymous', role: 'general', characterIds: ['a', 'b'] }];
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assert.match(result.draft.prompt, /甲 \(S2\): <Picture 1>/u); assert.match(result.draft.prompt, /乙 \(S1\): <Picture 1>/u);
  draft.references = [{ assetId: 'a-image', role: 'character', characterIds: [] }];
  assert.equal(prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api }).draft.prompt, originalPrompt);
});

await test('损坏的显式人物绑定一律未绑定并提示，不借用资产归属、不改变槽位或冻结稿', () => {
  for (const malformed of [null, 123, false, 'a', { id: 'a' }, ['a', null], ['a', 1], Array(1)]) {
    const { project, draft } = fixture();
    draft.references = [{ assetId: 'a-image', role: 'character', slotIndex: 2, characterIds: malformed as unknown as string[] }];
    const original = structuredClone(draft);
    assert.deepEqual(videoReferenceCharacterOwners(project, project.assets[0], draft.references[0]), [], 'invalid explicit data never falls back to the asset owner');
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
    assert.equal(result.draft.prompt, originalPrompt);
    assert.ok(result.warnings.some((warning) => /图片槽 3.*人物绑定资料格式无效.*不阻止生成/u.test(warning)));
    assert.deepEqual(result.draft.references, original.references, 'warnings cannot normalize or reorder the persisted selection');
    assert.equal(buildVideoApiBody(api, result.draft, ['a.png']).prompt, originalPrompt, 'invalid optional identity metadata does not block request serialization');
    const frozen = { ...draft, prompt: `${originalPrompt}\n已冻结正文保持。`, reuseTaskId: 'frozen-task', h3ReferenceWarnings: ['既有提示'] };
    const retry = prepareVideoH3ReferenceDraft(project, frozen, { backend: 'api', api });
    assert.equal(retry.draft.prompt, frozen.prompt);
    assert.deepEqual(retry.draft.references, original.references);
    assert.ok(retry.warnings.includes('既有提示'));
    assert.ok(retry.warnings.some((warning) => warning.includes('人物绑定资料格式无效')));
    assert.deepEqual(draft, original);
  }
});

await test('取消首图保留其他用途与物理槽，新图补回空槽，引用跟随真实上传顺序', () => {
  const { project, draft } = fixture(); project.assets.push(image('a-second', 'a'));
  draft.references = [{ assetId: 'a-image', role: 'character' }, { assetId: 'b-image', role: 'subject' }];
  let selection = removeVideoReference(draft, 'a-image');
  assert.equal(selection.references[0].slotIndex, 1); assert.equal(selection.references[0].role, 'subject');
  selection = addVideoReference(selection, { assetId: 'a-second', role: 'general' });
  assert.deepEqual(selection.references.map((reference) => [reference.assetId, reference.role]), [['a-second', 'character'], ['b-image', 'subject']]);
  const result = prepareVideoH3ReferenceDraft(project, { ...draft, ...selection }, { backend: 'api', api: cloud() });
  assert.match(result.draft.prompt, /甲 \(S2\): <Picture 1>/u); assert.match(result.draft.prompt, /乙 \(S1\): <Picture 2>/u);
});

await test('旧稿无metadata、跨项目、人工改稿或失效anchor仅提示绝不覆盖当前正文', () => {
  const { project, draft } = fixture();
  for (const changed of [
    { ...draft, h3ReferenceBinding: undefined },
    { ...draft, h3ReferenceBinding: { ...draft.h3ReferenceBinding!, projectId: 'other-project' } },
    { ...draft, prompt: `${originalPrompt}\n人工修改保留。` },
  ]) {
    const result = prepareVideoH3ReferenceDraft(project, changed, { backend: 'api', api });
    assert.equal(result.draft.prompt, changed.prompt); assert.ok(result.warnings.length);
  }
  draft.h3ReferenceBinding!.identities.characters[0].referenceAnchor = '<d>[Chinese] 请把地图给我。</d>';
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assert.deepEqual(literals(result.draft.prompt), literals(originalPrompt)); assert.ok(result.warnings.some((warning) => warning.includes('锚点已失效')));
});

await test('不明自定义模板、首尾帧专用接口不虚构Picture顺序，不阻断', () => {
  const { project, draft } = fixture();
  for (const connection of [{ ...api, requestTemplate: '{"prompt":"{{prompt}}","x":"{{image_3}}"}' }, { ...api, provider: 'minimax' as const }, { ...cloud(), runningHubMappedFields: undefined }]) {
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: connection });
    assert.equal(result.draft.prompt, originalPrompt); assert.ok(result.warnings.length);
  }
  assert.deepEqual(videoH3PictureNumbers(draft.references, { backend: 'api', api: { ...api, requestTemplate: '{"prompt":"{{prompt}}","photos":"{{images}}"}' } }).numbers, [1, 2, 3]);
});

await test('重复声源或Subject与损坏元数据仅警告，不本地重分配人物编号', () => {
  for (const key of ['speakerToken', 'subjectToken'] as const) {
    const { project, draft } = fixture(); const bindings = draft.h3ReferenceBinding!.identities.characters;
    if (key === 'speakerToken') bindings[1].speakerToken = bindings[0].speakerToken;
    else { bindings[0].subjectToken = '<Subject 2>'; bindings[1].subjectToken = '<Subject 2>'; }
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
    assert.equal(result.draft.prompt, originalPrompt); assert.ok(result.warnings.some((warning) => warning.includes('编号被多个绑定记录共用')));
  }
  const { project, draft } = fixture();
  const corrupt = { ...draft, h3ReferenceBinding: { ...draft.h3ReferenceBinding!, identities: { version: 1, characters: {} } } } as unknown as VideoGenerationDraft;
  const result = prepareVideoH3ReferenceDraft(project, corrupt, { backend: 'api', api });
  assert.equal(result.draft.prompt, originalPrompt); assert.ok(result.warnings.length);
});

await test('尾帧组合在最终物理映射时才序列化，Picture/Subject/声源编号不互换', () => {
  const { project, draft } = fixture(); draft.references = draft.references.slice(1).map((reference) => ({ ...reference, slotIndex: undefined }));
  const prepared = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
  assert.equal(prepared.issue, undefined); assert.equal(prepared.draft.prompt, originalPrompt);
  const references = videoBatchTailReferences(prepared.draft.references, { mode: 'prepend', index: 0, role: 'first-frame' }, 'tail');
  const result = prepareVideoH3ReferenceDraft(project, { ...prepared.draft, references }, { backend: 'api', api });
  assert.match(result.draft.prompt, /甲 \(S2\): <Picture 2>/u); assert.match(result.draft.prompt, /乙 \(S1\): <Picture 3>/u);
  assert.doesNotMatch(result.draft.prompt, /<Subject|\(S3\)/u);
});

await test('六字段仅在AI给定Subject身份句后加引用，详细镜头正文和音轨字节保持', () => {
  const { project, draft } = fixture();
  const identity = '<Subject 7> is 甲 (S2), black hair and blue robe.';
  const prompt = `subject_definitions:\n${identity}\nsummary:\nA walk.\nretention_analysis:\n<Subject 7> preserved.\ndetailed_description:\n[Shot 1] <Subject 7> (S2) says <d>[Chinese] 好，我们一起走。</d>.\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
  draft.prompt = prompt; draft.h3ReferenceBinding = { version: 1, projectId: project.id, basePrompt: prompt, renderedPrompt: prompt,
    identities: { version: 1, characters: [{ characterId: 'a', name: '甲', speakerToken: '(S2)', subjectToken: '<Subject 7>', referenceAnchor: identity }] } };
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assert.match(result.draft.prompt, /甲 <Subject 7> \(S2\): <Picture 2>/u);
  assert.equal(result.draft.prompt.slice(result.draft.prompt.indexOf('summary:')), prompt.slice(prompt.indexOf('summary:')));
  assert.equal(readH3PromptProtocol(result.draft.prompt)?.sections.length, 6);
});

await test('已有Picture通过保存manifest按原资产或明确同人物替换，不留两份冲突编号', () => {
  const { project, draft } = fixture();
  const prompt = originalPrompt.replace(anchorA, `${anchorA} Existing visual source: <Picture 9>.`).replace('脚步声', '脚步声与字面量<Picture 9>');
  draft.prompt = prompt; draft.h3ReferenceBinding = { ...draft.h3ReferenceBinding!, basePrompt: prompt, renderedPrompt: prompt,
    sourcePictures: [{ number: 9, assetId: 'a-image' }] };
  project.assets.push(image('a-new', 'a')); draft.references[1].assetId = 'a-new';
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
  assert.match(result.draft.prompt, /Existing visual source: <Picture 3>/u);
  assert.match(result.draft.prompt, /甲 \(S2\): <Picture 3>/u);
  assert.deepEqual(literals(result.draft.prompt), literals(prompt));
  const invalid = prepareVideoH3ReferenceDraft(project, { ...draft, h3ReferenceBinding: { ...draft.h3ReferenceBinding!, sourcePictures: [] } }, { backend: 'api', api });
  assert.equal(invalid.draft.prompt, prompt);
  assert.ok(invalid.warnings.some((warning) => warning.includes('未附加冲突引用')));
});

await test('场景替图只按唯一location证据绑定真实槽，角色编号与原文正文不变', () => {
  for (const provenance of ['entity', 'assetIds'] as const) {
    const { project, draft } = sceneFixture();
    if (provenance === 'assetIds') {
      const scene = project.assets.find((asset) => asset.id === 'scene-new')!;
      scene.sourceEntityId = undefined; scene.sourceEntityKind = undefined;
      project.locations[0].assetIds.push(scene.id);
    }
    draft.references = [{ assetId: 'tail', role: 'first-frame' }, { assetId: 'scene-new', role: 'scene', slotIndex: 3 }, { assetId: 'a-image', role: 'character', slotIndex: 4 }];
    const before = structuredClone({ project, draft });
    for (const [connection, sceneNumber, personNumber] of [[cloud(), 4, 5], [api, 2, 3]] as const) {
      const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: connection });
      assert.equal(result.draft.prompt.replace(` Visual identity reference for 甲 (S2): <Picture ${personNumber}>.`, ''), scenePrompt(sceneNumber, personNumber, null));
      assert.deepEqual(literals(result.draft.prompt), literals(draft.prompt));
      assert.deepEqual(readH3PromptProtocol(result.draft.prompt)?.sections, readH3PromptProtocol(draft.prompt)?.sections);
      assert.equal(prepareVideoH3ReferenceDraft(project, result.draft, { backend: 'api', api: connection }).draft.prompt, result.draft.prompt, 'repeat serialization is idempotent');
    }
    assert.deepEqual({ project, draft }, before);
  }
});

await test('无归属场景/道具/通用选图不猜同场景，取消人物图也不撤销安全移除', () => {
  for (const role of ['scene', 'prop', 'general'] as const) {
    const { project, draft } = sceneFixture();
    project.assets.push({ ...image('unrelated'), name: '山门', type: 'reference', role: 'scene' });
    draft.references = [{ assetId: 'tail', role: 'first-frame' }, { assetId: 'unrelated', role }];
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
    assert.equal(result.draft.prompt, scenePrompt(null, null, null), 'only three obsolete image envelopes and retention tokens change');
    assert.ok(result.warnings.some((warning) => warning.includes('场景图没有唯一可证明')));
    assert.deepEqual(result.draft.references, draft.references);
    assert.deepEqual(literals(result.draft.prompt), literals(draft.prompt));
    assert.equal(result.draft.prompt.slice(result.draft.prompt.indexOf('detailed_description:')), draft.prompt.slice(draft.prompt.indexOf('detailed_description:')));
  }
});

await test('同location多张替图不擅选；只用默认人物时仍兼容场景交本地首帧', () => {
  const { project, draft } = sceneFixture();
  draft.references = [{ assetId: 'tail', role: 'first-frame' }, { assetId: 'a-image', role: 'character' }];
  const ordinary = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assert.equal(ordinary.draft.prompt.replace(' Visual identity reference for 甲 (S2): <Picture 2>.', ''), scenePrompt(1, 2, null));
  project.assets.push({ ...project.assets.find((asset) => asset.id === 'scene-new')!, id: 'scene-new-2' });
  draft.references = [{ assetId: 'tail', role: 'first-frame' }, { assetId: 'scene-new', role: 'scene' }, { assetId: 'scene-new-2', role: 'scene' }];
  const ambiguous = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assert.equal(ambiguous.draft.prompt, scenePrompt(null, null, null));
  assert.ok(ambiguous.warnings.some((warning) => warning.includes('场景图没有唯一可证明')));
});

await test('location证据不接受同名、冲突种类、重复实体或跨类型ID碰撞', () => {
  const { project } = sceneFixture();
  const original = project.assets.find((asset) => asset.id === 'scene-old')!;
  const replacement = project.assets.find((asset) => asset.id === 'scene-new')!;
  assert.deepEqual(videoReferenceLocationOwners(project, original).map((location) => location.id), ['gate']);
  assert.deepEqual(videoReferenceLocationOwners(project, replacement).map((location) => location.id), ['gate']);
  replacement.sourceEntityKind = 'character';
  project.locations[0].assetIds.push(replacement.id);
  assert.deepEqual(videoReferenceLocationOwners(project, replacement), [], 'explicit conflicting kind cannot fall back to membership');
  replacement.sourceEntityKind = 'location';
  project.characters.push(character('gate', '同名不构成场景证据', []));
  assert.deepEqual(videoReferenceLocationOwners(project, replacement), []);
  project.characters = project.characters.filter((entry) => entry.id !== 'gate');
  project.locations.push({ ...project.locations[0] });
  assert.deepEqual(videoReferenceLocationOwners(project, replacement), []);
});

await test('真实单段引擎mock提交、排队冻结与任务快照都使用预览同一稿，不受后来选图影响', async () => {
  const { project, draft } = fixture(); let state = createInitialState(); state.project = project; state.projects = [];
  state.settings.videoTaskApi = api; state.settings.videoExecutionMode = 'queue';
  const posts: Record<string, unknown>[] = [];
  const desktop = {
    videoRequest: async (payload: Parameters<VideoGenerationDesktop['videoRequest']>[0]) => {
      if (payload.method === 'POST') { posts.push(JSON.parse(payload.body!)); return { status: 200, body: JSON.stringify({ id: `remote-${posts.length}`, status: 'queued' }) }; }
      return { status: 200, body: JSON.stringify({ status: 'processing' }) };
    },
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async () => ({ persisted: true }), onVideoProgress: () => () => undefined,
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); }, desktop, onRuntime: () => undefined, pollIntervalMs: 100000 });
  try {
    const preview = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api }).draft;
    const first = await engine.start(preview);
    assert.equal(posts[0].prompt, preview.prompt);
    const second = await engine.start({ ...preview, name: '排队稿', parameters: { ...preview.parameters, seed: 10 } });
    const task = state.project.generationTasks.find((entry) => entry.id === second) as VideoGenerationTask;
    assert.equal(posts.length, 1, 'second task remains locally queued');
    assert.equal(task.videoJob!.snapshot.draft.prompt, preview.prompt);
    assert.equal(task.requestBody.prompt, preview.prompt);
    preview.references[1].assetId = 'b-image'; preview.h3ReferenceBinding!.identities.characters[0].name = '后来编辑';
    state.project.characters[0].name = '资料后来更名';
    assert.equal(task.videoJob!.snapshot.draft.references[1].assetId, 'a-image');
    assert.equal(task.videoJob!.snapshot.draft.h3ReferenceBinding!.identities.characters[0].name, '甲');
    assert.equal(task.videoJob!.snapshot.draft.prompt, posts[0].prompt);
    assert.ok(first && second);
  } finally { engine.dispose(); }
});

await test('批量未来尾帧在入队时即冻结最终Picture绑定，等待期间不再编写提示词', async () => {
  const { project, draft } = fixture(); let state = createInitialState(); state.project = project; state.projects = [];
  state.settings.videoTaskApi = api;
  const desktop = { videoRequest: async () => ({ status: 200, body: JSON.stringify({ id: 'remote-first', status: 'queued' }) }),
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async () => ({ persisted: true }), onVideoProgress: () => () => undefined,
    videoWorkbenchStatus: async () => ({ available: true, ffmpeg: true, ffprobe: true, message: 'synthetic' }),
    extractWorkbenchFrames: async () => { throw new Error('previous task is queued; extraction must not start'); },
    readManagedImageDataUrl: async () => ({ dataUrl: 'data:image/png;base64,AAAA' }),
  } as unknown as VideoGenerationDesktop;
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); }, desktop, onRuntime: () => undefined, pollIntervalMs: 100000, persistState: async () => undefined });
  try {
    const identitiesOnly = { ...draft, references: [{ assetId: 'a-image', role: 'character' as const }, { assetId: 'b-image', role: 'character' as const }] };
    const first = { ...identitiesOnly, source: { sequencePlanId: 'plan', segmentId: 's1', storyboardId: 'board1', segmentIndex: 1 } };
    const second = { ...identitiesOnly, source: { sequencePlanId: 'plan', segmentId: 's2', storyboardId: 'board2', segmentIndex: 2 } };
    const expected = prepareVideoH3ReferenceDraft(project, { ...second, references: videoBatchTailReferences(second.references, { mode: 'prepend', index: 0, role: 'first-frame' }, 'future-tail-preview') }, { backend: 'api', api }).draft.prompt;
    const batch = await engine.startBatch({ projectId: project.id, label: '冻结引用', items: [
      { itemKey: 'b1:zh', draft: first }, { itemKey: 'b2:zh', draft: second, previousTail: { predecessorItemKey: 'b1:zh', placement: { mode: 'prepend', index: 0, role: 'first-frame' } } },
    ] });
    const task = state.project.generationTasks.find((entry) => entry.id === batch.taskIds[1]) as VideoGenerationTask;
    assert.equal(task.videoJob!.snapshot.draft.prompt, expected);
    assert.match(expected, /甲 \(S2\): <Picture 2>/u); assert.match(expected, /乙 \(S1\): <Picture 3>/u);
    assert.equal(task.videoJob!.snapshot.draft.references.length, 3);
    second.references.reverse(); state.project.characters[0].name = '之后改名';
    assert.equal(task.videoJob!.snapshot.draft.prompt, expected);
    assert.equal(task.videoJob!.snapshot.draft.references[1].assetId, 'a-image');
  } finally { engine.dispose(); }
});

const legacyHeroFixture = () => {
  const { project, draft } = fixture();
  const king = character('king', '里尤洛', []);
  const hero = { ...character('hero', '夏提雅-女武神形态\u200c', ['hero-image']), aliases: ['夏提雅', 'Shalltear'] };
  project.characters = [king, hero]; project.assets = [image('hero-image', 'hero'), image('tail')];
  const kingAnchor = 'Identity: 里尤洛 (S1), the orc king.';
  const prompt = `integrated_multimodal_description: [Shot 1] ${kingAnchor} 里尤洛望着前方。他提到了夏提雅。\n[Shot 2] At 00:07.500 夏提雅挥动长枪，将冲来的敌人击飞。<sound>金属撞击</sound>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
  draft.prompt = prompt; draft.parameters = {}; draft.references = [{ assetId: 'hero-image', role: 'character', slotIndex: 2 }];
  draft.h3ReferenceBinding = { version: 1, projectId: project.id, basePrompt: prompt, renderedPrompt: prompt,
    identities: { version: 1, characters: [{ characterId: 'king', name: king.name, speakerToken: '(S1)', referenceAnchor: kingAnchor }] } };
  return { project, draft, hero, prompt };
};

await test('旧稿漏人物表项，出镜别名与选图身份唯一时仅本次提交补关联，使用真实云端槽位', () => {
  const { project, draft, prompt } = legacyHeroFixture();
  const before = structuredClone({ project, draft });
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
  const association = ' Visual identity reference for 夏提雅-女武神形态 (known as 夏提雅): <Picture 3>.';
  assert.equal(result.draft.prompt.replace(association, ''), prompt);
  assert.ok(result.draft.prompt.indexOf(association) > result.draft.prompt.indexOf('[Shot 2]'), 'never move a later appearance to Shot 1');
  assert.equal(getH3PromptProtocolIssue(prompt), undefined, 'the authored fixture has valid shot cuts');
  assert.equal(getH3PromptProtocolIssue(result.draft.prompt, prompt, ['<Picture 3>']), undefined, 'only the explicitly selected picture extends the protocol');
  assert.deepEqual(result.characterStates.find((entry) => entry.characterId === 'hero'), {
    characterId: 'hero', name: '夏提雅-女武神形态\u200c', status: 'bound', slots: [3],
  });
  const body = buildVideoApiBody(cloud(), result.draft, ['hero-upload.png']);
  const nodes = body.nodeInfoList as Array<{ nodeId: string; fieldValue: string }>;
  assert.equal(nodes.find((node) => node.nodeId === 'i2')?.fieldValue, 'hero-upload.png');
  assert.equal(nodes.find((node) => node.nodeId === 'p')?.fieldValue, result.draft.prompt);
  assert.equal(prepareVideoH3ReferenceDraft(project, result.draft, { backend: 'api', api: cloud() }).draft.prompt, result.draft.prompt);
  assert.deepEqual({ project, draft }, before, 'saved source and selected assets are immutable');
  const deselected = prepareVideoH3ReferenceDraft(project, { ...result.draft, references: [] }, { backend: 'api', api: cloud() });
  assert.equal(deselected.draft.prompt, prompt);
  assert.equal(deselected.characterStates.find((entry) => entry.characterId === 'hero')?.status, 'unselected');
  const frozenDraft = { ...result.draft, reuseTaskId: 'frozen' };
  project.characters[1].name = '后来改名';
  const frozen = prepareVideoH3ReferenceDraft(project, frozenDraft, { backend: 'api', api: cloud() });
  assert.strictEqual(frozen.draft, frozenDraft);
  assert.deepEqual(frozen.characterStates, result.characterStates);
});

await test('只有对白提及、明确画外、歧义别名、场景用途和不明槽位均不能冒充人物已关联', () => {
  for (const visual of ['里尤洛说<d>[Chinese] 夏提雅在哪里？</d>。', '夏提雅在画外说话，镜头只拍里尤洛。']) {
    const { project, draft } = legacyHeroFixture();
    const prompt = draft.prompt.replace('夏提雅挥动长枪，将冲来的敌人击飞。', visual);
    draft.prompt = prompt; draft.h3ReferenceBinding = { ...draft.h3ReferenceBinding!, basePrompt: prompt, renderedPrompt: prompt };
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
    assert.equal(result.draft.prompt, prompt);
    assert.equal(result.characterStates.find((entry) => entry.characterId === 'hero')?.status, 'pending');
  }
  const { project, draft } = legacyHeroFixture();
  project.characters.push({ ...character('other-form', '夏提雅-礼服形态', []), aliases: ['夏提雅'] });
  const ambiguous = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
  assert.equal(ambiguous.draft.prompt, draft.prompt);
  assert.equal(ambiguous.characterStates.find((entry) => entry.characterId === 'hero')?.status, 'pending');
  project.characters.pop();
  const scene = prepareVideoH3ReferenceDraft(project, { ...draft, references: [{ assetId: 'hero-image', role: 'scene' }] }, { backend: 'api', api: cloud() });
  assert.equal(scene.draft.prompt, draft.prompt);
  assert.equal(scene.characterStates.find((entry) => entry.characterId === 'hero')?.status, 'unselected');
  const unknown = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: { ...cloud(), runningHubMappedFields: undefined } });
  assert.equal(unknown.draft.prompt, draft.prompt);
  assert.equal(unknown.characterStates.find((entry) => entry.characterId === 'hero')?.status, 'pending');
});

await test('可信旧英文原稿完全无身份表仍按唯一英文别名补派生关联，中文名和英文名同指一个ID', () => {
  const { project, draft } = legacyHeroFixture();
  const prompt = 'integrated_multimodal_description: [Shot 1] Shalltear thrusts her spear at the charging orcs.\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
  const board = { id: 'legacy-english', sceneId: project.scenes[0]?.id || '', shots: [], finalPrompt: prompt,
    officialPromptZh: prompt, officialPromptEn: prompt, officialPromptEnSource: prompt } as Project['storyboards'][number];
  project.storyboards = [board];
  draft.prompt = prompt; draft.h3ReferenceBinding = undefined; draft.source = { storyboardId: board.id, language: 'en' };
  project.assets.push(image('hero-second', 'hero'));
  draft.references = [{ assetId: 'hero-image', role: 'character', slotIndex: 1 }, { assetId: 'hero-second', role: 'character', slotIndex: 4 }];
  const before = structuredClone(project);
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assert.match(result.draft.prompt, /Visual identity reference for 夏提雅-女武神形态 \(known as Shalltear\): <Picture 1>, <Picture 2>\./u);
  assert.deepEqual(result.characterStates.find((entry) => entry.characterId === 'hero')?.slots, [1, 2], 'generic arrays use upload order, not sparse slot numbers');
  assert.equal(result.characterStates.find((entry) => entry.characterId === 'hero')?.status, 'bound');
  assert.deepEqual(project, before);
  assert.equal(draft.h3ReferenceBinding, undefined);
});

await test('后镜补关联保留At紧随镜号，三字段与六字段稿都不越入下一镜或声音章节', () => {
  for (const fullReference of [false, true]) {
    const { project, draft, prompt } = legacyHeroFixture();
    const withNextShot = prompt.replace('\noverall_soundscape:', '\n[Shot 3] At 00:12.000 里尤洛退回军阵。\noverall_soundscape:');
    const source = fullReference ? withNextShot.replace('integrated_multimodal_description:',
      'subject_definitions:\n<Subject 1> is 里尤洛: the orc king.\nsummary:\n远处交战。\nretention_analysis:\nKeep the established identities.\ndetailed_description:') : withNextShot;
    draft.prompt = source;
    draft.h3ReferenceBinding = { ...draft.h3ReferenceBinding!, basePrompt: source, renderedPrompt: source };
    const before = structuredClone(draft);
    assert.equal(getH3PromptProtocolIssue(source), undefined);
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
    assert.equal(result.characterStates.find((entry) => entry.characterId === 'hero')?.status, 'bound');
    assert.equal(getH3PromptProtocolIssue(result.draft.prompt, source, ['<Picture 3>']), undefined);
    assert.match(result.draft.prompt, /\[Shot 2\] At 00:07\.500 夏提雅/u);
    const associationStart = result.draft.prompt.indexOf(' Visual identity reference for 夏提雅');
    assert.ok(associationStart > result.draft.prompt.indexOf('At 00:07.500'));
    assert.ok(associationStart < result.draft.prompt.indexOf('[Shot 3]'));
    assert.deepEqual(literals(result.draft.prompt), literals(source));
    assert.deepEqual(draft, before);
  }
});

console.log(`${groups} H3 reference-binding regression groups passed (synthetic inputs, no real API)`);
