import assert from 'node:assert/strict';
import { regenerateSequenceReferencePrompt } from '../src/sequenceReferencePrompt';
import type { ConverterPreset, Storyboard, VideoSegment, VideoSequencePlan, VideoShot } from '../src/types';

const currentStory = '陈舟在老槐树下等候。许宁走在林月前面，两人沿碎石路向他走去。许宁先看见他，在数步外停下并笑开。';
const nextStory = '许宁叫住陈舟。陈舟闻声转身，唤两人过来。';
const shotPrompt = (index: number, camera: string, action: string, space: string, direction: string) => [
  `【${[0, 5, 11][index]}s-${[5, 11, 15][index]}s】 主体：@许宁、@林月、@陈舟（安静）正在 [${action}]（建立相遇关系）`,
  `空间：${space}`,
  '光影：薄雾晨光',
  `镜头：${camera}`,
  '台词：无',
  '音效：环境层-[轻风] 动作层-[碎石脚步] 情绪层-[无配乐]',
  `方向：${direction}`,
].join('；');
const oldCameras = [
  '固定中景，机位在行进方向侧前方，人物面向镜头，陈舟在画面深处',
  '固定中景，机位在行进方向侧前方，人物面向镜头，陈舟在画面深处',
  '固定近中景，机位在两人侧前方，看见许宁的脸，陈舟在画面深处槐树下',
];
const oldActions = [
  '陈舟在槐树下等候',
  '许宁和林月沿碎石路走向陈舟',
  '许宁停下并笑开',
];
const oldSpaces = [
  '槐树在路边，陈舟在树下',
  '许宁领先，林月在她侧后半步，两人沿路走向槐树',
  '两人停在离陈舟数步的路上，槐树与陈舟在前方',
];
const oldDirections = [
  '陈舟面向宿舍方向，目光看向来路',
  '许宁与林月朝槐树方向行走',
  '许宁面朝陈舟，目光落在他身上；林月随许宁停下',
];
const canonical = (cameras: string[]) => [0, 1, 2].map((index) => shotPrompt(
  index, cameras[index], oldActions[index], oldSpaces[index], oldDirections[index],
)).join('\n');
const fixedCamera = [
  '固定中景，从小路侧面看陈舟在槐树下等候',
  '固定中景，从路侧观察两人沿路走近，陈舟仍在树下前方',
  '固定近中景，从陈舟肩旁稍偏侧拍，许宁停在数步外看向他的脸，陈舟肩缘留在画面左侧',
];
const fixedCanonical = canonical(fixedCamera)
  .replace('许宁停下并笑开', '许宁认出陈舟后停下并笑开')
  .replace('两人停在离陈舟数步的路上，槐树与陈舟在前方', '许宁停在陈舟数步外，林月仍在她侧后半步')
  .replace('许宁面朝陈舟，目光落在他身上；林月随许宁停下',
    '许宁面朝陈舟，目光落在他身上；林月在许宁侧后半步停下');

