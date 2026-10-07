import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createInitialState } from '../src/storage';
import { applyOfficialH3Prompt } from '../src/officialPrompt';
import { sourceContentHash } from '../src/sourceContentHash';
import type { Storyboard, VideoSequencePlan } from '../src/types';
import {
  encodeRecoveredState, recoverDeletedAssetPrompt, writeRecoveryWithCompareAndSwap, type RecoveryState,
} from './lib/deletedAssetPromptRecovery';

const { validateStateText } = createRequire(import.meta.url)('../electron/stateSerialization.cjs');
const target = { projectId: 'recovery-project', storyboardId: 'recovery-board', sequencePlanId: 'recovery-plan' };
const fixture = (): { current: RecoveryState; snapshot: RecoveryState } => {
  const initial = createInitialState();
  const prompts = [
    '【0s-5s】主体：李云；动作：李云听见敲门声，停步望向木门；空间：雨夜客栈；光影：暖色烛光；镜头：中景缓推；台词：无；音效：雨声。',
    '【5s-10s】主体：李云；动作：李云抬手靠近门闩；空间：雨夜客栈；光影：暖色烛光；镜头：固定近景；台词：无；音效：雨声。',
  ];
  const board: Storyboard = {
    id: target.storyboardId, sequencePlanId: target.sequencePlanId, segmentId: 'segment-1', sceneId: 'scene-1',
    workflow: 'drama', inputMode: 'text', durationSec: 10, durationPreset: '10s', shotMode: 'exact', shotCount: 2,
    pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'style_cinema',
    ruleSetId: 'timeline_director_cn', converterPresetId: 'converter_unified_video', globalLock: '身份不变',
    shots: prompts.map((prompt, index) => ({
      id: `shot-${index}`, index: index + 1, startSec: index * 5, endSec: (index + 1) * 5, purpose: '观察',
      subject: '李云', action: '李云停步', camera: '中景', transition: '切入', lighting: '烛光', sound: '雨声', result: '看向门口',
      referenceAssetIds: ['deleted-output'], prompt, locked: true,
    })),
    finalPrompt: prompts.join('\n\n'), promptTrace: { modelRuleSetId: 'timeline_director_cn', converterPresetId: 'converter_unified_video',
      sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1, mode: 'text-api', shotPlanMode: 'ai-complete',
      convertedPromptFingerprint: sourceContentHash(prompts.join('\n\n')) },
    promptPlan: { canonicalPrompt: prompts.join('\n\n'), durationSec: 10, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      workflow: 'drama', inputMode: 'text', shotIds: ['shot-0', 'shot-1'], referenceAssetIds: [], constraints: [],
      trace: { ruleSetId: 'timeline_director_cn', converterId: 'converter_unified_video' } },
    firstFrameAssetId: 'deleted-output', createdAt: 1, updatedAt: 1,
  };
  const official = applyOfficialH3Prompt(board, { assets: [], characters: [], locations: [], props: [] });
  official.officialPromptEn = official.officialPromptZh!.replaceAll('李云', 'Li Yun');
  official.officialPromptEnSource = official.officialPromptZh;
  official.englishPrompt = official.officialPromptEn;
  official.englishPromptSource = official.officialPromptZh;
  const snapshot: RecoveryState = { ...initial, project: { ...initial.project, id: target.projectId,
    assets: [{ id: 'deleted-output', name: '自产图', type: 'reference', role: 'composition', tags: [], source: 'generated',
      sourceStoryboardId: board.id, createdAt: 1, updatedAt: 1 }],
    characters: [], locations: [], props: [], scenes: [], storyboards: [official],
    sequencePlans: [{ id: target.sequencePlanId, segments: [{ id: 'segment-1', storyboardId: board.id, status: 'ready' }] } as VideoSequencePlan],
  }, projects: [{ id: target.projectId, __activeProjectReference: true }] };
  const current = structuredClone(snapshot);
  current.project.assets = [];
  const damaged = current.project.storyboards[0];
  damaged.shots = damaged.shots.map((shot) => ({ ...shot, referenceAssetIds: [] }));
  delete damaged.firstFrameAssetId;
  damaged.finalPrompt = prompts.join('\n');
  damaged.promptPlan!.canonicalPrompt = damaged.finalPrompt;
  damaged.officialPromptEn = '';
  damaged.englishPrompt = '';
  damaged.audioLedger = [];
  damaged.updatedAt = 2;
  Object.assign(damaged, applyOfficialH3Prompt(damaged, { assets: [], characters: [], locations: [], props: [] }));
  return { current, snapshot };
};

