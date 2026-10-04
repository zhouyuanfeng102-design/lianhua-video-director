import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Real App + fresh browser storage + synthetic model replies. Never attach to
// an existing browser/profile or permit a real model, image, or video request.
export const QA_INVENTORY = [
  'Raw story without any parsed scene and a 15-second segment duration make one semantic-planning request, even for a same-render double-click, with no master/H3/English preflight.',
  'The returned N semantic segments occupy N complete 15-second windows, remain unconfirmed until the user confirms, and contain no master shot ownership.',
  'Each confirmed segment requests its own shot plan and H3; later segments receive the exact previous final H3 and the existing 0.5-second handoff contract.',
  'A real reload preserves semantic source metadata, confirmed boundaries, completed prompts, legacy plans, and sparse video reference slots.',
  'An unclosed semantic JSON body automatically recovers with one additional request, appends an independent plan, and preserves all completed H3 and earlier plans.',
  'JSON output mode is present only in semantic planning/recovery requests; shot planning, H3 and English requests retain their existing protocol.',
  'A non-recoverable HTTP 400 does not overwrite completed results or automatically retry; the runtime error log retains its concrete reason and explicit retry starts one new request.',
  'The semantic review remains unclipped at 1366×900 and 1120×720 with 100% font scale, with visible planning and confirmation actions.',
  'For both an empty plan and an existing plan, the semantic action row is a direct panel child immediately below the whole options box, right-aligned and uncovered at 1366×900 and 1120×720 whether options are expanded or collapsed.',
  'While an isolated semantic request is pending, its disabled planning button and enabled stop button stay together in that external row in every layout; stopping aborts the request, ignores a released late reply, and retains all existing plans/H3/reference slots without duplicate requests.',
  'Opening a legacy project still displays its original master prompt and the separate opt-in semantic-planning entry without issuing a model request.',
  'Custom total 90 seconds at D=15 requests exactly six segments; raw 100 aligns to 105 on blur and reaches the API as exactly seven complete segments.',
  'Changing D keeps the custom total on complete segment multiples, and a real reload restores custom mode/T; switching to AI omits the old T from the wire payload.',
  'Whitespace/case-only fitStatus variations normalize to balanced on the initial request, with no additional AI review or repair call.',
  'Four consecutive invalid fitStatus replies exhaust only the initial-plus-three repair budget, show the field and all allowed values in both visible summaries, retain old plans/H3/reference slots, and permit a one-call retry without changing duration.',
];

const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `semantic-sequence-${Date.now()}`));
const relativeOutput = path.relative(outputBase, output);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Semantic QA output must stay below output/playwright');
for (let candidate = output; candidate !== root; candidate = path.dirname(candidate)) {
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error('Semantic QA output cannot traverse links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const apiPath = '/__semantic_sequence_mock__/v1/chat/completions';
const fixturePath = '/__semantic_sequence_fixture.html';
const storageKey = 'lianhua_video_director_state_v22';
const projectId = 'semantic-sequence-ui-project';
const legacyProjectId = 'semantic-sequence-legacy-project';
const sourceParts = [
  '林舟在石桥边把铜铃递向苏禾，说：“请接稳铜铃。”铃还在两人指间。',
  '苏禾接稳铜铃，抬手指向左侧石阶，说：“我们沿这边走。”',
  '两人转身沿左侧石阶离开，林舟说：“天亮前就能到了。”铜铃由苏禾带走。',
];
const lines = ['请接稳铜铃。', '我们沿这边走。', '天亮前就能到了。'];
const story = sourceParts.join('\n');
const titles = ['递出铜铃', '接铃指路', '转身离开'];
const semanticResponse = {
  segmentCount: 3, reason: '合成模型把完整交接与离开安排为三个完整15秒段。', fitStatus: 'balanced',
  segments: sourceParts.map((content, index) => ({
    title: titles[index], content, summary: `AI语义第${index + 1}段`, narrativePurpose: '推进原有交接与离开',
    entryState: index === 0 ? '二人在石桥相对站立' : index === 1 ? '铜铃仍在双方手指之间' : '苏禾已指向左侧石阶',
    exitState: index === 0 ? '铜铃仍在双方手指之间' : index === 1 ? '苏禾已指向左侧石阶' : '二人沿左侧石阶离开',
    transitionHint: '下一段只短暂接续上段末尾的可见动作，再推进本段事件。',
    boundaryReason: '由AI决定的动作接力边界', continuityPack: '林舟在左，苏禾在右，保持铜铃归属及石阶方向。',
    semanticSource: {
      sourceEvidence: [{ text: content }],
      // Repeating a cross-boundary event identity is intentional, not a local
      // duplicate-event veto or a requirement to regenerate earlier content.
      events: [{ id: 'bell-handoff', description: content, phase: index === 0 ? '交接中' : '推进中' }],
      dialogues: [{ id: `line-${index + 1}`, speaker: index === 1 ? '苏禾' : '林舟', text: lines[index], language: 'Chinese' }],
    },
  })),
};
const partialSemanticResponse = JSON.stringify(semanticResponse).slice(0, -20);
const invalidFitStatusResponse = { ...semanticResponse, fitStatus: 'balanced（适中）' };
const semanticResponseWithCount = (count) => ({ ...semanticResponse, segmentCount: count,
  segments: Array.from({ length: count }, (_, index) => ({ ...semanticResponse.segments[index % semanticResponse.segments.length], title: `固定第${index + 1}段` })),
});
const textContent = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n') : '';
const messageText = (payload, role) => (payload.messages || []).filter((message) => message.role === role)
  .map((message) => textContent(message.content)).join('\n');
const tagged = (text, tag) => {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  return match ? JSON.parse(match[1]) : undefined;
};
const translated = (source) => {
  const kept = [];
  return source.replace(/<d>[\s\S]*?<\/d>|"[^"\n]*"|“[^”\n]*”|林舟|苏禾/gu, (value) => {
    const token = `__QA_KEEP_${kept.length}__`; kept.push(value); return token;
  }).replace(/[\p{Script=Han}]+/gu, ' translated scene ')
    .replace(/，/gu, ', ').replace(/；/gu, '; ').replace(/。/gu, '.')
    .replace(/__QA_KEEP_(\d+)__/gu, (_all, index) => kept[Number(index)]);
};
const makeShots = (segmentIndex) => [0, 1].map((index) => ({
  startSec: index * 7.5, endSec: (index + 1) * 7.5,
  subject: '林舟与苏禾', action: sourceParts[segmentIndex - 1], sourceExcerpt: sourceParts[segmentIndex - 1],
  purpose: '推进本段原事件', camera: '石桥东侧稳定中景，不越轴', transition: '顺接动作', lighting: '清晨柔和侧光',
  sound: '无配乐，无新增对白', result: semanticResponse.segments[segmentIndex - 1].exitState,
  space: '林舟在左，苏禾在右，左侧石阶保持原位置', direction: '二人保持原有面向与石阶方向',
  performance: '双手动作自然接续，仅当前说话者做口型',
  dialogue: index === 0 ? `第1s @${segmentIndex === 2 ? '苏禾' : '林舟'}：“${lines[segmentIndex - 1]}”` : '无',
}));
const bootstrap = `import {createServer} from 'vite';const server=await createServer({server:{host:'127.0.0.1',port:${port},strictPort:true,hmr:false,watch:null}});await server.listen();console.log('Semantic sequence isolated QA ready');`;
const vite = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: vite, qaLabel: 'semantic sequence UI QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser; let context; let page;
let phase = 'semantic-plan'; let segmentIndex = 1; let heldSemanticRequest;
const requests = []; const errors = []; const blockedRequests = []; const blockedDevelopmentSockets = []; const screenshots = []; const steps = []; const layouts = []; const cancelledRequests = [];
const semanticPlan = (state) => state.project.sequencePlans.find((plan) => plan.planningMode === 'semantic-segments');
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey);
const semanticPlanButton = () => page.getByTestId('semantic-sequence-plan');
const segmentBoards = (state, planId = semanticPlan(state)?.id) => {
  const plan = state.project.sequencePlans.find((entry) => entry.id === planId);
  return plan?.segments.map((segment) => state.project.storyboards.find((board) => board.id === segment.storyboardId)) || [];
};
const preservedLegacyProject = (state) => {
  // Browser persistence deduplicates the active library entry into an ID-only
  // reference; compare the authoritative project field when legacy is active.
  const legacy = state.project.id === legacyProjectId ? state.project : state.projects.find((project) => project.id === legacyProjectId);
  assert.ok(legacy, 'legacy project must remain present');
  // Existing startup workbench recovery calls applyOwnedProjectUpdate even
  // when its updater returns the same project. That helper touches only the
  // top-level updatedAt. Keep every other field, including all result/plan/
  // revision timestamps, under strict comparison; do not change production.
  const { updatedAt, ...preserved } = legacy;
  assert.equal(typeof updatedAt, 'number');
  return preserved;
};
const savedResults = (state) => ({ plans: state.project.sequencePlans, boards: state.project.storyboards, assets: state.project.assets, tasks: state.project.generationTasks,
  legacyProject: preservedLegacyProject(state) });
