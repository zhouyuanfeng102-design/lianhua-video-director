import assert from 'node:assert/strict';
import { requestStoryAnalysis } from '../src/services/llm';
import type { StoryVisualConversionSnapshot, TextApiConfig } from '../src/types';

const sourceText = '甲踢出箱子，乙避开，箱子撞墙。';
const resultText = '甲的脚踢中箱子，箱子朝乙滑去。乙移开身体让出路径，箱子越过乙原先的位置撞到墙上。';
const snapshot: StoryVisualConversionSnapshot = {
  id: 'adopted', chapterId: 'chapter', sourceName: '复杂动作', sourceText, resultText, createdAt: 1,
  actionPlan: { version: 1, sourceParagraphs: [{ id: 'p1', text: sourceText }], summary: '踢出、避开、撞墙',
    events: [{ id: 'kick', sourceParagraphIds: ['p1'], evidence: sourceText, actor: '甲', target: '乙',
      action: '踢出箱子', phases: ['踢出', '避开', '撞墙'], result: '乙未被击中，箱子撞墙', uncertainties: [] }] },
  paragraphs: [{ id: 'v1', sourceParagraphIds: ['p1'], eventIds: ['kick'], text: resultText,
    stagingAdditions: ['箱子在地面滑行是已采用的画面编排'] }],
};
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://synthetic.mock.invalid/v1',
  apiKey: 'synthetic-only', model: 'synthetic', temperature: 0, maxTokens: 8192, vision: false };
const originalWindow = globalThis.window;
const requests: Array<{ system: string; data: any }> = [];
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  lianhuaDesktop: { request: async ({ body }: { body: string }) => {
    const messages = JSON.parse(body).messages as Array<{ role: string; content: string }>;
    const user = messages.find((message) => message.role === 'user')!.content;
    const data = JSON.parse(user.split('<story_analysis_data>\n')[1].split('\n</story_analysis_data>')[0]);
    requests.push({ system: messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'), data });
    return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      scenes: [{ title: '撞墙', content: data.sourceStory, summary: '箱子撞墙', characters: [], location: '', props: [] }],
      characters: [], locations: [], props: [],
    }) } }] }) };
  } },
} });
try {
  const analysis = await requestStoryAnalysis(config, resultText, undefined, { chapterId: 'chapter', visualConversion: snapshot });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].data.visualConversion, snapshot);
  assert.match(requests[0].system, /scenes.content 完整保留/u);
  assert.equal(analysis.scenes[0].content, resultText, 'analysis keeps the adopted continuous action prose');
  await requestStoryAnalysis(config, '用户已经改写成甲站立不动。', undefined, { visualConversion: snapshot });
  assert.equal(requests[1].data.visualConversion, undefined, 'unmatched historical evidence cannot restore deleted actions');
  assert.doesNotMatch(requests[1].system, /STORY_VISUAL_ACTION_CONTEXT_V1/u);
  console.log('PASS adopted action context reaches story analysis; unmatched history is omitted');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
}
