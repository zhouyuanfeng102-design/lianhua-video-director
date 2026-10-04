import assert from 'node:assert/strict';

const storageKey = 'lianhua_video_director_state_v22';

// This runs only in the isolated UI-QA browser; no real project is imported.
const installFixture = ({ raw, scale }) => {
  const state = JSON.parse(raw);
  const longText = '旅人把竹篮放在木桥边，扶住栏杆站稳，转身确认身后的同伴已经跟上，再向桥中央走去。桥下水面映着岸边柳树，风吹过时树影轻轻晃动，同伴保持在画面右后方，没有遮挡人物的手部动作。';
  const board = (count) => {
    const shots = Array.from({ length: count }, (_, offset) => ({
      id: `qa-picker-${count}-${offset}`, index: count === 20 && offset === 19 ? 100 : offset + 1,
      startSec: offset * 3, endSec: (offset + 1) * 3, purpose: '排版回归',
      subject: '河岸旅人', action: offset === 3 ? `无空格文本 ${'StoryboardContinuityReference'.repeat(12)} ${longText}` : longText,
      camera: '固定中景', lighting: '柔和日光', sound: '水声', result: '旅人到达桥边',
      transition: '连续', referenceAssetIds: [], prompt: '河岸旅人行走', locked: false,
    }));
    return {
      id: `qa-picker-board-${count}`, sceneId: state.project.scenes[0]?.id || 'qa-picker-scene',
      sourceStoryTitle: `QA ${count} 镜长描述`, sourceStoryContent: '旅人沿河岸行走。',
      workflow: 'drama', inputMode: 'text', durationSec: count * 3, durationPreset: 'custom',
      shotMode: 'exact', shotCount: count, pace: 'standard', aspectRatio: '16:9', resolution: '1080p',
      audioMode: 'none', stylePresetId: state.stylePresets[0].id, ruleSetId: state.ruleSets[0].id,
      converterPresetId: state.converterPresets[0].id, globalLock: '河岸旅人', shots,
      finalPrompt: shots.map((shot) => `【${shot.startSec}s-${shot.endSec}s】 主体：河岸旅人；空间：木桥边；光影：柔和日光；镜头：固定中景；台词：无；音效：水声`).join('\n'),
      createdAt: count, updatedAt: count,
    };
  };
  state.project = { ...state.project, name: '分镜列表排版 QA', characters: [], locations: [], props: [], assets: [], generationTasks: [], sequencePlans: [], storyboards: [board(5), board(20)] };
  state.projects = (state.projects || []).map((project) => project.id === state.project.id ? state.project : project);
  state.settings.uiFontScalePercent = scale;
  for (const key of ['textApi', 'imageApi', 'visionApi', 'videoApi']) {
    if (state.settings[key]) state.settings[key] = { ...state.settings[key], enabled: false, apiKey: '' };
  }
  localStorage.setItem('lianhua_video_director_state_v22', JSON.stringify(state));
};

const settle = async () => {
  await Promise.race([
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise((resolve) => setTimeout(resolve, 100)),
  ]);
};

