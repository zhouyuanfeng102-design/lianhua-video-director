import assert from 'node:assert/strict';
import { buildPromptPlan, buildShots } from '../src/promptEngine';
import { defaultConverterPresets, defaultRuleSets, defaultStylePresets } from '../src/storage';
import type { Scene } from '../src/types';

interface DirectorStylePreset {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly summary: string;
  readonly scene: string;
}

interface DirectorStylesModule {
  readonly directorStyleCategories: readonly string[];
  readonly directorStylePresets: readonly DirectorStylePreset[];
  filterDirectorStylePresets(category: string): readonly DirectorStylePreset[];
  resolveDirectorStylePreset(id: string): DirectorStylePreset;
  selectDirectorStyleForCategory(currentId: string, category: string): string;
  formatDirectorStyleSummary(preset: DirectorStylePreset): string;
}

const modulePath = '../src/' + 'directorStyles';
const maybeModule = await import(modulePath).catch(() => ({})) as Partial<DirectorStylesModule>;

assert.equal(
  typeof maybeModule.filterDirectorStylePresets,
  'function',
  'director presets need a behavior-level catalog API for category filtering',
);
assert.equal(typeof maybeModule.resolveDirectorStylePreset, 'function');
assert.equal(typeof maybeModule.selectDirectorStyleForCategory, 'function');
assert.equal(typeof maybeModule.formatDirectorStyleSummary, 'function');
assert.ok(Array.isArray(maybeModule.directorStyleCategories));
assert.ok(Array.isArray(maybeModule.directorStylePresets));

const catalog = maybeModule as DirectorStylesModule;
assert.ok(
  catalog.directorStyleCategories.includes('特摄'),
  'the director category selector must expose 特摄',
);

const tokusatsuPresets = catalog.filterDirectorStylePresets('特摄');
assert.deepEqual(
  tokusatsuPresets.map(({ id, name }) => [id, name]),
  [
    ['koichi_sakamoto', '坂本浩一'],
    ['kiyotaka_taguchi', '田口清隆'],
    ['keita_amemiya', '雨宫庆太'],
    ['osamu_kaneda', '金田治'],
  ],
  '特摄 filtering must expose the four representative director presets in a stable order',
);
assert.ok(
  tokusatsuPresets.every(({ category }) => category === '特摄'),
  'the 特摄 result must not leak presets from another category',
);

assert.equal(
  catalog.selectDirectorStyleForCategory('kiyotaka_taguchi', '特摄'),
  'kiyotaka_taguchi',
  'changing filters must preserve a selection that remains visible',
);
assert.equal(
  catalog.selectDirectorStyleForCategory('christopher_nolan', '特摄'),
  'koichi_sakamoto',
  'changing to 特摄 must select its first valid preset when the old selection is hidden',
);

const observableAnchors = new Map<string, readonly string[]>([
  ['koichi_sakamoto', ['攻防轴线', '低机位跟拍', '威亚', '实景爆破']],
  ['kiyotaka_taguchi', ['地面视角', '皮套表演', '微缩城市', '数字合成']],
  ['keita_amemiya', ['装甲英雄', '做旧金属', '烟雾', '逆光']],
  ['osamu_kaneda', ['英雄团队', '前中后景', '车辆', '连环实景爆破']],
]);

for (const preset of tokusatsuPresets) {
  const formatted = catalog.formatDirectorStyleSummary(preset);
  assert.match(formatted, /；适合：/u, `${preset.name} must contribute both craft direction and scene fit`);
  for (const anchor of observableAnchors.get(preset.id) || []) {
    assert.match(
      formatted,
      new RegExp(anchor, 'u'),
      `${preset.name} must describe the observable ${anchor} production characteristic`,
    );
  }
}

const selectedDirector = catalog.resolveDirectorStylePreset('kiyotaka_taguchi');
const selectedDirectorSummary = catalog.formatDirectorStyleSummary(selectedDirector);
const scene: Scene = {
  id: 'scene_tokusatsu_director',
  title: '巨兽逼近城市',
  content: '巨兽越过街区，防卫队员抬头确认其前进方向。',
  summary: '巨兽进入城市，防卫队确认威胁方向。',
  characterIds: [],
  locationIds: [],
  propIds: [],
  storyboardIds: [],
  createdAt: 1,
  updatedAt: 1,
};
const style = defaultStylePresets[0];
const ruleSet = defaultRuleSets[0];
const converter = defaultConverterPresets[0];
const shots = buildShots({
  scene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 2,
  pace: 'standard',
  camera: '稳定跟拍',
  lighting: '日间硬光',
  style,
  extra: '',
});
const plan = buildPromptPlan({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'action',
  inputMode: 'text',
  scene,
  globalLock: '',
  shots,
  assets: [],
  style,
  ruleSet,
  converter,
  extra: '',
  directorStyleName: selectedDirector.name,
  directorStyleSummary: selectedDirectorSummary,
  visualStyle: '特摄剧',
});

assert.match(plan.canonicalPrompt, /田口清隆/u, 'the selected director name must reach the real video prompt');
assert.match(plan.canonicalPrompt, /微缩城市/u, 'the selected director craft direction must reach the real video prompt');
assert.ok(
  plan.constraints.some((constraint) => constraint.includes(`导演说明：${selectedDirectorSummary}`)),
  'the selected director summary must remain an explicit prompt constraint',
);

console.log('director-style category, selection, and prompt-consumption checks passed');
