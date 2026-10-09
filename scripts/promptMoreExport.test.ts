import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSelectedSequencePromptText } from '../src/sequencePromptExport';
import { buildOfficialH3SourceFingerprint } from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { createPromptResultMoreFixture } from './promptResultMoreFixture';
import type { Project } from '../src/types';
import type { VideoPromptFormat } from '../src/videoGenerationTypes';

const { state, texts } = createPromptResultMoreFixture();
const project = state.project; const plan = project.sequencePlans[0];
const original = structuredClone(project);
for (const promptFormat of ['h3', 'seedance', 'ordinary'] as const) {
  for (const language of ['zh', 'en'] as const) {
    const result = buildSelectedSequencePromptText(project, { ...plan, segments: [...plan.segments].reverse() }, { promptFormat, language });
    assert.equal(result.readyCount, 2, `${promptFormat} ${language}: each saved current segment is available`);
    assert.equal(result.pendingCount, 0); assert.equal(result.warningCount, 0);
    for (const body of texts[promptFormat][language]) assert.ok(result.text.includes(body), 'saved body is exported byte for byte');
    assert.ok(result.text.indexOf('=== 第 1 段') < result.text.indexOf('=== 第 2 段'), 'export uses segment index rather than array order');
    for (const otherFormat of ['h3', 'seedance', 'ordinary'] as const) {
      for (const otherLanguage of ['zh', 'en'] as const) {
        if (otherFormat === promptFormat && otherLanguage === language) continue;
        for (const body of texts[otherFormat][otherLanguage]) assert.ok(!result.text.includes(body), 'other format/language body must never leak into the selected export');
      }
    }
  }
}
assert.deepEqual(project, original, 'TXT reads leave saved prompts, source identity and project content untouched');

const withChangedFirstBoard = (change: (board: Project['storyboards'][number]) => void): Project => {
  const next = structuredClone(project); change(next.storyboards.find((board) => board.id === 'prompt-more-board-1')!); return next;
};
const expectPendingFirst = (candidate: Project, promptFormat: VideoPromptFormat, language: 'zh' | 'en' = 'zh') => {
  const result = buildSelectedSequencePromptText(candidate, candidate.sequencePlans[0], { promptFormat, language });
  assert.equal(result.readyCount, 1); assert.equal(result.pendingCount, 1);
  assert.ok(result.text.includes('=== 第 1 段：山道第1段 ==='));
  assert.ok(result.text.includes('[待生成／待更新：'), 'pending segments remain in the file with an explicit reason');
  for (const format of ['h3', 'seedance', 'ordinary'] as const) for (const lang of ['zh', 'en'] as const)
    assert.ok(!result.text.includes(texts[format][lang][0]), 'missing selected artifact cannot fall back to any other body');
  return result;
};

expectPendingFirst(withChangedFirstBoard((board) => { board.seedance25Output = undefined; }), 'seedance');
expectPendingFirst(withChangedFirstBoard((board) => { delete board.seedance25Output!.promptEn; delete board.seedance25Output!.englishSourceFingerprint; }), 'seedance', 'en');
expectPendingFirst(withChangedFirstBoard((board) => { board.seedance25Output!.sourceFingerprint = 'stale-source'; }), 'seedance');
expectPendingFirst(withChangedFirstBoard((board) => { board.officialPromptEnSource = 'a different Chinese draft'; }), 'h3', 'en');
expectPendingFirst(withChangedFirstBoard((board) => { board.officialPromptSource = 'stale-source'; }), 'h3');
expectPendingFirst(withChangedFirstBoard((board) => { board.englishPromptSource = 'a different ordinary source'; }), 'ordinary', 'en');
expectPendingFirst(withChangedFirstBoard((board) => { board.sourceStale = true; }), 'ordinary');
expectPendingFirst(withChangedFirstBoard((board) => { board.sequencePlanId = 'another-plan'; }), 'ordinary');
expectPendingFirst(withChangedFirstBoard((board) => { board.segmentId = 'another-segment'; }), 'ordinary');

