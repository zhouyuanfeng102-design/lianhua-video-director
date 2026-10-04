import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImagePromptIdentityContext } from '../src/imagePromptIdentityContext';
import { buildImageRegenerationTask, resolveImageRegenerationSource } from '../src/imageRegeneration';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';
import type { Character, ImageGenerationTask, Project } from '../src/types';

// Neutral in-memory fixtures only: no persisted user state or model request.
const character: Character = {
  id: 'named-character', name: '星岚·机械形态', baseName: '星岚', variantOf: '星岚', formLabel: '机械形态',
  gender: '自定义', race: '机械', apparentAge: '设定资料', appearance: '银色机体', outfit: '蓝色外覆装甲',
  anchor: '三角胸徽', signatureProps: '', personality: '', motionHabits: '', negativeContinuity: '', assetIds: [],
  nsfwProfile: { fullBody: 'NEUTRAL_STABLE_PROFILE_FIXTURE', provenance: 'manual' },
};
const project = (): Project => ({
  id: 'identity-context-project', name: 'THIS_PROJECT_TITLE_IS_NOT_A_FRANCHISE',
  description: '作品归属：云港纪事。世界观：空中城邦。本次使用纯色摄影棚。',
  sourceDocuments: [{ id: 'source', name: '第一章.txt', content: '星岚来自《云港纪事》的空中城邦。', createdAt: 1, updatedAt: 1 }],
  characters: [structuredClone(character)], locations: [], props: [], scenes: [], storyboards: [], sequencePlans: [],
  assets: [], generationTasks: [], createdAt: 1, updatedAt: 1,
});
const task = (overrides: Partial<ImageGenerationTask> = {}): ImageGenerationTask => ({
  id: 'identity-task', kind: 'image', name: '中性身份测试', assetKind: 'character', imageVariant: 'portrait',
  sourceEntityId: character.id, backend: 'openai', model: 'synthetic-image', status: 'failed',
  prompt: '', conversionSource: '本图为中性角色头像', converterSystemPrompt: '旧转换器规则快照',
  referenceAssetIds: [], primaryReferenceAssetIds: [], width: 1024, height: 1024, createdAt: 1, updatedAt: 1,
  ...overrides,
});

test('identity context contains authored evidence and full form name without assigning a project title as a work', () => {
  const source = project(); const before = JSON.stringify(source);
  const evidence = buildImagePromptIdentityContext(source, [character.name]);
  assert.match(evidence, /星岚·机械形态/u);
  assert.match(evidence, /云港纪事/u);
  assert.match(evidence, /空中城邦/u);
  assert.match(evidence, /第一章\.txt/u);
  assert.ok(!evidence.includes(source.name));
  assert.equal(JSON.stringify(source), before);
  assert.equal(buildImagePromptIdentityContext({ ...source, description: '', sourceDocuments: [] }), '',
    'an unknown origin stays empty instead of becoming the project title');
});

test('bounded long-story excerpts retain late base-name evidence and the ending without renaming the selected form', () => {
  const source = project();
  source.description = '';
  source.sourceDocuments[0].content = `星岚。星岚。星岚。${'中性旅途描写。'.repeat(700)}星岚的作品归属是《迟到的身份事实》。${'其他场景。'.repeat(900)}尾部来源证据。`;
  const evidence = buildImagePromptIdentityContext(source, [character.name]);
  assert.match(evidence, /当前指定人物姓名（含已明确形态）：星岚·机械形态/u);
  assert.match(evidence, /迟到的身份事实/u);
  assert.match(evidence, /尾部来源证据/u);
  assert.ok(evidence.length <= 12000);
});

