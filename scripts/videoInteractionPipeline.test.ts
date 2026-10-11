import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { buildVideoSceneContext } from '../src/videoSceneContext';
import { requestSemanticSequencePlan } from '../src/services/semanticSequencePlanner';
import { semanticSegmentSourceContext } from '../src/semanticSequencePlan';
import { requestShotRecommendation } from '../src/services/llm';
import { generateSingleSegmentPrompt } from '../src/singleSegmentPrompt';
import { generateSeedanceBilingualOutput, getOfficialSeedanceSourceFingerprint } from '../src/seedancePrompt';
import { buildOfficialSeedanceInput } from '../src/seedanceSource';
import { VIDEO_INTERACTION_RULES, VIDEO_INTERACTION_TRANSLATION_RULE } from '../src/videoInteractionRules';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';
import type { ConverterPreset, Location, ReferenceAsset, Scene, Storyboard, TextApiConfig } from '../src/types';

// Authored replies verify request transport and permissions, not video quality.
// No user project or live model/video API is read or modified by this test.
const storyParts = [
  '绝死绝命追赶向后退入走廊的马雷，镰刀贴地斩向他的小腿；马雷继续退步并下压木杖，挡开镰刃至她的右侧，仍注视她的武器。',
  '绝死绝命借镰刃被拨开的余势追上仍在后退的马雷，转动躯干将镰刃横斩向他的肩侧；马雷把木杖抬至胸前挡住，两人兵刃接触后仍相向保持一步外。绝死绝命说：“停下！”马雷始终没有发话。',
];
const story = storyParts.join('');
const scene: Scene = { id: 'corridor-scene', title: '追入回廊', content: story, summary: '', characterIds: [],
  locationIds: ['corridor'], propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 };
const location: Location = { id: 'corridor', name: '寝殿外回廊', description: '狭长通道连接寝殿门槛，柱间仅留两人交错的通行区域。',
  fixedProps: '门槛与右侧石柱', anchor: '破损寝殿门位于通道起点', lighting: '门外侧光', timeWeather: '白天', palette: '灰色石材', assetIds: [] };
const sceneAsset: ReferenceAsset = { id: 'scene-image', name: '回廊构图', type: 'reference', mediaType: 'image', role: 'scene',
  sourceEntityKind: 'location', sourceEntityId: 'corridor', visualAnchor: '门槛、石柱与可通行区域',
  dataUrl: 'data:image/png;base64,SYNTHETIC_MEDIA_BYTES', prompt: 'PRIVATE_OLD_PROMPT',
  tags: [], createdAt: 1, updatedAt: 1 };
const frame: ReferenceAsset = { id: 'entry-frame', name: '前段视频末端', type: 'reference', mediaType: 'image', role: 'first-frame',
  sourceVideoAssetId: 'previous-video', sourceTimeSec: 14.875, imageFrameTimeSec: 14.875,
  dataUrl: 'data:image/png;base64,PRIVATE_FRAME_BYTES', tags: [], createdAt: 1, updatedAt: 1 };
const sourceObjects = { locations: [location, { ...location, id: 'unrelated', name: '不相干的广场' }], scenes: [scene], assets: [sceneAsset, frame] };
const sourceBefore = structuredClone(sourceObjects);
const sceneContext = buildVideoSceneContext({ ...sourceObjects, sourceSceneIds: [scene.id], selectedAssetIds: [sceneAsset.id, frame.id] });
assert.equal(sceneContext.locationSelection, 'linked-locations');
assert.deepEqual(sceneContext.locations.map((item) => item.id), ['corridor']);
assert.equal(sceneContext.references.find((item) => item.id === frame.id)?.sourceTimeSec, 14.875);
assert.doesNotMatch(JSON.stringify(sceneContext), /PRIVATE_|SYNTHETIC_MEDIA_BYTES|dataUrl|PRIVATE_OLD_PROMPT/);
assert.deepEqual(sourceObjects, sourceBefore, 'building a public scene request cannot mutate source assets or places');

