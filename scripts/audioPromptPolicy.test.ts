import assert from 'node:assert/strict';
import {
  AUDIO_PROMPT_RULE,
  AUDIO_H3_DELIVERY_RULE,
  AUDIO_EXISTING_SCOPE_RULE,
  AUDIO_TRANSLATION_SCOPE_RULE,
  DIEGETIC_AUDIO_SCOPE_RULE,
  DIALOGUE_DELIVERY_RULE,
  NATURAL_ACTION_AUDIO_RULE,
  NATURAL_BACKGROUND_MUSIC_RULE,
  NO_DIALOGUE_PERFORMANCE_RULE,
  STORY_DRIVEN_MUSIC_RULE,
  VISUAL_IDENTITY_SPEECH_SCOPE_RULE,
  normalizeShotAmbientSound,
  stripAmbientBedFromAction,
  stripContinuousAmbientBed,
} from '../src/audioPromptPolicy';
import { compileTargetPrompt, type PromptAdapterInput } from '../src/promptAdapters';

assert.match(AUDIO_PROMPT_RULE, /新生成默认仅剧情内声音.*non_diegetic_music写N\/A/u);
assert.match(AUDIO_PROMPT_RULE, /只有用户在本次请求中明确要求非叙事配乐.*才可写入non_diegetic_music/u);
assert.match(AUDIO_PROMPT_RULE, /仅无事件的背景近静音，不是整条音轨静音/u);
assert.ok(AUDIO_PROMPT_RULE.includes(NATURAL_ACTION_AUDIO_RULE));
assert.match(AUDIO_PROMPT_RULE, /镜头距离、动作力度.*不为每个小动作配声/u);
assert.match(AUDIO_PROMPT_RULE, /亲吻不强制每次都有独立音效.*中景轻吻可以非常轻、甚至几乎听不见/u);
assert.match(AUDIO_PROMPT_RULE, /不突出“啵”、夸张唇部弹响或贴麦口部声/u);
assert.doesNotMatch(AUDIO_PROMPT_RULE, /不把动作音压成不可闻|不能只用含糊的“极轻接触声”代替吻声/u);
assert.match(AUDIO_PROMPT_RULE, /未发生、只是靠近、想吻或差点吻不能加吻声/u);
assert.match(AUDIO_PROMPT_RULE, /不自动添加持续呼吸、ASMR或摩擦声/u);
assert.equal(AUDIO_PROMPT_RULE.includes(STORY_DRIVEN_MUSIC_RULE), true, 'shared audio rule must expose evidence-based story music guidance');
assert.match(STORY_DRIVEN_MUSIC_RULE, /剧情情绪转折、危险、追逐、回忆、亲密关系、胜利收束.*不是自动添加非叙事BGM的依据/u);
assert.match(STORY_DRIVEN_MUSIC_RULE, /场景名称、天气、普通走动和风格预设.*不是自动添加非叙事BGM的依据/u);
assert.match(STORY_DRIVEN_MUSIC_RULE, /用户明确“无\/不要\/禁止配乐”始终优先/u);
assert.ok(STORY_DRIVEN_MUSIC_RULE.includes(NATURAL_BACKGROUND_MUSIC_RULE));
assert.match(NATURAL_BACKGROUND_MUSIC_RULE, /非叙事背景音乐（BGM\/score）不是默认声层/u);
assert.match(NATURAL_BACKGROUND_MUSIC_RULE, /简洁、柔和、极低存在感/u);
assert.match(NATURAL_BACKGROUND_MUSIC_RULE, /不是API音量参数或实际测量结果/u);
assert.match(NATURAL_BACKGROUND_MUSIC_RULE, /远离前景并让位于对白和关键动作声/u);
assert.match(NATURAL_BACKGROUND_MUSIC_RULE, /不压低对白或整条音轨/u);
assert.match(NATURAL_BACKGROUND_MUSIC_RULE, /切镜不突然重启或增响/u);
assert.match(NATURAL_BACKGROUND_MUSIC_RULE, /切镜不突然重启或增响.*不靠增大音量/u);
assert.match(NATURAL_BACKGROUND_MUSIC_RULE, /风格预设.*不能授权你自行补BGM/u);
assert.match(AUDIO_H3_DELIVERY_RULE, /non_diegetic_music固定写N\/A.*不自动补背景音乐/u);
assert.match(AUDIO_H3_DELIVERY_RULE, /明确要求非叙事配乐.*极低存在感.*让位于对白与关键动作声/u);
assert.match(AUDIO_H3_DELIVERY_RULE, /audioMode为none.*不添加音乐、对白声或动作声/u);
assert.match(AUDIO_H3_DELIVERY_RULE, /保持原有H3字段名称与顺序、对白及说话人，镜数与切点保持已确认排程/u);
assert.match(AUDIO_H3_DELIVERY_RULE, /仅本次指令明确授权taskAuthority=current-segment-staging-replan时.*同时交付的修正canonicalPrompt.*固定段长与exact镜数仍不变/u);
assert.match(AUDIO_H3_DELIVERY_RULE, /若本次明确是格式修复、参考图更新或上下段衔接修复.*不重新配乐/u);
assert.match(AUDIO_H3_DELIVERY_RULE, /overall_soundscape只写整段范围的简短剧情内环境\/声景摘要/u);
assert.match(AUDIO_H3_DELIVERY_RULE, /具体对白原字、唯一说话人、声源编号、逐镜无对白.*全部写在对应\[Shot N\]/u);
assert.match(AUDIO_H3_DELIVERY_RULE, /不得在overall_soundscape中列Shot编号、对白复述、声源分配、镜内时序或长篇否定清单/u);
assert.match(AUDIO_H3_DELIVERY_RULE, /不得新增negative_prompt、negative、反向提示词或其它声音section/u);
assert.match(AUDIO_TRANSLATION_SCOPE_RULE, /sourcePrompt为准.*无对白不抬升/u);
assert.match(AUDIO_TRANSLATION_SCOPE_RULE, /N\/A原样保留.*不借新声音规则重写旧稿的混音方案/u);
assert.match(AUDIO_EXISTING_SCOPE_RULE, /只更新已有提示词中明确要求的非声音内容.*不得重新选配器/u);
assert.equal(AUDIO_PROMPT_RULE.split(DIEGETIC_AUDIO_SCOPE_RULE).length - 1, 1,
  'planning, conversion and their existing repairs inherit one source-and-time scope rule');
