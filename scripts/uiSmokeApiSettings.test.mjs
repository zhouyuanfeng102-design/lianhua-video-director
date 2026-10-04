import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const uiSmokeSource = fs.readFileSync(path.join(root, 'scripts', 'uiSmoke.mjs'), 'utf8');
const webQaSource = fs.readFileSync(path.join(root, 'scripts', 'webQa.mjs'), 'utf8');

test('UI smoke verifies the image panel is active before clicking any settings tab', () => {
  const apiCheckStart = uiSmokeSource.indexOf("if (navigation === 'API 设置')");
  const panelLoop = uiSmokeSource.indexOf('for (const panelId of panelIds)', apiCheckStart);
  const firstPanelClick = uiSmokeSource.indexOf('button.click()', panelLoop);
  const defaultPanelCheck = uiSmokeSource.indexOf('const defaultImagePanelActive', apiCheckStart);

  assert.ok(apiCheckStart >= 0, 'the API settings check must exist');
  assert.ok(panelLoop > apiCheckStart, 'the five-panel loop must exist');
  assert.ok(firstPanelClick > panelLoop, 'the panel loop must exercise its tabs');
  assert.ok(
    defaultPanelCheck > apiCheckStart && defaultPanelCheck < panelLoop,
    'the default image-panel state must be captured before the first settings-tab click',
  );
  assert.match(
    uiSmokeSource,
    /const defaultImagePanelActive\s*=\s*stage\?\.getAttribute\('data-active-panel'\)\s*===\s*'image'[\s\S]*?defaultImageTabSelected/u,
  );
  assert.match(
    uiSmokeSource,
    /!apiSettings\.defaultImagePanelActive\s*\|\|\s*!apiSettings\.defaultImageTabSelected/u,
    'a bad initial active panel must fail the smoke instead of only appearing in the report',
  );
});

