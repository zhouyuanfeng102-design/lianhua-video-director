import assert from 'node:assert/strict';
import { cleanSeedanceReferenceClaims, findSeedanceReferenceConflicts } from '../src/seedanceReferenceClaims';

let groups = 0;
const test = (name: string, run: () => void) => { run(); console.log(`PASS ${++groups} ${name}`); };
const images = { hasImages: true, hasAudio: false };
const audio = { hasImages: false, hasAudio: true };

test('中文实际截图中的状态声明移除，人物与场景事实逐字保留', () => {
  const facts = '吴小观、夏娃、龙娘、熊娘按主体定义保持身份与服装；异界森林营地按“停靠巨型龙车的林间空地”建立空间。';
  const source = `本次未提供图片、视频或音频参考素材，全部人物、道具与场景均以文字设定为执行依据。${facts}`;
  const result = cleanSeedanceReferenceClaims(source, images);
  assert.equal(result.text, facts);
  assert.equal(result.removedClaims.length, 2);
  assert.deepEqual(findSeedanceReferenceConflicts(result.text, images), []);
});

test('本次已选图消除全部人物场景仅文字为准，具体剧情和引用保留', () => {
  const facts = '空间通道尚未开启。备注：“全部人物与场景均以文字设定为准。”';
  const source = `本次未提供任何图片、视频或音频素材，全部人物与场景均以文字设定为准。${facts}`;
  assert.equal(cleanSeedanceReferenceClaims(source, images).text, facts);
  assert.equal(cleanSeedanceReferenceClaims(source, { hasImages: false, hasAudio: false }).text, source);
  assert.equal(cleanSeedanceReferenceClaims(`全部人物与场景均以文字设定为准的提示写在屏幕上。${facts}`, images).text,
    `全部人物与场景均以文字设定为准的提示写在屏幕上。${facts}`);
});

test('复合句中的空清单、不使用和不依据旧图声明分别清理', () => {
  const facts = '营地位于巨树旁的森林空地；光纹只是投影，能力尚未发动。';
  const result = cleanSeedanceReferenceClaims(`本次 referenceManifest 为空，没有实际映射的图片、视频、音频或 Clay Render 素材；不使用参考素材，也不依据未提供的图像像素补充画面细节。${facts}`, images);
  assert.equal(result.text, facts);
  assert.equal(result.removedClaims.length, 4);
});

test('常见同义声明按完整子句清理，不限定截图中的字词组合', () => {
  const facts = '人物保持原身份，能力尚未发动。';
  const source = `本次没有提供任何参考图片。本次不使用任何外部参考素材。全部人物均仅依据文字描述执行。${facts}`;
  const result = cleanSeedanceReferenceClaims(source, images);
  assert.equal(result.text, facts);
  assert.equal(result.removedClaims.length, 3);
  const quoted = '屏幕字样：“本次没有提供任何参考图片。”角色说：“本次不使用任何外部参考素材。”';
  assert.equal(cleanSeedanceReferenceClaims(quoted, images).text, quoted);
});

test('英文状态和禁止参考指令清理，剧情事实保持', () => {
  const facts = 'Establish the camp as “a forest clearing beside a giant tree”; the light pattern is only a projection, not an activated power.';
  const result = cleanSeedanceReferenceClaims(`no external reference material is mapped; do not use reference material. ${facts}`, images);
  assert.equal(result.text, facts);
  assert.equal(result.removedClaims.length, 2);
  assert.equal(cleanSeedanceReferenceClaims('No images, videos or audio reference materials are provided. Keep the original costume.', images).text, 'Keep the original costume.');
  assert.equal(cleanSeedanceReferenceClaims('No images, videos, or audio reference materials are provided. All characters, props, and settings are based solely on textual descriptions. Keep the original costume.', images).text, 'Keep the original costume.');
});

