import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
export { setupDirectorLookRequirementQa as setup } from './directorLookRequirementUiQa.mjs';

// Called only by the persistent Playwright Interactive REPL. The caller owns
// the browser. setup() creates synthetic A/B projects in an isolated context;
// this helper never opens a production profile or contacts a paid model.
export const QA_INVENTORY = [
  '真实鼠标点击、逐字键盘输入、中文提交、中途插入删除、换行，光标与文字均保留',
  '剧情解析保持运行时可编辑导演要求；AI分析按钮仍禁用，输入不会触发额外请求',
  '解析成功后要求不回滚，点击AI分析时发送最新完整要求并回填四项风格',
  '解析HTTP503失败仍保留输入，解除忙碌后可继续分析',
  '本项AI分析途中编辑会取消过期回填，而不是禁用输入或吞字',
];

const custom = (page) => page.locator('textarea[aria-label="导演与视觉自定义要求"]');
const lookButton = (page) => page.locator('#director-setup-style').getByRole('button', { name: 'AI 分析填写', exact: true });
const lookInputs = (page) => page.locator('#director-setup-style .director-style-pane input');
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const eventually = async (predicate, name) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Director typing QA timed out: ${name}`);
};
const enterDirector = async (page) => {
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await custom(page).waitFor();
};
const enterStory = (page) => page.locator('.sidebar').getByRole('button', { name: '剧情解析', exact: true }).click();
const pointerFocus = async (page) => {
  const target = custom(page);
  const box = await target.boundingBox();
  assert.ok(box && box.width > 40 && box.height > 10, 'requirement has a usable pointer target');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await target.evaluate((element) => document.activeElement === element), true, 'real pointer click must focus the requirement');
};
const replaceByTyping = async (page, latin, chinese) => {
  await pointerFocus(page);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(latin, { delay: 12 });
  if (chinese) await page.keyboard.insertText(chinese);
  assert.equal(await custom(page).inputValue(), latin + (chinese || ''));
  assert.equal(await custom(page).evaluate((element) => document.activeElement === element), true);
};
const readLook = async (page) => ({
  category: await lookInputs(page).nth(0).inputValue(),
  director: await lookInputs(page).nth(1).inputValue(),
  visual: await lookInputs(page).nth(2).inputValue(),
  summary: await page.locator('#director-setup-style .director-style-pane > .field').nth(1).locator('.field-hint').textContent(),
});
const fixtureProject = (page) => page.evaluate(async () => {
  const { STORAGE_KEY } = await import('/src/storage.ts');
  const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (!['look-qa-a', 'look-qa-b'].includes(state?.project?.id)) throw new Error('Typing QA requires its synthetic project fixture');
  return { key: STORAGE_KEY, project: state.project };
});

export async function run(page, outputDirectory) {
  const origin = new URL(page.url()).origin;
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname));
  const outputBase = path.resolve(import.meta.dirname, '../output/playwright');
  const output = path.resolve(outputDirectory);
  const relative = path.relative(outputBase, output);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'evidence stays below output/playwright');
  await fs.mkdir(output, { recursive: true });
  const fixture = await fixtureProject(page);
  assert.equal(fixture.project.id, 'look-qa-a');
  const sourceStory = fixture.project.sourceDocuments[0].content;
  const requests = []; const errors = []; const expectedFailures = []; const stages = []; const screenshots = [];
  let nextStoryMode = ''; let nextLookMode = ''; let heldStory; let heldLook;
  const consoleListener = (message) => {
    if (message.type() !== 'error') return;
    if (message.text().startsWith('[vite] failed to connect to websocket.')) return;
    if (/Failed to load resource:.*503/iu.test(message.text())) expectedFailures.push(message.text());
    else if (/ERR_ABORTED|ERR_FAILED|ERR_CANCELED/iu.test(message.text()) && message.location().url?.includes('/qa-director-look/') && heldLook) expectedFailures.push(message.text());
    else errors.push(message.text());
  };
  const pageErrorListener = (error) => errors.push(error.message);
  page.on('console', consoleListener); page.on('pageerror', pageErrorListener);
  const apiPattern = '**/qa-director-look/v1/chat/completions';
  const apiHandler = async (route) => {
    let currentHold;
    try {
      const request = route.request();
      assert.equal(new URL(request.url()).origin, origin);
      assert.equal(request.method(), 'POST');
      const body = request.postDataJSON();
      const user = body.messages.filter((message) => message.role === 'user').map((message) => typeof message.content === 'string'
        ? message.content : message.content.map((part) => part.text || '').join('\n')).join('\n');
      const storyMatch = user.match(/<story_analysis_data>\s*([\s\S]*?)\s*<\/story_analysis_data>/u);
      const lookMatch = user.match(/<director_look_data>\s*([\s\S]*?)\s*<\/director_look_data>/u);
      if (storyMatch) {
        const data = JSON.parse(storyMatch[1]); const mode = nextStoryMode; nextStoryMode = '';
        assert.equal(data.sourceStory, sourceStory);
        assert.ok(['held-success', 'held-failure'].includes(mode), 'story requests require an explicit QA case');
        requests.push({ kind: 'story', mode, data });
        await new Promise((resolve) => { heldStory = currentHold = { resolve, finished: false }; });
        if (mode === 'held-failure') {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'QA intentional story service unavailable' } }) });
        } else {
          const content = JSON.stringify({ characters: [], locations: [], props: [], scenes: [{ title: '完整同行剧情', content: sourceStory, summary: '隔离解析返回的全文场景', characters: [], props: [] }] });
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content } }] }) });
        }
      } else if (lookMatch) {
        const data = JSON.parse(lookMatch[1]); const mode = nextLookMode; nextLookMode = '';
        requests.push({ kind: 'look', mode, data });
        if (!mode) { await route.fallback(); return; }
        assert.equal(mode, 'held-stale');
        await new Promise((resolve) => { heldLook = currentHold = { resolve, finished: false }; });
        const content = JSON.stringify({ directorCategory: '不得回填的旧分类', directorStyle: '不得回填的旧风格', directorStyleSummary: '过期请求', visualStyle: '不得回填的旧视觉' });
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content } }] }) });
      } else throw new Error('Unexpected text-model request; no supplement or paid work is allowed by this fixture');
    } catch (error) {
      const expectedAbort = currentHold === heldLook && currentHold && /Target|closed|abort|handled|cancel|Interception/iu.test(String(error));
      if (expectedAbort) expectedFailures.push(String(error));
      else {
        errors.push(String(error));
        await route.fulfill({ status: 500, body: 'Typing QA rejected an unexpected request' }).catch(() => {});
      }
    } finally { if (currentHold) currentHold.finished = true; }
  };
  await page.route(apiPattern, apiHandler);
  const capture = async (name) => {
    await settle(page); const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false, scale: 'css' }); screenshots.push(file);
  };
  const waitReady = () => eventually(async () => await lookButton(page).isEnabled(), 'analysis action becomes enabled');
  const saveCheck = (value) => page.waitForFunction(({ key, value }) => JSON.parse(localStorage.getItem(key) || 'null')?.project?.directorLookRequirement === value, { key: fixture.key, value });
  const startStory = async (mode) => {
    heldStory = undefined; nextStoryMode = mode;
    await enterStory(page);
    await page.locator('.story-input-actions').getByRole('button', { name: '解析并补全', exact: true }).click();
    await eventually(() => Boolean(heldStory), 'story analysis held by isolated response gate');
    await enterDirector(page);
    assert.equal(await lookButton(page).isDisabled(), true, 'style analysis must not run while shared story generation is active');
    assert.equal(await custom(page).isEnabled(), true, 'the requirement draft must not inherit unrelated generation busy state');
  };
  const releaseStory = async () => {
    heldStory.resolve();
    await eventually(() => heldStory.finished, 'mock story route released');
    await waitReady();
  };
  try {
    await replaceByTyping(page, 'left right', '，中文要求');
    await page.keyboard.press('ControlOrMeta+Home');
    for (let count = 0; count < 4; count += 1) await page.keyboard.press('ArrowRight');
    await page.keyboard.type(' MIDDLE', { delay: 12 });
    await page.keyboard.press('Backspace'); await page.keyboard.type('E');
    await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('Enter');
    await page.keyboard.insertText('第二行：柔和光线');
    const idleValue = 'left MIDDLE right，中文要求\n第二行：柔和光线';
    assert.equal(await custom(page).inputValue(), idleValue);
    await saveCheck(idleValue); await capture('01-idle-real-pointer-and-keyboard');
    stages.push('idle-real-pointer-ascii-chinese-midstring-edit-newline');

    await startStory('held-success');
    const beforeBusy = requests.length;
    await replaceByTyping(page, 'while story runs: ', '解析时仍可编辑，柔光电影感');
    await page.keyboard.press('Enter'); await page.keyboard.insertText('第二行要求不丢失');
    const runningValue = 'while story runs: 解析时仍可编辑，柔光电影感\n第二行要求不丢失';
    assert.equal(await custom(page).inputValue(), runningValue);
    await settle(page); assert.equal(requests.length, beforeBusy, 'typing must not start another model call');
    assert.equal(await lookButton(page).isDisabled(), true);
    await capture('02-story-running-draft-remains-editable');
    await releaseStory();
    assert.equal(await custom(page).inputValue(), runningValue, 'analysis completion cannot overwrite a newer requirement');
    await saveCheck(runningValue);
    stages.push('story-success-busy-input-kept-no-extra-model-call');

    await lookButton(page).click();
    await eventually(() => requests.some((request) => request.kind === 'look' && request.data.customRequirement === runningValue), 'latest full requirement reaches original look fixture');
    await eventually(async () => (await readLook(page)).category === '水墨奇幻', 'original look fixture fills fields');
    const look = await readLook(page);
    assert.equal(look.director, '淡彩留白与缓慢推进的诗意调度');
    assert.equal(look.visual, '淡彩水墨与柔和纸张肌理');
    assert.match(look.summary, /遵循水墨要求/u); await waitReady();
    await capture('03-latest-request-filled'); stages.push('latest-custom-sent-four-fields-filled');

    await startStory('held-failure');
    const beforeFailureEdit = requests.length;
    await replaceByTyping(page, 'failure draft: ', '失败期间输入同样保留');
    const failureValue = 'failure draft: 失败期间输入同样保留';
    assert.equal(requests.length, beforeFailureEdit);
    await releaseStory(); assert.equal(await custom(page).inputValue(), failureValue);
    await saveCheck(failureValue); await capture('04-http503-preserves-draft');
    stages.push('story-http503-keeps-draft-and-unlocks-action');

    const stableLook = JSON.stringify(await readLook(page));
    nextLookMode = 'held-stale'; await lookButton(page).click();
    await eventually(() => Boolean(heldLook), 'style analysis held');
    await replaceByTyping(page, 'newer live draft: ', '手动输入优先，取消旧回填');
    const liveValue = 'newer live draft: 手动输入优先，取消旧回填';
    await waitReady(); heldLook.resolve();
    await eventually(() => heldLook.finished, 'stale style response released');
    await settle(page);
    assert.equal(await custom(page).inputValue(), liveValue);
    assert.equal(JSON.stringify(await readLook(page)), stableLook, 'aborted old style result must not overwrite current fields');
    await saveCheck(liveValue); await capture('05-live-edit-cancels-stale-look');
    stages.push('own-look-inflight-edit-cancels-stale-response-without-swallowing-input');
    assert.equal(requests.filter((request) => request.kind === 'story').length, 2);
    assert.equal(requests.filter((request) => request.kind === 'look').length, 2);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    return { inventory: QA_INVENTORY, stages, requests, errors, expectedFailures, screenshots, realPointerKeyboard: true, latestRequirementPreserved: true };
  } finally {
    heldStory?.resolve(); heldLook?.resolve();
    await page.unroute(apiPattern, apiHandler);
    page.off('console', consoleListener); page.off('pageerror', pageErrorListener);
  }
}
