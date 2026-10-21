import assert from 'node:assert/strict';
import {
  requestCharacterPrivateProfileAutofill,
  requestImageAssetAutofill,
  requestImagePromptConverter,
  requestShotRecommendation,
  requestStoryDurationEstimate,
  requestStoryPreparationWithReview,
  TextModelResponseError,
} from '../src/services/llm';
import { extractStoryBeats } from '../src/storySegmentation';
import type { TextApiConfig } from '../src/types';

type Message = { role: string; content: string | Array<{ type: string; text?: string }> };
type RequestBody = { messages: Message[] };
const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://offline.invalid/v1',
  apiKey: '', model: 'offline-only', temperature: 0.2, maxTokens: 4096, vision: true,
};
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let requests: RequestBody[] = [];
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  lianhuaDesktop: { request: async (payload: { body?: string }) => {
    requests.push(JSON.parse(payload.body || '{}') as RequestBody);
    // A non-retryable model error stops before existing response/repair paths.
    throw new TextModelResponseError('empty_content', 'OFFLINE_CAPTURE_STOP');
  } },
} });
globalThis.fetch = async () => { throw new Error('Unexpected network access in offline prompt test'); };

const capture = async (call: () => Promise<unknown>): Promise<RequestBody> => {
  requests = [];
  await assert.rejects(call, /OFFLINE_CAPTURE_STOP/u);
  assert.equal(requests.length, 1, 'capture must stop at the first request without a retry');
  return requests[0];
};
const messageText = (message: Message): string => typeof message.content === 'string'
  ? message.content : message.content.map((part) => part.text || '').join('\n');
const textOf = (body: RequestBody, role: string): string => body.messages.filter((message) => message.role === role).map(messageText).join('\n');
const dataOf = (body: RequestBody, tag: string): Record<string, any> => {
  const match = textOf(body, 'user').match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `${tag} must remain in the request`);
  return JSON.parse(match[1]) as Record<string, any>;
};
const commonPrefixCharacters = (left: string, right: string): number => {
  let index = 0;
  while (index < Math.min(left.length, right.length) && left[index] === right[index]) index += 1;
  return index;
};

