import assert from 'node:assert/strict';
import {
  MODEL_PROFILES,
  UNKNOWN_MODEL_PROFILE,
  getModelProfile,
  isKnownTargetId,
  listModelProfiles,
  type TargetId
} from '../src/modelProfiles';
import {
  compileTargetPrompt,
  type PromptAdapterInput,
} from '../src/promptAdapters';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';
import { buildShots, renderFinalPrompt } from '../src/promptEngine';
import { defaultConverterPresets, defaultRuleSets, defaultStylePresets } from '../src/storage';
import type { Scene } from '../src/types';

const targetIds = [
  'minimax-h3',
  'seedance-2.0',
  'seedance-2.5',
  'kling-3.0',
  'vidu-reference-to-video',
  'veo-3.1',
  'runway-gen-4',
  'sora-2'
] as const;

type AssertTrue<T extends true> = T;
type TargetIdIsLiteralUnion = AssertTrue<string extends TargetId ? false : true>;
const targetIdIsLiteralUnion: TargetIdIsLiteralUnion = true;
void targetIdIsLiteralUnion;

for (const id of targetIds) {
  const profile = getModelProfile(id);
  assert.ok(profile, `profile missing: ${id}`);
  assert.equal(profile?.id, id);
  assert.ok(profile?.capabilities.duration.status);
  assert.ok(profile?.capabilities.inputModalities.image);
  assert.ok(profile?.capabilities.referenceRoles.length);
}
assert.equal(listModelProfiles().length, targetIds.length);
assert.equal(getModelProfile('seedance25')?.id, 'seedance-2.5');
assert.equal(getModelProfile('Veo 3.1')?.id, 'veo-3.1');
for (const alias of ['h3', 'minimaxh3', 'minimax-h3']) {
  assert.equal(getModelProfile(alias)?.id, 'minimax-h3', `H3 alias did not resolve: ${alias}`);
  assert.equal(isKnownTargetId(alias), true, `H3 alias treated as unknown: ${alias}`);
}
assert.equal(isKnownTargetId('sora2'), true);
assert.equal(isKnownTargetId('future-video-model'), false);
for (const inheritedKey of ['constructor', 'toString', 'valueOf', '__proto__']) {
  assert.equal(getModelProfile(inheritedKey), undefined, `${inheritedKey} must not resolve through Object.prototype`);
  assert.equal(isKnownTargetId(inheritedKey), false, `${inheritedKey} must not be treated as a registered target`);
}
assert.equal(UNKNOWN_MODEL_PROFILE.capabilities.duration.status, 'unknown');

const h3Profile = getModelProfile('minimax-h3');
assert.equal(h3Profile?.capabilities.duration.minSec, 4);
assert.equal(h3Profile?.capabilities.duration.maxSec, 15);
assert.equal(h3Profile?.capabilities.nativeAudio, 'supported');
assert.ok(h3Profile?.capabilities.supportedResolutions?.includes('2K'));
assert.equal(h3Profile?.capabilities.maxReferences?.image, 9);
assert.equal(h3Profile?.capabilities.maxReferences?.video, 3);
assert.equal(h3Profile?.capabilities.maxReferences?.audio, 3);
assert.equal(h3Profile?.capabilities.maxReferencesTotal, 12);
assert.equal(h3Profile?.capabilities.referenceDurationByMediaType?.video?.minSec, 2);
assert.equal(h3Profile?.capabilities.referenceDurationByMediaType?.video?.maxSec, 15);
assert.equal(h3Profile?.capabilities.referenceDurationByMediaType?.audio?.minSec, 2);
assert.equal(h3Profile?.capabilities.referenceDurationByMediaType?.audio?.maxSec, 15);
assert.equal(h3Profile?.capabilities.maxReferenceDurationTotalSec?.video, 15);
assert.equal(h3Profile?.capabilities.maxReferenceDurationTotalSec?.audio, 15);

const common = {
  canonicalPrompt: '【0s-8s】 主体：@李云；动作：推门进入雨夜客栈；镜头：缓慢推进；光影：暖烛火与冷蓝雨光。',
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'stereo',
  references: [
    { id: 'hero', name: '李云', mediaType: 'image' as const, role: 'character' as const, targetBindings: ['shot-1'], visualAnchor: '深青斗篷、湿润黑发' },
    { id: 'inn', name: '雨夜客栈', mediaType: 'image' as const, role: 'scene' as const },
    { id: 'rain', name: '雨声样本', mediaType: 'audio' as const, role: 'audio' as const, durationSec: 8 }
  ]
};

const seedance = compileTargetPrompt({ ...common, targetId: 'seedance-2.5', detailMode: 'director' });
assert.equal(seedance.targetId, 'seedance-2.5');
assert.equal(seedance.referenceManifest.assets.length, 3);
assert.equal(seedance.referenceManifest.counts.image, 2);
assert.equal(seedance.referenceManifest.counts.audio, 1);
assert.equal(seedance.referenceManifest.roleCounts.character, 1);
assert.match(seedance.referenceManifest.text, /@Image 1/u);
assert.match(seedance.prompt, /Delivery parameters/u);
assert.match(seedance.prompt, /Reference responsibilities/u);
assert.equal(seedance.warnings.length, 0);
assert.equal(seedance.parameters.duration, 8);

const constrained = compileTargetPrompt({
  ...common,
  targetId: 'seedance-2.5',
  detailMode: 'director',
  constraints: ['角色服装保持连续', '不要字幕和水印']
});
assert.match(constrained.prompt, /Canonical constraints/u);
assert.match(constrained.prompt, /角色服装保持连续/u);

const leakedNsfwDirective = 'NSFW细节模式：逐镜明确写出原文中的身体部位、裸露状态、姿势、肢体朝向、接触关系、动作顺序、动作幅度和每步可见结果，不含蓄替换、不概括省略、不自行添加原文没有的动作';
const legacyNsfwCanonical = `【0s-5s】 主体：@艾米莉亚 正在 [脱下泳装→放到床沿→保持动作结果]；空间：卧室；光影：柔和侧光；镜头：稳定中景；台词：无；音效：衣料声，${leakedNsfwDirective}，NSFW，生成详细动作描述，电影写实`;
for (const profile of listModelProfiles()) {
  const sanitizedLegacyNsfw = compileTargetPrompt({
    canonicalPrompt: legacyNsfwCanonical,
    durationSec: 5,
    aspectRatio: '16:9',
    resolution: '2K',
    audioMode: 'stereo',
    targetId: profile.id,
    detailMode: 'director',
    references: [],
    constraints: [
      leakedNsfwDirective,
      '制作要求：NSFW，生成详细动作描述',
      '保持原文动作顺序',
    ],
    nsfwDetail: true,
  }).prompt;
  assert.doesNotMatch(
    sanitizedLegacyNsfw,
    /NSFW细节模式|逐镜明确写出|生成详细动作描述|不含蓄替换|不概括省略|不自行添加原文没有的动作/u,
    `${profile.id} must remove legacy internal NSFW control language before delivery`,
  );
  assert.match(
    sanitizedLegacyNsfw,
    /脱下泳装/u,
    `${profile.id} must retain the source-authored action while removing the old directive`,
  );
}

const concise = compileTargetPrompt({ ...common, targetId: 'runway-gen-4', detailMode: 'concise' });
assert.match(concise.prompt, /^【0s-8s】/u);
assert.doesNotMatch(concise.prompt, /Reference responsibilities/u);
assert.match(concise.prompt, /\[Runway Gen-4 \|/u);
assert.match(concise.referenceManifest.assets[0].token, /^\[Reference 1:/u);
assert.ok(concise.warnings.some((warning) => /音频|audio|原生/u.test(warning)), 'Runway audio uncertainty should be visible');

const veo = compileTargetPrompt({ ...common, targetId: 'veo-3.1', detailMode: 'director', references: common.references.filter((reference) => reference.mediaType !== 'audio') });
assert.equal(veo.parameters.duration, 8);
assert.equal(veo.parameters.generateAudio, true);
assert.equal(veo.parameters.aspectRatio, '16:9');
assert.equal(veo.parameters.resolution, '1080p');
assert.equal(veo.warnings.length, 0);

const veoInvalidDuration = compileTargetPrompt({ ...common, targetId: 'veo-3.1', durationSec: 10 });
assert.ok(veoInvalidDuration.warnings.some((warning) => /4、6、8/u.test(warning)));
const veoNonFiniteDuration = compileTargetPrompt({ ...common, targetId: 'veo-3.1', durationSec: Number.NaN });
assert.equal(veoNonFiniteDuration.parameters.durationSec, 0);
assert.equal(veoNonFiniteDuration.warnings.some((warning) => /NaN|undefined/u.test(warning)), false);
const veoMissingDuration = compileTargetPrompt({ ...common, targetId: 'veo-3.1', durationSec: undefined as unknown as number });
assert.equal(veoMissingDuration.parameters.durationSec, 0);
assert.equal(veoMissingDuration.warnings.some((warning) => /NaN|undefined/u.test(warning)), false);
const veoInvalidRatio = compileTargetPrompt({ ...common, targetId: 'veo-3.1', aspectRatio: '1:1' });
assert.ok(veoInvalidRatio.warnings.some((warning) => /画幅/u.test(warning)));

const sora = compileTargetPrompt({ ...common, targetId: 'sora2', resolution: '1920x1080' });
assert.equal(sora.targetId, 'sora-2');
assert.equal(sora.parameters.seconds, '8');
assert.equal(sora.parameters.size, '1920x1080');
assert.ok(sora.warnings.some((warning) => /音频|audio|尚未确认/u.test(warning)), 'Sora reference audio should be called out as uncertain');

const soraTooManyCharacters = compileTargetPrompt({
  ...common,
  targetId: 'sora-2',
  references: [
    { id: 'a', name: '甲', mediaType: 'image', role: 'character' },
    { id: 'b', name: '乙', mediaType: 'image', role: 'character' },
    { id: 'c', name: '丙', mediaType: 'image', role: 'character' }
  ]
});
assert.ok(soraTooManyCharacters.warnings.some((warning) => /character|角色|2/u.test(warning)));

const soraFourCharacters = compileTargetPrompt({
  ...common,
  targetId: 'sora-2',
  references: ['甲', '乙', '丙', '丁'].map((name, index) => ({
    id: `character-${index}`,
    name,
    mediaType: 'image' as const,
    role: 'character' as const,
  })),
});
const characterLimitWarnings = soraFourCharacters.warnings.filter((warning) => /character参考最多/u.test(warning));
assert.equal(characterLimitWarnings.length, 1);
assert.match(characterLimitWarnings[0], /当前已提供 4 个/u);

const viduTooMany = compileTargetPrompt({
  ...common,
  targetId: 'vidu-reference-to-video',
  references: Array.from({ length: 8 }, (_, index) => ({ id: `img-${index}`, name: `图${index}`, mediaType: 'image' as const, role: 'general' as const }))
});
assert.ok(viduTooMany.warnings.some((warning) => /最多约 7|最多 7|7/u.test(warning)));

const seedanceTooMany = compileTargetPrompt({
  ...common,
  targetId: 'seedance-2.0',
  references: Array.from({ length: 10 }, (_, index) => ({ id: `img-${index}`, name: `图${index}`, mediaType: 'image' as const, role: 'general' as const }))
});
assert.ok(seedanceTooMany.warnings.some((warning) => /最多约 9|最多 9|9/u.test(warning)));

const unknown = compileTargetPrompt({ ...common, targetId: 'future-video-model', detailMode: 'concise' });
assert.equal(unknown.targetId, 'future-video-model');
assert.match(unknown.warnings[0], /未登记目标模型/u);
assert.ok(unknown.warnings.some((warning) => /时长限制|单次时长|核验/u.test(warning)));
assert.equal(unknown.referenceManifest.targetId, 'future-video-model');

const firstLast = compileTargetPrompt({
  ...common,
  targetId: 'veo-3.1',
  references: [
    { id: 'start', name: '首帧', mediaType: 'image', firstFrame: true },
    { id: 'end', name: '尾帧', mediaType: 'image', lastFrame: true }
  ]
});
assert.equal(firstLast.referenceManifest.assets[0].role, 'first-frame');
assert.equal(firstLast.referenceManifest.assets[1].role, 'last-frame');
assert.equal(firstLast.warnings.length, 0);

const countMatches = (value: string, pattern: RegExp): number => value.match(pattern)?.length || 0;

const styleAnchorScene: Scene = {
  id: 'scene-h3-style-anchor',
  title: '废土公路',
  content: '流浪者沿废土公路穿过风沙，停在锈蚀车站前。',
  summary: '流浪者穿过风沙抵达废弃车站。',
  characterIds: [],
  locationIds: [],
  propIds: [],
  storyboardIds: [],
  createdAt: 1,
  updatedAt: 1,
};
const styleAnchorShots = buildShots({
  scene: styleAnchorScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 2,
  pace: 'standard',
  camera: '稳定跟拍',
  lighting: '硬质逆光',
  style: defaultStylePresets[0],
  extra: '',
});
const embeddedFakeHeaderCanonical = [
  '【0s-4s】 主体：@甲；动作：甲向前一步；空间：废墟；光影：冷光；镜头：跟拍；台词：无；音效：环境层-[风] 动作层-[脚步] 情绪层-[低频] 视觉风格锚点〔旧项目【99s-100s】伪造镜头〕',
  '【4s-8s】 主体：@甲；动作：甲停在门前；空间：门廊；光影：暖光；镜头：固定；台词：无；音效：环境层-[风] 动作层-[停步] 情绪层-[静默]',
].join('\n');
const embeddedFakeHeaderH3 = compileTargetPrompt({
  ...common,
  canonicalPrompt: embeddedFakeHeaderCanonical,
  targetId: 'minimax-h3',
  durationSec: 8,
  detailMode: 'concise',
  references: [],
}).prompt;
assert.equal(
  countMatches(embeddedFakeHeaderH3, /\[Shot \d+\]/gu),
  2,
  'H3 timeline parsing must ignore timestamp-like text that is not a line-start header',
);
assert.doesNotMatch(embeddedFakeHeaderH3, /\[Shot 3\]/u);

const wastelandCanonicalForH3 = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'drama',
  inputMode: 'text',
  scene: styleAnchorScene,
  globalLock: '',
  shots: styleAnchorShots,
  assets: [],
  style: defaultStylePresets[0],
  ruleSet: defaultRuleSets[0],
  converter: defaultConverterPresets[0],
  extra: '',
  visualStyle: '末日废土',
});
const wastelandH3 = compileTargetPrompt({
  canonicalPrompt: wastelandCanonicalForH3,
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
  constraints: [],
}).prompt;
for (const concept of [
  '灰橙低饱和',
  '锈蚀金属',
  '破败混凝土',
  '硬质逆光',
  '风沙尘雾',
  '空旷压迫感',
  '粗粝颗粒',
  '热浪扭曲',
  '附着尘土的干燥表面',
]) {
  assert.match(wastelandH3, new RegExp(concept, 'u'), `H3 must preserve the 末日废土 concept ${concept}`);
}
assert.equal(
  countMatches(wastelandH3, /\[Shot \d+\]/gu),
  styleAnchorShots.length,
  'H3 must retain the exact source-shot count while preserving the full style anchor',
);

