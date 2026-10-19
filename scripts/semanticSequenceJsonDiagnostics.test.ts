import assert from 'node:assert/strict';
import { parseSemanticSequenceResponse, SemanticSequenceTechnicalError } from '../src/semanticSequencePlan';
import type { SemanticSequencePlanningInput } from '../src/semanticSequencePlan';

const privateMarker = 'SYNTHETIC_PRIVATE_JSON_PROSE';
const input: SemanticSequencePlanningInput = {
  title: '合成诊断', story: '甲把杯子放在桌上。', segmentDurationSec: 15,
  directorSettingsFingerprint: 'synthetic-json-diagnostics',
  creativeDirection: { cameraTerms: [], lightingTerms: [], extraRequirement: '' },
};
const failure = (raw: string): SemanticSequenceTechnicalError => {
  try { parseSemanticSequenceResponse(raw, input); } catch (error) {
    assert.ok(error instanceof SemanticSequenceTechnicalError);
    assert.ok(!error.message.includes(privateMarker));
    assert.ok(!JSON.stringify(error).includes(privateMarker));
    assert.ok(Object.values(error.diagnostics ?? {}).every((value) => typeof value === 'number'));
    assert.equal(error.diagnostics?.responseLength, raw.length);
    return error;
  }
  throw new Error('Malformed synthetic JSON unexpectedly parsed');
};
const nativePosition = (raw: string): number | undefined => {
  try { JSON.parse(raw.trim()); } catch (error) {
    assert.ok(error instanceof SyntaxError);
    const match = error.message.match(/ at position (\d+)(?: \(line (\d+) column (\d+)\))?$/u);
    return match ? Number(match[1]) + raw.length - raw.trimStart().length : undefined;
  }
  throw new Error('Synthetic malformed JSON must produce a native syntax error');
};
const assertLocation = (error: SemanticSequenceTechnicalError, source: string, expectedPosition: number, layer: number): void => {
  const lines = source.slice(0, expectedPosition).split(/\r\n|[\r\n]/u);
  assert.equal(error.diagnostics?.syntaxPosition, expectedPosition);
  assert.equal(error.diagnostics?.syntaxLine, lines.length);
  assert.equal(error.diagnostics?.syntaxColumn, lines[lines.length - 1].length + 1);
  assert.equal(error.diagnostics?.decodedStringLayer, layer);
  assert.match(error.message, layer === 0 ? /响应正文内语法错误位置/u : new RegExp(`第${layer}层解码字符串内语法错误位置`, 'u'));
};

const malformed: Array<[string, RegExp]> = [
  [`{"reason":"${privateMarker}","fitStatus":"balanced" "segments":[]}`, /对象成员分隔或闭合符无效/u],
  [`{"reason":"${privateMarker}","fitStatus":"balanced",segments:[]}`, /属性名或对象成员格式无效/u],
  [`{"reason":"${privateMarker} "unescaped"","segments":[]}`, /对象成员分隔或闭合符无效/u],
  [`{"reason":"${privateMarker}\nunescaped newline","segments":[]}`, /字符串含未转义控制字符/u],
  [`{"reason":"${privateMarker}\\q","segments":[]}`, /字符串转义无效/u],
];
for (const [raw, category] of malformed) {
  const error = failure(raw);
  assert.match(error.message, category);
  const position = nativePosition(raw);
  assert.notEqual(position, undefined, 'the runtime supplies positions for these synthetic syntax errors');
  assertLocation(error, raw, position!, 0);
  assert.match(error.message, /候选 JSON 范围起点/u);
}

const inner = ` \n{"reason":"${privateMarker}","fitStatus":"balanced" "segments":[]}\n `;
const innerPosition = nativePosition(inner)!;
for (const [raw, layer] of [
  [JSON.stringify({ data: inner }), 1],
  [JSON.stringify({ data: { result: inner } }), 1],
  [JSON.stringify(JSON.stringify(inner)), 2],
] as const) {
  const error = failure(raw);
  assertLocation(error, inner, innerPosition, layer);
  assert.equal(error.diagnostics?.jsonStart, 0);
  assert.equal(error.diagnostics?.jsonEnd, raw.length);
  assert.match(error.message, /候选 JSON 范围终点 \d+（不含）/u);
  assert.ok(!error.message.includes('响应正文内语法错误位置'), 'decoded positions must not claim to point into the outer response');
}

const prefixedBody = malformed[0][0];
const prefix = '仅供合成测试的说明\n```json\n';
const prefixed = `${prefix}${prefixedBody}\n\`\`\``;
const prefixedError = failure(prefixed);
assert.equal(prefixedError.diagnostics?.jsonStart, prefix.length);
assert.equal(prefixedError.diagnostics?.jsonEnd, prefix.length + prefixedBody.length);
assertLocation(prefixedError, prefixed, prefix.length + nativePosition(prefixedBody)!, 0);

const unfinished = `{"reason":"${privateMarker}`;
const unfinishedError = failure(unfinished);
assert.equal(unfinishedError.kind, 'incomplete-json');
assert.match(unfinishedError.message, /语法类别：(?:字符串未闭合|JSON 提前结束)/u);
const unfinishedPosition = nativePosition(unfinished);
if (unfinishedPosition !== undefined) assertLocation(unfinishedError, unfinished, unfinishedPosition, 0);
else assert.equal(unfinishedError.diagnostics?.syntaxPosition, undefined, 'do not invent a location when the engine reports none');

const authored = {
  reason: '完整交付', fitStatus: 'balanced', segments: [{
    title: '放杯', content: `甲放下杯子，杯上写着“${privateMarker}”。`, summary: '放杯', narrativePurpose: '原动作',
    entryState: '甲持杯', exitState: '杯在桌上', transitionHint: '从桌上状态接续', boundaryReason: '实际进度', continuityPack: '杯仍在桌上',
    semanticSource: { sourceEvidence: [{ text: input.story }], events: [{ id: 'put-cup', description: input.story }], dialogues: [] },
  }],
};
assert.equal(parseSemanticSequenceResponse(JSON.stringify(authored), input).segments[0].content, authored.segments[0].content);
console.log('semanticSequenceJsonDiagnostics: syntax locations, decoded layers, privacy and unchanged valid parsing passed');