try {
  const sharedStory = '林舟住在庭院，青衫和木门来自同一段完整故事。'.repeat(180);
  const contexts = [1, 2].map((index) => ({
    kind: 'semantic-segment-source-v1', sourceStoryTitle: '共享原文', sourceContentHash: 'same-source',
    segmentIndex: index, segmentCount: 2, segmentDurationSec: 15,
    segment: { title: `第${index}段`, content: `林舟走到第${index}扇门前。`,
      semanticSource: { sourceEvidence: [], events: [], dialogues: [] } },
    generationStoryContent: `林舟走到第${index}扇门前。`,
    storyUnderstandingContext: {
      usage: 'understanding-only', sourceStoryContent: sharedStory,
      sceneContext: { kind: 'video-scene-context-v1', usage: 'understanding-only', locationSelection: 'linked-locations',
        locations: [], scenes: [{ id: `scene-${index}`, title: `场地${index}`, content: `第${index}扇门`, locationIds: [] }], references: [] },
      characterIdentities: [], instruction: '全文只用于理解，不改变当前段演出范围。',
    },
    creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' },
    characterContinuity: [], pacing: { pace: 'natural' },
  }));
  const snapshots = structuredClone(contexts);
  const segmentBodies = [];
  for (const context of contexts) {
    const body = await capture(() => requestShotRecommendation(config, {
      durationSec: 15, workflow: 'drama', pace: 'normal', story: context.generationStoryContent,
      sequenceSegmentContext: context,
    }, { reviewWithAi: true }));
    const data = dataOf(body, 'storyboard_planning_data');
    for (const [key, value] of Object.entries(context)) assert.deepEqual(data.sequenceSegmentContext[key], value, key);
    assert.equal(data.sourceStory, context.generationStoryContent);
    assert.deepEqual(body.messages.map((message) => message.role), ['system', 'user']);
    segmentBodies.push(body);
  }
  assert.deepEqual(contexts, snapshots, 'request ordering must not mutate domain context');
  assert.equal(textOf(segmentBodies[0], 'system'), textOf(segmentBodies[1], 'system'));
  const firstUser = textOf(segmentBodies[0], 'user');
  const commonCharacters = commonPrefixCharacters(firstUser, textOf(segmentBodies[1], 'user'));
  assert.ok(firstUser.indexOf(sharedStory) >= 0);
  assert.ok(commonCharacters > firstUser.indexOf(sharedStory) + sharedStory.length,
    'both complete shared story and stable identity facts must precede changing scene/segment evidence');
  assert.ok(firstUser.indexOf('"sourceStoryContent"') < firstUser.indexOf('"segmentIndex"'));
  console.log(`PASS semantic request shared prefix: ${commonCharacters} characters (not tokens or a measured cache hit rate)`);

  const form = { name: '林舟', appearance: '', outfit: '', gender: '男' };
  const assetBodies = [];
  for (const field of ['appearance', 'outfit']) {
    const body = await capture(() => requestImageAssetAutofill(config, 'character', form, [field, 'name'], sharedStory));
    const request = dataOf(body, 'asset_autofill_request');
    assert.equal(request.assetKind, 'character');
    assert.deepEqual(request.requestFields, [field], 'nonempty name remains outside the writable field set');
    assert.deepEqual(Object.keys(request.responseShape), [field]);
    assert.ok(textOf(body, 'user').indexOf(sharedStory) < textOf(body, 'user').indexOf('当前表单：'));
    assetBodies.push(body);
  }
  assert.equal(textOf(assetBodies[0], 'system'), textOf(assetBodies[1], 'system'), 'field selection no longer changes the early system prefix');
  assert.match(textOf(assetBodies[0], 'system'), /不得返回、改写或推断其他字段/u);
  const noStory = await capture(() => requestImageAssetAutofill(config, 'character', form, ['appearance'], 'MUST_NOT_INCLUDE_PROJECT_SOURCE', undefined, { useStory: false }));
  assert.ok(!textOf(noStory, 'user').includes('MUST_NOT_INCLUDE_PROJECT_SOURCE'));
  console.log('PASS ordinary asset field boundary, nonempty fields, source opt-out and stable system');

  const privateBodies = [];
  for (const field of ['nsfwFullBody', 'nsfwBreasts']) {
    const body = await capture(() => requestCharacterPrivateProfileAutofill(config,
      { name: '甲角色', gender: '女', appearance: '成年人物的既定外貌' }, [field], '同一源剧情', '同一项目资料'));
    assert.deepEqual(dataOf(body, 'private_profile_request').requestFields, [field]);
    assert.deepEqual(Object.keys(dataOf(body, 'private_profile_request').responseShape), [field]);
    privateBodies.push(body);
  }
  assert.equal(textOf(privateBodies[0], 'system'), textOf(privateBodies[1], 'system'));
  assert.match(textOf(privateBodies[0], 'system'), /不能根据资料扩展集合或改写已有非空字段/u);
  console.log('PASS private profile requested fields remain current with stable system');

  const source = '林舟推开木门，沿着走廊走进庭院。';
  const visual = await capture(() => requestStoryPreparationWithReview(config, source));
  assert.equal(dataOf(visual, 'story_visual_data').sourceTextOrRequirement, source);
  const visualUser = textOf(visual, 'user');
  assert.equal(visualUser.split('先建立完整的场景稿，再整理场景内的有序事件。').length - 1, 1,
    'stage output instruction must be sent exactly once');
  assert.ok(visualUser.indexOf('"continuity"') < visualUser.indexOf('"sourceTextOrRequirement"'));
  console.log('PASS visual conversion stage instruction is no longer duplicated');

  const image = await capture(() => requestImagePromptConverter(config, 'character', '本次角色画面', 'natural-language', '输出当前画面', '共同身份来源'));
  const imageUser = textOf(image, 'user');
  assert.ok(imageUser.includes('共同身份来源') && imageUser.includes('本次角色画面'));
  assert.ok(imageUser.indexOf('共同身份来源') < imageUser.indexOf('本次角色画面'));
  console.log('PASS image conversion keeps identity evidence ahead of current visual source');

  const durationBodies = [];
  for (const segmentDurationSec of [10, 15]) {
    const body = await capture(() => requestStoryDurationEstimate(config, {
      title: '估时样例', story: source, beats: extractStoryBeats(source), segmentDurationSec,
    }));
    assert.equal(dataOf(body, 'story_data').segmentDurationSec, segmentDurationSec);
    assert.equal(dataOf(body, 'story_data').story, source);
    durationBodies.push(body);
  }
  assert.equal(textOf(durationBodies[0], 'system'), textOf(durationBodies[1], 'system'));
  console.log('PASS duration values remain current in data without splitting the system prefix');
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  globalThis.fetch = originalFetch;
}
