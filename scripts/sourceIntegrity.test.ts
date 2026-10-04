import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySourceIntegrityResolution,
  detectSourceIntegrityIssues,
  sourceContentHash,
} from '../src/sourceIntegrity';

const fullLengthRegressionParagraph = `雨夜的海港被潮声压得很低，巡灯员沈砚提着旧铜灯沿防波堤逐级检查。他先在第三座信号塔下发现一串带泥的脚印，又看见本该锁死的检修门留着一道缝。门后没有人，只有湿透的航海图铺在地上，图中用红线圈出了明晨第一班渡船的航道。沈砚没有触碰航海图，而是用相机记录门锁、脚印和墙角散落的蓝色纤维。远处汽笛响起时，塔顶的白灯忽然熄灭，备用电源也没有启动。他立刻通知值班室封闭码头，并沿着电缆沟寻找断点。走到旧仓库背面，他听见金属碰撞声，看见一名穿灰色雨衣的人翻过矮墙。那人丢下一只工具包，里面有剪断的铜线、绝缘手套和写着潮位时刻的纸条。沈砚没有贸然追入黑巷，而是守住唯一出口，等待巡逻队从另一侧合围。几分钟后，白灯重新亮起，渡船调度也收到改道指令。黎明前，值班员根据完整记录确认航道警报不是设备故障，而是一场被及时阻止的蓄意破坏。镜头最后掠过潮湿的石阶、封存的证物袋与恢复旋转的塔灯，远海的第一艘船安全驶向新的航线。🧭`;
const nearDuplicateFirst = '调查组进入北侧机房后，先核对温度记录和门禁时间，再检查三台备用泵的压力曲线。负责人让所有人保留原始照片，不得覆盖相机时间，也不得在确认前移动断裂的阀门。技术员完成取样以后，把编号、位置和封存人逐项写入交接单，随后通知控制中心降低管线负荷，等待实验室复核。';
const nearDuplicateSecond = '调查组进入北侧设备机房后，先核对温度记录与门禁时间，再检查三台备用泵的压力曲线。负责人要求所有人保留原始照片，不得修改相机时间，也不得在确认前移动断裂的阀门。技术员完成取样以后，把编号、位置和封存人逐项写入交接单，随后通知控制中心降低管线负荷，等候实验室二次复核。';

test('detects a 220+ character whole-document copy without breaking UTF-16 half-open ranges', () => {
  assert.ok([...fullLengthRegressionParagraph].length > 220, 'the regression fixture must remain longer than 220 characters');
  const text = `${fullLengthRegressionParagraph}\n\n${fullLengthRegressionParagraph}`;
  const untouched = text;

  const issues = detectSourceIntegrityIssues(text);
  const issue = issues.find((candidate) => candidate.type === 'whole-document-duplicate');

  assert.ok(issue, 'duplicating an entire long source must produce a whole-document issue');
  assert.deepEqual(issue.original, { start: 0, end: fullLengthRegressionParagraph.length });
  assert.deepEqual(issue.duplicate, {
    start: fullLengthRegressionParagraph.length + 2,
    end: text.length,
  });
  assert.equal(text.slice(issue.original.start, issue.original.end), fullLengthRegressionParagraph);
  assert.equal(text.slice(issue.duplicate.start, issue.duplicate.end), fullLengthRegressionParagraph);
  assert.ok(issue.confidence >= 0.99);
  assert.match(issue.description, /整篇|全文/u);
  assert.equal(text, untouched, 'detection must be read-only and must never delete source text');
});

