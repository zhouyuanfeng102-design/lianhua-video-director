import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImagePrompt } from '../src/promptEngine';
import { getImageVariantGenerationSpec, imageWorkbenchEntityToForm, ordinaryImageVariantConverterRule, ordinaryImageVariantNegativePrompt } from '../src/imageGeneration';
import { buildImagePromptIdentityContext } from '../src/imagePromptIdentityContext';
import { IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT, LANDSCAPE_IMAGE_NEGATIVE_PROMPT, buildLandscapeImageSource, isLandscapeImageRequest } from '../src/imageLocationScope';
import { IMAGE_PROMPT_NAMED_IDENTITY_CONTRACT, IMAGE_PROMPT_VISIBLE_CHARACTER_IDENTITY_CONTRACT, buildImagePromptConverterSystemPrompt, gptImage25MicroNsfwConverterExtraRule, normalizeImagePromptRulesState, resolveImagePromptSelection, type ImagePromptBackend } from '../src/imagePromptRules';
import { createInitialState } from '../src/storage';
import type { ImageVariant, Location, Project } from '../src/types';

const location: Location = {
  id: 'synthetic-environment', name: '蓝灯休息厅',
  description: '深灰石墙、木质吧台和拱形入口。岚星走到沙发旁，另一人正在等候。',
  timeWeather: '夜间，窗外薄雨。', lighting: '顶部暖色吊灯、墙面蓝色灯带。', palette: '深灰、木色和蓝色。',
  fixedProps: '左侧两张沙发、中央矮桌和右侧空置吧台，墙边有固定雕塑。',
  anchor: '入口在左后方，吧台沿右墙。岚星倚着矮桌说：“等一下。”两个人的动作必须连续。',
  assetIds: [],
  visualStyle: '水彩手绘，纸张纹理与青绿色晕染',
};
const makeProject = (): Project => ({
  ...createInitialState().project,
  id: 'environment-scope', name: '不应当追加的项目名',
  description: 'PROJECT_STORY_SENTINEL：当前人物在蓝灯休息厅见面。',
  storyDraft: { name: 'draft', content: 'DRAFT_ACTION_SENTINEL：两个人转身离开。', updatedAt: 1 },
  sourceDocuments: [{ id: 'doc', name: '剧情.txt', content: 'FULL_STORY_SENTINEL：岚星拦住旅人。', createdAt: 1, updatedAt: 1 }],
  characters: [], locations: [structuredClone(location)], props: [], scenes: [], storyboards: [], sequencePlans: [], assets: [], generationTasks: [],
});

test('landscape scope is selected only by the explicit location and variant pair', () => {
  assert.equal(isLandscapeImageRequest('location', 'landscape'), true);
  for (const variant of [undefined, 'snapshot', 'first-frame', 'last-frame', 'storyboard-frame', 'portrait'] as Array<ImageVariant | undefined>) {
    assert.equal(isLandscapeImageRequest('location', variant), false);
  }
  for (const kind of ['character', 'character-private', 'character-sheet', 'prop', 'storyboard', 'grid']) {
    assert.equal(isLandscapeImageRequest(kind, 'landscape'), false);
  }
});

test('all location variants pass the saved visual style into prompt conversion without changing scope', () => {
  const fields = imageWorkbenchEntityToForm('location', location);
  for (const variant of ['landscape', 'snapshot', 'first-frame'] as const) {
    const source = buildImagePrompt('location', fields, variant);
    assert.ok(source.includes(location.visualStyle!));
    assert.equal(source.includes('无人风景场景资产'), variant === 'landscape');
  }
  assert.doesNotMatch(buildImagePrompt('location', { ...fields, style: '' }, 'snapshot'), /视觉风格：/u);
});

test('mixed location notes are preserved as extraction data instead of positive narrative scene instructions', () => {
  const fields = imageWorkbenchEntityToForm('location', location);
  const before = JSON.stringify({ location, fields });
  const source = buildImagePrompt('location', fields, 'landscape');
  assert.equal(source, buildLandscapeImageSource(fields));
  assert.match(source, /无人风景场景资产/u);
  assert.match(source, /各字段可能混有故事内容；人物、动作和对白不是本次画面指令/u);
  assert.doesNotMatch(source, /适合作为视频首帧|根据剧情建立空间布局|符合剧情的关键陈设/u);
  const raw = JSON.parse(source.split('地点原始资料 JSON：\n')[1]);
  for (const key of ['name', 'description', 'weather', 'lighting', 'palette', 'fixedProps', 'anchor']) {
    assert.equal(raw[key], fields[key], `${key} remains the original dossier text`);
  }
  assert.equal(JSON.stringify({ location, fields }), before, 'no name matching or source rewriting');
});