test('UI smoke verifies each required image API label and its real control are visible in the viewport', () => {
  for (const [label, selector] of [
    ['启用图像生成接口', 'input[type="checkbox"]'],
    ['后端', 'select'],
    ['模型 / 工作流', 'input'],
    ['API 地址', 'input'],
    ['API 密钥', 'input'],
  ]) {
    assert.ok(uiSmokeSource.includes(`label: '${label}'`), `missing real-field check for ${label}`);
    assert.ok(uiSmokeSource.includes(`controlSelector: '${selector}'`), `missing control selector for ${label}`);
  }

  assert.match(uiSmokeSource, /labelElement\?\.closest\('\.field, \.check-row'\)/u);
  assert.match(uiSmokeSource, /fieldContainer\?\.querySelector\(requirement\.controlSelector\)/u);
  assert.match(uiSmokeSource, /isElementFullyVisible\(labelElement,\s*stageRect\)/u);
  assert.match(uiSmokeSource, /isElementFullyVisible\(controlElement,\s*stageRect\)/u);
  assert.match(
    uiSmokeSource,
    /imageFieldResults\.every\(\(field\)\s*=>\s*field\.labelVisible\s*&&\s*field\.controlVisible\)/u,
  );
  assert.doesNotMatch(
    uiSmokeSource,
    /imageFieldsVisible\s*=\s*\[[\s\S]*?panelText\.includes/u,
    'textContent alone cannot prove that an image API label/control is visible',
  );
});

test('UI smoke checks both axes, descendant clipping, and zero workspace scroll for every settings panel', () => {
  assert.match(
    uiSmokeSource,
    /const panelIds\s*=\s*\['image',\s*'text',\s*'vision',\s*'video',\s*'credentials'\]/u,
  );

  for (const metric of [
    'documentOverflowX',
    'documentOverflowY',
    'workspaceOverflowX',
    'workspaceOverflowY',
    'stageOverflowX',
    'stageOverflowY',
    'contentOverflowX',
    'contentOverflowY',
    'internalOverflowX',
    'internalOverflowY',
    'descendantClippedX',
    'descendantClippedY',
    'workspaceScrollTop',
  ]) {
    assert.match(
      uiSmokeSource,
      new RegExp(`\\|\\| panel\\.${metric}(?:\\s|\\)|\\n)`),
      `${metric} must be a failing condition for each panel`,
    );
  }

  assert.match(uiSmokeSource, /rect\.left\s*<\s*stageRect\.left/u);
  assert.match(uiSmokeSource, /rect\.right\s*>\s*stageRect\.right/u);
  assert.match(uiSmokeSource, /rect\.top\s*<\s*stageRect\.top/u);
  assert.match(uiSmokeSource, /rect\.bottom\s*>\s*stageRect\.bottom/u);
  assert.match(uiSmokeSource, /rect\.right\s*>\s*window\.innerWidth/u);
  assert.match(uiSmokeSource, /rect\.bottom\s*>\s*window\.innerHeight/u);
});

test('UI smoke requires the collapsed video form to fit without scrolling', () => {
  assert.match(
    uiSmokeSource,
    /const expectedLabels\s*=\s*\['图片 API',\s*'文本 API',\s*'视觉 API',\s*'视频生成',\s*'密码本'\]/u,
  );
  assert.match(
    uiSmokeSource,
    /panelId\s*===\s*'video'[\s\S]{0,220}querySelector\(':scope > \.video-generation-settings'\)/u,
    'the direct video-generation settings form must be measured',
  );
  assert.match(uiSmokeSource, /\['hidden',\s*'clip'\]\.includes\(getComputedStyle\(videoSettings\)\.overflowY\)/u);
  assert.match(uiSmokeSource, /videoSettings\.scrollHeight\s*<=\s*videoSettings\.clientHeight\s*\+\s*1/u);
  assert.match(uiSmokeSource, /videoSettings\.scrollWidth\s*<=\s*videoSettings\.clientWidth\s*\+\s*1/u);
  assert.match(uiSmokeSource, /videoSettings\.scrollTop\s*===\s*0/u);
  assert.match(uiSmokeSource, /querySelectorAll\('details'\)[\s\S]{0,100}every\(\(details\)\s*=>\s*!details\.open\)/u);
  assert.doesNotMatch(uiSmokeSource, /allowedVerticalScroller/u);
  for (const check of [
    'videoSettingsOverflowContained',
    'videoSettingsInsideStage',
    'videoSettingsFitsWithoutScroll',
    'videoDetailsCollapsed',
    'videoCommonCardsVisible',
    'videoAdvancedEditorsDeferred',
  ]) {
    assert.match(
      uiSmokeSource,
      new RegExp(`\\|\\| !panel\\.${check}(?:\\s|\\)|\\n)`),
      `${check} must remain a failing condition`,
    );
  }
});

test('video settings smoke measures the redesigned cards and verifies heavy editors stay unmounted', () => {
  assert.match(uiSmokeSource, /querySelectorAll\(':scope > \.vgs-main > \.vgs-card'\)/u);
  assert.match(uiSmokeSource, /videoCommonCards\.length\s*>=\s*2/u);
  assert.match(uiSmokeSource, /videoCommonCards\.every\(\(card\)\s*=>\s*isElementFullyVisible\(card,\s*stageRect\)\)/u);
  assert.match(uiSmokeSource, /!videoSettings\.querySelector\('textarea, \.vgs-api-dialog, \.vwm-dialog'\)/u);
  assert.match(uiSmokeSource, /!document\.querySelector\('\.vwm-dialog'\)/u);
});

test('web QA runs the UI smoke at all three supported single-screen viewports', () => {
  for (const [width, height] of [
    ['1120', '720'],
    ['1280', '720'],
    ['1280', '800'],
  ]) {
    assert.match(
      webQaSource,
      new RegExp(
        `runScript\\('scripts/uiSmoke\\.mjs',[\\s\\S]{0,400}?VIEWPORT_HEIGHT: '${height}',[\\s\\S]{0,100}?VIEWPORT_WIDTH: '${width}'`,
      ),
      `missing ${width}x${height} UI smoke viewport`,
    );
  }
});

test('web QA repeats the affected desktop viewport at Windows 225 percent DPI', () => {
  assert.match(
    uiSmokeSource,
    /const deviceScaleFactor = Number\(process\.env\.DEVICE_SCALE_FACTOR \|\| 1\)/u,
  );
  assert.match(
    uiSmokeSource,
    /Emulation\.setDeviceMetricsOverride[\s\S]{0,160}deviceScaleFactor/u,
  );
  assert.match(uiSmokeSource, /devicePixelRatio/u);
  assert.match(
    webQaSource,
    /QA_OUTPUT:\s*path\.join\(root, '\.qa-ui-high-dpi-final'\)[\s\S]{0,220}VIEWPORT_HEIGHT:\s*'800'[\s\S]{0,100}VIEWPORT_WIDTH:\s*'1280'[\s\S]{0,100}DEVICE_SCALE_FACTOR:\s*'2\.25'/u,
  );
});

test('UI smoke verifies the image-workbench rule and preset selects without clipping or overlap', () => {
  assert.match(uiSmokeSource, /document\.querySelector\('\.image-prompt-selection-grid'\)/u);
  assert.match(uiSmokeSource, /findPromptSelectionSelect\('生图规则集'\)/u);
  assert.match(uiSmokeSource, /findPromptSelectionSelect\('分类预设'\)/u);
  assert.match(uiSmokeSource, /element\?\.tagName\s*===\s*'SELECT'/u);
  assert.match(uiSmokeSource, /optionValues:\s*\[\.\.\.element\.options\]/u);
  assert.match(uiSmokeSource, /option\.value\.trim\(\)\s*!==\s*''/u);
  assert.match(uiSmokeSource, /option\.textContent\?\.trim\(\)/u);
  assert.match(uiSmokeSource, /operable:\s*!element\.disabled/u);
  assert.match(uiSmokeSource, /document\.elementFromPoint/u);
  assert.match(uiSmokeSource, /element\.tabIndex\s*>=\s*0/u);
  assert.match(uiSmokeSource, /selectionGridVisible/u);
  assert.match(uiSmokeSource, /selectionGridInsideContainer/u);
  assert.match(uiSmokeSource, /selectionGridHorizontalOverflow/u);
  assert.match(uiSmokeSource, /selectionGridVerticalOverflow/u);
  assert.match(uiSmokeSource, /followingControls\.filter/u);
  assert.match(uiSmokeSource, /followingControlsStartAfterGrid/u);
  assert.match(uiSmokeSource, /selectionGridOverlapsFollowingControl/u);
  assert.match(uiSmokeSource, /const contentHeight = rect\.height[\s\S]{0,400}style\.paddingTop[\s\S]{0,400}style\.borderBottomWidth/u);
  assert.match(uiSmokeSource, /textFitsContentBox:\s*contentHeight\s*\+\s*0\.5\s*>=\s*lineHeight/u);

  for (const failingCondition of [
    '!imageWorkbench.ruleSelect.found',
    '!imageWorkbench.ruleSelect.visible',
    '!imageWorkbench.ruleSelect.operable',
    '!imageWorkbench.ruleSelect.hasNonEmptyOption',
    '!imageWorkbench.ruleSelect.textFitsContentBox',
    '!imageWorkbench.presetSelect.found',
    '!imageWorkbench.presetSelect.visible',
    '!imageWorkbench.presetSelect.operable',
    '!imageWorkbench.presetSelect.hasNonEmptyOption',
    '!imageWorkbench.presetSelect.textFitsContentBox',
    '!imageWorkbench.selectionGridVisible',
    '!imageWorkbench.followingControlsStartAfterGrid',
    '!imageWorkbench.selectionGridInsideContainer',
    'imageWorkbench.selectionGridHorizontalOverflow',
    'imageWorkbench.selectionGridVerticalOverflow',
    'imageWorkbench.selectionGridOverlapsFollowingControl',
  ]) {
    assert.ok(
      uiSmokeSource.includes(failingCondition),
      `${failingCondition} must fail the image-workbench UI smoke`,
    );
  }
});

test('image settings sections are checked and the removed duplicate result area stays absent', () => {
  assert.match(uiSmokeSource, /actionBar\?\.querySelector\(':scope > \.image-requirement-field \.image-autofill-requirement'\)/u);
  assert.match(uiSmokeSource, /selectionGrid\?\.closest\('\.image-setting-rules'\)/u);
  assert.match(uiSmokeSource, /followingCandidate = rulesSection\?\.nextElementSibling/u);
  assert.match(uiSmokeSource, /document\.querySelectorAll\('\.image-output-refined \.image-generation-controls > \.image-setting-section'\)/u);
  assert.match(uiSmokeSource, /settingSectionRects\.slice\(index \+ 1\)\.some\(\(other\) => overlaps\(rect, other\)\)/u);
  assert.match(uiSmokeSource, /duplicateResultsAbsent = !document\.querySelector\('\.image-results-container, \.image-generation-output-tabs, \.image-batch-result-strip'\)/u);
  assert.match(uiSmokeSource, /barContentRight[\s\S]*?barStyle\.paddingRight[\s\S]*?barStyle\.borderRightWidth/u);
  assert.match(uiSmokeSource, /Math\.abs\(actionsRect\.right - barContentRight\) <= 2/u);
  assert.match(uiSmokeSource, /document\.querySelector\('\.image-output-head \.image-rule-manager-button'\)/u);
  assert.match(uiSmokeSource, /document\.querySelector\('\.image-setting-references details\.image-panel-capability'\)/u);
  assert.match(uiSmokeSource, /moreSettingsSummary\?\.click\(\);[\s\S]*?extraSettingsPanel\?\.querySelector\('\.image-negative-field input'\)[\s\S]*?moreSettingsSummary\?\.click\(\);/u);
  assert.match(uiSmokeSource, /document\.elementFromPoint\(negativeRect\.left \+ negativeRect\.width \/ 2, negativeRect\.top \+ negativeRect\.height \/ 2\) === negativeInput/u);
  for (const failingCondition of [
    '!imageWorkbench.settingSectionsFound',
    '!imageWorkbench.settingSectionsVisible',
    'imageWorkbench.settingSectionsOverlap',
    'imageWorkbench.settingSectionsOverflow',
    '!imageWorkbench.duplicateResultsAbsent',
    '!imageWorkbench.generationFieldsPreserved',
    '!imageWorkbench.moreSettingsDefaultCollapsed',
    '!imageWorkbench.moreSettingsExpandable',
    '!imageWorkbench.moreSettingsControlsVisible',
    '!imageWorkbench.moreSettingsClosedAfterCheck',
  ]) {
    assert.ok(uiSmokeSource.includes(failingCondition), `${failingCondition} must fail the image settings UI smoke`);
  }
});