const capture = async (name) => { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false, animations: 'disabled' }); screenshots.push(`${name}.png`); };
const enterDirector = async () => { await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click(); await page.locator('.director-view').waitFor(); };
const assertNoUnexpectedGeneration = (state, originals) => {
  assert.equal(state.project.id, projectId);
  assert.deepEqual(state.project.scenes, [], 'raw-story semantic workflow must not depend on or manufacture parsed scenes');
  assert.deepEqual(state.project.sourceDocuments, originals.sourceDocuments, 'raw source documents remain unchanged');
  assert.deepEqual(state.project.assets, originals.assets, 'semantic planning must not generate/replace reference media');
  assert.deepEqual(state.project.generationTasks, originals.tasks, 'semantic planning must not submit video/image tasks or change their physical reference slots');
  assert.deepEqual(preservedLegacyProject(state), originals.legacyProject, 'legacy project, master and saved result remain untouched');
};
const assertFitStatusFailureSummary = (summary, label) => {
  assert.match(summary, /\$\.fitStatus/u, `${label}: the summary must name the invalid field without opening technical details`);
  for (const allowed of ['comfortable', 'balanced', 'compressed', 'insufficient']) {
    assert.ok(summary.includes(allowed), `${label}: the summary must include allowed status ${allowed}`);
  }
  assert.doesNotMatch(summary, /未识别的错误/u, `${label}: a known enum failure must not be replaced by an unknown-error fallback`);
};
const setPlanningOptionsOpen = async (open) => {
  const body = page.locator('#sequence-planning-options-body');
  if (await body.isVisible() !== open) {
    await page.locator('.sequence-planning-options-head').getByRole('button', { name: open ? '展开规划参数' : '收起规划参数', exact: true }).click();
  }
  assert.equal(await body.isVisible(), open);
  assert.equal(await body.evaluate((element) => element.hidden), !open);
  assert.equal(await page.locator('.sequence-planning-options-head').getByRole('button', { name: open ? '收起规划参数' : '展开规划参数', exact: true }).count(), 1);
};
const invokeSemanticPlanningTwice = () => semanticPlanButton().evaluate((element) => {
  const propKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
  const onClick = propKey && element[propKey]?.onClick;
  if (typeof onClick !== 'function') throw new Error('cannot locate rendered semantic planning callback');
  const event = { target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} };
  onClick(event); onClick(event);
});
const verifySemanticActionMatrix = async (planState, busy = false) => {
  for (const [width, height] of [[1366, 900], [1120, 720]]) {
    await page.setViewportSize({ width, height });
    for (const expanded of [true, false]) {
      await setPlanningOptionsOpen(expanded);
      // Move away from buttons so hover transforms do not affect alignment.
      await page.mouse.move(0, 0);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.evaluate(() => {
        const panel = document.querySelector('#sequence-plan-panel');
        const options = panel?.querySelector(':scope > .sequence-planning-options');
        const row = panel?.querySelector(':scope > .sequence-semantic-actions');
        const primary = document.querySelector('[data-testid="semantic-sequence-plan"]');
        if (!panel || !options || !row || !primary) throw new Error('semantic action row/options/primary must exist as panel children');
        const rect = (element, selector) => {
          const box = element.getBoundingClientRect();
          return { selector, x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        };
        const button = (element) => {
          const box = rect(element, element.dataset.testid || element.textContent.trim());
          const points = [[0.5, 0.5], [0.1, 0.25], [0.9, 0.25], [0.1, 0.75], [0.9, 0.75]];
          return { ...box, text: element.textContent.trim(), disabled: element.disabled,
            uncovered: points.every(([x, y]) => { const top = document.elementFromPoint(box.x + box.width * x, box.y + box.height * y); return element === top || element.contains(top); }) };
        };
        const buttons = [...row.querySelectorAll('button')];
        return { type: 'semantic-action-row', width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
          panel: rect(panel, '#sequence-plan-panel'), options: rect(options, '.sequence-planning-options'), row: rect(row, '.sequence-semantic-actions'),
          rowImmediatelyFollowsOptions: row.previousElementSibling === options, primaryInRow: primary.parentElement === row,
          primaryInsideOptions: options.contains(primary), buttons: buttons.map(button), primary: button(primary),
          stop: buttons.some((element) => element.textContent.trim() === '停止分段') ? button(buttons.find((element) => element.textContent.trim() === '停止分段')) : null,
          optionsExpanded: !document.querySelector('#sequence-planning-options-body').hidden };
      });
      const label = `${planState}/${busy ? 'busy' : 'idle'}/${expanded ? 'expanded' : 'collapsed'}/${width}×${height}`;
      assert.equal((await readState()).settings.uiFontScalePercent, 100);
      assert.equal(layout.optionsExpanded, expanded, label);
      assert.equal(layout.rowImmediatelyFollowsOptions, true, `${label}: the action row must immediately follow the complete options box`);
      assert.equal(layout.primaryInRow, true, `${label}: the planning button must be directly inside the dedicated row`);
      assert.equal(layout.primaryInsideOptions, false, `${label}: the planning button must be outside the parameter box`);
      assert.ok(layout.scrollWidth <= width + 1, `${label}: document must not overflow horizontally`);
      assert.ok(layout.options.bottom <= layout.row.y + 1, `${label}: action row must sit below the entire parameter box`);
      assert.ok(Math.abs(layout.row.right - layout.options.right) <= 1, `${label}: action row must align with the parameter box right edge`);
      assert.equal(layout.buttons.length, busy ? 2 : 1, `${label}: the action row must contain only planning and, while busy, stop`);
      const rightmost = layout.buttons.reduce((right, button) => Math.max(right, button.right), 0);
      assert.ok(Math.abs(rightmost - layout.row.right) <= 2, `${label}: actions must stay right-aligned`);
      assert.ok(Math.abs(layout.primary.right - layout.row.right) <= 2, `${label}: the primary action must stay at the far right, including while stop is present`);
      for (const box of [layout.panel, layout.row, ...layout.buttons]) {
        assert.ok(box.width > 0 && box.height > 0 && box.x >= -1 && box.y >= -1 && box.right <= width + 1 && box.bottom <= height + 1,
          `${label}: ${box.selector} must remain inside the viewport`);
      }
      assert.ok(layout.buttons.every((button) => button.uncovered), `${label}: every action must be uncovered at its center and four inner corners`);
      assert.equal(layout.primary.disabled, busy, `${label}: only a pending request disables the primary action`);
      assert.equal(layout.primary.text, busy ? 'AI 分段中…' : planState === 'empty' ? 'AI 理解剧情并分段' : '重新 AI 分段');
      if (busy) {
        assert.ok(layout.stop, `${label}: stop must remain visible after collapsing parameters`);
        assert.equal(layout.stop.disabled, false, `${label}: stop must be clickable while planning`);
        assert.ok(Math.abs((layout.primary.y + layout.primary.height / 2) - (layout.stop.y + layout.stop.height / 2)) <= 1,
          `${label}: planning and stop must share the same row`);
        assert.ok(layout.primary.right <= layout.stop.x + 1 || layout.stop.right <= layout.primary.x + 1, `${label}: planning and stop cannot overlap`);
      } else assert.equal(layout.stop, null);
      layouts.push({ ...layout, planState, busy, expanded });
      await capture(`actions-${planState}-${busy ? 'busy' : 'idle'}-${expanded ? 'expanded' : 'collapsed'}-${width}x${height}`);
    }
  }
};
const verifySemanticCancellation = async (planState, originals) => {
  const before = savedResults(await readState()); const requestStart = requests.length;
  const beforeErrors = await page.evaluate(() => localStorage.getItem('lianhua_runtime_error_log_v1'));
  phase = `semantic-cancel-${planState}`;
  assert.equal(heldSemanticRequest, undefined);
  await invokeSemanticPlanningTwice();
  await waitForCondition({ label: `${planState} pending semantic request`, timeoutMs: 20_000, intervalMs: 30, check: () => Boolean(heldSemanticRequest) });
  assert.equal(requests.length, requestStart + 1, `${planState}: same-render double-click creates only one pending semantic request`);
  assert.equal(requests[requestStart].kind, 'semantic-plan');
  await verifySemanticActionMatrix(planState, true);
  assert.equal(requests.length, requestStart + 1, `${planState}: viewport and parameter toggles must not restart planning`);
  const held = heldSemanticRequest;
  const aborted = page.waitForEvent('requestfailed', { predicate: (request) => request.url() === `${origin}${apiPath}` });
  await page.locator('.sequence-semantic-actions').getByRole('button', { name: '停止分段', exact: true }).click();
  held.release();
  const failedRequest = await aborted;
  assert.match(failedRequest.failure()?.errorText || '', /ABORTED|CANCELLED/iu, `${planState}: stop must abort the pending transport`);
  await held.finished; heldSemanticRequest = undefined;
  await page.waitForLoadState('networkidle');
  assert.equal(await semanticPlanButton().isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: '停止分段', exact: true }).count(), 0);
  assert.equal(await semanticPlanButton().innerText(), planState === 'empty' ? 'AI 理解剧情并分段' : '重新 AI 分段');
  assert.deepEqual(savedResults(await readState()), before, `${planState}: cancellation and a released late reply must not create or overwrite plans/H3/references`);
  assertNoUnexpectedGeneration(await readState(), originals);
  assert.equal(await page.evaluate(() => localStorage.getItem('lianhua_runtime_error_log_v1')), beforeErrors, `${planState}: user cancellation must not add an error log`);
  assert.equal(requests.length, requestStart + 1, `${planState}: stop must not automatically retry`);
  cancelledRequests.push({ phase, errorText: failedRequest.failure().errorText, lateReplyReleased: true, requestCount: requests.length - requestStart });
  await capture(`actions-${planState}-stopped-collapsed-1120x720`);
  steps.push(`${planState} plan: pending primary/stop stay right-aligned below expanded/collapsed options in both viewports; same-render double-click sends one request, stop aborts it, and the released late reply preserves all results without retry/error log`);
};
const verifySemanticLayout = async (width, height, label = '01-semantic-layout') => {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layout = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`missing layout element ${selector}`);
      const box = element.getBoundingClientRect();
      return { selector, x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const button = (selector) => {
      const element = document.querySelector(selector); const box = rect(selector);
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { ...box, disabled: element.disabled, uncovered: element === top || element.contains(top) };
    };
    return {
      width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      panel: rect('#sequence-plan-panel'),
      sections: ['.sequence-planner-head', '.sequence-planning-options', '.sequence-semantic-actions', '.sequence-plan-workspace > .sequence-filmstrip', '.sequence-segment-editor', '.sequence-plan-footer'].map(rect),
      actions: [button('[data-testid="semantic-sequence-plan"]'), button('.sequence-plan-confirm-actions button')],
    };
  });
  assert.equal((await readState()).settings.uiFontScalePercent, 100);
  assert.ok(layout.scrollWidth <= width + 1, `${width}×${height}: document must not overflow horizontally`);
  for (const box of [layout.panel, ...layout.actions]) {
    assert.ok(box.width > 0 && box.height > 0 && box.x >= -1 && box.y >= -1 && box.right <= width + 1 && box.bottom <= height + 1,
      `${width}×${height}: ${box.selector} must remain in viewport`);
  }
  for (let index = 1; index < layout.sections.length; index += 1) {
    assert.ok(layout.sections[index - 1].bottom <= layout.sections[index].y + 1,
      `${width}×${height}: ${layout.sections[index - 1].selector} overlaps ${layout.sections[index].selector}`);
  }
  assert.ok(layout.actions.every((action) => action.uncovered && !action.disabled), `${width}×${height}: primary actions must remain clickable and uncovered`);
  layouts.push(layout); await capture(`${label}-${width}x${height}`);
};

