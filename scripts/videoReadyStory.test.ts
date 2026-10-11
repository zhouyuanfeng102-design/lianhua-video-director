import assert from 'node:assert/strict';
import { requestStoryPreparationWithReview } from '../src/services/llm';
import { normalizeStoryVisualActionPlan, normalizeStoryVisualParagraphs, reviewStoryVisualAction, storyVisualSourceParagraphs, type StoryVisualActionPlan, type StoryVisualParagraph } from '../src/storyVisualAction';
import { readStoryVisualData, type CapturedStoryRequest } from './storyVisualTestFixtures';
import type { TextApiConfig } from '../src/types';

const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://visual.test.invalid/v1', apiKey: 'mock-only', model: 'mock', temperature: 0.2, maxTokens: 8192, vision: false };
const originalWindow = globalThis.window;
const source = [
  '绝死用尽全力，将森林精灵王尸体踢向少女。尸体以连常人都难以躲避的速度飞去。',
  '少女很轻松地避开了。尸体穿过门廊撞在后方墙上，发出巨响，血花在墙上绽开。',
  '绝死推测少女至少还有一名同伴，或者存在能变形的魔法道具，但尚未看到同伴。',
  '绝死露出微笑，开口回答：“你是谁？”',
].join('\n\n');
const plan: StoryVisualActionPlan = { version: 1, sourceParagraphs: storyVisualSourceParagraphs(source), summary: '绝死将尸体踢向少女；少女避开，尸体撞墙。未知少女同伴是否存在。', events: [
  { id: 'e1', sourceParagraphIds: ['p1'], evidence: '将森林精灵王尸体踢向少女', actor: '绝死', target: '少女', action: '踢尸体攻击少女', phases: ['尸体受踢向少女飞去'], result: '尸体高速飞去', uncertainties: ['用哪条腿踢、少女避让方向未指定'] },
  { id: 'e2', sourceParagraphIds: ['p2'], evidence: '少女很轻松地避开了', actor: '少女', target: '尸体', action: '避开飞来的尸体', phases: ['少女避让', '尸体没有击中少女'], result: '少女避开', uncertainties: ['避让姿势与方向未指定'] },
  { id: 'e3', sourceParagraphIds: ['p2'], evidence: '尸体穿过门廊撞在后方墙上', actor: '尸体', target: '后方墙', action: '撞墙', result: '巨响，血花绽开', uncertainties: [] },
  { id: 'e4', sourceParagraphIds: ['p3'], evidence: '绝死推测少女至少还有一名同伴', actor: '绝死', target: '', action: '推测可能有同伴或变形道具', result: '尚未见到同伴', uncertainties: ['同伴存在与道具能力均未证实'] },
  { id: 'e5', sourceParagraphIds: ['p4'], evidence: '绝死露出微笑，开口回答：“你是谁？”', actor: '绝死', target: '', action: '微笑后回答', result: '', uncertainties: [] },
] };
const paragraphs: StoryVisualParagraph[] = [
  { id: 'v1', sourceParagraphIds: ['p1', 'p2'], eventIds: ['e1', 'e2', 'e3'], text: '绝死用尽全力将森林精灵王的尸体踢向少女。尸体沿门廊高速飞向少女所在的位置；少女轻松避开，尸体从她原来的位置飞过，继续穿过门廊撞上后方墙。撞击发出巨响，血花在墙面绽开。', stagingAdditions: [] },
  { id: 'v2', sourceParagraphIds: ['p3'], eventIds: ['e4'], text: '绝死推测少女可能另有同伴，或者持有能变形的魔法道具；这些推测尚未证实，她还没有看到少女的同伴。', stagingAdditions: [] },
  { id: 'v3', sourceParagraphIds: ['p4'], eventIds: ['e5'], text: '绝死露出微笑，开口回答：“你是谁？”', stagingAdditions: [] },
];
let requests: CapturedStoryRequest[] = [];
let checks = 0;
try {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: { request: async (payload: { body?: string }) => {
    const request = JSON.parse(payload.body || '{}') as CapturedStoryRequest; requests.push(request);
    const data = readStoryVisualData(request);
    const response = data.stage === 'understanding' ? plan : { paragraphs };
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }) };
  } } } });
  const result = await requestStoryPreparationWithReview(config, source, undefined, undefined, 'optimize');
  assert.equal(requests.length, 2);
  assert.equal(result.text, paragraphs.map((paragraph) => paragraph.text).join('\n\n'));
  assert.deepEqual(result.actionPlan, plan);
  assert.equal(result.warnings.filter((warning) => warning.kind.startsWith('dialogue-')).length, 0);
  const prompts = requests.map((request) => request.messages.map((message) => message.content).join('\n')).join('\n');
  for (const requirement of ['踢不能改为扔', '躲过不能改为挡住', '猜测不能写成已发生', '连续交锋分别记录', 'stagingAdditions', '准备', '路径', '终态']) assert.ok(prompts.includes(requirement), requirement);
  assert.match(result.text, /踢向少女/u);
  assert.doesNotMatch(result.text, /同伴走出|少女受伤|扔向|翻滚/u);
  checks++;

  assert.equal(normalizeStoryVisualActionPlan({ ...plan, events: [{ ...plan.events[0], evidence: '投掷尸体' }] }, source)?.events[0].evidence, '投掷尸体', 'metadata stays an unverified model claim, without a local source gate');
  assert.deepEqual(normalizeStoryVisualActionPlan({ ...plan, events: [{ ...plan.events[0], sourceParagraphIds: ['p99'] }] }, source)?.events[0].sourceParagraphIds, ['p99']);
  assert.equal(normalizeStoryVisualParagraphs([{ ...paragraphs[0], eventIds: ['e99'] }], plan).length, 1);
  checks++;

  const alteredTarget = [{ ...paragraphs[0], text: '绝死踢出尸体，撞上后方墙。' }, ...paragraphs.slice(1)];
  assert.deepEqual(reviewStoryVisualAction(source, alteredTarget.map((paragraph) => paragraph.text).join('\n\n'), plan, alteredTarget), [], 'local ownership checking is disabled');
  const omitted = paragraphs.filter((paragraph) => paragraph.id !== 'v2');
  assert.deepEqual(reviewStoryVisualAction(source, omitted.map((paragraph) => paragraph.text).join('\n\n'), plan, omitted), [], 'local metadata completeness checking is disabled');
  const changed = paragraphs.map((paragraph) => ({ ...paragraph, text: paragraph.text.replace('你是谁？', '你想干什么？') }));
  assert.deepEqual(reviewStoryVisualAction(source, changed.map((paragraph) => paragraph.text).join('\n\n'), plan, changed), [], 'local dialogue checking is disabled');
  checks++;

  const multi = '甲向乙刺剑，乙拨开剑尖。甲随即横斩丙，丙退开，剑锋落空。';
  const multiPlan: StoryVisualActionPlan = { version: 1, sourceParagraphs: storyVisualSourceParagraphs(multi), summary: '甲两次攻击，目标分别为乙、丙，第二击落空。', events: [
    { id: 'a1', sourceParagraphIds: ['p1'], evidence: '甲向乙刺剑', actor: '甲', target: '乙', action: '刺剑', result: '乙拨开', uncertainties: [] },
    { id: 'a2', sourceParagraphIds: ['p1'], evidence: '甲随即横斩丙', actor: '甲', target: '丙', action: '横斩', result: '丙退开，落空', uncertainties: [] },
  ] };
  assert.ok(normalizeStoryVisualActionPlan(multiPlan, multi));
  const staged = normalizeStoryVisualParagraphs([{ id: 's1', sourceParagraphIds: ['p1'], eventIds: ['a1', 'a2'], text: multi, stagingAdditions: ['甲刺剑后将身体重心转向丙；原文未指定转身方式。'] }], multiPlan);
  assert.equal(staged[0].stagingAdditions.length, 1, 'source facts and unsupported spatial choreography remain separate metadata');
  checks++;

  const complex = '李云固定箱盖，旋开锁扣，抽出卡住的插销，再扶住盖子向上掀开。';
  const complexPlan = { version: 1, sourceParagraphs: storyVisualSourceParagraphs(complex), summary: '先固定，后开扣、抽销、掀盖。', events: [{ id: 'c1', sourceParagraphIds: ['p1'], evidence: complex, actor: '李云', target: '箱盖', action: '开箱', phases: ['固定箱盖', '旋开锁扣', '抽出插销', '扶盖掀开'], result: '箱盖开启', uncertainties: [] }] };
  assert.ok(normalizeStoryVisualActionPlan(complexPlan, complex), 'noncombat complex action phases use the same event contract');
  checks++;
} finally { Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }); }
console.log(`${checks} reported-combat, ownership, uncertainty and complex-action contract checks passed (mock fixtures; no live quality claim)`);
