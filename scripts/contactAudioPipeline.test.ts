import assert from 'node:assert/strict';
import { AUDIO_PROMPT_RULE, AUDIO_TRANSLATION_SCOPE_RULE, NATURAL_ACTION_AUDIO_RULE } from '../src/audioPromptPolicy';
import { ADOPTED_VIDEO_EXPRESSION_RULE, VIDEO_CREATIVE_DIRECTION_DATA_RULE } from '../src/videoCreativeDirection';
import { VIDEO_ACTION_CHOREOGRAPHY_RULE } from '../src/videoActionChoreographyRules';
import { requestShotRecommendation } from '../src/services/llm';
import { generateSingleSegmentPrompt } from '../src/singleSegmentPrompt';
import { buildOfficialSeedanceInput } from '../src/seedanceSource';
import { generateOfficialSeedancePrompt } from '../src/seedancePrompt';
import { createInitialState } from '../src/storage';
import { createSeedanceTranslationResponse } from './seedanceTranslationTestUtils';
import type { AiStoryboardShotPlan, ConverterPreset, Project, ReferenceAsset, Storyboard, TextApiConfig, VideoShot } from '../src/types';

// Offline request transport and preservation checks. A model double cannot
// establish how a video model will sound or move.
const source = '甲乙把刀剑放在阶旁，空手连交三拳两脚，格挡落在包着衣袖的前臂。'
  + '收势后，两人走回石阶旁，各自拿回刀剑检查，再并肩坐下。';
const style = '写实武侠；兵刃碰撞有层次，兵器金属冷反光。';
const contact = '衣袖包裹的前臂接触时短促闷响，布鞋踏砖与衣料摩擦随动作发生和结束。';
const handling = '走回石阶时布鞋踏砖，拿回刀剑时手指握紧缠布柄的轻微摩擦；检查和坐下不另添碰响。';
const shotPlans: AiStoryboardShotPlan[] = [
  { startSec: 0, endSec: 9, subject: '甲、乙', action: '甲乙空手连交三拳两脚，格挡落在包着衣袖的前臂。',
    sourceExcerpt: source.slice(0, source.indexOf('收势')), purpose: '连续空手交手', camera: '同侧稳定全身双人景',
    transition: '开场承接空手状态', lighting: '暮色自然光', sound: contact, result: '双方开始收势',
    space: '两人站在庭院内，刀剑静置阶旁', direction: '双方互相面对', performance: '招来即应', dialogue: '无' },
  { startSec: 9, endSec: 15, subject: '甲、乙', action: '收势后走回石阶旁，各自拿回刀剑检查，再并肩坐下。',
    sourceExcerpt: source.slice(source.indexOf('收势')), purpose: '收势并取回道具坐下', camera: '同侧全身景随人移向石阶',
    transition: '接收势后的行进', lighting: '暮色自然光', sound: handling, result: '各自握着武器坐在阶上',
    space: '人物走到近旁石阶', direction: '面向石阶后并肩坐下', performance: '走完再取物坐下', dialogue: '无' },
];
const canonical = shotPlans.map((shot) => `【${shot.startSec}s-${shot.endSec}s】主体：@甲、@乙 正在 [${shot.action}]；`
  + `空间：${shot.space}；光影：${shot.lighting}；镜头：${shot.camera}；台词：无；音效：${shot.sound}`).join('\n');
const shots: VideoShot[] = shotPlans.map((shot, i) => ({ ...shot, id: `shot-${i}`, index: i + 1, locked: false,
  referenceAssetIds: ['armed-sheet'], prompt: canonical.split('\n')[i], authoredBy: 'text-api' }));
const asset: ReferenceAsset = { id: 'armed-sheet', name: '持剑人物外观参考', type: 'reference', source: 'upload',
  role: 'composition', referenceRole: 'composition', mediaType: 'image', visualAnchor: '用于衣着外观；持剑静态姿势。',
  dataUrl: 'data:image/png;base64,AA==', tags: [], createdAt: 1, updatedAt: 1 };
const board: Storyboard = { id: 'contact-board', sceneId: 'courtyard', sourceStoryContent: source,
  workflow: 'drama', inputMode: 'text_reference', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 2,
  pace: 'standard', aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo', stylePresetId: '',
  ruleSetId: '', globalLock: '', globalReferenceAssetIds: [asset.id], directorStyleSummary: style,
  shots, finalPrompt: canonical, createdAt: 1, updatedAt: 1 };
