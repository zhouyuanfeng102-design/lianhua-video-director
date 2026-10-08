import assert from 'node:assert/strict';
import { generateSingleSegmentPrompt } from '../src/singleSegmentPrompt';
import { hasCurrentOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt } from '../src/officialPrompt';
import { characterParticipationIssues } from '../src/characterParticipation';
import type { Character, ConverterPreset, PromptCharacterParticipation, ReferenceAsset, Storyboard, VideoShot } from '../src/types';

// Synthetic/offline: no real project, credentials, or model requests.
const person: Character = { id: 'person', name: '旅人', gender: '男', apparentAge: '成年', race: '人类',
  appearance: '黑发', outfit: '蓝衣', signatureProps: '', personality: '沉着', motionHabits: '',
  anchor: '蓝衣', negativeContinuity: '', assetIds: [] };
const canonical = Array.from({ length: 5 }, (_, index) =>
  `【${index * 6}s-${(index + 1) * 6}s】主体：@旅人 正在 [走向城门]；空间：城门前；光影：晨光；镜头：中景；台词：无；音效：脚步声`).join('\n');
const shots: VideoShot[] = canonical.split('\n').map((prompt, index) => ({ id: `shot-${index + 1}`, index: index + 1,
  startSec: index * 6, endSec: (index + 1) * 6, purpose: '前行', subject: '旅人', action: '走向城门', camera: '中景',
  lighting: '晨光', sound: '脚步声', result: '', transition: '', locked: false, referenceAssetIds: [], prompt,
  sourceBeatIds: [`beat-${index}`], sourceExcerpt: '旅人向城门走去。',
}));
const board: Storyboard = { id: 'board', sceneId: 'scene', workflow: 'drama', inputMode: 'text',
  sourceStoryContent: '旅人向城门走去。', durationSec: 30, durationPreset: 'custom', shotMode: 'auto',
  pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'style',
  ruleSetId: 'rule', globalLock: '', globalReferenceAssetIds: [], shots, finalPrompt: canonical, createdAt: 1, updatedAt: 1 };
const converter: ConverterPreset = { id: 'converter', name: '转换器', workflow: 'all', inputMode: 'all', scope: 'video',
  enabled: true, version: 'test', systemPrompt: '输出完整剧情', outputRules: '普通六字段', updatedAt: 1 };
const context = { characters: [person], assets: [] };
const body = 'integrated_multimodal_description: [Shot 1] 旅人在门外。\n[Shot 2] At 00:06.000 城门开启。\n'
  + '[Shot 3] At 00:12.000 旅人迈步。\n[Shot 4] At 00:18.000 旅人走向门内。\n'
  + '[Shot5] At 00:24.000 旅人站在门内，\n转身看向城外。\noverall_soundscape: N/A\nnon_diegetic_music: N/A';
const english = body.replaceAll('旅人', 'Traveler');
const participation: PromptCharacterParticipation = { version: 1, characters: [{ characterId: person.id, name: person.name,
  presence: 'visible', shotIndex: 5, evidence: '旅人站在门内, 转身看向城外。' }] };
const identityBindings = { version: 1 as const, characters: [{ characterId: person.id, name: person.name,
  referenceAnchor: 'Identity: 旅人, 蓝衣。' }] };
const delivery = { h3Prompt: body, canonicalPrompt: canonical, identityBindings, characterParticipation: participation,
  shotSourceIds: shots.map((shot) => [shot.id]), shotMetadata: shots.map(() => null) };
let checks = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); checks++; console.log(`PASS ${name}`); };
const run = async (review: string | (() => string), extra: { failEnglishReview?: boolean; isCurrent?: () => boolean } = {}) => {
  const calls: string[] = []; let englishCalls = 0; let checkpoint: Storyboard | undefined;
  const result = await generateSingleSegmentPrompt({ board: structuredClone(board), context, converter, reviewWithAi: true,
    clean: (value) => value, isCurrent: extra.isCurrent,
    onQualifiedChinese: (value) => { checkpoint = value; },
    request: async (_system, _user, stage) => {
      calls.push(stage);
      if (stage === 'convert') return canonical;
      if (stage === 'review') return typeof review === 'function' ? review() : review;
      englishCalls++;
      if (extra.failEnglishReview && englishCalls === 2) throw new Error('offline simulated review outage');
      return JSON.stringify({ h3Prompt: english, identityBindings });
    },
  });
  return { result, calls, checkpoint };
};

