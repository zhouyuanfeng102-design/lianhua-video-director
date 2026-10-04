import assert from 'node:assert/strict';
import {
  NEW_ANIME_VISUAL_STYLE_PRESET_IDS,
  NEW_VISUAL_STYLE_PRESET_IDS,
  applyVisualStyleSelection,
  createBuiltInVisualStylePresets,
  findVisualStyleDefinition,
  matchedStylePresetId,
  resolveVisualStyleSelectDisplay,
  resolveVisualStylePrompt,
  visualStyleDefinitions,
} from '../src/visualStyles';
import type { VisualStyleDefinition } from '../src/visualStyles';

const expectedMappings = [
  ['cinematic_realism', '电影写实', 'style_cinema'],
  ['documentary', '纪录片', 'style_documentary'],
  ['korean_portrait', '韩式偶像', 'style_korean_portrait'],
  ['vintage_film', '复古胶片', 'style_vintage_film'],
  ['black_cinema', '黑色电影', 'style_black_cinema'],
  ['short_drama', '短剧质感', 'style_short_drama'],
  ['korean_mood', '韩系氛围', 'style_korean_mood'],
  ['raw_camera', '毛边美学', 'style_raw_camera'],
  ['sports_event', '赛事体育', 'style_sports_event'],
  ['republic_vintage', '民国复古', 'style_republic_vintage'],
  ['anime_movie', '动画电影', 'style_anime_movie'],
  ['ink_fantasy', '水墨幻想', 'style_ink_fantasy'],
  ['dream_surreal', '梦境超现实', 'style_dream_surreal'],
  ['no_style', '无附加风格', 'style_neutral'],
  ['tv_anime_cel', 'TV番剧赛璐璐', 'style_tv_anime_cel'],
  ['shonen_action_anime', '热血少年番', 'style_shonen_action_anime'],
  ['shojo_soft_anime', '少女漫画动画', 'style_shojo_soft_anime'],
  ['anime_illustration_paint', '厚涂动漫插画', 'style_anime_illustration_paint'],
  ['toon_3d_anime', '三渲二动漫', 'style_toon_3d_anime'],
  ['stylized_3d_cartoon', '卡通3D动画', 'style_stylized_3d_cartoon'],
  ['game_cg_anime', '游戏CG动漫', 'style_game_cg_anime'],
  ['chibi_3d_cute', 'Q版3D萌系', 'style_chibi_3d_cute'],
  ['post_apocalyptic_wasteland', '末日废土', 'style_post_apocalyptic_wasteland'],
  ['cyberpunk_night', '赛博朋克夜城', 'style_cyberpunk_night'],
  ['hard_scifi_space', '硬科幻太空', 'style_hard_scifi_space'],
  ['biopunk', '生物科幻', 'style_biopunk'],
  ['dieselpunk', '柴油朋克', 'style_dieselpunk'],
  ['kaiju_disaster', '巨兽灾难', 'style_kaiju_disaster'],
  ['tokusatsu_drama', '特摄剧', 'style_tokusatsu_drama'],
  ['wuxia', '国风武侠', 'style_wuxia'],
  ['oriental_myth', '东方神话', 'style_oriental_myth'],
  ['xianxia_cloud', '仙侠云境', 'style_xianxia_cloud'],
  ['dark_fantasy', '黑暗奇幻', 'style_dark_fantasy'],
  ['refined_3d', '精致3D动画', 'style_3d'],
  ['stop_motion_clay', '定格黏土', 'style_stop_motion_clay'],
  ['suspense_thriller', '悬疑惊悚', 'style_suspense'],
  ['gothic_horror', '哥特恐怖', 'style_gothic_horror'],
] as const;

const definitions: readonly VisualStyleDefinition[] = visualStyleDefinitions;
assert.equal(definitions.length, 37, 'the visual-style catalog must contain exactly 37 definitions');
assert.equal(Object.isFrozen(definitions), true, 'the exported catalog must be immutable at runtime');
assert.deepEqual(
  definitions.map(({ id, name, stylePresetId }) => [id, name, stylePresetId]),
  expectedMappings,
  'the catalog must preserve the specified one-to-one visual-style mapping and order',
);

const assertUnique = (values: readonly string[], field: string): void => {
  assert.equal(new Set(values).size, values.length, `${field} values must be unique`);
};

assertUnique(definitions.map(({ id }) => id), 'id');
assertUnique(definitions.map(({ name }) => name), 'name');
assertUnique(definitions.map(({ stylePresetId }) => stylePresetId), 'stylePresetId');

const legacyNames = [
  '电影写实',
  '纪录片',
  '韩式偶像',
  '复古胶片',
  '黑色电影',
  '短剧质感',
  '韩系氛围',
  '毛边美学',
  '赛事体育',
  '民国复古',
  '动画电影',
  '水墨幻想',
  '梦境超现实',
  '无附加风格',
] as const;
assert.deepEqual(
  definitions.slice(0, legacyNames.length).map(({ name }) => name),
  legacyNames,
  'all 14 existing visual-style names must remain unchanged',
);