const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://interaction.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-key', model: 'synthetic-model', temperature: 0, maxTokens: 8192, vision: false };
const creativeDirection = { cameraTerms: [], lightingTerms: [], extraRequirement: '摄影机跟随攻防关系' };
const block = (user: string, tag: string): any => {
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `request contains ${tag}`); return JSON.parse(match[1]);
};
const planShots = [{ startSec: 0, endSec: 4, sourceExcerpt: storyParts[0], subject: '绝死绝命与马雷',
  action: '绝死绝命追赶后退的马雷并进入镰刃可及范围，镰刃贴地斩向马雷小腿；马雷继续退步，下压木杖挡开镰刃至绝死绝命右侧',
  space: '从寝殿门槛进入狭长回廊前段，马雷始终在绝死绝命前方且面向她，双方接触后继续保持一步外',
  direction: '绝死绝命沿回廊追向马雷，目光锁定其防守木杖；马雷面向绝死绝命，注视来袭镰刃并沿同一路径退步',
  performance: '马雷关注对手武器，没有发话', purpose: '第一击及持续退避',
  camera: '摄影机在双方交战轴的石柱一侧平移跟随，绝死绝命在画面左侧进攻，马雷在右侧退避，可见双方侧脸与接触点',
  lighting: '门外侧光', sound: '脚步与第一次兵器接触声', dialogue: '无',
  result: '镰刃被拨至绝死绝命右侧，木杖下压；马雷仍面向她后退，绝死绝命继续追进，双方保持一步外', transition: '从第一次挡击的真实末态接续第二击' },
{ startSec: 4, endSec: 8, sourceExcerpt: storyParts[1], subject: '绝死绝命与马雷',
  action: '从镰刃被拨至右侧的末态继续，绝死绝命借余势追上退步中的马雷，转动躯干横斩其肩侧；马雷从下压位置抬杖至胸前挡住，双方接触后卸力分开，绝死绝命发话',
  space: '沿同一回廊前段继续移动，绝死绝命追上马雷至武器可及距离；第二次接触后双方仍相向保持一步外',
  direction: '绝死绝命的身体与镰刃仍围绕前方具名对手马雷，马雷视线跟随她的镰刃，身体保持朝她的防守关系',
  performance: '马雷持续观察与防守，全程没有发话', purpose: '上一击的余势接下一击',
  camera: '摄影机留在交战轴石柱一侧随双方平移，保持绝死绝命左、马雷右的投影及两兵刃接触点，不为展示正脸移到攻击终点',
  lighting: '门外侧光', sound: '脚步与第二次兵器接触声', dialogue: '第2s–3s @绝死绝命：“停下！”',
  result: '兵刃接触后分开，绝死绝命持镰、马雷持杖且仍面向对方，双方在回廊中段保持一步外，无人倒地受伤', transition: '沿双方末态承接' }];
