import assert from 'node:assert/strict';
import { generateSingleSegmentPrompt } from '../src/singleSegmentPrompt';
import { buildOfficialSeedanceInput, hasCurrentSeedancePrompt } from '../src/seedanceSource';
import { buildOfficialH3CompileInput } from '../src/officialPrompt';
import { getOfficialSeedanceSourceFingerprint } from '../src/seedancePrompt';
import { seedanceChineseWriterRule } from '../src/seedancePromptRules';
import { buildVideoPromptExecutionContext } from '../src/videoPromptExecutionContext';
import { createInitialState } from '../src/storage';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { Project, Storyboard } from '../src/types';

// Local responses exercise the existing writer/translator, without a live API.
const actions = ['甲颔首回礼并抬手起势。', '甲虚晃同时横移，乙跟随转身。', '甲连续三拳、左腿低扫两次；乙逐次格挡避让并右掌持续按左肩，至甲下沉后脱开。'];
const canonical = (cuts: number[]) => actions.map((action, index) =>
  `【${cuts[index]}s-${cuts[index + 1]}s】主体：@甲与乙，正在 [${action}]；空间：石台；光影：日光；镜头：侧面中景；台词：${index === 2 ? '甲（画内，镜内8–9秒）：“请继续。”' : '无'}；音效：脚步与格挡同期声。`).join('\n');
const original = canonical([0, 5, 10, 15]);
const retimed = canonical([0, 1.5, 4, 15]);
const prose = (body: string) => ['视频规格：15秒；16:9；720p；stereo。', '参考素材与职责：本次无外部素材。',
  '主体连续性：甲黑衣，乙白衣。', '一句话概述：甲乙连续试探并接续攻防。', `连续时间轴：\n${body.replaceAll('@', '')}`,
  '全局约束：只有已有脚步、衣料、格挡声，无背景音乐。'].join('\n\n');
const chinese = prose(retimed);
const english = ['Video specification: 15 seconds; 16:9; 720p; stereo.', 'References and responsibilities: No external media.',
  'Subject continuity: 甲 in black, 乙 in white.', 'One-sentence summary: 甲 and 乙 continue their sparring.',
  'Continuous timeline:\n0–1.5 seconds: 甲 nods and raises the hands.\n1.5–4 seconds: 甲 feints and moves sideways while 乙 turns.\n4–15 seconds: 甲 throws three punches and sweeps low twice with the left leg. 乙 blocks and evades, maintaining right-palm pressure on the left shoulder until 甲 lowers and breaks free. During 8–9 seconds of this shot, 甲 says in Chinese, “请继续。”',
  'Global constraints: Only existing footsteps, clothing and blocks; no background music.'].join('\n\n');