const shots: VideoShot[] = oldCameras.map((camera, index) => ({
  id: `meeting-shot-${index + 1}`,
  index: index + 1,
  startSec: [0, 5, 11][index],
  endSec: [5, 11, 15][index],
  subject: '许宁、林月、陈舟',
  action: oldActions[index],
  purpose: '推进本段相遇',
  camera,
  lighting: '薄雾晨光',
  sound: '轻风和碎石脚步',
  result: '沿当前场面继续',
  transition: '同一场面切镜',
  space: oldSpaces[index],
  direction: oldDirections[index],
  dialogue: '无',
  performance: '',
  referenceAssetIds: [],
  locked: false,
  prompt: shotPrompt(index, camera, oldActions[index], oldSpaces[index], oldDirections[index]),
  sourceExcerpt: currentStory,
}));
const board: Storyboard = {
  id: 'meeting-board',
  sceneId: 'locust-tree',
  sourceStoryTitle: '路口等候与走近',
  sourceStoryContent: currentStory + nextStory,
  workflow: 'drama',
  inputMode: 'text_reference',
  durationSec: 15,
  durationPreset: '15s',
  shotMode: 'exact',
  shotCount: 3,
  pace: 'standard',
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  stylePresetId: 'cinema',
  ruleSetId: '',
  converterPresetId: 'meeting-converter',
  globalLock: '',
  shots,
  finalPrompt: canonical(oldCameras),
  createdAt: 1,
  updatedAt: 1,
};
const currentSegment: VideoSegment = {
  id: 'meeting-current',
  index: 1,
  title: '路口等候与走近',
  globalStartSec: 0,
  globalEndSec: 15,
  durationSec: 15,
  content: currentStory,
  summary: '许宁先认出等候的陈舟并停步。',
  sourceSceneIds: ['locust-tree'],
  sourceBeatIds: [],
  narrativePurpose: '建立三人会面关系',
  entryState: '陈舟在槐树下等候',
  exitState: '许宁在数步外停下并笑开',
  transitionHint: '从许宁笑开、将要开口处接续',
  status: 'ready',
};
const nextSegment: VideoSegment = {
  id: 'meeting-next',
  index: 2,
  title: '叫住与交谈',
  globalStartSec: 15,
  globalEndSec: 30,
  durationSec: 15,
  content: nextStory,
  summary: '许宁叫住陈舟，陈舟转身并唤两人过来。',
  sourceSceneIds: ['locust-tree'],
  sourceBeatIds: [],
  narrativePurpose: '开启交谈',
  entryState: '许宁刚停步笑开',
  exitState: '陈舟唤两人靠近',
  transitionHint: '沿上一段停步状态开始',
  status: 'ready',
};
const plan: VideoSequencePlan = {
  id: 'meeting-plan',
  title: '槐树下相遇',
  sourceStoryTitle: '路口等候与走近',
  sourceStoryContent: currentStory + nextStory,
  durationMode: 'fixed',
  totalDurationSec: 30,
  segmentDurationSec: 15,
  segmentationMode: 'fixed',
  fitStatus: 'balanced',
  segments: [currentSegment, nextSegment],
  createdAt: 1,
  updatedAt: 1,
};
const converter: ConverterPreset = {
  id: 'meeting-converter',
  name: '测试转换器',
  workflow: 'all',
  inputMode: 'all',
  scope: 'video',
  enabled: true,
  version: 'test',
  systemPrompt: '按本段原文整理已有镜头。',
  outputRules: '保持镜数、时间边界及原话归属。',
  updatedAt: 1,
};
const stages: string[] = [];
const result = await regenerateSequenceReferencePrompt({
  board: {
    ...board,
    sequencePlanId: plan.id,
    segmentId: currentSegment.id,
    segmentIndex: 1,
    segmentCount: 2,
    globalStartSec: 0,
    globalEndSec: 15,
    durationSec: currentSegment.durationSec,
    promptPlan: {
      canonicalPrompt: board.finalPrompt,
      durationSec: 15,
      aspectRatio: '16:9',
      resolution: '2K',
      audioMode: 'stereo',
      workflow: 'drama',
      inputMode: 'text_reference',
      shotIds: shots.map((shot) => shot.id),
      referenceAssetIds: [],
      constraints: [],
      trace: { ruleSetId: '', converterId: converter.id },
    },
  },
  segment: currentSegment,
  mode: 'regenerate',
  context: { assets: [], characters: [] },
  converter,
  clean: (text) => text,
  reviewWithAi: true,
  request: async (_system, user, stage) => {
    stages.push(stage);
    if (stage === 'convert') {
      const data = JSON.parse(user.match(/<video_conversion_data>\s*([\s\S]*?)\s*<\/video_conversion_data>/u)![1]);
      assert.equal(data.sourceStoryContent, currentStory);
      assert.ok(!user.includes('老师？'));
      assert.ok(!user.includes('唤两人过来'));
      assert.equal(data.shotEvidence.length, 3);
      assert.match(data.shotEvidence[1].plannedSpace, /许宁领先，林月在她侧后半步/u);
      return fixedCanonical;
    }
    if (stage === 'review') {
      const data = JSON.parse(user.match(/<video_staging_review_data>\s*([\s\S]*?)\s*<\/video_staging_review_data>/u)![1]);
      assert.equal(data.sourceStoryContent, currentStory);
      assert.equal(data.adoptedVisualExpression[2].camera, fixedCamera[2]);
      assert.equal(data.shots[2].camera, fixedCamera[2]);
      assert.match(data.shots[2].space, /林月仍在她侧后半步/u);
      assert.match(data.shots[2].direction, /许宁面朝陈舟，目光落在他身上/u);
      assert.ok(!data.sourceStoryContent.includes('老师？'));
      assert.ok(!data.sourceStoryContent.includes('转身并唤两人'));
      return JSON.stringify({
        h3Prompt: [
          'integrated_multimodal_description:',
          '[Shot 1] 陈舟在槐树下等候。',
          '[Shot 2] At 00:05.000，许宁走在前面，林月在她侧后半步，两人沿路走向陈舟。',
          '[Shot 3] At 00:11.000，从陈舟肩旁稍偏侧拍。许宁停在数步外，目光落在陈舟脸上。林月在许宁侧后半步停下。',
          'overall_soundscape: 清晨轻风与碎石脚步声。',
          'non_diegetic_music: N/A',
        ].join('\n'),
        identityBindings: { version: 1, characters: [] },
      });
    }
    const translation = JSON.parse(user) as { slots: Array<{ id: string; sourceText: string }> };
    return JSON.stringify({
      slots: translation.slots.map((slot) => ({ id: slot.id, text: slot.sourceText
        .replace('从陈舟肩旁稍偏侧拍', 'filmed slightly to the side from over Chen Zhou’s shoulder')
        .replace('许宁停在数步外，目光落在陈舟脸上', 'Xu Ning stops several steps away, looking at Chen Zhou’s face')
        .replace('林月在许宁侧后半步停下', 'Lin Yue stops half a step behind Xu Ning') })),
    });
  },
});

assert.deepEqual(stages, ['convert', 'review', 'translate']);
assert.equal(result.shots[2].camera, fixedCamera[2]);
assert.ok(result.officialPromptZh?.includes('从陈舟肩旁稍偏侧拍'));
assert.ok(result.officialPromptEn?.includes('over Chen Zhou’s shoulder'));
assert.ok(!result.officialPromptZh?.includes('老师？'));
assert.ok(!result.officialPromptEn?.includes('老师？'));
assert.match(result.shots[2].space || '', /林月仍在她侧后半步/u);
assert.match(result.shots[2].direction || '', /许宁面朝陈舟，目光落在他身上/u);
console.log('H3 eyeline and blocking regression passed.');