test('selected ordinary dossiers retain exact work clues without copying private or unselected character data', () => {
  for (const field of ['appearance', 'race', 'anchor'] as const) {
    const source = project(); source.description = ''; source.sourceDocuments = [];
    source.characters[0][field] = '明确角色出处：《云港机械纪事》。原始资料保持原样。';
    source.characters[0].nsfwProfile = { fullBody: 'PRIVATE_PROFILE_MUST_STAY_OUT', provenance: 'manual' };
    source.characters[0].assetIds = ['PRIVATE_IMAGE_MUST_STAY_OUT'];
    source.characters.push({ ...structuredClone(character), id: 'not-selected', name: '未选人物',
      baseName: '未选人物', variantOf: undefined, appearance: 'UNSELECTED_DOSSIER_MUST_STAY_OUT' });
    const before = JSON.stringify(source);
    const evidence = buildImagePromptIdentityContext(source, [character.name]);
    assert.match(evidence, /云港机械纪事/u);
    assert.match(evidence, /当前指定人物普通档案《星岚·机械形态》/u);
    assert.match(evidence, /结合可靠角色知识理解具体作品身份/u);
    assert.ok(!evidence.includes('PRIVATE_PROFILE_MUST_STAY_OUT'));
    assert.ok(!evidence.includes('PRIVATE_IMAGE_MUST_STAY_OUT'));
    assert.ok(!evidence.includes('UNSELECTED_DOSSIER_MUST_STAY_OUT'));
    assert.equal(JSON.stringify(source), before);
    assert.equal(buildImagePromptIdentityContext(source), '', 'empty-frame input does not acquire character dossiers');
  }
});

test('ordinary dossier lookup accepts the explicit form display name and retains full metadata', () => {
  const source = project(); source.description = ''; source.sourceDocuments = [];
  source.characters[0].name = '星岚';
  source.characters[0].appearance = '出自《云港纪事》的银色机体。';
  const evidence = buildImagePromptIdentityContext(source, ['星岚·机械形态']);
  assert.match(evidence, /当前指定人物姓名（含已明确形态）：星岚·机械形态/u);
  assert.match(evidence, /资料原始姓名：星岚/u);
  assert.match(evidence, /当前形态：机械形态/u);
  assert.match(evidence, /形态来源姓名：星岚/u);
  assert.match(evidence, /云港纪事/u);
});

test('legacy female lifecycle wording is neutralized only in generated identity evidence', () => {
  const source = project(); source.description = ''; source.sourceDocuments = [];
  source.characters[0] = {
    ...structuredClone(character),
    name: '露娜·幼体形态', baseName: '露娜', variantOf: '露娜', formLabel: '幼体形态', gender: '女',
    apparentAge: '约十二岁', height: '约140cm', race: '人类少女',
    bodyPlan: '未完全发育的少女骨架，双臂双腿', appearance: '幼态脸型与女童身形',
    outfit: '少女款浅色连衣裙', anchor: '保持幼体形态与金色长发',
  };
  const before = JSON.stringify(source);
  const evidence = buildImagePromptIdentityContext(source, ['露娜·缩小状态']);
  assert.match(evidence, /露娜·缩小状态/u);
  assert.match(evidence, /约十二岁/u);
  assert.match(evidence, /约140cm/u);
  assert.doesNotMatch(evidence, /儿童|孩童|小孩|幼体|幼态|幼年|幼女|女童|女孩|萝莉|少女|少年|未发育/u);
  assert.equal(JSON.stringify(source), before, 'identity evidence cleanup must not mutate saved project data');
});

test('a known-looking name is raw evidence and never becomes a locally inferred franchise', () => {
  const source = project(); source.description = ''; source.sourceDocuments = [];
  source.characters[0] = { ...structuredClone(character), name: '蒂法', baseName: undefined,
    formLabel: undefined, variantOf: undefined, appearance: '黑色长发。' };
  const evidence = buildImagePromptIdentityContext(source, ['蒂法']);
  assert.match(evidence, /蒂法/u);
  assert.match(evidence, /黑色长发/u);
  assert.ok(!evidence.includes('最终幻想'));
  assert.ok(!evidence.includes('游戏世界'));
});

test('project-description excerpts preserve late explicit work evidence instead of clipping at 2400 characters', () => {
  const source = project(); source.sourceDocuments = [];
  source.description = `${'中性设定说明。'.repeat(700)}星岚的作品归属：《说明后部的具体作品》。${'其余环境资料。'.repeat(700)}`;
  const before = JSON.stringify(source);
  const evidence = buildImagePromptIdentityContext(source, [character.name]);
  assert.match(evidence, /说明后部的具体作品/u);
  assert.ok(evidence.length <= 12000);
  assert.equal(JSON.stringify(source), before);
});

test('late source markers survive after many repetitive early character mentions', () => {
  const source = project(); source.description = '';
  source.sourceDocuments[0].content = `${'开头景物。'.repeat(200)}星岚走路。${'中性景物。'.repeat(120)}星岚看天。${'中性景物。'.repeat(120)}星岚回头。${'中性景物。'.repeat(120)}星岚来自《第四处才说明的作品》。${'普通结尾。'.repeat(500)}原文最后一句。`;
  const evidence = buildImagePromptIdentityContext(source, [character.name]);
  assert.match(evidence, /第四处才说明的作品/u);
  assert.match(evidence, /原文最后一句/u);
  assert.ok(evidence.length <= 12000);
});