for (const definition of definitions) {
  assert.equal(Object.isFrozen(definition), true, `${definition.name} definition must be immutable at runtime`);
  assert.equal(Object.isFrozen(definition.preset), true, `${definition.name} preset rules must be immutable at runtime`);
  assert.ok(definition.category.trim(), `${definition.name} must have a category`);

  if (definition.id === 'no_style') {
    assert.equal(definition.promptAnchor, '', 'no_style must not inject an additional visual anchor');
  } else {
    assert.ok(definition.promptAnchor.trim(), `${definition.name} must have an explicit prompt anchor`);
    for (const dimension of ['色彩', '材质', '光影', '氛围', '质感']) {
      assert.match(
        definition.promptAnchor,
        new RegExp(`${dimension}：`, 'u'),
        `${definition.name} prompt anchor must specify ${dimension}`,
      );
    }
  }

  for (const field of ['visual', 'camera', 'lighting', 'sound'] as const) {
    assert.ok(definition.preset[field].trim(), `${definition.name} preset.${field} must be non-empty`);
  }
}

const wasteland = findVisualStyleDefinition('末日废土');
assert.ok(wasteland, '末日废土 must be findable by name');
for (const anchor of ['灰橙低饱和', '锈蚀金属', '风沙尘雾', '破败混凝土', '硬质逆光', '空旷压迫感']) {
  assert.match(wasteland.promptAnchor, new RegExp(anchor, 'u'), `末日废土 must include ${anchor}`);
}

const tokusatsu = findVisualStyleDefinition('特摄剧');
assert.ok(tokusatsu, '特摄剧 must be a first-class visual style');
for (const anchor of ['英雄识别色', '皮套', '微缩建筑', '现场爆破', '光学合成', '特摄剧']) {
  assert.match(tokusatsu.promptAnchor, new RegExp(anchor, 'u'), `特摄剧 must include ${anchor}`);
}
assert.equal(
  findVisualStyleDefinition('特摄电影写实')?.id,
  'tokusatsu_drama',
  'the legacy 特摄电影写实 value must resolve to the new 特摄剧 catalog entry',
);

for (const [name, anchors] of [
  ['TV番剧赛璐璐', ['平涂赛璐璐', '硬边阴影', '2D合成']],
  ['热血少年番', ['速度线', '能量火花', '2D动作作画']],
  ['少女漫画动画', ['柔粉', '星点眼神光', '漫画分格式']],
  ['厚涂动漫插画', ['厚涂笔触', '半写实皮肤', '数字插画']],
  ['三渲二动漫', ['卡通着色', '描边轮廓', '三渲二合成']],
  ['卡通3D动画', ['圆润PBR', '平滑动画曲线', '电影级3D渲染']],
  ['游戏CG动漫', ['精细3D服装', '技能自发光', '实时CG渲染']],
  ['Q版3D萌系', ['马卡龙浅色', 'Q版大头比例', '干净3D卡通渲染']],
] as const) {
  const definition = findVisualStyleDefinition(name);
  assert.ok(definition, `${name} must be a first-class anime visual style`);
  for (const anchor of anchors) {
    assert.match(definition.promptAnchor, new RegExp(anchor, 'u'), `${name} must include ${anchor}`);
  }
}

assert.equal(findVisualStyleDefinition('cinematic_realism')?.name, '电影写实');
assert.equal(findVisualStyleDefinition('电影写实')?.id, 'cinematic_realism');
assert.equal(findVisualStyleDefinition(' 电影写实 ')?.id, 'cinematic_realism');
assert.equal(findVisualStyleDefinition('不存在的风格'), undefined);

assert.deepEqual(
  applyVisualStyleSelection(
    '末日废土',
    ['style_wuxia', 'style_cinema'],
    'style_deleted_current',
  ),
  {
    visualStyle: '末日废土',
    stylePresetId: 'style_wuxia',
    matched: false,
  },
  'a stale current preset must fall back deterministically to the first available preset',
);
assert.deepEqual(
  applyVisualStyleSelection('末日废土', [], 'style_deleted_current'),
  {
    visualStyle: '末日废土',
    stylePresetId: 'style_deleted_current',
    matched: false,
  },
  'a stale current preset may only be retained when no preset remains available',
);

assert.equal(
  typeof resolveVisualStyleSelectDisplay,
  'function',
  'the catalog must expose a pure controlled-select display resolver',
);
assert.deepEqual(
  resolveVisualStyleSelectDisplay('wuxia'),
  { value: '国风武侠', compatibility: false },
  'a saved catalog ID must display its canonical catalog name without mutating saved state',
);
assert.deepEqual(
  resolveVisualStyleSelectDisplay('国风武侠'),
  { value: '国风武侠', compatibility: false },
);
assert.deepEqual(
  resolveVisualStyleSelectDisplay('特摄电影写实'),
  { value: '特摄剧', compatibility: false },
  'the legacy 特摄电影写实 value must display as the canonical 特摄剧 option',
);
assert.deepEqual(resolveVisualStyleSelectDisplay(''), { value: '', compatibility: false });