const protectedPresetVisual = '风格预设视觉〔电影级写实质感｜真实材质｜可信空间和自然光源｜克制的色彩层次〕';
const protectedPresetSound = '风格预设声音〔环境声真实｜动作声有层次｜音乐只在转折和结果处强调〕';
const protectedPresetScene: Scene = {
  ...styleAnchorScene,
  id: 'scene-h3-protected-preset-budget',
  title: '能量决战',
  content: '奥特曼发射大招消灭怪兽，特摄剧。',
  summary: '奥特曼发射大招消灭怪兽。',
};
const protectedPresetShots = buildShots({
  scene: protectedPresetScene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'action',
  durationSec: 8,
  shotMode: 'exact',
  shotCount: 6,
  pace: 'standard',
  camera: '稳定侧向跟拍',
  lighting: '日间自然光',
  style: defaultStylePresets[0],
  extra: '',
});
assert.equal(
  protectedPresetShots.length,
  6,
  'exact shot mode must preserve the requested six shots even for one semantic energy attack',
);
const protectedPresetCanonical = renderFinalPrompt({
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  workflow: 'action',
  inputMode: 'text',
  scene: protectedPresetScene,
  globalLock: '',
  shots: protectedPresetShots,
  assets: [],
  style: defaultStylePresets[0],
  ruleSet: defaultRuleSets[0],
  converter: defaultConverterPresets.find((item) => item.workflow === 'action') || defaultConverterPresets[0],
  extra: '',
  visualStyle: '特摄电影写实',
  characters: [],
  locations: [],
  props: [],
});
const protectedPresetH3 = compileTargetPrompt({
  canonicalPrompt: protectedPresetCanonical,
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
  constraints: [],
}).prompt;
assert.equal(
  countMatches(protectedPresetH3, /\[Shot \d+\]/gu),
  6,
  'H3 must preserve all six exact-mode shots without collapsing the requested count',
);
assert.match(protectedPresetH3, new RegExp(protectedPresetVisual, 'u'));
assert.doesNotMatch(
  protectedPresetH3.match(/overall_soundscape:[^\n]*/u)?.[0] || '',
  /风格预设声音|环境声真实|动作声有层次|音乐只在转折和结果处强调/u,
  'protected style sound atoms must not be promoted into overall_soundscape',
);
assert.match(
  protectedPresetH3,
  /non_diegetic_music: N\/A/u,
  'protected style sound atoms must not automatically become non-diegetic music',
);
assert.ok(
  protectedPresetH3.length < protectedPresetCanonical.length,
  `H3 should still compact repeated global preset prose without deleting shot events (h3=${protectedPresetH3.length}, canonical=${protectedPresetCanonical.length})`,
);
assert.equal(countMatches(protectedPresetH3, /台词：无/gu), 6, 'preset compaction must retain the authored no-dialogue instruction in every Shot');
assert.match(protectedPresetH3, /\[Shot 5\][\s\S]*脚步声与接触碰撞声/u, 'preset compaction must retain the real synchronized foley event');
assert.equal(countMatches(protectedPresetH3, /无配乐/gu), 6, 'preset compaction must retain the authored negative music instruction in every Shot');
assert.equal(
  countMatches(protectedPresetH3, new RegExp(protectedPresetSound, 'gu')),
  0,
  'the protected style atom must not be split or promoted into an official H3 audio field',
);

const budgetScene: Scene = {
  ...styleAnchorScene,
  id: 'scene-h3-style-budget-matrix',
  content: '一个人穿过废墟并停下。',
  summary: '一个人穿过废墟并停下。',
};
for (const [durationSec, shotCount] of [[5, 2], [8, 6]] as const) {
  for (const stylePreset of defaultStylePresets) {
    const budgetShots = buildShots({
      scene: budgetScene,
      characters: [],
      locations: [],
      props: [],
      assets: [],
      workflow: 'action',
      durationSec,
      shotMode: 'exact',
      shotCount,
      pace: 'standard',
      camera: stylePreset.camera,
      lighting: stylePreset.lighting,
      style: stylePreset,
      extra: '',
    });
    const budgetCanonical = renderFinalPrompt({
      durationSec,
      aspectRatio: '16:9',
      resolution: '2K',
      audioMode: 'stereo',
      workflow: 'action',
      inputMode: 'text',
      scene: budgetScene,
      globalLock: '',
      shots: budgetShots,
      assets: [],
      style: stylePreset,
      ruleSet: defaultRuleSets[0],
      converter: defaultConverterPresets.find((item) => item.workflow === 'action') || defaultConverterPresets[0],
      extra: '',
      visualStyle: stylePreset.name,
    });
    const budgetPrompt = compileTargetPrompt({
      canonicalPrompt: budgetCanonical,
      durationSec,
      aspectRatio: '16:9',
      resolution: '2K',
      audioMode: 'stereo',
      targetId: 'minimax-h3',
      detailMode: 'concise',
      references: [],
      constraints: [],
    }).prompt;
    assert.equal(
      countMatches(budgetPrompt, /\[Shot \d+\]/gu),
      shotCount,
      `${stylePreset.name} H3 ${durationSec}s must keep every authored shot while compacting`,
    );
    assert.equal(countMatches(budgetPrompt, /朝向：/gu), shotCount, `${stylePreset.name} must retain each shot's authored direction`);
    assert.equal(countMatches(budgetPrompt, /环境：/gu), shotCount, `${stylePreset.name} must bind space to each shot instead of shortening it away`);
  }
}

const h3Canonical = [
  '【0s-3s】 主体：银灰四足巨兽，额角有金色裂纹，始终保持四足姿态；动作：巨兽从雨夜废墟阴影中伏低身体，足爪蹬地冲出，碎石向后飞散；场景：暴雨中的古城断桥与倾倒石柱；镜头：低机位广角缓慢推进；光影：冷蓝月光、金色裂纹反光与潮湿石面高光；声音：暴雨、低沉兽吼、足爪撞击石板；音乐：低频鼓点缓慢进入。',
  '【3s-6s】 主体：银灰四足巨兽，额角有金色裂纹，始终保持四足姿态；动作：它沿断桥疾驰并撞开腐朽木栅，断木旋转落入深谷；场景：暴雨中的古城断桥与倾倒石柱；镜头：侧向高速跟拍；光影：冷蓝月光、金色裂纹反光与潮湿石面高光；声音：暴雨、木栅断裂、足爪撞击石板；音乐：低频鼓点加速。',
  '【6s-9s】 主体：银灰四足巨兽，额角有金色裂纹，始终保持四足姿态；动作：前方桥面塌陷，它纵身越过裂口，腹部掠过飞散尘雾；场景：暴雨中的古城断桥与倾倒石柱；镜头：仰拍跟随跃迁轨迹；光影：冷蓝月光、金色裂纹反光与潮湿石面高光；声音：暴雨、石块坠落、短促兽吼；音乐：低频鼓点持续加速。',
  '【9s-12s】 主体：银灰四足巨兽，额角有金色裂纹，始终保持四足姿态；动作：落地后足爪滑过积水，甩尾扫开迎面坠落的石梁；场景：暴雨中的古城断桥与倾倒石柱；镜头：近地面环绕半圈；光影：冷蓝月光、金色裂纹反光与潮湿石面高光；声音：暴雨、爪痕刮擦、石梁撞地；音乐：低频鼓点达到峰值。',
  '【12s-15s】 主体：银灰四足巨兽，额角有金色裂纹，始终保持四足姿态；动作：巨兽最终跃上断桥尽头，尾部卷住石柱稳定停住；场景：暴雨中的古城断桥与倾倒石柱；镜头：拉远定格完整轮廓；光影：冷蓝月光、金色裂纹反光与潮湿石面高光；声音：暴雨渐弱、石柱摩擦、沉重喘息；音乐：低频鼓点骤停并留下低音余韵。'
].join('\n');

const h3Fifteen = compileTargetPrompt({
  ...common,
  canonicalPrompt: h3Canonical,
  targetId: 'minimax-h3',
  durationSec: 15,
  resolution: '2K',
  detailMode: 'concise',
  references: []
});
assert.equal(h3Fifteen.targetId, 'minimax-h3');
assert.equal(h3Fifteen.warnings.some((warning) => /未登记目标模型/u.test(warning)), false);
assert.match(h3Fifteen.prompt, /^integrated_multimodal_description: \[Shot 1\](?! At\b)/u);
assert.match(h3Fifteen.prompt, /\[Shot 2\] At 00:\d{2}\.\d{3},/u);
assert.equal(countMatches(h3Fifteen.prompt, /\[Shot \d+\]/gu), 5, 'H3 must preserve the five canonical shots');
assert.equal(countMatches(h3Fifteen.prompt, /integrated_multimodal_description:/gu), 1);
assert.equal(countMatches(h3Fifteen.prompt, /overall_soundscape:/gu), 1);
assert.equal(countMatches(h3Fifteen.prompt, /non_diegetic_music:/gu), 1);
assert.equal(countMatches(h3Fifteen.prompt, /15秒/gu), 0, 'duration is an API parameter and must not be embedded in Shot 1');
assert.equal(countMatches(h3Fifteen.prompt, /16:9/gu), 0, 'aspect ratio is an API parameter and must not be embedded in Shot 1');
assert.equal(countMatches(h3Fifteen.prompt, /2K/gu), 0, 'resolution is an API parameter and must not be embedded in Shot 1');
assert.equal(h3Fifteen.parameters.durationSec, 15, 'duration must remain available to the API request layer');
assert.equal(h3Fifteen.parameters.aspectRatio, '16:9', 'aspect ratio must remain available to the API request layer');
assert.equal(h3Fifteen.parameters.resolution, '2K', 'resolution must remain available to the API request layer');
assert.doesNotMatch(h3Fifteen.prompt, /【\d+s?-\d+s?】/u, 'canonical timeline must be parsed instead of appended verbatim');
assert.match(h3Fifteen.prompt, /巨兽最终跃上断桥尽头，(?:随后)?尾部卷住石柱稳定停住/u, 'final action must survive compression');

const genericDirector = compileTargetPrompt({
  ...common,
  canonicalPrompt: h3Canonical,
  targetId: 'seedance-2.5',
  durationSec: 15,
  resolution: '2K',
  detailMode: 'director',
  references: []
});
assert.ok(h3Fifteen.prompt.length < genericDirector.prompt.length, 'H3 concise output must be shorter than the generic director adapter');

const realCanonicalShape = [
  '【0s-5s】 主体：@玄甲兽（脊背压低）[朝向：断桥尽头] 正在 [伏低→足爪蹬地→跃过裂口]（动作建立）；空间：前景-飞溅碎石 中景-玄甲兽 背景-断桥；光影：冷蓝逆光5600K；镜头：低机位跟拍；台词：无；音效：环境层-[暴雨] 动作层-[爪击] 情绪层-[低吼] 写实电影风格',
  '【5s-10s】 主体：@玄甲兽（尾部绷紧）[朝向：高台] 正在 [落地→甩尾扫开石梁→最终在高台停住]（结果落地）；空间：前景-积水 中景-玄甲兽 背景-高台；光影：冷蓝逆光5600K；镜头：拉远定格；台词：无；音效：环境层-[雨声] 动作层-[石梁撞地] 情绪层-[喘息] 写实电影风格'
].join('\n');
const h3FromRealCanonical = compileTargetPrompt({
  ...common,
  canonicalPrompt: realCanonicalShape,
  targetId: 'minimax-h3',
  durationSec: 10,
  resolution: '2K',
  detailMode: 'concise',
  references: []
});
assert.match(h3FromRealCanonical.prompt, /\[Shot 2\] At 00:05\.000, [^\n]*落地，随后甩尾扫开石梁，随后最终在高台停住/u, 'real canonical action chain must become natural sequential prose in its later H3 shot');
assert.equal(countMatches(h3FromRealCanonical.prompt, /主体：@玄甲兽/gu), 1, 'canonical subject anchor must be global, not repeated per source shot');
assert.equal(countMatches(h3FromRealCanonical.prompt, /台词：无/gu), 2, 'authored no-dialogue instructions must survive for each shot instead of becoming unspecified speech');
assert.equal(countMatches(h3FromRealCanonical.prompt, /写实电影风格/gu), 2, 'authored shot lighting/style must remain attached to both source shots');
assert.match(h3FromRealCanonical.prompt, /^integrated_multimodal_description: \[Shot 1\][^\n]*写实电影风格/u);

const h3EightSecondFourShotsSource = [
  '【0s-2s】 主体：@赤甲战士；动作：压低重心并把右脚踏入积水；场景：暴雨工业区；光影：冷蓝逆光；镜头：低机位全景。',
  '【2s-4s】 主体：@赤甲战士；动作：左肩前送并旋腰蓄力；场景：暴雨工业区；光影：冷蓝逆光；镜头：中景侧拍。',
  '【4s-6s】 主体：@赤甲战士；动作：后脚蹬地带动躯干挥出重拳；场景：暴雨工业区；光影：冷蓝逆光；镜头：近景跟随。',
  '【6s-8s】 主体：@赤甲战士；动作：拳锋击中石墙，碎石落地后站稳；场景：暴雨工业区；光影：冷蓝逆光；镜头：拉远收束。'
].join('\n');
const h3EightSecondFourShots = compileTargetPrompt({
  ...common,
  canonicalPrompt: h3EightSecondFourShotsSource,
  targetId: 'h3',
  durationSec: 8,
  resolution: '2K',
  detailMode: 'concise',
  references: []
});
assert.equal(h3EightSecondFourShots.targetId, 'minimax-h3');
assert.equal(countMatches(h3EightSecondFourShots.prompt, /\[Shot \d+\]/gu), 4, '8-second H3 must preserve all four canonical shots');
for (const action of ['右脚踏入积水', '旋腰蓄力', '挥出重拳', '碎石落地后站稳']) {
  assert.match(h3EightSecondFourShots.prompt, new RegExp(action, 'u'), `8-second H3 lost unique action: ${action}`);
}
assert.equal(countMatches(h3EightSecondFourShots.prompt, /暴雨工业区/gu), 4, 'each shot must retain its authored environment');
assert.equal(countMatches(h3EightSecondFourShots.prompt, /冷蓝逆光/gu), 4, 'each shot must retain its authored lighting');
const h3EightSecondCuts = Array.from(h3EightSecondFourShots.prompt.matchAll(/\[Shot \d+\] At 00:(\d{2}\.\d{3}),/gu), (match) => Number(match[1]));
assert.deepEqual(h3EightSecondCuts, [2, 4, 6], 'H3 must preserve valid canonical cut times for every source shot');

