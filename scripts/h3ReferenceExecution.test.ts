import assert from 'node:assert/strict';
import { renderH3ReferenceExecution } from '../src/h3ReferenceExecution';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';
import { prepareVideoH3ReferenceDraft } from '../src/videoH3ReferenceBinding';
import { refreshVideoH3MediaModeDraft } from '../src/videoH3MediaMode';
import { createInitialState } from '../src/storage';
import type { Character, H3IdentityBindings, ReferenceAsset, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';

let groups = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); console.log(`PASS ${++groups} ${name}`); };
const anchors = ['林沐 (S1) 是黑发青年，穿灰色长袍。', '叶清碧 (S2) 是青白衣女性。', '祈凌霜 (S3) 是紫蓝衣女性。'];
const identities: H3IdentityBindings = { version: 1, characters: anchors.map((referenceAnchor, index) => ({
  characterId: ['lin', 'ye', 'qi'][index], name: ['林沐', '叶清碧', '祈凌霜'][index], speakerToken: `(S${index + 1})`, referenceAnchor,
})) };
const source = `integrated_multimodal_description:
[Shot 1] ${anchors.join('')}
画面左侧祈凌霜、中间林沐、右侧叶清碧，单一稳定机位，不互换位置。
0.50—1.50秒，叶清碧 (S2，女性发声身份，自然发声) 对林沐说：<d>[Chinese] 他说的本来就是实话。</d>叶清碧从林沐自身左侧伸出右手，以指尖轻拂他的左颊，立即收回。
2.75—3.45秒，林沐 (S1，男性发声身份，自然发声) 对叶清碧说：<d>[Chinese] 多谢师傅。</d>祈凌霜倾听。
3.55—6.55秒，祈凌霜 (S3，女性发声身份，自然发声) 先看叶清碧，再看林沐，问：<d>[Chinese] 师傅擦得真仔细。师弟，要是我来擦，你是不是也会说多谢？</d>
7.35—9.15秒，祈凌霜拿出帕子，从林沐自身右侧轻擦他的右颊。祈凌霜 (S3，女性发声身份，自然发声) 说：<d>[Chinese] 好了，这回干净了。</d>
[Shot 2] At 00:10.000 叶清碧 (S2) 看向祈凌霜，说：<d>[Chinese] 标牌上的“林沐 (S1)”与[Shot 99]不改。</d>屏幕显示“叶清碧 (S2) <Subject 99>”；<sound>原样衣料声。</sound>
overall_soundscape:
N/A

non_diegetic_music:
N/A`;
const pictures = new Map([['lin', [3]], ['ye', [4]], ['qi', [5]]]);
const literals = (prompt: string): string[] => [...prompt.matchAll(/<(d|sound)>[\s\S]*?<\/\1>/gu)].map((match) => match[0]);
const soundTail = (prompt: string): string => prompt.slice(prompt.indexOf('overall_soundscape:'));

