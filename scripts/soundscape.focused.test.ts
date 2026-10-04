import assert from 'node:assert/strict';
import { compileTargetPrompt } from '../src/promptAdapters';
import { buildShots, renderShotPrompt } from '../src/promptEngine';
import { defaultRuleSets, defaultStylePresets } from '../src/storage';
import type { Scene } from '../src/types';

const scene: Scene = {
  id: 'soundscape-focus-scene',
  title: '瀑布石径',
  content: '旅人来到瀑布下游的湿石径。',
  summary: '旅人在瀑布边行动。',
  characterIds: [],
  locationIds: [],
  propIds: [],
  storyboardIds: [],
  createdAt: 1,
  updatedAt: 1,
};
const baseShot = buildShots({
  scene,
  characters: [],
  locations: [],
  props: [],
  assets: [],
  workflow: 'drama',
  durationSec: 2,
  shotMode: 'exact',
  shotCount: 1,
  pace: 'standard',
  camera: '中景固定',
  lighting: '阴天散射光',
  style: defaultStylePresets[0],
  extra: '',
})[0]!;
const ordinaryPrompt = renderShotPrompt({
  ...baseShot,
  action: '旅人缓慢抬头看向瀑布',
  sound: '',
  lighting: '瀑布下游的阴天散射光',
}, 2, [], [baseShot], 'stereo', defaultRuleSets[0]!);
assert.match(ordinaryPrompt, /环境层-\[无\]/u);
assert.doesNotMatch(ordinaryPrompt, /底噪|瀑布声/u, 'a visible waterfall must not automatically invent a continuous audio bed');
assert.match(ordinaryPrompt, /动作层-\[无\]/u);
assert.doesNotMatch(ordinaryPrompt, /衣物|呼吸/u);