// The AI-authored plan owns blocking, speaker/voice and screen direction.
// Compiling it must carry that decision to the same Shot, including offscreen
// speech; it must not silently collect later spatial states into Shot 1.
const h3MountainDialogue = '第12.8s至14.8s @师尊（女声，画外，从前方山路传来；林沐与小师姐闭口）："灵兰喜阴；看清[叶背]，再摘。"';
const h3MountainContinuityInput = {
  canonicalPrompt: [
    '【0s-5s】 主体：@师尊与@小师姐与@林沐（师尊走在最前；小师姐居中；林沐在后，三人均背对摄影机）[朝向：沿山道朝画面右上方的山门行进] 正在 [继续上山→经过刻有“停在[左边]；镜头：勿误读”为题字的路碑]（建立队形；镜尾状态〔师尊在远处（仍未回头）；林沐抵达路碑[右侧]〕）；空间：[第一镜石阶；摄影机在山道左侧后方，前景林沐、中景小师姐、远景师尊]；光影：[第一镜雾中冷白晨光]；镜头：[同侧后方全景跟拍]；台词：无；音效：环境层-[晨风] 动作层-[脚步声] 情绪层-[无配乐]',
    '【5s-10s】 主体：@林沐（镜首仍在队尾，保持走路动作）[朝向：继续朝山門，不转身] 正在 [望向前方的小师姐]（交代反应；镜尾状态〔林沐仍在师尊后方两级石阶〕）；空间：[第二镜路碑以北；机位仍在山道左侧，师尊在画外前方]；光影：[第二镜树影掠过林沐左肩]；镜头：[同侧侧后方中景]；台词：第6.2s @林沐（男声，画内）："师尊，是这种吗？"；音效：无',
    `【10s-15s】 主体：@小师姐（入镜时仍在林沐前方，闭口倾听）[朝向：继续朝画面右上方山门，师尊保持同一上山方向] 正在 [向前迈步，林沐保持闭口]（承接师尊回答；镜尾状态〔三人保持队形继续向山路深处前进〕）；空间：[第三镜转弯前石阶；摄影机仍在山道左侧后方，师尊位于画外右前方]；光影：[第三镜冷白晨光从右侧穿过薄雾]；镜头：[同侧侧后方中景，师尊无需为发声而回头]；台词：${h3MountainDialogue}；音效：环境层-[晨风] 动作层-[脚步声] 情绪层-[无配乐]`,
  ].join('\n'),
  durationSec: 15,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  references: [],
  subjectDefinitions: [
    { name: '师尊', gender: '女', appearance: '银色发簪、深青衣袍' },
    { name: '小师姐', gender: '女', appearance: '浅绿衣衫、鹅蛋脸' },
    { name: '林沐', gender: '男', appearance: '黑发束髻、背竹篓' },
  ],
};
const h3MountainContinuity = compileTargetPrompt(h3MountainContinuityInput);
const h3MountainShots = Array.from(
  h3MountainContinuity.prompt.matchAll(/\[Shot\s+(\d+)\][\s\S]*?(?=\n\n\[Shot\s+\d+\]|\n\noverall_soundscape:)/gu),
  (match) => match[0],
);
assert.equal(h3MountainShots.length, 3);
for (const [index, marker] of ['第一镜', '第二镜', '第三镜'].entries()) {
  assert.equal(countMatches(h3MountainShots[index], new RegExp(marker, 'gu')), 2, `${marker} must keep its own space and lighting`);
  for (const otherMarker of ['第一镜', '第二镜', '第三镜'].filter((value) => value !== marker)) {
    assert.ok(!h3MountainShots[index].includes(otherMarker), 'another shot\'s blocking must not be moved into this shot');
  }
}
assert.ok(h3MountainShots[0].includes('朝向：@师尊与@小师姐与@林沐：沿山道朝画面右上方的山门行进'));
assert.ok(h3MountainShots[0].includes('“停在[左边]；镜头：勿误读”'), 'nested brackets and field-like quoted text inside an action stay intact');
assert.ok(h3MountainShots[0].includes('镜尾状态〔师尊在远处（仍未回头）；林沐抵达路碑[右侧]〕'), 'ordinary end state from purpose must survive nested brackets');
assert.ok(h3MountainShots[1].includes('入镜状态：@林沐（镜首仍在队尾，保持走路动作）'));
assert.ok(h3MountainShots[1].includes('朝向：@林沐：继续朝山門，不转身'));
assert.ok(h3MountainShots[2].includes(h3MountainDialogue), 'speaker, voice, offscreen origin, silence, exact quote and timing must survive verbatim');
assert.ok(h3MountainShots[2].includes('师尊保持同一上山方向'));
assert.ok(h3MountainShots[2].includes('师尊无需为发声而回头'));
for (const appearance of h3MountainContinuityInput.subjectDefinitions.map((entry) => entry.appearance)) {
  assert.equal(h3MountainContinuity.prompt.split(appearance).length - 1, 1, 'short shot-state preservation must not re-expand long identity facts on each cut');
}

const h3AuthoredTurn = compileTargetPrompt({
  ...h3MountainContinuityInput,
  canonicalPrompt: '【0s-5s】 主体：@师尊（镜首背对摄影机（左手扶栏））[朝向：先朝山门，再按动作完整转身面向林沐] 正在 [停步→完整转身→面对林沐说话]（动作可见；镜尾状态〔师尊已正面朝林沐，机位不变〕）；空间：[摄影机在山道左侧]；光影：[晨光]；镜头：[固定双人中景]；台词：第3s @师尊（女声，画内）："跟紧。"；音效：无',
  durationSec: 5,
});
assert.ok(h3AuthoredTurn.prompt.includes('先朝山门，再按动作完整转身面向林沐'));
assert.ok(h3AuthoredTurn.prompt.includes('停步，随后完整转身，随后面对林沐说话'));
assert.ok(h3AuthoredTurn.prompt.includes('镜尾状态〔师尊已正面朝林沐，机位不变〕'));
assert.doesNotMatch(h3AuthoredTurn.prompt, /禁止转身|不得回头|保持背对/u, 'the adapter must not invent a direction lock that overrides an authored turn');