const installMocks = async () => {
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    const record = { method: 'WEBSOCKET', url: socket.url() };
    // Vite may still inject its client when HMR is false. Block that local
    // development connection too, but do not confuse it with an app/provider
    // request. No WebSocket is allowed to reach its server in this fixture.
    if (url.protocol === 'ws:' && url.host === new URL(origin).host && url.pathname === '/') blockedDevelopmentSockets.push(record);
    else blockedRequests.push(record);
    socket.close();
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && url.pathname !== apiPath)) {
      blockedRequests.push({ method: request.method(), url: request.url() }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === fixturePath) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Isolated semantic fixture</body></html>' }); return; }
    if (url.pathname !== apiPath) { await route.continue(); return; }
    try {
      assert.equal(request.method(), 'POST');
      const payload = request.postDataJSON(); const system = messageText(payload, 'system'); const user = messageText(payload, 'user');
      const planning = tagged(user, 'storyboard_planning_data'); const planningReview = tagged(user, 'storyboard_ai_review_data');
      const conversion = tagged(user, 'video_conversion_data'); const stagingReview = tagged(user, 'video_staging_review_data');
      const englishReview = tagged(user, 'review_data');
      const semanticSource = tagged(user, 'semantic_segment_source_data')?.sequenceSegmentContext;
      const handoff = tagged(user, 'sequence_text_handoff_data')?.sequenceHandoff
        || conversion?.sequenceHandoff || stagingReview?.sequenceHandoff || englishReview?.stagingContext?.sequenceHandoff;
      let kind; let response; let data;
      if (system.includes('RAW_STORY_SEMANTIC_SEQUENCE_PLANNING_V1')) {
        kind = 'semantic-plan'; const prefix = 'semantic_sequence_input=';
        assert.ok(user.includes(prefix)); data = JSON.parse(user.slice(user.indexOf(prefix) + prefix.length).trim());
        assert.equal(data.story, story); assert.equal(data.segmentDurationSec, 15);
        if (data.durationMode === 'fixed') {
          assert.equal(data.requestedTotalDurationSec % data.segmentDurationSec, 0);
          assert.equal(data.durationAdjustmentPolicy, 'fixed-total-duration');
          assert.equal(data.requiredSegmentCount, data.requestedTotalDurationSec / data.segmentDurationSec);
          response = semanticResponseWithCount(data.requiredSegmentCount);
        } else {
          assert.equal(data.durationAdjustmentPolicy, 'ai-chooses-segment-count');
          for (const field of ['requestedTotalDurationSec', 'totalDurationSec', 'requiredSegmentCount']) {
            assert.equal(Object.hasOwn(data, field), false, `AI wire input must omit old custom ${field}`);
          }
          response = phase === 'plan-recovery' ? partialSemanticResponse
            : phase === 'fit-status-failure' ? invalidFitStatusResponse
              : phase === 'semantic-plan' ? { ...semanticResponse, fitStatus: ' BALANCED ' }
                : phase === 'fit-status-retry' ? { ...semanticResponse, fitStatus: ' Balanced ' } : semanticResponse;
        }
      } else if (system.includes('RAW_STORY_SEMANTIC_SEQUENCE_TECHNICAL_REPAIR_V1')) {
        assert.ok(phase === 'plan-recovery' || phase === 'fit-status-failure', 'technically valid semantic responses must not trigger an extra semantic/repair gate');
        kind = 'semantic-repair'; const prefix = 'semantic_sequence_repair=';
        assert.ok(user.includes(prefix)); data = JSON.parse(user.slice(user.indexOf(prefix) + prefix.length).trim());
        assert.equal(data.input.story, story); assert.equal(data.input.segmentDurationSec, 15);
        assert.ok(data.technicalIssues.length);
        if (phase === 'fit-status-failure') {
          assert.equal(data.previousResponse, JSON.stringify(invalidFitStatusResponse));
          assertFitStatusFailureSummary(data.technicalIssues.join('；'), 'technical repair issues');
          response = invalidFitStatusResponse;
        } else {
          assert.equal(data.previousResponse, partialSemanticResponse);
          response = semanticResponse;
        }
      } else if (system.includes('智能导演分类器')) { kind = 'director'; response = { mode: 'narrative', reason: '合成的本段动作' }; }
      else if (planning || planningReview) { kind = planning ? 'shot-plan' : 'shot-review'; data = planning || planningReview; response = { shots: makeShots(segmentIndex) }; assert.equal(data.durationSec, 15); }
      else if (conversion) { kind = 'convert'; data = conversion; response = conversion.localStructureDraft || conversion.shotEvidence.map((shot) => shot.localStructureDraft).join('\n'); }
      else if (stagingReview) {
        kind = 'h3-review'; data = stagingReview;
        response = stagingReview.candidatePrompt.replace('overall_soundscape:', `SEMANTIC_FINAL_END_${segmentIndex}:末镜保留原动作的当前接力状态。\noverall_soundscape:`);
      } else if (englishReview) { kind = 'english-review'; data = englishReview; response = englishReview.candidateEnglishPrompt; }
      else if (/提示词翻译器/u.test(system)) { kind = 'translate'; response = translated(user.split('\n\n<sequence_text_handoff_data>')[0]); }
      else throw new Error(`Unexpected model stage (no master/estimate/legacy segmentation allowed): ${system.slice(0, 100)}`);
      const semanticRequest = kind === 'semantic-plan' || kind === 'semantic-repair';
      if (phase === 'semantic-plan' || phase === 'plan-failure' || phase === 'plan-retry' || phase === 'fit-status-retry') assert.equal(kind, 'semantic-plan', 'preflight must only request semantic boundaries');
      if (phase.startsWith('semantic-cancel-')) assert.equal(kind, 'semantic-plan', 'cancellation must not issue a preflight or technical-repair request');
      if (phase.startsWith('custom-total-') || phase === 'ai-after-custom-total') assert.equal(kind, 'semantic-plan', 'duration controls must only request semantic boundaries');
      if (phase === 'plan-recovery' || phase === 'fit-status-failure') assert.ok(semanticRequest, 'automatic recovery must only request semantic boundaries');
      if (semanticRequest) assert.deepEqual(payload.response_format, { type: 'json_object' }, 'semantic planner opts into JSON output mode');
      else assert.equal(payload.response_format, undefined, `${kind}: existing shot/H3/English protocol must not inherit semantic JSON mode`);
      if (!semanticRequest) for (const futureLine of lines.slice(segmentIndex)) assert.ok(!user.includes(futureLine), `segment ${segmentIndex} must not receive later-segment dialogue ${futureLine}`);
      if (kind === 'shot-plan' || kind === 'shot-review' || kind === 'convert' || kind === 'h3-review') {
        const scoped = semanticSource || data?.sequenceSegmentContext;
        assert.ok(scoped, `${kind} needs scoped original evidence, events and dialogue`);
        assert.equal(scoped.kind, 'semantic-segment-source-v1'); assert.equal(scoped.segmentIndex, segmentIndex);
        assert.equal(scoped.segmentDurationSec, 15); assert.equal(scoped.segment.content, sourceParts[segmentIndex - 1]);
        assert.deepEqual(scoped.segment.semanticSource, semanticResponse.segments[segmentIndex - 1].semanticSource);
        assert.equal(scoped.sourceStoryContent, undefined); assert.equal(scoped.story, undefined);
      }
      if (kind === 'translate' || kind === 'english-review') assert.equal(semanticSource, undefined, 'English must not replan semantic content');
      requests.push({ phase, kind, segmentIndex: semanticRequest ? undefined : segmentIndex, data, handoff, semanticSource,
        responseFormat: payload.response_format, maxTokens: payload.max_tokens, thinking: payload.thinking });
      assert.equal((payload.messages || []).flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part.type === 'image_url').length, 0);
      if (handoff) { assert.equal(handoff.openingOverlapSec, 0.5); assert.equal(handoff.segmentIndex, segmentIndex); assert.equal(handoff.previousSegmentIndex, segmentIndex - 1); }
      if (phase === 'plan-failure') { await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":{"message":"QA_SEMANTIC_EXPECTED_FAILURE"}}' }); return; }
      const reply = { contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: typeof response === 'string' ? response : JSON.stringify(response) }, finish_reason: 'stop' }] }) };
      if (phase.startsWith('semantic-cancel-')) {
        assert.equal(heldSemanticRequest, undefined, 'only one cancellable semantic request may be in flight');
        let release; let finish;
        const released = new Promise((resolve) => { release = resolve; });
        const finished = new Promise((resolve) => { finish = resolve; });
        heldSemanticRequest = { release, finished };
        await released;
        // The browser has already aborted this isolated request. Releasing a
        // late synthetic success must neither restore it nor create a plan.
        await route.fulfill(reply).catch(() => {});
        finish(); return;
      }
      await route.fulfill(reply);
    } catch (error) {
      errors.push(String(error)); await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: `Isolated semantic mock rejected input: ${error.message}` } }) }).catch(() => {});
    }
  });
};

