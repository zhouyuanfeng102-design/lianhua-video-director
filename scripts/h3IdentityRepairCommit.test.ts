import assert from 'node:assert/strict';
import { commitH3IdentityRepair } from '../src/h3IdentityRepairCommit';
import type { H3IdentityRepairResult } from '../src/h3IdentityRepair';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { applyOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt, hasCurrentOfficialH3Prompt } from '../src/officialPrompt';
import { buildSequencePromptHandoff, getSequencePromptHandoffStatus, stampSequencePromptHandoff } from '../src/sequencePromptHandoff';
import { createInitialState } from '../src/storage';
import { createStoryboardRevision, restoreStoryboardRevisionSnapshot } from '../src/storyboardVersions';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { Character, Project, Storyboard, VideoSequencePlan } from '../src/types';

export const repairCharacter: Character = { id: 'amu', name: '阿沐', gender: '女', apparentAge: '成年', race: '人类',
  appearance: '短发', outfit: '灰色外套', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [] };
const story = '阿沐开门说：“请等一等。”随后停在门口。';
const canonical = '【0s-5s】主体：@阿沐（平静）[朝向：门] 正在 [开门后停步]（等待）；空间：门廊；光影：自然光；镜头：稳定中景；台词：@阿沐：请等一等。；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]';

/** Synthetic data only; importing this helper does not run the assertions. */
export const makeIdentityRepairProject = (): Project => {
  const state = createInitialState();
  const plan: VideoSequencePlan = {
    id: 'plan', title: '修复测试', sourceStoryTitle: '修复测试', sourceStoryContent: story,
    durationMode: 'fixed', requestedTotalDurationSec: 15, totalDurationSec: 15, segmentDurationSec: 5,
    segmentationMode: 'fixed', fitStatus: 'balanced', createdAt: 1, updatedAt: 1,
    segments: [1, 2, 3].map((index) => ({ id: `segment-${index}`, index, title: `第${index}段`,
      globalStartSec: (index - 1) * 5, globalEndSec: index * 5, durationSec: 5, content: story, summary: story,
      sourceSceneIds: ['scene'], sourceBeatIds: [], narrativePurpose: '等待', entryState: '到门口', exitState: '停步',
      transitionHint: '继续等待', continuityPack: '灰外套', storyboardId: `board-${index}`, status: 'ready', locked: false })),
  };
  let project: Project = { ...state.project, id: 'identity-repair-project', characters: [repairCharacter], assets: [], locations: [], props: [],
    scenes: [{ id: 'scene', title: '合成剧情', content: story, summary: story, characterIds: ['amu'], locationIds: [], propIds: [],
      storyboardIds: ['board-1', 'board-2', 'board-3'], createdAt: 1, updatedAt: 1 }], sequencePlans: [plan],
    storyboards: [], generationTasks: [{ id: 'submitted-video', kind: 'video', storyboardId: 'board-2', targetId: 'minimax-h3', status: 'succeeded',
      requestBody: { prompt: 'frozen submitted prompt' }, resultUrl: 'saved-video.mp4', createdAt: 1, updatedAt: 1 }] };
  project.storyboards = [1, 2, 3].map((index): Storyboard => {
    const board: Storyboard = {
      id: `board-${index}`, sceneId: 'scene', sourceStoryContent: story, sourceStoryTitle: '修复测试',
      workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1,
      pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', globalLock: '',
      stylePresetId: 'style', ruleSetId: 'rule', converterPresetId: 'converter', finalPrompt: canonical,
      sequencePlanId: 'plan', segmentId: `segment-${index}`, segmentIndex: index, segmentCount: 3,
      globalStartSec: (index - 1) * 5, globalEndSec: index * 5, createdAt: 1, updatedAt: 1,
      shots: [{ id: `shot-${index}`, index: 1, startSec: 0, endSec: 5, subject: '阿沐', action: '开门后停步', camera: '中景',
        purpose: '等待', lighting: '自然光', sound: '', transition: '连续', result: '停步', referenceAssetIds: [], prompt: canonical, locked: false }],
      promptTrace: { mode: 'text-api', shotPlanMode: 'ai-complete', modelRuleSetId: 'rule', converterPresetId: 'converter',
        sourceDocumentIds: [], referenceAssetIds: [], convertedPromptFingerprint: sourceContentHash(canonical), generatedAt: 1 },
      h3IdentityBindings: { version: 1, characters: [{ characterId: 'amu', name: '阿沐', referenceAnchor: '过时中文身份句。' }] },
      h3IdentityBindingsEn: { version: 1, characters: [{ characterId: 'amu', name: '阿沐', referenceAnchor: 'Stale English identity.' }] },
    };
    const result = applyOfficialH3Prompt(board, officialH3ContextForStoryboard(project, board));
    result.officialPromptEn = result.officialPromptZh;
    result.officialPromptEnSource = result.officialPromptZh;
    result.englishPrompt = result.officialPromptEn;
    result.englishPromptSource = result.finalPrompt;
    result.targetOutput!.parameters = { preserved: 'user-video-parameters' };
    result.revisions = [createStoryboardRevision(result, [], { reason: 'existing-history', createdAt: 1 })];
    return result;
  });
  for (const index of [1, 2]) {
    const context = buildSequencePromptHandoff(project, plan.id, plan.segments[index].id).context!;
    project = { ...project, storyboards: project.storyboards.map((board, position) => position === index ? stampSequencePromptHandoff(board, context) : board) };
  }
  return project;
};

