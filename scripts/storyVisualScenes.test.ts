import assert from 'node:assert/strict';
import {
  assembleStoryVisualSceneParagraphs,
  normalizeStoryVisualActionPlan,
  normalizeStoryVisualParagraphs,
  normalizeStoryVisualScenes,
  renderStoryVisualScenes,
  storyVisualSourceParagraphs,
  storyVisualSourceQuotes,
  type StoryVisualActionPlan,
  type StoryVisualEvent,
  type StoryVisualParagraph,
} from '../src/storyVisualAction';

// These fixtures exercise source-preserving assembly, not model quality.
const source = '数天后，夏娃从战舰走出，张开双臂紧紧抱住吴小观，激动地笑出声。\n\n'
  + '随后的日子里，吴小观的伤势也已大致痊愈。这一天，他独自盘坐在森林空地，整理“炼狱之门”。他抬头望向龙娘。'
  + '龙娘说：“等你什么时候到了娘的实力再来找我们吧，你现在也不过在姬的最下层。”门外女仆应道：「我在门外等候。」她们提到了不在场的国王。';
const sourceParagraphs = storyVisualSourceParagraphs(source);
const sourceQuotes = storyVisualSourceQuotes(sourceParagraphs);
assert.deepEqual(sourceQuotes.map((quote) => [quote.id, quote.text]), [
  ['p2-q1', '炼狱之门'],
  ['p2-q2', '等你什么时候到了娘的实力再来找我们吧，你现在也不过在姬的最下层。'],
  ['p2-q3', '我在门外等候。'],
]);
for (const quote of sourceQuotes) {
  const paragraph = sourceParagraphs.find((item) => item.id === quote.sourceParagraphId)!;
  assert.equal(paragraph.text.slice(quote.sourceStart + 1, quote.sourceEnd - 1), quote.text);
}
assert.equal(storyVisualSourceQuotes('甲说：“  不要改空格！  ”')[0].text, '  不要改空格！  ');
assert.deepEqual(storyVisualSourceQuotes(`甲说："Don't leave."`)[0].text, "Don't leave.");
assert.deepEqual(storyVisualSourceQuotes('甲说：“他说‘回来’。”').map((quote) => quote.text), ['他说‘回来’。', '回来']);