const base: Storyboard = {
  id: 'retiming', sceneId: 'scene', chapterId: 'chapter', workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s',
  shotMode: 'exact', shotCount: 3, pace: 'standard', aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo',
  stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', globalReferenceAssetIds: [],
  sourceStoryContent: `${actions.join('')}甲说：“请继续。”`, finalPrompt: original,
  shots: actions.map((action, index) => ({ id: `shot-${index + 1}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5,
    subject: '甲与乙', action, purpose: '试探', camera: '侧面中景', transition: '', lighting: '日光', sound: '同期声', result: '',
    referenceAssetIds: [], locked: false, sourceBeatIds: [`event-${index + 1}`], sourceExcerpt: action, prompt: original.split('\n')[index] })),
  promptPlan: { canonicalPrompt: original, durationSec: 15, aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo',
    workflow: 'drama', inputMode: 'text', shotIds: ['shot-1', 'shot-2', 'shot-3'], referenceAssetIds: [], constraints: [], trace: {} },
  promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(original), generatedAt: 1 },
  officialPromptZh: 'historical H3', officialPromptSource: original, createdAt: 1, updatedAt: 1,
} as Storyboard;
const project: Project = { ...structuredClone(createInitialState().project), characters: [], locations: [], props: [], scenes: [], assets: [], sequencePlans: [], storyboards: [base] };
const context = { characters: [], locations: [], props: [], assets: [] };
const buildSeedanceInput = (board: Storyboard) => buildOfficialSeedanceInput(project, board);
const executionContext = buildVideoPromptExecutionContext({ backend: 'api', api: { provider: 'generic', model: 'configured-seedance-2.0' } });

assert.match(seedanceChineseWriterRule(), /已有全部镜头起止值/u);
assert.doesNotMatch(seedanceChineseWriterRule(true), /已有全部镜头起止值|原起止时间、镜数、顺序和切点|不要 JSON/u);
for (const sequence of [false, true]) {
  const board = { ...structuredClone(base), ...(sequence ? { sequencePlanId: 'plan', segmentId: 'seg-2', segmentIndex: 2, globalStartSec: 15, globalEndSec: 30 } : {}) };
  board.seedance25Output = { targetId: 'seedance-2.5', promptZh: prose(original), durationSec: 15,
    sourceFingerprint: getOfficialSeedanceSourceFingerprint(buildSeedanceInput(board)), referenceManifest: [], warnings: [], generatedAt: 1 };
  const before = JSON.stringify(board);
  const calls: string[] = [];
  let checkpoint: Storyboard | undefined;
  const result = await generateSingleSegmentPrompt({ board, context, targetPromptFormat: 'seedance', purpose: 'action-retiming',
    skipConversion: true, reviewWithAi: true, buildSeedanceInput, executionContext, clean: (value) => value,
    onQualifiedChinese: (value) => { checkpoint = value; assert.equal(value.finalPrompt, retimed); assert.ok(hasCurrentSeedancePrompt(project, value)); },
    request: async (system, user, stage) => {
      calls.push(stage);
      if (stage === 'review') {
        assert.match(system, /移动已有镜界/u);
        assert.doesNotMatch(system, /已有全部镜头起止值|不要 JSON/u);
        const data = JSON.parse(user.match(/<seedance_source_data>\s*([\s\S]*?)\s*<\/seedance_source_data>/u)![1]);
        assert.equal(data.taskAuthority, 'current-segment-staging-replan');
        assert.equal(data.revisionScope, 'current-segment-action-retiming');
        assert.equal(data.executionContext.model, 'configured-seedance-2.0');
        assert.equal(data.specification.durationSec, 15);
        assert.equal(data.candidatePrompt, board.seedance25Output!.promptZh);
        assert.deepEqual(data.sourceEvidence.shots.map((shot: { id: string }) => shot.id), ['shot-1', 'shot-2', 'shot-3']);
        return JSON.stringify({ canonicalPrompt: retimed, seedancePrompt: chinese, shotSourceIds: board.shots.map((shot) => [shot.id]), shotMetadata: [null, null, null] });
      }
      assert.equal(stage, 'translate');
      assert.ok(checkpoint, 'the common source and Chinese are saved together before English');
      return english;
    } });
  assert.deepEqual(calls, ['review', 'translate']);
  assert.equal(JSON.stringify(board), before);
  assert.equal(result.finalPrompt, retimed);
  assert.equal(result.durationSec, 15);
  assert.deepEqual(result.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]), [['shot-1', 0, 1.5], ['shot-2', 1.5, 4], ['shot-3', 4, 15]]);
  assert.deepEqual(result.shots.map((shot) => shot.sourceBeatIds), board.shots.map((shot) => shot.sourceBeatIds));
  actions.forEach((action) => assert.ok(result.seedance25Output!.promptZh.includes(action)));
  assert.match(result.seedance25Output!.promptEn!, /three punches|sweeps low twice/u);
  assert.ok(hasCurrentSeedancePrompt(project, result, 'en'), result.seedance25Output?.englishError);
  assert.equal(buildOfficialH3CompileInput(result, context).canonicalPrompt, retimed, 'H3 consumes the updated common source');
  assert.equal(result.officialPromptZh, board.officialPromptZh, 'historical H3 is not silently rewritten');
  assert.equal(result.globalStartSec, board.globalStartSec);
  assert.equal(getOfficialSeedanceSourceFingerprint({ ...buildSeedanceInput(result), executionContext }), getOfficialSeedanceSourceFingerprint(buildSeedanceInput(result)));
  for (const failure of ['transport', 'json']) {
    let attempts = 0;
    await assert.rejects(generateSingleSegmentPrompt({ board, context, targetPromptFormat: 'seedance', purpose: 'action-retiming',
      skipConversion: true, buildSeedanceInput, clean: (value) => value,
      onQualifiedChinese: () => assert.fail('failed Chinese never overwrites old input'),
      request: async () => { attempts += 1; if (failure === 'transport') throw new Error('offline failure'); return '{'; } }));
    assert.equal(attempts, 1, 'no recovery or review call is added');
    assert.equal(JSON.stringify(board), before);
  }
  const preserved = await generateSingleSegmentPrompt({ board: result, context, targetPromptFormat: 'seedance', purpose: 'reference-refresh',
    skipConversion: true, buildSeedanceInput, clean: (value) => value,
    request: async (system, user, stage) => {
      if (stage === 'review') { assert.match(system, /已有全部镜头起止值/u); assert.doesNotMatch(user, /"revisionScope": "current-segment-action-retiming"/u); return chinese; }
      return english;
    } });
  assert.equal(preserved.finalPrompt, retimed);
  let translationCalls = 0;
  const translated = await generateSingleSegmentPrompt({ board: preserved, context, targetPromptFormat: 'seedance', mode: 'translate-english',
    buildSeedanceInput, clean: (value) => value, request: async (_system, _user, stage) => { translationCalls += 1; assert.equal(stage, 'translate'); return english; } });
  assert.equal(translationCalls, 1);
  assert.equal(translated.finalPrompt, retimed);
}
console.log('PASS Seedance standalone/sequence shared action retiming, fixed duration, nonuniform cuts, source identity, preservation and two-call delivery');