const shotTimes = planShots.map((shot) => [shot.startSec, shot.endSec]);
const oldWindow = globalThis.window; const oldFetch = globalThis.fetch;
let semanticCalls = 0; let planningCalls = 0;
try {
  globalThis.fetch = async () => { throw new Error('Real network is forbidden in this fixture'); };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async (payload: { body?: string }) => {
      const messages = JSON.parse(payload.body!).messages;
      const system: string = messages.find((item: any) => item.role === 'system').content;
      const user: string = messages.find((item: any) => item.role === 'user').content;
      let content: unknown;
      if (user.startsWith('semantic_sequence_input=')) {
        semanticCalls += 1;
        const data = JSON.parse(user.slice(user.indexOf('=') + 1));
        assert.deepEqual(data.sceneContext, sceneContext); assert.equal(data.story, story);
        assert.ok(system.includes('谁追赶谁'), 'semantic prose retains both roles before summarizing');
        content = { reason: '单次连续攻防', fitStatus: 'balanced', segments: [{ title: '追入回廊', content: story,
          summary: '绝死绝命追赶后退的马雷', narrativePurpose: '连续追击', entryState: '门槛前', exitState: '回廊中一步外',
          transitionHint: '延续动作', boundaryReason: '完整交锋', continuityPack: '马雷仍后退，绝死绝命追进',
          semanticSource: { sourceEvidence: [{ text: story }], events: [{ id: 'chase', description: '追赶与退避并连续攻防' }],
            dialogues: [{ id: 'line-1', speaker: '绝死绝命', text: '停下！', language: '中文' }] } }] };
      } else {
        planningCalls += 1;
        const data = block(user, 'storyboard_planning_data');
        assert.deepEqual(data.sceneContext, sceneContext); assert.equal(data.sourceStory, story);
        assert.equal(data.durationSec, 8); assert.equal(data.requiredShotCount, 2);
        assert.ok(system.includes(VIDEO_INTERACTION_RULES));
        content = { reason: '两次攻防沿同轴持续推进', shots: planShots };
      }
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }) };
    },
  } } });
  const semantic = await requestSemanticSequencePlan(config, { title: '回廊交锋', story, segmentDurationSec: 8,
    durationMode: 'fixed', requestedTotalDurationSec: 8, directorSettingsFingerprint: 'fixture', creativeDirection,
    characterContinuity: [], sourceSceneIds: [scene.id], shotMode: 'exact', shotCount: 2, sceneContext }, undefined, { planId: 'semantic-test', now: () => 1 });
  assert.equal(semanticCalls, 1, 'scene evidence adds no semantic audit call');
  const semanticBefore = structuredClone(semantic);
  const segment = semantic.segments[0];
  const scoped = semanticSegmentSourceContext(semantic, segment, sceneContext);
  assert.deepEqual(scoped.storyUnderstandingContext?.sceneContext, sceneContext);
  const edited = semanticSegmentSourceContext(semantic, { ...segment, content: '双方收起武器，无人讲话。', contentOverridden: true }, sceneContext);
  assert.equal(edited.generationStoryContent, '双方收起武器，无人讲话。', 'old dialogue evidence cannot restore a deleted line');
  assert.deepEqual(semantic, semanticBefore, 'request context is not a saved plan migration');
  const plan = await requestShotRecommendation(config, { durationSec: 8, story, workflow: 'action', pace: 'tight',
    requiredShotCount: 2, sceneContext }, { reviewWithAi: false });
  assert.equal(planningCalls, 1); assert.deepEqual(plan.shots, planShots);

  const canonicalShots = planShots.map((shot) => `【${shot.startSec}s-${shot.endSec}s】主体：@绝死绝命与马雷[朝向：${shot.direction}] 正在 [${shot.action}]（结果：${shot.result}）；空间：${shot.space}；光影：${shot.lighting}；镜头：${shot.camera}；台词：${shot.dialogue}；音效：${shot.sound}。`);
  const canonical = canonicalShots.join('\n');
  const board: Storyboard = { id: 'interaction-board', sceneId: scene.id, sourceStoryContent: story, workflow: 'action', inputMode: 'text',
    durationSec: 8, durationPreset: 'custom', shotMode: 'exact', shotCount: 2, pace: 'tight', aspectRatio: '16:9', resolution: '2K',
    audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: 'fixture', globalLock: '', finalPrompt: canonical,
    shots: planShots.map((shot, index) => ({ id: `interaction-shot-${index + 1}`, index: index + 1, ...shot,
      referenceAssetIds: [], prompt: canonicalShots[index], locked: false })),
    createdAt: 1, updatedAt: 1, targetModelId: 'minimax-h3', targetOutput: { targetId: 'minimax-h3', prompt: '',
      parameters: { seed: 99 }, referenceManifest: [], warnings: [], generatedAt: 1 } };
  const converter: ConverterPreset = { id: 'fixture', name: '合成转换器', scope: 'video', workflow: 'all', inputMode: 'all', enabled: true,
    version: 'test', systemPrompt: '依据当前剧情生成', outputRules: '六字段', updatedAt: 1 };
  const zh = `integrated_multimodal_description: [Shot 1] ${planShots[0].action}；${planShots[0].space}；${planShots[0].direction}；${planShots[0].camera}；退出关系：${planShots[0].result}。两人本镜无对白。\n[Shot 2] At 00:04.000, ${planShots[1].action}；${planShots[1].space}；${planShots[1].direction}；${planShots[1].camera}；退出关系：${planShots[1].result}。第6s (S1)说：<d>[Chinese] 停下！</d>马雷整个0–8秒没有发话。\noverall_soundscape: 脚步和两次兵器接触。\nnon_diegetic_music: N/A`;
  const en = 'integrated_multimodal_description: [Shot 1] Zesshi pursues the retreating Mare until he is within scythe reach. Her scythe sweeps toward his lower leg; he continues retreating and presses his wooden staff down to deflect the blade to her own right. Mare remains ahead of Zesshi and faces her. Her gaze stays on his staff, and his gaze tracks her blade. The camera follows from the pillar side of their combat axis, with Zesshi on screen-left and Mare on screen-right; the contact and both profiles remain visible. At the cut her blade is deflected to her right, his staff stays low, and both continue moving one step apart. Neither speaks.\n[Shot 2] At 00:04.000, Zesshi continues directly from the deflected blade position, carries that momentum into her next stride to reach Mare as he retreats, and rotates her torso to slash toward his shoulder. Mare raises his staff from the low position to his chest and blocks; they absorb the contact and separate. Both still face the actual opponent at one step apart, with their attention on the opposing weapon. The camera remains on the same pillar side and tracks them, preserving Zesshi on screen-left and Mare on screen-right. At 6 seconds (S1) says: <d>[Chinese] 停下！</d>Mare performs the defensive actions without speech throughout 0–8 seconds. They finish with weapons held and no injury or fall.\noverall_soundscape: Footsteps and the two weapon contacts.\nnon_diegetic_music: N/A';
  const envelope = (prompt: string) => JSON.stringify({ h3Prompt: prompt, identityBindings: { version: 1, characters: [] },
    characterParticipation: { version: 1, characters: [] }, canonicalPrompt: canonical,
    shotSourceIds: board.shots.map((shot) => [shot.id]), shotMetadata: board.shots.map(() => null) });
  const stages: string[] = []; let chineseSaved = false;
  const boardBefore = structuredClone(board);
  const generated = await generateSingleSegmentPrompt({ board, context: { assets: [], characters: [], locations: [location] },
    converter, sceneContext, sequenceSegmentContext: scoped, reviewWithAi: true, clean: (value) => value.trim(), now: () => 2,
    onQualifiedChinese: (saved) => { chineseSaved = true; assert.equal(saved.officialPromptZh, zh); },
    request: async (system, user, stage) => {
      stages.push(stage);
      if (stage === 'translate') {
        assert.ok(chineseSaved, 'Chinese checkpoint remains before translation');
        assert.ok(system.includes(VIDEO_INTERACTION_TRANSLATION_RULE));
        const translatedSource = user.includes('<review_data>') ? block(user, 'review_data').sourcePrompt
          : user.includes('<translation_identity_data>') ? block(user, 'translation_identity_data').sourcePrompt : user;
        assert.equal(translatedSource, zh, 'English uses the approved Chinese');
        return envelope(en);
      }
      assert.ok(system.includes(VIDEO_INTERACTION_RULES));
      assert.deepEqual(block(user, 'video_scene_context_data').sceneContext, sceneContext);
      if (stage === 'convert') {
        const data = block(user, 'video_conversion_data'); assert.ok(data.sourceStoryContent.startsWith(story));
        assert.deepEqual(data.shotEvidence.map((shot: any) => [shot.plannedSpace, shot.plannedDirection, shot.plannedResult]),
          planShots.map((shot) => [shot.space, shot.direction, shot.result]), 'conversion receives authored blocking, gaze and contact exit states without local inference');
        assert.deepEqual(data.shotEvidence.map((shot: any) => [shot.globalStartSec, shot.globalEndSec]), shotTimes);
        assert.equal(data.shotEvidence[1].previousShot.plannedResult, planShots[0].result,
          'the second attack receives the first deflection and continuing retreat as the real entry evidence');
        assert.equal(data.shotEvidence[0].nextShot.plannedDirection, planShots[1].direction);
        return canonical;
      }
      const data = block(user, 'video_staging_review_data');
      assert.equal(data.durationSec, 8); assert.equal(data.shotMode, 'exact'); assert.equal(data.shotCount, 2);
      assert.deepEqual(data.shots.map((shot: any) => [shot.startSec, shot.endSec]), shotTimes);
      return envelope(zh);
    } });
  assert.ok(!generated.officialPromptEnError, 'the English checkpoint remains usable');
  assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate'], 'new rules reuse existing generation stages');
  assert.equal(generated.officialPromptEn, en); assert.equal(generated.durationSec, 8);
  assert.equal(generated.shotCount, 2);
  assert.deepEqual(generated.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]), board.shots.map((shot) => [shot.id, shot.startSec, shot.endSec]));
  assert.deepEqual(readH3PromptProtocol(en), readH3PromptProtocol(zh), 'English preserves the approved two-shot cut and reference protocol');
  assert.equal(generated.targetOutput?.parameters.seed, 99);
  assert.equal(generated.targetOutput?.parameters.durationSec, 8);
  assert.deepEqual(board, boardBefore, 'generation never edits the original board in place');

  const seedanceInput = { targetId: 'seedance-2.5', durationSec: 8, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    canonicalPrompt: canonical, references: [], sourceEvidence: { story, shotMode: 'exact', shotCount: 2 }, sceneContext };
  assert.equal(getOfficialSeedanceSourceFingerprint(seedanceInput), getOfficialSeedanceSourceFingerprint({ ...seedanceInput, sceneContext: undefined }),
    'request-only scene data does not invalidate historical outputs');
  const seedanceZh = `视频规格：8秒；16:9；2K。\n参考素材与职责：无外部素材。\n主体连续性：两人沿同一回廊推进。\n一句话概述：绝死绝命连续追击后退的马雷。\n连续时间轴（覆盖0–8秒）：\n${canonical}\n全局约束：马雷始终观察与防守，无发话；两击从上一招真实末态继续。`;
  // Seedance retains its existing token-protected compatibility transport.
  // A literal round-trip isolates complete source delivery/restoration here;
  // the H3 fixture above exercises an authored English two-exchange reply.
  const seedanceProtectedValues: Record<string, string> = {
    __LH_ENTITY_001__: '@绝死绝命与马雷', __LH_ENTITY_002__: '绝死绝命与马雷',
    __LH_ENTITY_003__: '@绝死绝命', __LH_ENTITY_004__: '绝死绝命', __LH_DIALOGUE_001__: '“停下！”',
  };
  let seedanceCalls = 0; let seedanceSaved = '';
  const seeded = await generateSeedanceBilingualOutput({ input: seedanceInput,
    onChinese: (output) => { seedanceSaved = output.promptZh; return true; }, onEnglish: () => true,
    request: async (system, user) => {
      seedanceCalls += 1;
      if (seedanceCalls === 1) { assert.ok(system.includes(VIDEO_INTERACTION_RULES));
        assert.deepEqual(block(user, 'seedance_source_data').sceneContext, sceneContext); return seedanceZh; }
      assert.equal(seedanceSaved, seedanceZh); assert.ok(system.includes(VIDEO_INTERACTION_TRANSLATION_RULE));
      const restoredSource = user.replace(/__LH_[A-Z_\d]+?__/gu, (token) => {
        assert.ok(seedanceProtectedValues[token], `known fixture protection value ${token}`); return seedanceProtectedValues[token];
      });
      assert.equal(restoredSource, seedanceSaved, 'Seedance translation receives the complete approved two-exchange text with blocking, gaze, axis and silent defender');
      return user;
    } });
  assert.equal(seedanceCalls, 2); assert.ok(!seeded.englishError, seeded.englishError); assert.equal(seeded.promptEn, seedanceZh);
  const project = createInitialState().project;
  project.scenes = [scene]; project.locations = [location]; project.assets = [sceneAsset];
  const officialInput = buildOfficialSeedanceInput(project, { ...board, globalReferenceAssetIds: [sceneAsset.id] });
  assert.equal(officialInput?.sceneContext?.locations[0].description, location.description, 'the production Seedance entry carries linked location evidence');
} finally {
  globalThis.fetch = oldFetch;
  if (oldWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: oldWindow });
}
console.log('PASS video interaction scene/context transport, fixed scope, checkpoints and historical compatibility');