assert.match(DIEGETIC_AUDIO_SCOPE_RULE, /可见环境、明确可听的有源事件和有剧情理由的跨镜声床/u);
assert.match(DIEGETIC_AUDIO_SCOPE_RULE, /看见风吹衣摆、水面、瀑布、雨景或烟雾.*只是视觉事实/u);
assert.match(DIEGETIC_AUDIO_SCOPE_RULE, /原文明写听见、传来.*保留该声源.*不能一刀切删成无声/u);
assert.match(DIEGETIC_AUDIO_SCOPE_RULE, /声源存在、一直可见、发生在同一地点.*不等于.*从本段0秒持续到结束/u);
assert.match(DIEGETIC_AUDIO_SCOPE_RULE, /进入、可听范围和退出.*远近、遮挡.*前后层级/u);
assert.match(DIEGETIC_AUDIO_SCOPE_RULE, /远处传来瀑布坠落声.*实际听到它的事件时段.*不能改成整段持续/u);
assert.match(DIEGETIC_AUDIO_SCOPE_RULE, /不把所有真实声音强制缩成短音/u);
assert.match(DIEGETIC_AUDIO_SCOPE_RULE, /“轻微、低响、柔和、远处”只约束听感，不是持续时间授权/u);
assert.match(DIEGETIC_AUDIO_SCOPE_RULE, /同一声源只安排一次.*不再在overall_soundscape中变成第二条全局铺底/u);
assert.match(DIEGETIC_AUDIO_SCOPE_RULE, /没有剧情依据的全局声床时overall_soundscape写N\/A.*局部环境声、对白与动作声仍保留/u);
assert.match(AUDIO_H3_DELIVERY_RULE, /局部环境声的出现、结束和听觉距离保留在对应镜内/u);
assert.match(AUDIO_TRANSLATION_SCOPE_RULE, /出现与结束时段、相对本镜或本段的时间坐标.*前景或背景层级/u);
assert.match(AUDIO_TRANSLATION_SCOPE_RULE, /不把局部事件改成贯穿全段的continuous\/throughout ambience/u);
assert.match(AUDIO_TRANSLATION_SCOPE_RULE, /同一已确认跨镜声源保持原范围，不能一刀切删掉或改短/u);
assert.match(AUDIO_EXISTING_SCOPE_RULE, /不延长局部声音、不提前引入后段声源.*不在镜内与overall_soundscape新增重复铺底/u);