assert.equal(resolveVisualStylePrompt('no_style'), '');
assert.equal(resolveVisualStylePrompt('无附加风格'), '');
assert.equal(resolveVisualStylePrompt('末日废土'), wasteland.promptAnchor);
assert.equal(
  resolveVisualStylePrompt('  特摄电影写实  '),
  tokusatsu.promptAnchor,
  'the legacy 特摄电影写实 value must receive the complete 特摄剧 prompt anchor',
);
assert.equal(resolveVisualStylePrompt('   '), '');

assert.equal(matchedStylePresetId('wuxia'), 'style_wuxia');
assert.equal(matchedStylePresetId('国风武侠'), 'style_wuxia');
assert.equal(matchedStylePresetId('不存在的风格'), undefined);

assert.equal(
  typeof applyVisualStyleSelection,
  'function',
  'the catalog must export a pure linked visual-style selection helper',
);

assert.deepEqual(
  applyVisualStyleSelection(
    'post_apocalyptic_wasteland',
    ['style_cinema', 'style_post_apocalyptic_wasteland'],
    'style_cinema',
  ),
  {
    visualStyle: '末日废土',
    stylePresetId: 'style_post_apocalyptic_wasteland',
    matched: true,
  },
  'a recognized catalog id must normalize to its canonical name and linked available preset',
);
assert.deepEqual(
  applyVisualStyleSelection('末日废土', ['style_cinema'], 'style_cinema'),
  {
    visualStyle: '末日废土',
    stylePresetId: 'style_cinema',
    matched: false,
  },
  'a deleted matching preset must leave the current preset unchanged',
);
assert.deepEqual(
  applyVisualStyleSelection(
    '特摄电影写实',
    ['style_cinema', 'style_tokusatsu_drama'],
    'style_cinema',
  ),
  {
    visualStyle: '特摄剧',
    stylePresetId: 'style_tokusatsu_drama',
    matched: true,
  },
  'the legacy 特摄电影写实 value must select the matching 特摄剧 preset',
);
assert.deepEqual(
  applyVisualStyleSelection('no_style', ['style_neutral'], 'style_cinema'),
  {
    visualStyle: '无附加风格',
    stylePresetId: 'style_neutral',
    matched: true,
  },
  'no_style must link to style_neutral when that preset is available',
);

const timestamp = 1_771_234_567_890;
const builtInPresets = createBuiltInVisualStylePresets(timestamp);
assert.equal(builtInPresets.length, 37, 'the catalog must build exactly 37 StylePreset objects');
assert.deepEqual(
  builtInPresets.map(({ id, name, category }) => [id, name, category]),
  definitions.map(({ stylePresetId, name, category }) => [stylePresetId, name, category]),
  'built-in StylePreset metadata must map one-to-one to the visual-style catalog',
);
assert.ok(builtInPresets.every(({ updatedAt }) => updatedAt === timestamp), 'all presets must use the supplied timestamp');
for (const preset of builtInPresets) {
  for (const field of ['visual', 'camera', 'lighting', 'sound'] as const) {
    assert.ok(preset[field].trim(), `${preset.name} built-in ${field} rule must be non-empty`);
  }
}

const legacyPresetIds = new Set(['style_cinema', 'style_wuxia', 'style_3d', 'style_suspense']);
assert.equal(NEW_ANIME_VISUAL_STYLE_PRESET_IDS.length, 8, 'exactly 8 anime preset IDs must be new in this release');
assert.equal(Object.isFrozen(NEW_ANIME_VISUAL_STYLE_PRESET_IDS), true, 'the new anime preset ID list must be immutable at runtime');
assertUnique(NEW_ANIME_VISUAL_STYLE_PRESET_IDS, 'new anime preset id');
assert.deepEqual(
  NEW_ANIME_VISUAL_STYLE_PRESET_IDS,
  [
    'style_tv_anime_cel',
    'style_shonen_action_anime',
    'style_shojo_soft_anime',
    'style_anime_illustration_paint',
    'style_toon_3d_anime',
    'style_stylized_3d_cartoon',
    'style_game_cg_anime',
    'style_chibi_3d_cute',
  ],
  'the additive anime migration list must contain every new anime style exactly once',
);
assert.equal(NEW_VISUAL_STYLE_PRESET_IDS.length, 33, 'exactly 33 preset IDs must be new');
assert.equal(Object.isFrozen(NEW_VISUAL_STYLE_PRESET_IDS), true, 'the new preset ID list must be immutable at runtime');
assertUnique(NEW_VISUAL_STYLE_PRESET_IDS, 'new preset id');
assert.ok(
  NEW_VISUAL_STYLE_PRESET_IDS.every((id) => !legacyPresetIds.has(id)),
  'the four legacy preset IDs must not be marked as new',
);
assert.deepEqual(
  NEW_VISUAL_STYLE_PRESET_IDS,
  expectedMappings.map(([, , presetId]) => presetId).filter((id) => !legacyPresetIds.has(id)),
  'the new preset ID list must contain every non-legacy catalog preset exactly once',
);

console.log('visual styles catalog tests passed');