test('only the location form schema enters landscape extraction, not stray character/story fields', () => {
  const fields = { ...imageWorkbenchEntityToForm('location', location),
    story: 'UNRELATED_STORY_FIELD', characters: 'UNRELATED_CHARACTER_FIELD', appearance: 'UNRELATED_BODY_FIELD',
    style: '冷调写实建筑摄影',
  };
  const source = buildLandscapeImageSource(fields);
  assert.match(source, /冷调写实建筑摄影/u);
  assert.doesNotMatch(source, /UNRELATED_STORY_FIELD|UNRELATED_CHARACTER_FIELD|UNRELATED_BODY_FIELD/u);
});

test('an empty landscape dossier requests a reusable environment without inventing story participants', () => {
  const source = buildImagePrompt('location', {}, 'landscape');
  assert.match(source, /不得从缺失字段推测并补入剧情人物/u);
  assert.doesNotMatch(source, /根据剧情建立|符合剧情|视频首帧/u);
  assert.equal(JSON.parse(source.split('地点原始资料 JSON：\n')[1]).anchor, '');
});

test('landscape bypasses story and identity context even when a caller supplies names and a storyboard', () => {
  const project = makeProject();
  const before = JSON.stringify(project);
  const context = buildImagePromptIdentityContext(project, ['岚星'], {
    sourceStoryTitle: '旧分镜', sourceStoryContent: 'BOARD_ACTION_SENTINEL：岚星站在吧台边。',
  }, { assetKind: 'location', imageVariant: 'landscape' });
  assert.equal(context, '');
  assert.equal(JSON.stringify(project), before);
  for (const variant of ['snapshot', 'first-frame'] as const) {
    assert.match(buildImagePromptIdentityContext(project, [], undefined, { assetKind: 'location', imageVariant: variant }), /FULL_STORY_SENTINEL/u);
  }
  assert.match(buildImagePromptIdentityContext(project, ['岚星'], undefined, { assetKind: 'character', imageVariant: 'portrait' }), /当前指定人物姓名/u);
});

test('current landscape directions and negative prompts target empty environments only', () => {
  assert.match(getImageVariantGenerationSpec('landscape').direction, /无人风景场景资产/u);
  assert.match(getImageVariantGenerationSpec('landscape').direction, /一个相机视点/u);
  assert.equal(ordinaryImageVariantConverterRule('landscape'), IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT);
  assert.equal(ordinaryImageVariantNegativePrompt('landscape'), LANDSCAPE_IMAGE_NEGATIVE_PROMPT);
  assert.match(LANDSCAPE_IMAGE_NEGATIVE_PROMPT, /people.*characters.*storyboard/u);
  for (const variant of ['snapshot', 'first-frame', 'portrait', 'showcase'] as ImageVariant[]) {
    assert.notEqual(ordinaryImageVariantNegativePrompt(variant), LANDSCAPE_IMAGE_NEGATIVE_PROMPT);
    assert.ok(!ordinaryImageVariantConverterRule(variant).includes(IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT));
  }
});

test('natural language, SD, ComfyUI and NovelAI landscape converters receive the final environment contract', () => {
  for (const backend of ['openai', 'sd-webui', 'comfyui', 'novelai'] as ImagePromptBackend[]) {
    const selected = resolveImagePromptSelection({ backend, assetKind: 'location', imageVariant: 'landscape' });
    const prompt = buildImagePromptConverterSystemPrompt(selected, '额外要求：保留原蓝色灯带和木质纹理。', 'landscape');
    assert.ok(prompt.includes(IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT), backend);
    assert.ok(prompt.lastIndexOf('[LANDSCAPE_ENVIRONMENT_V1]') > prompt.indexOf('</image_prompt_extra_rules>'));
    assert.ok(!prompt.includes(IMAGE_PROMPT_NAMED_IDENTITY_CONTRACT));
    assert.ok(!prompt.includes(IMAGE_PROMPT_VISIBLE_CHARACTER_IDENTITY_CONTRACT));
    assert.match(prompt, /只输出环境基础段，不创建人物段/u);
    assert.match(prompt, /原资料中的固定雕塑或装饰作为静物保留/u);
    assert.match(prompt, /参考图中的人物、角色、站位、动作或人物倒影不进入本次无人环境/u);
  }
});