const nonReady = structuredClone(project); nonReady.sequencePlans[0].segments[0].status = 'planned';
expectPendingFirst(nonReady, 'h3');
const orphan = structuredClone(project); orphan.sequencePlans[0].segments[0].storyboardId = 'missing-board';
expectPendingFirst(orphan, 'ordinary');
const stalePlan = structuredClone(project); stalePlan.sequencePlans[0].sourceStale = true;
assert.equal(buildSelectedSequencePromptText(stalePlan, stalePlan.sequencePlans[0], { promptFormat: 'ordinary', language: 'zh' }).pendingCount, 2);
const legacy = withChangedFirstBoard((board) => { delete board.sequencePlanId; delete board.segmentId; });
assert.equal(buildSelectedSequencePromptText(legacy, legacy.sequencePlans[0], { promptFormat: 'ordinary', language: 'zh' }).readyCount, 2,
  'legacy missing association metadata is readable without accepting an explicit conflicting owner');

const echo = withChangedFirstBoard((board) => { board.finalPrompt = '普通中文第1段\n只返回完整JSON'; });
expectPendingFirst(echo, 'ordinary');
assert.ok(!buildSelectedSequencePromptText(echo, echo.sequencePlans[0], { promptFormat: 'ordinary', language: 'zh' }).text.includes('只返回完整JSON'),
  'internal output rules cannot enter an exported video prompt');

const referenceProject = structuredClone(project);
const referenceBoard = referenceProject.storyboards.find((board) => board.id === 'prompt-more-board-1')!;
referenceProject.assets = [{ id: 'prompt-more-missing-picture', name: '山道参考', type: 'reference', role: 'general', mediaType: 'image',
  referenceRole: 'general', dataUrl: 'data:image/png;base64,AA==', tags: [], checksum: 'synthetic-image-checksum', createdAt: 1, updatedAt: 1 }];
referenceBoard.globalReferenceAssetIds = [referenceProject.assets[0].id];
referenceBoard.targetOutput!.referenceManifest = [{ id: referenceProject.assets[0].id, token: '<Picture 1>', mediaType: 'image' }];
referenceBoard.officialPromptSource = buildOfficialH3SourceFingerprint(referenceBoard, officialH3ContextForStoryboard(referenceProject, referenceBoard));
referenceProject.assets = [];
const warned = buildSelectedSequencePromptText(referenceProject, plan, { promptFormat: 'h3', language: 'zh' });
assert.equal(warned.readyCount, 2); assert.equal(warned.warningCount, 1);
assert.ok(warned.text.includes('参考提示：参考图待更新'));
assert.ok(warned.text.includes(texts.h3.zh[0]), 'read-only export preserves the exact H3 artifact with a missing reference notice');

const app = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');
const director = app.slice(app.indexOf('function DirectorView'), app.indexOf('function StoryboardView'));
assert.equal(/导出分段 JSON/u.test(director), false, 'retired JSON export must not remain in the director UI');
assert.equal(/<DirectorPromptMoreMenu[\s\S]*?label:\s*"修复对白与排时"[\s\S]*?label:\s*"导出全部分段提示词"/u.test(director), true,
  'repair and TXT export remain in More');
assert.equal(/exportSequencePromptsAsText\(activeSequencePlan, directorPromptFormat, promptLanguage\)/u.test(director), true,
  'TXT export receives the current format and language');
assert.equal(/ctx\.openVideoDirector\(\{ storyboardId: directorResultStoryboard\.id, language: promptLanguage, promptFormat: directorPromptFormat \}\)/u.test(director), true,
  'Send retains the selected format and language');
assert.equal(/exportSequencePromptsAsJson\s*\(/u.test(director), false,
  'retired JSON action cannot remain in the director menu; the existing compatibility helper may remain outside the UI');
console.log('Prompt More/export checks passed: exact three-format bilingual bodies, pending without fallback, source/association ownership, read-only reference notices, menu placement and preserved send selection.');