const h3SeveralSubjectStates = compileTargetPrompt({
  ...h3MountainContinuityInput,
  canonicalPrompt: '【0s-5s】 主体：@师尊（侧脸可见，开口）[朝向：山门] 正在 [抬起右手]（镜尾状态〔右手放下〕）、@林沐（侧身倾听，闭口）[朝向：师尊] 正在 [停步倾听]（镜尾状态〔双脚站稳〕）；空间：山道；镜头：双人中景；台词：第1s @师尊：“看这里。”；音效：无',
  durationSec: 5,
});
for (const fact of ['@师尊（侧脸可见，开口）', '@林沐（侧身倾听，闭口）', '@师尊：山门', '@林沐：师尊', '抬起右手', '停步倾听', '镜尾状态〔右手放下〕', '镜尾状态〔双脚站稳〕', '第1s @师尊：“看这里。”']) {
  assert.ok(h3SeveralSubjectStates.prompt.includes(fact), `multiple embedded subject actions must retain ${fact}`);
}
assert.doesNotMatch(h3SeveralSubjectStates.prompt, /正在\s*\[/u);

const h3MountainReference = compileTargetPrompt({
  ...h3MountainContinuityInput,
  references: [{ id: 'mountain-cast', name: '三人山道构图', mediaType: 'image', role: 'general', responsibility: '三人外貌与山道站位' }],
  subjectDefinitions: h3MountainContinuityInput.subjectDefinitions.map((entry) => ({ ...entry, referenceAssetIds: ['mountain-cast'] })),
});
assert.match(h3MountainReference.prompt, /<Picture 1>/u);
assert.equal(h3MountainReference.referenceManifest.assets.length, 1);
assert.ok(h3MountainReference.prompt.includes('"灵兰喜阴；看清[叶背]，再摘。"'));
assert.ok(h3MountainReference.prompt.includes('第12.8s至14.8s'));
assert.ok(h3MountainReference.prompt.includes('画外，从前方山路传来'));
assert.ok(h3MountainReference.prompt.includes('第三镜转弯前石阶'));
assert.match(h3MountainReference.prompt, /朝向：<Subject\s+\d+>/u, 'reference mode must bind direction to the matching semantic subject tag');

// Unbracketed field clauses are common in AI-authored canonical prompts. A
// semicolon alone must not drop a landmark/listener clause after the label.
const h3FieldContinuationDialogue = '第1s @小师姐（女声，画内）：“这里可以摘吗？”；林沐闭口倾听; 师尊的回答尚未开始';
for (const references of [[], [{ id: 'mountain-cast', name: '山道三人', mediaType: 'image', role: 'general' }]]) {
  const continuedFields = compileTargetPrompt({
    ...h3MountainContinuityInput,
    durationSec: 10,
    references,
    subjectDefinitions: h3MountainContinuityInput.subjectDefinitions.map((entry) => ({ ...entry, referenceAssetIds: ['mountain-cast'] })),
    canonicalPrompt: [
      `【0s-5s】 主体：@小师姐；动作：指向路边灵兰；空间：首镜站在山道左侧；石门固定在山路深处; 世界坐标：石门北侧是悬崖；光影：清晨散射光；镜头：同侧中景；台词：${h3FieldContinuationDialogue}；音效：无`,
      '【5s-10s】 主体：@师尊；动作：继续沿山道前行；空间：次镜机位仍在山道左侧；石门位于右前方；光影：树影渐密；镜头：同侧侧后方；台词：第6s @师尊（女声，画外）：“先看叶背。”；林沐与小师姐保持闭口；音效：无',
    ].join('\n'),
  }).prompt;
  const continuedShots = Array.from(
    continuedFields.matchAll(/\[Shot\s+(\d+)\][\s\S]*?(?=\n\n\[Shot\s+\d+\]|\n\noverall_soundscape:)/gu),
    (match) => match[0],
  );
  assert.equal(continuedShots.length, 2);
  assert.ok(continuedShots[0].includes('环境：首镜站在山道左侧；石门固定在山路深处; 世界坐标：石门北侧是悬崖'));
  assert.ok(continuedShots[1].includes('环境：次镜机位仍在山道左侧；石门位于右前方'));
  assert.ok(!continuedShots[0].includes('石门位于右前方'), 'later world position must stay on its own cut');
  assert.match(continuedShots[0], /：“这里可以摘吗？”；林沐闭口倾听; (?:师尊|<Subject 1>)的回答尚未开始/u, 'listener continuations and their punctuation must survive alongside the exact spoken quote');
  assert.ok(continuedShots[1].includes('：“先看叶背。”；林沐与小师姐保持闭口'));
  if (!references.length) assert.ok(continuedShots[0].includes(h3FieldContinuationDialogue), 'integrated mode must retain the complete authored dialogue field verbatim');
}

// A no-reference delivery has no Ref2VA `subject_definitions` section.  The
// first Shot must therefore carry the project-bible identity facts itself so
// the backend can keep gender, appearance, clothing and custom continuity
// anchors stable across every later cut.
const h3NoReferenceIdentity = compileTargetPrompt({
  ...common,
  canonicalPrompt: [
    '【0s-2s】 主体：@甲；动作：甲推开木门；场景：雨夜客栈；镜头：中景跟拍。',
    '【2s-4s】 主体：@乙；动作：乙抬头回应；场景：雨夜客栈；镜头：侧面近景。',
    '【4s-6s】 主体：@甲与@乙；动作：两人同时停步；场景：雨夜客栈；镜头：双人全景。',
  ].join('\n'),
  targetId: 'minimax-h3',
  durationSec: 6,
  resolution: '2K',
  detailMode: 'concise',
  references: [],
  subjectDefinitions: [
    {
      name: '甲',
      kind: 'character',
      gender: '男',
      race: '人类',
      appearance: '黑发、眉骨清晰',
      outfit: '深青长袍',
      anchor: '左腕红绳',
    },
    {
      name: '乙',
      kind: 'character',
      gender: '自定义：无性别',
      race: '羽族',
      appearance: '银白短发、金色瞳孔',
      outfit: '白色羽织',
      anchor: '右耳青玉耳坠',
    },
  ],
});
assert.match(
  h3NoReferenceIdentity.prompt,
  /主体：@甲（性别：男；物种\/族裔：人类；外貌：黑发、眉骨清晰；服装：深青长袍；连续性锚点：左腕红绳）/u,
  'no-reference H3 must carry the first character identity anchor in the integrated prompt',
);
assert.match(
  h3NoReferenceIdentity.prompt,
  /@乙（性别：自定义：无性别；物种\/族裔：羽族；外貌：银白短发、金色瞳孔；服装：白色羽织；连续性锚点：右耳青玉耳坠）/u,
  'no-reference H3 must preserve custom gender and appearance facts for every named character',
);

// Dynamic body/clothing state lives inside the canonical subject parenthesis.
// It is shot state, not a stable identity suffix, and must survive the H3
// structured-subject parser on every cut.
const h3DynamicWardrobe = compileTargetPrompt({
  canonicalPrompt: [
    '【0s-2s】 主体：@林岚（性别设定〔女〕；当前裸露状态〔完整着装〕；当前衣物状态〔红色长裙穿在身上〕）[朝向：镜面] 正在 [站在镜前]（建立）；空间：卧室；镜头：中景固定；台词：无；音效：无。',
    '【2s-4s】 主体：@林岚（性别设定〔女〕；当前裸露状态〔全裸〕；当前衣物状态〔红色长裙已脱下并作为离身道具留在椅背〕）[朝向：镜面] 正在 [脱下红色长裙]（推进）；空间：卧室；镜头：中景固定；台词：无；音效：无。',
    '【4s-6s】 主体：@林岚（性别设定〔女〕；当前裸露状态〔全裸〕；当前衣物状态〔红色长裙已脱下并作为离身道具留在椅背〕）[朝向：窗前] 正在 [走到窗前]（延续）；空间：卧室；镜头：侧向跟拍；台词：无；音效：无。',
    '【6s-8s】 主体：@林岚（性别设定〔女〕；当前裸露状态〔完整着装〕；当前衣物状态〔红色长裙已重新穿在身上〕）[朝向：镜面] 正在 [重新穿回红色长裙]（收束）；空间：卧室；镜头：中景固定；台词：无；音效：无。',
  ].join('\n'),
  durationSec: 8,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'none',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
  subjectDefinitions: [{ name: '林岚', kind: 'character', appearance: '黑色长发' }],
});
const h3DynamicWardrobeShots = Array.from(
  h3DynamicWardrobe.prompt.matchAll(/\[Shot\s+(\d+)\][\s\S]*?(?=\n\n\[Shot\s+\d+\]|\n\noverall_soundscape:)/gu),
  (match) => match[0],
);
assert.equal(h3DynamicWardrobeShots.length, 4);
const h3DynamicWardrobeExpected = [
  ['当前裸露状态〔完整着装〕', '当前衣物状态〔红色长裙穿在身上〕', '站在镜前'],
  ['当前裸露状态〔全裸〕', '当前衣物状态〔红色长裙已脱下并作为离身道具留在椅背〕', '脱下红色长裙'],
  ['当前裸露状态〔全裸〕', '当前衣物状态〔红色长裙已脱下并作为离身道具留在椅背〕', '走到窗前'],
  ['当前裸露状态〔完整着装〕', '当前衣物状态〔红色长裙已重新穿在身上〕', '重新穿回红色长裙'],
] as const;
h3DynamicWardrobeExpected.forEach((expected, index) => {
  for (const value of expected) {
    assert.ok(
      h3DynamicWardrobeShots[index].includes(value),
      `H3 Shot ${index + 1} dropped dynamic clothing state or action: ${value}`,
    );
  }
  assert.ok(
    h3DynamicWardrobeShots[index].indexOf(expected[0]) < h3DynamicWardrobeShots[index].indexOf(expected[2]),
    `H3 Shot ${index + 1} must establish its current clothing state before the visible action`,
  );
});

const h3MultiCharacterNsfwState = compileTargetPrompt({
  canonicalPrompt: [
    '【0s-2s】 主体：@甲（当前裸露状态〔全裸〕；当前衣物状态〔红色长裙已脱下并作为离身道具留在屏风旁〕）[朝向：水池] 正在 [走到池边]（建立）；空间：浴室；镜头：双人中景；台词：无；音效：无。',
    '【2s-4s】 主体：@乙（当前裸露状态〔上身裸露〕；当前衣物状态〔蓝色外袍褪至腰间〕）[朝向：甲] 正在 [转身看向甲]（推进）；空间：浴室；镜头：侧面近景；台词：无；音效：无。',
    '【4s-6s】 主体：@甲（当前裸露状态〔全裸〕；当前衣物状态〔红色长裙已脱下并作为离身道具留在屏风旁〕）[朝向：乙] 正在 [在池边停下]（延续）；空间：浴室；镜头：双人全景；台词：无；音效：无。',
  ].join('\n'),
  durationSec: 6,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'none',
  targetId: 'minimax-h3',
  references: [{ id: 'two-person-state-reference', name: '双人构图参考', mediaType: 'image', role: 'general' }],
  subjectDefinitions: [
    { name: '甲', kind: 'character', appearance: '黑色长发', referenceAssetIds: ['two-person-state-reference'] },
    { name: '乙', kind: 'character', appearance: '银色短发', referenceAssetIds: ['two-person-state-reference'] },
  ],
});
const h3MultiCharacterNsfwShots = Array.from(
  h3MultiCharacterNsfwState.prompt.matchAll(/\[Shot\s+(\d+)\][\s\S]*?(?=\n\n\[Shot\s+\d+\]|\n\noverall_soundscape:)/gu),
  (match) => match[0],
);
assert.equal(h3MultiCharacterNsfwShots.length, 3);
assert.match(h3MultiCharacterNsfwShots[0], /当前裸露状态〔全裸〕[\s\S]*红色长裙已脱下/u);
assert.doesNotMatch(h3MultiCharacterNsfwShots[0], /蓝色外袍褪至腰间/u);
assert.match(h3MultiCharacterNsfwShots[1], /当前裸露状态〔上身裸露〕[\s\S]*蓝色外袍褪至腰间/u);
assert.doesNotMatch(h3MultiCharacterNsfwShots[1], /红色长裙已脱下/u);
assert.match(h3MultiCharacterNsfwShots[2], /当前裸露状态〔全裸〕[\s\S]*红色长裙已脱下/u);

// A compressed candidate may deliberately set globalClauseLimit=1. Subject
// identity is not a decorative clause, so both performers must survive that
// compression path instead of selectEvenly keeping only the last one.
const h3MultiSubjectCompression = compileTargetPrompt({
  ...common,
  canonicalPrompt: [
    '【0s-1s】 主体：@甲与@乙；动作：甲压低重心，乙抬手示意；场景：暴雨工业区；光影：冷蓝逆光；镜头：低机位全景。',
    '【1s-2s】 主体：@甲与@乙；动作：甲向前一步，乙侧身让开；场景：暴雨工业区；光影：冷蓝逆光；镜头：中景侧拍。',
    '【2s-3s】 主体：@甲与@乙；动作：甲伸手推门，乙回头观察；场景：暴雨工业区；光影：冷蓝逆光；镜头：近景跟随。',
    '【3s-4s】 主体：@甲与@乙；动作：甲停在门槛，乙举灯照亮室内；场景：暴雨工业区；光影：冷蓝逆光；镜头：越肩镜头。',
    '【4s-5s】 主体：@甲与@乙；动作：甲转身护住乙，乙握紧短刃；场景：暴雨工业区；光影：冷蓝逆光；镜头：环绕近景。',
    '【5s-6s】 主体：@甲与@乙；动作：甲与乙并肩站定，最终望向前方；场景：暴雨工业区；光影：冷蓝逆光；镜头：拉远定格。',
  ].join('\n'),
  targetId: 'minimax-h3',
  durationSec: 6,
  resolution: '2K',
  detailMode: 'concise',
  references: [],
});
assert.match(h3MultiSubjectCompression.prompt, /主体：@甲、@乙/u, 'H3 compression must retain every distinct subject identity');
assert.equal(
  countMatches(h3MultiSubjectCompression.prompt, /主体：@甲、@乙/gu),
  1,
  'multi-subject identity should be emitted once as a global first-Shot anchor',
);

const h3EightSecondKeyframes = compileTargetPrompt({
  ...common,
  canonicalPrompt: h3EightSecondFourShotsSource,
  targetId: 'minimax-h3',
  durationSec: 8,
  resolution: '2K',
  detailMode: 'concise',
  references: [
    { id: 'start-8s', name: '首帧', mediaType: 'image', firstFrame: true },
    { id: 'end-8s', name: '尾帧', mediaType: 'image', lastFrame: true }
  ]
});
assert.match(
  h3EightSecondKeyframes.prompt,
  /^How the reference pictures align with the target video — Picture 1 \(from Shot 1\) aligns with the 0\.00-second mark of the target video; Picture 2 \(from Shot 4\) aligns with the 8\.00-second mark of the target video\./u,
  'last-frame reference must bind to the real final canonical shot'
);

const h3FirstFrame = compileTargetPrompt({
  ...common,
  targetId: 'minimaxh3',
  durationSec: 5,
  resolution: '2K',
  detailMode: 'concise',
  references: [{ id: 'opening', name: '开场画面', mediaType: 'image', firstFrame: true }]
});
assert.match(h3FirstFrame.prompt, /^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\.\n\n/u);
assert.equal(h3FirstFrame.referenceManifest.assets[0].token, '<Picture 1>');

const h3FirstLastReferences = compileTargetPrompt({
  ...common,
  canonicalPrompt: [
    '【0s-5s】 主体：李云；动作：从客栈门口拔剑冲入雨幕；镜头：中景跟拍；声音：雨声与拔剑声。',
    '【5s-10s】 主体：李云；动作：在石阶尽头收剑停住；镜头：推近至近景；声音：雨声渐弱。'
  ].join('\n'),
  targetId: 'minimax-h3',
  durationSec: 10,
  resolution: '2K',
  detailMode: 'concise',
  references: [
    { id: 'start', name: '首帧', mediaType: 'image', firstFrame: true },
    { id: 'end', name: '尾帧', mediaType: 'image', lastFrame: true }
  ]
});
assert.match(h3FirstLastReferences.prompt, /^How the reference pictures align with the target video — Picture 1 \(from Shot 1\) aligns with the 0\.00-second mark of the target video; Picture 2 \(from Shot \d+\) aligns with the 10\.00-second mark of the target video\.\n\n/u);
assert.deepEqual(
  h3FirstLastReferences.referenceManifest.assets.map((asset) => asset.token),
  ['<Picture 1>', '<Picture 2>']
);
for (const token of ['<Picture 1>', '<Picture 2>']) {
  assert.ok(h3FirstLastReferences.prompt.includes(token), `H3 prompt omitted reference token ${token}`);
}

const h3MixedKeyframeReferences = compileTargetPrompt({
  ...common,
  targetId: 'minimax-h3',
  durationSec: 10,
  resolution: '2K',
  detailMode: 'concise',
  references: [
    { id: 'start', name: '首帧', mediaType: 'image', firstFrame: true },
    { id: 'end', name: '尾帧', mediaType: 'image', lastFrame: true },
    { id: 'motion', name: '动作轨迹', mediaType: 'video', role: 'motion', durationSec: 5 },
    { id: 'rain', name: '雨声', mediaType: 'audio', role: 'audio', durationSec: 5 }
  ]
});
assert.match(h3MixedKeyframeReferences.prompt, /^subject_definitions:\n/u, 'mixed keyframes and ordinary references must use Ref2VA');
assert.doesNotMatch(h3MixedKeyframeReferences.prompt, /^How the reference pictures align with the target video/u);
for (const section of ['summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']) {
  assert.ok(h3MixedKeyframeReferences.prompt.includes(`\n${section}`), `mixed Ref2VA prompt omitted ${section}`);
}

const realCanonicalH3 = [
  '【0s-5.00s】 主体：@六足甲壳巨兽（六足甲壳巨兽；节肢交替支撑）[朝向：躯体运动轴线指向动作目标] 正在 [从地铁口爬出→背部骨刺张开→低伏冲向装甲车]（开篇情绪奠基）；空间：前景-雨滴 中景-@六足甲壳巨兽与动作区域 背景-暴雨城市；光影：左侧4500K硬光，明暗比4:1；镜头：全景，低机位跟拍；台词：无；音效：环境层-[暴雨] 动作层-[甲壳摩擦] 情绪层-[低频鼓点] 电影写实，画幅16:9，分辨率2K',
  '【5.00s-10.00s】 主体：@六足甲壳巨兽（多足压低，甲壳起伏）[朝向：躯体运动轴线指向前方] 正在 [甩尾击碎路障→足爪踏裂积水路面→碎石落地]（推动转折）；空间：前景-碎石 中景-@六足甲壳巨兽与动作区域 背景-暴雨城市；光影：左侧4500K硬光，明暗比4:1；镜头：中景，侧向跟拍；台词：无；音效：环境层-[暴雨] 动作层-[碰撞与碎石声] 情绪层-[低频鼓点] 电影写实，画幅16:9，分辨率2K',
  '【10.00s-15.00s】 主体：@六足甲壳巨兽（节肢交替支撑）[朝向：躯体运动轴线指向上方] 正在 [跃上断桥尽头→尾部卷住石柱→最后昂首咆哮]（完成结果收束）；空间：前景-断桥边缘 中景-@六足甲壳巨兽与动作区域 背景-暴雨城市；光影：后侧6500K硬光，明暗比4:1；镜头：拉远定格完整轮廓；台词：无；音效：环境层-[暴雨渐弱] 动作层-[石柱摩擦与兽吼] 情绪层-[鼓点骤停] 电影写实，画幅16:9，分辨率2K'
].join('\n');
const realPlanConstraints = [
  '画幅16:9',
  '分辨率2K',
  '制作要求：主体始终是非人类六足甲壳巨兽',
  '连续性锚点：六足、甲壳、骨刺与尾部结构不变，禁止人形化',
  '连续性规则：同名主体保持身份稳定；人物离开画面要自然出画；正文仍用主体名；不新增人物或台词。'.repeat(6),
  '规则基础：最终只输出逐镜六字段时间轴。每镜必须包含主体、空间、光影、镜头、台词和三层音效，并补齐三拍动作链。'.repeat(8),
  '输出规则：不得遗漏任何旧规则，必须逐条解释所有内部字段。'.repeat(8),
  '转换器 智能导演：微表情写成目光、呼吸、手部动作和身体重心。'.repeat(8)
];
const realCanonicalAdapted = compileTargetPrompt({
  ...common,
  canonicalPrompt: realCanonicalH3,
  targetId: 'minimax-h3',
  durationSec: 15,
  resolution: '2K',
  detailMode: 'concise',
  constraints: realPlanConstraints,
  references: []
});
assert.match(realCanonicalAdapted.prompt, /甩尾击碎路障/u);
assert.match(realCanonicalAdapted.prompt, /最后昂首咆哮/u);
assert.doesNotMatch(realCanonicalAdapted.prompt, /保持当前可见状态/u, 'structured 正在 actions must be parsed from the canonical subject field');
assert.doesNotMatch(realCanonicalAdapted.prompt, /规则基础|输出规则|转换器|三拍动作链/u, 'internal canonical rules must never be copied into the H3 execution prompt');
assert.doesNotMatch(realCanonicalAdapted.prompt, /连续性规则|人物离开画面/u, 'generic canonical continuity prose must not compete with H3 shot actions');
assert.doesNotMatch(realCanonicalAdapted.prompt, /\[朝向：|正在\s*\[/u, 'canonical field syntax must be translated into natural H3 shot prose');
assert.doesNotMatch(realCanonicalAdapted.prompt, /→/u, 'canonical action arrows must be translated into natural sequential prose');
assert.equal(
  countMatches(realCanonicalAdapted.prompt, /（/gu),
  countMatches(realCanonicalAdapted.prompt, /）/gu),
  'H3 prompt must not contain unbalanced canonical parentheses'
);
const repeatedGlobalSpecs = compileTargetPrompt({
  ...common,
  canonicalPrompt: realCanonicalH3.replace(
    /分辨率2K/gu,
    '分辨率2K，保留立体声层次，主体始终是非人类六足甲壳巨兽，追求极致的真实感和电影质感',
  ),
  targetId: 'minimax-h3',
  durationSec: 15,
  detailMode: 'concise',
  references: [],
  constraints: ['制作要求：主体始终是非人类六足甲壳巨兽'],
});
assert.ok(
  countMatches(repeatedGlobalSpecs.prompt, /主体始终是非人类六足甲壳巨兽/gu) <= 1,
  'the global species constraint must appear once even when canonical visual tails repeat it',
);
assert.ok(
  countMatches(repeatedGlobalSpecs.prompt, /保留立体声层次/gu) <= 1,
  'the global audio mode must not repeat across H3 shots',
);

const repeatedCreatureFallbacks = compileTargetPrompt({
  ...common,
  targetId: 'minimax-h3',
  durationSec: 15,
  detailMode: 'concise',
  references: [],
  constraints: ['连续性锚点：六足甲壳结构不变，禁止人形化'],
  canonicalPrompt: [
    '【0s-3s】 主体：@甲壳巨兽（多足蓄力）[朝向：前方] 正在 [动作一爬出地铁口→节肢交替蹬地推进→甲壳与足爪停稳]（建立）；镜头：全景跟拍；音效：环境层-[雨] 动作层-[甲壳] 情绪层-[低频]',
    '【3s-6s】 主体：@甲壳巨兽（多足蓄力）[朝向：前方] 正在 [动作二张开骨刺→节肢交替蹬地推进→甲壳与足爪停稳]（推进）；镜头：中景跟拍；音效：环境层-[雨] 动作层-[甲壳] 情绪层-[低频]',
    '【6s-9s】 主体：@甲壳巨兽（多足蓄力）[朝向：前方] 正在 [动作三甩尾碎障→节肢交替蹬地推进→甲壳与足爪停稳]（转折）；镜头：侧向跟拍；音效：环境层-[雨] 动作层-[撞击] 情绪层-[低频]',
    '【9s-12s】 主体：@甲壳巨兽（多足蓄力）[朝向：前方] 正在 [动作四踏裂路面→节肢交替蹬地推进→甲壳与足爪停稳]（升级）；镜头：低机位跟拍；音效：环境层-[雨] 动作层-[碎石] 情绪层-[低频]',
    '【12s-15s】 主体：@甲壳巨兽（甲壳起伏）[朝向：上方] 正在 [动作五昂首咆哮→节肢交替蹬地推进→甲壳与足爪停稳]（收束）；镜头：拉远定格；音效：环境层-[雨] 动作层-[兽吼] 情绪层-[鼓点停]'
  ].join('\n')
});
assert.match(repeatedCreatureFallbacks.prompt, /动作一爬出地铁口/u);
assert.match(repeatedCreatureFallbacks.prompt, /动作三甩尾碎障/u);
assert.match(repeatedCreatureFallbacks.prompt, /动作五昂首咆哮/u);
assert.match(repeatedCreatureFallbacks.prompt, /动作二张开骨刺/u);
assert.match(repeatedCreatureFallbacks.prompt, /动作四踏裂路面/u);
assert.equal(countMatches(repeatedCreatureFallbacks.prompt, /\[Shot \d+\]/gu), 5, 'repeated fallback clauses must not cause unique source shots to be dropped');
assert.ok(
  countMatches(repeatedCreatureFallbacks.prompt, /节肢交替蹬地推进/gu) >= 5,
  'an action authored in every source shot must remain bound to every H3 shot'
);

const h3BattleEventFidelity = compileTargetPrompt({
  ...common,
  targetId: 'minimax-h3',
  durationSec: 5,
  resolution: '2K',
  detailMode: 'concise',
  references: [],
  canonicalPrompt: [
    '【0s-0.8s】 主体：@剑客与@敌将；动作：敌将长刀劈落→剑客举剑格挡→剑客反手挑开刀锋；镜头：低机位近景跟拍；音效：长刀破风与剑刃第一次碰撞声。',
    '【0.8s-1.6s】 主体：@剑客与@敌将；动作：敌将转身横扫→剑客举剑格挡→剑客踏墙翻越刀背；镜头：侧向高速跟拍；音效：长刀横扫与剑刃第二次碰撞声。',
    '【1.6s-2.4s】 主体：@剑客与@敌将；动作：敌将贴地追砍→剑客举剑格挡→剑客滑步刺向护心镜；镜头：贴地环绕镜头；音效：刀刃刮地与护心镜碎裂声。',
    '【2.4s-3.2s】 主体：@剑客与@敌将；动作：敌将掷出断刀→剑客举剑格挡→断刀擦过肩甲钉入木柱；镜头：越肩特写；音效：断刀旋转与木柱迸裂声。',
    '【3.2s-4.1s】 主体：@剑客与@敌将；动作：敌将拔出匕首扑近→剑客举剑格挡→剑客旋身缴械压住敌将；镜头：手持环绕近景；音效：匕首撞剑与缴械落地声。',
    '【4.1s-5s】 主体：@剑客与@敌将；动作：敌将踉跄跪地→剑客举剑格挡→剑客收剑停在雨中；镜头：拉远定格；音效：敌将跪地声与雨中收剑声。'
  ].join('\n')
});
const h3BattleShotDescriptions = Array.from(
  h3BattleEventFidelity.prompt.matchAll(/\[Shot (\d+)\][\s\S]*?(?=\[Shot \d+\]|\n\noverall_soundscape:)/gu),
  (match) => match[0],
);
assert.equal(h3BattleShotDescriptions.length, 6, 'H3 battle prompt must preserve every source shot');
const h3BattleExpectations = [
  { actions: ['敌将长刀劈落', '剑客举剑格挡', '剑客反手挑开刀锋'], sound: '长刀破风与剑刃第一次碰撞声' },
  { actions: ['敌将转身横扫', '剑客举剑格挡', '剑客踏墙翻越刀背'], sound: '长刀横扫与剑刃第二次碰撞声' },
  { actions: ['敌将贴地追砍', '剑客举剑格挡', '剑客滑步刺向护心镜'], sound: '刀刃刮地与护心镜碎裂声' },
  { actions: ['敌将掷出断刀', '剑客举剑格挡', '断刀擦过肩甲钉入木柱'], sound: '断刀旋转与木柱迸裂声' },
  { actions: ['敌将拔出匕首扑近', '剑客举剑格挡', '剑客旋身缴械压住敌将'], sound: '匕首撞剑与缴械落地声' },
  { actions: ['敌将踉跄跪地', '剑客举剑格挡', '剑客收剑停在雨中'], sound: '敌将跪地声与雨中收剑声' },
] as const;
h3BattleExpectations.forEach((expected, index) => {
  for (const action of expected.actions) {
    assert.ok(
      h3BattleShotDescriptions[index].includes(action),
      `H3 Shot ${index + 1} omitted combat event: ${action}`,
    );
  }
  assert.ok(
    h3BattleShotDescriptions[index].includes(`声音：${expected.sound}`),
    `H3 Shot ${index + 1} must bind its own sound instead of relying on a global sound summary`,
  );
});
const h3BattleCameras = ['低机位近景跟拍', '侧向高速跟拍', '贴地环绕镜头', '越肩特写', '手持环绕近景', '拉远定格'];
h3BattleCameras.forEach((camera, index) => {
  assert.match(
    h3BattleShotDescriptions[index],
    new RegExp(`镜头：${camera}`, 'u'),
    `H3 Shot ${index + 1} must retain its authored camera cue on the official-limit compression path`,
  );
});

const h3BlankVisualAndSound = compileTargetPrompt({
  ...common,
  targetId: 'minimax-h3',
  durationSec: 5,
  detailMode: 'concise',
  references: [],
  canonicalPrompt: '【0s-5s】 主体：@李云；动作：站定；空间：空庭；光影：｜；镜头：固定中景；台词：无；音效：｜；音乐：｜',
});
assert.doesNotMatch(h3BlankVisualAndSound.prompt, /风格与光影：\s*[｜|]/u, 'blank visual delimiters must not become a visible H3 label');
assert.doesNotMatch(h3BlankVisualAndSound.prompt, /声音：\s*[｜|]/u, 'blank sound delimiters must not become a visible Shot sound');
assert.doesNotMatch(h3BlankVisualAndSound.prompt, /(?:^|[：；\s])[｜|](?:$|[；。\s])/mu, 'H3 output must not contain isolated delimiter-only atoms');
assert.match(h3BlankVisualAndSound.prompt, /non_diegetic_music: N\/A/u, 'blank music must remain N/A');

const h3MissingCamera = compileTargetPrompt({
  ...common,
  targetId: 'minimax-h3',
  durationSec: 8,
  detailMode: 'concise',
  references: [],
  canonicalPrompt: [
    '【0s-4s】 主体：@李云；动作：推门进入客栈。',
    '【4s-8s】 主体：@李云；动作：停在门槛回望。',
  ].join('\n'),
});
assert.match(
  h3MissingCamera.prompt,
  /\[Shot 1\][\s\S]*镜头：保持当前构图/u,
  'a camera-less first source shot must receive a neutral H3 composition cue',
);
assert.match(
  h3MissingCamera.prompt,
  /\[Shot 2\][\s\S]*镜头：延续前镜构图/u,
  'later camera-less source shots must receive a continuity composition cue',
);

const repeatedFinalAction = compileTargetPrompt({
  ...common,
  targetId: 'minimax-h3',
  durationSec: 15,
  resolution: '2K',
  detailMode: 'concise',
  references: [],
  canonicalPrompt: [
    '【0s-3s】 主体：@剑客；动作：推开客栈木门；镜头：全景跟拍。',
    '【3s-6s】 主体：@剑客；动作：穿过昏暗走廊；镜头：中景侧拍。',
    '【6s-9s】 主体：@剑客；动作：停在亮着烛火的门外；镜头：缓慢推近。',
    '【9s-12s】 主体：@剑客；动作：抬眼看向门缝→握紧剑柄→最终吹灭烛火；镜头：近景。',
    '【12s-15s】 主体：@剑客；动作：抬眼看向门缝→握紧剑柄→最终吹灭烛火；镜头：特写定格。'
  ].join('\n')
});
assert.match(repeatedFinalAction.prompt, /\[Shot 5\][^\n]*最终吹灭烛火/u, 'the real final H3 shot must retain the final visible result even when the source action repeats');

const h3FullReference = compileTargetPrompt({
  ...common,
  canonicalPrompt: realCanonicalH3,
  targetId: 'minimax-h3',
  durationSec: 15,
  detailMode: 'concise',
  references: [
    { id: 'creature', name: '巨兽设定图', mediaType: 'image', role: 'character', responsibility: '锁定六足甲壳巨兽的物种与解剖结构' },
    { id: 'city', name: '暴雨城市', mediaType: 'image', role: 'scene', responsibility: '锁定暴雨城市环境' },
    { id: 'motion-ref', name: '多足运动', mediaType: 'video', role: 'motion', responsibility: '仅参考多足运动轨迹' }
  ]
});
assert.match(h3FullReference.prompt, /^subject_definitions:\n/u, 'general references must use the official H3 full-reference structure');
for (const section of ['summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']) {
  assert.ok(h3FullReference.prompt.includes(`\n${section}`), `full-reference H3 prompt omitted ${section}`);
}
assert.match(h3FullReference.prompt, /<Subject 1>.*<Picture 1>/u);
assert.match(h3FullReference.prompt, /<Subject 2>.*<Picture 2>/u);
assert.match(h3FullReference.prompt, /<Subject 3>.*<Video 1>/u);
assert.doesNotMatch(h3FullReference.prompt, /；{2,}|;;/u, 'H3 reference definitions must not contain empty-field double separators');

const h3QuotedDialogue = compileTargetPrompt({
  ...common,
  canonicalPrompt: '【0s-5s】 主体：@李云（屏息）[朝向：门口] 正在 [抬头→转身→停住]（作出反应）；空间：雨夜客栈；光影：暖烛光；镜头：缓慢推近；台词：第2s @李云："等等；别走。"；音效：环境层-[雨声] 动作层-[衣摆声] 情绪层-[呼吸声]',
  targetId: 'minimax-h3',
  durationSec: 5,
  resolution: '2K',
  detailMode: 'concise',
  references: []
});
assert.match(h3QuotedDialogue.prompt, /台词：第2s @李云："等等；别走。"/u, 'quoted canonical dialogue must survive field parsing verbatim');

const singleCharacterSubjectReference = compileTargetPrompt({
  canonicalPrompt: '【0s-5s】 主体：我、自我、甲、甲方、我们；动作：我们推门，自我稳定，甲方站在门外；空间：雨夜门廊；光影：冷蓝侧光；镜头：中景固定；音效：环境层-[雨声] 动作层-[木门开启声] 情绪层-[无配乐]；台词：第1s @我："我们先走"，第2s @我：“自我介绍”，第3s @我：‘甲方；音效：等候’，第4s @我：「我随后来」，第4.5s @我：『我还在说',
  durationSec: 5,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [{ id: 'self-reference', name: '人物参考图', mediaType: 'image', role: 'character' }],
  subjectDefinitions: [
    {
      name: '我',
      kind: 'character',
      description: '第一人称叙事者',
      referenceAssetIds: ['self-reference'],
    },
    { name: '甲', kind: 'character', referenceAssetIds: ['self-reference'] },
  ],
});
const singleCharacterSubjectDetailed = singleCharacterSubjectReference.prompt
  .split('detailed_description:\n')[1]
  ?.split('\n\noverall_soundscape:')[0] || '';
assert.match(singleCharacterSubjectDetailed, /主体：<Subject 1>、自我、<Subject 2>、甲方、我们/u, 'one-Han-character names must map only as complete entries in a structured subject field');
assert.match(singleCharacterSubjectDetailed, /台词：第1s <Subject 1>：/u, 'an explicit @name speaker outside quotation marks must map');
for (const preservedProse of ['我们推门', '自我稳定', '甲方站在门外']) {
  assert.match(singleCharacterSubjectDetailed, new RegExp(preservedProse, 'u'), `a one-character name must not rewrite ordinary prose: ${preservedProse}`);
}
for (const quotedBody of ['"我们先走"', '“自我介绍”', '‘甲方；音效：等候’', '「我随后来」', '『我还在说']) {
  assert.match(singleCharacterSubjectDetailed, new RegExp(quotedBody, 'u'), `quoted dialogue must remain byte-for-byte unchanged: ${quotedBody}`);
}
assert.doesNotMatch(singleCharacterSubjectDetailed, /<Subject 1>们|自<Subject 1>|<Subject 1>方/u, 'single-character bare-name mapping must not corrupt larger Chinese words');

const unclosedQuoteBeforeStructuredFields = compileTargetPrompt({
  canonicalPrompt: '【0s-5s】 主体：@我；动作：沿湿石径前行；台词：第1s @我：『我们先走；别回头；空间：瀑布石径；光影：阴天散射光；镜头：中景稳定跟拍；音效：环境层-[远处瀑布声] 动作层-[第2s @我脚步声] 情绪层-[无配乐]',
  durationSec: 5,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [{ id: 'unclosed-quote-reference', name: '人物参考图', mediaType: 'image', role: 'character' }],
  subjectDefinitions: [{ name: '我', kind: 'character', referenceAssetIds: ['unclosed-quote-reference'] }],
});
const unclosedQuoteDetailed = unclosedQuoteBeforeStructuredFields.prompt
  .split('detailed_description:\n')[1]
  ?.split('\n\noverall_soundscape:')[0] || '';
assert.match(unclosedQuoteDetailed, /台词：第1s <Subject 1>：『我们先走；别回头/u, 'ordinary semicolons inside an unclosed quote must remain dialogue text');
assert.match(unclosedQuoteDetailed, /环境：瀑布石径/u, 'a known scene field after an unclosed quote must still be parsed');
assert.match(unclosedQuoteDetailed, /风格与光影：阴天散射光/u, 'a known lighting field after an unclosed quote must still be parsed');
assert.match(unclosedQuoteDetailed, /镜头：中景稳定跟拍/u, 'a known camera field after an unclosed quote must still be parsed');
assert.match(unclosedQuoteDetailed, /第2s <Subject 1>脚步声/u, 'an explicit subject tag in a recovered sound field is outside the unclosed quote and must still map');
assert.match(unclosedQuoteDetailed, /环境层-\[远处瀑布声\]/u, 'an environment layer after an unclosed quote must remain in its own shot');
assert.match(unclosedQuoteBeforeStructuredFields.prompt, /overall_soundscape: N\/A/u, 'recovering a local field must not promote it into a global bed');

const multiCharacterSubjectReference = compileTargetPrompt({
  canonicalPrompt: [
    '【0s-2.5s】 主体：无名主角；动作：无名主角拔剑，小师妹后退；空间：演武场；光影：晨光；镜头：中景侧拍；台词：无；音效：环境层-[微风] 动作层-[拔剑声] 情绪层-[无配乐]',
    '【2.5s-5s】 主体：小师妹；动作：无名主角版本海报保持不动，超级无名主角版本海报也保持不动，小师妹收剑；空间：演武场；光影：晨光；镜头：近景固定；台词：无；音效：环境层-[微风] 动作层-[收剑声] 情绪层-[无配乐]',
  ].join('\n'),
  durationSec: 5,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [{ id: 'duel-reference', name: '双人参考图', mediaType: 'image', role: 'character' }],
  subjectDefinitions: [
    { name: '无名主角', kind: 'character', referenceAssetIds: ['duel-reference'] },
    { name: '小师妹', kind: 'character', referenceAssetIds: ['duel-reference'] },
  ],
});
const multiCharacterSubjectDetailed = multiCharacterSubjectReference.prompt
  .split('detailed_description:\n')[1]
  ?.split('\n\noverall_soundscape:')[0] || '';
assert.match(multiCharacterSubjectDetailed, /<Subject 1>拔剑/u, 'a bare multi-character Chinese subject must still map at an action-clause boundary');
assert.match(multiCharacterSubjectDetailed, /<Subject 2>后退/u, 'a later bare multi-character Chinese subject must still map at an action-clause boundary');
assert.match(multiCharacterSubjectDetailed, /无名主角版本海报保持不动/u, 'a known name used as the prefix of a longer Chinese term must stay literal');
assert.match(multiCharacterSubjectDetailed, /超级无名主角版本/u, 'a known name embedded inside a longer Chinese term must stay literal');
assert.doesNotMatch(multiCharacterSubjectDetailed, /(?:^|超级)<Subject 1>版本/u, 'bare-name mapping must not rewrite a longer Chinese term at either edge');

const tokenBoundarySubjectReference = compileTargetPrompt({
  canonicalPrompt: '【0s-5s】 主体：Ann、7；动作：Ann turns, Anna stays, 7 turns, 17 stays, Ann_2 waits；空间：studio；光影：soft light；镜头：medium shot；台词：@Ann: "Anna waits"；音效：环境层-[room tone] 动作层-[footstep] 情绪层-[无配乐]',
  durationSec: 5,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [{ id: 'token-reference', name: 'cast reference', mediaType: 'image', role: 'character' }],
  subjectDefinitions: [
    { name: 'Ann', kind: 'character', referenceAssetIds: ['token-reference'] },
    { name: '7', kind: 'character', referenceAssetIds: ['token-reference'] },
  ],
});
const tokenBoundarySubjectDetailed = tokenBoundarySubjectReference.prompt
  .split('detailed_description:\n')[1]
  ?.split('\n\noverall_soundscape:')[0] || '';
assert.match(tokenBoundarySubjectDetailed, /<Subject 1> turns/u, 'a standalone Latin name must map');
assert.match(tokenBoundarySubjectDetailed, /<Subject 2> turns/u, 'a standalone numeric name must map');
assert.match(tokenBoundarySubjectDetailed, /Anna stays/u, 'Ann must not match the prefix of Anna');
assert.match(tokenBoundarySubjectDetailed, /17 stays/u, 'numeric subject 7 must not match inside 17');
assert.match(tokenBoundarySubjectDetailed, /Ann_2 waits/u, 'Unicode token boundaries must treat underscore as part of a larger token');
assert.doesNotMatch(tokenBoundarySubjectDetailed, /<Subject 1>a|1<Subject 2>|Ann_<Subject 2>/u, 'Latin and numeric names require boundaries on both sides');

const shortFallbackAssetReference = compileTargetPrompt({
  canonicalPrompt: '【0s-5s】 主体：旅人；动作：旅人推门，雨落在门上，@门打开，@雨停止；空间：门廊；光影：阴天；镜头：中景固定；台词：无；音效：环境层-[雨声] 动作层-[开门声] 情绪层-[无配乐]',
  durationSec: 5,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [
    { id: 'door-reference', name: '门', mediaType: 'image', role: 'prop' },
    { id: 'rain-reference', name: '雨', mediaType: 'image', role: 'scene' },
  ],
});
const shortFallbackAssetDetailed = shortFallbackAssetReference.prompt
  .split('detailed_description:\n')[1]
  ?.split('\n\noverall_soundscape:')[0] || '';
assert.match(shortFallbackAssetDetailed, /旅人推门/u, 'a one-character fallback asset name must not rewrite a verb-object word');
assert.match(shortFallbackAssetDetailed, /雨落在门上/u, 'short fallback asset names must stay literal when they are not explicitly tagged');
assert.match(shortFallbackAssetDetailed, /<Subject 1>打开/u, 'an explicit @tag must still map a short fallback asset name');
assert.match(shortFallbackAssetDetailed, /<Subject 2>停止/u, 'every explicitly tagged short fallback asset name must map');
assert.doesNotMatch(shortFallbackAssetDetailed, /@(?:门|雨)/u, 'mapped explicit fallback tags must not leak into the official detailed description');

const h3Silent = compileTargetPrompt({
  ...common,
  canonicalPrompt: '【0s-5s】 主体：石像；动作：石像裂开后停住；声音：石块碎裂；音乐：激昂鼓点。',
  targetId: 'minimax-h3',
  durationSec: 5,
  resolution: '2K',
  audioMode: 'silent',
  detailMode: 'concise',
  references: []
});
assert.match(h3Silent.prompt, /overall_soundscape: N\/A/u);
assert.match(h3Silent.prompt, /non_diegetic_music: N\/A/u, 'silent H3 mode must suppress canonical music as well as diegetic sound');

const h3OutOfOrderCuts = compileTargetPrompt({
  ...common,
  canonicalPrompt: [
    '【0s-2s】 主体：机械兽；动作：启动；镜头：全景。',
    '【8s-10s】 主体：机械兽；动作：跨过障碍；镜头：跟拍。',
    '【2s-4s】 主体：机械兽；动作：转向；镜头：侧拍。',
    '【12s-15s】 主体：机械兽；动作：最终停在门前；镜头：拉远。'
  ].join('\n'),
  targetId: 'minimax-h3',
  durationSec: 15,
  resolution: '2K',
  detailMode: 'concise',
  references: []
});
const h3CutTimes = Array.from(h3OutOfOrderCuts.prompt.matchAll(/\[Shot \d+\] At 00:(\d{2}\.\d{3}),/gu), (match) => Number(match[1]));
assert.ok(h3CutTimes.every((time, index) => index === 0 || time > h3CutTimes[index - 1]), 'H3 cut timestamps must remain strictly increasing');

const h3PrototypeFieldAliases = () => compileTargetPrompt({
  ...common,
  canonicalPrompt: '【0s-5s】 constructor：继承键；toString：继承键；__proto__：继承键；主体：机械兽；动作：启动后停住。',
  targetId: 'minimax-h3',
  durationSec: 5,
  resolution: '2K',
  detailMode: 'concise',
  references: []
});
assert.doesNotThrow(h3PrototypeFieldAliases, 'canonical field aliases must ignore Object.prototype keys');
for (const inheritedKey of ['constructor', 'toString', 'valueOf', '__proto__']) {
  const inheritedReference = compileTargetPrompt({
    ...common,
    targetId: 'minimax-h3',
    durationSec: 5,
    resolution: '2K',
    detailMode: 'concise',
    references: [{ id: inheritedKey, name: inheritedKey, mediaType: inheritedKey, role: inheritedKey }]
  });
  assert.equal(inheritedReference.referenceManifest.assets[0].mediaType, 'image');
  assert.equal(inheritedReference.referenceManifest.assets[0].role, 'general');
}

const h3FiveSecondCausalMerge = compileTargetPrompt({
  ...common,
  canonicalPrompt: [
    '【0s-1s】 主体：机关兽；动作：开端按下石制机关；镜头：近景。',
    '【1s-2s】 主体：机关兽；动作：中段齿轮开始转动；镜头：特写。',
    '【2s-4s】 主体：机关兽；动作：过渡锁链向上收紧；镜头：跟拍。',
    '【4s-5s】 主体：机关兽；动作：结尾石门最终完全开启；镜头：拉远。'
  ].join('\n'),
  targetId: 'minimax-h3',
  durationSec: 5,
  resolution: '2K',
  detailMode: 'concise',
  references: []
});
assert.equal(countMatches(h3FiveSecondCausalMerge.prompt, /\[Shot \d+\]/gu), 4, '5-second custom storyboard must preserve all four source shots');
assert.match(h3FiveSecondCausalMerge.prompt, /开端按下石制机关/u, '5-second custom storyboard must preserve the initiating cause');
assert.match(h3FiveSecondCausalMerge.prompt, /中段齿轮开始转动/u, '5-second custom storyboard must preserve its second shot');
assert.match(h3FiveSecondCausalMerge.prompt, /过渡锁链向上收紧/u, '5-second custom storyboard must preserve its third shot');
assert.match(h3FiveSecondCausalMerge.prompt, /结尾石门最终完全开启/u, '5-second custom storyboard must preserve the final visible result');

const h3MixedLimit = compileTargetPrompt({
  ...common,
  targetId: 'minimax-h3',
  durationSec: 15,
  resolution: '2K',
  detailMode: 'concise',
  references: [
    ...Array.from({ length: 9 }, (_, index) => ({ id: `image-${index}`, name: `图${index}`, mediaType: 'image' as const, role: 'general' as const })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `video-${index}`, name: `视频${index}`, mediaType: 'video' as const, role: 'motion' as const, durationSec: 2 })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `audio-${index}`, name: `音频${index}`, mediaType: 'audio' as const, role: 'audio' as const, durationSec: 2 }))
  ]
});
assert.ok(h3MixedLimit.warnings.some((warning) => /素材总数.*12|总数最多约 12/u.test(warning)), 'H3 mixed reference total limit must be enforced');

