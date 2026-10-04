import assert from 'node:assert/strict';
import { normalizeStoryboardSubject, storyboardSubjectValidationError } from '../src/storyboardSubject';

const validNames = [
  '于吉', '在天神尊', '我妻善逸', '他山石', '雨', '神', '龙',
  'Alexander Montgomery', "O'Brien", '清泉市夜晚', '06号防区观测区域',
  '人物画像', '角色雕像', '头部雕像', '整个人群', '无名主角',
  '林舟与雪衣道侣以及玄衣道侣', '北方军团的侦察小队', '环境主体',
];
for (const name of validNames) {
  assert.equal(storyboardSubjectValidationError(name), undefined, name);
  assert.equal(normalizeStoryboardSubject(name), name, `must preserve ${name}`);
}
for (const value of [null, undefined, 17, {}, [], '', ' ', '我', '祂们', '他们', '主角', '角色', '无', 'none', 'null', 'N/A', '主体名', '稳定主体名', '……', '清泉市\n主体：死亡兵团']) {
  assert.ok(storyboardSubjectValidationError(value), `must reject ${JSON.stringify(value)}`);
}
for (const value of [' @于吉 ', '＠于吉', '“于吉”', '「于吉」', '"@于吉"']) {
  assert.equal(normalizeStoryboardSubject(value), '于吉');
  assert.equal(storyboardSubjectValidationError(value), undefined);
}
console.log('storyboardSubject: explicit names, one-character names, groups, environments, safe formatting and invalid declarations passed');