test('detects one exact long block while preserving both source ranges', () => {
  const block = '顾宁推开档案室的铁门，依次核对墙上的值班表、桌面的借阅簿和柜门封条。她发现昨夜十一点后的签名使用了褪色墨水，编号却沿用了白班记录。随后她拍下封条裂口，把散落纸页按原顺序装入透明袋，并请保安调取东侧走廊的原始录像。录像显示清洁车曾在门口停留七分钟，推车人离开时换了一顶帽子。顾宁据此标记时间线，保留现场，不让任何人补写或重排材料';
  assert.ok([...block].length >= 100);
  const prefix = '序章记录了大楼停电前的正常交接。\n';
  const bridge = '\n中间插入一段与档案室无关的码头调度记录。\n';
  const suffix = '\n结尾转向第二天的公开调查。';
  const text = `${prefix}${block}${bridge}${block}${suffix}`;

  const issue = detectSourceIntegrityIssues(text)
    .find((candidate) => candidate.type === 'large-duplicate-block');

  assert.ok(issue, 'a repeated long source block must not be lost among unique surrounding text');
  assert.equal(text.slice(issue.original.start, issue.original.end), block);
  assert.equal(text.slice(issue.duplicate.start, issue.duplicate.end), block);
  assert.equal(issue.original.start, prefix.length);
  assert.equal(issue.duplicate.start, prefix.length + block.length + bridge.length);
  assert.ok(issue.confidence >= 0.99);
});

test('detects a high-similarity long duplicate despite whitespace and punctuation-only edits', () => {
  const first = '钟遥进入控制室，先确认主屏幕上的三组坐标；随后关闭自动广播，并把异常航线抄到纸质日志。她要求同伴逐一核验舱门状态、燃料余量和救生艇编号，任何结果都必须由两个人签字。警报解除以后，她仍保留原始数据，等待地面站完成复核。';
  const second = '钟遥进入控制室 先确认主屏幕上的三组坐标。随后关闭自动广播，并把异常航线抄到纸质日志；她要求同伴逐一核验舱门状态、燃料余量、和救生艇编号。任何结果都必须由两个人签字！警报解除以后，她仍保留原始数据，等待地面站完成复核。';
  const prefix = '前置内容只介绍天气。\n';
  const bridge = '\n这里是完全不同的设备维护说明。\n';
  const suffix = '\n后置内容只记录返航。';
  const text = `${prefix}${first}${bridge}${second}${suffix}`;

  const issue = detectSourceIntegrityIssues(text)
    .find((candidate) => candidate.type === 'high-similarity-duplicate');

  assert.ok(issue, 'format-only edits must not hide a long duplicated passage');
  assert.equal(text.slice(issue.original.start, issue.original.end), first);
  assert.equal(text.slice(issue.duplicate.start, issue.duplicate.end), second);
  assert.ok(issue.confidence >= 0.9);
  assert.match(issue.description, /相似|空白|标点/u);
});

test('detects a long near-duplicate with localized wording edits instead of requiring normalized equality', () => {
  const text = [
    '事故简报先说明人员已经撤离。',
    nearDuplicateFirst,
    '这一段只记录南侧仓库的消防演练，与机房调查没有关系。',
    nearDuplicateSecond,
    '末尾列出下一班值守人员。',
  ].join('\n');

  const issue = detectSourceIntegrityIssues(text)
    .find((candidate) => candidate.type === 'high-similarity-duplicate');

  assert.ok(issue, 'several small wording edits must not conceal a substantially duplicated long paragraph');
  assert.equal(text.slice(issue.original.start, issue.original.end), nearDuplicateFirst);
  assert.equal(text.slice(issue.duplicate.start, issue.duplicate.end), nearDuplicateSecond);
  assert.ok(issue.confidence >= 0.85);
});

test('keep-first accepts a detected near-duplicate only after the caller explicitly chooses it', () => {
  const text = `${nearDuplicateFirst}\n${nearDuplicateSecond}`;
  const issue = detectSourceIntegrityIssues(text)
    .find((candidate) => candidate.type === 'high-similarity-duplicate');
  assert.ok(issue);

  assert.equal(
    applySourceIntegrityResolution(text, issue, 'keep-first'),
    `${nearDuplicateFirst}\n`,
    'the explicit resolution should remove the reported near-duplicate while keeping the first wording',
  );
});