await test('screenshot evidence mismatch does not reject Chinese or trigger content repair', async () => {
  assert.ok(characterParticipationIssues(body, participation, [person], identityBindings).length);
  const { result, calls, checkpoint } = await run(JSON.stringify(delivery));
  assert.deepEqual(calls, ['convert', 'review', 'translate', 'translate']);
  assert.equal(result.officialPromptZh, body);
  assert.equal(result.officialPromptEn, english);
  assert.equal(checkpoint?.officialPromptZh, body);
  assert.equal(hasCurrentOfficialH3Prompt(result, context), true);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(result, context), true);
  assert.deepEqual(result.h3CharacterParticipation?.characters, participation.characters);
});
await test('unreadable ancillary metadata retains body with a nonblocking notice', async () => {
  const { result, calls } = await run(JSON.stringify({ ...delivery, identityBindings: null, characterParticipation: { bad: true } }));
  assert.equal(result.officialPromptZh, body);
  assert.ok(result.h3DeliveryWarnings?.length);
  assert.equal(calls.filter((stage) => stage === 'review').length, 1);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(result, context), true);
});
await test('missing companion timeline retains saved shots and both readable prompts', async () => {
  const { result } = await run(JSON.stringify({ h3Prompt: body, identityBindings, characterParticipation: participation }));
  assert.equal(result.officialPromptZh, body);
  assert.ok(result.h3DeliveryWarnings?.some((item) => item.includes('时间轴待同步')));
  assert.equal(result.finalPrompt, canonical);
  assert.equal(result.shots.length, 5);
  assert.equal(hasCurrentOfficialH3Prompt(result, context), true);
  const reloaded = JSON.parse(JSON.stringify(result)) as Storyboard;
  assert.equal(hasCurrentOfficialH3EnglishPrompt(reloaded, context), true);
  assert.deepEqual(reloaded.h3DeliveryWarnings, result.h3DeliveryWarnings);
});
await test('bad JSON requests technical repair, then accepts AI body without metadata rechecks', async () => {
  let count = 0;
  const { result, calls } = await run(() => ++count === 1 ? '{broken' : JSON.stringify(delivery));
  assert.equal(result.officialPromptZh, body);
  assert.equal(calls.filter((stage) => stage === 'review').length, 2);
});
await test('exhausted technical repairs preserve candidate and warn rather than discard text', async () => {
  const { result, calls, checkpoint } = await run('{broken');
  assert.equal(calls.filter((stage) => stage === 'review').length, 4);
  assert.ok(result.officialPromptZh?.trim());
  assert.equal(checkpoint?.officialPromptZh, result.officialPromptZh);
  assert.ok(result.h3DeliveryWarnings?.some((item) => item.includes('AI复核未完成')));
  assert.equal(hasCurrentOfficialH3Prompt(result, context), true);
});
await test('English review failure preserves received translation and independent Chinese', async () => {
  const { result } = await run(JSON.stringify(delivery), { failEnglishReview: true });
  assert.equal(result.officialPromptZh, body);
  assert.equal(result.officialPromptEn, english);
  assert.ok(result.h3DeliveryWarningsEn?.length);
});
await test('project change still cancels before storing returned text', async () => {
  let current = true;
  await assert.rejects(run(() => { current = false; return JSON.stringify(delivery); }, { isCurrent: () => current }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError');
});
await test('first H3 delivery after an unreadable canonical creates output metadata without compiling the AI body', async () => {
  const asset: ReferenceAsset = { id: 'selected-image', name: '城门参考', type: 'reference', role: 'composition',
    mediaType: 'image', source: 'upload', dataUrl: 'data:image/png;base64,AA==', tags: [], createdAt: 1, updatedAt: 1 };
  const firstContext = { ...context, assets: [asset] };
  const firstBoard = { ...board, globalReferenceAssetIds: [asset.id] };
  assert.equal(firstBoard.targetOutput, undefined);
  assert.equal(firstBoard.targetModelId, undefined);
  const gap = canonical.replace('【6s-12s】', '【7s-12s】');
  const calls: string[] = [];
  let checkpoint: Storyboard | undefined;
  const result = await generateSingleSegmentPrompt({ board: firstBoard, context: firstContext, converter,
    reviewWithAi: true, clean: (value) => value, now: () => 100,
    onQualifiedChinese: (value) => { checkpoint = value; },
    request: async (_system, user, stage) => {
      calls.push(stage);
      if (stage === 'convert') return gap;
      if (stage === 'review') {
        const data = JSON.parse(user.match(/<video_staging_review_data>\s*([\s\S]*?)\s*<\/video_staging_review_data>/u)![1]);
        assert.equal(data.canonicalPrompt, gap);
        assert.equal(data.candidatePrompt, '');
        return JSON.stringify({ ...delivery, canonicalPrompt: gap });
      }
      return JSON.stringify({ h3Prompt: english, identityBindings });
    },
  });
  assert.deepEqual(calls, ['convert', 'review', 'translate', 'translate']);
  assert.equal(result.officialPromptZh, body);
  assert.equal(result.officialPromptEn, english);
  assert.equal(result.targetModelId, 'minimax-h3');
  assert.equal(result.targetOutput?.targetId, 'minimax-h3');
  assert.equal(result.targetOutput?.prompt, body);
  assert.equal(result.targetOutput?.parameters.durationSec, 30);
  assert.equal(result.targetOutput?.parameters.aspectRatio, '16:9');
  assert.equal(result.targetOutput?.generatedAt, 100);
  assert.deepEqual(result.targetOutput?.referenceManifest.map((entry) => [entry.id, entry.token]), [[asset.id, '<Picture 1>']]);
  assert.equal(checkpoint?.targetOutput?.prompt, body);
  assert.equal(hasCurrentOfficialH3Prompt(checkpoint!, firstContext), true);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(result, firstContext), true);
  assert.equal(hasCurrentOfficialH3EnglishPrompt(JSON.parse(JSON.stringify(result)), firstContext), true);
  assert.equal(firstBoard.targetOutput, undefined, 'input and prior results remain untouched');
});
console.log(`AI-authored final delivery pipeline: ${checks} offline checks passed`);
