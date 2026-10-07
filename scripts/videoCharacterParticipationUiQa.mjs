import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { installTailCharactersFixture } from './videoTailCharactersUiQa.mjs';

// Reuse only the isolated component fixture, never its submission assertions.
// All examples, assets and storage are synthetic. Generation stays untouched.
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'playwright', 'video-character-participation');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
let browser; let page; let failure;
const errors = []; const stages = []; const screenshots = []; const layouts = [];
let requests;
const capture = async (name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file }); screenshots.push(file); };
const row = (index) => page.locator(`.vd-batch-row[data-segment-id="cpq-segment-${index}"]`);
const open = async (index, language = '中文') => {
  await row(index).getByRole('button', { name: language, exact: true }).click();
  await page.getByRole('button', { name: `第 ${index} 段选择参考图`, exact: true }).click();
  await page.getByRole('dialog', { name: `第 ${index} 段 · 选择参考图`, exact: true }).waitFor();
};
const chip = (id) => page.locator(`.vd-segment-character-chip[data-character-id="${id}"]`);
const status = async (id, expected) => {
  await page.waitForFunction(({ id, expected }) => document.querySelector(`.vd-segment-character-chip[data-character-id="${id}"]`)?.getAttribute('data-reference-status') === expected, { id, expected });
};
const close = () => page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12_000); page.on('pageerror', (error) => errors.push(error.message));
  requests = await installTailCharactersFixture(page, `http://127.0.0.1:${server.httpServer.address().port}`);
  await page.evaluate(() => window.__tailCharactersQa.reset({ source: 'runninghub', slots: 6, firstRole: 'character', withoutVideos: true, withoutReferences: true }));
  await page.evaluate(async () => {
    const { sourceContentHash } = await import('/src/sourceIntegrity.ts');
    window.__tailCharactersQa.mutateProject((project) => {
      const samples = ['夏提雅·布拉德弗伦', '亚乌菈·贝拉·菲欧拉', '贝·里尤洛', '掘土兽人侍从', '掘土兽人战士'];
      const ids = ['shalltear', 'aura', 'king', 'attendant', 'army'];
      const image = project.assets[0]; const originalCharacter = project.characters[0]; const originalBoard = project.storyboards[0];
      project.name = '人物关联隔离验证';
      project.characters = samples.map((name, index) => ({ ...structuredClone(originalCharacter), id: ids[index], name, aliases: [], assetIds: [`cpq-${ids[index]}-image`] }));
      project.assets = project.characters.map((character) => ({ ...structuredClone(image), id: character.assetIds[0], name: `${character.name}人物图`, sourceEntityId: character.id, sourceEntityKind: 'character' }));
      const prose = (index, en) => index === 5 ? en
        ? '[Shot 1] Pe Riyuro stands at the platform. [Shot 6] Shalltear raises her spear and strikes the charging army in the distant battlefield.'
        : '[Shot 1] 贝·里尤洛站在高台，掘土兽人侍从紧随身旁。\n[Shot 6] 镜头越过高台，远方战场中的夏提雅挥动长枪，击飞冲来的掘土兽人战士。'
        : en ? '[Shot 1] Pe Riyuro stands before his army. Shalltear and Aura walk out and stand at the cavern entrance.'
          : '[Shot 1] 贝·里尤洛站在前景，掘土兽人侍从紧随身旁，掘土兽人战士在后方列阵。远景王都通道口，夏提雅与亚乌菈并肩走出。';
      const wrap = (body) => `integrated_multimodal_description: ${body}\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A`;
      const plan = project.sequencePlans[0];
      plan.id = 'cpq-plan'; plan.title = '简称与远景人物关联验证'; plan.totalDurationSec = 150;
      plan.segments = Array.from({ length: 5 }, (_, offset) => ({ ...structuredClone(plan.segments[0]), id: `cpq-segment-${offset + 1}`, index: offset + 1, title: offset === 4 ? '消耗战的绝望豪赌' : '大军前线与阵前决意', durationSec: 30, globalStartSec: offset * 30, globalEndSec: (offset + 1) * 30, storyboardId: `cpq-board-${offset + 1}`, content: '贝·里尤洛与侍从交谈。' }));
      project.storyboards = plan.segments.map((segment) => {
        const zh = wrap(prose(segment.index, false)); const en = wrap(prose(segment.index, true));
        return { ...structuredClone(originalBoard), id: segment.storyboardId, sequencePlanId: plan.id, segmentId: segment.id, segmentIndex: segment.index, segmentCount: 5, durationSec: 30,
          sourceStoryTitle: segment.title, globalReferenceAssetIds: [], finalPrompt: zh, officialPromptZh: zh, officialPromptSource: zh,
          officialPromptEn: en, officialPromptEnSource: zh, englishPrompt: en, englishPromptSource: zh,
          h3IdentityBindings: { version: 1, characters: [] }, h3IdentityBindingsEn: { version: 1, characters: segment.index === 2 ? [{ characterId: 'shalltear', name: samples[0], referenceAnchor: 'This identity anchor is absent from the saved prompt.' }] : [] },
          targetOutput: { prompt: zh, referenceManifest: [] }, promptTrace: { ...originalBoard.promptTrace, referenceAssetIds: [], convertedPromptFingerprint: sourceContentHash(zh) },
          shots: [{ ...structuredClone(originalBoard.shots[0]), id: `cpq-shot-${segment.index}`, subject: '贝·里尤洛', action: '与侍从交谈', endSec: 30, referenceAssetIds: [], prompt: zh }],
        };
      });
      project.scenes[0].storyboardIds = project.storyboards.map((board) => board.id);
      project.scenes[0].characterIds = ['king', 'attendant', 'army'];
      window.__cpqOriginal = JSON.stringify(project);
      return project;
    });
  });
  await page.getByRole('tab', { name: '长剧情批量', exact: true }).click();
  await row(1).waitFor();

  await open(1);
  assert.equal(await chip('shalltear').count(), 1); assert.equal(await chip('aura').count(), 1);
  assert.match(await page.locator('.vd-segment-character-secondary').innerText(), /^其他提及（出镜待确认）：/u);
  await status('shalltear', 'unselected');
  await capture('01-first-segment-unselected-identities');
  await page.getByRole('button', { name: '选择图片 夏提雅·布拉德弗伦人物图', exact: true }).click();
  await status('shalltear', 'bound'); assert.match(await chip('shalltear').innerText(), /已关联图片 1/u);
  await page.getByRole('button', { name: '选择图片 亚乌菈·贝拉·菲欧拉人物图', exact: true }).click();
  await status('aura', 'bound'); assert.match(await chip('aura').innerText(), /已关联图片 2/u);
  await capture('02-first-segment-selected-picture-slots');
  await close();
  await open(1); await status('shalltear', 'unselected'); await status('aura', 'unselected');
  await close();
  stages.push('第 1 段最终中文稿里的远景简称人物出现；实际绑定槽 1/2；关闭取消不保存选图');

  await open(5);
  assert.equal(await chip('shalltear').count(), 1); assert.equal(await chip('aura').count(), 0);
  await page.getByRole('button', { name: '选择图片 夏提雅·布拉德弗伦人物图', exact: true }).click();
  await status('shalltear', 'bound');
  await page.getByRole('button', { name: '使用本段图片', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await row(5).getByRole('button', { name: '预览', exact: true }).click();
  const submittedPreview = await page.locator('.vd-batch-preview .vd-prompt-preview').innerText();
  assert.match(submittedPreview, /夏提雅[^\n]*<Picture 1>/u);
  assert.match(submittedPreview, /击飞冲来的掘土兽人战士/u);
  await open(5); await status('shalltear', 'bound');
  await capture('03-fifth-segment-later-shot-bound'); await close();
  stages.push('第 5 段第 6 镜夏提雅出现；使用图片后真实预览包含对应 Picture 1，保留动作原文');

  await open(1, '英文');
  assert.equal(await chip('shalltear').count(), 1); assert.equal(await chip('aura').count(), 1);
  await page.getByRole('button', { name: '选择图片 夏提雅·布拉德弗伦人物图', exact: true }).click();
  await status('shalltear', 'bound');
  await capture('04-english-paired-identity-bound'); await close();
  stages.push('英文已配对中文显示相同参与人物，并使用提交准备函数给出的实际图片绑定状态');
  await open(2, '英文');
  await page.getByRole('button', { name: '选择图片 夏提雅·布拉德弗伦人物图', exact: true }).click();
  await status('shalltear', 'pending');
  assert.equal(await page.getByRole('button', { name: '使用本段图片', exact: true }).isEnabled(), true);
  await capture('05-english-invalid-anchor-pending');
  stages.push('英文身份锚点失效时如实显示待关联，使用图片不阻断');

  for (const viewport of [{ width: 1120, height: 760 }, { width: 900, height: 700 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.getByRole('dialog').evaluate((dialog) => {
      const boxes = ['.vd-segment-character-hint', '.vd-reference-picker-panels', '.vd-modal-footer'].map((selector) => {
        const element = dialog.querySelector(selector); const rect = element?.getBoundingClientRect();
        return rect ? { selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
      }).filter(Boolean);
      const buttons = [...dialog.querySelectorAll('.vd-modal-header button, .vd-modal-footer button')].map((button) => {
        const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { text: button.textContent, visible: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, clickable: hit === button || button.contains(hit) };
      });
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1, dialogOverflow: dialog.scrollWidth > dialog.clientWidth + 1, boxes, buttons };
    });
    assert.equal(layout.overflow, false); assert.equal(layout.dialogOverflow, false);
    assert.ok(layout.buttons.every((button) => button.visible && button.clickable));
    const hint = layout.boxes.find((box) => box.selector === '.vd-segment-character-hint');
    const footer = layout.boxes.find((box) => box.selector === '.vd-modal-footer');
    assert.ok(hint.bottom <= footer.top);
    layouts.push({ viewport, ...layout }); await capture(`06-layout-${viewport.width}x${viewport.height}`);
  }
  await close();
  assert.equal(await page.evaluate(() => JSON.stringify(window.__tailCharactersQa.project) === window.__cpqOriginal), true);
  assert.deepEqual(await page.evaluate(() => ({ submissions: window.__tailCharactersQa.submissions.length, requests: window.__tailCharactersQa.requests.length, extracts: window.__tailCharactersQa.rawExtracts })), { submissions: 0, requests: 0, extracts: 0 });
  assert.deepEqual(errors, []); assert.deepEqual(requests.blockedRequests, []); assert.deepEqual(requests.textRequests, []);
  stages.push('1120×760 与 900×700 无遮挡或横向溢出；原项目和中英文稿未变；零生成任务和外部请求');
} catch (error) {
  failure = error;
  if (page && !page.isClosed()) { await capture('failure').catch(() => {}); await fs.writeFile(path.join(output, 'failure.txt'), `${error.stack}\n\n${await page.locator('body').innerText()}`); }
} finally {
  await browser?.close(); await server.close();
  const report = { passed: !failure, isolatedComponentOnly: true, productionDataRead: false, stages, screenshots, layouts, errors, ...requests, ...(failure ? { failure: String(failure.stack || failure) } : {}) };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
if (failure) process.exitCode = 1;