{
  const { current, snapshot } = fixture();
  current.project.description = '用户后来修改的项目说明';
  current.settings = { keepCurrent: 'secret-is-not-printed' };
  const before = structuredClone(current);
  const result = recoverDeletedAssetPrompt(current, snapshot, target, 3);
  assert.equal(result.status, 'recoverable');
  assert.deepEqual(current, before, 'pure helper never mutates input');
  assert.equal(result.state.project.storyboards[0].finalPrompt, snapshot.project.storyboards[0].finalPrompt);
  assert.equal(result.state.project.storyboards[0].officialPromptEn, snapshot.project.storyboards[0].officialPromptEn);
  assert.deepEqual(result.state.project.storyboards[0].shots, before.project.storyboards[0].shots);
  assert.equal(result.state.project.storyboards[0].firstFrameAssetId, undefined);
  assert.equal(result.state.project.assets.length, 0);
  assert.equal(result.state.project.description, before.project.description);
  assert.strictEqual(result.state.settings, current.settings);
  assert.strictEqual(result.state.project.sequencePlans, current.project.sequencePlans);
  assert.strictEqual(result.state.project.generationTasks, current.project.generationTasks);
  assert.deepEqual(result.state.projects, [{ id: target.projectId, __activeProjectReference: true }]);
  assert.equal(recoverDeletedAssetPrompt(result.state, snapshot, target).status, 'already-current');
  const encoded = encodeRecoveredState(result.state, 3);
  assert.deepEqual(validateStateText(encoded).project, JSON.parse(JSON.stringify(result.state.project)), 'native integrity validator accepts repaired state');
}
for (const mutate of [
  (current: RecoveryState) => { current.project.storyboards[0].shots[0].action = '用户改写的新动作'; },
  (current: RecoveryState) => { current.project.storyboards[0].finalPrompt += '用户后来改稿'; },
  (current: RecoveryState) => { current.project.storyboards[0].sourceStoryContent = '更改的原文'; },
  (current: RecoveryState) => { current.project.sequencePlans[0].title = '后来重排的计划'; },
  (current: RecoveryState) => { current.project.storyboards[0].officialPromptEn = 'new authored translation'; },
  (current: RecoveryState) => {
    const board = current.project.storyboards[0];
    board.officialPromptZh = board.officialPromptZh!.replace('李云', '用户新加角色');
    board.targetOutput!.prompt = board.officialPromptZh;
  },
  (current: RecoveryState) => { current.project.storyboards[0].targetOutput!.parameters.seed = 777; },
]) {
  const { current, snapshot } = fixture();
  mutate(current);
  assert.throws(() => recoverDeletedAssetPrompt(current, snapshot, target), /拒绝定点恢复/);
}
{
  const { current, snapshot } = fixture();
  snapshot.project.assets[0].source = 'upload';
  assert.throws(() => recoverDeletedAssetPrompt(current, snapshot, target), /拒绝定点恢复/);
}
{
  const { current, snapshot } = fixture();
  snapshot.project.storyboards[0].promptTrace!.convertedPromptFingerprint = 'invalid';
  assert.throws(() => recoverDeletedAssetPrompt(current, snapshot, target), /备份不是/);
}
const directory = mkdtempSync(join(tmpdir(), 'lianhua-targeted-recovery-'));
try {
  const file = join(directory, 'project-state.json');
  const original = Buffer.from('{"original":true}');
  const replacement = '{"repaired":true}';
  writeFileSync(file, original);
  assert.throws(() => writeRecoveryWithCompareAndSwap(file, original, replacement, () => { throw new Error('app running'); }), /app running/);
  assert.deepEqual(readFileSync(file), original);
  writeFileSync(file, '{"newUserWork":true}');
  assert.throws(() => writeRecoveryWithCompareAndSwap(file, original, replacement, () => {}), /项目文件已变化/);
  assert.equal(readFileSync(file, 'utf8'), '{"newUserWork":true}');
  writeFileSync(file, original);
  let checks = 0;
  assert.throws(() => writeRecoveryWithCompareAndSwap(file, original, replacement, () => {
    if (++checks === 2) writeFileSync(file, '{"concurrentSave":true}');
  }), /写入前发现/);
  assert.equal(readFileSync(file, 'utf8'), '{"concurrentSave":true}');
  writeFileSync(file, original);
  const saved = writeRecoveryWithCompareAndSwap(file, original, replacement, () => {});
  assert.equal(readFileSync(file, 'utf8'), replacement);
  assert.deepEqual(readFileSync(saved.backupPath), original);
  assert.equal(existsSync(`${file}.prompt-recovery.lock`), false);
} finally {
  // directory is the exact unique mkdtemp path created by this test, never user data.
  rmSync(directory, { recursive: true, force: true });
}
console.log('PASS deleted-asset prompt recovery: precise restoration, stale/edit refusal, integrity, process guard, CAS and original backup');