for (const sharedRule of [VISUAL_IDENTITY_SPEECH_SCOPE_RULE, NO_DIALOGUE_PERFORMANCE_RULE]) {
  assert.equal(DIALOGUE_DELIVERY_RULE.split(sharedRule).length - 1, 1,
    'the shared dialogue contract carries each identity/no-speech rule once');
  assert.ok(AUDIO_PROMPT_RULE.includes(sharedRule),
    'existing generation callers inherit the same rules without another API stage');
}
assert.match(VISUAL_IDENTITY_SPEECH_SCOPE_RULE, /人物姓名、资料、角色\/形态名称、参考图名称、图片槽位、身份映射及参考职责.*不是台词/u);
assert.match(VISUAL_IDENTITY_SPEECH_SCOPE_RULE, /保留资料与画面描述中的完整姓名.*不靠删除、改名或占位符/u);
assert.match(VISUAL_IDENTITY_SPEECH_SCOPE_RULE, /真实台词本来就在呼喊姓名.*逐字保留该句、原说话人和时刻/u);
assert.match(NO_DIALOGUE_PERFORMANCE_RULE, /从0秒到该段结束（包括最后几秒）都不说话/u);
assert.match(NO_DIALOGUE_PERFORMANCE_RULE, /不新增喊名、含混交谈、耳语、旁白或说话口型/u);
assert.match(NO_DIALOGUE_PERFORMANCE_RULE, /仅当原稿明确要求不可辨词汇的人声.*该区间没有明确要求无对白/u);
assert.match(NO_DIALOGUE_PERFORMANCE_RULE, /无对白不等于整轨静音.*笑声、咳嗽、哭泣等非语言声及必要动作声/u);
assert.match(NO_DIALOGUE_PERFORMANCE_RULE, /不等于嘴唇永久闭合或表情冻结.*微笑、亲吻、进食等非说话动作/u);
assert.match(NO_DIALOGUE_PERFORMANCE_RULE, /只覆盖原定无对白区间.*不删其它镜头或其它时刻的真实台词/u);

for (const value of [
  '现场环境底噪', '室内环境底噪', '潮湿林地底噪持续',
  '第0.3s远处溪流持续', '第1s起远处溪流持续', '灵溪水声逐渐增强',
  'continuous damp forest floor noise', 'room tone', 'white noise',
  'valley wind continuing', 'valley wind continues', 'spirit stream water sound gradually rising',
  '持续风声和溪流声', 'continuous wind and water ambience',
  'water ambience and continuous wind',
  '全局白噪声持续15秒', '第0s整段白噪声持续15秒后停止',
]) {
  assert.equal(stripContinuousAmbientBed(value), '', `remove continuous ambient bed: ${value}`);
}

for (const value of [
  '第0.5s脚步落地，第1s碰撞',
  '第0.5s电流滋滋声持续0.2秒',
  '第0.5s白噪声响0.2秒后立即停止',
  '第0.5s短暂白噪声随收音机开关停止',
  'At 0.5s a white noise burst lasting 0.2 seconds cuts off',
  '第1s一阵风声持续2秒',
  '第2s树叶滴水声', '远处传来三声鸟鸣',
  '持续低音量背景音乐与雨声',
  '持续古琴背景音乐', 'continuous low-volume background music',
  '第1s人物说“这里没有背景噪声。”',
]) {
  assert.equal(stripContinuousAmbientBed(value), value, `preserve authored event, music or quote: ${value}`);
}

