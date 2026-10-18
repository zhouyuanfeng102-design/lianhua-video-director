import assert from 'node:assert/strict';
import { renderH3ReferenceExecution } from '../src/h3ReferenceExecution';
import { renderH3PerformancePlan } from '../src/h3PerformancePlan';
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

await test('静默人物身份句的旧S不与重新排序后的实际说话人共用', () => {
  const metadata: H3IdentityBindings = { version: 1, characters: identities.characters.map((entry, index) => {
    if (index !== 1) return { ...entry };
    const { speakerToken: _voice, ...silent } = entry;
    return silent;
  }) };
  const prompt = `integrated_multimodal_description:\n[Shot 1] ${anchors.join('')}\n林沐 (S1) 说：<d>[Chinese] 久等了。</d>\n祈凌霜 (S3) 问：<d>[Chinese] 你是谁？</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
  const result = renderH3ReferenceExecution({ prompt, identities: metadata, characterPictures: pictures, language: 'zh' })!;
  assert.ok(result);
  assert.equal(result.characters.find((entry) => entry.characterId === 'ye')?.speakerToken, undefined);
  assert.equal(result.identities.characters.find((entry) => entry.characterId === 'ye')?.speakerToken, undefined);
  assert.equal(result.characters.find((entry) => entry.characterId === 'qi')?.speakerToken, '(S2)');
  assert.doesNotMatch(result.prompt, /叶清碧\s*\(S2\)/u);
  assert.match(result.prompt, /祈凌霜 \(S2\) 问/u);
  assert.deepEqual(literals(result.prompt), literals(prompt));
});

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

await test('已保存表演换图只更新Picture，时间/原话/静默与冻结请求不变', () => {
  const { project, draft } = fixture();
  const rendered = renderH3PerformancePlan({ language: 'zh', characters: identities.characters,
    plan: { version: 1, timeBase: 'shot', overallSoundscape: '脚步与对白声。', nonDiegeticMusic: 'N/A',
      characters: identities.characters.map((entry) => ({ characterId: entry.characterId, visualDescription: `${entry.name}沿用已确认外观` })),
      shots: [{ shotIndex: 1, startSec: 0, visualDescription: '三人保持对峙。', events: [] },
        { shotIndex: 2, startSec: 6.5, visualDescription: '镜头转向祈凌霜。', events: [
          { kind: 'visual', eventId: 'look', startSec: 0, endSec: 4, sourceFact: '确认不在场的历史人物',
            description: '林沐扫视远方，收回目光。', silentCharacterIds: ['lin'] },
          { kind: 'speech', eventId: 'ask', dialogueId: 'd-ask', speakerCharacterIds: ['qi'], listenerCharacterIds: ['lin', 'ye'],
            text: '你是谁？', language: 'Chinese', channel: 'on-screen', startSec: 5, endSec: 6.6 },
        ] }] } });
  const bound: H3IdentityBindings = { version: 1, characters: rendered.characters, events: rendered.events, performance: rendered.plan };
  const input: VideoGenerationDraft = { ...draft, prompt: rendered.prompt,
    h3ReferenceBinding: { ...draft.h3ReferenceBinding!, basePrompt: rendered.prompt, renderedPrompt: rendered.prompt, identities: bound } };
  const first = prepareVideoH3ReferenceDraft(project, input, { backend: 'api', api }).draft;
  assert.match(first.prompt, /<Subject 3> 是 祈凌霜 \(S1\)，视觉参考为<Picture 1>/u);
  assert.match(first.prompt, /本段11\.50–13\.10秒，<Subject 3> 祈凌霜 \(S1\)/u);
  assert.doesNotMatch(first.prompt, /确认不在场|林沐\s*\(S\d\)|叶清碧\s*\(S\d\)/u);
  assert.match(first.prompt, /overall_soundscape:\n脚步与对白声。/u);
  assert.equal(first.h3ReferenceBinding?.executionIdentities?.performance?.timeBase, 'clip');
  assert.equal(prepareVideoH3ReferenceDraft(project, first, { backend: 'api', api }).draft.prompt, first.prompt);
  const swapped = prepareVideoH3ReferenceDraft(project, { ...first, references: [...first.references].reverse() }, { backend: 'api', api }).draft;
  assert.match(swapped.prompt, /<Subject 3> 是 祈凌霜 \(S1\)，视觉参考为<Picture 3>/u);
  assert.deepEqual(literals(swapped.prompt), literals(first.prompt));
  assert.equal(swapped.h3ReferenceBinding?.executionIdentities?.performance?.shots[1].events[1].startSec, 11.5);
  assert.deepEqual(swapped.h3ReferenceBinding?.identities, bound);
  const frozen = { ...first, reuseTaskId: 'saved-request' };
  assert.equal(prepareVideoH3ReferenceDraft(project, frozen, { backend: 'api', api }).draft, frozen);
  const narratorPlan = structuredClone(rendered.plan);
  narratorPlan.characters!.push({ characterId: 'narrator', name: '叙述者', presence: 'offscreen', visualDescription: '' });
  narratorPlan.shots[0].events.push({ kind: 'speech', eventId: 'narration', dialogueId: 'd-narration',
    speakerCharacterIds: ['narrator'], text: '既有旁白。', language: 'Chinese', channel: 'voiceover', startSec: 0, endSec: 1 });
  const withNarrator = renderH3PerformancePlan({ language: 'zh', mode: 'full-reference', characters: identities.characters,
    plan: narratorPlan, characterPictures: pictures, characterAudio: new Map([['narrator', [4]], ['qi', [2]]]) });
  const narratorBindings: H3IdentityBindings = { version: 1, characters: withNarrator.characters,
    events: withNarrator.events, performance: withNarrator.plan };
  const again = renderH3ReferenceExecution({ prompt: withNarrator.prompt, identities: narratorBindings,
    language: 'zh', characterPictures: pictures })!;
  assert.equal((again.prompt.match(/声音身份: 叙述者/gmu) || []).length, 1);
  assert.match(again.prompt, /声音身份: 叙述者 \(S1\)[^\n]*<Audio 4>/u);
  assert.match(again.prompt, /<Subject 3> 是 祈凌霜 \(S2\)[^\n]*<Audio 2>/u);
});

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
