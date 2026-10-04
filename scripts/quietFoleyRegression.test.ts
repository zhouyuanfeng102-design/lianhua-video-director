import assert from 'node:assert/strict';
import { compileTargetPrompt, type PromptAdapterInput, type PromptReferenceInput } from '../src/promptAdapters';

const beds = [
  '谷风与灵泉声压至很低',
  '谷风与灵泉声持续',
  '环境风与灵泉低响持续',
  '谷风轻微上扬，远处灵泉声持续',
];
const actions = [
  '林岚向韩竹靠近→双唇轻触韩竹左脸→分开停住',
  '韩竹轻吻林岚额头→停住后后退',
  '林岚转头看向谷口',
  '韩竹扶住林岚手臂→两人站稳',
];
const cues = [
  '第1.2s唇部接触脸颊时一次细微、短促、清晰可辨的轻吻声',
  '第2s唇部接触额头时一次细微、短促、清晰可辨的轻吻声',
  '无',
  '第0.5s扶住手臂时一次短促衣料接触声',
];
const starts = [0, 4, 8, 11];
const ends = [4, 8, 11, 15];
const canonical = actions.map((action, index) => [
  `【${starts[index]}s-${ends[index]}s】 主体：@林岚与@韩竹（成年人，平静）[朝向：同伴] 正在 [${action}]（推进互动）`,
  '空间：前景-衣袖 中景-两位成年人 背景-灵泉与谷口风雾',
  '光影：月光与暖色流萤',
  '镜头：近景稳定侧拍',
  index === 2 ? '台词：第0.5s @林岚："谷风与灵泉声持续。"' : '台词：无',
  `音效：环境层-[${beds[index]}] 动作层-[${cues[index]}] 情绪层-[无配乐]`,
].join('；')).join('\n');
const input: PromptAdapterInput = {
  canonicalPrompt: canonical, durationSec: 15, aspectRatio: '16:9', resolution: '2K',
  audioMode: 'stereo', targetId: 'minimax-h3', detailMode: 'concise',
};
const before = JSON.stringify(input);
const modes: PromptReferenceInput[][] = [
  [],
  [{ id: 'first', name: '成人同框首帧', mediaType: 'image', role: 'first-frame' }],
  [{ id: 'composition', name: '成人同框构图参考', mediaType: 'image', role: 'composition' }],
];
for (const references of modes) {
  const result = compileTargetPrompt({ ...input, references });
  const body = result.prompt.match(/(?:integrated_multimodal_description|detailed_description):\s*([\s\S]*?)\n\noverall_soundscape:/u)?.[1] || '';
  assert.ok(body);
  const shotBlocks = body.split(/\n\n(?=\[Shot \d+\])/u);
  assert.equal(shotBlocks.length, 4);
  for (let index = 0; index < 4; index += 1) {
    assert.match(shotBlocks[index], /环境层-\[无\]/u, `remove the exact real ambient phrase in Shot ${index + 1}`);
    assert.ok(shotBlocks[index].includes(`动作层-[${cues[index]}]`), `retain the original timed action sound in Shot ${index + 1}`);
  }
  assert.match(body, /At 00:04\.000/u);
  assert.match(body, /At 00:08\.000/u);
  assert.match(body, /At 00:11\.000/u);
  assert.match(body, /背景-灵泉与谷口风雾/u, 'visible water/wind scenery is not an audio request and must remain');
  assert.match(body, /"谷风与灵泉声持续。"/u, 'spoken words about sound must not be rewritten');
  assert.doesNotMatch(shotBlocks[2], /轻吻声/u, 'a look/turn shot must not acquire a kiss sound from another shot');
  assert.match(result.prompt, /overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/u);
  assert.equal((body.match(/清晰可辨的轻吻声/gu) || []).length, 2, 'only the two visible contacts have kiss cues');

  const scored = compileTargetPrompt({ ...input, references, constraints: ['背景音乐：只在最后两秒使用低音量钢琴背景音乐，其余无配乐'] });
  assert.match(scored.prompt, /non_diegetic_music: .*最后两秒.*低音量钢琴/su);
  assert.ok(scored.prompt.includes(cues[0]) && scored.prompt.includes(cues[1]), 'explicit low background music must not erase foreground kisses');
  assert.match(scored.prompt, /overall_soundscape: N\/A/u);
  assert.deepEqual(scored.parameters, result.parameters, 'sound-text cleanup must not change generation parameters');

  const silent = compileTargetPrompt({ ...input, references, audioMode: 'none' });
  assert.doesNotMatch(silent.prompt, /轻吻声|衣料接触声/u, 'a user-selected fully silent output remains fully silent');
}
assert.equal(JSON.stringify(input), before, 'source canonical prompt must never be overwritten by audio cleanup');
console.log('quiet ambience and audible synchronized foley regression checks passed');