const h3ReferenceDurations = compileTargetPrompt({
  ...common,
  targetId: 'minimax-h3',
  durationSec: 15,
  resolution: '2K',
  detailMode: 'concise',
  references: [
    { id: 'short-video', name: '过短视频', mediaType: 'video', role: 'motion', durationSec: 1 },
    { id: 'long-audio', name: '过长音频', mediaType: 'audio', role: 'audio', durationSec: 16 }
  ]
});
assert.ok(h3ReferenceDurations.warnings.some((warning) => /video参考.*过短视频.*2 秒/u.test(warning)));
assert.ok(h3ReferenceDurations.warnings.some((warning) => /audio参考.*过长音频.*15 秒/u.test(warning)));

const h3ReferenceDurationTotals = compileTargetPrompt({
  ...common,
  targetId: 'minimax-h3',
  durationSec: 15,
  resolution: '2K',
  detailMode: 'concise',
  references: [
    { id: 'video-a', name: '视频甲', mediaType: 'video', role: 'motion', durationSec: 8 },
    { id: 'video-b', name: '视频乙', mediaType: 'video', role: 'motion', durationSec: 8 },
    { id: 'audio-a', name: '音频甲', mediaType: 'audio', role: 'audio', durationSec: 8 },
    { id: 'audio-b', name: '音频乙', mediaType: 'audio', role: 'audio', durationSec: 8 }
  ]
});
assert.ok(h3ReferenceDurationTotals.warnings.some((warning) => /video参考总时长.*16.*15/u.test(warning)));
assert.ok(h3ReferenceDurationTotals.warnings.some((warning) => /audio参考总时长.*16.*15/u.test(warning)));