const event = (id: string, overrides: Partial<StoryVisualEvent>): StoryVisualEvent => ({
  id, sourceParagraphIds: ['p2'], evidence: '', actor: '', target: '', action: '', result: '', uncertainties: [], ...overrides,
});
const plan: StoryVisualActionPlan = {
  version: 1, sourceParagraphs, sourceQuotes, summary: '拥抱重逢之后，经过一段日子，吴小观整理奖励并受到龙娘拒绝。',
  scenes: [
    { id: 'return', title: '修复归来', time: '数天后', timeRelation: '承接前事数日之后', location: '战舰外', setting: '战舰外的空地',
      participants: [{ id: 'eve', name: '夏娃', presence: 'present' }, { id: 'wu', name: '吴小观', presence: 'present' }],
      eventIds: ['hug'], sourceParagraphIds: ['p1'] },
    { id: 'reward', title: '整理战斗奖励', time: '这一天', timeRelation: '随后的日子里，吴小观的伤势已大致痊愈', location: '森林空地',
      setting: '森林空地中央', participants: [
        { id: 'wu', name: '吴小观', presence: 'present' },
        { id: 'dragon', name: '龙娘', aliases: ['她'], existingEntityId: 'character-dragon', presence: 'present', eventIds: ['refusal'] },
        { id: 'maid', name: '女仆', presence: 'offscreen', eventIds: ['maid-line'] },
        { id: 'king', name: '国王', presence: 'mentioned' },
      ], eventIds: ['maid-line', 'refusal', 'reward-event', 'look'], sourceParagraphIds: ['p2'] },
  ],
  events: [
    event('hug', { sceneId: 'return', kind: 'action', sourceParagraphIds: ['p1'], actor: '夏娃', target: '吴小观',
      action: '夏娃张开双臂紧紧抱住吴小观，激动地笑出声。', phases: ['张开双臂', '紧紧抱住', '保持拥抱'], result: '两人仍在拥抱',
      sourceStart: 0, sourceEnd: sourceParagraphs[0].text.length }),
    event('reward-event', { sceneId: 'reward', kind: 'action', actor: '吴小观', action: '吴小观独自盘坐，整理“炼狱之门”。', sourceQuoteIds: ['p2-q1'] }),
    event('look', { sceneId: 'reward', kind: 'action', actor: '吴小观', target: '龙娘', action: '吴小观抬头望向龙娘。' }),
    event('refusal', { sceneId: 'reward', kind: 'dialogue', actor: '龙娘', target: '吴小观', speaker: '龙娘', action: '龙娘拒绝吴小观的挑战。',
      participantIds: ['dragon', 'wu'], dialogue: '模型改过的台词不应覆盖原话', sourceQuoteIds: ['p2-q2'] }),
    event('maid-line', { sceneId: 'reward', kind: 'dialogue', actor: '女仆', speaker: '女仆', dialogue: '另一句不应替换原话的台词', sourceQuoteIds: ['p2-q3'] }),
  ],
};
const details = normalizeStoryVisualParagraphs([
  { id: 'd1', sceneId: 'return', eventDetails: [
    { eventId: 'hug', text: '夏娃双臂合拢，在相拥中保持接触，笑声随拥抱持续。', stagingAdditions: [] },
  ] },
  { id: 'd2', sceneId: 'reward', eventDetails: [
    { eventId: 'refusal', text: '龙娘说：“你太弱了，下次再来！”', stagingAdditions: [] },
    { eventId: 'reward-event', text: '吴小观低头整理奖励。', stagingAdditions: [] },
  ] },
]);
assert.equal(details.length, 2, 'event detail responses do not need a second prose rewrite');
assert.equal(details[0].text, '');
assert.equal(details[0].sceneId, 'return');

