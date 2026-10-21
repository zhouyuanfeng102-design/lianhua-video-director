import assert from 'node:assert/strict';
import { requestStoryAnalysis, requestStoryPreparationWithReview, requestStoryVisualParagraphRewrite } from '../src/services/llm';
import { normalizeStoryVisualConversionSnapshot } from '../src/semanticSequencePlan';
import { storyVisualOriginalSource } from '../src/storyVisualConversion';
import { splitChapterAnalysisSource } from '../src/chapterEntities';
import { STORY_VISUAL_ENGINE_VERSION, assembleStoryVisualSceneParagraphs, storyVisualSourceParagraphs, storyVisualSourceQuotes,
  type StoryVisualActionPlan, type StoryVisualEvent, type StoryVisualScene } from '../src/storyVisualAction';
import type { StoryVisualConversionSnapshot, TextApiConfig } from '../src/types';
import { readStoryVisualData, type CapturedStoryRequest } from './storyVisualTestFixtures';

// Offline integration fixture. These deterministic responses test the actual
// request and adoption pipeline, not the quality of a real model's reading.
const source = '数天后，夏娃修复完成，从战舰走出，张开双臂紧紧抱住吴小观。夏娃说：“终于又见到你了！”\n\n'
  + '随后的日子里，吴小观的伤势也已大致痊愈。这一天，他独自盘坐在森林空地，清点“炼狱之门”。女仆在树林外说：“我在外面等你。”';
const sourceParagraphs = storyVisualSourceParagraphs(source);
const sourceQuotes = storyVisualSourceQuotes(sourceParagraphs);
const makeEvent = (id: string, values: Partial<StoryVisualEvent>): StoryVisualEvent => ({
  id, sourceParagraphIds: ['p1'], evidence: '', actor: '', target: '', action: '', result: '', uncertainties: [], ...values,
});
const scenes: StoryVisualScene[] = [
  { id: 'return', title: '修复后重逢', time: '数天后', timeRelation: '承接前事数日之后', location: '战舰外', setting: '停泊战舰外的空地',
    participants: [{ id: 'eve', name: '夏娃', existingEntityId: 'character-eve', presence: 'present' },
      { id: 'wu', name: '吴小观', existingEntityId: 'character-wu', presence: 'present' }],
    eventIds: ['hug', 'eve-line'], sourceParagraphIds: ['p1'] },
  { id: 'reward', title: '痊愈后清点', time: '这一天', timeRelation: '随后的日子里', location: '森林空地', setting: '森林空地中央与树林外',
    participants: [{ id: 'wu', name: '吴小观', existingEntityId: 'character-wu', presence: 'present' },
      { id: 'maid', name: '女仆', aliases: ['侍女'], existingEntityId: 'character-maid', presence: 'offscreen', eventIds: ['maid-line'] }],
    eventIds: ['recovery', 'count', 'maid-line'], sourceParagraphIds: ['p2'] },
];
const facts: StoryVisualActionPlan = {
  version: 1, sourceParagraphs, sourceQuotes, scenes, summary: '修复重逢；随后一些日子恢复，再清点奖励，女仆在画外等待。',
  events: [
    makeEvent('hug', { sceneId: 'return', kind: 'action', actor: '夏娃', target: '吴小观', action: '夏娃张开双臂紧紧抱住吴小观。',
      phases: ['张开双臂', '合拢双臂并抱住', '保持拥抱'], result: '两人仍相拥', sourceStart: 0, sourceEnd: 34 }),
    makeEvent('eve-line', { sceneId: 'return', kind: 'dialogue', actor: '夏娃', speaker: '夏娃', action: '夏娃激动地发话。',
      dialogue: '模型概述的对白不应替换原文', sourceQuoteIds: ['p1-q1'], participantIds: ['eve', 'wu'] }),
    makeEvent('recovery', { sceneId: 'reward', kind: 'narration', sourceParagraphIds: ['p2'],
      action: '随后的日子里，吴小观的伤势也已大致痊愈。' }),
    makeEvent('count', { sceneId: 'reward', kind: 'action', sourceParagraphIds: ['p2'], actor: '吴小观',
      action: '吴小观独自盘坐在森林空地，清点“炼狱之门”。', sourceQuoteIds: ['p2-q1'] }),
    makeEvent('maid-line', { sceneId: 'reward', kind: 'dialogue', sourceParagraphIds: ['p2'], actor: '女仆', speaker: '女仆',
      dialogue: '这里也不能覆盖原话', sourceQuoteIds: ['p2-q2'], participantIds: ['maid'] }),
  ],
};
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible',
  baseUrl: 'https://story-scenes.mock.invalid/v1/chat/completions', apiKey: 'synthetic-only',
  model: 'offline-scene-fixture', temperature: 0, maxTokens: 8192, vision: false };
