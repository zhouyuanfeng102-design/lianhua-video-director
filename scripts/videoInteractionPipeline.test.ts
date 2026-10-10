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
import type { ConverterPreset, Location, ReferenceAsset, Scene, Storyboard, TextApiConfig } from '../src/types';

// Authored replies verify request transport and permissions, not video quality.
// No user project or live model/video API is read or modified by this test.
const story = '绝死绝命追赶向后退入走廊的马雷，镰刀斩向他的小腿；马雷用木杖挡开，仍注视她的武器。绝死绝命说：“停下！”马雷没有发话。';
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
const planShot = { startSec: 0, endSec: 8, sourceExcerpt: story, subject: '绝死绝命与马雷',
  action: '绝死绝命追赶后退的马雷，镰刀斩向小腿；马雷木杖挡开',
  space: '从寝殿门槛进入狭长回廊，接触后保持一步外', direction: '绝死绝命前进，马雷沿同一路径后退',
  performance: '马雷关注对手武器，没有发话', purpose: '连续攻防', camera: '侧向跟随，允许双方侧脸',
  lighting: '门外侧光', sound: '脚步与兵器接触声', dialogue: '第6s–7s @绝死绝命：“停下！”',
  result: '木杖与镰刀分开，双方仍在同一回廊', transition: '动作连续' };
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
        assert.equal(data.durationSec, 8); assert.equal(data.requiredShotCount, 1);
        assert.ok(system.includes(VIDEO_INTERACTION_RULES));
        content = { reason: '同轴连续跟随', shots: [planShot] };
      }
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }) };
    },
  } } });
  const semantic = await requestSemanticSequencePlan(config, { title: '回廊交锋', story, segmentDurationSec: 8,
    durationMode: 'fixed', requestedTotalDurationSec: 8, directorSettingsFingerprint: 'fixture', creativeDirection,
    characterContinuity: [], sourceSceneIds: [scene.id], shotMode: 'exact', shotCount: 1, sceneContext }, undefined, { planId: 'semantic-test', now: () => 1 });
  assert.equal(semanticCalls, 1, 'scene evidence adds no semantic audit call');
  const semanticBefore = structuredClone(semantic);
  const segment = semantic.segments[0];
  const scoped = semanticSegmentSourceContext(semantic, segment, sceneContext);
  assert.deepEqual(scoped.storyUnderstandingContext?.sceneContext, sceneContext);
  const edited = semanticSegmentSourceContext(semantic, { ...segment, content: '双方收起武器，无人讲话。', contentOverridden: true }, sceneContext);
  assert.equal(edited.generationStoryContent, '双方收起武器，无人讲话。', 'old dialogue evidence cannot restore a deleted line');
  assert.deepEqual(semantic, semanticBefore, 'request context is not a saved plan migration');
  const plan = await requestShotRecommendation(config, { durationSec: 8, story, workflow: 'action', pace: 'tight',
    requiredShotCount: 1, sceneContext }, { reviewWithAi: false });
  assert.equal(planningCalls, 1); assert.deepEqual(plan.shots, [planShot]);

  const canonical = '【0s-8s】主体：绝死绝命与马雷；动作：绝死绝命追赶后退的马雷，镰刀斩向小腿，马雷用木杖挡开；空间：寝殿门槛与狭长回廊，一步外接触；光影：门外侧光；镜头：侧向跟随双方动作；台词：第6s @绝死绝命：“停下！”；音效：脚步及兵器接触声。';
  const board: Storyboard = { id: 'interaction-board', sceneId: scene.id, sourceStoryContent: story, workflow: 'action', inputMode: 'text',
    durationSec: 8, durationPreset: 'custom', shotMode: 'exact', shotCount: 1, pace: 'tight', aspectRatio: '16:9', resolution: '2K',
    audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: 'fixture', globalLock: '', finalPrompt: canonical,
    shots: [{ id: 'interaction-shot', index: 1, ...planShot, referenceAssetIds: [], prompt: canonical, locked: false }],
    createdAt: 1, updatedAt: 1, targetModelId: 'minimax-h3', targetOutput: { targetId: 'minimax-h3', prompt: '',
      parameters: { seed: 99 }, referenceManifest: [], warnings: [], generatedAt: 1 } };
  const converter: ConverterPreset = { id: 'fixture', name: '合成转换器', scope: 'video', workflow: 'all', inputMode: 'all', enabled: true,
    version: 'test', systemPrompt: '依据当前剧情生成', outputRules: '六字段', updatedAt: 1 };
  const zh = 'integrated_multimodal_description: [Shot 1] 绝死绝命追赶后退的马雷，镰刀斩向小腿，马雷用木杖挡开；两人看向对手的武器，保持一步外，摄影机从侧面跟随。第6s (S1)说：<d>[Chinese] 停下！</d>马雷整个0–8秒没有发话。\noverall_soundscape: 脚步和兵器接触。\nnon_diegetic_music: N/A';
  const en = 'integrated_multimodal_description: [Shot 1] Zesshi pursues the retreating Mare. Her scythe sweeps toward his lower leg; he parries with his wooden staff. Their attention stays on each other’s weapons at one step apart while the camera follows from the side. At 6 seconds (S1) says: <d>[Chinese] 停下！</d>Mare performs the defensive actions without speech throughout 0–8 seconds.\noverall_soundscape: Footsteps and weapon contact.\nnon_diegetic_music: N/A';
  const envelope = (prompt: string) => JSON.stringify({ h3Prompt: prompt, identityBindings: { version: 1, characters: [] },
    characterParticipation: { version: 1, characters: [] }, canonicalPrompt: canonical, shotSourceIds: [[board.shots[0].id]], shotMetadata: [null] });
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
        return canonical;
      }
      const data = block(user, 'video_staging_review_data');
      assert.equal(data.durationSec, 8); assert.equal(data.shotMode, 'exact');
      return envelope(zh);
    } });
  assert.ok(!generated.officialPromptEnError, 'the English checkpoint remains usable');
  assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate'], 'new rules reuse existing generation stages');
  assert.equal(generated.officialPromptEn, en); assert.equal(generated.durationSec, 8);
  assert.equal(generated.targetOutput?.parameters.seed, 99);
  assert.equal(generated.targetOutput?.parameters.durationSec, 8);
  assert.deepEqual(board, boardBefore, 'generation never edits the original board in place');

  const seedanceInput = { targetId: 'seedance-2.5', durationSec: 8, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
    canonicalPrompt: canonical, references: [], sourceEvidence: { story, shotMode: 'exact', shotCount: 1 }, sceneContext };
  assert.equal(getOfficialSeedanceSourceFingerprint(seedanceInput), getOfficialSeedanceSourceFingerprint({ ...seedanceInput, sceneContext: undefined }),
    'request-only scene data does not invalidate historical outputs');
  const seedanceZh = `视频规格：8秒；16:9；2K。\n参考素材与职责：无外部素材。\n主体连续性：两人沿同一回廊推进。\n一句话概述：绝死绝命追赶后退的马雷。\n连续时间轴（覆盖0–8秒）：\n【0s-8s】${story}镜头从侧面跟随，保持武器可及的距离。\n全局约束：马雷保持观察与防守，无发话。`;
  const seedanceEn = `Video specification: 8 seconds; 16:9; 2K.\nReferences and responsibilities: none.\nSubject continuity: both follow the same corridor.\nOne-sentence summary: 绝死绝命 pursues 马雷 as he retreats.\nContinuous timeline:【0s-8s】绝死绝命 advances; 马雷 retreats and parries. 绝死绝命 says “停下！”; 马雷 remains attentive without speech. The camera tracks the interaction from the side.\nGlobal constraints: preserve real spacing.`;
  let seedanceCalls = 0; let seedanceSaved = false;
  const seeded = await generateSeedanceBilingualOutput({ input: seedanceInput,
    onChinese: () => { seedanceSaved = true; return true; }, onEnglish: () => true,
    request: async (system, user) => {
      seedanceCalls += 1;
      if (seedanceCalls === 1) { assert.ok(system.includes(VIDEO_INTERACTION_RULES));
        assert.deepEqual(block(user, 'seedance_source_data').sceneContext, sceneContext); return seedanceZh; }
      assert.ok(seedanceSaved); assert.ok(system.includes(VIDEO_INTERACTION_TRANSLATION_RULE));
      assert.ok(user.includes('镜头从侧面跟随，保持武器可及的距离'), 'translation keeps the approved physical staging'); return seedanceEn;
    } });
  assert.equal(seedanceCalls, 2); assert.ok(!seeded.englishError, seeded.englishError); assert.equal(seeded.promptEn, seedanceEn);
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