const seed = async () => {
  await page.goto(`${origin}${fixturePath}`);
  await page.evaluate(async ({ key, projectId, legacyProjectId, story, origin }) => {
    const { createInitialState } = await import('/src/storage.ts'); const state = createInitialState(); const now = Date.now();
    const { buildLocalSequencePlan } = await import('/src/storySegmentation.ts');
    const characters = ['林舟', '苏禾'].map((name, index) => ({ id: `semantic-person-${index}`, name, gender: index ? '女' : '男', apparentAge: '30岁成年', race: '人类', appearance: '固定面容与黑发', outfit: index ? '青色长衣' : '灰色长衣', signatureProps: '铜铃', personality: '沉稳', motionHabits: '动作自然', anchor: '保持身份', negativeContinuity: '', assetIds: [] }));
    const scene = { id: 'semantic-scene', title: '石桥交接铜铃', content: story, summary: '铜铃交接和离开', characterIds: characters.map((entry) => entry.id), locationIds: [], propIds: [], storyboardIds: [], createdAt: now, updatedAt: now };
    const project = { ...state.project, id: projectId, name: '语义分段隔离验证', characters, locations: [], props: [], scenes: [], sourceDocuments: [{ id: 'semantic-source', name: scene.title, content: story, createdAt: now, updatedAt: now }], storyboards: [], sequencePlans: [], assets: [], generationTasks: [], storyDraft: undefined, directorSettingsConfirmedFingerprint: undefined, directorSettingsConfirmedAt: undefined, createdAt: now, updatedAt: now };
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
    const references = [{ assetId: 'historical-ref-a', role: 'character', slotIndex: 0 }, { assetId: 'historical-ref-b', role: 'character', slotIndex: 2 }];
    project.assets = references.map((reference) => ({ id: reference.assetId, name: reference.assetId, type: 'reference', role: 'character', tags: [], dataUrl: pixel, createdAt: 1, updatedAt: 1 }));
    project.generationTasks = [{ id: 'historical-stopped-video', kind: 'video', storyboardId: 'historical-unlinked-result', targetId: 'historical-target', status: 'failed', requestBody: {}, error: 'Historical stopped fixture', createdAt: 1, updatedAt: 1,
      videoJob: { stage: 'stopped', trackingStopped: true, remoteGenerationEnded: true, snapshot: { projectId, clientId: 'historical-client', connection: { backend: 'api' },
        draft: { name: 'Historical sparse references', prompt: 'No video request is authorized', backend: 'api', references, referenceSlotRoles: ['character', 'prop', 'character'], parameters: {} },
        images: references.map((reference) => ({ ...reference, name: reference.assetId, dataUrl: pixel })) } } }];
    const legacyStory = '历史人物站在旧门边，保留原稿。';
    const legacyScene = { ...scene, id: 'historical-scene', title: '历史总稿场景', content: legacyStory, summary: '保留历史总稿', characterIds: [], storyboardIds: ['historical-master'], createdAt: 1, updatedAt: 1 };
    const legacyPlan = buildLocalSequencePlan({ title: '历史总稿计划', story: legacyStory, totalDurationSec: 15, segmentDurationSec: 15, segmentationMode: 'fixed', sourceSceneIds: [legacyScene.id] });
    legacyPlan.id = 'historical-master-plan'; legacyPlan.masterStoryboardId = 'historical-master';
    const legacyBoard = { id: 'historical-master', sceneId: 'historical-scene', sequencePlanId: legacyPlan.id,
      workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
      stylePresetId: state.settings.defaultStylePresetId, ruleSetId: state.settings.defaultRuleSetId, globalLock: '历史空间不变', globalReferenceAssetIds: [],
      sourceStoryContent: legacyPlan.sourceStoryContent, shots: [], finalPrompt: 'HISTORICAL_MASTER_DO_NOT_OVERWRITE', officialPromptZh: 'HISTORICAL_SAVED_RESULT_DO_NOT_OVERWRITE', createdAt: 1, updatedAt: 1 };
    const legacyProject = { ...project, id: legacyProjectId, name: '旧总稿兼容项目', characters: [], scenes: [legacyScene], sourceDocuments: [{ id: 'historical-source', name: legacyScene.title, content: legacyStory, createdAt: 1, updatedAt: 1 }], sequencePlans: [legacyPlan], storyboards: [legacyBoard], assets: [], generationTasks: [], createdAt: 1, updatedAt: 1 };
    state.project = project; state.projects = [project, legacyProject]; state.activeProjectId = projectId;
    state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: `${origin}/__semantic_sequence_mock__/v1`, apiKey: '', model: 'semantic-sequence-mock', vision: false };
    const api = state.settings.textApi;
    const legacyDirectorFingerprint = JSON.stringify(['drama', 'text', 'exact', 1, 'standard', '16:9', '2K', 'stereo',
      state.settings.defaultStylePresetId, state.settings.defaultRuleSetId, 'converter_unified_video', 'standard_cinema',
      [], [], '电影写实', '', [], api.enabled, api.provider, api.baseUrl, api.model, api.temperature, api.maxTokens, api.vision,
      '视觉', '标准电影感', '叙事清晰、镜头克制；适合：通用场景']);
    legacyPlan.masterPromptDirectorSettingsFingerprint = legacyDirectorFingerprint;
    legacyProject.directorSettingsConfirmedFingerprint = legacyDirectorFingerprint;
    legacyProject.directorSettingsConfirmedAt = 1;
    state.settings.textApiProfiles = []; state.settings.activeTextApiProfileId = null;
    for (const field of ['imageApi', 'visionApi', 'videoTaskApi', 'runningHubVideo', 'comfyuiVideo']) if (state.settings[field]) state.settings[field].enabled = false;
    state.settings.uiFontScalePercent = 100;
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, projectId, legacyProjectId, story, origin });
  await page.goto(origin, { waitUntil: 'networkidle' }); await enterDirector();
};