test('field budgets retain late anchors and separate work clues for every selected character', () => {
  const source = project(); source.description = ''; source.sourceDocuments = [];
  source.characters = Array.from({ length: 4 }, (_, index) => ({
    ...structuredClone(character), id: `selected-${index}`, name: `星岚${index}·机械形态`,
    baseName: `星岚${index}`, variantOf: `星岚${index}`,
    appearance: `${'中性外貌资料。'.repeat(600)}角色出处：《外貌作品${index}》。${'其他外貌。'.repeat(600)}`,
    anchor: `${'中性锚点。'.repeat(600)}所属作品：《锚点作品${index}》。${'其他锚点。'.repeat(600)}`,
  }));
  const evidence = buildImagePromptIdentityContext(source, source.characters.map((item) => item.name));
  for (let index = 0; index < 4; index += 1) {
    assert.ok(evidence.includes(`星岚${index}·机械形态`));
    assert.ok(evidence.includes(`外貌作品${index}`));
    assert.ok(evidence.includes(`锚点作品${index}`));
  }
  assert.ok(evidence.length <= 12000);
});

test('source budgets prioritize frozen story, description, selected dossier and marked documents over long titles', () => {
  const source = project();
  source.description = `${'中性项目说明。'.repeat(800)}项目作品：《保留项目世界》。${'其他说明。'.repeat(800)}`;
  source.characters[0].anchor = '作品：《保留人物作品》。';
  source.sourceDocuments = Array.from({ length: 8 }, (_, index) => ({
    id: `doc-${index}`, name: `文档${index}${'冗长文件标题'.repeat(500)}`,
    content: `星岚散步。${'普通事件描写。'.repeat(1000)}`, createdAt: 1, updatedAt: 1,
  }));
  source.sourceDocuments.push({ id: 'late-origin', name: '较后的身份资料',
    content: `星岚的作品出处：《保留较后文档作品》。${'中性故事描写。'.repeat(1000)}`, createdAt: 1, updatedAt: 1 });
  source.storyDraft = { name: '不相关新草稿', content: 'UNSUBMITTED_WORLD_MUST_STAY_OUT', updatedAt: 2 };
  const evidence = buildImagePromptIdentityContext(source, [character.name], {
    sourceStoryTitle: '冻结故事', sourceStoryContent: `冻结原文作品：《保留冻结世界》。${'中性冻结故事。'.repeat(1200)}`,
  });
  assert.match(evidence, /保留冻结世界/u);
  assert.match(evidence, /保留项目世界/u);
  assert.match(evidence, /保留人物作品/u);
  assert.match(evidence, /保留较后文档作品/u);
  assert.ok(evidence.indexOf('保留冻结世界') < evidence.indexOf('保留项目世界'));
  assert.ok(!evidence.includes('UNSUBMITTED_WORLD_MUST_STAY_OUT'));
  assert.ok(evidence.length <= 12000);
});

test('new unsaved workbench source is evidence while a saved duplicate is not copied twice', () => {
  const source = project();
  source.storyDraft = { name: '新草稿', content: '星岚来自明确的原创浮岛世界。', updatedAt: 2 };
  const evidence = buildImagePromptIdentityContext(source, [character.name]);
  assert.match(evidence, /当前未提交剧情草稿/u);
  assert.match(evidence, /原创浮岛世界/u);
  source.storyDraft.content = source.sourceDocuments[0].content;
  assert.ok(!buildImagePromptIdentityContext(source, [character.name]).includes('当前未提交剧情草稿'));
});

test('scene-only legacy sources can supply evidence without inventing a visible character', () => {
  const source = project(); source.description = ''; source.sourceDocuments = [];
  source.scenes = [{ id: 'scene', title: '空城', content: '世界观是云端城邦；本镜是空的石桥。', summary: '',
    characterIds: [], locationIds: [], propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 }];
  const evidence = buildImagePromptIdentityContext(source);
  assert.match(evidence, /云端城邦/u);
  assert.ok(!evidence.includes('当前指定人物姓名'));
  assert.ok(!evidence.includes(character.name));
});