const readLayout = () => {
  const list = document.querySelector('.storyboard-shot-picker-list');
  const picker = document.querySelector('.storyboard-shot-picker');
  if (!list || !picker) return { missing: true };
  const bounds = (element) => element.getBoundingClientRect();
  const listRect = bounds(list);
  const rows = [...list.querySelectorAll('.storyboard-shot-picker-item')];
  const rowRects = rows.map(bounds);
  const buttons = [...picker.querySelectorAll('button')];
  const visibleHit = (element) => {
    if (!element) return false;
    const box = bounds(element);
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth + 1
      && box.top >= 0 && box.bottom <= innerHeight + 1 && (hit === element || element.contains(hit));
  };
  const controls = ['全选', '清空', '生成选中分镜图片'].map((label) => buttons.find((button) => button.textContent.trim().startsWith(label)));
  const workspace = document.querySelector('.workspace');
  const details = rows.map((row) => {
    const check = row.querySelector('input');
    const index = row.querySelector('.storyboard-shot-index');
    const description = row.querySelector('.storyboard-shot-description');
    if (!check || !index || !description) return { missing: true };
    const cb = bounds(check), ib = bounds(index), db = bounds(description), rb = bounds(row);
    return {
      columnsOrdered: cb.right <= ib.left + 1 && ib.right <= db.left + 1,
      insideRow: db.right <= rb.right + 1 && db.bottom <= rb.bottom + 1,
      indexVisible: index.scrollWidth <= index.clientWidth + 1,
      textUnclipped: description.scrollWidth <= description.clientWidth + 1 && description.scrollHeight <= description.clientHeight + 1,
      descriptionLeft: db.left,
    };
  });
  const count = rows.filter((row) => row.querySelector('input')?.checked).length;
  const generate = controls[2];
  return {
    missing: false, rowCount: rows.length, count,
    columnsAligned: details.every((detail) => Math.abs(detail.descriptionLeft - details[0].descriptionLeft) <= 1),
    rowsSeparate: rowRects.every((box, index) => !index || rowRects[index - 1].bottom <= box.top + 1),
    detailsValid: details.every((detail) => !detail.missing && detail.columnsOrdered && detail.insideRow && detail.indexVisible && detail.textUnclipped),
    controlsVisible: controls.every(visibleHit),
    controlsOutsideList: controls.every((control) => control && !list.contains(control)),
    listInsideViewport: listRect.top >= 0 && listRect.bottom <= innerHeight + 1 && listRect.height > 60,
    scrollable: list.scrollHeight > list.clientHeight + 1,
    horizontalOverflow: list.scrollWidth > list.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1 || workspace.scrollWidth > workspace.clientWidth + 1,
    workspaceOverflowY: workspace.scrollHeight > workspace.clientHeight + 1,
    selectedStatus: picker.querySelector('[role="status"]')?.textContent.replace(/\s+/gu, ' ').trim(),
    generateLabel: generate?.textContent.trim(), generateDisabled: generate?.disabled,
    fontScale: document.querySelector('.app-shell')?.getAttribute('data-ui-font-scale'),
  };
};

const assertLayout = (layout, count, scale) => {
  assert.equal(layout.missing, false, 'storyboard selector must render');
  assert.equal(layout.rowCount, count);
  assert.equal(layout.fontScale, String(scale));
  for (const key of ['columnsAligned', 'rowsSeparate', 'detailsValid', 'controlsVisible', 'controlsOutsideList', 'listInsideViewport']) {
    assert.equal(layout[key], true, `${key}: ${JSON.stringify(layout)}`);
  }
  assert.equal(layout.horizontalOverflow, false);
  assert.equal(layout.workspaceOverflowY, false, 'only the shot list should scroll');
  if (count === 20) assert.equal(layout.scrollable, true);
};

/** Exercise the actual renderer, including a mutation that reproduces the old
 * inline-label defect so this test cannot pass without a working row layout. */