const savedWindow = globalThis.window;
const savedFetch = globalThis.fetch;
let requests: CapturedStoryRequest[] = [];
const install = (reply: (request: CapturedStoryRequest, index: number) => unknown): void => {
  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async (payload: { body?: string }) => {
      const request = JSON.parse(payload.body || '{}') as CapturedStoryRequest;
      requests.push(request);
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop',
        message: { content: JSON.stringify(reply(request, requests.length - 1)) } }] }) };
    },
  } } });
};
const readEnvelope = (request: CapturedStoryRequest, tag: string): Record<string, any> => {
  const user = request.messages.find((message) => message.role === 'user')?.content || '';
  const start = user.indexOf(`<${tag}>`) + tag.length + 2;
  return JSON.parse(user.slice(start, user.indexOf(`</${tag}>`)));
};
const fiveFields = (body: string): void => {
  const offsets = ['时间：', '地点：', '人物：', '场景：', '剧情：'].map((field) => body.indexOf(`\n${field}`));
  assert.ok(offsets.every((offset) => offset >= 0));
  assert.deepEqual([...offsets].sort((left, right) => left - right), offsets);
};
const nameOf = (entry: string | { name?: string }): string | undefined => typeof entry === 'string' ? entry : entry.name;

try {
  globalThis.fetch = async () => { throw new Error('Scene pipeline tests must not contact a model provider'); };
  install((request, index) => {
    const data = readStoryVisualData(request) as Record<string, any>;
    assert.equal(data.sourceTextOrRequirement, source);
    assert.equal(data.engineVersion, STORY_VISUAL_ENGINE_VERSION);
    if (index === 0) {
      assert.equal(data.stage, 'understanding');
      assert.deepEqual(data.sourceQuotes, sourceQuotes);
      return facts;
    }
    assert.equal(index, 1, 'a small source uses only the two existing generation stages');
    assert.equal(data.stage, 'visualizing');
    assert.deepEqual(data.actionPlan.scenes.map((scene: StoryVisualScene) => scene.id), ['return', 'reward']);
    return { paragraphs: [
      { id: 'detail-return', sceneId: 'return', sourceParagraphIds: ['p1'], eventIds: ['hug', 'eve-line'], eventDetails: [
        { eventId: 'hug', text: '夏娃双臂合拢，紧贴吴小观保持拥抱，双臂没有提前松开。', stagingAdditions: [] },
        { eventId: 'eve-line', text: '夏娃说：“以后不要回来了。”', stagingAdditions: [] },
      ], stagingAdditions: [] },
      { id: 'detail-reward', sceneId: 'reward', sourceParagraphIds: ['p2'], eventIds: ['recovery', 'count', 'maid-line'], eventDetails: [
        { eventId: 'count', text: '吴小观保持盘坐，低头逐项清点奖励。', stagingAdditions: [] },
      ], stagingAdditions: [] },
    ] };
  });
  const converted = await requestStoryPreparationWithReview(config, source, undefined, undefined, 'optimize', undefined, { detailMode: 'faithful' });
  assert.equal(requests.length, 2);
  assert.equal(converted.paragraphs?.length, 2);
  converted.paragraphs!.forEach((paragraph) => fiveFields(paragraph.text));
  assert.match(converted.paragraphs![0].text, /时间：数天后/u);
  assert.match(converted.paragraphs![1].text, /时间：这一天；随后的日子里/u);
  assert.match(converted.text, /夏娃张开双臂紧紧抱住吴小观/u);
  assert.match(converted.text, /双臂没有提前松开/u);
  assert.match(converted.text, /夏娃：“终于又见到你了！”/u);
  assert.match(converted.text, /女仆：“我在外面等你。”/u);
  assert.match(converted.text, /女仆（画外）/u);
  assert.match(converted.text, /吴小观的伤势也已大致痊愈/u, 'narration remains even when stage two only elaborates actions');
  assert.doesNotMatch(converted.text, /以后不要回来了|模型概述的对白|这里也不能覆盖/u);
  assert.doesNotMatch(converted.text, /：“炼狱之门”/u, 'a quoted object remains an object');

  const snapshot: StoryVisualConversionSnapshot = { id: 'scene-conversion', chapterId: 'chapter', sourceName: '森林',
    sourceText: source, resultText: converted.text, createdAt: 1, actionPlan: converted.actionPlan,
    paragraphs: converted.paragraphs, engineVersion: converted.engineVersion, detailMode: converted.detailMode };
  const restored = normalizeStoryVisualConversionSnapshot(JSON.parse(JSON.stringify(snapshot)))!;
  assert.deepEqual(restored.actionPlan?.scenes, converted.actionPlan?.scenes);
  assert.deepEqual(restored.actionPlan?.sourceQuotes, sourceQuotes);
  assert.deepEqual(restored.actionPlan?.events[0].phases, facts.events[0].phases);
  assert.equal(restored.actionPlan?.events[0].sourceStart, 0);
  assert.equal(restored.actionPlan?.events[0].sourceEnd, 34);
  assert.deepEqual(restored.paragraphs, converted.paragraphs);
  assert.equal(restored.resultText, converted.text);

  install((request, index) => {
    assert.equal(index, 0, 'scene handoff does not request a cast repair');
    const data = readEnvelope(request, 'story_analysis_data');
    assert.equal(data.sourceStory, converted.text);
    assert.deepEqual(data.visualConversion.actionPlan.scenes, converted.actionPlan?.scenes);
    // Deliberately return a shortened scene and omit the maid from every
    // analysis entity list. The adopted structured source still owns its cast.
    return { characters: [{ name: '吴小观', existingEntityId: 'character-wu', gender: '男', appearance: '黑发', aliases: [] }],
      locations: [{ name: '森林空地', description: '林中空地' }], props: [],
      scenes: [{ title: '被压缩的剧情', content: '吴小观清点奖励。', summary: '清点', characters: ['吴小观'], location: '森林空地', props: [] }] };
  });
  const analysis = await requestStoryAnalysis(config, converted.text, undefined, { visualConversion: restored, chapterId: 'chapter' });
  assert.equal(requests.length, 1);
  assert.equal(analysis.scenes.length, 2);
  assert.deepEqual(analysis.scenes.map((scene) => scene.content), converted.paragraphs!.map((paragraph) => paragraph.text));
  analysis.scenes.forEach((scene) => fiveFields(scene.content!));
  assert.ok(analysis.scenes[1].characters?.some((person) => nameOf(person) === '女仆'));
  const maid = analysis.characters?.find((person) => nameOf(person) === '女仆');
  assert.ok(maid && typeof maid !== 'string');
  assert.equal(maid.existingEntityId, 'character-maid');
  assert.match(analysis.scenes[1].content!, /女仆：“我在外面等你。”/u);

  const secondAdoption: StoryVisualConversionSnapshot = { ...restored, id: 'second-adoption', createdAt: 2,
    sourceText: converted.text, resultText: '再次采用的完整场景稿' };
  const lineage = { storyVisualConversions: [restored, secondAdoption] };
  assert.equal(storyVisualOriginalSource(lineage, 'chapter', converted.text), source);
  assert.equal(storyVisualOriginalSource(lineage, 'chapter', secondAdoption.resultText), source, 'repeat adopted conversion follows the stored source lineage');
  const edited = `${converted.text}\n用户补写：夏娃没有离开。`;
  assert.equal(storyVisualOriginalSource(lineage, 'chapter', edited), edited, 'manual edits remain the current source');
  assert.equal(storyVisualOriginalSource(lineage, 'another-chapter', converted.text), converted.text);

  const untouchedScene = structuredClone(converted.paragraphs![1]);
  install((request, index) => {
    assert.equal(index, 0, 'a user-requested scene rewrite remains one request');
    const data = readStoryVisualData(request) as Record<string, any>;
    assert.equal(data.stage, 'rewriting');
    assert.equal(data.paragraphId, converted.paragraphs![0].id);
    assert.equal(data.previousParagraph.sceneId, 'return');
    assert.deepEqual(data.focusEvents.map((event: StoryVisualEvent) => event.id), ['hug', 'eve-line']);
    return { paragraph: { id: data.paragraphId, sceneId: 'return', sourceParagraphIds: ['p1'], eventIds: ['hug', 'eve-line'],
      eventDetails: [{ eventId: 'hug', text: '夏娃双臂持续环抱吴小观，怀抱始终没有松开。', stagingAdditions: [] },
        { eventId: 'eve-line', text: '夏娃说：“改成另外一句！”', stagingAdditions: [] }], stagingAdditions: [] } };
  });
  const rewritten = await requestStoryVisualParagraphRewrite(config, source, converted, converted.paragraphs![0].id);
  assert.equal(requests.length, 1);
  assert.match(rewritten.paragraphs![0].text, /怀抱始终没有松开/u);
  assert.match(rewritten.paragraphs![0].text, /夏娃：“终于又见到你了！”/u);
  assert.doesNotMatch(rewritten.text, /改成另外一句/u);
  assert.deepEqual(rewritten.paragraphs![1], untouchedScene, 'rewriting one scene leaves the other scene unchanged');
  assert.deepEqual(rewritten.actionPlan, converted.actionPlan, 'a process rewrite keeps the original scene and event plan');

  // A single long source paragraph crosses both normal stage budgets. Its
  // event offsets route each action once; scene and quote IDs remain stable.
  let longSource = '';
  const longEvents: StoryVisualEvent[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const actionStart = longSource.length;
    longSource += `第${index}段，林舟留在营地等待。${'他保持原位，留意营地动静。'.repeat(46)}`;
    const dialogueStart = longSource.length;
    longSource += `女仆说：“第${index}次呼叫。”`;
    longEvents.push(makeEvent(`wait-${index}`, { sceneId: 'long-camp', kind: 'action', actor: '林舟',
      action: `林舟在第${index}段继续等待。`, sourceStart: actionStart, sourceEnd: dialogueStart }),
    makeEvent(`call-${index}`, { sceneId: 'long-camp', kind: 'dialogue', actor: '女仆', speaker: '女仆',
      dialogue: '不要采用这句概要', sourceQuoteIds: [`p1-q${index}`], sourceStart: dialogueStart, sourceEnd: longSource.length }));
  }
  const routedEvents = new Map<string, number>();
  let understandingCalls = 0;
  let visualizingCalls = 0;
  let understandingBatchCount = 0;
  let visualizingBatchCount = 0;
  install((request) => {
    const data = readStoryVisualData(request) as Record<string, any>;
    if (data.stage === 'understanding') {
      understandingCalls += 1;
      understandingBatchCount = data.batchCount;
      const covered = longEvents.filter((event) => data.sourceParagraphs.some((paragraph: { id: string; sourceStart?: number; sourceEnd?: number }) =>
        paragraph.id === 'p1' && event.sourceStart! >= (paragraph.sourceStart || 0) && event.sourceStart! < (paragraph.sourceEnd ?? longSource.length)));
      return { version: 1, summary: '同一营地持续等待，女仆四次原话依次发生。', events: covered,
        scenes: [{ id: 'long-camp', title: '营地等待', time: '同一天', timeRelation: '连续发生', location: '营地', setting: '原有营地',
          participants: [{ id: 'lin', name: '林舟', presence: 'present' }, { id: 'maid', name: '女仆', presence: 'offscreen' }],
          eventIds: covered.map((event) => event.id), sourceParagraphIds: ['p1'] }] };
    }
    assert.equal(data.stage, 'visualizing', 'batch handling does not introduce a third generation stage');
    visualizingCalls += 1;
    visualizingBatchCount = data.batchCount;
    for (const event of data.focusEvents as StoryVisualEvent[]) routedEvents.set(event.id, (routedEvents.get(event.id) || 0) + 1);
    return { paragraphs: [{ id: `details-${data.batchIndex}`, sceneId: 'long-camp', sourceParagraphIds: ['p1'],
      eventIds: data.focusEvents.map((event: StoryVisualEvent) => event.id), stagingAdditions: [],
      eventDetails: data.focusEvents.filter((event: StoryVisualEvent) => event.kind === 'action')
        .map((event: StoryVisualEvent) => ({ eventId: event.id, text: `保持该次等待的连续过程（${event.id}）。`, stagingAdditions: [] })) }] };
  });
  const longConverted = await requestStoryPreparationWithReview({ ...config, maxTokens: 2048 }, longSource,
    undefined, undefined, 'optimize', undefined, { detailMode: 'faithful' });
  assert.ok(understandingCalls > 1 && visualizingCalls > 1);
  assert.equal(understandingCalls, understandingBatchCount);
  assert.equal(visualizingCalls, visualizingBatchCount);
  assert.equal(requests.length, understandingCalls + visualizingCalls, 'only declared normal batches were requested');
  assert.equal(longConverted.actionPlan?.events.length, longEvents.length);
  assert.equal(longConverted.actionPlan?.scenes?.length, 1, 'continued batch records merge into one scene');
  assert.equal(longConverted.paragraphs?.length, 1);
  assert.equal(routedEvents.size, longEvents.length);
  assert.ok([...routedEvents.values()].every((count) => count === 1), 'each source event is allocated to one detail batch');
  assert.deepEqual(longConverted.actionPlan?.sourceQuotes, storyVisualSourceQuotes(longSource));
  for (let index = 1; index <= 4; index += 1) {
    assert.equal(longConverted.text.split(`女仆：“第${index}次呼叫。”`).length - 1, 1);
  }
  fiveFields(longConverted.text);

  // Original-novel ranges and rendered-scene ranges use different coordinate
  // spaces. The first long novel chunk would overlap both short rendered
  // scenes if its offsets were reused, incorrectly attaching its prop to both.
  const analysisSourceScenes = [
    { id: 'key-scene', title: '递交钥匙', location: '战舰外', prop: '金属钥匙',
      fact: '夏娃在战舰外把金属钥匙交给吴小观。', filler: '树林中没有新的行动。'.repeat(1200) },
    { id: 'compass-scene', title: '收起罗盘', location: '林间小径', prop: '铜制罗盘',
      fact: '吴小观在林间小径收起铜制罗盘。', filler: '小径上没有新的行动。'.repeat(1200) },
  ];
  const analysisOriginal = analysisSourceScenes.map((item) => item.fact + item.filler).join('\n\n');
  const analysisChunks = splitChapterAnalysisSource(analysisOriginal);
  assert.ok(analysisOriginal.length > 16000 && analysisChunks.length >= 2);
  const analysisPlan: StoryVisualActionPlan = { version: 1,
    sourceParagraphs: storyVisualSourceParagraphs(analysisOriginal), summary: '先交钥匙，后收起罗盘。',
    events: analysisSourceScenes.map((item, index) => makeEvent(`prop-event-${index}`, {
      sceneId: item.id, kind: 'action', sourceParagraphIds: [`p${index + 1}`], action: item.fact,
      actor: index === 0 ? '夏娃' : '吴小观', target: index === 0 ? '吴小观' : '铜制罗盘', evidence: item.fact,
    })),
    scenes: analysisSourceScenes.map((item, index) => ({ id: item.id, title: item.title,
      time: index === 0 ? '数天后' : '同日稍后', timeRelation: index === 0 ? '承接前事' : '交出钥匙之后',
      location: item.location, setting: item.location, sourceParagraphIds: [`p${index + 1}`], eventIds: [`prop-event-${index}`],
      participants: [{ id: 'wu', name: '吴小观', presence: 'present' },
        ...(index === 0 ? [{ id: 'eve', name: '夏娃', presence: 'present' as const }] : [])],
    })),
  };
  const analysisParagraphs = assembleStoryVisualSceneParagraphs(analysisPlan, []);
  const analysisRendered = analysisParagraphs.map((paragraph) => paragraph.text).join('\n\n');
  const analysisSnapshot: StoryVisualConversionSnapshot = { id: 'long-analysis-source', chapterId: 'long-analysis-chapter',
    sourceName: '两个道具场次', sourceText: analysisOriginal, resultText: analysisRendered, createdAt: 3,
    actionPlan: analysisPlan, paragraphs: analysisParagraphs, engineVersion: STORY_VISUAL_ENGINE_VERSION, detailMode: 'faithful' };
  assert.ok(analysisChunks[0].sourceEnd > analysisRendered.length, 'fixture separates original and rendered coordinates');
  install((request, index) => {
    assert.ok(index < analysisChunks.length, 'analysis must not add a content repair request');
    const data = readEnvelope(request, 'story_analysis_data');
    const chunk = analysisChunks[index];
    assert.equal(data.sourceStory, chunk.content);
    assert.deepEqual(data.sourceRange, { start: chunk.sourceStart, end: chunk.sourceEnd });
    const current = analysisSourceScenes.find((item) => chunk.content.includes(item.fact));
    assert.ok(current, 'each existing source chunk contains its distinct original scene');
    return { characters: [{ name: '吴小观' }, { name: '夏娃' }], locations: [{ name: current.location }],
      props: [{ name: current.prop, category: '道具', material: '金属' }], scenes: [{
        title: current.title, content: current.fact + current.filler, summary: '只供资料提取的简短摘要',
        characters: ['吴小观'], location: current.location, props: [current.prop],
      }] };
  });
  const longAnalysis = await requestStoryAnalysis(config, analysisRendered, undefined, {
    visualConversion: analysisSnapshot, chapterId: analysisSnapshot.chapterId,
  });
  assert.equal(requests.length, analysisChunks.length, 'long analysis uses only the existing original-source splitter batches');
  assert.equal(longAnalysis.scenes.length, analysisSourceScenes.length);
  let renderedCursor = 0;
  longAnalysis.scenes.forEach((scene, index) => {
    const paragraph = analysisParagraphs[index];
    const expectedStart = analysisRendered.indexOf(paragraph.text, renderedCursor);
    const expectedEnd = expectedStart + paragraph.text.length;
    assert.equal(scene.content, paragraph.text, 'each adopted scene keeps its full rendered script');
    assert.deepEqual((scene.props || []).map(nameOf), [analysisSourceScenes[index].prop], 'original ranges must not attach another scene’s prop');
    assert.equal(scene.sourceStart, expectedStart);
    assert.equal(scene.sourceEnd, expectedEnd);
    assert.equal(analysisRendered.slice(scene.sourceStart, scene.sourceEnd), paragraph.text);
    fiveFields(scene.content!);
    renderedCursor = expectedEnd;
  });
  console.log('PASS scene pipeline: two normal stages, original dialogue, action detail, preserved scene/cast analysis, storage, source lineage, one-scene rewrite and budget batches');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: savedWindow });
  globalThis.fetch = savedFetch;
}
