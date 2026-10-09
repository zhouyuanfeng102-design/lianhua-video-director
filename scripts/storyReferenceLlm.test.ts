import assert from 'node:assert/strict';
import {
  requestStoryReferenceVisionAnalysis, requestStoryPreparationWithReview,
  requestStoryAnalysis, requestStoryBibleEnrichment,
} from '../src/services/llm';
import type { StoryReferenceAnalysis, StoryReferenceContext, VisionApiConfig } from '../src/types';

const config: VisionApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://reference.example.test/v1',
  apiKey: 'synthetic-reference-key', model: 'synthetic-vision', temperature: 0.2, maxTokens: 4096, vision: true,
};
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6izsAAAAASUVORK5CYII=';
const subject = (id: string, label: string) => ({ id, label, description: `${label}的完整可见特征`, fields: { appearance: '银发与蓝衣', position: '画面左侧' } });
const visual = {
  description: '两个人站在拱廊中，身后有石柱，前景放着铜制茶壶。',
  characters: [subject('character-1', '左侧人物'), subject('character-2', '右侧人物')],
  locations: [subject('location-1', '拱廊')], props: [subject('prop-1', '茶壶')],
  events: ['左侧人物抬手'], relationships: ['两人隔桌相对'], readableText: ['招牌：欢迎'], uncertainties: ['身高无法可靠判断'],
  style: '写实', composition: '中景双人', lighting: '右侧日光', colors: '青铜与蓝色',
  extraDetail: { edgeObjects: [{ material: '石', texture: ['裂缝', '青苔'] }] },
};
type Request = { system?: string; messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> };
const originalWindow = globalThis.window;
let requests: Request[] = [];
let responder: (request: Request, count: number) => string = () => JSON.stringify(visual);
let responseOverride: { status: number; body: string } | undefined;
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  lianhuaDesktop: { request: async (input: { body?: string }) => {
    const request = JSON.parse(input.body || '{}') as Request;
    requests.push(request);
    if (responseOverride) return responseOverride;
    const response = responder(request, requests.length);
    return { status: 200, body: JSON.stringify(request.system
      ? { content: [{ type: 'text', text: response }], stop_reason: 'end_turn' }
      : { choices: [{ message: { content: response }, finish_reason: 'stop' }] }) };
  } },
} });
const userText = (request: Request): string => {
  const content = request.messages.find((message) => message.role === 'user')!.content;
  return typeof content === 'string' ? content : String(content.find((part) => part.type === 'text')?.text || '');
};
const data = (request: Request, tag: string): Record<string, any> => {
  const source = userText(request).match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'))?.[1];
  assert.ok(source, `${tag} must be present`);
  return JSON.parse(source);
};
let checks = 0;
try {
  const analysis = await requestStoryReferenceVisionAnalysis(config, image);
  assert.equal(requests.length, 1);
  assert.equal((requests[0].messages[1].content as unknown[]).length, 2, 'one text part and exactly one real image');
  assert.equal(analysis.characters.length, 2);
  assert.deepEqual(analysis.structuredData, visual, 'preserve all nested, previously unknown information');
  assert.equal(analysis.rawResponse, JSON.stringify(visual));
  assert.equal(analysis.model, config.model);
  checks++;

  requests = [];
  await requestStoryReferenceVisionAnalysis({ ...config, provider: 'claude' }, image);
  const claudeParts = requests[0].messages[0].content as Array<Record<string, any>>;
  assert.equal(claudeParts.filter((part) => part.type === 'image').length, 1);
  assert.equal(claudeParts.find((part) => part.type === 'image')?.source.media_type, 'image/png');
  checks++;

  const variableShapes = [
    { ...visual, characters: { name: '左侧人物', appearance: { hair: '银发', details: ['发梢偏蓝', '遮住左眼'] }, outfit: '蓝衣' },
      locations: { 拱廊: { description: '石柱拱廊', fields: { material: ['青石', '苔藓'] } } }, props: '铜制茶壶，盖子闭合' },
    { ...visual, characters: { 左侧人物: '银发蓝衣，正在抬手', 右侧人物: { description: '金发黑衣，站在桌后' } },
      events: { 左侧人物: { action: '抬手', hand: '右手' } }, relationships: [{ source: '左侧人物', relation: '隔桌相对', target: '右侧人物' }],
      readableText: '招牌：欢迎', uncertainties: { 身高: '没有可靠尺度' }, style: { medium: '写实', texture: ['石纹', '布纹'] }, colors: ['青铜', '蓝色'] },
    { ...visual, characters: ['银发蓝衣的左侧人物', '金发黑衣的右侧人物'], props: '无道具', locations: JSON.stringify(visual.locations) },
  ];
  for (const shape of variableShapes) {
    requests = []; responder = () => JSON.stringify(shape);
    const normalized = await requestStoryReferenceVisionAnalysis(config, image);
    assert.equal(requests.length, 1, 'usable object/map/text formats normalize locally without another paid request');
    assert.deepEqual(normalized.structuredData, shape, 'all original nested details remain intact');
    assert.equal(normalized.rawResponse, JSON.stringify(shape));
    assert.ok(normalized.characters.every((entry) => entry.id && entry.label && entry.description));
    if (shape === variableShapes[0]) {
      assert.match(normalized.characters[0].description, /遮住左眼/u);
      assert.deepEqual(JSON.parse(normalized.characters[0].fields.appearance), { hair: '银发', details: ['发梢偏蓝', '遮住左眼'] });
      assert.equal(normalized.locations[0].label, '拱廊');
      assert.equal(normalized.props[0].description, '铜制茶壶，盖子闭合');
    } else {
      assert.equal(normalized.characters.length, 2, 'retain each explicitly provided subject separately');
      if (shape === variableShapes[1]) {
        assert.equal(normalized.characters[1].label, '右侧人物');
        assert.match(normalized.events[0], /右手/u);
        assert.match(normalized.relationships[0], /隔桌相对/u);
        assert.match(normalized.style, /布纹/u);
      } else assert.deepEqual(normalized.props, [], 'explicit absence does not invent a prop');
    }
    checks++;
  }
  const chinese = { result: {
    画面描述: visual.description, 人物: { 名称: '左侧人物', 描述: '银发蓝衣', 特征: { 姿势: '抬手' } },
    地点: '石砌拱廊', 道具: [], 动作: ['抬手'], 关系: [], 可读文字: [], 不确定项: [],
    风格: '写实', 构图: '中景', 光线: '日光', 色彩: '蓝', 额外资料: { 背景: '青苔' },
  } };
  requests = []; responder = () => JSON.stringify(chinese);
  const chineseAnalysis = await requestStoryReferenceVisionAnalysis(config, image);
  assert.equal(requests.length, 1);
  assert.equal(chineseAnalysis.description, visual.description, 'whole image description comes from the explicit envelope, never an inner person');
  assert.equal(chineseAnalysis.characters[0].label, '左侧人物');
  assert.deepEqual(chineseAnalysis.structuredData, chinese);
  checks++;

  for (const incomplete of [
    '这张图里两个人站在拱廊中，左侧人物银发蓝衣，右侧人物金发黑衣。',
    JSON.stringify({ description: visual.description }),
    JSON.stringify({ ...visual, characters: '左侧银发蓝衣的人抬手，另一侧金发黑衣的人站在桌后。' }),
    JSON.stringify({ ...visual, characters: null }),
    JSON.stringify({ ...visual, characters: [{ name: '左侧人物' }] }),
    JSON.stringify({ ...visual, 人物: [{ name: '背景行人', description: '站在石柱后' }] }),
  ]) {
    requests = []; responder = (_request, count) => count === 1 ? incomplete : JSON.stringify(visual);
    const corrected = await requestStoryReferenceVisionAnalysis(config, image);
    assert.equal(requests.length, 2, 'only incomplete evidence gets one bounded format correction');
    assert.equal(corrected.characters.length, 2);
    assert.equal(corrected.rawResponse, incomplete, 'retain the complete first response');
    const repair = corrected.structuredData?.formatRepair as Record<string, unknown>;
    assert.equal(repair.originalResponse, incomplete);
    assert.equal(repair.correctedResponse, JSON.stringify(visual));
    assert.deepEqual(corrected.structuredData?.correctedAnalysis, visual);
    assert.ok(userText(requests[1]).includes(JSON.stringify(incomplete)), 'send every original fact for AI correction without truncation');
    assert.equal((requests[1].messages[1].content as Array<Record<string, any>>).filter((part) => part.type === 'image_url').length, 1);
    assert.equal((requests[1].messages[1].content as Array<Record<string, any>>).find((part) => part.type === 'image_url')?.image_url.url, image);
    checks++;
  }
  for (const malformed of [{ ...visual, description: '' }, { ...visual, characters: [subject('same', '甲'), subject('same', '乙')] }]) {
    requests = []; responder = () => JSON.stringify(malformed);
    await assert.rejects(requestStoryReferenceVisionAnalysis(config, image), /格式补正后仍不完整/u);
    assert.equal(requests.length, 2, 'failed correction is bounded; no third request or invented empty collections');
    checks++;
  }
  for (const transport of [
    { status: 401, body: JSON.stringify({ error: { message: 'synthetic authentication failure' } }) },
    { status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"description":"truncated' }, finish_reason: 'length' }] }) },
    { status: 200, body: JSON.stringify({ choices: [{ message: { content: '', refusal: 'synthetic refusal' }, finish_reason: 'stop' }] }) },
    { status: 200, body: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }) },
  ]) {
    requests = []; responseOverride = transport;
    await assert.rejects(requestStoryReferenceVisionAnalysis(config, image));
    assert.equal(requests.length, 1, 'HTTP/refusal/filter/truncation failures never trigger format repair');
    checks++;
  }
  responseOverride = undefined;
  const canceledAfterResponse = new AbortController();
  requests = []; responder = () => { canceledAfterResponse.abort(); return 'invalid format'; };
  await assert.rejects(requestStoryReferenceVisionAnalysis(config, image, canceledAfterResponse.signal), { name: 'AbortError' });
  assert.equal(requests.length, 1, 'cancellation cannot trigger a repair');
  checks++;

  const transportFailure = new Error('synthetic network failure');
  requests = []; responder = () => { throw transportFailure; };
  await assert.rejects(requestStoryReferenceVisionAnalysis(config, image), transportFailure);
  assert.equal(requests.length, 1);
  checks++;

  for (const emptyCollections of [[], {}]) {
    requests = []; responder = () => JSON.stringify({ ...visual, characters: emptyCollections, locations: emptyCollections, props: emptyCollections });
    const empty = await requestStoryReferenceVisionAnalysis(config, image);
    assert.equal(requests.length, 1);
    assert.deepEqual([empty.characters, empty.locations, empty.props], [[], [], []], 'only explicitly empty collections remain empty; no local scene inference');
    checks++;
  }
  const controller = new AbortController(); controller.abort();
  requests = [];
  await assert.rejects(requestStoryReferenceVisionAnalysis(config, image, controller.signal), { name: 'AbortError' });
  assert.equal(requests.length, 0);
  checks++;

  const savedAnalysis: StoryReferenceAnalysis = { ...analysis, description: `${'完整细节'.repeat(9000)}末尾识图事实` };
  const context: StoryReferenceContext = {
    mode: 'image', chapterId: 'chapter-1', fingerprint: 'snapshot-1', text: 'UI mirror only',
    narrator: { name: '叙述者', description: '用户自定义外貌' },
    references: [1, 2].map((number) => ({ referenceId: `reference-${number}`, number, assetId: `asset-${number}`,
      analysis: savedAnalysis, fullDescription: `图${number}人工修订全文`, notes: `图${number}的补充要求`,
      subjectBindings: [{ subjectId: 'character-1', kind: 'character', name: `角色${number}` }],
    })),
  };
  const assertFullContext = (actual: Record<string, unknown>) => {
    const { text: _mirror, ...expected } = context;
    assert.deepEqual(actual, expected, 'all image evidence, manual corrections and narrator must reach every stage');
  };
  for (const mode of ['expand', 'optimize'] as const) {
    requests = []; responder = () => '图1左侧人物向图2左侧人物问好。';
    await requestStoryPreparationWithReview({ ...config, vision: false }, '让图1和图2人物互动。', undefined, undefined, mode, 600, { referenceContext: context });
    assertFullContext(data(requests[0], 'story_expansion_data').referenceContext);
    assert.equal(typeof requests[0].messages.at(-1)?.content, 'string', 'saved visual context works with a text-only model');
    assert.match(JSON.stringify(requests[0]), /不强制出场/u);
    checks++;
  }

  const link = (number: number, subjectId = 'character-1') => ({ referenceId: `reference-${number}`, subjectId });
  const storyResult = (bindings = [link(1), link(2)], assetIds = ['asset-1', 'asset-2']) => ({
    characters: [{ name: '共同人物', appearance: '银发蓝衣', storyReferenceBindings: bindings }],
    locations: [{ name: '拱廊', description: '石柱拱廊', storyReferenceBindings: [link(1, 'location-1')] }],
    props: [{ name: '茶壶', material: '铜', storyReferenceBindings: [link(2, 'prop-1')] }],
    scenes: [{ title: '见面', content: '共同人物抬手。', characters: ['共同人物'], location: '拱廊', props: ['茶壶'], referenceAssetIds: assetIds }],
  });
  requests = []; responder = () => JSON.stringify(storyResult());
  const parsed = await requestStoryAnalysis(config, '共同人物抬手。', undefined, { referenceContext: context });
  assertFullContext(data(requests[0], 'story_analysis_data').referenceContext);
  assert.deepEqual((parsed.characters![0] as any).storyReferenceBindings, [link(1), link(2)]);
  assert.deepEqual((parsed.locations![0] as any).storyReferenceBindings, [link(1, 'location-1')]);
  assert.deepEqual((parsed.props![0] as any).storyReferenceBindings, [link(2, 'prop-1')]);
  assert.deepEqual(parsed.scenes[0].referenceAssetIds, ['asset-1', 'asset-2']);
  checks++;

  requests = []; responder = (_request, count) => JSON.stringify(storyResult([link(count)]));
  const long = await requestStoryAnalysis(config, '共同人物抬手。'.repeat(2600), undefined, { referenceContext: context });
  assert.equal(requests.length, 2);
  requests.forEach((request) => assertFullContext(data(request, 'story_analysis_data').referenceContext));
  assert.deepEqual((long.characters![0] as any).storyReferenceBindings, [link(1), link(2)], 'merge image provenance across chapter chunks');
  checks++;

  responder = () => JSON.stringify(storyResult([{ referenceId: 'unknown', subjectId: 'character-1' }]));
  await assert.rejects(requestStoryAnalysis(config, '共同人物抬手。', undefined, { referenceContext: context }), /关联不在/u);
  responder = () => JSON.stringify(storyResult([link(1)], ['outside-asset']));
  await assert.rejects(requestStoryAnalysis(config, '共同人物抬手。', undefined, { referenceContext: context }), /不在当前章节/u);
  checks++;

  requests = []; responder = (_request, count) => JSON.stringify({ items: [{ name: '茶壶', category: '器皿', material: '铜',
    appearance: '青铜壶', effect: '盛茶', stateRules: count === 1 ? '' : '保持形状', storyReferenceBindings: [link(2, 'prop-1')] }] });
  const enriched = await requestStoryBibleEnrichment(config, '把茶壶放在桌上。', { characters: [], locations: [], props: ['茶壶'] }, undefined,
    { fullSourceContext: true, referenceContext: context });
  assert.equal(requests.length, 2, 'existing completeness repair still runs only for missing detail');
  requests.forEach((request) => assertFullContext(data(request, 'story_reference_data').referenceContext));
  assert.deepEqual(enriched.props[0].storyReferenceBindings, [link(2, 'prop-1')]);
  assert.deepEqual(enriched.incompleteKinds, []);
  checks++;
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
console.log(`Story reference LLM: ${checks} targeted mock checks passed; no live API requests.`);
