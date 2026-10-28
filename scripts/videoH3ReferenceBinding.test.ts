import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { getH3PromptProtocolIssue, readH3PromptProtocol } from '../src/h3PromptProtocol';
import { renderH3PerformancePlan } from '../src/h3PerformancePlan';
import { stampCharacterParticipation } from '../src/characterParticipation';
import { isVideoH3ReferenceInfo, prepareVideoH3ReferenceDraft, videoH3PictureNumbers, videoH3ReferenceCharacterIds, videoReferenceCharacterOwners, videoReferenceLocationOwners } from '../src/videoH3ReferenceBinding';
import { prepareVideoTailCharacterDraft } from '../src/videoTailCharacters';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { addVideoReference, removeVideoReference } from '../src/videoReferenceSlots';
import { videoBatchTailReferences } from '../src/videoBatch';
import { compileH3ReferenceImageOrders, readH3ReferenceImageOrders } from '../src/h3ReferenceImageOrder';
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
const cloud = (imageCount = 5): VideoTaskApiConfig => {
  const images = Array.from({ length: imageCount }, (_, index) => ({ nodeId: `i${index}`, inputName: 'image' }));
  const mapping = { prompt: [{ nodeId: 'p', inputName: 'value' }], images };
  const graph = {
    p: { class_type: 'Text', inputs: { value: '' } },
    ...Object.fromEntries(images.map(({ nodeId }) => [nodeId, { class_type: 'LoadImage', inputs: { image: '' } }])),
    h3: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { prompt: ['p', 0],
      ...Object.fromEntries(images.map(({ nodeId }, index) => [`ref_images.ref_image_${index}`, [nodeId, 0]])),
    } },
  };
  return { ...api, provider: 'runninghub', runningHubImageRoles: images.map((_, index) => index ? 'character' : 'first-frame'),
    requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'p', fieldName: 'value', fieldValue: '' },
      ...images.map(({ nodeId }) => ({ nodeId, fieldName: 'image', fieldValue: '' }))] }),
    runningHubMappedFields: [{ nodeId: 'p', fieldName: 'value', kind: 'prompt' },
      ...images.map(({ nodeId }, imageIndex) => ({ nodeId, fieldName: 'image', kind: 'image' as const, imageIndex }))],
    runningHubH3ReferenceImages: compileH3ReferenceImageOrders(readH3ReferenceImageOrders(graph), mapping, () => false),
  };
};
const literals = (value: string): string[] => [...value.matchAll(/<(?:d|sound)>[\s\S]*?<\/(?:d|sound)>/gu)].map((match) => match[0]);
const assertPictureBinding = (prompt: string, name: string, numbers: number[]): void => {
  const pictures = numbers.map((number) => `<Picture ${number}>`).join(', ');
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  assert.match(prompt, new RegExp(`(?:is ${escapedName}(?: \\(S\\d+\\))? referenced from|Visual identity reference for ${escapedName}:) ${pictures}`, 'u'));
};
const actionBody = (prompt: string): string => {
  const header = /^(?:integrated_multimodal_description|detailed_description):/mu.exec(prompt)!;
  const body = prompt.slice(header.index + header[0].length);
  const tail = /^overall_soundscape:/mu.exec(body);
  return tail ? body.slice(0, tail.index) : body;
};
const assertExecutionSource = (actual: string, source: string, _anchors: readonly string[] = [anchorA, anchorB]): void => {
  const normalize = (value: string): string => {
    let body = actionBody(value);
    return body.replace(/ Visual identity reference for [^\r\n]*?: <Picture \d+>(?:, <Picture \d+>)*\./gu, '')
      .replace(/<Subject\s+\d+>[ \t]*/gu, '').replace(/[SＳ][0-9０-９]+/gu, 'Sx').replace(/\s+/gu, ' ').trim();
  };
  assert.deepEqual(readH3PromptProtocol(actual)?.shots, readH3PromptProtocol(source)?.shots);
  assert.deepEqual(literals(actual), literals(source));
  assert.equal(actual.slice(actual.indexOf('overall_soundscape:')), source.slice(source.indexOf('overall_soundscape:')));
  assert.equal(normalize(actual), normalize(source), 'only proven identity labels, source declarations and voice numbers are compiled; actions and time stay');
};
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

await test('稀疏RunningHub按模型实际消费图片编号，上传仍保持明确物理槽', () => {
  const { project, draft } = fixture();
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
  assert.deepEqual(result.warnings, []);
  assertPictureBinding(result.draft.prompt, '甲', [2]);
  assertPictureBinding(result.draft.prompt, '乙', [3]);
  const dense = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assertPictureBinding(dense.draft.prompt, '甲', [2]);
  assertPictureBinding(dense.draft.prompt, '乙', [3]);
  const body = buildVideoApiBody(cloud(), { ...result.draft, parameters: {} }, ['tail.png', 'a.png', 'b.png']);
  const fields = body.nodeInfoList as Array<{ nodeId: string; fieldValue: string }>;
  assert.equal(fields.find((field) => field.nodeId === 'p')?.fieldValue, result.draft.prompt);
  assert.equal(fields.find((field) => field.nodeId === 'i2')?.fieldValue, 'a.png');
  assert.equal(fields.find((field) => field.nodeId === 'i4')?.fieldValue, 'b.png');
  assert.equal(fields.find((field) => field.nodeId === 'i1')?.fieldValue, '');
});

await test('重复身份句不再覆盖可信人物ID与本次明确选图的关联', () => {
  const { project, draft } = fixture();
  const duplicated = originalPrompt.replace('[Shot 2]', `[Shot 2] ${anchorA}`);
  draft.prompt = duplicated;
  draft.h3ReferenceBinding = { ...draft.h3ReferenceBinding!, basePrompt: duplicated, renderedPrompt: duplicated };
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
  for (const [id, name, number] of [['a', '甲', 2], ['b', '乙', 3]] as const) {
    assert.equal(result.characterStates.find((entry) => entry.characterId === id)?.status, 'bound');
    assert.deepEqual(result.characterStates.find((entry) => entry.characterId === id)?.slots, [number]);
    assertPictureBinding(result.draft.prompt, name, [number]);
  }
  assert.ok(result.warnings.some((warning) => warning.includes('身份句重复')));
  assert.equal(result.warnings.some((warning) => warning.includes('本次未绑定该人物图片')), false);
  assert.equal(result.draft.prompt.includes(duplicated), false, 'request-local picture labels are the only prompt edits');
  assert.equal(result.draft.prompt.replace(/ Visual identity reference for [^\r\n]*?: <Picture \d+>(?:, <Picture \d+>)*\./gu, ''), duplicated);
});

