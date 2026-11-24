import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  materializeSemanticSequencePlan, parseSemanticSpanRewrite, SemanticSequenceTechnicalError,
} from '../src/semanticSequencePlan';
import type { SemanticSequencePlanningInput, SemanticSequenceResponseSegment } from '../src/semanticSequencePlan';
import { requestSemanticSpanRewrite } from '../src/services/semanticSequencePlanner';
import { orderedSemanticSelection, replaceSemanticSegmentSpan } from '../src/sequencePlan';
import type { TextApiConfig, VideoSequencePlan } from '../src/types';

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [];
const test = (name: string, run: () => void | Promise<void>) => tests.push({ name, run });
const config = (): TextApiConfig => ({
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://span-rewrite.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-not-a-credential', model: 'synthetic-span', temperature: 0, maxTokens: 4096, vision: false,
});
const planningInput = (count: number): SemanticSequencePlanningInput => ({
  title: '局部改写测试', story: '甲推开门。乙说等我。丙走过长桥。', segmentDurationSec: 15,
  durationMode: 'fixed', requestedTotalDurationSec: count * 15,
  directorSettingsFingerprint: 'synthetic-director-settings', creativeDirection: {
    directorStyle: { id: 'synthetic-director', name: '自然观察', summary: '完整导演要求' },
    visualStyle: { name: '素雅', prompt: '完整视觉要求' },
    stylePreset: { id: 'synthetic-preset', name: '合成预设', visual: '完整视觉', camera: '完整摄影', lighting: '完整光影', sound: '同期声' },
    cameraTerms: [], lightingTerms: [], extraRequirement: '',
  },
});
const draft = (index: number, evidence = '甲推开门'): SemanticSequenceResponseSegment => ({
  title: `第${index}段标题`, content: `第${index}段正文`, summary: `摘要${index}`, narrativePurpose: `职责${index}`,
  entryState: `入口${index}`, exitState: `出口${index}`, transitionHint: `转场${index}`,
  boundaryReason: `边界${index}`, continuityPack: `连续${index}`,
  semanticSource: {
    sourceEvidence: [{ text: evidence }],
    events: [{ id: `event-${index}`, description: `事件${index}` }],
    dialogues: [],
  },
});
const planFor = (count: number): VideoSequencePlan => materializeSemanticSequencePlan(
  planningInput(count),
  { segmentCount: count, reason: '测试分段', fitStatus: 'balanced', segments: Array.from({ length: count }, (_, index) => draft(index + 1)) },
  { planId: 'span-plan', now: 1000 },
);

test('click selection keeps plan order and knows a gap', () => {
  const segments = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const range = orderedSemanticSelection(segments, ['c', 'b']);
  assert.deepEqual(range.ids, ['b', 'c']);
  assert.equal(range.startIndex, 1);
  assert.equal(range.contiguous, true);
  const gap = orderedSemanticSelection(segments, ['a', 'c']);
  assert.deepEqual(gap.ids, ['a', 'c']);
  assert.equal(gap.contiguous, false);
});

test('merge replaces three segments with one 15 second segment and shifts the tail', () => {
  const source = planFor(4);
  source.segments[0].storyboardId = 'board-1';
  source.segments[3].storyboardId = 'board-4';
  const keptAfter = source.segments[3].content;
  const merged = draft(9, '甲推开门');
  merged.entryState = '模型入口';
  merged.exitState = '模型出口';
  const next = replaceSemanticSegmentSpan(source, 0, 3, [merged], ['fresh-span']);
  assert.equal(source.segments.length, 4);
  assert.equal(source.segments[0].storyboardId, 'board-1');
  assert.equal(next.segments.length, 2);
  assert.equal(next.totalDurationSec, 30);
  assert.equal(next.requestedTotalDurationSec, 30);
  assert.equal(next.semanticPlanningSnapshot?.requestedTotalDurationSec, 30);
  assert.equal(next.segments[0].id, 'fresh-span');
  assert.equal(next.segments[0].durationSec, 15);
  assert.equal(next.segments[0].content, '第9段正文');
  assert.equal(next.segments[0].entryState, source.segments[0].entryState);
  assert.equal(next.segments[0].exitState, source.segments[2].exitState);
  assert.equal(next.segments[0].status, 'planned');
  assert.equal(next.segments[0].storyboardId, undefined);
  assert.equal(next.segments[1].id, source.segments[3].id);
  assert.equal(next.segments[1].content, keptAfter);
  assert.equal(next.segments[1].status, 'stale');
  assert.equal(next.segments[1].storyboardId, undefined);
  assert.equal(next.segments[1].globalStartSec, 15);
  assert.equal(next.segments[1].globalEndSec, 30);
});