const officialSwordCanonical = [
  '【0s-2.2s】 主体：@无名主角（男，沉着）[朝向：@小师妹] 正在 [双脚站稳并将青钢剑斜指地面→注视@小师妹抽出软剑并抖出淡青灵光]（建立对峙）；空间：青石演武场与晨雾；光影：冷白晨光与淡金轮廓光；镜头：平视全景缓慢前推；台词：无；音效：环境层-[微风与远处铃声] 动作层-[金属出鞘声] 情绪层-[静默]',
  '【2.2s-5.2s】 主体：@小师妹（女，专注）[朝向：@无名主角左肋] 正在 [后脚发力贴地低掠→软剑如淡青鞭影缠向左肋→@无名主角后撤半步横剑格挡并迸出火星]（首次交锋）；空间：湿润青石与被搅动的雾气；光影：淡青灵光与火星；镜头：侧面中景跟拍；台词：无；音效：环境层-[微风] 动作层-[第二镜独有软剑破空与金属锐响] 情绪层-[静默]',
  '【5.2s-8.5s】 主体：@小师妹（女，决绝）[朝向：@无名主角咽喉、心口和持剑手腕] 正在 [分出三道淡青剑影依次分刺三个目标→@无名主角将灵力灌入剑身并直劈中路→三道剑影同时崩散且鞋跟擦出白痕]（破解升级攻势）；空间：演武场中央石徽；光影：冰青与淡金灵光；镜头：兵器线侧面稳定中景；台词：无；音效：环境层-[微风] 动作层-[第三镜独有三次破空、灵力崩散与鞋跟擦地] 情绪层-[静默]',
  '【8.5s-12.3s】 主体：@小师妹（女，迅捷）[朝向：@无名主角侧后方膝弯] 正在 [借势翻身绕到侧后方反撩膝弯→@无名主角侧步拧腰击中剑锷前五寸使软剑下弯→他欺近平推迫使她抬剑再挡并后退两步]（攻守逆转）；空间：演武场边缘与练功桩；光影：冷白晨光；镜头：横向中景跟拍；台词：无；音效：环境层-[微风] 动作层-[第四镜独有反撩破风、剑身震响与两次脚步] 情绪层-[静默]',
  '【12.3s-15s】 主体：@无名主角（男，克制）[朝向：@小师妹咽喉] 正在 [踏前一步绕过她抬起的软剑→剑尖停在喉前三寸且没有触碰→@小师妹额角渗汗并放下软剑]（胜负已定）；空间：晨雾渐散的演武场；光影：淡金轮廓光；镜头：平视中景后拉；台词：无；音效：环境层-[微风] 动作层-[第五镜独有停剑、呼气与衣料声] 情绪层-[静默]',
].join('\n');
const officialSwordResult = compileTargetPrompt({
  canonicalPrompt: officialSwordCanonical,
  durationSec: 15,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [{
    id: 'sword-reference',
    name: '双人演武场参考图',
    mediaType: 'image',
    role: 'general',
    responsibility: '同时锁定无名主角、小师妹、服装、兵器、演武场与仙侠画风',
  }],
  subjectDefinitions: [
    { name: '无名主角', kind: 'character', description: '男性剑客，深色服装，青钢硬剑', referenceAssetIds: ['sword-reference'] },
    { name: '小师妹', kind: 'character', description: '女性弟子，浅青衣裙，柔软软剑', referenceAssetIds: ['sword-reference'] },
    { name: '青石演武场', kind: 'scene', description: '带晨雾、石徽与练功桩的露天演武场', referenceAssetIds: ['sword-reference'] },
  ],
} as Parameters<typeof compileTargetPrompt>[0] & {
  subjectDefinitions: Array<{
    name: string;
    kind: string;
    description: string;
    referenceAssetIds: string[];
  }>;
});

const officialSectionIndexes = [
  'subject_definitions:',
  'summary:',
  'retention_analysis:',
  'detailed_description:',
  'overall_soundscape:',
  'non_diegetic_music:',
].map((section) => officialSwordResult.prompt.indexOf(section));
assert.ok(officialSectionIndexes.every((index) => index >= 0), 'official Ref2VA output must contain every official section');
assert.deepEqual(
  [...officialSectionIndexes].sort((left, right) => left - right),
  officialSectionIndexes,
  'official Ref2VA sections must remain in official order',
);

const officialSwordDetailed = officialSwordResult.prompt
  .split('detailed_description:\n')[1]
  ?.split('\n\noverall_soundscape:')[0] || '';
const officialSwordShotBlocks = Array.from(
  officialSwordDetailed.matchAll(/\[Shot (\d+)\]([\s\S]*?)(?=\[Shot \d+\]|$)/gu),
  (match) => match[0],
);
assert.equal(officialSwordShotBlocks.length, 5, 'official output must preserve all five source shots');
assert.match(officialSwordDetailed, /<Subject 1>/u, 'official detailed shots must use subject reference tags');
assert.match(officialSwordDetailed, /<Subject 2>/u, 'official detailed shots must map every referenced character name');
assert.doesNotMatch(officialSwordDetailed, /@(?:无名主角|小师妹)/u, 'canonical @names must not bypass H3 subject tags');
for (const [index, marker] of [
  '金属出鞘声',
  '第二镜独有软剑破空与金属锐响',
  '第三镜独有三次破空、灵力崩散与鞋跟擦地',
  '第四镜独有反撩破风、剑身震响与两次脚步',
  '第五镜独有停剑、呼气与衣料声',
].entries()) {
  assert.match(
    officialSwordShotBlocks[index] || '',
    new RegExp(marker, 'u'),
    `Shot ${index + 1} must retain its own synchronized action sound`,
  );
}
for (const action of [
  '抖出淡青灵光',
  '贴地低掠',
  '缠向左肋',
  '横剑格挡并迸出火星',
  '分出三道淡青剑影依次分刺三个目标',
  '将灵力灌入剑身并直劈中路',
  '三道剑影同时崩散且鞋跟擦出白痕',
  '借势翻身绕到侧后方反撩膝弯',
  '击中剑锷前五寸使软剑下弯',
  '抬剑再挡并后退两步',
  '绕过她抬起的软剑',
  '剑尖停在喉前三寸且没有触碰',
  '额角渗汗并放下软剑',
]) {
  assert.match(officialSwordResult.prompt, new RegExp(action, 'u'), `official conversion lost story action: ${action}`);
}
assert.match(officialSwordResult.prompt, /<Subject 1>.*无名主角.*<Picture 1>/u);
assert.match(officialSwordResult.prompt, /<Subject 2>.*小师妹.*<Picture 1>/u);
assert.match(officialSwordResult.prompt, /<Subject 3>.*青石演武场.*<Picture 1>/u);
assert.match(officialSwordResult.prompt, /non_diegetic_music: N\/A/u, 'no explicit score request must not invent continuous music');
assert.equal(
  officialSwordResult.warnings.some((warning) => /软预算/u.test(warning)),
  false,
  'the retired project soft-budget warning must not be emitted',
);

const h3ExplicitQuietMusic = compileTargetPrompt({
  canonicalPrompt: '【0s-5s】 主体：@剑客（沉着）[朝向：木桩] 正在 [右脚蹬地带动髋肩转动→剑刃撞击木桩后屈膝卸力回稳]（完成训练）；空间：安静庭院；光影：晨光；镜头：中景侧拍；台词：无；音效：环境层-[低位风声] 动作层-[第2.1s剑刃撞木声] 情绪层-[极轻古琴点奏]',
  durationSec: 5,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
});
const h3QuietMusicDetailed = h3ExplicitQuietMusic.prompt
  .split('integrated_multimodal_description: ')[1]
  ?.split('\n\noverall_soundscape:')[0] || '';
const h3QuietMusicSoundscape = h3ExplicitQuietMusic.prompt
  .split('overall_soundscape: ')[1]
  ?.split('\n\nnon_diegetic_music:')[0] || '';
assert.match(h3QuietMusicDetailed, /第2\.1s剑刃撞木声/u, 'action sound timing must stay inside its corresponding Shot');
assert.match(h3QuietMusicDetailed, /情绪层-\[极轻古琴点奏\]/u, 'authored emotion audio must stay in its own shot without local classification');
assert.doesNotMatch(h3QuietMusicSoundscape, /极轻古琴点奏/u, 'music must not leak into overall_soundscape');
assert.equal(h3QuietMusicSoundscape, 'N/A', 'unbounded low background wind must not mask authored sword impacts');
assert.doesNotMatch(h3QuietMusicSoundscape, /剑刃撞木声|动作声.*前景/u, 'shot-timed foley must not be promoted globally or forced into the foreground');
assert.match(h3ExplicitQuietMusic.prompt, /non_diegetic_music: N\/A$/u, 'emotion words do not create a global music field');
assert.doesNotMatch(h3ExplicitQuietMusic.prompt, /配乐保持稀疏|无对白不抬升/u, 'the adapter must not append its own mix plan');

const h3AutoEmotionWithNestedPhysicalPreset = compileTargetPrompt({
  canonicalPrompt: '【0s-5s】 主体：@无名主角（专注）[朝向：前方] 正在 [推开木门并停在门槛]（建立）；空间：雨夜客栈；光影：门缝冷光；镜头：中景跟拍；台词：无；音效：环境层-[雨声] 动作层-[木门开启声] 情绪层-[克制低频氛围渐进｜风格预设声音〔环境声与动作声同步〕]',
  durationSec: 5,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
});
const autoEmotionSoundscape = h3AutoEmotionWithNestedPhysicalPreset.prompt
  .split('overall_soundscape: ')[1]
  ?.split('\n\nnon_diegetic_music:')[0] || '';
const autoEmotionMusic = h3AutoEmotionWithNestedPhysicalPreset.prompt
  .split('non_diegetic_music: ')[1] || '';