await test('选图确定性编译六字段主体，镜数切点对白动作声音保留且可逆幂等', () => {
  const { project, draft } = fixture(); const before = structuredClone({ project, draft });
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  const protocol = readH3PromptProtocol(result.draft.prompt)!;
  assert.deepEqual(protocol.sections, ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']);
  assert.deepEqual(protocol.shots, readH3PromptProtocol(originalPrompt)!.shots);
  assert.deepEqual(literals(result.draft.prompt), literals(originalPrompt));
  assertExecutionSource(result.draft.prompt, originalPrompt);
  assert.match(result.draft.prompt, /乙 \(S1\) 画内发话/u);
  assert.match(result.draft.prompt, /甲 \(S2\) 回答/u);
  assert.equal(prepareVideoH3ReferenceDraft(project, result.draft, { backend: 'api', api }).draft.prompt, result.draft.prompt);
  assert.equal(prepareVideoH3ReferenceDraft(project, { ...result.draft, references: [] }, { backend: 'api', api }).draft.prompt, originalPrompt);
  assert.deepEqual({ project, draft }, before);
});

await test('中英文纯视觉身份句不含声源号，后镜非语言悲鸣不妨碍同ID图片关联', () => {
  for (const language of ['zh', 'en'] as const) {
    const { project, draft } = fixture();
    const identity = language === 'zh' ? '身份：甲，黑发蓝袍。' : 'Identity: 甲, black hair and blue robe.';
    const cry = language === 'zh' ? '甲 (S1) 发出非语言悲鸣。<sound>短促悲鸣，无可辨字词。</sound>'
      : '甲 (S1) releases a nonverbal cry. <sound>A brief wordless cry.</sound>';
    const prompt = `integrated_multimodal_description:\n[Shot 1] ${identity} ${language === 'zh' ? '甲站在门前。' : '甲 stands at the doorway.'}\n[Shot 2] At 00:03.000 ${language === 'zh' ? '甲抬头。' : '甲 looks up.'}\n[Shot 3] At 00:06.000 ${cry}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
    project.assets[0] = { ...project.assets[0], characterReferenceId: 'a', referenceEntityBinding: { kind: 'character', entityId: 'a' } };
    draft.prompt = prompt; draft.source = { promptFormat: 'h3', language };
    draft.references = [{ assetId: 'a-image', role: 'character', slotIndex: 2 }];
    draft.h3ReferenceBinding = { version: 1, projectId: project.id, basePrompt: prompt, renderedPrompt: prompt,
      identities: { version: 1, characters: [{ characterId: 'a', name: '甲', speakerToken: '(S1)', referenceAnchor: identity }] } };
    const before = structuredClone({ project, draft });
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
    assert.equal(result.characterStates.find((entry) => entry.characterId === 'a')?.status, 'bound');
    assert.deepEqual(result.characterStates.find((entry) => entry.characterId === 'a')?.slots, [1]);
    assertPictureBinding(result.draft.prompt, '甲', [1]);
    assert.match(result.draft.prompt, /<Subject 1> is 甲 \(S1\)/u);
    assertExecutionSource(result.draft.prompt, prompt, [identity]);
    assert.deepEqual(literals(result.draft.prompt), literals(prompt), 'the authored cry stays unchanged');
    assert.deepEqual(result.draft.h3ReferenceBinding?.identities, draft.h3ReferenceBinding!.identities);
    assert.deepEqual({ project, draft }, before);
  }
});

await test('第五段同类中英文三字段稿沿用Subject元数据，物理槽4和5的人物映射到消费图片1和2', () => {
  for (const language of ['zh', 'en'] as const) {
    const { project, draft } = fixture();
    const first = language === 'zh' ? '身份：甲，保持已有驾驶员外观。' : 'Identity: 甲 keeps the authored pilot appearance.';
    const second = language === 'zh' ? '身份：乙，保持已有机甲外观。' : 'Identity: 乙 keeps the authored machine appearance.';
    const prompt = `integrated_multimodal_description:\n[Shot 1] ${first}\n${second}\n${language === 'zh' ? '两者保持原剧情中的站位与动作。' : 'Both retain their authored positions and actions.'}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
    const metadata: H3IdentityBindings = { version: 1, characters: [
      { characterId: 'a', name: '甲', subjectToken: '<Subject 1>', speakerToken: '(S1)', referenceAnchor: first },
      { characterId: 'b', name: '乙', subjectToken: '<Subject 2>', speakerToken: '(S2)', referenceAnchor: second },
    ] };
    draft.prompt = prompt; draft.source = { promptFormat: 'h3', language, segmentIndex: 5 };
    draft.references = [{ assetId: 'a-image', role: 'character', slotIndex: 3 }, { assetId: 'b-image', role: 'character', slotIndex: 4 }];
    draft.h3ReferenceBinding = { version: 1, projectId: project.id, basePrompt: prompt, renderedPrompt: prompt, identities: metadata };
    const before = structuredClone({ project, draft });
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
    assert.deepEqual(result.characterStates.map(({ characterId, status, slots }) => ({ characterId, status, slots })), [
      { characterId: 'a', status: 'bound', slots: [1] }, { characterId: 'b', status: 'bound', slots: [2] },
    ]);
    assertPictureBinding(result.draft.prompt, '甲', [1]);
    assertPictureBinding(result.draft.prompt, '乙', [2]);
    assertExecutionSource(result.draft.prompt, prompt, [first, second]);
    assert.match(result.draft.prompt, /<Subject 1> is 甲/u);
    assert.match(result.draft.prompt, /<Subject 2> is 乙/u);
    assert.deepEqual(result.draft.h3ReferenceBinding?.identities, metadata);
    assert.equal(result.warnings.some((warning) => warning.includes('锚点已失效')), false);
    assert.deepEqual({ project, draft }, before);
  }
});

await test('只报告本次选图涉及的人物；无选图不逐人刷警告，映射说明与失效区分', () => {
  const { project, draft } = fixture();
  draft.h3ReferenceBinding!.identities.characters.forEach((identity) => { identity.referenceAnchor += '已脱节'; });
  const noPictures = prepareVideoH3ReferenceDraft(project, { ...draft, references: [] }, { backend: 'api', api: cloud() });
  assert.deepEqual(noPictures.warnings, []);
  const selected = prepareVideoH3ReferenceDraft(project, { ...draft, references: [{ assetId: 'a-image', role: 'character' }] }, { backend: 'api', api: cloud() });
  const failures = selected.warnings.filter((message) => !isVideoH3ReferenceInfo(message));
  assert.equal(failures.length, 1); assert.match(failures[0], /人物“甲”.*不在当前语言的正文中/u); assert.doesNotMatch(failures[0], /人物“乙”/u);
  assert.equal(selected.warnings.filter(isVideoH3ReferenceInfo).length, 0, 'known topology no longer emits the legacy unknown-order explanation');
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
  assertPictureBinding(result.draft.prompt, '甲', [2]);
  assertPictureBinding(result.draft.prompt, '乙', [3]);
  assert.deepEqual(videoH3ReferenceCharacterIds(project, draft), ['a', 'b']);
  const explicit = { ...draft, references: [{ assetId: 'a-image', role: 'general' as const, characterIds: ['b'] }] };
  assert.deepEqual(videoH3ReferenceCharacterIds(project, explicit), ['b']);
  assertPictureBinding(prepareVideoH3ReferenceDraft(project, explicit, { backend: 'api', api }).draft.prompt, '乙', [1]);
});

await test('多人合照与同一人物多图都按明确资产归属，不构造一图一人', () => {
  const { project, draft } = fixture(); project.assets.push(image('group'), image('a-second', 'a'));
  project.characters[0].assetIds.push('group', 'a-second'); project.characters[1].assetIds.push('group');
  draft.references = [{ assetId: 'group', role: 'character' }, { assetId: 'a-second', role: 'character' }];
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assertPictureBinding(result.draft.prompt, '甲', [1, 2]);
  assertPictureBinding(result.draft.prompt, '乙', [1]);
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
  assertPictureBinding(result.draft.prompt, '甲', [1]); assertPictureBinding(result.draft.prompt, '乙', [1]);
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
  assertPictureBinding(result.draft.prompt, '甲', [1]); assertPictureBinding(result.draft.prompt, '乙', [2]);
});

await test('旧稿无metadata、跨项目与人工改稿仅提示；准确唯一的已存定位不复审正文内容', () => {
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
  assert.deepEqual(literals(result.draft.prompt), literals(originalPrompt));
  assert.equal(result.characterStates.find((entry) => entry.characterId === 'a')?.status, 'bound', 'the exact existing locator is not rejected by dialogue or section rules');
  assert.equal(result.warnings.some((warning) => warning.includes('锚点已失效')), false);
  assertExecutionSource(result.draft.prompt, originalPrompt);
  assert.match(actionBody(result.draft.prompt), /乙 \(S1\) 画内发话 <d>\[Chinese\] 请把地图给我。<\/d>/u);
  assert.doesNotMatch(result.draft.prompt.split('detailed_description:')[0], /<d>/u);
});

await test('缺失定位仍待关联；重复定位沿用明确人物ID与本次选图', () => {
  const missing = originalPrompt.replace(anchorA, '已替换原定位文本。');
  const { project, draft } = fixture();
  draft.prompt = missing;
  draft.references = [{ assetId: 'a-image', role: 'character', slotIndex: 3 }];
  draft.h3ReferenceBinding = { ...draft.h3ReferenceBinding!, basePrompt: missing, renderedPrompt: missing };
  const unresolved = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
  assert.equal(unresolved.characterStates.find((entry) => entry.characterId === 'a')?.status, 'pending');
  assert.equal(unresolved.draft.prompt, missing);
  assert.deepEqual(unresolved.draft.references, draft.references);

  const duplicated = `${originalPrompt}\n${anchorA}`;
  const duplicateDraft = { ...draft, prompt: duplicated,
    h3ReferenceBinding: { ...draft.h3ReferenceBinding!, basePrompt: duplicated, renderedPrompt: duplicated } };
  const recovered = prepareVideoH3ReferenceDraft(project, duplicateDraft, { backend: 'api', api: cloud() });
  assert.equal(recovered.characterStates.find((entry) => entry.characterId === 'a')?.status, 'bound');
  assertPictureBinding(recovered.draft.prompt, '甲', [1]);
  assert.ok(recovered.warnings.some((warning) => warning.includes('身份句重复')));
});

await test('不明自定义模板、首尾帧专用接口不虚构Picture顺序，不阻断', () => {
  const { project, draft } = fixture();
  for (const connection of [{ ...api, requestTemplate: '{"prompt":"{{prompt}}","x":"{{image_3}}"}' }, { ...api, provider: 'minimax' as const }, { ...cloud(), runningHubH3ReferenceImages: undefined, runningHubMappedFields: undefined }]) {
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: connection });
    assert.equal(result.draft.prompt, originalPrompt); assert.ok(result.warnings.length);
  }
  assert.deepEqual(videoH3PictureNumbers(draft.references, { backend: 'api', api: { ...api, requestTemplate: '{"prompt":"{{prompt}}","photos":"{{images}}"}' } }).numbers, [1, 2, 3]);
});