test('storyboard identity uses its saved source before project evidence and excludes an unrelated unsubmitted draft', () => {
  const source = project();
  source.storyDraft = { name: '下一个故事', content: '草稿专属信息：同名人物属于另一个作品。', updatedAt: 2 };
  const evidence = buildImagePromptIdentityContext(source, [character.name], {
    sourceStoryTitle: '本段已确认故事', sourceStoryContent: '本段明确作品是《分镜冻结世界》，这里仅出现角色的代词。',
  });
  assert.match(evidence, /分镜冻结世界/u);
  assert.ok(!evidence.includes('草稿专属信息'));
  assert.ok(evidence.indexOf('身份/世界背景摘录：\n本段明确作品')
    < evidence.indexOf('身份/世界背景摘录：\n星岚'), 'saved storyboard source precedes a document with more exact name matches');
  assert.match(buildImagePromptIdentityContext(source, [], {
    sourceSceneSnapshots: [{ id: 'snapshot', title: '快照', content: '快照保留的作品归属。', summary: '',
      characterIds: [], propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 }],
  }), /快照保留的作品归属/u);
});

test('frozen nonempty and explicitly empty identity snapshots survive serialization and normalization', () => {
  for (const frozen of ['明确作品：云港纪事；人物：星岚·机械形态。', '']) {
    const state = createInitialState();
    state.project = project();
    state.project.generationTasks = [task({ conversionIdentityContext: frozen })];
    state.projects = [state.project]; state.activeProjectId = state.project.id;
    const saved = serializeStateForStorage(state);
    const restored = normalizeState(JSON.parse(saved.serialized));
    const image = restored.project.generationTasks.find((item) => item.id === 'identity-task');
    assert.ok(image?.kind === 'image');
    assert.equal(image.conversionIdentityContext, frozen);
    assert.ok(Object.hasOwn(image, 'conversionIdentityContext'));
  }
  const state = createInitialState(); state.project = project(); state.project.generationTasks = [task()];
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  const restored = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
  assert.ok(!Object.hasOwn(restored.project.generationTasks[0], 'conversionIdentityContext'));
});

test('retry reuses its frozen evidence after the project identity changes, including an explicit empty snapshot', () => {
  for (const frozen of ['原作品：云港纪事；原人物：星岚·机械形态。', '']) {
    const source = project(); source.description = '此后改成的作品资料';
    const original = task({ conversionIdentityContext: frozen }); source.generationTasks = [original];
    const recovered = resolveImageRegenerationSource(original, source);
    assert.equal(recovered.conversionIdentityContext, frozen);
    const retried = buildImageRegenerationTask(original, source, {
      id: 'retried-identity', timestamp: 2, backend: 'openai', model: 'synthetic-image', source: recovered,
    });
    assert.equal(retried.conversionIdentityContext, frozen);
    assert.equal(retried.conversionSource, original.conversionSource);
    assert.equal(retried.prompt, original.prompt, 'creating a retry never hard-appends named identity');
  }
});

test('legacy retries only add source evidence when conversion is actually needed, not rewrite a saved final prompt', () => {
  const source = project();
  const finished = task({ prompt: 'Exact historical final image prompt' });
  const before = JSON.stringify(finished);
  assert.equal(resolveImageRegenerationSource(finished, source).conversionIdentityContext, undefined);
  assert.equal(JSON.stringify(finished), before);
  const failed = task();
  const recovered = resolveImageRegenerationSource(failed, source);
  assert.match(recovered.conversionIdentityContext || '', /云港纪事/u);
  assert.match(recovered.conversionIdentityContext || '', /星岚·机械形态/u);
  assert.equal(recovered.conversionSource, failed.conversionSource);
  assert.ok(!Object.hasOwn(failed, 'conversionIdentityContext'), 'legacy source tasks are not migrated in place');
});

test('private legacy conversion receives full named identity separately even when its old visual input omitted the name', () => {
  const source = project();
  const original = task({ imageVariant: 'private-five-view', referenceScope: 'nsfw-private-profile', nsfwPrivatePart: 'full-body',
    prompt: 'Original neutral layout description', conversionSource: 'NEUTRAL_BODY_INPUT_WITHOUT_A_NAME' });
  const recovered = resolveImageRegenerationSource(original, source);
  assert.match(recovered.conversionIdentityContext || '', /星岚·机械形态/u);
  assert.match(recovered.conversionIdentityContext || '', /云港纪事/u);
  assert.equal(recovered.conversionSource, original.conversionSource);
  assert.equal(original.prompt, 'Original neutral layout description');
});