assert.equal(
  stripContinuousAmbientBed('连续谷风。第0.5s脚步落地。第1s碰撞'),
  '第0.5s脚步落地。第1s碰撞',
  'sentence delimiters must not swallow following timed action sounds',
);
assert.equal(
  stripContinuousAmbientBed('continuous wind. Footstep at 0.5s. Bell at 1s'),
  'Footstep at 0.5s. Bell at 1s',
  'English sentence punctuation must not split decimal timestamps or lose following sounds',
);
assert.equal(
  stripContinuousAmbientBed('第1s脚步声与现场底噪，第2.5s玉佩碰撞'),
  '第1s脚步声，第2.5s玉佩碰撞',
);
assert.equal(
  normalizeShotAmbientSound('环境层-[湿林底噪持续] 动作层-[第1s脚步声，连续谷风，第2.5s玉佩碰撞] 情绪层-[持续古琴背景音乐]'),
  '环境层-[无] 动作层-[第1s脚步声，第2.5s玉佩碰撞] 情绪层-[持续古琴背景音乐]',
);
const briefRadioNoise = '第0.5s白噪声响0.2秒后立即停止';
assert.equal(stripAmbientBedFromAction(briefRadioNoise), briefRadioNoise, 'bounded noise events must also survive action-tail cleanup');
assert.equal(
  normalizeShotAmbientSound(`环境层-[白噪声铺底] 动作层-[${briefRadioNoise}与连续谷风，第1s开关轻响] 情绪层-[无配乐]`),
  `环境层-[无] 动作层-[${briefRadioNoise}，第1s开关轻响] 情绪层-[无配乐]`,
  'an adjacent ambient bed must not turn a bounded radio burst into removable background noise',
);

assert.equal(
  stripAmbientBedFromAction('旅人迈向桥头，灵溪水声逐渐增强，转身看向同伴'),
  '旅人迈向桥头，转身看向同伴',
);
assert.equal(stripAmbientBedFromAction('持续风声和溪流声'), '');
assert.equal(stripAmbientBedFromAction('continuous wind and water ambience'), '');
assert.equal(
  stripAmbientBedFromAction('保持人物身份；全局连续林地底噪；不得删对白'),
  '保持人物身份；不得删对白',
);
for (const action of [
  '谷风持续吹来掀开旅人衣摆', '溪水淹过石阶并持续上涨',
  '溪水持续拍打桥面', '山风持续吹动衣摆',
  'continuous wind blows open the door',
  '角色说出“室内底噪”之后离去', '角色望向雨幕并停在桥头',
]) assert.equal(stripAmbientBedFromAction(action), action, `visual or quoted actions must remain intact: ${action}`);

const canonical = [
  '【0s-5s】 主体：@旅人；动作：旅人踏上石阶；空间：潮湿林地；光影：冷灰天光；镜头：中景跟拍；台词：第1s @旅人："风声持续。快走！"；音效：环境层-[潮湿林地底噪持续，谷风持续] 动作层-[第2.5s脚步落地] 情绪层-[无配乐]',
  '【5s-10s】 主体：@旅人；动作：旅人扶住木桥；空间：溪谷；光影：冷灰天光；镜头：侧向跟拍；台词：无；音效：环境层-[连续风声和溪流声] 动作层-[第1s手掌碰木声，第3s玉佩碰撞] 情绪层-[无配乐]',
  '【10s-15s】 主体：@旅人；动作：旅人在桥头停住，灵溪水声逐渐增强，转身看向同伴；空间：溪谷木桥；光影：冷灰天光；镜头：近景固定；台词：无；音效：环境层-[灵溪水声逐渐增强] 动作层-[第1s脚步停住] 情绪层-[无配乐]',
].join('\n');
const input: PromptAdapterInput = {
  canonicalPrompt: canonical, durationSec: 15, aspectRatio: '16:9',
  resolution: '2K', audioMode: 'stereo', targetId: 'minimax-h3', detailMode: 'concise',
  constraints: ['保持人物身份；全局连续林地底噪；不得删对白'],
};
const unchangedInput = structuredClone(input);
const parameterControl = compileTargetPrompt({ ...input, canonicalPrompt: canonical.replaceAll('底噪', '声景') });
for (const references of [
  [],
  [{ id: 'frame', name: '首帧', mediaType: 'image', role: 'first-frame' }],
  [{ id: 'ref', name: '人物参考', mediaType: 'image', role: 'character' }],
]) {
  const output = compileTargetPrompt({ ...input, references });
  assert.deepEqual(output.parameters, parameterControl.parameters, 'audio text changes must not alter any generation parameter');
  assert.deepEqual(input, unchangedInput, 'normalization must not mutate source canonical data');
  assert.doesNotMatch(output.prompt, /底噪|溪流声|溪水声|谷风持续|连续风声/u);
  assert.match(output.prompt, /风声持续。快走！/u, 'dialogue containing sound words must be preserved');
  assert.match(output.prompt, /第2\.5s脚步落地/u);
  assert.match(output.prompt, /第1s手掌碰木声，第3s玉佩碰撞/u);
  assert.match(output.prompt, /第1s脚步停住/u);
  assert.match(output.prompt, /转身看向同伴/u);
  assert.match(output.prompt, /At 00:05\.000/u);
  assert.match(output.prompt, /At 00:10\.000/u);
  assert.match(output.prompt, /overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/u);
  const shotBody = output.prompt.split(output.prompt.includes('detailed_description:') ? 'detailed_description:' : 'integrated_multimodal_description:')[1]
    ?.split('overall_soundscape:')[0] || '';
  assert.equal((shotBody.match(/\[Shot \d+\]/gu) || []).length, 3);
}