await test('重复声源元数据原样携带，不影响各自明确的人物图片关联', () => {
  const { project, draft } = fixture(); const bindings = draft.h3ReferenceBinding!.identities.characters;
  bindings[1].speakerToken = bindings[0].speakerToken;
  const before = structuredClone(bindings);
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assert.equal(result.characterStates.find((entry) => entry.characterId === 'a')?.status, 'bound');
  assert.equal(result.characterStates.find((entry) => entry.characterId === 'b')?.status, 'bound');
  assert.match(result.draft.prompt, /Visual identity reference for 甲: <Picture 2>/u);
  assert.match(result.draft.prompt, /Visual identity reference for 乙: <Picture 3>/u);
  assert.deepEqual(result.draft.h3ReferenceBinding?.identities.characters, before);
  assert.deepEqual(literals(result.draft.prompt), literals(originalPrompt));
  assert.equal(result.warnings.some((warning) => warning.includes('声源编号')), false);
});

await test('旧Subject元数据不限制明确ID与唯一定位，损坏数据仍保留原稿', () => {
  const duplicate = fixture(); const bindings = duplicate.draft.h3ReferenceBinding!.identities.characters;
  bindings[0].subjectToken = '<Subject 2>'; bindings[1].subjectToken = '<Subject 2>';
  const before = structuredClone(bindings);
  const sharedSubject = prepareVideoH3ReferenceDraft(duplicate.project, duplicate.draft, { backend: 'api', api });
  assert.equal(sharedSubject.characterStates.find((entry) => entry.characterId === 'a')?.status, 'bound');
  assert.equal(sharedSubject.characterStates.find((entry) => entry.characterId === 'b')?.status, 'bound');
  assert.equal(sharedSubject.draft.prompt.replace(' Visual identity reference for 甲: <Picture 2>.', '')
    .replace(' Visual identity reference for 乙: <Picture 3>.', ''), originalPrompt);
  assert.deepEqual(sharedSubject.draft.h3ReferenceBinding?.identities.characters, before);
  assert.deepEqual(sharedSubject.draft.prompt.match(/<Subject \d+>|\(S\d+\)/gu), originalPrompt.match(/<Subject \d+>|\(S\d+\)/gu));
  assert.equal(sharedSubject.warnings.some((warning) => warning.includes('编号')), false);
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
  assertPictureBinding(result.draft.prompt, '甲', [2]); assertPictureBinding(result.draft.prompt, '乙', [3]);
  assert.match(result.draft.prompt, /<Subject 1> is 甲 \(S2\)/u);
  assert.match(result.draft.prompt, /<Subject 2> is 乙 \(S1\)/u);
  assert.doesNotMatch(result.draft.prompt, /\(S3\)/u);
});