assert.match(autoEmotionMusic, /^N\/A/u, 'automatic neutral emotion and physical preset sound must not invent music');
assert.doesNotMatch(autoEmotionSoundscape, /风格预设声音|环境声与动作声同步/u, 'protected preset sound must never leak into overall_soundscape');
assert.doesNotMatch(autoEmotionMusic, /环境声与动作声同步/u, 'nested physical preset sound must never leak into music');

const h3ProtectedPresetNoScore = compileTargetPrompt({
  canonicalPrompt: '【0s-5s】 主体：@旅人（平静）[朝向：前方] 正在 [停步观察山谷]（建立）；空间：山谷石径；光影：清晨散射光；镜头：中景固定；台词：无；音效：环境层-[远处鸟鸣] 动作层-[无] 情绪层-[无配乐｜风格预设声音〔衣料与饰品声轻而可闻｜轻柔电子乐维持低位〕]',
  durationSec: 5,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
}).prompt;
const h3ProtectedNoScoreGlobal = h3ProtectedPresetNoScore.split('overall_soundscape: ')[1]?.split('\n\nnon_diegetic_music:')[0] || '';
assert.equal(h3ProtectedNoScoreGlobal, 'N/A', 'local birdsong does not declare a global soundscape');
assert.match(h3ProtectedPresetNoScore, /环境层-\[远处鸟鸣\]/u, 'the authored birdsong remains available in its original shot');
assert.doesNotMatch(h3ProtectedNoScoreGlobal, /衣料|饰品|电子乐/u, 'protected foley and music descriptions must remain out of the global soundscape');
assert.match(h3ProtectedPresetNoScore, /non_diegetic_music: N\/A$/u, 'protected music wording is not an authored score request');

const h3BreathingIsNotMusic = compileTargetPrompt({
  canonicalPrompt: '【0s-5s】 主体：@旅人（紧张）[朝向：洞口] 正在 [停步倾听洞内动静]（建立）；空间：洞口；光影：阴天；镜头：近景；台词：无；音效：环境层-[远处风声] 动作层-[无] 情绪层-[轻微呼吸声]',
  durationSec: 5,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
}).prompt;
assert.match(h3BreathingIsNotMusic, /non_diegetic_music: N\/A$/u, 'generic breathing and foley descriptions are not authored music');

// Regression for the delivered long-street video: this exact compound denial
// used to be promoted by a music-keyword regex and acquire a positive mix tail.
const h3NoScoreCanonical = [
  '【0s-5s】 主体：@祈凌霜；动作：沿街前行，回头以手势催促林沐；空间：青石长街；光影：日光；镜头：同侧跟拍；台词：无；音效：环境层-[第0s起：远处摊贩敲铃一声] 动作层-[第2s脚步声] 情绪层-[无配乐，不自动补背景音乐]',
  '【5s-10s】 主体：@林沐；动作：点头后加快脚步；空间：青石长街；光影：日光；镜头：同侧中景；台词：第0.5s @林沐（画内，普通话）：“我这就来。”；音效：环境层-[无] 动作层-[第1s脚步声] 情绪层-[No music. Do not add BGM.]',
  '【10s-15s】 主体：@叶清碧；动作：跟随同伴；空间：集市入口；光影：日光；镜头：侧后全景；台词：None；音效：环境层-[无] 动作层-[第2s商贩在摊前敲击铜铃一声] 情绪层-[店内乐师在画内弹响一个琴音，随动作结束]',
].join('\n');
for (const references of [
  [],
  [{ id: 'no-score-first', name: '首帧', mediaType: 'image', role: 'first-frame' }],
  [{ id: 'no-score-cast', name: '人物参考', mediaType: 'image', role: 'character' }],
]) {
  const source = {
    canonicalPrompt: h3NoScoreCanonical, durationSec: 15, aspectRatio: '16:9', resolution: '2K',
    audioMode: 'stereo', targetId: 'minimax-h3', references,
  };
  const before = structuredClone(source);
  const result = compileTargetPrompt(source);
  const protocol = readH3PromptProtocol(result.prompt);
  assert.ok(protocol, 'every supported H3 reference form keeps its protocol');
  assert.deepEqual(protocol.shots, [
    { marker: '[Shot 1]', cut: null },
    { marker: '[Shot 2]', cut: 'At 00:05.000' },
    { marker: '[Shot 3]', cut: 'At 00:10.000' },
  ]);
  assert.match(result.prompt, /non_diegetic_music: N\/A$/u);
  assert.match(result.prompt, /情绪层-\[无配乐，不自动补背景音乐\]/u, 'the compound no-score instruction stays in the authored shot');
  assert.match(result.prompt, /情绪层-\[No music\. Do not add BGM\.\]/u);
  assert.match(result.prompt, /情绪层-\[店内乐师在画内弹响一个琴音，随动作结束\]/u, 'a story-world musical event stays diegetic');
  assert.match(result.prompt, /台词：无/u, 'explicit no-dialogue survives H3 serialization');
  assert.match(result.prompt, /台词：None/u, 'English no-dialogue survives unchanged');
  assert.ok(result.prompt.includes('“我这就来。”'), 'the adapter preserves the authored line and invents no replacement');
  assert.match(result.prompt, /第2s脚步声|第1s脚步声/u);
  assert.match(result.prompt, /环境层-\[第0s起：远处摊贩敲铃一声\]/u, 'the local bell keeps its exact timestamp and punctuation in its shot');
  assert.match(result.prompt, /overall_soundscape: N\/A/u, 'a single timed bell must not become a segment-wide soundscape');
  assert.doesNotMatch(result.prompt, /配乐保持稀疏|无对白不抬升|keep any music/u, 'no automatic positive score-tail is appended');
  assert.deepEqual(source, before, 'serialization never modifies saved source text');
}

const h3ExplicitScoreFields = compileTargetPrompt({
  canonicalPrompt: h3NoScoreCanonical.replace('情绪层-[无配乐，不自动补背景音乐]', '情绪层-[无]；配乐：仅第1镜最后0.5秒古琴一个短音，低音量'),
  durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', targetId: 'minimax-h3',
  constraints: ['背景音乐：第3镜最后1秒同一古琴短句，结束即停'],
});
assert.match(h3ExplicitScoreFields.prompt, /non_diegetic_music: 仅第1镜最后0\.5秒古琴一个短音，低音量；第3镜最后1秒同一古琴短句，结束即停$/u, 'explicit score fields map without remixing or dropping their timing');
assert.doesNotMatch(h3ExplicitScoreFields.prompt, /配乐保持稀疏|无对白不抬升/u);

const h3NoScoreStructuredDenial = compileTargetPrompt({
  canonicalPrompt: h3NoScoreCanonical, durationSec: 15, aspectRatio: '16:9', resolution: '2K',
  audioMode: 'stereo', targetId: 'minimax-h3', constraints: ['non_diegetic_music: No music. Do not add a soundtrack.'],
});
assert.match(h3NoScoreStructuredDenial.prompt, /non_diegetic_music: No music\. Do not add a soundtrack\.$/u, 'an explicit structured denial stays a denial, without keyword reinterpretation');

const h3ThreeShotSoundscape = compileTargetPrompt({
  canonicalPrompt: [
    '【0s-2s】 主体：@旅人（警觉）[朝向：瀑布] 正在 [缓慢抬头望向瀑布]（建立环境）；空间：瀑布下游石径；光影：阴天散射光；镜头：中景仰拍；台词：无；音效：环境层-[远处瀑布声] 动作层-[无] 情绪层-[无配乐]',
    '【2s-4s】 主体：@旅人（专注）[朝向：前方] 正在 [沿湿石径快步穿过]（推进）；空间：瀑布下游石径；光影：阴天散射光；镜头：侧跟拍；台词：无；音效：环境层-[林间风声] 动作层-[第0.8s鞋底踩湿石声] 情绪层-[无配乐]',
    '【4s-6s】 主体：@旅人（戒备）[朝向：木桥] 正在 [伸手扶住摇晃木桥]（形成阻碍）；空间：瀑布边木桥；光影：阴天散射光；镜头：近景固定；台词：无；音效：环境层-[远处瀑布声与林间风声] 动作层-[第0.4s手掌撞木声] 情绪层-[无配乐]',
  ].join('\n'),
  durationSec: 6,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
});
const h3ThreeShotIntegrated = h3ThreeShotSoundscape.prompt
  .split('integrated_multimodal_description: ')[1]
  ?.split('\n\noverall_soundscape:')[0] || '';
const h3ThreeShotGlobalSoundscape = h3ThreeShotSoundscape.prompt
  .split('overall_soundscape: ')[1]
  ?.split('\n\nnon_diegetic_music:')[0] || '';
assert.match(h3ThreeShotIntegrated, /\[Shot 2\][\s\S]*?第0\.8s鞋底踩湿石声/u, 'walking foley must remain in its corresponding Shot');
assert.match(h3ThreeShotIntegrated, /\[Shot 3\][\s\S]*?第0\.4s手掌撞木声/u, 'contact foley must remain in its corresponding Shot');
assert.equal(h3ThreeShotGlobalSoundscape, 'N/A', 'several local environment fields do not authorize a full-segment soundscape');
assert.deepEqual([...h3ThreeShotIntegrated.matchAll(/环境层-\[([^\]]*)\]/gu)].map((match) => match[1]),
  ['远处瀑布声', '林间风声', '远处瀑布声与林间风声'], 'all local environment cues remain in their authored shot, without aggregation');
assert.doesNotMatch(h3ThreeShotGlobalSoundscape, /鞋底踩湿石声|手掌撞木声/u, 'synchronized foley must not be copied into overall_soundscape');
assert.doesNotMatch(h3ThreeShotGlobalSoundscape, /动作声.*前景|前景.*动作声/u, 'global soundscape must not force every action sound into the foreground');
assert.match(h3ThreeShotSoundscape.prompt, /non_diegetic_music: N\/A/u, 'without an authored score, H3 must output exactly N/A music');

const h3RelativeAmbientTiming = compileTargetPrompt({
  canonicalPrompt: [
    '【0s-4s】 主体：@旅人；动作：沿溪流前行；空间：林间石径；光影：阴天；镜头：中景跟拍；台词：无；音效：环境层-[第0.3s远处溪流持续] 动作层-[无] 情绪层-[无配乐]',
    '【4s-9s】 主体：@旅人；动作：穿过林间薄雾；空间：林间石径；光影：阴天；镜头：侧向跟拍；台词：无；音效：环境层-[远处溪流持续] 动作层-[第1s脚步声] 情绪层-[无配乐]',
    '【9s-15s】 主体：@旅人；动作：在桥头停住；空间：溪谷木桥；光影：阴天；镜头：近景固定；台词：无；音效：环境层-[第1s起远处溪流持续] 动作层-[无] 情绪层-[无配乐]',
  ].join('\n'),
  durationSec: 15,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
}).prompt;
const h3RelativeAmbientIntegrated = h3RelativeAmbientTiming
  .split('integrated_multimodal_description: ')[1]
  ?.split('\n\noverall_soundscape:')[0] || '';
const h3RelativeAmbientGlobal = h3RelativeAmbientTiming
  .split('overall_soundscape: ')[1]
  ?.split('\n\nnon_diegetic_music:')[0] || '';
assert.doesNotMatch(h3RelativeAmbientIntegrated, /溪流持续/u, 'continuous ambient beds must be removed from every Shot, including timed legacy cues');
assert.match(h3RelativeAmbientIntegrated, /\[Shot 2\][\s\S]*?第1s脚步声/u, 'local action sound timing must remain unchanged');
assert.equal(h3RelativeAmbientGlobal, 'N/A', 'removing a continuous ambient bed must also remove it from the global soundscape');
assert.doesNotMatch(h3RelativeAmbientGlobal, /第\s*\d+(?:\.\d+)?\s*(?:s|秒)/u, 'global ambience must not reinterpret a local Shot timestamp as segment-global time');

const h3ChronologicalEnvironment = compileTargetPrompt({
  canonicalPrompt: [
    '【0s-2s】 主体：@旅人（平静）[朝向：前方] 正在 [穿过林地]（建立）；空间：林地；光影：阴天；镜头：中景；台词：无；音效：环境层-[雨声] 动作层-[无] 情绪层-[无配乐]',
    '【2s-4s】 主体：@旅人（平静）[朝向：前方] 正在 [继续前行]（推进）；空间：林地；光影：阴天；镜头：中景；台词：无；音效：环境层-[风声] 动作层-[第0.5s脚步声] 情绪层-[无配乐]',
    '【4s-6s】 主体：@旅人（平静）[朝向：前方] 正在 [走入雨幕]（转折）；空间：林地；光影：阴天；镜头：中景；台词：无；音效：环境层-[雨声] 动作层-[无] 情绪层-[无配乐]',
    '【6s-8s】 主体：@旅人（平静）[朝向：前方] 正在 [望向山口]（延续）；空间：林地；光影：阴天；镜头：中景；台词：无；音效：环境层-[雾中鸟鸣] 动作层-[无] 情绪层-[无配乐]',
    '【8s-10s】 主体：@旅人（平静）[朝向：前方] 正在 [绕过湿石]（推进）；空间：林地；光影：阴天；镜头：中景；台词：无；音效：环境层-[远处溪流声] 动作层-[第0.4s脚步声] 情绪层-[无配乐]',
    '【10s-12s】 主体：@旅人（平静）[朝向：前方] 正在 [停在树下]（收束）；空间：林地；光影：阴天；镜头：中景；台词：无；音效：环境层-[树叶滴水声] 动作层-[无] 情绪层-[无配乐]',
  ].join('\n'),
  durationSec: 12,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
}).prompt;
const h3ChronologicalGlobal = h3ChronologicalEnvironment.split('overall_soundscape: ')[1]?.split('\n\nnon_diegetic_music:')[0] || '';
assert.equal(h3ChronologicalGlobal, 'N/A', 'local rain, wind and birdsong must not be copied into a global layer');
assert.deepEqual([...h3ChronologicalEnvironment.matchAll(/环境层-\[([^\]]*)\]/gu)].map((match) => match[1]),
  ['雨声', '风声', '雨声', '雾中鸟鸣', '远处溪流声', '树叶滴水声'],
  'shot-local environment layers retain chronological order and non-adjacent repeats without a second global copy');