test('a micro NSFW visual rule never gives landscape, snapshot or first-frame locations a character-portrait target', () => {
  for (const variant of ['landscape', 'snapshot', 'first-frame'] as const) {
    const selected = resolveImagePromptSelection({ backend: 'openai', assetKind: 'location', imageVariant: variant,
      manualRuleSetId: 'image-rule-openai-gpt-image-2-5-micro-nsfw',
    });
    assert.equal(gptImage25MicroNsfwConverterExtraRule(selected, 'location', variant), '');
    const prompt = buildImagePromptConverterSystemPrompt(selected, ordinaryImageVariantConverterRule(variant), variant);
    assert.ok(!prompt.includes('当前目标是普通角色图：'));
    assert.equal(prompt.includes(IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT), variant === 'landscape');
  }
  const character = resolveImagePromptSelection({ backend: 'openai', assetKind: 'character', imageVariant: 'full-body',
    manualRuleSetId: 'image-rule-openai-gpt-image-2-5-micro-nsfw',
  });
  assert.match(gptImage25MicroNsfwConverterExtraRule(character, 'character', 'full-body'), /当前目标是普通单幅全身角色图/u);
});

test('old saved default presets cannot authorize people for landscape and remain unmodified', () => {
  const rules = normalizeImagePromptRulesState(undefined);
  const preset = rules.categoryPresets.find((item) => item.id === 'image-preset-location')!;
  preset.outputRules = '输出单一场景建立画面，空间层次和固定锚点必须可辨；原资料没有人物时不得擅自添加人物。';
  preset.version = '1.0.0';
  const before = JSON.stringify(rules);
  const selected = resolveImagePromptSelection({ backend: 'openai', assetKind: 'location', imageVariant: 'landscape', state: rules, manualPresetId: preset.id });
  const prompt = buildImagePromptConverterSystemPrompt(selected, '', 'landscape');
  assert.ok(prompt.includes(preset.outputRules));
  assert.ok(prompt.lastIndexOf(IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT) > prompt.indexOf(preset.outputRules));
  assert.match(prompt, /优先于通用、旧版或自定义预设中允许人物、首帧或剧情的描述/u);
  assert.equal(JSON.stringify(rules), before);
});

test('custom stylistic rules remain intact while their narrative suggestions cannot change landscape scope', () => {
  const selected = resolveImagePromptSelection({ backend: 'openai', assetKind: 'location' });
  const custom = { ...selected, preset: { ...selected.preset,
    systemPrompt: 'CUSTOM_STYLE_SENTINEL：蓝色灯光、水彩笔触。可添加人物在门口交谈。',
    outputRules: '旧模板可用双人剧情首帧。',
  } };
  const before = JSON.stringify(custom);
  const prompt = buildImagePromptConverterSystemPrompt(custom, '补充：两个人在沙发交谈。', 'landscape');
  assert.match(prompt, /CUSTOM_STYLE_SENTINEL/u);
  assert.match(prompt, /保留所选媒介、视觉风格、画幅与环境空间事实/u);
  assert.ok(prompt.lastIndexOf(IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT) > prompt.indexOf('补充：两个人在沙发交谈'));
  assert.equal(JSON.stringify(custom), before);
});

test('snapshot and first-frame location variants retain their explicitly narrative construction', () => {
  const fields = imageWorkbenchEntityToForm('location', location);
  for (const variant of ['snapshot', 'first-frame'] as const) {
    const source = buildImagePrompt('location', fields, variant);
    assert.ok(source.includes(fields.anchor));
    assert.ok(!source.includes('地点原始资料 JSON：'));
    const selected = resolveImagePromptSelection({ backend: 'openai', assetKind: 'location', imageVariant: variant });
    const rules = buildImagePromptConverterSystemPrompt(selected, ordinaryImageVariantConverterRule(variant), variant);
    assert.ok(!rules.includes(IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT));
    assert.ok(rules.includes(IMAGE_PROMPT_NAMED_IDENTITY_CONTRACT));
  }
  assert.match(buildImagePrompt('location', fields, 'snapshot'), /主体动作和环境关系清晰/u);
  assert.match(buildImagePrompt('location', fields, 'first-frame'), /人物站位/u);
});

test('character and prop variants keep identity, outfit and object behavior without environment-only restrictions', () => {
  const characterSource = buildImagePrompt('character', { name: '岚星', gender: '女性', appearance: '黑发', outfit: '蓝色外套', anchor: '额前银色发夹' }, 'portrait');
  assert.match(characterSource, /岚星.*女性.*蓝色外套/su);
  assert.ok(!characterSource.includes('无人风景场景资产'));
  const propSource = buildImagePrompt('prop', { name: '铜钥匙', material: '铜', appearance: '齿槽清晰', effect: '由旅人手持开门' }, 'showcase');
  assert.match(propSource, /铜钥匙.*由旅人手持开门/su);
  assert.ok(!propSource.includes('无人风景场景资产'));
  for (const kind of ['character', 'prop', 'storyboard'] as const) {
    const selected = resolveImagePromptSelection({ backend: 'openai', assetKind: kind });
    assert.ok(!buildImagePromptConverterSystemPrompt(selected, '', kind === 'character' ? 'portrait' : undefined).includes(IMAGE_PROMPT_LANDSCAPE_SCOPE_CONTRACT));
  }
});