export const identityRepairResultFor = (board: Storyboard, language: 'zh' | 'en', insert = true): H3IdentityRepairResult => {
  const source = (language === 'zh' ? board.officialPromptZh : board.officialPromptEn)!;
  const sentence = language === 'zh' ? '身份：阿沐。' : 'Identity: 阿沐.';
  const position = source.indexOf('[Shot 1]') + '[Shot 1]'.length;
  const text = `\n${sentence}\n`;
  return { prompt: insert ? source.slice(0, position) + text + source.slice(position) : source,
    identityBindings: { version: 1, characters: [{ characterId: 'amu', name: '阿沐', referenceAnchor: sentence }] },
    changed: true, promptChanged: insert, repairedCharacterIds: ['amu'], attempts: 1,
    insertedSentences: insert ? [sentence] : [], edits: insert ? [{ start: position, text }] : [] };
};

const run = (): void => {
  let groups = 0;
  const group = (fn: () => void): void => { fn(); groups += 1; };
  group(() => {
    const project = makeIdentityRepairProject();
    const original = JSON.stringify(project);
    const source = project.storyboards[1];
    const zh = identityRepairResultFor(source, 'zh');
    const en = identityRepairResultFor(source, 'en');
    const next = commitH3IdentityRepair(project, source.id, { zh, en }, 100);
    const board = next.storyboards[1];
    assert.equal(JSON.stringify(project), original, 'source/history are immutable');
    for (const key of ['shots', 'finalPrompt', 'promptTrace', 'durationSec', 'shotCount', 'audioLedger'] as const) assert.deepEqual(board[key], source[key]);
    assert.deepEqual(board.targetOutput!.parameters, source.targetOutput!.parameters);
    assert.deepEqual(next.generationTasks, project.generationTasks);
    assert.deepEqual(next.sequencePlans, project.sequencePlans);
    assert.equal(board.officialPromptZh, zh.prompt);
    assert.equal(board.officialPromptEn, en.prompt);
    assert.equal(board.officialPromptEnSource, zh.prompt);
    assert.equal(board.targetOutput!.prompt, zh.prompt);
    assert.equal(hasCurrentOfficialH3Prompt(board, officialH3ContextForStoryboard(next, board)), true);
    assert.equal(hasCurrentOfficialH3EnglishPrompt(board, officialH3ContextForStoryboard(next, board)), true);
    assert.equal(board.revisions!.length, source.revisions!.length + 2);
    const before = board.revisions!.at(-2)!;
    const after = board.revisions!.at(-1)!;
    assert.equal(before.reason, 'pre-identity-repair');
    assert.equal(before.officialPromptZh, source.officialPromptZh);
    assert.deepEqual(before.h3IdentityBindings, source.h3IdentityBindings);
    assert.equal(after.officialPromptEn, en.prompt);
    assert.equal(board.activeRevisionId, after.id);
    assert.ok(before.storyboardId && before.revision && before.shots);
    const restored = restoreStoryboardRevisionSnapshot({ ...board, shots: board.shots.map((shot) => ({ ...shot })) }, {
      ...before, storyboardId: before.storyboardId, revision: before.revision, shots: before.shots.map((shot) => ({ ...shot })),
    });
    assert.equal(restored.officialPromptZh, source.officialPromptZh);
    assert.deepEqual(restored.h3IdentityBindingsEn, source.h3IdentityBindingsEn);
  });
  group(() => {
    const project = makeIdentityRepairProject();
    const source = project.storyboards[1];
    assert.throws(() => commitH3IdentityRepair(project, source.id, { zh: identityRepairResultFor(source, 'zh') }), /同时修复当前英文/u);
    const result = identityRepairResultFor(source, 'en');
    result.prompt = result.prompt.replace('阿沐', '另一人物');
    assert.throws(() => commitH3IdentityRepair(project, source.id, { en: result }), /原正文/u);
    result.edits[0].start = -1;
    assert.throws(() => commitH3IdentityRepair(project, source.id, { en: result }), /位置/u);
  });
  group(() => {
    const project = makeIdentityRepairProject();
    const source = project.storyboards[1];
    source.officialPromptEn = identityRepairResultFor(source, 'en').prompt;
    source.englishPrompt = source.officialPromptEn;
    const result = identityRepairResultFor(source, 'en', false);
    const next = commitH3IdentityRepair(project, source.id, { en: result });
    assert.equal(next.storyboards[1].officialPromptZh, source.officialPromptZh);
    assert.equal(next.storyboards[1].officialPromptEn, source.officialPromptEn);
    assert.deepEqual(next.storyboards[1].h3IdentityBindings, source.h3IdentityBindings);
    assert.equal(next.storyboards[1].h3IdentityBindingsEn!.characters[0].referenceAnchor, 'Identity: 阿沐.');
    assert.deepEqual(next.storyboards[2], project.storyboards[2], 'metadata-only repair never re-seals following provenance');
    assert.equal(commitH3IdentityRepair(next, source.id, { en: { ...result, changed: false } }), next);
  });
  group(() => {
    const project = makeIdentityRepairProject();
    const source = project.storyboards[1];
    assert.equal(getSequencePromptHandoffStatus(source, project).kind, 'current');
    assert.equal(getSequencePromptHandoffStatus(project.storyboards[2], project).kind, 'current');
    const next = commitH3IdentityRepair(project, source.id, { zh: identityRepairResultFor(source, 'zh'), en: identityRepairResultFor(source, 'en') });
    assert.equal(getSequencePromptHandoffStatus(next.storyboards[1], next).kind, 'current');
    assert.equal(getSequencePromptHandoffStatus(next.storyboards[2], next).kind, 'current');
    assert.notDeepEqual(next.storyboards[2].sequencePromptHandoff, project.storyboards[2].sequencePromptHandoff);
    assert.equal(next.storyboards[2].officialPromptZh, project.storyboards[2].officialPromptZh);
  });
  group(() => {
    const project = makeIdentityRepairProject();
    project.storyboards[1].sequencePromptHandoff!.sourceFingerprint = 'previously-stale';
    project.storyboards[2].sequencePromptHandoff!.sourceFingerprint = 'also-previously-stale';
    const source = project.storyboards[1];
    const next = commitH3IdentityRepair(project, source.id, { zh: identityRepairResultFor(source, 'zh'), en: identityRepairResultFor(source, 'en') });
    assert.equal(getSequencePromptHandoffStatus(next.storyboards[1], next).kind, 'stale');
    assert.equal(getSequencePromptHandoffStatus(next.storyboards[2], next).kind, 'stale');
    assert.deepEqual(next.storyboards[1].sequencePromptHandoff, source.sequencePromptHandoff);
    assert.deepEqual(next.storyboards[2].sequencePromptHandoff, project.storyboards[2].sequencePromptHandoff);
  });
  group(() => {
    const project = makeIdentityRepairProject();
    const source = project.storyboards[1];
    source.officialPromptEnSource = 'already-stale';
    assert.throws(() => commitH3IdentityRepair(project, source.id, { en: identityRepairResultFor(source, 'en') }), /英文提示词已变化/u);
    const next = commitH3IdentityRepair(project, source.id, { zh: identityRepairResultFor(source, 'zh') });
    assert.equal(next.storyboards[1].officialPromptEn, source.officialPromptEn, 'stale English is retained, never falsely certified');
    assert.equal(hasCurrentOfficialH3EnglishPrompt(next.storyboards[1], officialH3ContextForStoryboard(next, next.storyboards[1])), false);
    source.finalPrompt += ' changed';
    assert.throws(() => commitH3IdentityRepair(project, source.id, { zh: identityRepairResultFor(source, 'zh') }), /中文提示词已变化/u);
  });
  console.log(`h3IdentityRepairCommit: ${groups} groups passed`);
};

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/h3IdentityRepairCommit.test.ts')) run();