test('媒体状态按图音分别判断，无图但有音频不保留笼统无素材声明', () => {
  const source = '本次未提供图片参考素材。未提供音频参考素材。不使用参考素材。没有视频参考素材。';
  assert.equal(cleanSeedanceReferenceClaims(source, images).text, '未提供音频参考素材。没有视频参考素材。');
  assert.equal(cleanSeedanceReferenceClaims(source, audio).text, '本次未提供图片参考素材。没有视频参考素材。');
  assert.equal(cleanSeedanceReferenceClaims(source, { hasImages: true, hasAudio: true }).text, '没有视频参考素材。');
  assert.equal(cleanSeedanceReferenceClaims('No images are selected for this request. No audio is supplied. No external reference material is provided.', audio).text, 'No images are selected for this request.');
  assert.equal(cleanSeedanceReferenceClaims('- 本段未绑定外部图像、视频或音频媒体素材。所有人物沿用原设定。', audio).text, '所有人物沿用原设定。');
});

test('清空媒体不改变原稿，重复处理不累加内容', () => {
  const source = '本次未提供图片、视频或音频参考素材。营地保持原状。';
  assert.equal(cleanSeedanceReferenceClaims(source, { hasImages: false, hasAudio: false }).text, source);
  const first = cleanSeedanceReferenceClaims(source, images).text;
  assert.equal(cleanSeedanceReferenceClaims(first, images).text, first);
});

test('对白、屏幕文字与sound字面量包含无图句时完全保持', () => {
  const facts = '门牌保留字样“本次未提供图片、视频或音频参考素材”。少女说：“不使用参考素材。仅以文字设定为执行依据。”<d>没有图片参考素材。</d><sound>没有音频参考素材。</sound>墙上的“@Image 99”只是原场景文字。';
  assert.equal(cleanSeedanceReferenceClaims(facts, { hasImages: true, hasAudio: true }).text, facts);
  assert.deepEqual(findSeedanceReferenceConflicts(facts, images), []);
  const mixed = `本次未提供图片参考素材。${facts}`;
  assert.equal(cleanSeedanceReferenceClaims(mixed, images).text, facts);
});

test('只移除完整素材状态子句，不误删近似剧情或带引号的场景事实', () => {
  const facts = '没有图片的房间依然明亮。未提供图片的小孩走入大厅。不使用参考素材的导演角色正在解释工作。全部人物均以文字设定为执行依据的规则写在墙上。场景以“没有参考素材的空白画框”为背景。';
  assert.equal(cleanSeedanceReferenceClaims(facts, images).text, facts);
  const embedded = '庭院保持清晨光线，未提供图片参考素材，门牌保留字样“欢迎来到庭院”。';
  assert.equal(cleanSeedanceReferenceClaims(embedded, images).text, '庭院保持清晨光线，门牌保留字样“欢迎来到庭院”。');
  assert.equal(cleanSeedanceReferenceClaims('庭院保持清晨光线，未提供图片参考素材。', images).text, '庭院保持清晨光线。');
});

test('检测坐标保留UTF16与原声明，图片及音频类别区分', () => {
  const source = '🌙场景保持原状。未提供图片参考素材；未提供音频参考素材。';
  const claims = findSeedanceReferenceConflicts(source, { hasImages: true, hasAudio: true });
  assert.deepEqual(claims.map((claim) => claim.kind), ['images', 'audio']);
  for (const claim of claims) assert.equal(source.slice(claim.start, claim.end), claim.text);
});

test('无声与静音剧情保持，只有明确声音参考输入状态会被清理', () => {
  const silence = '没有声音。没有声线。无音色。No sound. No voices. No sound is used. Do not use sound.';
  const state = { hasImages: true, hasAudio: true };
  assert.equal(cleanSeedanceReferenceClaims(silence, state).text, silence);
  assert.deepEqual(findSeedanceReferenceConflicts(silence, state), []);
  const source = `未提供声音参考素材。未提供声线参考素材。No voice references are provided. No sound samples are uploaded. ${silence}`;
  const result = cleanSeedanceReferenceClaims(source, state);
  assert.equal(result.text, silence);
  assert.equal(result.removedClaims.length, 4);
});

console.log(`Seedance reference claims: ${groups} groups passed.`);