const explicitMusic = compileTargetPrompt({
  ...input,
  canonicalPrompt: canonical.replace('情绪层-[无配乐]', '情绪层-[持续古琴背景音乐]'),
});
assert.match(explicitMusic.prompt, /情绪层-\[持续古琴背景音乐\]/u);
assert.match(explicitMusic.prompt, /non_diegetic_music: N\/A$/u, 'authored emotion audio stays in its own shot instead of being promoted by keywords');
const explicitLegacyMusic = compileTargetPrompt({
  ...input,
  canonicalPrompt: canonical.replace('情绪层-[无配乐]', '情绪层-[悬疑弦乐持续音]'),
  constraints: ['必须保留悬疑弦乐持续音背景配乐，低音量'],
});
assert.ok(explicitLegacyMusic.prompt.includes('情绪层-[悬疑弦乐持续音]'));
assert.ok(explicitLegacyMusic.prompt.includes('必须保留悬疑弦乐持续音背景配乐，低音量'));
assert.match(explicitLegacyMusic.prompt, /non_diegetic_music: N\/A$/u, 'free-form legacy score requests remain available to AI without a local score decision');
const storyInferredMusic = compileTargetPrompt({
  ...input,
  canonicalPrompt: canonical.replace('情绪层-[无配乐]', '情绪层-[悬疑弦乐持续音]'),
  constraints: [],
});
assert.match(storyInferredMusic.prompt, /情绪层-\[悬疑弦乐持续音\]/u, 'an AI-authored story score survives at its authored shot scope');
assert.match(storyInferredMusic.prompt, /non_diegetic_music: N\/A$/u);
const requestedPiano = compileTargetPrompt({ ...input, constraints: ['背景音乐：使用钢琴点奏，低音量'] });
assert.match(requestedPiano.prompt, /non_diegetic_music: 使用钢琴点奏，低音量$/u, 'explicit field syntax maps verbatim, without automatic mix instructions');
const conditionalMusic = compileTargetPrompt({ ...input, constraints: ['如果有配乐则使用钢琴点奏，低音量'] });
assert.match(conditionalMusic.prompt, /non_diegetic_music: N\/A$/u);