const rendered = assembleStoryVisualSceneParagraphs(plan, details);
assert.equal(rendered.length, 2);
assert.deepEqual(rendered.map((paragraph) => paragraph.sceneId), ['return', 'reward']);
for (const paragraph of rendered) {
  const headings = ['时间：', '地点：', '人物：', '场景：', '剧情：'];
  const positions = headings.map((heading) => paragraph.text.indexOf(`\n${heading}`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
}
assert.match(rendered[0].text, /时间：数天后；承接前事数日之后/u);
assert.match(rendered[1].text, /时间：这一天；随后的日子里，吴小观的伤势已大致痊愈/u);
assert.match(rendered[0].text, /夏娃张开双臂紧紧抱住吴小观/u);
assert.match(rendered[0].text, /过程细化：夏娃双臂合拢/u);
assert.match(rendered[0].text, /结果：两人仍在拥抱/u);
assert.match(rendered[1].text, /人物：吴小观、龙娘、女仆（画外）/u);
assert.doesNotMatch(rendered[1].text.split('\n').find((line) => line.startsWith('人物：'))!, /国王/u);
assert.match(rendered[1].text, /龙娘：“等你什么时候到了娘的实力再来找我们吧，你现在也不过在姬的最下层。”/u);
assert.match(rendered[1].text, /女仆：“我在门外等候。”/u);
assert.doesNotMatch(rendered[1].text, /你太弱了|模型改过|另一句不应/u);
assert.ok(rendered[1].eventDetails?.every((detail) => detail.eventId !== 'refusal'), 'second-stage speech does not become adopted action detail');
assert.match(rendered[1].text, /吴小观抬头望向龙娘/u, 'missing second-stage detail must not delete a first-stage event');
assert.doesNotMatch(rendered[1].text, /：“炼狱之门”/u, 'a quote reference does not turn a named concept into dialogue');
assert.deepEqual(rendered[1].eventIds, ['reward-event', 'look', 'refusal', 'maid-line'], 'event order belongs to the source plan');
assert.deepEqual(assembleStoryVisualSceneParagraphs(plan, rendered), rendered, 'assembly is idempotent');
assert.equal(renderStoryVisualScenes(plan, rendered), rendered.map((paragraph) => paragraph.text).join('\n\n'));

const stagingPlan: StoryVisualActionPlan = { ...plan, sceneStaging: [{ version: 1, sceneId: 'return',
  sourceEventIds: ['hug'], worldRelations: ['同一战舰外空地'], entryState: '夏娃与吴小观尚未接触',
  participants: [{ id: 'eve', name: '夏娃', position: '吴小观面前', bodyFacing: '吴小观' }],
  phases: [{ id: 'embrace', eventId: 'hug', participantIds: ['eve'], startState: '尚未接触', action: '夏娃张开双臂', endState: '准备抱住' }],
}] };
const stagingBatches = normalizeStoryVisualParagraphs([
  { id: 'hug-batch-1', sceneId: 'return', eventIds: ['hug'], eventDetails: [], sceneStaging: {
    version: 1, sceneId: 'return', sourceEventIds: ['hug'], entryState: '夏娃已张开双臂', exitState: '夏娃已经抱住吴小观',
    participants: [{ id: 'eve', name: '夏娃', position: '贴近吴小观' }],
    phases: [{ id: 'embrace', eventId: 'hug', participantIds: ['eve', 'wu'], startState: '双臂张开',
      action: '夏娃双臂合拢抱住吴小观', endState: '双臂已经合拢' }],
  } },
  { id: 'hug-batch-2', sceneId: 'return', eventIds: ['hug'], eventDetails: [], sceneStaging: {
    version: 1, sceneId: 'return', sourceEventIds: ['hug'], entryState: '双臂已经合拢', exitState: '两人保持拥抱',
    participants: [{ id: 'eve', name: '夏娃', position: '紧贴吴小观', gazeTarget: '吴小观' },
      { id: 'wu', name: '吴小观', position: '夏娃怀中' }],
    phases: [{ id: 'hold', eventId: 'hug', participantIds: ['eve', 'wu'], startState: '已经抱住',
      action: '持续保持拥抱', endState: '没有松开双臂' }],
  } },
]);
const stagingInputs = structuredClone({ plan: stagingPlan, paragraphs: stagingBatches });
const stagingRendered = assembleStoryVisualSceneParagraphs(stagingPlan, stagingBatches);
const mergedStaging = stagingRendered[0].sceneStaging!;
assert.deepEqual(mergedStaging.phases?.map((phase) => phase.id), ['embrace', 'hold'], 'later batch phases are retained in source order');
assert.equal(mergedStaging.entryState, '夏娃与吴小观尚未接触');
assert.equal(mergedStaging.exitState, '两人保持拥抱');
assert.equal(mergedStaging.phases?.[0].startState, '尚未接触');
assert.equal(mergedStaging.phases?.[0].endState, '双臂已经合拢');
assert.deepEqual(mergedStaging.phases?.[0].participantIds, ['eve', 'wu']);
assert.equal(mergedStaging.participants?.find((person) => person.id === 'eve')?.position, '紧贴吴小观');
assert.equal(mergedStaging.participants?.find((person) => person.id === 'eve')?.bodyFacing, '吴小观');
assert.deepEqual(mergedStaging.participants?.map((person) => person.id), ['eve', 'wu']);
assert.deepEqual(mergedStaging.sourceEventIds, ['hug']);
assert.deepEqual(assembleStoryVisualSceneParagraphs(stagingPlan, stagingRendered), stagingRendered, 'merged staging remains idempotent');
assert.deepEqual({ plan: stagingPlan, paragraphs: stagingBatches }, stagingInputs, 'scene merge does not mutate its stored sources');

const repeated = normalizeStoryVisualActionPlan({ ...plan, events: [{ ...plan.events[0], phases: ['敲门', '敲门', '等待'] }] }, source)!;
assert.deepEqual(repeated.events[0].phases, ['敲门', '敲门', '等待'], 'separate identical action phases retain their occurrences');
assert.equal(repeated.events[0].sourceStart, 0);
assert.equal(repeated.events[0].sourceEnd, sourceParagraphs[0].text.length);
assert.deepEqual(repeated.sourceQuotes, sourceQuotes, 'quote text is rebuilt from the original, not model text');
const repeatedDetails = normalizeStoryVisualParagraphs([{ sceneId: 'return', eventDetails: [
  { eventId: 'hug', text: '保持接触' }, { eventId: 'hug', text: '保持接触' },
] }]);
assert.equal(repeatedDetails[0].eventDetails?.length, 2, 'ordered detail records are not deduplicated');

const mergedScenes = normalizeStoryVisualScenes([
  plan.scenes![1],
  { ...plan.scenes![1], eventIds: ['refusal', 'look'], participants: [
    { id: 'dragon-next-batch', name: '龙娘', aliases: ['龙姑娘'], existingEntityId: 'character-dragon', presence: 'present', eventIds: ['look'] },
    { id: 'bear', name: '熊娘', presence: 'present' },
  ] },
], plan.events);
assert.equal(mergedScenes.length, 1);
assert.equal(mergedScenes[0].participants.filter((participant) => participant.existingEntityId === 'character-dragon').length, 1);
assert.deepEqual(mergedScenes[0].participants.find((participant) => participant.id === 'dragon')?.aliases, ['她', '龙姑娘']);
assert.deepEqual(mergedScenes[0].eventIds, ['reward-event', 'look', 'refusal', 'maid-line']);
assert.equal(mergedScenes[0].participants.at(-1)?.name, '熊娘');

const oldParagraphs: StoryVisualParagraph[] = [{ id: 'old', sourceParagraphIds: ['p1'], eventIds: [], text: '旧稿原样保留。', stagingAdditions: [] }];
const oldPlan: StoryVisualActionPlan = { version: 1, sourceParagraphs: [{ id: 'p1', text: '旧原文' }], events: [], summary: '旧状态' };
assert.deepEqual(normalizeStoryVisualActionPlan(oldPlan, '旧原文'), oldPlan);
assert.deepEqual(normalizeStoryVisualParagraphs(oldParagraphs), oldParagraphs);
assert.deepEqual(assembleStoryVisualSceneParagraphs(oldPlan, oldParagraphs), oldParagraphs);
assert.equal(renderStoryVisualScenes(oldPlan, oldParagraphs), '旧稿原样保留。');

const fallbackSpeech = { ...plan, events: [event('fallback-line', { sceneId: 'return', kind: 'dialogue', speaker: '夏娃', dialogue: '没有引用编号的旧对白。' })] };
assert.match(renderStoryVisualScenes(fallbackSpeech, []), /夏娃：“没有引用编号的旧对白。”/u);
const sceneFreeSpeech: StoryVisualActionPlan = { version: 1, sourceParagraphs, events: [
  event('door-answer', { kind: 'dialogue', actor: '玉小刚', speaker: '玉小刚', action: '玉小刚低声应门，声音从门后传来。', dialogue: '进来。' }),
], summary: '门外有人敲门，玉小刚隔门应答。' };
const sceneFreeRendered = renderStoryVisualScenes(sceneFreeSpeech, [{ id: 'body', sourceParagraphIds: ['p1'], eventIds: [],
  text: '玉小刚低声应门。人物发声，声音从门后传来。', stagingAdditions: [] }]);
assert.match(sceneFreeRendered, /玉小刚：“进来。”/u, 'structured dialogue is serialized even when the model supplies no scene records');
assert.doesNotMatch(sceneFreeRendered, /人物发声/u, 'model-authored generic prose cannot replace structured dialogue');
const unassigned = { ...plan, events: [...plan.events, event('unassigned', { action: '原文事件仍然保留。' })] };
assert.match(renderStoryVisualScenes(unassigned, []), /原文事件仍然保留/u);

console.log('PASS source-preserving scene assembly, time boundaries, dialogue, ordered actions, batch merge and legacy compatibility');