test('does not flag ordinary short refrains as source corruption', () => {
  const text = '清晨，阿岚走进车站。他回头看了一眼，然后把车票放进口袋。午后，列车经过峡谷，乘客们开始整理行李。他回头看了一眼，确认座位上没有遗落物品。夜里，站台恢复安静。';

  assert.deepEqual(
    detectSourceIntegrityIssues(text),
    [],
    'a repeated short sentence is normal prose, not a large duplicated source block',
  );
});

test('keep-first removes only the reported duplicate after an explicit resolution call', () => {
  const text = `${fullLengthRegressionParagraph}\n\n${fullLengthRegressionParagraph}`;
  const issue = detectSourceIntegrityIssues(text)
    .find((candidate) => candidate.type === 'whole-document-duplicate');
  assert.ok(issue);

  assert.equal(
    applySourceIntegrityResolution(text, issue, 'keep-first'),
    fullLengthRegressionParagraph,
    'explicit keep-first should retain the first complete source and remove its separator plus duplicate',
  );
  assert.equal(
    text,
    `${fullLengthRegressionParagraph}\n\n${fullLengthRegressionParagraph}`,
    'resolution must return a new string rather than mutate caller-owned source',
  );
});

test('keep-first preserves a unique symbol or opening quote immediately after a duplicate block', () => {
  const block = '顾宁推开档案室铁门后，依次核对墙上值班表、桌面借阅簿和柜门封条。她发现昨夜十一点后的签名使用了褪色墨水，编号却沿用了白班记录。随后她拍下封条裂口，把散落纸页按原顺序装入透明袋，并请保安调取东侧走廊原始录像。录像显示清洁车曾在门口停留七分钟，推车人离开时换了一顶帽子。顾宁据此标记时间线，保留现场，不让任何人补写或重排材料。';

  for (const uniqueSuffix of ['🧭后记继续。', '“后记从这里开始。”']) {
    const text = `序章。\n${block}\n桥接。\n${block}${uniqueSuffix}`;
    const issue = detectSourceIntegrityIssues(text)
      .find((candidate) => candidate.type === 'large-duplicate-block'
        || candidate.type === 'high-similarity-duplicate');
    assert.ok(issue, `the repeated block before ${uniqueSuffix} must be detected`);

    const resolved = applySourceIntegrityResolution(text, issue, 'keep-first');
    assert.ok(
      resolved.endsWith(uniqueSuffix),
      `removing the duplicate must preserve its following unique suffix ${uniqueSuffix}`,
    );
  }
});

test('detects a long near-duplicate twice within one physical line', () => {
  const prefix = '事故简报先说明人员已经撤离。';
  const bridge = '这一段只记录南侧仓库的消防演练，与机房调查没有关系。';
  const suffix = '末尾列出下一班值守人员。';
  const text = `${prefix}${nearDuplicateFirst}${bridge}${nearDuplicateSecond}${suffix}`;

  const issue = detectSourceIntegrityIssues(text)
    .find((candidate) => candidate.type === 'high-similarity-duplicate');

  assert.ok(issue, 'physical line wrapping must not decide whether a near-duplicate is detected');
  assert.equal(text.slice(issue.original.start, issue.original.end), nearDuplicateFirst);
  assert.equal(text.slice(issue.duplicate.start, issue.duplicate.end), nearDuplicateSecond);
});

test('content hash is deterministic and invalidates downstream work for every source edit', () => {
  const original = '潮水上涨，灯塔亮起。🧭';
  const edited = '潮水上涨，灯塔亮起！🧭';

  assert.equal(sourceContentHash(original), sourceContentHash(original));
  assert.notEqual(sourceContentHash(original), sourceContentHash(edited));
  assert.match(sourceContentHash(original), /^src-v1-[0-9a-f]{16}$/u);
});