await test('第三段指尖/帕子明确行动者与图/name/Subject/首发S同源，镜头时间对白声音保持', () => {
  const before = structuredClone(identities);
  const result = renderH3ReferenceExecution({ prompt: source, identities, characterPictures: pictures, language: 'zh' })!;
  assert.ok(result);
  assert.deepEqual(readH3PromptProtocol(result.prompt)?.sections, ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']);
  assert.deepEqual(readH3PromptProtocol(result.prompt)?.shots, readH3PromptProtocol(source)?.shots);
  assert.deepEqual(literals(result.prompt), literals(source));
  assert.equal(soundTail(result.prompt), soundTail(source));
  assert.match(result.prompt, /<Subject 2> is 叶清碧 \(S1\) referenced from <Picture 4>/u);
  assert.match(result.prompt, /<Subject 1> is 林沐 \(S2\) referenced from <Picture 3>/u);
  assert.match(result.prompt, /0\.50—1\.50秒，<Subject 2> 叶清碧 \(S1，女性发声身份，自然发声\)/u);
  assert.match(result.prompt, /<Subject 2> 叶清碧从<Subject 1> 林沐自身左侧伸出右手，以指尖轻拂他的左颊，立即收回。/u);
  assert.match(result.prompt, /7\.35—9\.15秒，<Subject 3> 祈凌霜拿出帕子，从<Subject 1> 林沐自身右侧轻擦他的右颊。/u);
  assert.match(result.prompt, /屏幕显示“叶清碧 \(S2\) <Subject 99>”/u);
  assert.deepEqual(result.characters.map(({ characterId, speakerToken }) => [characterId, speakerToken]), [['lin', '(S2)'], ['ye', '(S1)'], ['qi', '(S3)']]);
  assert.deepEqual(identities, before);
  assert.equal(renderH3ReferenceExecution({ prompt: result.prompt, identities: result.identities, characterPictures: pictures, language: 'zh' })?.prompt, result.prompt);
});

await test('明确事件ID可标注代词行动者，听者和被称呼人不反推行动者/说话人', () => {
  const eventText = '7.35—9.15秒，她拿出帕子，擦净林沐右颊。';
  const prompt = source.replace('7.35—9.15秒，祈凌霜拿出帕子，从林沐自身右侧轻擦他的右颊。', eventText);
  const data: H3IdentityBindings = { ...identities, events: [{ eventId: 'wipe-cloth', kind: 'action', referenceAnchor: eventText,
    actorCharacterId: 'qi', targetCharacterIds: ['lin'], listenerCharacterIds: ['ye'], addressedCharacterIds: ['ye'] }] };
  const result = renderH3ReferenceExecution({ prompt, identities: data, characterPictures: pictures })!;
  assert.match(result.prompt, /<Subject 3> 祈凌霜: 7\.35—9\.15秒，她拿出帕子，擦净<Subject 1> 林沐右颊。/u);
  assert.deepEqual(result.identities.events?.[0].targetCharacterIds, ['lin']);
  assert.ok(result.prompt.includes(result.identities.events![0].referenceAnchor!));
  const unknown = renderH3ReferenceExecution({ prompt, identities: { ...data, events: [{ ...data.events![0], actorCharacterId: undefined }] }, characterPictures: pictures })!;
  assert.ok(unknown.prompt.includes('7.35—9.15秒，她拿出帕子，擦净<Subject 1> 林沐右颊。'));
  assert.doesNotMatch(unknown.prompt, /祈凌霜: 7\.35/u);
  const speech = '10.00—11.00秒，她低声说：<d>[Chinese] 好。</d>';
  const speechSource = `integrated_multimodal_description:\n[Shot 1] ${anchors.join('')}\n${speech}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
  const explicit = renderH3ReferenceExecution({ prompt: speechSource, identities: { ...identities, events: [{ eventId: 'spoken', kind: 'dialogue',
    referenceAnchor: speech, speakerCharacterId: 'ye', listenerCharacterIds: ['lin'], addressedCharacterIds: ['qi'] }] }, characterPictures: pictures })!;
  assert.match(explicit.prompt, /她低声说：<Subject 2> 叶清碧 \(S1\): <d>\[Chinese\] 好。<\/d>/u);
  assert.ok(explicit.prompt.includes(explicit.identities.events![0].referenceAnchor!));
});

await test('已有六字段主体保留，人物重复使用/修改实际图槽不复制定义或吞镜头', () => {
  const first = renderH3ReferenceExecution({ prompt: source, identities, characterPictures: pictures })!;
  const result = renderH3ReferenceExecution({ prompt: first.prompt, identities: first.identities,
    characterPictures: new Map([['lin', [7]], ['ye', [8]], ['qi', [9, 10]]]) })!;
  assert.equal((result.prompt.match(/^<Subject 2> is /gmu) || []).length, 1);
  assert.match(result.prompt, /<Subject 2> is 叶清碧 \(S1\) referenced from <Picture 8>/u);
  assert.match(result.prompt, /<Subject 3> is 祈凌霜 \(S3\) referenced from <Picture 9>, <Picture 10>/u);
  assert.match(result.prompt, /<Subject 2>: fully_preserved - 叶清碧; reference <Picture 8>/u);
  assert.doesNotMatch(result.prompt.split('detailed_description:')[0], /<Picture [345]>/u);
  assert.deepEqual(readH3PromptProtocol(result.prompt)?.shots, readH3PromptProtocol(source)?.shots);
  assert.deepEqual(literals(result.prompt), literals(source));
  assert.equal(renderH3ReferenceExecution({ prompt: result.prompt, identities: result.identities,
    characterPictures: new Map([['lin', [7]], ['ye', [8]], ['qi', [9, 10]]]) })?.prompt, result.prompt);
});

await test('行动者和作用对象都为代词时消费各自明确ID，第三人发话不变成行动者且保持幂等', () => {
  const eventText = '3.00—4.00秒，她用指尖替他擦掉糖汁；旁边传来一句：<d>[Chinese] 慢一些。</d>';
  const prompt = `integrated_multimodal_description:\n[Shot 1] ${anchors.join('')}\n${eventText}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
  const data: H3IdentityBindings = { ...identities, events: [{ eventId: 'separate-action-and-speech', kind: 'action', referenceAnchor: eventText,
    actorCharacterId: 'qi', targetCharacterIds: ['lin'], speakerCharacterId: 'ye', listenerCharacterIds: ['lin'], addressedCharacterIds: ['qi'] }] };
  const result = renderH3ReferenceExecution({ prompt, identities: data, characterPictures: pictures, language: 'zh' })!;
  const body = result.prompt.split('detailed_description:')[1];
  assert.match(body, /行动者: <Subject 3> 祈凌霜; 作用对象: <Subject 1> 林沐\. 3\.00—4\.00秒，她用指尖替他擦掉糖汁/u);
  assert.match(body, /旁边传来一句：<Subject 2> 叶清碧 \(S1\): <d>\[Chinese\] 慢一些。<\/d>/u);
  assert.doesNotMatch(body, /行动者: <Subject 2> 叶清碧/u);
  assert.deepEqual(literals(result.prompt), literals(prompt));
  assert.ok(body.includes(result.identities.events![0].referenceAnchor!));
  assert.deepEqual(result.identities.events![0].targetCharacterIds, ['lin']);
  assert.equal(result.identities.events![0].actorCharacterId, 'qi');
  assert.equal(result.identities.events![0].speakerCharacterId, 'ye');
  assert.equal(renderH3ReferenceExecution({ prompt: result.prompt, identities: result.identities, characterPictures: pictures, language: 'zh' })?.prompt, result.prompt);
  const explicit = eventText.replace('她用指尖替他', '祈凌霜用指尖替林沐');
  const explicitData: H3IdentityBindings = { ...data, events: [{ ...data.events![0], referenceAnchor: explicit }] };
  const alreadyNamed = renderH3ReferenceExecution({ prompt: prompt.replace(eventText, explicit), identities: explicitData, characterPictures: pictures, language: 'zh' })!;
  assert.doesNotMatch(alreadyNamed.prompt, /行动者:|作用对象:/u);
  assert.ok(alreadyNamed.prompt.includes(alreadyNamed.identities.events![0].referenceAnchor!));
});

await test('Latin词界/中文重叠姓名/协议样例literal不会误替换', () => {
  const prompt = 'integrated_multimodal_description:\n[Shot 1] Ann (S8) is in blue. 安是长发女性。安宁是短发女性。 Annual Annette，Ann (S8) says: <d>[English] Ann, S8, <Subject 3> and [Shot 9].</d>安看安宁。标牌写着“Ann 安宁 (S8)”。\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
  const metadata: H3IdentityBindings = { version: 1, characters: [
    { characterId: 'ann', name: 'Ann', speakerToken: '(S8)', referenceAnchor: 'Ann (S8) is in blue.' },
    { characterId: 'an', name: '安', referenceAnchor: '安是长发女性。' },
    { characterId: 'anning', name: '安宁', referenceAnchor: '安宁是短发女性。' },
  ] };
  const result = renderH3ReferenceExecution({ prompt, identities: metadata, characterPictures: new Map([['ann', [2]], ['an', [3]], ['anning', [4]]]) })!;
  assert.match(result.prompt, /Annual Annette，<Subject 1> Ann \(S1\) says/u);
  assert.match(result.prompt, /<Subject 2> 安看<Subject 3> 安宁。/u);
  assert.match(result.prompt, /标牌写着“Ann 安宁 \(S8\)”。/u);
  assert.deepEqual(literals(result.prompt), literals(prompt));
});

await test('无events的明确非语言首发也参与S顺序，身份声明不算发声', () => {
  const prompt = `integrated_multimodal_description:\n[Shot 1] ${anchors.join('')}\n0.10秒，祈凌霜 (S3) 先轻笑一声。<sound>短促轻笑。</sound>\n0.80秒，叶清碧 (S2) 说：<d>[Chinese] 好。</d>\n1.50秒，林沐 (S1) 叹气。<sound>一声叹息。</sound>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
  const result = renderH3ReferenceExecution({ prompt, identities, characterPictures: pictures })!;
  assert.deepEqual(result.characters.map(({ characterId, speakerToken }) => [characterId, speakerToken]), [['lin', '(S3)'], ['ye', '(S2)'], ['qi', '(S1)']]);
  assert.match(result.prompt, /0\.10秒，<Subject 3> 祈凌霜 \(S1\) 先轻笑/u);
  assert.match(result.prompt, /1\.50秒，<Subject 1> 林沐 \(S3\) 叹气/u);
  assert.deepEqual(literals(result.prompt), literals(prompt));
});

const api: VideoTaskApiConfig = { enabled: true, provider: 'generic', endpoint: 'https://h3.test.invalid', statusEndpointTemplate: '',
  apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', model: 'fixture' };
const character = (id: string, name: string): Character => ({ id, name, assetIds: [`${id}-image`], gender: '', race: '', apparentAge: '', appearance: '', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' });
const image = (id: string): ReferenceAsset => ({ id: `${id}-image`, name: id, type: 'character', role: 'character',
  characterReferenceId: id, referenceEntityBinding: { kind: 'character', entityId: id }, dataUrl: 'data:image/png;base64,AAAA', tags: [], createdAt: 1, updatedAt: 1 });
const fixture = () => {
  const project = createInitialState().project;
  project.characters = [character('lin', '林沐'), character('ye', '叶清碧'), character('qi', '祈凌霜')];
  project.assets = ['lin', 'ye', 'qi'].map(image); project.storyboards = []; project.generationTasks = [];
  const draft: VideoGenerationDraft = { name: '执行映射', backend: 'api', prompt: source, parameters: {},
    source: { promptFormat: 'h3', language: 'zh' }, references: ['qi', 'lin', 'ye'].map((id) => ({ assetId: `${id}-image`, role: 'character' })),
    h3ReferenceBinding: { version: 1, projectId: project.id, basePrompt: source, renderedPrompt: source, identities: structuredClone(identities) } };
  return { project, draft };
};

await test('实际提交选图顺序驱动Picture；重复准备幂等；撤图恢复源稿；任务快照冻结', () => {
  const { project, draft } = fixture(); const before = structuredClone({ project, draft });
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api }).draft;
  assert.match(result.prompt, /<Subject 2> is 叶清碧 \(S1\) referenced from <Picture 3>/u);
  assert.match(result.prompt, /<Subject 3> is 祈凌霜 \(S3\) referenced from <Picture 1>/u);
  assert.equal(result.h3MediaMode?.authoredMode, 'full-reference');
  assert.equal(result.h3ReferenceBinding?.basePrompt, source);
  assert.deepEqual(result.h3ReferenceBinding?.identities, identities);
  assert.equal(prepareVideoH3ReferenceDraft(project, result, { backend: 'api', api }).draft.prompt, result.prompt);
  assert.equal(prepareVideoH3ReferenceDraft(project, { ...result, references: [] }, { backend: 'api', api }).draft.prompt, source);
  const frozen = { ...result, reuseTaskId: 'frozen-task' };
  assert.equal(prepareVideoH3ReferenceDraft(project, frozen, { backend: 'api', api }).draft, frozen);
  assert.deepEqual({ project, draft }, before);
});

await test('明确更新本次参考同样纯编译，无LLM；不可信历史稿保守兼容不猜人', async () => {
  const { project, draft } = fixture(); let calls = 0;
  const result = await refreshVideoH3MediaModeDraft({ project, draft, context: { backend: 'api', api },
    request: async () => { calls += 1; throw new Error('不应调用LLM'); } });
  assert.equal(calls, 0);
  assert.equal(result.h3MediaMode?.authoredMode, 'full-reference');
  assert.equal(result.h3MediaMode?.referenceUpdateCurrent, true);
  const historical = { ...draft, h3ReferenceBinding: undefined, source: { promptFormat: 'h3' as const, language: 'zh' as const } };
  const unchanged = await refreshVideoH3MediaModeDraft({ project, draft: historical, context: { backend: 'api', api },
    request: async () => { calls += 1; throw new Error('不应调用LLM'); } });
  assert.equal(unchanged.prompt, source); assert.equal(calls, 0);
});

await test('Picture重排同步事件原锚点；历史对白/动作锚点不会搬出原镜头', () => {
  const { project, draft } = fixture();
  const event = '7.35—9.15秒，她站在<Picture 9>前拿出帕子，擦净林沐右颊。';
  const prompt = source.replace('7.35—9.15秒，祈凌霜拿出帕子，从林沐自身右侧轻擦他的右颊。', event);
  project.assets.push({ id: 'scene-image', name: '场景', type: 'location', role: 'scene', dataUrl: 'data:image/png;base64,AAAA', tags: [], createdAt: 1, updatedAt: 1 });
  draft.prompt = prompt; draft.references.push({ assetId: 'scene-image', role: 'scene' });
  draft.h3ReferenceBinding = { ...draft.h3ReferenceBinding!, basePrompt: prompt, renderedPrompt: prompt,
    sourcePictures: [{ number: 9, assetId: 'scene-image' }], identities: { ...identities, events: [{ eventId: 'wipe', kind: 'action', referenceAnchor: event,
      actorCharacterId: 'qi', targetCharacterIds: ['lin'] }] } };
  const result = prepareVideoH3ReferenceDraft(project, draft, { backend: 'api', api }).draft;
  assert.match(result.prompt, /<Subject 3> 祈凌霜: 7\.35—9\.15秒，她站在<Picture 4>前拿出帕子，擦净<Subject 1> 林沐右颊。/u);
  assert.ok(result.prompt.includes(result.h3ReferenceBinding!.executionIdentities!.events![0].referenceAnchor!));
  assert.equal(draft.h3ReferenceBinding.identities.events![0].referenceAnchor, event);
  for (const locator of ['<d>[Chinese] 他说的本来就是实话。</d>', '祈凌霜拿出帕子，从林沐自身右侧轻擦他的右颊。']) {
    const data = structuredClone(identities); data.characters[1].referenceAnchor = locator;
    const compiled = renderH3ReferenceExecution({ prompt: source, identities: data, characterPictures: pictures })!;
    assert.deepEqual(literals(compiled.prompt), literals(source));
    assert.doesNotMatch(compiled.prompt.split('detailed_description:')[0], /<d>|拿出帕子/u);
    assert.match(compiled.prompt.split('detailed_description:')[1], /7\.35—9\.15秒，<Subject 3> 祈凌霜拿出帕子/u);
  }
});