const run = async () => {
  await waitForCondition({ label: 'semantic Vite startup', timeoutMs: 40_000, intervalMs: 100, check: async () => { try { return (await fetch(origin)).ok; } catch { return false; } } });
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(40_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await installMocks(); await seed();
  assert.equal(await page.evaluate(() => Boolean(window.lianhuaDesktop)), false, 'fixture must not have a desktop/production-data bridge');
  const initial = await readState();
  const originals = { sourceDocuments: initial.project.sourceDocuments, assets: initial.project.assets, tasks: initial.project.generationTasks, legacyProject: preservedLegacyProject(initial) };
  assert.deepEqual(initial.project.scenes, [], 'start with the raw story only, no prior scene analysis');
  assert.ok(originals.legacyProject.sequencePlans[0].masterStoryboardId);
  assert.deepEqual(originals.tasks[0].videoJob.snapshot.draft.references.map((reference) => reference.slotIndex), [0, 2]);
  assert.deepEqual(originals.tasks[0].videoJob.snapshot.draft.referenceSlotRoles, ['character', 'prop', 'character']);
  await page.getByRole('button', { name: '长剧情拆段', exact: true }).click();
  await page.locator('#sequence-director-settings-panel #director-setup-timing').getByRole('button', { name: '15 秒', exact: true }).click();
  await page.getByRole('button', { name: /确认全片导演参数，进入①/u }).click();
  await page.locator('.sequence-planner-panel').waitFor();
  await verifySemanticActionMatrix('empty');
  await verifySemanticCancellation('empty', originals);
  const initialPlanStart = requests.length; phase = 'semantic-plan';
  await invokeSemanticPlanningTwice();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)).project.sequencePlans.some((plan) => plan.planningMode === 'semantic-segments' && plan.segments.length === 3), storageKey);
  assert.deepEqual(errors, []);
  const planned = await readState(); const plan = semanticPlan(planned);
  assert.equal(plan.totalDurationSec, 45); assert.equal(plan.segmentDurationSec, 15); assert.equal(plan.masterStoryboardId, undefined);
  assert.equal(plan.fitStatus, 'balanced', 'whitespace/case-only status must normalize without an extra model call');
  assert.deepEqual(plan.segments.map((segment) => [segment.globalStartSec, segment.globalEndSec, segment.durationSec]), [[0, 15, 15], [15, 30, 15], [30, 45, 15]]);
  assert.ok(plan.segments.every((segment) => !segment.sourceShotIds?.length && !segment.storyboardId));
  assert.equal(planned.project.storyboards.length, 0); assert.equal(requests.length, initialPlanStart + 1); assert.equal(requests[initialPlanStart].kind, 'semantic-plan');
  assert.equal(await page.locator('#sequence-plan-panel[data-planning-mode="semantic-segments"]').count(), 1);
  assert.equal(await page.locator('#sequence-plan-panel').getByRole('tab', { name: /总提示词|总稿/u }).count(), 0, 'new semantic plan must not show a nonexistent master prompt tab');
  assertNoUnexpectedGeneration(planned, originals); await capture('01-direct-semantic-plan-no-master');
  steps.push('one raw-story semantic request creates three 15-second segments and no master/H3/English');
  steps.push('initial model fitStatus " BALANCED " normalizes to balanced using that same single request, without an added review or repair');
  await verifySemanticActionMatrix('existing');
  steps.push('empty/existing plans keep a directly adjacent external action row below the complete parameter box, right-aligned and uncovered in expanded/collapsed states at 1366×900 and 1120×720');
  await verifySemanticLayout(1366, 900); await verifySemanticLayout(1120, 720);
  await page.setViewportSize({ width: 1366, height: 900 });
  steps.push('semantic review and both primary actions are visible, uncovered and non-overlapping at 1366×900 and 1120×720 with 100% font scale');
  await page.getByRole('button', { name: /确认分段，进入/u }).click();
  assert.equal(requests.length, initialPlanStart + 1, 'confirming semantic boundaries must not silently generate any shot/H3');
  phase = 'segment-one'; segmentIndex = 1;
  await page.getByRole('button', { name: '生成当前段提示词', exact: true }).click();
  await page.waitForFunction(({ key, planId }) => { const state = JSON.parse(localStorage.getItem(key)); const plan = state.project.sequencePlans.find((entry) => entry.id === planId); const board = state.project.storyboards.find((entry) => entry.id === plan.segments[0].storyboardId); return board?.officialPromptZh && board.officialPromptEn && board.officialPromptEnSource === board.officialPromptZh; }, { key: storageKey, planId: plan.id }, { timeout: 60_000 });
  const firstState = await readState(); const firstBoard = segmentBoards(firstState, plan.id)[0];
  assert.equal(firstBoard.durationSec, 15); assert.equal(firstState.project.storyboards.length, 1); assert.match(firstBoard.officialPromptZh, /SEMANTIC_FINAL_END_1/u);
  assert.ok(requests.some((request) => request.phase === phase && request.kind === 'shot-plan'));
  await capture('02-first-segment-h3'); steps.push('confirmed semantic segment generates its own shot plan and final bilingual H3');
  phase = 'segment-two'; segmentIndex = 2;
  await page.locator('.sequence-director-strip .sequence-segment-chip').nth(1).click();
  await page.getByRole('button', { name: '生成当前段提示词', exact: true }).click();
  await page.waitForFunction(({ key, planId }) => { const state = JSON.parse(localStorage.getItem(key)); const plan = state.project.sequencePlans.find((entry) => entry.id === planId); const board = state.project.storyboards.find((entry) => entry.id === plan.segments[1].storyboardId); return board?.officialPromptZh && board.officialPromptEn && board.officialPromptEnSource === board.officialPromptZh && board.sequencePromptHandoff?.resultFingerprint; }, { key: storageKey, planId: plan.id }, { timeout: 60_000 });
  const completed = await readState(); const childRequests = requests.filter((request) => request.phase === phase && request.handoff);
  assert.ok(childRequests.length >= 3); assert.ok(childRequests.every((request) => request.handoff.previousFinalPrompt === firstBoard.officialPromptZh));
  assertNoUnexpectedGeneration(completed, originals); await capture('03-next-segment-exact-final-handoff');
  steps.push('second segment receives exact prior final H3 and 0.5-second handoff, without generating a video');
  const beforeReload = savedResults(completed); const callsBeforeReload = requests.length;
  await page.reload({ waitUntil: 'networkidle' }); await enterDirector();
  assert.deepEqual(savedResults(await readState()), beforeReload); assert.equal(requests.length, callsBeforeReload);
  await capture('04-real-reload-preserves-results'); steps.push('real browser reload preserves semantic plans, source metadata, and completed H3 without API replay');
  const planningTab = page.locator('[role="tab"][aria-controls="sequence-plan-panel"]');
  if (await planningTab.count()) await planningTab.first().click();
  const planButton = semanticPlanButton(); await planButton.waitFor();
  await verifySemanticCancellation('existing', originals);
  await page.setViewportSize({ width: 1120, height: 720 });
  const beforeRecovery = savedResults(await readState()); const recoveryStart = requests.length; phase = 'plan-recovery';
  await planButton.click();
  await page.waitForFunction(({ key, count }) => JSON.parse(localStorage.getItem(key)).project.sequencePlans.length === count + 1,
    { key: storageKey, count: beforeRecovery.plans.length });
  const recovered = await readState(); const recoveredPlan = recovered.project.sequencePlans.find((entry) => !beforeRecovery.plans.some((old) => old.id === entry.id));
  assert.ok(recoveredPlan); assert.equal(recoveredPlan.planningMode, 'semantic-segments'); assert.equal(recoveredPlan.reviewConfirmedFingerprint, undefined);
  assert.equal(requests.length, recoveryStart + 2, 'unclosed body must make precisely the initial request and one automatic recovery request');
  assert.deepEqual(requests.slice(recoveryStart).map((request) => request.kind), ['semantic-plan', 'semantic-repair']);
  assert.ok(requests[recoveryStart + 1].maxTokens > requests[recoveryStart].maxTokens, 'unclosed JSON recovery raises the request output allowance');
  for (const oldPlan of beforeRecovery.plans) assert.deepEqual(recovered.project.sequencePlans.find((entry) => entry.id === oldPlan.id), oldPlan);
  assert.deepEqual(recovered.project.storyboards, beforeRecovery.boards, 'automatic recovery retains the exact earlier bilingual final H3');
  assertNoUnexpectedGeneration(recovered, originals);
  assert.equal(await page.locator('.runtime-error-log-count').textContent(), '0', 'successful recovery does not produce a final failure log');
  await capture('04b-unclosed-json-recovered-1120x720');
  steps.push('after reload, one unclosed JSON body automatically recovers on request two and appends a new unconfirmed plan, preserving exact prior H3, old plans and sparse references');
  const beforeFailure = savedResults(await readState()); const failureStart = requests.length; phase = 'plan-failure';
  await planButton.click();
  await waitForCondition({ label: 'expected failed semantic request', timeoutMs: 20_000, intervalMs: 30, check: () => requests.length === failureStart + 1 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.sequence-planner-panel button'))
    .some((button) => button.textContent?.trim() === '重新 AI 分段' && !button.disabled));
  assert.deepEqual(savedResults(await readState()), beforeFailure, 'failed replan must not remove old confirmed boundaries or completed prompts');
  assert.equal(requests.length, failureStart + 1, 'failed provider response must not silently auto-retry');
  const runtimeErrors = await page.evaluate(() => JSON.parse(localStorage.getItem('lianhua_runtime_error_log_v1') || '[]'));
  assert.equal(runtimeErrors.length, 1); assert.equal(runtimeErrors[0].stage, 'sequence-semantic-planning');
  assert.equal(runtimeErrors[0].status, 400); assert.match(runtimeErrors[0].message, /QA_SEMANTIC_EXPECTED_FAILURE/u);
  assert.equal(await page.locator('.runtime-error-log-count').textContent(), '1');
  await capture('05-failed-replan-keeps-completed-results');
  await page.locator('.runtime-error-log-trigger').click();
  const errorDialog = page.getByRole('dialog', { name: '报错日志', exact: true }); await errorDialog.waitFor();
  const errorDetails = errorDialog.locator('.runtime-error-details details');
  if (await errorDetails.count()) await errorDetails.locator('summary').click();
  assert.match(await errorDialog.innerText(), /QA_SEMANTIC_EXPECTED_FAILURE/u, 'the log dialog displays the concrete provider failure');
  await capture('05b-http400-concrete-error-log-1120x720');
  await errorDialog.getByRole('button', { name: '关闭', exact: true }).click();
  steps.push('ordinary HTTP 400 makes one request, keeps completed H3/old plans intact, and shows the concrete provider reason in the runtime log at 1120×720');
  phase = 'plan-retry'; await planButton.click();
  await page.waitForFunction(({ key, count }) => JSON.parse(localStorage.getItem(key)).project.sequencePlans.length === count + 1, { key: storageKey, count: beforeFailure.plans.length });
  const retried = await readState(); const newPlan = retried.project.sequencePlans.find((entry) => !beforeFailure.plans.some((old) => old.id === entry.id));
  assert.ok(newPlan); assert.equal(newPlan.planningMode, 'semantic-segments'); assert.equal(newPlan.reviewConfirmedFingerprint, undefined);
  for (const oldPlan of beforeFailure.plans) assert.deepEqual(retried.project.sequencePlans.find((entry) => entry.id === oldPlan.id), oldPlan);
  assert.deepEqual(retried.project.storyboards, beforeFailure.boards); assertNoUnexpectedGeneration(retried, originals);
  assert.equal(requests.length, failureStart + 2, 'only the explicit retry starts one new planning request');
  assert.equal(newPlan.masterStoryboardId, undefined);
  await capture('06-explicit-retry-creates-independent-plan');
  steps.push('explicit retry creates an independent unconfirmed semantic plan, preserving earlier completed results, the legacy master project and physical reference slots 1/3');

  const durationSources = page.getByRole('group', { name: '总时长来源', exact: true });
  const customTotalInput = page.getByRole('spinbutton', { name: '全片总秒数', exact: true });
  const customModeButton = durationSources.getByRole('button', { name: '自定义总时长', exact: true });
  const aiModeButton = durationSources.getByRole('button', { name: 'AI适配', exact: true });
  const ensurePlanningOptionsOpen = async () => {
    const expand = page.getByRole('button', { name: '展开规划参数', exact: true });
    if (await expand.count()) await expand.click();
    await durationSources.waitFor({ state: 'visible' });
  };
  await page.setViewportSize({ width: 1366, height: 900 });
  await ensurePlanningOptionsOpen();
  assert.equal(await aiModeButton.getAttribute('aria-pressed'), 'true');
  await customModeButton.click();
  assert.equal(await customTotalInput.getAttribute('step'), '15');
  assert.equal(await customTotalInput.getAttribute('min'), '15');
  assert.equal(await customTotalInput.getAttribute('max'), '3600');
  const requestCustomTotal = async (total, name) => {
    const before = savedResults(await readState()); const requestStart = requests.length; phase = name;
    await planButton.click();
    await page.waitForFunction(({ key, count }) => JSON.parse(localStorage.getItem(key)).project.sequencePlans.length === count + 1,
      { key: storageKey, count: before.plans.length });
    const current = await readState(); const created = current.project.sequencePlans.find((entry) => !before.plans.some((old) => old.id === entry.id));
    assert.ok(created); assert.equal(created.durationMode, 'fixed'); assert.equal(created.requestedTotalDurationSec, total);
    assert.equal(created.totalDurationSec, total); assert.equal(created.segmentDurationSec, 15); assert.equal(created.segments.length, total / 15);
    assert.equal(created.semanticPlanningSnapshot.durationMode, 'fixed'); assert.equal(created.semanticPlanningSnapshot.requestedTotalDurationSec, total);
    assert.equal(requests.length, requestStart + 1, `${name}: custom-total planning is one model request`);
    assert.equal(requests[requestStart].data.durationMode, 'fixed'); assert.equal(requests[requestStart].data.requestedTotalDurationSec, total);
    assert.equal(requests[requestStart].data.totalDurationSec, total); assert.equal(requests[requestStart].data.requiredSegmentCount, total / 15);
    assert.ok(created.segments.every((segment) => segment.durationSec === 15 && !segment.storyboardId && !segment.sourceShotIds?.length));
    for (const oldPlan of before.plans) assert.deepEqual(current.project.sequencePlans.find((entry) => entry.id === oldPlan.id), oldPlan);
    assert.deepEqual(current.project.storyboards, before.boards, `${name}: custom-total success retains every earlier exact H3`);
    assertNoUnexpectedGeneration(current, originals);
    await ensurePlanningOptionsOpen();
    return created;
  };
  await customTotalInput.fill('90'); await customTotalInput.press('Tab');
  assert.equal(await customTotalInput.inputValue(), '90');
  await requestCustomTotal(90, 'custom-total-90');
  assert.match(await page.locator('.sequence-planning-options').innerText(), /6\s*段\s*×\s*15\s*秒\s*=\s*90\s*秒/u);
  await capture('08-custom-total-90-six-segments');
  await customTotalInput.fill('100'); assert.equal(await customTotalInput.inputValue(), '100');
  await customTotalInput.press('Tab'); assert.equal(await customTotalInput.inputValue(), '105', 'blur aligns raw custom total upward to a complete D=15 segment');
  await requestCustomTotal(105, 'custom-total-105');
  assert.match(await page.locator('.sequence-planning-options').innerText(), /7\s*段\s*×\s*15\s*秒\s*=\s*105\s*秒/u);
  await verifySemanticLayout(1366, 900, '09-custom-total-layout'); await verifySemanticLayout(1120, 720, '09-custom-total-layout');
  await page.setViewportSize({ width: 1366, height: 900 });
  const durationOptions = page.locator('.sequence-planning-options');
  await durationOptions.getByRole('button', { name: '10秒', exact: true }).click();
  assert.equal(await customTotalInput.getAttribute('step'), '10'); assert.equal(await customTotalInput.inputValue(), '110');
  await durationOptions.getByRole('button', { name: '15秒', exact: true }).click();
  assert.equal(await customTotalInput.getAttribute('step'), '15'); assert.equal(await customTotalInput.inputValue(), '120');
  await customTotalInput.fill('45'); await customTotalInput.press('Tab');
  const restoredCustomPlan = await requestCustomTotal(45, 'custom-total-45');
  const customResults = savedResults(await readState()); const beforeCustomReload = requests.length;
  await page.reload({ waitUntil: 'networkidle' }); await enterDirector();
  const planningTabAfterCustomReload = page.locator('[role="tab"][aria-controls="sequence-plan-panel"]');
  if (await planningTabAfterCustomReload.count()) await planningTabAfterCustomReload.first().click();
  await ensurePlanningOptionsOpen();
  await customModeButton.waitFor();
  assert.equal(await customModeButton.getAttribute('aria-pressed'), 'true'); assert.equal(await customTotalInput.inputValue(), '45');
  assert.deepEqual(savedResults(await readState()), customResults); assert.equal(requests.length, beforeCustomReload);
  assert.equal(semanticPlan(await readState()).id, restoredCustomPlan.id);
  await capture('10-reload-restores-custom-total');
  await aiModeButton.click(); assert.equal(await aiModeButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await customTotalInput.count(), 0, 'AI mode no longer exposes the stale custom-total input');
  const beforeAi = savedResults(await readState()); const beforeAiRequest = requests.length; phase = 'ai-after-custom-total';
  await planButton.click();
  await page.waitForFunction(({ key, count }) => JSON.parse(localStorage.getItem(key)).project.sequencePlans.length === count + 1,
    { key: storageKey, count: beforeAi.plans.length });
  const aiRestored = await readState(); const aiCreated = semanticPlan(aiRestored);
  assert.equal(requests.length, beforeAiRequest + 1); assert.equal(requests[beforeAiRequest].data.durationMode, 'ai-estimated');
  for (const field of ['requestedTotalDurationSec', 'totalDurationSec', 'requiredSegmentCount']) assert.equal(Object.hasOwn(requests[beforeAiRequest].data, field), false);
  assert.equal(aiCreated.durationMode, 'ai-estimated'); assert.equal(aiCreated.requestedTotalDurationSec, undefined); assert.equal(aiCreated.totalDurationSec, 45);
  for (const oldPlan of beforeAi.plans) assert.deepEqual(aiRestored.project.sequencePlans.find((entry) => entry.id === oldPlan.id), oldPlan);
  assert.deepEqual(aiRestored.project.storyboards, beforeAi.boards); assertNoUnexpectedGeneration(aiRestored, originals);
  await ensurePlanningOptionsOpen();
  await capture('11-ai-after-custom-total-omits-old-duration');
  steps.push('custom total 90→6 complete segments; raw 100 blurs to 105→7 and reaches API as T=105/N=7; D changes align T, both fixed layouts remain uncovered, reload restores fixed45, and AI omits old T while preserving all exact H3/old plans/sparse references');

  const beforeFitStatusFailure = savedResults(await readState()); const fitStatusFailureStart = requests.length;
  const errorsBeforeFitStatusFailure = await page.evaluate(() => JSON.parse(localStorage.getItem('lianhua_runtime_error_log_v1') || '[]'));
  phase = 'fit-status-failure';
  await planButton.click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="semantic-sequence-plan"]');
    return button && !button.disabled && document.querySelector('.sequence-planning-error > span')?.textContent?.includes('$.fitStatus');
  });
  const fitStatusRequests = requests.slice(fitStatusFailureStart);
  assert.deepEqual(fitStatusRequests.map((request) => request.kind), ['semantic-plan', 'semantic-repair', 'semantic-repair', 'semantic-repair'],
    'invalid fitStatus uses exactly the initial request plus the existing three technical repairs, with no extra review');
  assert.ok(fitStatusRequests.every((request) => request.phase === 'fit-status-failure'));
  for (const repair of fitStatusRequests.slice(1)) assert.deepEqual(repair.data.input, fitStatusRequests[0].data, 'enum repair must retain the exact original planning input and duration');
  assert.deepEqual(savedResults(await readState()), beforeFitStatusFailure, 'exhausted enum repairs must retain every old plan, exact bilingual H3, and physical reference slot');
  assertNoUnexpectedGeneration(await readState(), originals);
  assert.equal(await planButton.isEnabled(), true, 'the planning button becomes available again after enum repair exhaustion');
  assert.equal(await aiModeButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await customTotalInput.count(), 0, 'invalid fitStatus must not require changing duration mode or exposing a new total');
  const fitStatusSummary = await page.locator('.sequence-planning-error > span').innerText();
  assertFitStatusFailureSummary(fitStatusSummary, 'planning failure summary');
  assert.match(await page.locator('.sequence-planning-error').innerText(), /无需手动重算总时长/u);
  const fitStatusErrors = await page.evaluate(() => JSON.parse(localStorage.getItem('lianhua_runtime_error_log_v1') || '[]'));
  assert.equal(fitStatusErrors.length, errorsBeforeFitStatusFailure.length + 1, 'one final enum failure creates one log, not one log per repair');
  assert.equal(fitStatusErrors[0].stage, 'sequence-semantic-planning');
  assertFitStatusFailureSummary(fitStatusErrors[0].message, 'persisted failure diagnostic');
  assert.equal(await page.locator('.runtime-error-log-count').textContent(), String(fitStatusErrors.length));
  await capture('12-invalid-fit-status-exhausted-keeps-results');
  await page.locator('.runtime-error-log-trigger').click();
  const fitStatusErrorDialog = page.getByRole('dialog', { name: '报错日志', exact: true }); await fitStatusErrorDialog.waitFor();
  assertFitStatusFailureSummary(await fitStatusErrorDialog.locator('.runtime-error-log-entry').first().locator('.task-error-summary').innerText(), 'runtime log summary');
  await capture('12b-invalid-fit-status-visible-log-summary');
  await fitStatusErrorDialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(requests.length, fitStatusFailureStart + fitStatusRequests.length, 'reading error summaries must not start an additional model request');
  const fitStatusRetryStart = requests.length; phase = 'fit-status-retry';
  await planButton.click();
  await page.waitForFunction(({ key, count }) => JSON.parse(localStorage.getItem(key)).project.sequencePlans.length === count + 1,
    { key: storageKey, count: beforeFitStatusFailure.plans.length });
  const fitStatusRetried = await readState();
  const fitStatusNewPlan = fitStatusRetried.project.sequencePlans.find((entry) => !beforeFitStatusFailure.plans.some((old) => old.id === entry.id));
  assert.ok(fitStatusNewPlan); assert.equal(fitStatusNewPlan.fitStatus, 'balanced');
  assert.equal(fitStatusNewPlan.planningMode, 'semantic-segments'); assert.equal(fitStatusNewPlan.reviewConfirmedFingerprint, undefined);
  assert.equal(fitStatusNewPlan.masterStoryboardId, undefined);
  assert.equal(fitStatusNewPlan.segmentDurationSec, 15); assert.equal(fitStatusNewPlan.totalDurationSec, 45);
  assert.deepEqual(requests.slice(fitStatusRetryStart).map((request) => request.kind), ['semantic-plan'], 'explicit retry with " Balanced " succeeds in one call, without extra repair or AI review');
  assert.deepEqual(requests[fitStatusRetryStart].data, fitStatusRequests[0].data, 'retry succeeds without modifying the story, director settings, or duration');
  for (const oldPlan of beforeFitStatusFailure.plans) assert.deepEqual(fitStatusRetried.project.sequencePlans.find((entry) => entry.id === oldPlan.id), oldPlan);
  assert.deepEqual(fitStatusRetried.project.storyboards, beforeFitStatusFailure.boards); assertNoUnexpectedGeneration(fitStatusRetried, originals);
  assert.equal(await page.locator('.sequence-planning-error').count(), 0, 'successful retry clears the current planning error');
  assert.equal(await page.locator('.runtime-error-log-count').textContent(), String(fitStatusErrors.length), 'successful retry preserves the diagnostic log without adding a new failure');
  await capture('13-fit-status-retry-without-changing-duration');
  steps.push('four invalid fitStatus replies exhaust the existing initial-plus-three budget; planning/log summaries name $.fitStatus and all four allowed values without the unknown-error fallback; old plans/H3/sparse references remain exact and the retry button recovers');
  steps.push('direct retry with " Balanced " succeeds in one semantic request using the unchanged duration and planning input, appends an independent unconfirmed plan, and requires no extra AI review');
  const callsBeforeLegacy = requests.length;
  await page.getByRole('button', { name: /^项目库（/u }).click();
  await page.locator('.project-library-select').filter({ hasText: '旧总稿兼容项目' }).click();
  await enterDirector();
  await page.locator('[role="tab"][aria-controls="sequence-plan-panel"]').click();
  await page.locator('#sequence-plan-panel[data-planning-mode="legacy-master"]').waitFor();
  const masterTab = page.getByRole('tab', { name: /总提示词/u });
  if (await masterTab.count()) await masterTab.click();
  assert.equal(await page.locator('#sequence-master-prompt').inputValue(), 'HISTORICAL_MASTER_DO_NOT_OVERWRITE');
  assert.equal(await page.getByTestId('semantic-sequence-from-legacy').count(), 1);
  assert.deepEqual(preservedLegacyProject(await readState()), originals.legacyProject);
  assert.equal(requests.length, callsBeforeLegacy, 'viewing a legacy master must not generate a new semantic plan or prompt');
  await capture('07-legacy-master-still-readable');
  steps.push('legacy project remains readable with its unchanged master, saved H3 and opt-in semantic entry, without a model request');
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, inventory: QA_INVENTORY, isolatedBrowserStorage: true, productionDataRead: false, externalRequests: 0, paidApiCalls: 0,
    comparisonNotes: ['Only inactive project top-level updatedAt is excluded because existing startup workbench recovery refreshes it on a no-op. Every plan, board, revision, asset, task and nested timestamp remains strictly compared.'],
    requests, steps, screenshots, layouts, cancelledRequests, errors, blockedRequests, blockedDevelopmentSockets }, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.join(output, 'report.json'), steps, screenshots }));
};

try { await Promise.race([run(), harness.qaFailure]); }
catch (error) {
  if (page && !page.isClosed()) { await capture('failure').catch(() => {}); fs.writeFileSync(path.join(output, 'failure.aria.txt'), await page.locator('body').ariaSnapshot().catch(() => '')); }
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error?.stack, requests, errors, blockedRequests, blockedDevelopmentSockets }, null, 2)); throw error;
} finally {
  heldSemanticRequest?.release();
  await context?.close(); await browser?.close(); harness.markElectronStopping(); await harness.stopAll();
  fs.writeFileSync(path.join(output, 'vite-process.log'), harness.readElectronLog());
}