test('small split keeps both pieces at the fixed duration and marks the following segment stale', () => {
  const source = planFor(3);
  source.segments[0].storyboardId = 'board-1';
  source.segments[1].storyboardId = 'board-2';
  const first = draft(1, '甲推开门');
  const second = draft(2, '甲推开门');
  first.exitState = '切在门口';
  second.entryState = '模型另写的入口';
  second.exitState = '模型另写的出口';
  const next = replaceSemanticSegmentSpan(source, 0, 1, [first, second], ['left', 'right']);
  assert.equal(next.segments.length, 4);
  assert.equal(next.totalDurationSec, 60);
  assert.equal(next.segments[0].id, 'left');
  assert.equal(next.segments[0].entryState, source.segments[0].entryState);
  assert.equal(next.segments[0].exitState, '切在门口');
  assert.equal(next.segments[0].storyboardId, undefined);
  assert.equal(next.segments[1].id, 'right');
  assert.equal(next.segments[1].entryState, '切在门口');
  assert.equal(next.segments[1].exitState, source.segments[0].exitState);
  assert.equal(next.segments[1].durationSec, 15);
  assert.equal(next.segments[2].id, source.segments[1].id);
  assert.equal(next.segments[2].content, source.segments[1].content);
  assert.equal(next.segments[2].status, 'stale');
  assert.equal(next.segments[2].storyboardId, undefined);
  assert.equal(next.segments[3].id, source.segments[2].id);
  assert.equal(next.segments[3].status, 'planned');
});

test('a locked segment is left unchanged', () => {
  const source = planFor(2);
  source.segments[0].locked = true;
  assert.throws(() => replaceSemanticSegmentSpan(source, 0, 2, [draft(8)], ['fresh']), /解锁/);
  assert.equal(source.segments.length, 2);
  assert.equal(source.segments[0].locked, true);
});

test('span parser keeps one exact segment and rejects an unknown excerpt', () => {
  const body = { reason: '收成一段', segments: [draft(1)] };
  const parsed = parseSemanticSpanRewrite(JSON.stringify(body), ['甲推开门'], 1);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].content, '第1段正文');
  const wrong = { reason: '收成一段', segments: [draft(1, '不在摘录里')] };
  assert.throws(() => parseSemanticSpanRewrite(JSON.stringify(wrong), ['甲推开门'], 1), SemanticSequenceTechnicalError);
  assert.throws(() => parseSemanticSpanRewrite(JSON.stringify({ reason: '两段', segments: [draft(1), draft(2)] }), ['甲推开门'], 1), /正好是 1 段/);
});

test('the span request asks for the selected count once and does not resegment the chapter', async () => {
  const requests: Array<{ body?: string }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    lianhuaDesktop: { request: async (payload: { body?: string }) => {
      requests.push(payload);
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reason: '合并', segments: [draft(7)] }) } }] }) };
    } },
  } });
  const result = await requestSemanticSpanRewrite(config(), {
    operation: 'merge', segmentDurationSec: 15, rangeEntry: '入口1', rangeExit: '出口3',
    segments: [draft(1), draft(2), draft(3)],
  });
  assert.equal(result.length, 1);
  assert.equal(requests.length, 1);
  const body = requests[0].body || '';
  assert.match(body, /semantic_span_input/u);
  assert.match(body, /正好是 1/u);
  assert.equal(body.includes('RAW_STORY_SEMANTIC_SEQUENCE_PLANNING_V1'), false);
  assert.equal(body.includes('甲推开门。乙说等我。丙走过长桥。'), false);
});

test('the planner shows merge and small-split on the segment cards', () => {
  const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(app, /小分段/u);
  assert.match(app, /toggleSpanSegment/u);
  assert.match(app, /sequence-segment-chip \$\{segment\.id === activeSegmentId \? "active" : ""\} \$\{selectedSegmentIds\?\.includes\(segment\.id\) \? "selected" : ""\}/u);
  assert.match(css, /\.sequence-segment-chip\.selected/u);
});

let failed = 0;
for (const item of tests) {
  try {
    await item.run();
    console.log(`ok ${item.name}`);
  } catch (error) {
    failed += 1;
    console.error(`fail ${item.name}`);
    console.error(error);
  }
}
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