const authoredKissCue = '第1.2s唇触脸颊时一次细微、短促、可辨的轻吻声';
const kissDraft = renderShotPrompt({
  ...baseShot,
  action: '成年旅人靠近成年同伴，双唇轻触同伴脸颊后分开',
  sound: authoredKissCue,
}, 2, [], [baseShot], 'stereo', defaultRuleSets[0]!);
assert.ok(kissDraft.includes(`动作层-[${authoredKissCue}]`), 'authored timed kiss foley must not be hidden inside a removable style/emotion atom');
const kissH3 = compileTargetPrompt({ canonicalPrompt: kissDraft, durationSec: 2,
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', targetId: 'minimax-h3', detailMode: 'concise' });
assert.ok(kissH3.prompt.includes(authoredKissCue), 'the existing precise kiss cue must survive local draft to H3 compilation');
assert.match(kissH3.prompt, /overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/u);

const authoredLayeredSound = `环境层-[谷风与灵泉声持续] 动作层-[${authoredKissCue}] 情绪层-[无配乐]`;
const layeredKissDraft = renderShotPrompt({ ...baseShot, action: '成年旅人轻吻同伴脸颊', sound: authoredLayeredSound },
  2, [], [baseShot], 'stereo', defaultRuleSets[0]!);
assert.ok(layeredKissDraft.includes(`环境层-[无] 动作层-[${authoredKissCue}] 情绪层-[无配乐]`), 'structured authored audio must preserve its own layers without being nested into a style atom');
const noKissDraft = renderShotPrompt({ ...baseShot, action: '旅人转头看向谷口', sound: '' },
  2, [], [baseShot], 'stereo', defaultRuleSets[0]!);
assert.doesNotMatch(noKissDraft, /吻声/u, 'the local draft cannot invent kiss sounds when no cue or kiss was supplied');
const silentKissDraft = renderShotPrompt({ ...baseShot, action: '成年旅人轻吻同伴脸颊', sound: authoredKissCue },
  2, [], [baseShot], 'none', defaultRuleSets[0]!);
assert.doesNotMatch(silentKissDraft, /吻声/u, 'explicit silent output remains authoritative');

const timedScoreCue = '第0.8s低音量背景音乐：古琴两音淡入';
const timedScoreDraft = renderShotPrompt({ ...baseShot, action: '旅人转头看向谷口', sound: timedScoreCue },
  2, [], [baseShot], 'stereo', defaultRuleSets[0]!);
assert.ok(timedScoreDraft.includes(`动作层-[无] 情绪层-[${timedScoreCue}]`), 'a score timestamp must not turn music into diegetic action sound');
const mixedKissScoreDraft = renderShotPrompt({ ...baseShot, action: '成年旅人轻吻同伴脸颊', sound: `${timedScoreCue}；${authoredKissCue}` },
  2, [], [baseShot], 'stereo', defaultRuleSets[0]!);
assert.ok(mixedKissScoreDraft.includes(`动作层-[${authoredKissCue}] 情绪层-[${timedScoreCue}]`), 'timed score and kiss cues must remain in their respective layers');
const mixedKissScoreH3 = compileTargetPrompt({ canonicalPrompt: mixedKissScoreDraft, durationSec: 2,
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', targetId: 'minimax-h3' });
assert.ok(mixedKissScoreH3.prompt.includes(authoredKissCue));
assert.ok(mixedKissScoreH3.prompt.includes(`情绪层-[${timedScoreCue}]`),
  'the authored local score keeps its exact timing and level in its own shot');
assert.match(mixedKissScoreH3.prompt, /non_diegetic_music: N\/A$/u,
  'a timed local score must not be automatically promoted into a second global music layer');
const lyricTimestampDraft = renderShotPrompt({ ...baseShot, action: '旅人静静站立', sound: '歌词：“第1s听见亲吻声”' },
  2, [], [baseShot], 'stereo', defaultRuleSets[0]!);
assert.match(lyricTimestampDraft, /动作层-\[无\]/u, 'a quoted lyric timestamp must not invent a timed action cue');

const walkingContactPrompt = renderShotPrompt({
  ...baseShot,
  action: '旅人沿湿石径快步走向木桥，伸手扶住摇晃的桥栏',
  sound: '',
  lighting: '瀑布下游的阴天散射光',
}, 4, [], [baseShot], 'stereo', defaultRuleSets[0]!);
assert.match(walkingContactPrompt, /动作层-\[脚步声\]/u, 'lightly holding a rail must not invent an impact cue');
for (const action of ['旅人轻扶同伴的手臂', '旅人轻拉同伴衣袖', '旅人轻拍同伴的肩膀', '成年旅人轻吻同伴脸颊']) {
  const quietContactPrompt = renderShotPrompt({ ...baseShot, action, camera: '中景固定', sound: '' },
    2, [], [baseShot], 'stereo', defaultRuleSets[0]!);
  assert.match(quietContactPrompt, /动作层-\[无\]/u, `a minor contact does not require a separate foley cue: ${action}`);
}
const impactPrompt = renderShotPrompt({ ...baseShot, action: '旅人快跑后肩膀撞上木门', sound: '' },
  2, [], [baseShot], 'stereo', defaultRuleSets[0]!);
assert.match(impactPrompt, /动作层-\[脚步声与接触碰撞声\]/u, 'actual footsteps and forceful collision must remain available');
const faintKissCue = '第1.2s中景轻吻非常轻，几乎听不见';
const faintKissDraft = renderShotPrompt({ ...baseShot, action: '成年旅人轻吻同伴脸颊', camera: '中景固定', sound: faintKissCue },
  2, [], [baseShot], 'stereo', defaultRuleSets[0]!);
const faintKissH3 = compileTargetPrompt({ canonicalPrompt: faintKissDraft, durationSec: 2,
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', targetId: 'minimax-h3' });
assert.ok(faintKissH3.prompt.includes(faintKissCue), 'near-inaudible source mixing must survive local draft and H3 compilation unchanged');
assert.doesNotMatch(faintKissH3.prompt, /清楚可辨|可辨识|贴麦|loud kiss/u);

const protectedStyleCanonical = renderShotPrompt({
  ...baseShot,
  id: 'soundscape-protected-style-only',
  action: '旅人静立在山谷石台上',
  sound: '风格雨声、碰撞与战鼓',
  lighting: '清晨散射光',
}, 2, [], [baseShot], 'stereo', defaultRuleSets[0]!);
assert.match(
  protectedStyleCanonical,
  /风格预设声音〔风格雨声、碰撞与战鼓〕/u,
  'editable style sound must remain a protected canonical atom',
);
assert.match(
  protectedStyleCanonical,
  /环境层-\[无\] 动作层-\[无\] 情绪层-\[无配乐｜风格预设声音/u,
  'protected style sound must not drive canonical environment, action, or emotion inference',
);
const protectedStyleH3 = compileTargetPrompt({
  canonicalPrompt: protectedStyleCanonical,
  durationSec: 2,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
  constraints: [],
}).prompt;
const protectedStyleH3Soundscape = protectedStyleH3
  .split('overall_soundscape: ')[1]
  ?.split('\n\nnon_diegetic_music:')[0] || '';
assert.equal(protectedStyleH3Soundscape, 'N/A');
assert.doesNotMatch(
  protectedStyleH3,
  /风格雨声|接触碰撞声|战鼓/u,
  'protected style rain, impacts, and drums must not leak through renderShotPrompt into H3 audio fields',
);
assert.match(protectedStyleH3, /non_diegetic_music: N\/A$/u);

const officialLimitCompressionConstraint = `外部画面约束：${'保持背景层次方向色温与空间关系完全连续'.repeat(520)}`;
const overflowSoundscapeH3 = compileTargetPrompt({
  canonicalPrompt: [
    '【0s-2s】 主体：@旅人；动作：旅人抬起左脚跨过第一块覆满青苔的湿石→右脚落在石缝边缘重新寻找支点→左手扶住外侧岩壁稳住肩胯→确认背后同伴已经跟上后继续向瀑布方向前进→停在凸起石脊旁观察前方落脚点与水流方向；空间：瀑布下游狭窄石径；光影：阴天散射光；镜头：低机位侧向稳定跟拍；台词：无；音效：环境层-[雨声] 动作层-[第0.4s鞋底踩湿石声] 情绪层-[无配乐]',
    '【2s-4s】 主体：@旅人；动作：旅人侧身穿过两株向石径中央倾斜的老树→收起右肩避开垂落藤蔓→鞋底沿湿润泥地连续换步→回头确认同伴位置后转向山谷深处→越过树根时保持视线锁定下一段安全路线；空间：瀑布下游狭窄石径；光影：树冠漏下冷灰天光；镜头：中景横向稳定跟拍；台词：无；音效：环境层-[风声] 动作层-[第0.4s鞋底踩湿石声] 情绪层-[无配乐]',
    '【4s-6s】 主体：@旅人；动作：旅人绕开横卧路面的断枝并踏上第二段湿石台阶→膝盖弯曲吸收落差→双臂向两侧展开保持平衡→站稳后沿着瀑布水雾覆盖的路线继续上行→经过弯道时再次检查脚下苔藓覆盖范围；空间：瀑布下游狭窄石径；光影：水雾中的柔和逆光；镜头：全景缓慢前推跟拍；台词：无；音效：环境层-[雨声] 动作层-[第0.4s鞋底踩湿石声] 情绪层-[无配乐]',
    '【6s-8s】 主体：@旅人；动作：旅人贴近岩壁经过一段只能容纳单人通行的窄路→右手沿粗糙石面移动寻找支撑→左脚试探前方松动碎石→避开滑落石块后重新踏稳→身体通过最窄处后缓慢恢复正面朝向；空间：瀑布下游狭窄石径；光影：岩壁反射的冷色漫射光；镜头：近景从前侧后退跟拍；台词：无；音效：环境层-[雨声] 动作层-[第0.4s鞋底踩湿石声] 情绪层-[无配乐]',
    '【8s-10s】 主体：@旅人；动作：旅人从岩壁阴影中走回开阔石径→先观察前方木桥的摇晃幅度→压低身体重心迎着水雾迈出两步→在桥头界石旁短暂停顿等待通行时机→辨认桥板受力位置后选择靠内侧落脚；空间：瀑布下游狭窄石径；光影：开阔处均匀阴天光；镜头：中远景弧线环绕跟拍；台词：无；音效：环境层-[雨声] 动作层-[第0.4s鞋底踩湿石声] 情绪层-[无配乐]',
    '【10s-12s】 主体：@旅人；动作：旅人确认木桥暂时稳定后迈向第一块桥板→后脚离开湿石前再次调整身体朝向→双手保持张开以抵消桥面的横向晃动→最终站在桥头望向瀑布上游→确认同行者抵达后保持位置等待下一步行动；空间：瀑布下游狭窄石径；光影：远处水面反射的银灰轮廓光；镜头：平视中景逐步后拉；台词：无；音效：环境层-[雨声] 动作层-[第0.4s鞋底踩湿石声] 情绪层-[无配乐]',
  ].join('\n'),
  durationSec: 12,
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'stereo',
  targetId: 'minimax-h3',
  detailMode: 'concise',
  references: [],
  constraints: [officialLimitCompressionConstraint],
});
assert.ok(
  overflowSoundscapeH3.prompt.length > 7000,
  'the complete soundscape fixture must exceed the retired local limit without triggering a lower-detail candidate',
);
assert.ok(
  overflowSoundscapeH3.prompt.includes(officialLimitCompressionConstraint),
  'long non-story constraints must be retained in full instead of discarded by an ultra-compact candidate',
);
const overflowSoundscapeShotBlocks = Array.from(
  overflowSoundscapeH3.prompt.matchAll(/\[Shot (\d+)\][\s\S]*?(?=\[Shot \d+\]|\n\noverall_soundscape:)/gu),
  (match) => match[0],
);
assert.equal(overflowSoundscapeShotBlocks.length, 6);
overflowSoundscapeShotBlocks.forEach((shotBlock, index) => {
  assert.match(
    shotBlock,
    /声音：[^\n]*第0\.4s鞋底踩湿石声/u,
    `overflow Shot ${index + 1} must retain its explicitly authored local foley`,
  );
});
const overflowGlobalSoundscape = overflowSoundscapeH3.prompt
  .split('overall_soundscape: ')[1]
  ?.split('\n\nnon_diegetic_music:')[0] || '';
assert.equal(
  overflowGlobalSoundscape,
  'N/A',
  'long prompts must not aggregate shot-local rain and wind into an extra global bed',
);
assert.deepEqual([...overflowSoundscapeH3.prompt.matchAll(/环境层-\[([^\]]*)\]/gu)].map((match) => match[1]),
  ['雨声', '风声', '雨声', '雨声', '雨声', '雨声'],
  'the complete local environment order and original scope survive without global promotion');
assert.match(overflowSoundscapeH3.prompt, /non_diegetic_music: N\/A$/u);

console.log('focused soundscape regression checks passed');