// Regression for the late waterfall cue: source scope, not a sound keyword,
// determines where it is serialized. These are synthetic, non-network inputs.
const lateWaterfallCue = '第0s远处传来瀑布坠落声，保持远处听觉距离，持续6秒后结束';
const lateWaterfallInput: PromptAdapterInput = {
  canonicalPrompt: [
    '【0s-9s】 主体：@旅人；动作：旅人沿石径走近崖口；空间：远处可见瀑布与吹动衣摆的风；光影：晨光；镜头：中景跟拍；台词：无；音效：环境层-[无] 动作层-[第3s鞋底落石声] 情绪层-[无配乐]',
    `【9s-15s】 主体：@旅人；动作：旅人在崖口停下倾听；空间：同一山道；光影：晨光；镜头：同侧中景；台词：无；音效：环境层-[${lateWaterfallCue}] 动作层-[无] 情绪层-[无配乐]`,
  ].join('\n'),
  durationSec: 15, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', targetId: 'minimax-h3',
};
const lateWaterfallSnapshot = structuredClone(lateWaterfallInput);
for (const references of [[],
  [{ id: 'late-waterfall-first', name: '首帧', mediaType: 'image', role: 'first-frame' }],
  [{ id: 'late-waterfall-character', name: '旅人', mediaType: 'image', role: 'character' }],
]) {
  const compiled = compileTargetPrompt({ ...lateWaterfallInput, references });
  const protocol = readH3PromptProtocol(compiled.prompt)!;
  assert.ok(protocol, 'integrated, keyframe and full-reference formats remain valid H3');
  assert.deepEqual(protocol.shots, [{ marker: '[Shot 1]', cut: null }, { marker: '[Shot 2]', cut: 'At 00:09.000' }]);
  const body = compiled.prompt.split(compiled.prompt.includes('detailed_description:') ? 'detailed_description:' : 'integrated_multimodal_description:')[1].split('overall_soundscape:')[0];
  const [first, second] = body.split('[Shot 2]');
  assert.doesNotMatch(first, /瀑布坠落声/u, 'a later audible event is not pulled into the opening by its visible scenery');
  assert.ok(second.includes(lateWaterfallCue), 'local onset, end and distance survive exactly in the 9–15 second shot');
  assert.equal(compiled.prompt.split(lateWaterfallCue).length - 1, 1, 'the local cue occurs once, without a second global copy');
  assert.match(compiled.prompt, /overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/u);
  assert.match(compiled.prompt, /第3s鞋底落石声/u, 'the change does not erase foreground foley');

  const explicitGlobal = '同一场雨在屋外持续，人物始终在檐下；镜头越过门槛时听觉距离逐渐变近，不新增另一层雨声。';
  for (const declaration of [explicitGlobal, 'N/A']) {
    const explicit = compileTargetPrompt({ ...lateWaterfallInput, references, constraints: [`overall_soundscape: ${declaration}`] });
    assert.equal(explicit.prompt.split('overall_soundscape: ')[1]?.split('\n\nnon_diegetic_music:')[0], declaration,
      'an explicit global declaration, including N/A, is serialized without local sound/time filtering');
    assert.equal(explicit.prompt.split(`overall_soundscape: ${declaration}`).length - 1, 1,
      'the global field is not repeated as a first-shot constraint');
    assert.ok(explicit.prompt.includes(lateWaterfallCue), 'declaring a global field must not rewrite local cues');
    assert.deepEqual(readH3PromptProtocol(explicit.prompt), protocol);
    assert.deepEqual(explicit.parameters, compiled.parameters);
  }
  for (const declaration of [explicitGlobal, 'N/A',
    '同一屋外雨声从本段0秒至15秒可闻。\n人物始终在檐下，听觉距离保持远处；切镜不重启。',
    '同一屋外雨声持续。画面标牌的原文是“音频参数示例：\n\nnon_diegetic_music: 这只是标牌文字，不是配乐要求。\n”\n实际雨声仍按原时段结束。',
  ]) {
    const combinedBlock = `overall_soundscape: ${declaration}\n\nnon_diegetic_music: N/A`;
    const combined = compileTargetPrompt({ ...lateWaterfallInput, references, constraints: [combinedBlock] });
    assert.deepEqual(readH3PromptProtocol(combined.prompt), protocol,
      'a same-block global soundscape and music declaration yields exactly the existing three/six H3 fields');
    assert.ok(combined.prompt.includes(`overall_soundscape: ${declaration}\n\nnon_diegetic_music: N/A`),
      'genuine multiline soundscape prose and quoted field-like labels are preserved without swallowing the next section');
    assert.equal(combined.prompt.split(combinedBlock).length - 1, 1, 'the combined audio block is emitted once, not repeated in Shot 1');
    assert.ok(combined.prompt.includes(lateWaterfallCue), 'structured global audio does not change local cue time or distance');
    assert.deepEqual(combined.parameters, compiled.parameters);
  }
  const quotedLabels = '原台词引用“overall_soundscape: 原样读出这段文字。\n\nnon_diegetic_music: 同样只是引用。”';
  const quoted = compileTargetPrompt({ ...lateWaterfallInput, references, constraints: [quotedLabels] });
  assert.deepEqual(readH3PromptProtocol(quoted.prompt), protocol,
    'quoted field-like lines cannot split integrated or full-reference sections');
  assert.ok(quoted.prompt.includes(quotedLabels), 'quoted source prose is not classified or rewritten as global audio');
  assert.match(quoted.prompt, /overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/u);
  const otherField = compileTargetPrompt({ ...lateWaterfallInput, references,
    constraints: ['overall_soundscape: N/A\n\nsummary: 这是保留给AI的原始约束说明。\n\nnon_diegetic_music: N/A'] });
  assert.deepEqual(readH3PromptProtocol(otherField.prompt), protocol,
    'an unrelated structural declaration in an audio constraint cannot become a duplicate official section');
  assert.ok(otherField.prompt.includes('这是保留给AI的原始约束说明。'), 'unrelated source text is retained as opaque constraint prose');
  assert.match(otherField.prompt, /overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/u);
  const freeProse = compileTargetPrompt({ ...lateWaterfallInput, references, constraints: ['远处有瀑布，人物不讲话；不要自行补声。'] });
  assert.match(freeProse.prompt, /overall_soundscape: N\/A/u, 'free prose and scenery are not reclassified into a global sound field');
}
assert.deepEqual(lateWaterfallInput, lateWaterfallSnapshot, 'serialization leaves source prompts and settings untouched');

const fullReferenceSceneClauses = Array.from(
  { length: 8 },
  (_, index) => `场景层次${index + 1}${'保持空间纵深与可见背景关系'.repeat(32)}`,
).join('，');
const fullReferenceLightingClauses = Array.from(
  { length: 8 },
  (_, index) => `光影层次${index + 1}${'保持方向色温明暗比与轮廓连续'.repeat(18)}`,
).join('，');
const compressedFullReference = compileTargetPrompt({
  canonicalPrompt: `【0s-5s】 主体：@旅人；动作：旅人迈过湿石并在桥头站稳；场景：${fullReferenceSceneClauses}；光影：${fullReferenceLightingClauses}；镜头：中景稳定跟拍；台词：无；音效：环境层-[远处瀑布声] 动作层-[第2s鞋底踩湿石声] 情绪层-[无配乐]`,
  durationSec: 5,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [{ id: 'traveler-reference', name: '旅人参考图', mediaType: 'image', role: 'character' }],
  subjectDefinitions: [{
    name: '旅人',
    kind: 'character',
    description: `身份锚点${'保持面部发型服装与随身装备一致'.repeat(45)}`,
    referenceAssetIds: ['traveler-reference'],
  }],
  constraints: [],
});
assert.ok(compressedFullReference.prompt.includes(fullReferenceSceneClauses), 'every scene clause must survive, not just a budgeted sample');
assert.ok(compressedFullReference.prompt.includes(fullReferenceLightingClauses), 'every lighting clause must survive, not just a budgeted sample');
assert.match(compressedFullReference.prompt, /^subject_definitions:/u);
assert.equal(
  countMatches(compressedFullReference.prompt, /场景层次\d+/gu),
  8,
  'lossless identity deduplication lets the most detailed full-reference candidate fit without unnecessary scene compression',
);
assert.match(compressedFullReference.prompt, /第2s鞋底踩湿石声/u, 'compression must retain explicitly authored local foley');

// Full-reference retention is a preservation map, not a second copy of each
// complete identity bible. Long multi-character appearances must occur once
// in subject_definitions while every action, quote and reference stays intact.
const longIdentityNames = ['阿岚', '白翎', '苍砚'];
const longIdentityFacts = longIdentityNames.map((name) => Array.from(
  { length: 29 },
  (_, index) => `${name}外观锚点${index + 1}：额侧银色细辫、浅金虹膜、衣襟暗纹与左肩铜扣均保持同一形状`,
));
const longIdentityInput: Parameters<typeof compileTargetPrompt>[0] = {
  canonicalPrompt: [
    '【0s-5s】 主体：@阿岚；动作：@阿岚掀开铜匣确认紫色火光；空间：石殿；光影：火光侧照；镜头：中景；台词：第1s @阿岚："铜匣里只有这一片。"；音效：环境层-[无] 动作层-[第2s铜匣开启声] 情绪层-[古琴低音量点奏]',
    '【5s-10s】 主体：@白翎；动作：@白翎将赤色石片推入凹槽并锁住机关；空间：石殿；光影：火光侧照；镜头：侧向近景；台词：第2s @白翎："机关已经锁住。"；音效：环境层-[无] 动作层-[第3s卡榫闭合声] 情绪层-[无配乐]',
    '【10s-15s】 主体：@苍砚；动作：@苍砚握住门闩向内拉拢至门缝合严；空间：石殿；光影：火光侧照；镜头：固定全景；台词：第1s @苍砚："现在可以离开了。"；音效：环境层-[无] 动作层-[第2s门闩落锁声] 情绪层-[无配乐]',
  ].join('\n'),
  durationSec: 15,
  aspectRatio: '16:9',
  resolution: '2K',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [
    ...longIdentityNames.map((name, index) => ({
      id: `identity-picture-${index + 1}`,
      name: `${name}设定图`,
      mediaType: 'image',
      role: 'character',
      responsibility: `仅参考${name}身份与服装`,
    })),
    { id: 'identity-video', name: '推门轨迹参考', mediaType: 'video', role: 'motion', responsibility: '仅参考门闩移动轨迹' },
    { id: 'identity-audio', name: '对白音色参考', mediaType: 'audio', role: 'dialogue', responsibility: '仅参考对白发音与声线' },
  ],
  subjectDefinitions: longIdentityNames.map((name, index) => ({
    name,
    kind: 'character',
    appearance: longIdentityFacts[index]!.join('；'),
    outfit: `${name}衣领保留双排暗银缝线`,
    referenceAssetIds: [`identity-picture-${index + 1}`],
  })),
  constraints: [],
};
const shortIdentityControl = compileTargetPrompt({
  ...longIdentityInput,
  subjectDefinitions: longIdentityInput.subjectDefinitions?.map((subject) => ({ ...subject, appearance: '简短外观控制描述' })),
});
const longIdentitySnapshot = JSON.stringify(longIdentityInput);
const deduplicatedIdentities = compileTargetPrompt(longIdentityInput);
assert.equal(JSON.stringify(longIdentityInput), longIdentitySnapshot, 'retention deduplication must not rewrite the identity bible');
const identityDefinitions = deduplicatedIdentities.prompt.split('subject_definitions:\n')[1]?.split('\n\nsummary:')[0] || '';
const identityRetention = deduplicatedIdentities.prompt.split('retention_analysis:\n')[1]?.split('\n\ndetailed_description:')[0] || '';
const controlRetention = shortIdentityControl.prompt.split('retention_analysis:\n')[1]?.split('\n\ndetailed_description:')[0] || '';
for (const [index, name] of longIdentityNames.entries()) {
  const label = `<Subject ${index + 1}>`;
  const reference = `<Picture ${index + 1}>`;
  const definitionLine = identityDefinitions.split('\n').find((line) => line.startsWith(`${label} is `)) || '';
  const retentionLine = identityRetention.split('\n').find((line) => line.startsWith(`${label} (`)) || '';
  assert.ok(definitionLine.includes(`is ${name} referenced from ${reference}`));
  assert.ok(retentionLine.includes(`fully_preserved - ${name}；reference ${reference}`));
  assert.ok(retentionLine.includes(`subject_definitions 中 ${label}`), 'retention must explicitly refer to the same complete subject definition');
  for (const fact of [...longIdentityFacts[index]!, `${name}衣领保留双排暗银缝线`]) {
    assert.ok(definitionLine.includes(fact), `complete appearance fact must remain in its original subject definition: ${fact}`);
    assert.equal(deduplicatedIdentities.prompt.split(fact).length - 1, 1, 'each detailed identity fact must occur exactly once');
    assert.equal(identityRetention.includes(fact), false, 'retention must not duplicate complete appearance descriptions');
  }
}
assert.equal(identityRetention, controlRetention, 'appearance length must not alter subject/shot/name/reference preservation mappings');
assert.equal(
  deduplicatedIdentities.prompt.split('detailed_description:\n')[1],
  shortIdentityControl.prompt.split('detailed_description:\n')[1],
  'identity deduplication must not change any detailed shot, dialogue, sound or music',
);
assert.deepEqual(deduplicatedIdentities.prompt.match(/\[Shot \d+\]|<(?:Picture|Video|Audio) \d+>/gu), shortIdentityControl.prompt.match(/\[Shot \d+\]|<(?:Picture|Video|Audio) \d+>/gu), 'all shot markers and image/video/audio reference occurrences must remain unchanged');
assert.deepEqual(deduplicatedIdentities.referenceManifest, shortIdentityControl.referenceManifest);
assert.deepEqual(deduplicatedIdentities.parameters, shortIdentityControl.parameters);
assert.match(deduplicatedIdentities.prompt, /情绪层-\[古琴低音量点奏\]/u);
assert.match(deduplicatedIdentities.prompt, /non_diegetic_music: N\/A$/u, 'identity compilation must not classify an emotion-layer cue as global music');
const repeatedIdentityPayload = longIdentityInput.subjectDefinitions!.map((subject) => [subject.appearance, subject.outfit].filter(Boolean).join('；')).join('');
assert.ok(deduplicatedIdentities.prompt.length + repeatedIdentityPayload.length > 7000, 'the fixture must expose the former double-copy overflow, not merely test a short prompt');
const oversizedIdentities = compileTargetPrompt({
    ...longIdentityInput,
    subjectDefinitions: longIdentityInput.subjectDefinitions!.map((subject) => ({
      ...subject,
      appearance: [subject.appearance, ...Array.from(
        { length: 29 },
        (_, index) => `${subject.name}服装第${index + 1}处固定细节：铜片边沿黑色描线、纽扣排列和缝线方向必须完全一致`,
      )].join('；'),
    })),
  });
assert.ok(oversizedIdentities.prompt.length > 7000, 'the identity fixture must exceed the retired local limit');
for (const name of longIdentityNames) {
  for (let index = 1; index <= 29; index += 1) {
    assert.ok(oversizedIdentities.prompt.includes(`${name}服装第${index}处固定细节：铜片边沿黑色描线、纽扣排列和缝线方向必须完全一致`), 'long full-reference identity facts must never be shortened to fit a budget');
  }
}

const uncompressibleH3Action = `不可删除剧情动作${'旅人必须依次完成这项不可合并的剧情动作'.repeat(520)}`;
const unlimitedH3Action = compileTargetPrompt({
    canonicalPrompt: `【0s-5s】 主体：@旅人；动作：${uncompressibleH3Action}→尾部必须保存的最终停步事件；场景：石径；光影：阴天；镜头：中景固定；台词：无；音效：环境层-[远处瀑布声] 动作层-[无] 情绪层-[无配乐]`,
    durationSec: 5,
    aspectRatio: '16:9',
    resolution: '1080p',
    audioMode: 'stereo',
    targetId: 'minimax-h3',
    detailMode: 'concise',
    references: [],
    constraints: [],
  });
assert.ok(unlimitedH3Action.prompt.length > 7000);
assert.ok(unlimitedH3Action.prompt.includes(uncompressibleH3Action), 'the full long action must compile, not be truncated or rejected');
assert.match(unlimitedH3Action.prompt, /尾部必须保存的最终停步事件/u);

const completeClauseList = Array.from({ length: 20 }, (_, index) => `不可遗漏视觉事实${index + 1}`).join('，');
for (const durationSec of [5, 8, 10, 15, 60]) {
  const unlimited = compileTargetPrompt({
    canonicalPrompt: `【0s-${durationSec}s】 主体：@旅人；动作：${uncompressibleH3Action}→最终交还钥匙；空间：${completeClauseList}；光影：${completeClauseList}；镜头：全景跟拍，镜头继续向左侧环绕，保留尾部机位事实；台词：无；音效：环境层-[无] 动作层-[第1s钥匙碰撞声] 情绪层-[无配乐]`,
    durationSec, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', targetId: 'minimax-h3',
    references: [{ id: 'full-keyframe', name: '完整首帧', mediaType: 'image', role: 'first-frame', responsibility: completeClauseList }],
    constraints: [`外部视觉事实：${completeClauseList}`],
  });
  assert.ok(unlimited.prompt.length > 7000);
  assert.ok(unlimited.prompt.includes(uncompressibleH3Action));
  assert.equal(unlimited.prompt.split(completeClauseList).length - 1, 4, 'all scene, lighting, keyframe and constraint clauses must survive independent of duration tiers');
  assert.match(unlimited.prompt, /最终交还钥匙/u);
  assert.match(unlimited.prompt, /保留尾部机位事实/u);
  assert.match(unlimited.prompt, /第1s钥匙碰撞声/u);
  assert.equal(JSON.stringify(unlimited.parameters).includes('Infinity'), false);
}

console.log('prompt adapter regression checks passed');