for (const request of [
  '只在最后两秒使用低音量背景音乐，其余无配乐',
  '配乐为《无言》钢琴独奏，低音量',
  '音乐不要太大声，保持低音量钢琴背景音乐',
  '禁止高音量配乐，保留低音量钢琴背景音乐',
  '必须使用背景音乐，低音量，不要太大声',
  '要求背景音乐选用《不要背景音乐》钢琴独奏，低音量',
]) {
  const scored = compileTargetPrompt({ ...input, constraints: [request] });
  const music = scored.prompt.split('non_diegetic_music: ')[1] || '';
  assert.ok(scored.prompt.includes(request), `preserve the exact score schedule, title and volume request for AI review: ${request}`);
  assert.equal(music, 'N/A', 'free prose is not a structured global music field');
  assert.doesNotMatch(scored.prompt, /配乐保持稀疏|无对白不抬升/u);
  assert.match(scored.prompt, /风声持续。快走！/u);
  assert.match(scored.prompt, /第2\.5s脚步落地/u);
  assert.deepEqual(scored.parameters, parameterControl.parameters);
}
for (const constraints of [
  ['无背景音乐，只保留钢琴坠地的碰撞声'],
  ['只保留钢琴坠地的碰撞声'],
  ['使用钢琴点奏，不要背景音乐'],
  ['使用钢琴点奏，不要BGM'],
  ['使用钢琴点奏；不要背景音乐'],
  ['使用钢琴点奏', '不要背景音乐'],
  ['要求角色说“使用钢琴配乐”'],
]) {
  const unscored = compileTargetPrompt({ ...input, constraints });
  assert.match(unscored.prompt, /non_diegetic_music: N\/A$/u, `physical sound, dialogue or a direct score exclusion must not create music: ${constraints.join('；')}`);
  assert.match(unscored.prompt, /第2\.5s脚步落地/u);
}
const contradictorySavedScore = compileTargetPrompt({
  ...input,
  canonicalPrompt: canonical.replace('情绪层-[无配乐]', '情绪层-[轻柔钢琴配乐]'),
  constraints: ['使用钢琴点奏，不要背景音乐'],
});
assert.match(contradictorySavedScore.prompt, /non_diegetic_music: N\/A$/u, 'an old emotion cue must not create a global score');
assert.ok(contradictorySavedScore.prompt.includes('使用钢琴点奏，不要背景音乐'), 'AI receives the current requirement unchanged to resolve authored conflicts');
const defaultWithExplicitScore = compileTargetPrompt({
  ...input,
  canonicalPrompt: canonical.replace('情绪层-[无配乐]', '情绪层-[轻柔钢琴配乐]'),
  constraints: ['规则基础：默认无配乐，明确要求的配乐保留低音量'],
});
assert.match(defaultWithExplicitScore.prompt, /情绪层-\[轻柔钢琴配乐\]/u, 'an internal default must not delete authored shot audio');
assert.match(defaultWithExplicitScore.prompt, /non_diegetic_music: N\/A$/u);
for (const references of [[], [{ id: 'ref', name: '人物参考', mediaType: 'image', role: 'character' }]]) {
  const radioEvent = compileTargetPrompt({
    ...input,
    references,
    canonicalPrompt: canonical.replace('第2.5s脚步落地', `${briefRadioNoise}，第2.5s脚步落地`),
  });
  assert.ok(radioEvent.prompt.includes(briefRadioNoise), 'the integrated and full-reference compilers must preserve the bounded radio burst');
  assert.match(radioEvent.prompt, /第2\.5s脚步落地/u);
  assert.match(radioEvent.prompt, /风声持续。快走！/u);
  assert.doesNotMatch(radioEvent.prompt, /潮湿林地底噪持续|谷风持续/u);
}

const scores = ['古琴', '钢琴', '小提琴', '大提琴', '管风琴', '吉他', '木琴', '铜管', '合唱'];
const manyScores = compileTargetPrompt({
  ...input, durationSec: 9, constraints: [],
  canonicalPrompt: scores.map((score, index) => `【${index}s-${index + 1}s】 主体：@旅人；动作：旅人向前迈步；空间：林间石径；光影：阴天；镜头：中景；台词：无；音效：环境层-[无] 动作层-[第0.2s脚步声] 情绪层-[无]；配乐：${score}点奏`).join('\n'),
});
const scoreField = manyScores.prompt.split('non_diegetic_music: ')[1] || '';
scores.forEach((score) => assert.ok(scoreField.includes(`${score}点奏`), `explicit score must not be sampled away: ${score}`));
const silent = compileTargetPrompt({ ...input, audioMode: 'none', constraints: ['背景音乐：使用钢琴点奏，低音量'] });
assert.match(silent.prompt, /overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/u);

