import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import { buildOfficialH3SourceFingerprint } from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { buildOfficialSeedanceInput } from '../src/seedanceSource';
import { getOfficialSeedanceSourceFingerprint } from '../src/seedancePrompt';
import { masterPromptConfirmationFingerprint } from '../src/masterTimeline';
import { sequencePlanReviewFingerprint } from '../src/sequencePlan';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { AppState, Storyboard, VideoSequencePlan } from '../src/types';

// The production smoke test installs only this synthetic state in a fresh
// browser context. No existing project, API credential or real media is read.
export const createPromptResultMoreFixture = (): { state: AppState; texts: Record<'h3' | 'seedance' | 'ordinary', Record<'zh' | 'en', string[]>> } => {
  const state = createInitialState(); const now = 1780963200000;
  const chapterId = 'prompt-more-chapter'; const sceneId = 'prompt-more-scene';
  const story = '两名成年训练者沿山道行走。第一段走到石阶前，第二段沿石阶继续前行。';
  const texts = {
    ordinary: { zh: [1, 2].map((index) => `【0s-15s】主体：成年训练者甲乙；动作：普通中文第${index}段，两人沿山道连续行走；空间：石阶山道；光影：晨光；镜头：稳定中景；台词：无；音效：无。`),
      en: [1, 2].map((index) => `【0s-15s】Adult trainees A and B walk along the mountain path. Ordinary English segment ${index}; a steady medium shot under morning light. No dialogue or soundtrack.`) },
    h3: { zh: [1, 2].map((index) => `integrated_multimodal_description: [Shot 1] H3中文第${index}段，两名成年训练者沿石阶山道继续行走，稳定中景保留双方步伐。\noverall_soundscape: N/A\nnon_diegetic_music: N/A`),
      en: [1, 2].map((index) => `integrated_multimodal_description: [Shot 1] H3 English segment ${index}. Two adult trainees keep walking along the mountain steps, with their footwork visible in a steady medium shot.\noverall_soundscape: N/A\nnon_diegetic_music: N/A`) },
    seedance: { zh: [1, 2].map((index) => `视频规格：时长15秒；16:9；2K。\n参考素材与职责：没有外部参考。\n主体连续性：两名成年训练者保持服装和行走方向。\n一句话概述：Seedance中文第${index}段，两人沿山道行走。\n连续时间轴（覆盖0–15秒）：\n【0s-15s】两人沿石阶连续向前行走，镜头保留脚步。\n全局约束：保持身份和环境连续。`),
      en: [1, 2].map((index) => `Video specification: 15 seconds; 16:9; 2K.\nReferences and responsibilities: no external reference.\nSubject continuity: both adult trainees keep the same clothes and direction.\nOne-sentence summary: Seedance English segment ${index}, two trainees walk along the path.\nContinuous timeline (covering 0–15 seconds):\n【0s-15s】Both keep walking up the steps with footwork visible.\nGlobal constraints: keep identities and environment continuous.`) },
  };
  const boards: Storyboard[] = [1, 2].map((index) => {
    const finalPrompt = texts.ordinary.zh[index - 1];
    return { id: `prompt-more-board-${index}`, chapterId, sceneId,
      sourceStoryTitle: `山道第${index}段`, sourceStoryContent: story,
      workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1, pace: 'standard',
      aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: state.settings.defaultStylePresetId,
      ruleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', targetModelId: 'minimax-h3',
      globalLock: '两名成年训练者保持服装与行走方向。', finalPrompt,
      englishPrompt: texts.ordinary.en[index - 1], englishPromptSource: finalPrompt,
      officialPromptZh: texts.h3.zh[index - 1], officialPromptEn: texts.h3.en[index - 1], officialPromptEnSource: texts.h3.zh[index - 1],
      targetOutput: { targetId: 'minimax-h3', prompt: texts.h3.zh[index - 1], parameters: {}, referenceManifest: [], warnings: [], generatedAt: now },
      shots: [{ id: `prompt-more-shot-${index}`, index: 1, startSec: 0, endSec: 15, purpose: '山道前行', subject: '甲乙',
        action: '沿石阶连续行走', camera: '稳定中景', lighting: '晨光', sound: '', transition: '连续', result: '继续前行',
        referenceAssetIds: [], prompt: finalPrompt, locked: false, authoredBy: 'text-api' }],
      promptTrace: { mode: 'text-api', convertedPromptFingerprint: sourceContentHash(finalPrompt), shotPlanMode: 'ai-complete',
        modelRuleSetId: state.settings.defaultRuleSetId, converterPresetId: 'converter_unified_video', sourceDocumentIds: [chapterId], referenceAssetIds: [], generatedAt: now },
      sequencePlanId: 'prompt-more-plan', segmentId: `prompt-more-segment-${index}`, segmentIndex: index, segmentCount: 2,
      createdAt: now, updatedAt: now + index };
  });
  const master: Storyboard = { ...boards[0], id: 'prompt-more-master', segmentId: undefined, segmentIndex: undefined, segmentCount: undefined,
    durationSec: 30, durationPreset: 'custom', shotCount: 2, finalPrompt: boards.map((board) => board.finalPrompt).join('\n'),
    shots: boards.flatMap((board, index) => board.shots.map((shot) => ({ ...shot, index: index + 1, startSec: index * 15, endSec: (index + 1) * 15 }))),
    officialPromptZh: undefined, officialPromptEn: undefined, officialPromptEnSource: undefined, targetOutput: undefined };
  const plan: VideoSequencePlan = { id: 'prompt-more-plan', chapterId, title: '山道两段隔离验收', sourceStoryTitle: '山道行走', sourceStoryContent: story,
    durationMode: 'fixed', totalDurationSec: 30, segmentDurationSec: 15, segmentationMode: 'fixed', fitStatus: 'balanced', planningStage: 'segmented',
    masterStoryboardId: master.id, masterPromptConfirmedAt: now, reviewConfirmedAt: now,
    segments: boards.map((board, index) => ({ id: board.segmentId!, index: index + 1, title: board.sourceStoryTitle!,
      globalStartSec: index * 15, globalEndSec: (index + 1) * 15, durationSec: 15, content: story, summary: '山道行走',
      sourceSceneIds: [sceneId], sourceBeatIds: [], sourceShotIds: [master.shots[index].id], narrativePurpose: '前行',
      entryState: '正在行走', exitState: '继续前行', transitionHint: '连续', storyboardId: board.id, status: 'ready' })),
    createdAt: now, updatedAt: now };
  plan.masterPromptConfirmedFingerprint = masterPromptConfirmationFingerprint(plan, master);
  plan.reviewConfirmedFingerprint = sequencePlanReviewFingerprint(plan);
  const project = { ...state.project, id: 'prompt-more-project', name: '更多与导出隔离验收', activeChapterId: chapterId, chapterWorkspaces: {},
    sourceDocuments: [{ id: chapterId, name: '山道行走', content: story, createdAt: now, updatedAt: now }],
    scenes: [{ id: sceneId, chapterId, title: '山道行走', content: story, summary: story, characterIds: [], locationIds: [], propIds: [], storyboardIds: [...boards, master].map((board) => board.id), createdAt: now, updatedAt: now }],
    characters: [], locations: [], props: [], assets: [], storyboards: [...boards, master], sequencePlans: [plan], generationTasks: [], createdAt: now, updatedAt: now };
  for (const board of boards) {
    board.officialPromptSource = buildOfficialH3SourceFingerprint(board, officialH3ContextForStoryboard(project, board));
    const sourceFingerprint = getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project, board));
    board.seedance25Output = { targetId: 'seedance-2.5', promptZh: texts.seedance.zh[board.segmentIndex! - 1],
      promptEn: texts.seedance.en[board.segmentIndex! - 1], durationSec: 15, sourceFingerprint, englishSourceFingerprint: sourceFingerprint,
      referenceManifest: [], warnings: [], generatedAt: now };
  }
  state.project = project; state.projects = [project]; state.activeProjectId = project.id;
  for (const name of ['textApi', 'imageApi', 'visionApi', 'videoTaskApi'] as const) { state.settings[name].enabled = false; state.settings[name].apiKey = ''; }
  state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
  state.settings.runningHubVideo.enabled = false; state.settings.runningHubVideo.apiKey = '';
  state.settings.videoSource = 'api'; state.settings.videoBackend = 'api'; state.settings.uiFontScalePercent = 100;
  return { state: normalizeState(JSON.parse(serializeStateForStorage(state).serialized)), texts };
};

if (process.argv.includes('--emit')) process.stdout.write(JSON.stringify(createPromptResultMoreFixture()));