export const runStoryboardShotPickerRegression = async ({ evaluate, command, reload, capture }) => {
  const raw = await evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`);
  assert.ok(raw, 'isolated application state must already exist');
  const run = (fn, value) => evaluate(`(${fn.toString()})(${value === undefined ? '' : JSON.stringify(value)})`);
  const flush = () => run(settle);
  const reports = [];
  try {
    for (const scale of [100, 130]) {
      await run(installFixture, { raw, scale });
      await reload({ expectedFontScale: scale, label: `storyboard picker QA ${scale}%` });
      await evaluate(`([...document.querySelectorAll('.nav button')].find((button) => button.textContent.includes('图像工作台'))).click()`);
      await flush();
      await evaluate(`([...document.querySelectorAll('.image-asset-kind-tabs button')].find((button) => button.textContent.trim() === '分镜图')).click()`);
      await flush();
      for (const count of [5, 20]) {
        await run((count) => {
          const select = document.querySelector('select[aria-label="选择分镜"]');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, `qa-picker-board-${count}`);
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }, count);
        await flush();
        const layout = await run(readLayout);
        assertLayout(layout, count, scale);
        assert.equal(layout.count, 0);
        assert.equal(layout.generateDisabled, true);
        const initialFileName = await capture(`storyboard-picker-${count}-font${scale}-top`);
        if (scale === 100 && count === 5) {
          await evaluate(`(() => { const style = document.createElement('style'); style.id = 'qa-inline-regression'; style.textContent = '.storyboard-shot-picker-list{display:block!important}.storyboard-shot-picker-item,.storyboard-shot-index,.storyboard-shot-description{display:inline!important}'; document.head.append(style); })()`);
          await flush();
          try {
            const broken = await run(readLayout);
            assert.throws(() => assertLayout(broken, count, scale), 'the original inline-label layout must fail this regression');
          } finally {
            await evaluate(`document.getElementById('qa-inline-regression')?.remove()`);
            await flush();
          }
        }
        const selectionCounts = [0];
        for (const action of ['all', 'one', 'clear']) {
          await run((action) => {
            const picker = document.querySelector('.storyboard-shot-picker');
            if (action === 'one') picker.querySelector('input[type="checkbox"]').click();
            else [...picker.querySelectorAll('button')].find((button) => button.textContent.trim() === (action === 'all' ? '全选' : '清空')).click();
          }, action);
          await flush();
          const selected = await run(readLayout);
          selectionCounts.push(selected.count);
          assert.equal(selected.generateDisabled, selected.count === 0);
          assert.ok(selected.generateLabel.includes(`（${selected.count} 张）`));
          assert.equal(selected.selectedStatus, `已选 ${selected.count} / ${count} 镜`);
        }
        assert.deepEqual(selectionCounts, count === 5 ? [0, 5, 4, 0] : [0, 20, 19, 0]);
        await evaluate(`(() => { const inputs = [...document.querySelectorAll('.storyboard-shot-picker-list input')]; inputs.at(-1).focus(); })()`);
        await flush();
        for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
        await flush();
        const keyboard = await evaluate(`(() => { const list = document.querySelector('.storyboard-shot-picker-list'); const input = list.querySelector('label:last-child input'); const box = input.getBoundingClientRect(), lb = list.getBoundingClientRect(); return { checked: input.checked, focused: document.activeElement === input, visible: box.top >= lb.top && box.bottom <= lb.bottom, focusVisible: input.matches(':focus-visible'), scrollTop: list.scrollTop }; })()`);
        assert.equal(keyboard.checked, true, 'Space must toggle the last shot');
        assert.equal(keyboard.focused, true, 'selection rerenders must preserve focus');
        assert.equal(keyboard.visible, true);
        assert.equal(keyboard.focusVisible, true);
        if (count === 20) assert.ok(keyboard.scrollTop > 0);
        for (const modifiers of [8, 0]) {
          for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', modifiers, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
          await flush();
        }
        keyboard.tabReturned = await evaluate(`document.activeElement === document.querySelector('.storyboard-shot-picker-list label:last-child input')`);
        assert.equal(keyboard.tabReturned, true, 'Shift+Tab and Tab must return focus to the final shot');
        assertLayout(await run(readLayout), count, scale);
        const fileName = await capture(`storyboard-picker-${count}-font${scale}`);
        reports.push({ scale, count, layout, selectionCounts, keyboard, initialFileName, fileName, inlineRegressionCaught: scale === 100 && count === 5 });
      }
    }
    return reports;
  } finally {
    await evaluate(`localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(raw)})`);
    await reload({ label: 'restore isolated state after storyboard picker QA' });
  }
};