// These are the four verbatim environment fields in the supplied 00107
// workflow. Shared modifiers must not leave either half of a noise bed behind.
const leakedEnvironmentClauses = [
  '谷风与灵泉声压至很低',
  '谷风与灵泉声持续',
  '环境风与灵泉低响持续',
  '谷风轻微上扬，远处灵泉声持续',
];
for (const value of [
  ...leakedEnvironmentClauses,
  '低位谷风与灵泉声', '谷风与溪水声持续', '谷风持续与灵泉声持续',
  '谷风、灵泉声，都持续铺底', '持续，谷风与灵泉声',
  'valley wind and spirit spring sounds continuing',
  'quiet valley wind with spirit spring ambience',
  'wind and fountain ambience kept very low',
  'environmental wind and spring sounds slowly rising',
  'wind and spring sounds, both continuous',
  'continuous, wind and spring sounds',
]) {
  assert.equal(stripContinuousAmbientBed(value), '', `audio fields must remove the entire ambient group: ${value}`);
  assert.equal(stripAmbientBedFromAction(value), '', `action-tail cleanup must remove the same ambient group: ${value}`);
}
const subtleKiss = '第1.2s唇触脸颊时细微短促可辨识的轻吻声';
const subtleLipContact = '第2s唇部接触额头的短促唇接触声';
for (const value of [
  subtleKiss, subtleLipContact,
  'At 1.2s a soft kiss beside the spring',
  'At 2s a faint lip contact sound in the valley wind',
  '第1s低位谷风与灵泉声持续2秒后停止',
  '第1s灵泉声短暂响起后停止',
  'At 1s a quiet spring sound lasting 0.2 seconds cuts off',
  '持续谷风吹拂衣摆', '谷风持续卷起衣角', 'continuous wind blows the cloak',
  '对白：“谷风与灵泉声持续。”', "lyrics: 'continuous quiet spring sounds'",
  '持续低音量背景音乐与雨声',
]) {
  assert.equal(stripContinuousAmbientBed(value), value, `preserve authored event, physical action, score or quotation: ${value}`);
  assert.equal(stripAmbientBedFromAction(value), value, `action cleanup must preserve authored event, action or quotation: ${value}`);
}
assert.equal(stripContinuousAmbientBed(`谷风与灵泉声持续，${subtleKiss}，${subtleLipContact}`), `${subtleKiss}，${subtleLipContact}`);
assert.equal(stripContinuousAmbientBed('quiet piano score with continuous spring ambience'), 'quiet piano score');
assert.equal(stripAmbientBedFromAction('旅人先转身，谷风与灵泉声持续，随后在她脸颊亲一下'), '旅人先转身，随后在她脸颊亲一下');
assert.equal(normalizeShotAmbientSound(`环境层-[谷风与灵泉声持续] 动作层-[${subtleKiss}，${subtleLipContact}] 情绪层-[无配乐]`),
  `环境层-[无] 动作层-[${subtleKiss}，${subtleLipContact}] 情绪层-[无配乐]`);
assert.equal(normalizeShotAmbientSound('环境层-[谷风与灵泉声持续] 动作层-[无] 情绪层-[无配乐]'),
  '环境层-[无] 动作层-[无] 情绪层-[无配乐]', 'background cleanup must never invent a missing kiss, breath or other foreground event');

const repairedCuts = [0, 4, 8, 11, 15];
const realLeakInput: PromptAdapterInput = {
  ...input, constraints: [],
  canonicalPrompt: leakedEnvironmentClauses.map((environment, index) => [
    `【${repairedCuts[index]}s-${repairedCuts[index + 1]}s】 主体：@旅人；动作：旅人轻吻同伴脸颊后停住，${environment}`,
    '空间：谷口石台；光影：晨光；镜头：中景固定',
    index === 0 ? '台词：第1s @旅人："谷风与灵泉声持续。"' : '台词：无',
    `音效：环境层-[${environment}] 动作层-[${subtleKiss}，${subtleLipContact}] 情绪层-[无配乐]`,
  ].join('；')).join('\n'),
};
const realLeakSnapshot = structuredClone(realLeakInput);
for (const references of [[], [{ id: 'kiss-reference', name: '人物参考', mediaType: 'image', role: 'composition' }]]) {
  const repaired = compileTargetPrompt({ ...realLeakInput, references });
  assert.deepEqual([...repaired.prompt.matchAll(/环境层-\[([^\]]*)\]/gu)].map((match) => match[1]), ['无', '无', '无', '无']);
  assert.match(repaired.prompt, /overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/u);
  assert.equal(repaired.prompt.split(subtleKiss).length - 1, 4, 'each visible kiss retains its own precisely timed audible event');
  assert.equal(repaired.prompt.split(subtleLipContact).length - 1, 4);
  assert.equal((repaired.prompt.match(/轻吻同伴脸颊后停住/gu) || []).length, 4);
  assert.match(repaired.prompt, /"谷风与灵泉声持续。"/u, 'dialogue is not ambient sound and remains untouched');
  for (const cut of ['At 00:04.000', 'At 00:08.000', 'At 00:11.000']) assert.ok(repaired.prompt.includes(cut));
  assert.deepEqual(repaired.parameters, compileTargetPrompt({ ...realLeakInput, references, canonicalPrompt: realLeakInput.canonicalPrompt.replaceAll('灵泉', '泉水') }).parameters);
}
assert.deepEqual(realLeakInput, realLeakSnapshot);

console.log('quiet audio policy regression checks passed');
