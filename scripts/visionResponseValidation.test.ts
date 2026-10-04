import assert from 'node:assert/strict';
import { requestVisionAnalysis } from '../src/services/llm';
import type { TextApiConfig } from '../src/types';

const config: TextApiConfig = {
  enabled: true,
  provider: 'openai_compatible',
  baseUrl: 'https://vision.example.test/v1/chat/completions',
  apiKey: 'synthetic-test-key',
  model: 'synthetic-vision',
  temperature: 0.2,
  maxTokens: 4096,
  vision: true,
};
const reference = 'data:image/png;base64,AA==';
const originalWindow = globalThis.window;
let response: Record<string, unknown> = {};
let requestBody = '';
let calls = 0;
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    lianhuaDesktop: {
      request: async (payload: { body?: string }) => {
        calls += 1;
        requestBody = payload.body || '';
        return {
          status: 200,
          body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }),
        };
      },
    },
  },
});

try {
  for (const kind of ['character', 'location', 'prop'] as const) {
    response = { name: ' ', note: '分析已完成', unexpectedDescription: '此文字不属于可填写资料字段' };
    await assert.rejects(
      requestVisionAnalysis(config, kind, reference),
      /资料为空/u,
      `${kind}: unknown response fields must not make empty known fields look successful`,
    );
  }

  response = { name: '', appearance: ' \n ', height: '' };
  await assert.rejects(requestVisionAnalysis(config, 'character', reference), /资料为空/u);

  response = { note: '分析已完成' };
  await assert.rejects(requestVisionAnalysis(config, 'character', reference));

  response = {
    name: '  测试人物  ',
    gender: '男',
    appearance: '短发，圆框眼镜',
    outfit: '深蓝外套',
    age: '约三十岁',
    actualAge: '三十二岁',
    height: '依据身旁标尺约一米八',
    props: '  ',
    note: '额外说明',
    weather: '不属于人物资料',
    states: '不得回填成文本字段',
    unknownObject: { appearance: '嵌套值不得当作普通字段' },
  };
  const character = await requestVisionAnalysis(config, 'character', reference);
  assert.deepEqual(character.fields, {
    name: '测试人物',
    gender: '男',
    appearance: '短发，圆框眼镜',
    outfit: '深蓝外套',
    age: '约三十岁',
    actualAge: '三十二岁',
    height: '依据身旁标尺约一米八',
  });
  assert.match(requestBody, /返回字段[^。]*height/u);
  assert.match(requestBody, /height 仅在画面有可靠尺度依据时填写/u);

  response = { description: '石砌拱廊', lighting: '柔和日光', gender: '男', note: '分析已完成' };
  assert.deepEqual((await requestVisionAnalysis(config, 'location', reference)).fields, {
    description: '石砌拱廊', lighting: '柔和日光',
  });
  response = { material: '黄铜', stateRules: '盖子保持关闭', outfit: '不属于道具资料', note: '分析已完成' };
  assert.deepEqual((await requestVisionAnalysis(config, 'prop', reference)).fields, {
    material: '黄铜', stateRules: '盖子保持关闭',
  });

  response = {
    story: '一棵树在九个角度下的观察',
    note: '只保留资料字段',
    states: Array.from({ length: 9 }, (_, index) => ({
      index: index + 1,
      subject: '树木', action: '枝叶随风摆动', camera: '平视', transition: '切入', lighting: '日光', result: '枝叶归位',
    })),
  };
  const grid = await requestVisionAnalysis(config, 'grid', reference);
  assert.deepEqual(grid.fields, { story: '一棵树在九个角度下的观察' });
  assert.equal(grid.gridStates?.length, 9);
  assert.equal(calls, 9, 'response validation must never retry the model automatically');
} finally {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
}

console.log('Vision response validation: 9 synthetic requests passed; unknown fields cannot report a false success.');