const project: Project = { ...createInitialState().project, characters: [], locations: [], props: [],
  scenes: [], storyboards: [board], assets: [asset], sequencePlans: [] };
const context = { characters: [], assets: [asset], locations: [], props: [] };
const converter: ConverterPreset = { id: 'contact-converter', name: '测试转换器', workflow: 'all', inputMode: 'all',
  scope: 'video', systemPrompt: '表达已规划的动作与声音。', outputRules: '保持原动作与次数。',
  enabled: true, version: 'test', updatedAt: 1 };
const h3 = [
  'subject_definitions:\n甲乙沿用<Picture 1>的衣着外观，当前空手交手。',
  'summary:\n空手交手后取回道具坐下。',
  'retention_analysis:\n<Picture 1>仅提供衣着外观，手中状态按当前事件。',
  'detailed_description:\n[Shot 1] 甲乙空手连交三拳两脚，衣袖包裹的前臂相接。' + contact
    + '\n\n[Shot 2] At 00:09.000 收势后两人走回石阶，握住缠布柄各自拿回刀剑检查，再并肩坐下。' + handling,
  'overall_soundscape:\n同期声音贴合当前动作与听觉距离，间隙安静。',
  'non_diegetic_music:\nN/A',
].join('\n\n');
const seedance = [
  '视频规格：时长15秒；画面比例16:9；分辨率720p；声音stereo。',
  '参考素材与职责：\n@Image 1：衣着外观，保持当前空手状态。',
  '主体连续性：\n甲乙维持原衣着。',
  '一句话概述：\n甲乙空手交手后取回刀剑坐下。',
  `连续时间轴：\n${canonical.replaceAll('@甲', '甲').replaceAll('@乙', '乙')}`,
  '全局约束：\n同期声音贴合各自事件与距离，间隙安静，无配乐。',
].join('\n\n');
const block = (user: string, tag: string): Record<string, any> =>
  JSON.parse(user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'))![1]);
const before = JSON.stringify({ board, project, shotPlans });
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let checks = 0;
try {
  assert.match(VIDEO_ACTION_CHOREOGRAPHY_RULE, /实际步幅与运动路径/u);
  assert.match(VIDEO_ACTION_CHOREOGRAPHY_RULE, /不得写15–15秒、0秒动作/u);
  assert.match(VIDEO_ACTION_CHOREOGRAPHY_RULE, /不等于每个动作各占一段或一镜/u);
  assert.match(VIDEO_ACTION_CHOREOGRAPHY_RULE, /进入固定durationSec、exact镜数、当前段事件归属或已确认排程后，不继承这项加长权限/u);
  assert.match(VIDEO_CREATIVE_DIRECTION_DATA_RULE, /兵刃碰撞只在当前来源明确发生兵刃接触时应用/u);
  assert.match(VIDEO_CREATIVE_DIRECTION_DATA_RULE, /参考图里的持械姿势、武器展示和金属外观不授权补持械动作、兵刃接触、金属声或展示镜头/u);
  assert.match(ADOPTED_VIDEO_EXPRESSION_RULE, /声音同样只保真源头已经采用的声音对象和实际接触材质/u);
  checks++;
  globalThis.fetch = async () => { throw new Error('No real network in contact audio tests'); };
  const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://contact.invalid/v1',
    apiKey: 'offline', model: 'offline', temperature: 0, maxTokens: 8192, vision: false };
  const captured: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { lianhuaDesktop: {
    request: async ({ body }: { body?: string }) => {
      const request = JSON.parse(body!);
      const system = request.messages.find((message: any) => message.role === 'system').content;
      const user = request.messages.find((message: any) => message.role === 'user').content;
      captured.push(system);
      assert.ok(system.includes(NATURAL_ACTION_AUDIO_RULE));
      assert.ok(system.includes(VIDEO_CREATIVE_DIRECTION_DATA_RULE));
      assert.equal(block(user, captured.length === 1 ? 'storyboard_planning_data' : 'storyboard_ai_review_data').sourceStory, source);
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        reason: '连续交手与实际收尾共两镜', breakdown: ['完整保留交手次数和取物坐下'], shots: shotPlans,
      }) } }] }) };
    },
  } } });
  const planned = await requestShotRecommendation(config, { story: source, durationSec: 15, workflow: 'drama',
    pace: 'standard', directorStyle: { summary: style } }, { reviewWithAi: true });
  assert.equal(captured.length, 2, 'only the existing plan and review calls; no sound audit or retry');
  assert.deepEqual(planned.shots, shotPlans, 'the AI response is not locally rewritten or stripped of handling actions');
  checks++;

  for (const targetPromptFormat of ['h3', 'seedance'] as const) {
    const stages: string[] = [];
    const result = await generateSingleSegmentPrompt({ board, context, converter, reviewWithAi: true,
      targetPromptFormat, buildSeedanceInput: (current) => buildOfficialSeedanceInput(project, current),
      clean: (value) => value, hasImageInputs: true,
      request: async (system, user, stage) => {
        stages.push(stage);
        if (stage !== 'translate') {
          if (stage === 'convert' || targetPromptFormat === 'h3') {
            assert.ok(system.includes(AUDIO_PROMPT_RULE), `${targetPromptFormat} ${stage} receives current sound-source policy`);
          } else {
            assert.match(system, /拟音保真传递源稿中对应动作、发声对象、接触双方材质/u,
              'Seedance writer preserves adopted contact sources rather than selecting new sound');
            assert.match(system, /一次性声音及其具体材质和时刻只留在连续时间轴/u);
          }
          if (stage === 'convert') {
            const data = block(user, 'video_conversion_data');
            assert.equal(data.sourceStoryContent, source);
            assert.deepEqual(data.shotEvidence.map((shot: any) => shot.plannedSound), [contact, handling]);
            return canonical;
          }
          if (targetPromptFormat === 'seedance') return seedance;
          return JSON.stringify({ h3Prompt: h3, canonicalPrompt: canonical,
            shotSourceIds: shots.map((shot) => [shot.id]), shotMetadata: [null, null] });
        }
        assert.ok(!system.includes(NATURAL_ACTION_AUDIO_RULE), 'translation may not redesign sound from the novel or references');
        if (targetPromptFormat === 'seedance') {
          assert.ok(system.includes('sourcePrompt'));
          assert.equal(JSON.parse(user).sourcePrompt, seedance);
          return createSeedanceTranslationResponse(user, ({ sourceText }) => sourceText);
        }
        assert.ok(system.includes(AUDIO_TRANSLATION_SCOPE_RULE));
        const data = JSON.parse(user);
        assert.equal(data.sourcePrompt, h3);
        return JSON.stringify({ slots: data.slots.map((slot: { id: string; sourceText: string }) =>
          ({ id: slot.id, text: slot.sourceText })) });
      },
    });
    assert.deepEqual(stages, ['convert', 'review', 'translate']);
    assert.equal(result.durationSec, 15);
    assert.equal(result.finalPrompt, canonical);
    assert.deepEqual(result.shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.sound]),
      shots.map((shot) => [shot.id, shot.startSec, shot.endSec, shot.sound]));
    assert.deepEqual(result.globalReferenceAssetIds, [asset.id], 'the held-weapon image stays selected, not removed by a keyword filter');
    if (targetPromptFormat === 'h3') {
      assert.equal(result.officialPromptZh, h3);
      assert.equal(result.officialPromptEnError, '');
      assert.equal(result.officialPromptEn, h3, 'description-slot echo demonstrates lossless transport, not English quality');
    } else {
      assert.equal(result.seedance25Output?.promptZh, seedance);
      assert.equal(result.seedance25Output?.englishError, '');
      assert.ok(result.seedance25Output?.promptEn?.includes(handling), 'slot assembly preserves returned sound descriptions and their event window');
    }
    checks++;
  }
  // The direct Seedance entry in App does not pass through the single-segment
  // wrapper. Its own writer must receive the scope without another request.
  const directInput = buildOfficialSeedanceInput(project, board);
  const directBefore = JSON.stringify(directInput);
  let directCalls = 0;
  const direct = await generateOfficialSeedancePrompt({ input: directInput, request: async (system, user) => {
    directCalls++;
    assert.match(system, /接触双方材质、力度与起止关系/u);
    assert.match(system, /源稿真实发生的金属接触仍按原事件保留/u);
    assert.match(system, /一次性声音及其具体材质和时刻只留在连续时间轴/u);
    assert.equal(block(user, 'seedance_source_data').canonicalPrompt, canonical);
    return seedance;
  } });
  assert.equal(directCalls, 1);
  assert.equal(direct.promptZh, seedance);
  assert.equal(JSON.stringify(directInput), directBefore);
  checks++;
  assert.equal(JSON.stringify({ board, project, shotPlans }), before, 'no mutation of existing sources, references or plans');
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}
console.log(`Contact audio pipeline: ${checks} offline cases passed`);