await test('既有六字段Subject直接连接实际图片，按段首发重编S并保留镜头音轨', () => {
  const { project, draft } = fixture();
  const identity = '<Subject 7> is 甲 (S2), black hair and blue robe.';
  const prompt = `subject_definitions:\n${identity}\nsummary:\nA walk.\nretention_analysis:\n<Subject 7> preserved.\ndetailed_description:\n[Shot 1] <Subject 7> (S2) says <d>[Chinese] 好，我们一起走。</d>.\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
  draft.prompt = prompt; draft.h3ReferenceBinding = { version: 1, projectId: project.id, basePrompt: prompt, renderedPrompt: prompt,
    identities: { version: 1, characters: [{ characterId: 'a', name: '甲', speakerToken: '(S2)', subjectToken: '<Subject 7>', referenceAnchor: identity }] } };
  draft.references = draft.references.filter((reference) => reference.assetId !== 'b-image');
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api });
  assertPictureBinding(result.draft.prompt, '甲', [2]);
  assert.match(result.draft.prompt, /<Subject 7> is 甲 \(S1\) referenced from <Picture 2>/u);
  assert.match(result.draft.prompt, /\[Shot 1\] <Subject 7> \(S1\) says/u);
  assertExecutionSource(result.draft.prompt, prompt, [identity]);
  assert.equal(readH3PromptProtocol(result.draft.prompt)?.sections.length, 6);
});

await test('已有Picture通过保存manifest按原资产或明确同人物替换，不留两份冲突编号', () => {
  const { project, draft } = fixture();
  const prompt = originalPrompt.replace(anchorA, `${anchorA} Existing visual source: <Picture 9>.`).replace('脚步声', '脚步声与字面量<Picture 9>');
  draft.prompt = prompt; draft.h3ReferenceBinding = { ...draft.h3ReferenceBinding!, basePrompt: prompt, renderedPrompt: prompt,
    sourcePictures: [{ number: 9, assetId: 'a-image' }] };
  project.assets.push(image('a-new', 'a')); draft.references[1].assetId = 'a-new';
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
  assert.match(result.draft.prompt, /Existing visual source: <Picture 2>/u);
  assertPictureBinding(result.draft.prompt, '甲', [2]);
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
    for (const [connection, sceneNumber, personNumber] of [[cloud(), 2, 3], [api, 2, 3]] as const) {
      const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: connection });
      assertPictureBinding(result.draft.prompt, '甲', [personNumber]);
      assert.match(result.draft.prompt, new RegExp(`<Subject 9> is 山门 referenced from <Picture ${sceneNumber}>`, 'u'));
      assert.match(result.draft.prompt, /<Subject 7> is 剑 defined by the canonical prompt/u);
      assert.doesNotMatch(result.draft.prompt.split('detailed_description:')[0], /<Picture [789]>/u);
      assertExecutionSource(result.draft.prompt, scenePrompt(sceneNumber, personNumber, null));
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
  assertPictureBinding(ordinary.draft.prompt, '甲', [2]);
  assert.match(ordinary.draft.prompt, /<Subject 9> is 山门 referenced from <Picture 1>/u);
  assertExecutionSource(ordinary.draft.prompt, scenePrompt(1, 2, null));
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
    assertPictureBinding(expected, '甲', [2]); assertPictureBinding(expected, '乙', [3]);
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
  const association = ' Visual identity reference for 夏提雅-女武神形态 (known as 夏提雅): <Picture 1>.';
  assert.equal(result.draft.prompt.replace(association, ''), prompt);
  assert.ok(result.draft.prompt.indexOf(association) > result.draft.prompt.indexOf('[Shot 2]'), 'never move a later appearance to Shot 1');
  assert.equal(getH3PromptProtocolIssue(prompt), undefined, 'the authored fixture has valid shot cuts');
  assert.equal(getH3PromptProtocolIssue(result.draft.prompt, prompt, ['<Picture 1>']), undefined, 'only the explicitly selected picture extends the protocol');
  assert.deepEqual(result.characterStates.find((entry) => entry.characterId === 'hero'), {
    characterId: 'hero', name: '夏提雅-女武神形态\u200c', status: 'bound', slots: [1],
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

await test('紧凑镜号与带制表符镜号也把后镜人物参考图关联到真实云端槽位', () => {
  for (const separator of ['', '\t']) {
    const { project, draft, prompt } = legacyHeroFixture();
    const source = prompt.replace(/\[Shot /gu, `[Shot${separator}`);
    draft.prompt = source;
    draft.h3ReferenceBinding = { ...draft.h3ReferenceBinding!, basePrompt: source, renderedPrompt: source };
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
    const association = ' Visual identity reference for 夏提雅-女武神形态 (known as 夏提雅): <Picture 1>.';
    assert.equal(result.characterStates.find((entry) => entry.characterId === 'hero')?.status, 'bound');
    assert.deepEqual(result.characterStates.find((entry) => entry.characterId === 'hero')?.slots, [1]);
    assert.equal(result.draft.prompt.replace(association, ''), source);
    assert.ok(result.draft.prompt.indexOf(association) > result.draft.prompt.indexOf(`[Shot${separator}2] At 00:07.500`));
    assert.ok(result.draft.prompt.indexOf(association) < result.draft.prompt.indexOf('overall_soundscape:'));
    const body = buildVideoApiBody(cloud(), result.draft, ['hero-upload.png']);
    const nodes = body.nodeInfoList as Array<{ nodeId: string; fieldValue: string }>;
    assert.equal(nodes.find((node) => node.nodeId === 'i2')?.fieldValue, 'hero-upload.png');
    assert.equal(nodes.find((node) => node.nodeId === 'p')?.fieldValue, result.draft.prompt);
  }
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
  const mapped = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: { ...cloud(), runningHubH3ReferenceImages: undefined } });
  assert.match(mapped.draft.prompt, /Visual identity reference for 夏提雅-女武神形态 \(known as 夏提雅\): <Picture 3>/u);
  assert.equal(mapped.characterStates.find((entry) => entry.characterId === 'hero')?.status, 'bound');
  assert.deepEqual(mapped.characterStates.find((entry) => entry.characterId === 'hero')?.slots, [3]);
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
    assert.equal(getH3PromptProtocolIssue(result.draft.prompt, source, ['<Picture 1>']), undefined);
    assert.match(result.draft.prompt, /\[Shot 2\] At 00:07\.500 夏提雅/u);
    const associationStart = result.draft.prompt.indexOf(' Visual identity reference for 夏提雅');
    assert.ok(associationStart > result.draft.prompt.indexOf('At 00:07.500'));
    assert.ok(associationStart < result.draft.prompt.indexOf('[Shot 3]'));
    assert.deepEqual(literals(result.draft.prompt), literals(source));
    assert.deepEqual(draft, before);
  }
});

await test('显式普通稿即使保留H3章节也不进入H3人物绑定，图片槽和正文保持原样', () => {
  for (const language of ['zh', 'en'] as const) {
    const { project, draft } = fixture();
    draft.h3ReferenceBinding = undefined;
    draft.source = { promptFormat: 'ordinary', language };
    draft.references = [{ assetId: 'a-image', role: 'character', slotIndex: 2 }, { assetId: 'b-image', role: 'character', slotIndex: 3 }];
    const before = structuredClone(draft);
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
    assert.equal(result.draft.prompt, draft.prompt);
    assert.deepEqual(result.draft.references, draft.references);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.draft.h3ReferenceBinding, undefined);
    assert.deepEqual(result.characterStates.map((entry) => entry.slots), [[1], [2]]);
    assert.deepEqual(draft, before);
    const h3 = prepareVideoH3ReferenceDraft(project, { ...draft, source: { ...draft.source, promptFormat: 'h3' } }, { backend: 'api', api: cloud() });
    assert.ok(h3.warnings.some((warning) => warning.includes('没有可信的可定位人物绑定')));
  }
});

const headerlessH3Fixture = (language: 'zh' | 'en') => {
  const { project, draft } = fixture();
  const people = [['a', '甲'], ['b', '乙'], ['c', '丙'], ['d', '丁']] as const;
  project.characters = people.map(([id, name]) => character(id, name, [`${id}-image`]));
  project.assets = [
    { ...image('opening'), type: 'first-frame', role: 'first-frame' },
    { ...image('ending'), type: 'last-frame', role: 'last-frame' },
    ...people.map(([id], index) => ({ ...image(`${id}-image`, id), characterReferenceId: id,
      imageVariant: (['five-view', 'three-view', 'turnaround', 'portrait'] as const)[index],
      referenceEntityBinding: { kind: 'character' as const, entityId: id } })),
  ];
  const metadata = (lang: 'zh' | 'en'): H3IdentityBindings => ({ version: 1, characters: people.map(([id, name], index) => ({
    characterId: id, name, subjectToken: `<Subject ${index + 1}>`, speakerToken: `(S${index + 1})`,
    referenceAnchor: lang === 'zh' ? `身份：${name}，保持原有外观${index + 1}。` : `Identity: ${name} retains authored appearance ${index + 1}.`,
  })) });
  const prompt = (lang: 'zh' | 'en') => {
    const anchors = metadata(lang).characters.map((entry) => entry.referenceAnchor);
    return lang === 'zh'
      ? `前言：屏幕文字“[Shot 1] At 99:99.999 <Picture 99>”原样保留。\n[Shot 1] ${anchors[0]} ${anchors[1]} 甲把地图递给乙。<d>[Chinese] 请拿好地图。</d>\n[Shot 2] At 00:07.500 ${anchors[2]} ${anchors[3]} 丙与丁在门边等候。<sound>既有的脚步声</sound>`
      : `Preface: keep the literal screen text “[Shot 1] At 99:99.999 <Picture 99>”.\n[Shot 1] At 00:00.000 ${anchors[0]} ${anchors[1]} 甲 hands the map to 乙. <d>[Chinese] 请拿好地图。</d>\n[Shot 2] At 00:07.500 ${anchors[2]} ${anchors[3]} 丙 and 丁 wait beside the doorway. <sound>The authored footsteps</sound>`;
  };
  const board = { id: 'headerless-h3-board', sceneId: project.scenes[0]?.id || '', shots: [], finalPrompt: prompt('zh'),
    officialPromptZh: prompt('zh'), officialPromptEn: prompt('en'), officialPromptEnSource: prompt('zh'),
    h3IdentityBindings: metadata('zh'), h3IdentityBindingsEn: metadata('en') } as Project['storyboards'][number];
  project.storyboards = [board];
  draft.prompt = prompt(language); draft.parameters = {}; draft.h3ReferenceBinding = undefined;
  draft.source = { storyboardId: board.id, promptFormat: 'h3', language, segmentIndex: 4 };
  draft.references = [{ assetId: 'opening', role: 'first-frame', slotIndex: 0 }, { assetId: 'ending', role: 'last-frame', slotIndex: 1 },
    ...people.map(([id], index) => ({ assetId: `${id}-image`, role: 'character' as const, slotIndex: index + 2 }))];
  const config = cloud(6);
  config.runningHubImageRoles = ['first-frame', 'last-frame', 'character', 'character', 'character', 'character'];
  config.requestTemplate = JSON.stringify({ nodeInfoList: [{ nodeId: 'p', fieldName: 'value', fieldValue: '' },
    ...Array.from({ length: 6 }, (_, index) => ({ nodeId: `i${index}`, fieldName: 'image', fieldValue: '' }))] });
  config.runningHubMappedFields = [{ nodeId: 'p', fieldName: 'value', kind: 'prompt' },
    ...Array.from({ length: 6 }, (_, imageIndex) => ({ nodeId: `i${imageIndex}`, fieldName: 'image', kind: 'image' as const, imageIndex }))];
  return { project, draft, board, config, people };
};
const withoutHeaderlessPictureBindings = (prompt: string): string => prompt
  .replace(/ Visual identity reference for [甲乙丙丁]: <Picture \d+>(?:, <Picture \d+>)*\./gu, '')
  .replace(/(?:本段参考图用途：|Reference uses for this clip:|多视图身份参考：|Multi-view identity references:)[^\r\n]*\r?\n/gu, '');
const multiViewPictureNumbers = (prompt: string): number[] => {
  const line = prompt.match(/(?:多视图身份参考：|Multi-view identity references:)[^\r\n]*/u)?.[0] || '';
  return [...line.matchAll(/<Picture (\d+)>/gu)].map((match) => Number(match[1]));
};

const lateParticipationH3Fixture = (language: 'zh' | 'en', withHeading: boolean) => {
  const current = headerlessH3Fixture(language);
  const { project, draft, board } = current;
  for (const metadata of [board.h3IdentityBindings!, board.h3IdentityBindingsEn!]) {
    metadata.characters = metadata.characters.filter((entry) => entry.characterId !== 'd');
  }
  project.assets.find((asset) => asset.id === 'd-image')!.imageVariant = 'five-view';
  const quotedHeader = 'Example: “\ndetailed_description:\n[Shot 1] At 99:99.999 <Picture 99>\n”.\n';
  const text = (lang: 'zh' | 'en') => {
    const anchors = (lang === 'zh' ? board.h3IdentityBindings! : board.h3IdentityBindingsEn!).characters.map((entry) => entry.referenceAnchor);
    return quotedHeader + (withHeading ? 'detailed_description:\n' : '') + [
      `[Shot 1] At 00:00.000 ${anchors[0]} ${anchors[1]} ${lang === 'zh' ? '甲与乙站在桌边。' : 'The two captains stand beside the table.'}<d>[Chinese] 保留标记 [Shot 3] At 00:03.333 <Picture 99>。</d>`,
      `[Shot 2] At 00:04.000 ${anchors[2]} ${lang === 'zh' ? '丙望向门口。' : 'The guard looks toward the doorway.'}<sound>[Shot 3] At 00:05.555 原有声音标记</sound>`,
      `[Shot 3] At 00:08.000 ${lang === 'zh' ? '丁在门边停下，听甲讲话。' : 'The attendant pauses beside the doorway and listens to the captain.'} Literal: “[Shot 4] At 88:88.888”. <d>[Chinese] 这是原有台词 [Shot 4] At 00:09.999。</d>  \n`,
      `[Shot 4] At 00:12.000 ${lang === 'zh' ? '丁伸手接过地图。' : 'The attendant takes the map.'}<sound>原有收尾声音</sound>`,
      'overall_soundscape: Preserve literal label [Shot 3] At 77:77.777 in this sound section.',
      'non_diegetic_music: N/A',
    ].join('\n');
  };
  board.officialPromptZh = text('zh'); board.officialPromptEn = text('en');
  board.finalPrompt = board.officialPromptZh; board.officialPromptEnSource = board.officialPromptZh;
  board.h3CharacterParticipation = stampCharacterParticipation(board.officialPromptZh, { version: 1, characters: [
    { characterId: 'a', name: '甲', presence: 'visible', shotIndex: 1, evidence: '甲与乙站在桌边。', speaking: false },
    { characterId: 'b', name: '乙', presence: 'visible', shotIndex: 1, evidence: '甲与乙站在桌边。', speaking: false },
    { characterId: 'c', name: '丙', presence: 'visible', shotIndex: 2, evidence: '丙望向门口。', speaking: false },
    { characterId: 'd', name: '丁', presence: 'visible', shotIndex: 3, evidence: '丁在门边停下，听甲讲话。', speaking: false },
    { characterId: 'd', name: '丁', presence: 'visible', shotIndex: 4, evidence: '丁伸手接过地图。', speaking: false },
  ] });
  draft.prompt = language === 'zh' ? board.officialPromptZh : board.officialPromptEn;
  return { ...current, quotedHeader };
};

await test('有无章节均在已证明的后镜补无身份句人物，可信英文无需中文人物的英文别名', () => {
  for (const withHeading of [false, true]) for (const language of ['zh', 'en'] as const) {
    const { project, draft, board, config, quotedHeader } = lateParticipationH3Fixture(language, withHeading);
    const context = { backend: 'api' as const, api: config };
    const before = structuredClone({ project, draft });
    if (language === 'en') {
      assert.doesNotMatch(draft.prompt, /丁/u, 'English source has no Chinese name to recover by text matching');
      assert.deepEqual(project.characters.find((entry) => entry.id === 'd')!.aliases || [], []);
    }
    const result = prepareVideoH3ReferenceDraft(project, draft, context);
    for (const [index, [id, name]] of ([['a', '甲'], ['b', '乙'], ['c', '丙'], ['d', '丁']] as const).entries()) {
      assert.equal(result.characterStates.find((entry) => entry.characterId === id)?.status, 'bound');
      assert.deepEqual(result.characterStates.find((entry) => entry.characterId === id)?.slots, [index + 3]);
      assertPictureBinding(result.draft.prompt, name, [index + 3]);
    }
    const association = ' Visual identity reference for 丁: <Picture 6>.';
    assert.equal(result.draft.prompt.split(association).length - 1, 1);
    assert.ok(result.draft.prompt.indexOf(association) > result.draft.prompt.indexOf('[Shot 3] At 00:08.000'));
    assert.ok(result.draft.prompt.indexOf(association) < result.draft.prompt.indexOf('[Shot 4] At 00:12.000'));
    assert.ok(result.draft.prompt.startsWith(quotedHeader), 'fake quoted heading and first-shot marker remain literal');
    assert.equal(withoutHeaderlessPictureBindings(result.draft.prompt), draft.prompt, 'only the four image associations and responsibility notes are added');
    assert.deepEqual(literals(result.draft.prompt), literals(draft.prompt), 'fake shot/cut markers in dialogue and sound remain untouched');
    for (const [shot, cut] of [[1, '00:00.000'], [2, '00:04.000'], [3, '00:08.000'], [4, '00:12.000']]) {
      assert.ok(result.draft.prompt.includes(`[Shot ${shot}] At ${cut} `), 'no insertion may split a shot marker from its At prefix');
    }
    assert.deepEqual(multiViewPictureNumbers(result.draft.prompt), [3, 4, 5, 6]);
    assert.match(result.draft.prompt, language === 'zh' ? /<Picture 1> 开场构图参考；<Picture 2> 结束构图参考/u
      : /<Picture 1> opening composition reference; <Picture 2> ending composition reference/u);
    assert.equal(prepareVideoH3ReferenceDraft(project, result.draft, context).draft.prompt, result.draft.prompt);
    assert.deepEqual(result.draft.h3ReferenceBinding!.identities, language === 'zh' ? board.h3IdentityBindings : board.h3IdentityBindingsEn,
      'the request-local association does not manufacture a saved identity/speaker record');
    if (!withHeading) {
      const reordered = prepareVideoH3ReferenceDraft(project, { ...result.draft, references: [
        ...result.draft.references.slice(0, 2), ...result.draft.references.slice(2).reverse().map((reference, index) => ({ ...reference, slotIndex: index + 2 })),
      ] }, context);
      assertPictureBinding(reordered.draft.prompt, '丁', [3]);
      assert.deepEqual(reordered.characterStates.find((entry) => entry.characterId === 'd')?.slots, [3]);
      assert.equal(withoutHeaderlessPictureBindings(reordered.draft.prompt), draft.prompt);
      const removed = prepareVideoH3ReferenceDraft(project, { ...result.draft, references: result.draft.references.filter((reference) => reference.assetId !== 'd-image') }, context);
      assert.equal(removed.characterStates.find((entry) => entry.characterId === 'd')?.status, 'unselected');
      assert.doesNotMatch(removed.draft.prompt, /Visual identity reference for 丁:/u);
      assert.deepEqual(multiViewPictureNumbers(removed.draft.prompt), [3, 4, 5]);
      assert.equal(withoutHeaderlessPictureBindings(removed.draft.prompt), draft.prompt);
    }
    const cleared = prepareVideoH3ReferenceDraft(project, { ...result.draft, references: [] }, context);
    assert.equal(cleared.draft.prompt, draft.prompt);
    assert.ok(cleared.characterStates.every((entry) => entry.status === 'unselected'));
    assert.deepEqual({ project, draft }, before);
    const changedProject = structuredClone(project);
    changedProject.storyboards[0].officialPromptZh = 'Later source'; changedProject.storyboards[0].officialPromptEn = 'Later English';
    const frozenBound = { ...result.draft, reuseTaskId: 'frozen-late-visible-bound' };
    const frozenPending = { ...result.draft, prompt: draft.prompt, reuseTaskId: 'frozen-late-visible-pending', h3ReferenceBinding: {
      ...result.draft.h3ReferenceBinding!, renderedPrompt: draft.prompt,
      characterStates: result.characterStates.map((entry) => ({ ...entry, status: 'pending' as const })),
    } };
    for (const frozen of [frozenBound, frozenPending]) {
      const retry = prepareVideoH3ReferenceDraft(changedProject, frozen, context);
      assert.strictEqual(retry.draft, frozen);
      assert.deepEqual(retry.characterStates, frozen.h3ReferenceBinding!.characterStates);
    }
  }
});

await test('无身份句后镜关联仍尊重画外提及记录和英文原稿来源，不凭已选图猜入画', () => {
  for (const condition of ['offscreen', 'mentioned', 'unlinked-english'] as const) {
    const { project, draft, board, config } = lateParticipationH3Fixture('en', false);
    if (condition === 'unlinked-english') board.officialPromptEnSource = 'Different Chinese source';
    else board.h3CharacterParticipation!.characters = board.h3CharacterParticipation!.characters.map((entry) => entry.characterId === 'd'
      ? { ...entry, presence: condition } : entry);
    const before = structuredClone({ project, draft });
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: config });
    assert.equal(result.characterStates.find((entry) => entry.characterId === 'd')?.status, 'pending');
    assert.doesNotMatch(result.draft.prompt, /Visual identity reference for 丁:/u);
    assert.deepEqual(multiViewPictureNumbers(result.draft.prompt), [3, 4, 5]);
    assert.equal(withoutHeaderlessPictureBindings(result.draft.prompt), draft.prompt);
    assert.deepEqual({ project, draft }, before);
  }
});

await test('可信中英文无字段标题H3原稿按锚点关联首尾加四人六个云端槽，调序移除清空仍可逆幂等', () => {
  for (const language of ['zh', 'en'] as const) {
    const { project, draft, board, config, people } = headerlessH3Fixture(language);
    const context = { backend: 'api' as const, api: config };
    const before = structuredClone({ project, draft }); const savedProject = JSON.stringify(project);
    const result = prepareVideoH3ReferenceDraft(project, draft, context);
    for (const [index, [id, name]] of people.entries()) {
      assert.equal(result.characterStates.find((entry) => entry.characterId === id)?.status, 'bound');
      assert.deepEqual(result.characterStates.find((entry) => entry.characterId === id)?.slots, [index + 3]);
      assertPictureBinding(result.draft.prompt, name, [index + 3]);
    }
    assert.equal(withoutHeaderlessPictureBindings(result.draft.prompt), draft.prompt, 'only proven picture responsibilities are inserted; all authored text and cuts stay byte-for-byte');
    assert.match(result.draft.prompt, language === 'zh' ? /<Picture 1> 开场构图参考；<Picture 2> 结束构图参考/u
      : /<Picture 1> opening composition reference; <Picture 2> ending composition reference/u);
    assert.deepEqual(multiViewPictureNumbers(result.draft.prompt), [3, 4, 5], 'only explicitly marked multi-view character pictures get single-character semantics');
    assert.match(result.draft.prompt, language === 'zh' ? /不同视角不是同时入画的多个人/u : /views are not multiple people entering the frame/u);
    assert.match(result.draft.prompt, /“\[Shot 1\] At 99:99\.999 <Picture 99>”/u, 'quoted shot and picture tokens remain literal');
    if (language === 'en') assert.match(result.draft.prompt, /\[Shot 1\] At 00:00\.000 Identity:/u, 'the first-shot time prefix is not split by a reference note');
    assert.match(result.draft.prompt, /\[Shot 2\] At 00:07\.500/u);
    assert.deepEqual(literals(result.draft.prompt), literals(draft.prompt));
    assert.doesNotMatch(result.draft.prompt, /subject_definitions:|overall_soundscape:|non_diegetic_music:|<Subject \d+>|\(S\d+\)/u,
      'missing field titles and old identity metadata do not authorize new structure or voice content');
    assert.deepEqual(result.draft.h3ReferenceBinding?.identities, language === 'zh' ? board.h3IdentityBindings : board.h3IdentityBindingsEn);
    assert.deepEqual(result.draft.references, draft.references);
    const repeated = prepareVideoH3ReferenceDraft(project, result.draft, context);
    assert.equal(repeated.draft.prompt, result.draft.prompt); assert.deepEqual(repeated.characterStates, result.characterStates);
    const body = buildVideoApiBody(config, result.draft, ['opening.png', 'ending.png', 'a.png', 'b.png', 'c.png', 'd.png']);
    const fields = body.nodeInfoList as Array<{ nodeId: string; fieldValue: string }>;
    assert.equal(fields.find((field) => field.nodeId === 'p')?.fieldValue, result.draft.prompt);
    for (const [index, [id]] of people.entries()) assert.equal(fields.find((field) => field.nodeId === `i${index + 2}`)?.fieldValue, `${id}.png`);
    const reordered = prepareVideoH3ReferenceDraft(project, { ...result.draft, references: [
      ...result.draft.references.slice(0, 2), ...result.draft.references.slice(2).reverse().map((reference, index) => ({ ...reference, slotIndex: index + 2 })),
    ] }, context);
    for (const [index, [id, name]] of people.entries()) {
      assert.equal(reordered.characterStates.find((entry) => entry.characterId === id)?.status, 'bound');
      assert.deepEqual(reordered.characterStates.find((entry) => entry.characterId === id)?.slots, [6 - index]);
      assertPictureBinding(reordered.draft.prompt, name, [6 - index]);
    }
    assert.equal(withoutHeaderlessPictureBindings(reordered.draft.prompt), draft.prompt);
    assert.deepEqual(multiViewPictureNumbers(reordered.draft.prompt), [4, 5, 6]);
    const removed = prepareVideoH3ReferenceDraft(project, { ...result.draft, references: result.draft.references.filter((reference) => reference.assetId !== 'b-image') }, context);
    assert.equal(removed.characterStates.find((entry) => entry.characterId === 'b')?.status, 'unselected');
    assert.doesNotMatch(removed.draft.prompt, /Visual identity reference for 乙:/u);
    assertPictureBinding(removed.draft.prompt, '甲', [3]); assertPictureBinding(removed.draft.prompt, '丙', [4]); assertPictureBinding(removed.draft.prompt, '丁', [5]);
    assert.equal(withoutHeaderlessPictureBindings(removed.draft.prompt), draft.prompt);
    assert.deepEqual(multiViewPictureNumbers(removed.draft.prompt), [3, 4]);
    const repurposed = prepareVideoH3ReferenceDraft(project, { ...result.draft, references: result.draft.references.map((reference) =>
      reference.assetId === 'a-image' ? { ...reference, role: 'scene' as const, characterIds: undefined } : reference) }, context);
    assert.match(repurposed.draft.prompt, language === 'zh' ? /<Picture 3> 场景空间与光照参考/u : /<Picture 3> environment layout and lighting reference/u);
    assert.deepEqual(multiViewPictureNumbers(repurposed.draft.prompt), [4, 5], 'a scene use does not inherit the asset owner as an extra visible character');
    assert.equal(withoutHeaderlessPictureBindings(repurposed.draft.prompt), draft.prompt);
    const cleared = prepareVideoH3ReferenceDraft(project, { ...result.draft, references: [] }, context);
    assert.equal(cleared.draft.prompt, draft.prompt); assert.ok(cleared.characterStates.every((entry) => entry.status === 'unselected'));
    assert.deepEqual({ project, draft }, before); assert.equal(JSON.stringify(project), savedProject, 'saved bilingual source, identity metadata and asset records remain unchanged');
  }
});

await test('无标题稿仅信任真实来源与准确锚点，普通稿无来源手改稿和失效锚点不会误关联', () => {
  for (const language of ['zh', 'en'] as const) {
    const { project, draft, config } = headerlessH3Fixture(language);
    const context = { backend: 'api' as const, api: config };
    const bound = prepareVideoH3ReferenceDraft(project, draft, context);
    const skipped = [
      { ...draft, source: { ...draft.source, promptFormat: 'ordinary' as const } },
      { ...draft, source: { promptFormat: 'h3' as const, language } },
      { ...draft, prompt: `${draft.prompt}\n手动改稿内容保留。` },
      { ...bound.draft, prompt: `${bound.draft.prompt}\n手动改稿内容保留。` },
    ];
    for (const candidate of skipped) {
      const before = structuredClone({ project, candidate });
      const result = prepareVideoH3ReferenceDraft(project, candidate, context);
      assert.equal(result.draft.prompt, candidate.prompt);
      assert.ok(result.characterStates.every((entry) => entry.status !== 'bound'), 'selected pictures do not prove a missing or manually changed source');
      assert.deepEqual({ project, candidate }, before);
    }
    for (const failure of ['missing', 'duplicate'] as const) {
      const current = headerlessH3Fixture(language);
      const metadata = language === 'zh' ? current.board.h3IdentityBindings! : current.board.h3IdentityBindingsEn!;
      const anchor = metadata.characters[0].referenceAnchor;
      if (failure === 'missing') metadata.characters[0].referenceAnchor = 'This exact identity anchor does not exist in the authored prompt.';
      else {
        current.draft.prompt += `\n${anchor}`;
        if (language === 'zh') current.board.officialPromptZh = current.draft.prompt;
        else current.board.officialPromptEn = current.draft.prompt;
      }
      const before = structuredClone({ project: current.project, draft: current.draft });
      const result = prepareVideoH3ReferenceDraft(current.project, current.draft, context);
      const expectedStatus = failure === 'duplicate' ? 'bound' : 'pending';
      assert.equal(result.characterStates.find((entry) => entry.characterId === 'a')?.status, expectedStatus);
      if (failure === 'duplicate') assert.match(result.draft.prompt, /Visual identity reference for 甲:/u);
      else assert.doesNotMatch(result.draft.prompt, /Visual identity reference for 甲:/u);
      for (const id of ['b', 'c', 'd']) assert.equal(result.characterStates.find((entry) => entry.characterId === id)?.status, 'bound');
      if (failure === 'missing') assert.ok(result.warnings.some((warning) => warning.includes('锚点已失效')));
      else assert.ok(result.warnings.some((warning) => warning.includes('身份句重复')));
      assert.deepEqual(multiViewPictureNumbers(result.draft.prompt), failure === 'duplicate' ? [3, 4, 5] : [4, 5], 'identity binding keeps multi-view instructions');
      assert.equal(withoutHeaderlessPictureBindings(result.draft.prompt), current.draft.prompt);
      assert.deepEqual({ project: current.project, draft: current.draft }, before);
    }
  }
});

await test('无标题H3冻结重试保留已绑定或历史待关联状态，不按现有分镜重新绑定', () => {
  for (const language of ['zh', 'en'] as const) {
    const { project, draft, board, config } = headerlessH3Fixture(language);
    const context = { backend: 'api' as const, api: config };
    const result = prepareVideoH3ReferenceDraft(project, draft, context);
    const boundRetry = { ...result.draft, reuseTaskId: 'frozen-bound-headerless' };
    const legacyRetry = { ...result.draft, prompt: draft.prompt, reuseTaskId: 'frozen-pending-headerless', h3ReferenceBinding: {
      ...result.draft.h3ReferenceBinding!, renderedPrompt: draft.prompt,
      characterStates: result.characterStates.map((entry) => ({ ...entry, status: 'pending' as const, reason: '历史任务保留的待关联状态。' })),
    } };
    board.officialPromptZh = '后来改写的中文稿'; board.officialPromptEn = 'A later edited English source';
    project.characters[0].name = '后来修改的姓名';
    for (const frozen of [boundRetry, legacyRetry]) {
      const before = structuredClone({ project, frozen });
      const retry = prepareVideoH3ReferenceDraft(project, frozen, context);
      assert.strictEqual(retry.draft, frozen);
      assert.equal(retry.draft.prompt, frozen.prompt);
      assert.deepEqual(retry.characterStates, frozen.h3ReferenceBinding!.characterStates);
      assert.deepEqual({ project, frozen }, before);
    }
  }
});

await test('现有Subject与保存表演编译保留本次多视图职责且不重复人物定义', () => {
  for (const savedPerformance of [false, true]) {
    const { project, draft } = fixture();
    project.assets[0].imageVariant = 'five-view';
    draft.source = { promptFormat: 'h3', language: 'en' };
    if (savedPerformance) {
      const rendered = renderH3PerformancePlan({ language: 'en', characters: identities.characters,
        plan: { version: 1, timeBase: 'clip', overallSoundscape: 'N/A', nonDiegeticMusic: 'N/A',
          characters: identities.characters.map((entry) => ({ characterId: entry.characterId, visualDescription: `${entry.name} keeps the authored appearance.` })),
          shots: [{ shotIndex: 1, startSec: 0, visualDescription: '甲 hands the map to 乙.', events: [] }] } });
      draft.prompt = rendered.prompt;
      draft.h3ReferenceBinding = { version: 1, projectId: project.id, basePrompt: rendered.prompt, renderedPrompt: rendered.prompt,
        identities: { version: 1, characters: rendered.characters, events: rendered.events, performance: rendered.plan } };
    }
    const before = structuredClone({ project, draft });
    const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api: cloud() });
    assert.equal(result.draft.h3ReferenceBinding?.executionCharacters?.length, 2);
    assert.deepEqual(multiViewPictureNumbers(result.draft.prompt), [2]);
    assert.match(result.draft.prompt, /<Picture 1> opening composition reference/u);
    assert.equal((result.draft.prompt.match(/Multi-view identity references:/gu) || []).length, 1);
    assert.equal(prepareVideoH3ReferenceDraft(project, result.draft, { backend: 'api', api: cloud() }).draft.prompt, result.draft.prompt);
    const plainProject = structuredClone(project); plainProject.assets[0].imageVariant = 'portrait';
    const plain = prepareVideoH3ReferenceDraft(plainProject, draft, { backend: 'api', api: cloud() });
    assert.equal(result.draft.prompt.replace(/Multi-view identity references:[^\r\n]*\r?\n/u, ''), plain.draft.prompt,
      'multi-view metadata adds a responsibility only; compiled people, actions, sounds and cuts stay the same');
    assert.deepEqual({ project, draft }, before);
  }
});

console.log(`${groups} H3 reference-binding regression groups passed (synthetic inputs, no real API)`);
