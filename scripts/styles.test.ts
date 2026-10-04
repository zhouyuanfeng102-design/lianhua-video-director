import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const videoSettingsSource = readFileSync(new URL('../src/components/VideoGenerationSettings.tsx', import.meta.url), 'utf8');
const videoSettingsCss = readFileSync(new URL('../src/videoGenerationSettings.css', import.meta.url), 'utf8');
const videoWorkflowCss = readFileSync(new URL('../src/videoWorkflowManager.css', import.meta.url), 'utf8');
const videoWorkflowSource = readFileSync(new URL('../src/components/VideoWorkflowManager.tsx', import.meta.url), 'utf8');
const videoDirectorCss = readFileSync(new URL('../src/videoDirector.css', import.meta.url), 'utf8');
const videoOutputCss = readFileSync(new URL('../src/videoOutputParameters.css', import.meta.url), 'utf8');
const imageWorkbenchPanelCss = readFileSync(new URL('../src/imageWorkbenchPanel.css', import.meta.url), 'utf8');

const sourceBetween = (startToken: string, endToken: string): string => {
  const start = appSource.indexOf(startToken);
  const end = appSource.indexOf(endToken, start);
  assert.ok(start >= 0 && end > start, `source block must exist between ${startToken} and ${endToken}`);
  return appSource.slice(start, end);
};

const parseCssAlpha = (value: string): number => {
  const normalized = value.trim();
  return normalized.endsWith('%')
    ? Number(normalized.slice(0, -1)) / 100
    : Number(normalized);
};

const isTopLevelRule = (sourceCss: string, ruleIndex: number): boolean => {
  let depth = 0;
  let quote = '';
  let inComment = false;
  for (let index = 0; index < ruleIndex; index += 1) {
    const character = sourceCss[index];
    const nextCharacter = sourceCss[index + 1];
    if (inComment) {
      if (character === '*' && nextCharacter === '/') {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      inComment = true;
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth === 0;
};

const topLevelRuleMatches = (sourceCss: string, selectorPattern: string): RegExpMatchArray[] => [
  ...sourceCss.matchAll(new RegExp(`${selectorPattern}\\s*\\{(?<body>[^}]*)\\}`, 'gsu')),
].filter((match) => isTopLevelRule(sourceCss, match.index));

const ruleBody = (selector: string, description: string, sourceCss = css): string => {
  const selectorPattern = selector
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/\s+/gu, '\\s+');
  const match = topLevelRuleMatches(sourceCss, selectorPattern).at(0);
  assert.ok(match?.groups?.body, `${description} CSS rule must exist`);
  return match.groups.body;
};

const lastRuleBody = (selector: string, description: string, sourceCss = css): string => {
  const selectorPattern = selector
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/\s+/gu, '\\s+');
  const matches = topLevelRuleMatches(sourceCss, selectorPattern);
  const body = matches.at(-1)?.groups?.body;
  assert.ok(body, `${description} CSS rule must exist`);
  return body;
};

const cssProperty = (
  selector: string,
  property: string,
  description: string,
  sourceCss = css,
  exactSelector = false,
): string => {
  const propertyPattern = property.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const selectorPattern = selector
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/\s+/gu, '\\s+');
  const propertyMatcher = new RegExp(
    `(?:^|;)\\s*${propertyPattern}\\s*:\\s*(?<value>[^;]+)`,
    'su',
  );
  const matchingRules = topLevelRuleMatches(
    sourceCss,
    exactSelector ? `(?:^|[\\r\\n])\\s*${selectorPattern}` : selectorPattern,
  );
  assert.ok(matchingRules.length > 0, `${description} CSS rule must exist`);
  const match = [...matchingRules]
    .reverse()
    .map((rule) => rule.groups?.body.match(propertyMatcher))
    .find((candidate) => candidate?.groups?.value);
  assert.ok(match?.groups?.value, `${description} must declare ${property}`);
  return match.groups.value.trim().replace(/\s+/gu, ' ');
};

assert.equal(
  cssProperty('.director-result-actions', 'flex-wrap', 'director result actions'),
  'nowrap',
  'result actions must keep one row and fit their bounded column at narrow widths',
);
assert.equal(cssProperty('.director-side-panel .director-result-copy', 'height', 'preferred director text height'), '360px', 'normal windows target a 360px prompt reading area');
assert.equal(cssProperty('.director-side-panel .director-result-copy', 'min-height', 'usable director text minimum'), '160px', 'short windows retain at least 160px of independently scrollable prompt text');
assert.equal(cssProperty('.director-side-panel .director-result-copy', 'max-height', 'bounded director text maximum'), '360px', 'larger windows must not expand the prompt beyond its 360px target');
assert.equal(cssProperty('.director-side-panel .director-result-copy', 'flex', 'remaining-space director text'), '1 1 360px', 'the text yields height to headings and actions instead of forcing the whole panel to scroll');
assert.equal(cssProperty('.director-side-panel .director-result-copy', 'overflow', 'independent director text scroll'), 'auto');
assert.equal(cssProperty('.director-side-panel', 'overflow-y', 'stationary director result column'), 'hidden', 'the large result column must never become a vertical scroller');
assert.equal(cssProperty('.director-result-pane:not(.empty-result-pane)', 'flex', 'bounded director result pane'), '1 1 auto', 'the result pane must occupy and shrink within the remaining column height');
assert.equal(cssProperty('.director-result-pane:not(.empty-result-pane)', 'min-height', 'shrinkable director result pane'), '0');
assert.equal(cssProperty('.director-result-pane > *', 'flex-shrink', 'stable director result rows'), '0', 'supporting rows keep their natural height while the explicitly shrinkable text yields space');
assert.match(appSource, /className="prompt-copy director-result-copy h3-prompt-copy" role="region" aria-label="视频提示词正文" tabIndex=\{0\}/u, 'keyboard users can focus and scroll the full H3 prompt');
assert.match(cssProperty('.director-result-pane .director-result-actions', 'grid-template-columns', 'single-row result actions'), /^minmax\(0, 1\.4fr\) minmax\(0, 1\.15fr\) minmax\(0, 1\.4fr\) minmax\(0, \.7fr\)$/u, 'all three result buttons and the image-count control share one row');
assert.equal(cssProperty('.director-generate-bar .sequence-generation-actions', 'flex-wrap', 'single-row generation actions'), 'nowrap');
assert.equal(cssProperty('.director-view .director-control-card', 'grid-template-columns', 'shrinkable director parameter column'), 'minmax(0, 1fr)', 'an implicit auto column must not inherit the unwrapped footer min-content width and clip every parameter section');
assert.equal(cssProperty('.director-view .director-control-card > *', 'min-width', 'bounded director parameter children'), '0');
assert.equal(cssProperty('.director-view .director-control-card > *', 'max-width', 'bounded director parameter children'), '100%');
assert.equal(cssProperty('.director-generate-bar', 'grid-template-columns', 'bounded director action column'), 'minmax(0, 1fr)', 'status and actions each use the available column width before and after a result exists');
assert.equal(cssProperty('.director-view .director-control-card', 'grid-template-rows', 'director footer reserved height'), 'auto minmax(0, 1fr) auto', 'the footer must reserve its natural status-plus-actions height');
assert.equal(cssProperty('.director-generate-bar .btn', 'flex', 'shrinkable generation buttons'), '0 1 auto');
assert.match(cssProperty('.director-generate-bar .btn', 'font-size', 'responsive generation buttons'), /cqi/u, 'empty, failed and completed segments must all fit footer labels to the left column width');
assert.doesNotMatch(css, /\.director-view:has\(\.director-result-copy\) \.sequence-generation-actions\s*\{/u, 'generation action sizing must not depend on whether a result prompt exists');
assert.doesNotMatch(ruleBody('.director-generate-bar .sequence-generation-actions', 'non-scrolling generation actions'), /overflow-x:\s*(?:auto|scroll)/u, 'the bottom buttons must fit in one row without an extra horizontal scroller');
assert.equal(cssProperty('.director-result-actions > .btn', 'white-space', 'single-line result action labels'), 'nowrap');
assert.match(cssProperty('.director-result-actions > .btn', 'font-size', 'responsive result action labels'), /cqi/u, 'toolbar labels fit the actual result-column width');
assert.equal(cssProperty('.director-view:has(.director-result-copy) .director-all-sections', 'grid-template-rows', 'complete compact parameter sections'), 'repeat(4, max-content)', 'all parameter sections, hints and AI timing notes retain natural rows inside the bounded setup body');
assert.equal(cssProperty('.director-view:has(.director-result-copy) .director-setup-body', 'overflow-x', 'stationary director setup width'), 'hidden');
assert.equal(cssProperty('.director-view:has(.director-result-copy) .director-setup-body', 'overflow-y', 'stationary director setup column'), 'hidden', 'the large left parameter body cannot become another scroll container');
assert.equal(cssProperty('.director-view:has(.director-result-copy) .director-setup-section.tone-motion', 'min-height', 'minimum compact motion section'), '120px', 'motion options and extra requirements retain a usable compact section without displacing the footer');
assert.equal(cssProperty('.director-result-actions', 'flex', 'fixed director result actions'), '0 0 auto', 'result actions must remain a full-height footer while only prompt text scrolls');
assert.equal(cssProperty('.director-reference-head .director-result-bridge', 'flex', 'shrinkable video-director bridge'), '0 1 auto', 'the reference-header bridge yields width within the single-row header');
assert.match(
  sourceBetween('<div className="row-between director-reference-head">', '<div className="segmented director-panel-tabs reference-result-tabs">'),
  /className="director-result-bridge"[\s\S]*?ctx\.openVideoDirector\([\s\S]*?>送到视频导演台<\/Button>/u,
  'the existing video-director action must remain in the visible reference header',
);
assert.equal(cssProperty('.settings-panel-stage[data-active-panel="video"]', 'display', 'video settings stack'), 'flex', 'video permission and content must not share an implicit grid track');
assert.equal(cssProperty('.settings-panel-stage[data-active-panel="video"] > .video-generation-settings', 'min-height', 'scrollable video settings'), '0', 'long settings must shrink into the remaining visible stage');
assert.equal(cssProperty('.settings-panel-stage[data-active-panel="video"] > .video-generation-settings', 'scrollbar-gutter', 'default video settings scrollbar'), 'auto', 'the collapsed one-page form must not reserve an empty scrollbar gutter');
const redesignedVideoSelector = '.settings-panel-stage[data-active-panel="video"] > .video-generation-settings.video-settings-redesign';
assert.equal(cssProperty(redesignedVideoSelector, 'display', 'height-aware video settings', videoSettingsCss), 'flex', 'common settings must reserve a stable header, body and feedback footer');
assert.equal(cssProperty(redesignedVideoSelector, 'flex-direction', 'height-aware video settings', videoSettingsCss), 'column');
assert.equal(cssProperty(redesignedVideoSelector, 'overflow', 'default video settings overflow', videoSettingsCss), 'hidden', 'common settings must remain a one-page bounded surface');
assert.notEqual(cssProperty(redesignedVideoSelector, 'padding', 'video settings card padding', videoSettingsCss), '0', 'video settings must not revert to an ungrouped bare form');
assert.match(cssProperty(redesignedVideoSelector, 'border', 'video settings card outline', videoSettingsCss), /solid/u);
assert.equal(cssProperty('.video-settings-redesign .vgs-main', 'display', 'video settings card stack', videoSettingsCss), 'grid');
assert.equal(cssProperty('.video-settings-redesign .vgs-main', 'min-height', 'video settings card stack', videoSettingsCss), '0');
assert.equal(cssProperty('.video-settings-redesign .vgs-main', 'flex', 'height-aware video settings body', videoSettingsCss), '1 1 auto', 'the body must yield space to persistent headings and actions');
assert.equal(cssProperty('.video-settings-redesign .vgs-feedback', 'flex', 'persistent video feedback', videoSettingsCss), '0 0 auto');
assert.equal(cssProperty('.video-settings-redesign .vgs-card', 'min-width', 'bounded video settings cards', videoSettingsCss), '0');
assert.equal(cssProperty('.video-settings-redesign .vgs-fields', 'grid-template-columns', 'common two-column fields', videoSettingsCss).replace(/\s+/gu, ''), 'repeat(2,minmax(0,1fr))');
assert.equal(cssProperty('.video-settings-redesign .vgs-fields-three', 'grid-template-columns', 'wide video protocol fields', videoSettingsCss).replace(/\s+/gu, ''), 'repeat(3,minmax(0,1fr))');
assert.equal(cssProperty('.video-settings-redesign .vgs-actions', 'flex-wrap', 'video settings action wrapping', videoSettingsCss), 'wrap');
assert.equal(cssProperty('.video-settings-redesign .vgs-connection-footer', 'flex-wrap', 'permission and advanced settings actions', videoSettingsCss), 'wrap');
assert.equal(cssProperty('.vgs-dialog-content', 'min-height', 'bounded advanced video editor', videoSettingsCss), '0');
assert.equal(cssProperty('.vgs-dialog-content', 'overflow', 'advanced video editor fallback', videoSettingsCss), 'auto', 'only the opened advanced editor may use a bounded local scroller');
assert.match(cssProperty('.vgs-api-dialog', 'grid-template-rows', 'advanced editor header/body/footer', videoSettingsCss), /minmax\(0,\s*1fr\)/u);
assert.equal(cssProperty('.vwm-dialog', 'overflow', 'workflow manager frame', videoWorkflowCss), 'hidden');
assert.equal(cssProperty('.vwm-tab-panel', 'min-height', 'workflow editor tab', videoWorkflowCss), '0');
assert.equal(cssProperty('.vwm-tab-panel', 'overflow', 'workflow editor tab fallback', videoWorkflowCss), 'auto');
assert.match(cssProperty('.vwm-dialog', 'grid-template-rows', 'workflow editor persistent actions', videoWorkflowCss), /minmax\(0,\s*1fr\)/u);
// Long-video batch settings must yield vertical space before the segment list.
// In a short window, expanded JSON and enlarged fonts use a local settings
// scroller; collapsing removes that scroller without hiding the list or footer.
assert.equal(cssProperty('.video-director-view [hidden]', 'display', 'director explicit hidden contract', videoDirectorCss), 'none !important', 'author flex/grid rules must never expose hidden batch settings');
assert.equal(cssProperty('.vd-batch-controls[hidden]', 'display', 'collapsed batch settings', videoDirectorCss), 'none', 'the fold must remain hidden even when the batch panel is mounted on its own');
assert.equal(cssProperty('.vd-batch-controls', 'flex', 'shrinkable batch configuration', videoDirectorCss), '0 1 auto', 'tall settings must surrender space instead of squeezing the segment list');
assert.equal(cssProperty('.vd-batch-controls', 'min-height', 'shrinkable batch configuration', videoDirectorCss), '0', 'intrinsic form height must not prevent the settings scroller from shrinking');
assert.equal(cssProperty('.vd-batch-controls', 'overflow-y', 'local batch settings scroll', videoDirectorCss), 'auto', 'overflowing JSON and controls must stay accessible within the settings region');
assert.equal(cssProperty('.vd-batch-controls', 'scrollbar-width', 'compact batch settings scroll', videoDirectorCss), 'thin');
assert.equal(cssProperty('.vd-batch-controls > *', 'flex-shrink', 'stable batch settings children', videoDirectorCss), '0', 'settings children must scroll at their natural height, not overlap from flex shrinking');
assert.equal(cssProperty('.vd-batch-columns', 'flex', 'reserved segment list space', videoDirectorCss), '1 0 120px', 'the list and preview must retain a non-shrinking 120px basis even when advanced JSON is open');
assert.equal(cssProperty('.vd-batch-list', 'overflow', 'bounded batch segment list', videoDirectorCss), 'auto', 'extra segments must scroll within the reserved list space');
assert.equal(cssProperty('.vd-batch-responsive-tabs', 'flex', 'persistent batch view tabs', videoDirectorCss), '0 0 auto');
assert.equal(cssProperty('.vd-batch-footer', 'flex', 'persistent batch submission footer', videoDirectorCss), '0 0 auto', 'settings overflow must not collapse the confirmation and submission actions');
// Compact only the batch setup, keeping readable controls and wrapping notes.
assert.equal(cssProperty('.vd-batch-configuration .field', 'grid-template-columns', 'inline batch configuration labels', videoDirectorCss), 'auto minmax(0, 1fr)');
assert.equal(cssProperty('.vd-batch-toolbar .vd-batch-regenerate-success', 'flex', 'wrapping regeneration warning', videoDirectorCss), '0 1 auto', 'the full fee warning may share a row, but must remain visible');
assert.equal(cssProperty('.vop-batch', 'flex-wrap', 'wrapping batch output parameters', videoOutputCss), 'wrap');
assert.equal(cssProperty('.vop-batch-notes', 'flex-wrap', 'wrapping batch parameter help', videoOutputCss), 'wrap');
assert.equal(cssProperty('.vop-batch-notes > .vop-help-details[open]', 'flex-basis', 'expanded parameter help', videoOutputCss), '100%', 'expanded help must get its own row instead of overlapping controls');
assert.match(videoSettingsSource, /data-video-settings-panel=\{panel\}/u, 'video settings must expose the active backend for scoped responsive layout');
assert.match(videoSettingsSource, /managerOpen\s*&&\s*<VideoWorkflowManager/u, 'workflow editor must remain detached from the common page until opened');
assert.match(videoSettingsSource, /advancedOpen\s*&&/u, 'advanced protocol editor must be explicitly opened');
assert.doesNotMatch(videoSettingsSource, /<details\b/u, 'arbitrary mapping and JSON content must no longer stretch the common page');
for (const className of ['video-api-settings-form', 'comfyui-video-settings-form', 'vgs-main', 'vgs-card', 'video-settings-redesign']) {
  assert.match(videoSettingsSource, new RegExp(`className="[^"]*${className}[^"]*"`, 'u'), `${className} must remain wired to the video settings markup`);
}
for (const [name, scopedCss] of [['video settings', videoSettingsCss], ['workflow manager', videoWorkflowCss]]) {
  const unscaled = [...scopedCss.matchAll(/font-size:\s*(?<value>[^;}]+)/gu)].map((match) => match.groups?.value || '')
    .filter((value) => /\d(?:\.\d+)?px\b/u.test(value) && !/var\(--ui-font-scale,\s*1\)/u.test(value));
  assert.deepEqual(unscaled, [], `${name} must honor global font scaling, including responsive overrides`);
  assert.doesNotMatch(scopedCss, /font:\s*\d+(?:\.\d+)?px\b/gu, `${name} code editors cannot bypass the global font scale`);
}
assert.match(videoWorkflowSource, /getPropertyValue\(['"]--ui-font-scale['"]\)/u, 'body-mounted workflow portal must read the application font setting');
assert.match(videoWorkflowSource, /['"]--ui-font-scale['"]:\s*uiFontScale/u, 'the portal must explicitly carry the application font setting');
for (const [selector, pixels] of [['.asset-video-check', 12], ['.asset-video-source', 12]] as const) {
  assert.equal(cssProperty(selector, 'font-size', `scaled asset text ${selector}`), `calc(${pixels}px * var(--ui-font-scale, 1))`);
}
assert.doesNotMatch(appSource, /className="asset-library-entries"|>资产库首页</u, 'the removed intermediary home page must not return');
assert.doesNotMatch(appSource, /私密资料图\s*·\s*仅限匹配的成人 NSFW 镜头/u, 'private profile asset cards must not repeat the age-gate notice');
assert.equal(
  cssProperty('.director-result-head', 'flex-wrap', 'director result header'),
  'wrap',
  'the bilingual result header must wrap instead of overlapping when the panel narrows',
);
assert.match(
  ruleBody('.director-reference-head', 'default director reference header'),
  /(?:^|;)\s*flex-wrap:\s*wrap\s*;/u,
  'the reference-selection header must still allow its upload controls and pager to wrap',
);
assert.equal(
  cssProperty('.director-side-panel:has(.director-result-copy) .director-reference-head', 'flex-wrap', 'compact result reference header'),
  'nowrap',
  'the result title and video-director action share the fixed header without displacing the prompt',
);
assert.equal(
  cssProperty('.result-language-tools', 'min-width', 'result language tools'),
  '0',
  'the bilingual controls must be allowed to shrink inside the result panel',
);
assert.equal(
  cssProperty('.result-language-switch', 'display', 'result language card group'),
  'grid',
  'the Chinese and English controls must render as two independent cards',
);
assert.equal(
  cssProperty('.result-language-switch', 'grid-template-columns', 'result language card group'),
  'repeat(2, minmax(58px, 1fr))',
  'the language card group must reserve one stable column for each language',
);
assert.equal(
  cssProperty('.result-language-card', 'min-width', 'result language card'),
  '0',
  'language card labels must not force horizontal overflow',
);

assert.equal(
  cssProperty('.rule-tabs', 'overflow-y', 'rule center tab rail'),
  'auto',
  'six rule-center tabs must scroll inside their own rail instead of overlapping the editor',
);
assert.equal(
  cssProperty('.image-prompt-rule-workspace', 'overflow', 'image prompt rule workspace'),
  'hidden',
  'image prompt rule lists and editors must stay inside their bounded card',
);
assert.equal(
  cssProperty('.image-prompt-rule-workspace > .list', 'overflow-y', 'image prompt rule list'),
  'auto',
  'the image prompt rule list must scroll independently',
);
assert.equal(
  cssProperty('.image-prompt-rule-workspace > .rule-editor', 'overflow-y', 'image prompt rule editor'),
  'auto',
  'the image prompt editor must scroll independently instead of covering actions',
);

const nestedRuleFixture = `
  .qa-layout { grid-template-columns: 1fr 1fr; }
  @media (max-width: 900px) {
    .qa-layout { grid-template-columns: 1fr; }
  }
  @container qa-shell (max-width: 500px) {
    .qa-layout { grid-template-columns: 2fr; }
  }
`;
assert.equal(
  cssProperty('.qa-layout', 'grid-template-columns', 'top-level QA layout', nestedRuleFixture),
  '1fr 1fr',
  'base-layout assertions must ignore matching rules nested inside @media or @container',
);

const assertMinimumFontSize = (selector: string, description: string): void => {
  const body = lastRuleBody(selector, description);
  const declaration = body.match(/font-size:\s*(?<value>[^;}]+)/su);
  const match = declaration?.groups?.value.match(/(?<fontSize>\d+(?:\.\d+)?)px\b/su);
  assert.ok(
    match?.groups?.fontSize,
    `${description} must declare its font size in px so the minimum can be verified`,
  );

  const fontSize = Number(match.groups.fontSize);
  assert.ok(
    Number.isFinite(fontSize) && fontSize >= 8,
    `${description} font size must be at least 8px; received ${match.groups.fontSize}px`,
  );
};

const uiFontScaleExpression = /var\(--ui-font-scale,\s*1\)/u;
const assertUsesUiFontScale = (selector: string, description: string): void => {
  assert.match(
    cssProperty(selector, 'font-size', description),
    uiFontScaleExpression,
    `${description} must respond to the global UI font scale`,
  );
};

assert.match(
  appSource,
  /className="app-shell"[\s\S]{0,240}?data-ui-font-scale=\{uiFontScalePercent\}[\s\S]{0,240}?data-ui-font-size=\{uiFontSizeMode\}[\s\S]{0,240}?"--ui-font-scale":\s*uiFontScalePercent\s*\/\s*100/u,
  'the app shell must expose the persisted percentage as the global CSS font-scale variable',
);
for (const [selector, description] of [
  ['body', 'base application text'],
  ['.nav-item-label', 'sidebar navigation text'],
  ['.crumb h1', 'topbar heading'],
  ['.btn', 'button text'],
  ['.result-language-card', 'result language card text'],
  ['.modal-head h3', 'dialog heading'],
] as const) {
  assertUsesUiFontScale(selector, description);
}

const unscaledExplicitFontSizes = [...css.matchAll(/font-size:\s*(?<value>[^;}]+)/gu)]
  .map((match) => match.groups?.value.trim() || '')
  .filter((value) => /\d(?:\.\d+)?px\b/u.test(value) && !uiFontScaleExpression.test(value));
assert.deepEqual(
  unscaledExplicitFontSizes,
  [],
  `every explicit pixel font-size must use --ui-font-scale; unscaled values: ${unscaledExplicitFontSizes.join(', ')}`,
);
assert.doesNotMatch(
  css,
  /font:\s*\d+(?:\.\d+)?px\b/gu,
  'pixel font shorthand must not bypass the global UI font scale',
);
assert.doesNotMatch(
  appSource,
  /fontSize:\s*\d+(?:\.\d+)?(?:\s*[,}])/gu,
  'inline React font sizes must not bypass the global UI font scale',
);

assert.equal(
  cssProperty('.topbar', 'height', 'font-responsive topbar'),
  'auto',
  'the topbar must be allowed to grow when the font is enlarged',
);
assert.equal(
  cssProperty('.topbar', 'min-height', 'font-responsive topbar'),
  '50px',
  'the default topbar height must remain stable',
);
assert.equal(
  cssProperty('.crumb', 'flex', 'font-responsive topbar breadcrumb'),
  '1 1 auto',
  'the topbar breadcrumb must yield space to the action group',
);
assert.equal(
  cssProperty('.crumb', 'overflow', 'font-responsive topbar breadcrumb'),
  'hidden',
  'long enlarged breadcrumb content must not cover the topbar actions',
);
assert.equal(
  cssProperty('.top-actions', 'flex', 'font-responsive topbar actions'),
  '0 0 auto',
  'the topbar actions must retain a non-overlapping action region',
);
assert.equal(
  cssProperty('.ui-settings-modal', 'overflow', 'UI font settings dialog'),
  'hidden',
  'the font settings dialog must keep its header and footer separated from its scrolling body',
);
assert.match(
  appSource,
  /aria-label="界面与字体设置"[\s\S]{0,220}?aria-haspopup="dialog"[\s\S]{0,180}?aria-controls="ui-settings-dialog"[\s\S]{0,180}?aria-expanded=\{uiSettingsOpen\}/u,
  'the right-side font settings trigger must expose dialog state to assistive technology',
);
for (const requiredFontSetting of [
  '界面设置',
  'aria-label="界面字体大小"',
  'type="range"',
  'type="number"',
  '减小字体',
  '增大字体',
  '恢复默认字体',
  '完成',
]) {
  assert.equal(
    appSource.includes(requiredFontSetting),
    true,
    `font settings UI must include ${requiredFontSetting}`,
  );
}

assert.match(
  css,
  /input:focus-visible,\s*textarea:focus-visible,\s*select:focus-visible\s*\{[^}]*outline:\s*2px\s+solid[^}]*outline-offset:\s*[1-9]\d*px[^}]*\}/su,
  'keyboard focus must remain visible independently of the box shadow',
);
const focusBody = ruleBody('input:focus, textarea:focus, select:focus', 'input focus');
const focusShadow = focusBody.match(/box-shadow:\s*(?<shadow>[^;}]+)/su);
assert.ok(focusShadow?.groups?.shadow, 'input focus must declare a box shadow');
const focusColor = focusShadow.groups.shadow.match(/rgba?\((?<channels>[^)]*)\)/iu);
assert.ok(focusColor?.groups?.channels, 'input focus box shadow must use an RGB color with alpha');
const channels = focusColor.groups.channels;
const alphaText = channels.includes('/')
  ? channels.split('/').at(-1)?.trim()
  : channels.split(',').length === 4
    ? channels.split(',').at(-1)?.trim()
    : undefined;
assert.ok(alphaText, 'input focus box shadow must declare an alpha channel');
const focusAlpha = parseCssAlpha(alphaText);
assert.ok(
  Number.isFinite(focusAlpha) && focusAlpha > 0.08,
  `input focus ring alpha must be greater than 0.08; received ${alphaText}`,
);
assert.equal(parseCssAlpha('16%'), 0.16, 'CSS percentage alpha must convert to a fraction');
assertMinimumFontSize('.timing-parameter-card .segment', 'timing segment');
assertMinimumFontSize('.director-timing-fields .field-hint', 'director timing hint');
assertMinimumFontSize('.compact-option-grid .director-option-name', 'director option name');
assertMinimumFontSize(
  '.director-source-card .scene-chip-grid .select-chip',
  'director scene chip',
);
assertMinimumFontSize('.director-source-card .scene-multi-head', 'director scene heading');
assertMinimumFontSize(
  '.director-source-card .scene-multi-head .btn.small',
  'director scene bulk action',
);
assert.equal(
  cssProperty('.director-source-card', 'container-type', 'responsive director source'),
  'inline-size',
  'the source card must size scene controls from its own available width',
);
assert.equal(
  cssProperty('.director-source-card', 'container-name', 'responsive director source'),
  'director-source',
  'the source card must expose a stable named container',
);
assert.equal(
  cssProperty(
    '.director-source-card .scene-chip-grid',
    'grid-template-columns',
    'compact director scene grid',
  ),
  'repeat(6, minmax(0, 1fr))',
  'twelve director scenes must use two rows instead of four',
);
assert.equal(
  cssProperty(
    '.director-source-card .scene-chip-grid',
    'overflow-y',
    'bounded director scene grid',
  ),
  'auto',
  'additional scenes must scroll inside the compact source area instead of covering the director stage',
);
assert.equal(
  cssProperty(
    '.director-source-card .scene-chip-grid',
    'max-height',
    'bounded director scene grid',
  ),
  'clamp(38px, 3.5cqi, 42px)',
  'the scene selector must remain approximately half of its former four-row height',
);
assert.match(
  cssProperty(
    '.director-source-card .scene-chip-grid .select-chip',
    'font-size',
    'responsive director scene chip',
  ),
  /^calc\(clamp\(8px,\s*\.82cqi,\s*10px\)\s*\*\s*var\(--ui-font-scale,\s*1\)\)$/u,
  'scene labels must shrink with the source card while retaining an 8px floor',
);
assert.equal(
  cssProperty('.director-work-grid', 'grid-template-columns', 'director work columns'),
  'repeat(2, minmax(0, 1fr))',
  'director parameters and generated results must share the available width equally',
);
assert.equal(
  cssProperty('.director-control-card', 'container-type', 'responsive director controls'),
  'inline-size',
  'director controls must size their contents from the left column width',
);
assert.equal(
  cssProperty('.director-control-card', 'container-name', 'responsive director controls'),
  'director-controls',
  'director controls must expose the named container used by compact rules',
);
assert.match(
  cssProperty('.timing-parameter-card .segment', 'font-size', 'responsive timing segment'),
  /^calc\(clamp\(8px,\s*1\.4cqi,\s*9px\)\s*\*\s*var\(--ui-font-scale,\s*1\)\)$/u,
  'timing buttons must shrink with the director column while retaining an 8px floor',
);
assert.match(
  cssProperty('.compact-option-grid .director-option-name', 'font-size', 'responsive director option'),
  /^calc\(clamp\(8px,\s*1\.45cqi,\s*10px\)\s*\*\s*var\(--ui-font-scale,\s*1\)\)$/u,
  'director option labels must shrink with the director column while retaining an 8px floor',
);
assert.match(
  css,
  /@container\s+director-controls\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\.compact-option-grid \.director-option-name\s*\{[^}]*font-size:\s*calc\(clamp\(6px,\s*1\.05cqi,\s*7px\)\s*\*\s*var\(--ui-font-scale,\s*1\)\)[^}]*line-height:\s*1\.04/su,
  'narrow director option labels must shrink before a three-line chip is clipped',
);
assert.match(
  css,
  /@container\s+director-controls\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\.director-timing-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.5fr\)\s+minmax\(0,\s*\.66fr\)\s+minmax\(0,\s*1\.08fr\)\s+minmax\(0,\s*\.66fr\)/su,
  'narrow director columns must rebalance timing controls without adding rows',
);

assert.equal(
  cssProperty('.storyboard-view', 'grid-template-rows', 'storyboard page'),
  'none',
  'storyboard page must use natural rows so the batch toolbar cannot collapse at short desktop heights',
);
assert.equal(
  cssProperty('.storyboard-view', 'grid-auto-rows', 'storyboard page'),
  'max-content',
  'storyboard page implicit rows must preserve their content height',
);
assert.match(
  cssProperty('.shot-grid', 'grid-template-columns', 'storyboard shot grid'),
  /repeat\(auto-fit,\s*minmax\(min\(100%,\s*\d+px\),\s*1fr\)\)/u,
  'shot cards must collapse responsively instead of forcing two narrow columns',
);
const shotActionBody = lastRuleBody(
  '.storyboard-view .shot-card-head > .row',
  'storyboard shot action group',
);
assert.match(shotActionBody, /flex-wrap:\s*wrap\b/su, 'shot actions must wrap within their card');
assert.match(shotActionBody, /width:\s*100%(?:\s|;|$)/su, 'shot actions must stay within their card width');
assert.match(shotActionBody, /min-width:\s*0\b/su, 'shot actions must be allowed to shrink');

assert.equal(
  cssProperty('.rule-layout > .card', 'display', 'rule content card'),
  'grid',
  'the rule card must separate its fixed title row from the bounded content row',
);
assert.equal(
  cssProperty('.rule-layout > .card', 'grid-template-rows', 'rule content card'),
  'auto minmax(0, 1fr)',
  'the rule card title must stay visible while the preset workspace consumes the remaining height',
);
assert.equal(
  cssProperty('.rule-layout > .card', 'overflow', 'rule content card'),
  'hidden',
  'the rule card itself must not scroll the title and editor away together',
);
assert.equal(
  cssProperty('.rules-view .grid-main', 'overflow', 'rule preset workspace'),
  'hidden',
  'the bounded rule workspace must contain both independent scrolling columns',
);
const ruleColumnsSelector =
  '.rules-view .grid-main > .list, .rules-view .grid-main > .rule-editor';
assert.equal(
  cssProperty(ruleColumnsSelector, 'min-height', 'rule list and editor columns'),
  '0',
  'the rule list and editor must both shrink within the bounded content row',
);
assert.equal(
  cssProperty(ruleColumnsSelector, 'overflow-y', 'rule list and editor columns'),
  'auto',
  'the rule list and editor must scroll vertically without moving the other column',
);
assert.equal(
  cssProperty('.rules-view .list', 'align-content', 'rule preset list'),
  'start',
  'a short rule list must stay at the top instead of stretching its rows to fill the column',
);
assert.equal(
  cssProperty('.rules-view .list', 'grid-auto-rows', 'rule preset list'),
  'max-content',
  'each rule list item must retain its natural compact row height',
);

assert.equal(
  cssProperty('.settings-view', 'height', 'settings page'),
  '100%',
  'settings must remain bounded to the visible workspace height',
);
assert.match(
  cssProperty('.settings-view', 'grid-template-rows', 'settings page'),
  /auto auto auto minmax\(0, 1fr\) auto/u,
  'settings must reserve one bounded row for the active API panel',
);
assert.equal(
  cssProperty('.settings-view', 'overflow', 'settings page'),
  'hidden',
  'settings must not delegate API navigation to page scrolling',
);
assert.equal(
  cssProperty('.settings-panel-stage', 'overflow', 'settings panel stage'),
  'hidden',
  'the settings stage bounds the layout while a long selected panel owns its scrollable content',
);
assert.match(
  cssProperty('.settings-api-tabs', 'min-height', 'settings API tabs'),
  /^\d+px$/u,
  'settings API tabs must reserve a clickable height',
);
assert.match(
  appSource,
  /type SettingsPanel\s*=\s*"image"\s*\|\s*"text"\s*\|\s*"vision"\s*\|\s*"video"\s*\|\s*"credentials"/su,
  'settings navigation must expose image, text, vision, video, and credential panels',
);
assert.match(
  appSource,
  /useState<SettingsPanel>\(ctx\.openVideoSettings\s*\?\s*"video"\s*:\s*"image"\)/su,
  'ordinary settings opens image API; only an explicit video-settings launch opens video',
);
assert.match(appSource, /if \(item\.key === "settings"\) setOpenVideoSettings\(false\)/u, 'the normal settings navigation must clear the explicit video launch flag');
for (const panel of ['image', 'text', 'vision', 'video', 'credentials']) {
  assert.match(
    appSource,
    new RegExp(`data-settings-panel=["{]+${panel}["}]+`, 'su'),
    `${panel} settings panel must have a stable first-screen navigation target`,
  );
}

assert.equal(
  cssProperty('.director-view .director-setup-body', 'overflow', 'director setup body'),
  'hidden',
  'all director parameter groups must fit without an internal scroll container',
);
assert.equal(
  cssProperty('.director-view .director-all-sections', 'grid-template-rows', 'director sections'),
  'auto auto auto minmax(0, 1fr)',
  'timing, look, style, and motion groups must share the bounded setup body',
);
assert.equal(
  cssProperty('.director-view .director-motion-pane', 'grid-template-rows', 'director motion pane'),
  'minmax(0, 1fr) auto',
  'motion controls and extra requirement must share the visible parameter page',
);
assert.match(
  appSource,
  /id="director-setup-timing"[\s\S]*id="director-setup-look"[\s\S]*id="director-setup-style"[\s\S]*id="director-setup-motion"/u,
  'director parameters must expose all four groups together in DOM order',
);
assert.doesNotMatch(
  appSource,
  /DirectorSetupPage|directorSetupPage|setDirectorSetupPage|aria-label="导演参数分页"/u,
  'director parameter groups must not be split by paging state or tabs',
);
for (const section of ['timing', 'look', 'style', 'motion']) {
  assert.match(
    appSource,
    new RegExp(`<section\\s+id="director-setup-${section}"\\s+aria-labelledby="director-setup-${section}-title"`, 'u'),
    `${section} director parameter group must remain permanently visible and labelled`,
  );
}
assert.doesNotMatch(
  sourceBetween('id="director-setup-look"', 'id="director-setup-motion"'),
  /<Field label="风格预设">/u,
  'director parameter controls must not expose the redundant style-preset selector',
);
assert.match(
  appSource,
  /id="director-setup-style"[\s\S]*AI 分析填写[\s\S]*className="director-choice-combo"[\s\S]*aria-label="选择导演风格"[\s\S]*aria-label="选择视觉风格"/u,
  'director style controls must support AI autofill plus custom text with clickable selectable options',
);

assert.equal(
  cssProperty('.storyboard-delivery-tools .prompt-copy', 'overflow', 'target prompt copy'),
  'auto',
  'long target-model prompts must scroll instead of being clipped',
);
assert.match(
  appSource,
  /useState<string>\(\(\)\s*=>[\s\S]*?activeStoryboard\?\.targetModelId[\s\S]*?OFFICIAL_H3_TARGET_ID/u,
  'MiniMax H3 must be the default delivery target for a storyboard without a saved target',
);
assert.match(
  appSource,
  /useState<PromptDetailMode>\("concise"\)/u,
  'the default target prompt density must be the compact execution draft',
);
assert.match(appSource, /MiniMax H3 执行稿/u, 'the H3 execution draft must be visible as a primary delivery artifact');
assert.match(appSource, /deliveryPrompt\.length/u, 'the delivery card must show the actual prompt character count');
assert.match(
  appSource,
  /本地不限长/u,
  'the H3 delivery card must clearly state that the local character limit is removed',
);
assert.doesNotMatch(appSource, /h3PromptCharacterLimit|MINIMAX_H3_PROMPT_CHARACTER_LIMIT|官方上限/u, 'UI length counters must not classify a long prompt as invalid');
assert.doesNotMatch(appSource, /软预算/u, 'the retired project soft-budget wording must not remain in the UI');
assert.match(appSource, /handleCopyPrompt\(deliveryPrompt\)/u, 'the primary delivery copy action must copy the H3 execution draft');
assert.match(
  appSource,
  /downloadText\([\s\S]{0,260}deliveryPrompt/u,
  'the primary delivery export action must export the H3 execution draft',
);
assert.match(
  appSource,
  /targetIsOfficialH3\s*\?\s*"导出 H3 TXT"\s*:\s*"导出目标稿 TXT"/u,
  'the delivery export label must not call a non-H3 target an H3 draft',
);
assert.match(
  appSource,
  /const deliveryTargetFileLabel = targetIsOfficialH3/u,
  'the exported TXT filename must follow the selected target model',
);
assert.match(
  appSource,
  /targetIsOfficialH3[\s\S]{0,180}H3 官方 Shot 时间格式[\s\S]{0,220}当前为/u,
  'the H3 format hint must only be shown for the H3 target',
);

assert.equal(
  cssProperty('.modal.asset-preview-modal', 'overflow', 'asset preview modal'),
  'hidden',
  'asset preview modal must keep its save action on the first screen',
);
assert.match(
  cssProperty('.modal.asset-preview-modal', 'grid-template-rows', 'asset preview modal'),
  /auto minmax\(0,\s*1fr\)/u,
  'asset preview modal must reserve a bounded row for the image body',
);
assert.match(
  cssProperty('.asset-preview-body', 'grid-template-rows', 'asset preview body'),
  /minmax\(0,\s*1fr\) auto auto/u,
  'asset preview body must keep metadata and save actions below a shrinking image row',
);
assert.equal(cssProperty('.asset-preview-pane', 'overflow', 'zoomed image viewport'), 'auto', 'all parts of an enlarged image must remain scrollable');
assert.match(cssProperty('.asset-image-viewer', 'grid-template-rows', 'fixed image zoom controls'), /auto minmax\(0,\s*1fr\)/u, 'zoom controls remain outside the scrolling image');
assert.equal(cssProperty('.asset-preview-stage', 'min-width', 'centered image canvas'), '100%');
assert.equal(cssProperty('.asset-preview-pane img', 'max-width', 'unclipped zoomed image'), 'none', 'CSS must not clamp explicitly enlarged image dimensions');

assert.match(
  appSource,
  /className="segmented image-variant-row"[\s\S]{0,2400}<span className="image-canvas-hint" role="note">[\s\S]{0,220}resolvedImageOutputSize\.width[\s\S]{0,100}resolvedImageOutputSize\.height[\s\S]{0,240}<\/span>[\s\S]{0,100}<\/div>/u,
  'the four-view canvas note must share the variant row and display the selected pixel dimensions, not the old fixed canvas',
);
assert.match(
  appSource,
  /<ImageOutputSizeControls[\s\S]{0,140}lane=\{imageGenerationMode\}[\s\S]{0,80}value=\{imageSizePreference\}[\s\S]{0,120}resolved=\{\{ \.\.\.resolvedImageOutputSize[\s\S]{0,240}onChange=\{changeImageOutputSize\}[\s\S]{0,50}\/>/u,
  'ordinary and private image modes must expose working pixel controls backed by their current lane preference and resolved dimensions',
);
const imageRuleSection = sourceBetween(
  '<section className="image-setting-section image-setting-rules"',
  '<section className="image-setting-section image-setting-references"',
);
const imageReferenceSection = sourceBetween(
  '<section className="image-setting-section image-setting-references"',
  '<section className="image-setting-section image-setting-spec"',
);
const imageSpecSection = sourceBetween(
  '<section className="image-setting-section image-setting-spec"',
  '<div className="image-generate-row image-setting-section"',
);
const imageActionSection = sourceBetween(
  '<div className="image-generate-row image-setting-section"',
  '<ReferenceImagePickerModal',
);
const imageModeHeader = sourceBetween(
  '<div className="row-between image-generation-mode-bar">',
  '<div className="image-generation-controls"',
);
const imagePanelHeading = sourceBetween(
  '<div className="row-between image-output-head">',
  '<div className="row-between image-generation-mode-bar">',
);
assert.match(appSource, /import\s+["']\.\/imageWorkbenchPanel\.css["']/u, 'the refined image panel CSS must be loaded by the app');
assert.match(imagePanelHeading, /className="image-rule-manager-button"[\s\S]*?管理规则与预设/u, 'rule management belongs to the panel heading, separate from the two labelled selects');
assert.doesNotMatch(imageRuleSection, /管理规则与预设/u, 'rule management must not duplicate a row inside the compact rule section');
assert.equal((imageRuleSection.match(/<Field\s+label="(?:生图规则集|分类预设)"/gu) || []).length, 2, 'both labelled rule and preset fields must stay in the rule section');
assert.match(imageReferenceSection, /aria-label="参考图设置"[\s\S]*?className="image-upload-field"[\s\S]*?name=\{`use-reference-image-\$\{imageGenerationMode\}`\}/u, 'reference upload and the real-image-use checkbox must share the reference section');
assert.match(imageReferenceSection, /<details className="image-panel-capability"><summary aria-label="生图更多设置">更多设置<\/summary>\s*<div className="image-panel-extra-popover">[\s\S]*?className="image-api-capability"[\s\S]*?className="image-negative-field"/u, 'backend help and ordinary negatives must remain available in the expandable more-settings panel');
assert.doesNotMatch(imageReferenceSection, /<details[^>]*\bopen(?:\s|=|>)/u, 'optional reference settings must start collapsed so they do not occupy a permanent narrow row');
assert.match(imageSpecSection, /aria-label="画面规格与数量"[\s\S]*?className="image-generation-quantity-row"[\s\S]*?className="segmented image-variant-row"[\s\S]*?<ImageOutputSizeControls/u, 'quantity, ordinary variants and pixel controls must stay together in the image-specification section');
assert.match(imageSpecSection, /className="segmented image-private-variant-row"/u, 'private variants must use the same specification section');
assert.match(imageActionSection, /<Field label="自定义要求" className="image-requirement-field">\s*<input\s+className="image-autofill-requirement"/u, 'the custom-requirement field must keep its visible label and original input control');
assert.match(imageActionSection, /className="image-requirement-field"[\s\S]*?image-generate-actions/u, 'custom requirements must appear before the generation actions');
assert.doesNotMatch(imageActionSection, /className="image-negative-field"/u, 'optional negatives must not consume the fixed primary-action section');
assert.match(imageModeHeader, /image-generation-mode-tabs/u, 'ordinary/private mode tabs remain in the top mode header');
assert.doesNotMatch(imageModeHeader, /image-generation-output-tabs/u, 'result tabs must not be mixed into the ordinary/private mode header');
assert.doesNotMatch(appSource, /className="image-results-container"/u, 'the settings card must omit the duplicate results section');
assert.match(
  cssProperty('.image-view .image-output-card.image-output-refined', 'grid-template-rows', 'refined image panel', imageWorkbenchPanelCss),
  /^auto auto minmax\(0,\s*1fr\)$/u,
  'the image panel must dedicate its remaining height to generation controls',
);
assert.equal(cssProperty('.image-output-card.image-output-refined .image-setting-section', 'min-width', 'image settings section', imageWorkbenchPanelCss), '0', 'nested image settings must be allowed to shrink');
assert.equal(cssProperty('.image-output-card.image-output-refined .image-reference-controls', 'display', 'image reference controls', imageWorkbenchPanelCss), 'flex', 'reference upload buttons must share the full-width row rather than three intrinsic grid columns');
assert.match(imageWorkbenchPanelCss, /\.image-output-card\.image-output-refined \.image-reference-controls > label\.btn\s*\{[^}]*min-width:\s*0[^}]*white-space:\s*normal/u, 'reference buttons must wrap labels instead of overflowing narrow panels');
assert.equal(cssProperty('.image-output-card.image-output-refined .image-generation-controls', 'overflow-y', 'image generation controls', imageWorkbenchPanelCss), 'auto', 'generation controls must remain scrollable when their content exceeds the panel');
assert.match(cssProperty('.image-output-card.image-output-refined .image-generate-actions.single-action', 'grid-template-columns', 'single grid-image action', imageWorkbenchPanelCss), /^minmax\(0,\s*1fr\)$/u, 'the grid-only primary action must still occupy the full action row');
assert.equal(cssProperty('.image-output-card.image-output-refined .image-panel-extra-popover', 'overflow', 'image more-settings popover', imageWorkbenchPanelCss), 'auto', 'long optional settings must remain reachable inside a bounded popover');
assert.match(
  appSource,
  /className="image-entity-controls"[\s\S]{0,1800}>\s*新增\s*<[\s\S]{0,500}>\s*保存\s*</u,
  'the image entity selector must expose working new and save actions',
);
assert.match(
  appSource,
  /const fieldsForKind\s*=[\s\S]{0,220}assetKind === "character"[\s\S]{0,260}\["gender", "性别"\]/u,
  'the character image workbench form must expose a dedicated gender field',
);
assert.match(
  appSource,
  /id="image-character-gender-options"[\s\S]{0,500}>男<[\s\S]{0,200}>女<[\s\S]{0,200}>雄性<[\s\S]{0,200}>雌性</u,
  'the gender field must suggest human and non-human values without restricting custom text',
);
assert.match(
  appSource,
  /className="image-autofill-requirement"[\s\S]{0,500}自定义要求：补资料 \/ 生图额外要求/u,
  'the image action bar must expose one custom input used as an autofill requirement or an image-generation extra requirement by button context',
);
assert.match(
  appSource,
  /!hasFormClue\s*&&\s*!projectContext\.trim\(\)\s*&&\s*!requestedAutofillRequirement/u,
  'a custom autofill requirement must be sufficient input when the form and project context are blank',
);
assert.match(
  appSource,
  /requestImageAssetAutofill\([\s\S]{0,800}\{\s*customRequirement:\s*requestedAutofillRequirement\s*\}/u,
  'the image workbench must pass its custom requirement into the autofill service',
);
assert.match(
  appSource,
  /previousImageWorkbenchProjectIdRef[\s\S]{0,1500}setSelectedEntityId\(""\)[\s\S]{0,500}setAssetForm\(createInheritedAssetForm\(\)\)[\s\S]{0,160}setAssetFormStyleSource\("director"\)/u,
  'switching projects must clear the previous image entity binding and form while inheriting the prompt director visual style',
);
assert.match(
  appSource,
  /title="新增一条空白实体资料"[\s\S]{0,650}disabled=\{busy\s*\|\|\s*autofillBusy\}[\s\S]{0,500}title="保存当前实体资料"/u,
  'entity actions must stay disabled while image generation or autofill is running',
);
assert.match(
  css,
  /\.image-entity-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/u,
  'the image entity selector and actions must share a bounded responsive row',
);
assert.match(
  css,
  /\.image-autofill-requirement\s*\{[^}]*flex:\s*1\s+1\s+\d+px[^}]*min-width:\s*\d+px/u,
  'the custom autofill requirement must shrink or wrap without horizontal overflow',
);
assert.match(
  css,
  /@media\s*\(max-height:\s*800px\)\s*and\s*\(min-width:\s*900px\)[\s\S]{0,1800}\.image-fields-grid\s+\.field[\s\S]{0,280}grid-template-columns:\s*70px\s+minmax\(0,\s*1fr\)/u,
  '1280x800 and Electron 1269x765 workspaces must compact image fields into label-control rows',
);
assert.match(
  css,
  /@media\s*\(max-height:\s*800px\)\s*and\s*\(min-width:\s*900px\)[\s\S]{0,1000}\.image-prompt-selection-grid\s+select\s*\{[^}]*min-height:\s*28px[^}]*height:\s*28px[^}]*padding:\s*2px\s+6px[^}]*line-height:\s*1\.2/u,
  'compact image prompt selects must retain enough content height for Windows high-DPI text',
);
assert.match(
  css,
  /\.image-entity-field\s+\.field-hint,\s*\.image-upload-field\s+\.field-hint\s*\{\s*display:\s*none/u,
  'short image forms must hide optional help copy so every control stays on the first screen',
);

assert.match(appSource, /type ProductionMode\s*=\s*"single"\s*\|\s*"sequence"/u, 'director must expose single and sequence production modes');
assert.match(appSource, /单段直出/u, 'director must expose the single-output production mode');
assert.match(appSource, /长剧情拆段/u, 'director must expose the long-story production mode');
assert.match(appSource, /AI估算总时长/u, 'sequence planner must expose AI duration estimation');
assert.match(appSource, /① 生成全片总提示词/u, 'sequence planner must expose the visible master-generation action');
assert.match(appSource, /生成当前段提示词/u, 'sequence director must expose current-segment generation');
assert.match(appSource, /顺序生成全部/u, 'sequence director must reserve the serial batch action');
const directorStageStart = appSource.indexOf('<div className="director-stage">');
const directorStageSource = directorStageStart >= 0
  ? appSource.slice(directorStageStart, directorStageStart + 1800)
  : '';
assert.equal(
  directorStageSource.includes('productionMode === "sequence" && sequenceStage === "plan" && !sequenceSettingsOpen ? (')
    && directorStageSource.includes('<SequencePlannerPanel {...ctx} />')
    && directorStageSource.includes('className="director-work-grid"'),
  true,
  'the full planner and director controls must be mutually exclusive children of one stage',
);

assert.equal(
  cssProperty('.director-stage', 'min-height', 'director bounded stage'),
  '0',
  'director stage must be allowed to shrink inside the one-screen workspace',
);
assert.equal(
  cssProperty('.director-stage', 'overflow', 'director bounded stage'),
  'hidden',
  'director stage must contain either planner or director without page overflow',
);
assert.doesNotMatch(appSource, /className="(?:grid director-mode-row|source-mode-card workflow-mode-card)"/u,
  'the redundant smart-director banner must not occupy a source-card row');
assert.doesNotMatch(css, /\.(?:director-mode-row|source-mode-card|workflow-mode-card)\b/u,
  'removed director-mode cards must not leave dedicated layout styles');
assert.match(appSource, /const smartDirectorDecision = useMemo\([\s\S]*?inferDirectorWorkflow\(/u,
  'removing the banner must preserve automatic story-based director selection');
assert.match(appSource, /className="whole-story-source"[\s\S]*?已载入完整剧情原文/u,
  'the original-story loaded indicator must remain below the production controls');
assert.match(
  cssProperty('.sequence-planner-controls', 'grid-template-columns', 'legacy sequence planner controls', css, true),
  /^repeat\(4,\s*minmax\(0,\s*1fr\)\)$/u,
  'legacy sequence planning controls must remain a compact four-column row',
);
assert.equal(
  cssProperty(
    '.sequence-planner-panel[data-planning-mode="semantic-segments"] .sequence-planner-controls',
    'grid-template-columns',
    'semantic sequence planner controls',
    css,
    true,
  ),
  'repeat(2, minmax(0, 1fr))',
  'AI-adapted semantic planning keeps two equally shrinkable control columns without changing the legacy layout',
);
assert.equal(
  cssProperty(
    '.sequence-planner-panel[data-planning-mode="semantic-segments"][data-duration-mode="fixed"] .sequence-planner-controls',
    'grid-template-columns',
    'custom-duration semantic sequence planner controls',
    css,
    true,
  ),
  'repeat(3, minmax(0, 1fr))',
  'custom-duration semantic planning reserves a third shrinkable column for the user-selected total duration',
);
assert.equal(
  cssProperty('.sequence-planner-panel', 'flex-direction', 'sequence planner vertical flow'),
  'column',
  'the active review pane must receive flexible height without hard-coding simultaneous master and segment rows',
);
assert.equal(
  cssProperty('.sequence-segment-editor', 'overflow-y', 'sequence editor scrolling'),
  'auto',
  'short windows must allow reaching all seven fields instead of clipping compressed rows',
);
assert.equal(
  cssProperty('.sequence-editor-grid', 'grid-auto-rows', 'sequence editor content rows'),
  'auto',
  'editor rows must preserve the minimum label and control sizes',
);
assert.match(
  cssProperty('.sequence-editor-grid', 'grid-template-areas', 'semantic sequence editor placement'),
  /"boundary boundary boundary"[\s\S]*"content content summary"[\s\S]*"entry exit transition"/u,
  'conditional AI metadata must have its own named row and must not shift nth-child placement',
);
assert.doesNotMatch(
  css,
  /\.sequence-editor-grid\s*>\s*\.field:nth-child\(/u,
  'editor field placement must not depend on the presence of the AI boundary note',
);
assert.equal(
  cssProperty('.sequence-filmstrip', 'overflow-x', 'sequence filmstrip'),
  'auto',
  'only the segment filmstrip may scroll horizontally',
);
assert.equal(
  cssProperty('.sequence-filmstrip', 'overflow-y', 'sequence filmstrip'),
  'hidden',
  'the segment filmstrip must never add vertical scrolling',
);
assert.match(
  cssProperty('.sequence-director-strip .sequence-segment-chip', 'flex', 'director segment chip'),
  /^1 0 \d+px$/u,
  'dense director segment chips must keep a readable width and use horizontal scrolling instead of growing taller',
);
assert.match(
  ruleBody('.sequence-director-strip', 'default compact director segment strip'),
  /(?:^|;)\s*height:\s*48px\s*;/u,
  'the default director segment strip must retain its compact bounded height',
);
assert.equal(
  cssProperty('.director-view:has(.director-result-copy) .sequence-director-strip', 'height', 'result-mode director segment strip'),
  '40px',
  'the result-mode segment strip reserves a compact row so prompt headings and actions remain visible',
);
assert.equal(
  cssProperty('.sequence-director-strip .sequence-segment-chip', 'grid-template-columns', 'compact director segment chip'),
  'auto minmax(0, 1fr)',
  'director segment chips must place their index and title on the same compact row',
);
assert.equal(
  cssProperty('.sequence-director-strip .sequence-segment-index', 'white-space', 'director segment index'),
  'nowrap',
  'director segment indexes must not stack 第/数字/段 into several vertical lines',
);
assert.equal(
  cssProperty('.sequence-planner-panel .btn', 'min-height', 'sequence planner buttons'),
  '24px',
  'sequence planner actions must remain clickable in short desktop windows',
);
assert.doesNotMatch(
  css,
  /\.sequence-estimate-copy\s+(?:span|strong|details|summary)\s*\{[^}]*display:\s*none/u,
  'short desktop windows must not remove the estimate reason or its disclosure entry',
);
assert.equal(cssProperty('.sequence-analysis-row', 'flex-wrap', 'estimate row wrapping'), 'wrap');
assert.equal(cssProperty('.sequence-estimate-detail-body', 'overflow-y', 'complete estimate detail scrolling'), 'auto');
assert.equal(cssProperty('.sequence-estimate-detail-body', 'max-height', 'bounded estimate detail'), 'min(140px, 18vh)');
assert.equal(cssProperty('.sequence-estimate-detail-body', 'white-space', 'complete estimate reason'), 'pre-wrap');
assert.equal(cssProperty('.sequence-estimate-detail-body', 'overflow-wrap', 'long estimate reason'), 'anywhere');
assert.equal(cssProperty('.sequence-planning-options-body', 'max-height', 'bounded planning controls'), '35vh');
assert.match(css, /\.sequence-planning-error-details\s*>\s*pre\s*\{[^}]*white-space:\s*pre-wrap/u,
  'master-generation diagnostics must preserve the complete structured failure reason');
assert.match(appSource, /getSafeErrorDiagnostics\(sequenceMasterGenerationIssue\)/u,
  'master-generation diagnostics must be sanitized before being shown in the planner');
assert.match(appSource, /<summary>查看详细失败原因<\/summary>/u,
  'the planner must expose the detailed AI/H3 failure reason instead of hiding it in a generic toast');
assert.match(appSource, /<details className="sequence-estimate-details">[\s\S]*?<summary>[\s\S]*?估时说明[\s\S]*?<\/summary>/u);
assert.match(appSource, /className="sequence-estimate-detail-body" role="region" aria-label="估时完整说明" tabIndex=\{0\}/u);

assert.equal(cssProperty('.sidebar-footer', 'grid-template-columns', 'sidebar footer shrinkable track'), 'minmax(0, 1fr)');
assert.equal(cssProperty('.sidebar-footer', 'min-width', 'sidebar footer shrinking'), '0');
assert.equal(cssProperty('.sidebar-footer > *', 'min-width', 'sidebar footer child shrinking'), '0');
assert.equal(cssProperty('.sidebar-project-name', 'white-space', 'full project name wrapping'), 'normal');
assert.equal(cssProperty('.sidebar-project-name', 'overflow-wrap', 'unbroken project name'), 'anywhere');
assert.equal(cssProperty('.sidebar-project-name', 'overflow-y', 'extremely long project name'), 'auto');
assert.equal(cssProperty('.sidebar-project-name', 'height', 'stable sidebar name height'), '2.8em');
assert.doesNotMatch(ruleBody('.sidebar-project-name', 'full project name'), /text-overflow:\s*ellipsis/u);
assert.equal(cssProperty('.sidebar-version', 'grid-template-columns', 'uncropped footer version'), 'minmax(0, 1fr) auto');
assert.match(appSource, /点击打开项目库查看完整名称/u);
assert.match(
  css,
  /\.sequence-master-review\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*min-height:\s*0/u,
  'the master prompt review must be a visible, vertically managed card',
);
assert.match(
  css,
  /\.sequence-master-textarea\s*\{[^}]*flex:\s*1[^}]*min-height:\s*150px[^}]*resize:\s*none/u,
  'the full master prompt textarea must own flexible space with a readable minimum height',
);
assert.match(
  css,
  /\.sequence-master-review-actions\s*\{[^}]*flex:\s*0\s+0\s+auto/u,
  'master review actions must remain in a fixed, unclipped footer',
);

const analyzeSequenceStart = appSource.indexOf('const generateSequenceMasterPrompt = async () => {');
const analyzeSequenceEnd = appSource.indexOf('const updateSequenceMasterPrompt =', analyzeSequenceStart);
const analyzeSequenceSource = analyzeSequenceStart >= 0 && analyzeSequenceEnd > analyzeSequenceStart
  ? appSource.slice(analyzeSequenceStart, analyzeSequenceEnd)
  : '';
const estimateGateStart = analyzeSequenceSource.indexOf(
  'if (needsDurationEstimate) {',
);
const estimateGateEnd = analyzeSequenceSource.indexOf(
  'const chosenTotalDuration',
  estimateGateStart,
);
const estimateGateSource = estimateGateStart >= 0 && estimateGateEnd > estimateGateStart
  ? analyzeSequenceSource.slice(estimateGateStart, estimateGateEnd)
  : '';
const confirmPlanStart = appSource.indexOf('const confirmSequencePlan = () => {');
const confirmPlanEnd = appSource.indexOf('const generateSequenceMasterPrompt', confirmPlanStart);
const confirmPlanSource = confirmPlanStart >= 0 && confirmPlanEnd > confirmPlanStart
  ? appSource.slice(confirmPlanStart, confirmPlanEnd)
  : '';
const plannerStart = appSource.indexOf('function SequencePlannerPanel(ctx: AppContext) {');
const plannerEnd = appSource.indexOf('function DirectorView(ctx: AppContext) {', plannerStart);
const plannerSource = plannerStart >= 0 && plannerEnd > plannerStart
  ? appSource.slice(plannerStart, plannerEnd)
  : '';
for (const requiredReviewSource of [
  'className="sequence-master-review"',
  '全片总视频提示词',
  'aria-label="全片总视频提示词"',
  'updateSequenceMasterPrompt',
  '复制总提示词',
  '重新生成',
  '确认总提示词',
  '② AI 按剧情边界分段',
  '确认分段，进入③单段导演',
]) {
  assert.equal(
    plannerSource.includes(requiredReviewSource),
    true,
    `visible master review UI must include ${requiredReviewSource}`,
  );
}
assert.match(
  plannerSource,
  /planningStage\s*===\s*["']segmented["'][\s\S]*sequence-plan-workspace/u,
  'the segment filmstrip and editor must render only after confirmed segmentation',
);
assert.match(
  plannerSource,
  /planningStage\s*===\s*["']master-confirmed["'][\s\S]*disabled=\{[^}]*master[^}]*\}[\s\S]*onClick=\{segmentConfirmedMasterPrompt\}/u,
  'the split action must be gated by the confirmed live master prompt',
);
assert.doesNotMatch(appSource, /分析并拆段/u, 'the removed one-click action must never appear on first paint');
const storyViewStart = appSource.indexOf('function StoryView(ctx: AppContext) {');
const storyViewEnd = appSource.indexOf('function ', storyViewStart + 1);
const storyViewSource = storyViewStart >= 0 && storyViewEnd > storyViewStart
  ? appSource.slice(storyViewStart, storyViewEnd)
  : '';
const editSegmentStart = appSource.indexOf('const editSequenceSegment = (');
const editSegmentEnd = appSource.indexOf('const splitActiveSequenceSegment', editSegmentStart);
const editSegmentSource = editSegmentStart >= 0 && editSegmentEnd > editSegmentStart
  ? appSource.slice(editSegmentStart, editSegmentEnd)
  : '';
const fieldStart = appSource.indexOf('const FIELD_CONTROL_TAGS =');
const fieldEnd = appSource.indexOf('const Badge =', fieldStart);
const fieldSource = fieldStart >= 0 && fieldEnd > fieldStart
  ? appSource.slice(fieldStart, fieldEnd)
  : '';

assert.match(fieldSource, /new Set\(\["input", "select", "textarea"\]\)/u);
assert.match(fieldSource, /const explicitId[\s\S]*cloneElement[\s\S]*\{ id: controlId \}/u);
assert.match(fieldSource, /useId\(\)[\s\S]*<label htmlFor=\{associated\.controlId\}>/u);
assert.doesNotMatch(
  fieldSource,
  /cloneElement\([\s\S]*?aria-label/u,
  'Field association must preserve rather than replace an explicit aria-label',
);

const sequencePlanningSpecChecks = [
  {
    description: 'AI-estimated duration must be retained and flow directly into master generation',
    passes:
      /const \[estimateConfirmed,\s*setEstimateConfirmed\]\s*=\s*useState/u.test(appSource)
      && estimateGateSource.includes('sourceFingerprint: requestEstimateSourceFingerprint')
      && /const\s+effectiveRecommendedDuration\s*=\s*estimate\.recommendedSec/u.test(estimateGateSource)
      && estimateGateSource.includes('segmentDurationSec: requestSegmentDurationSec')
      && estimateGateSource.includes('onReview:') && estimateGateSource.includes('onRepair:')
      && estimateGateSource.includes('pendingAiEstimate = sourcedEstimate;')
      && estimateGateSource.includes('requestTotalDuration = effectiveRecommendedDuration;')
      && estimateGateSource.includes('setEstimateConfirmed(true);')
      && !estimateGateSource.includes('setTotalDuration(effectiveRecommendedDuration);')
      && !estimateGateSource.includes('allocateSegmentDurations(')
      && plannerSource.includes('{durationMode === "ai-estimated" && durationEstimate && ('),
  },
  {
    description: 'reviewed AI totals stay unchanged; manual budgets become full-segment AI timeline requests',
    passes:
      /setTotalDuration\(\s*resolveAiSequenceTotalDuration\(durationEstimate\.recommendedSec\)\s*\)/u.test(plannerSource)
      && /const\s+chosenTotalDuration\s*=\s*roundUpSequenceDurationToFullSegments\(requestedTotalDuration, segmentDurationSec\)/u.test(analyzeSequenceSource)
      && !analyzeSequenceSource.includes('resolveSequenceTotalDuration(')
      && /requestedTotalDurationSec:\s*chosenTotalDuration[\s\S]*?totalDurationSec:\s*chosenTotalDuration/u.test(analyzeSequenceSource),
  },
  {
    description: 'a successfully committed aligned plan updates duration after the request lease is released',
    passes:
      /if\s*\(!commitAccepted\)\s*return;\s*setSequenceMasterGenerationIssue\(""\);[\s\S]*?commitTotalDurationAfterRequest\s*=\s*\{\s*value:\s*completedTotalDuration,\s*touched:\s*true\s*\};/u.test(analyzeSequenceSource)
      && /sequencePlanningAbortRef\.current\s*=\s*null;[\s\S]*?commitTotalDurationAfterRequest\.value/u.test(analyzeSequenceSource),
  },
  {
    description: 'AI estimate copy must not claim that a local fixed grid adjusted the model duration',
    passes:
      analyzeSequenceSource.includes('AI 已估时并复核')
      && analyzeSequenceSource.includes('const effectiveRecommendedDuration = estimate.recommendedSec;')
      && !analyzeSequenceSource.includes('对齐后有效值'),
  },
  {
    description: 'the UI describes full selected segment seconds, AI-authored shots and no short tail',
    passes:
      appSource.includes('每段必须足额等于所选秒数；全片总时长为其整数倍')
      && appSource.includes('并自行审核修复，不由本地拆镜'),
  },
  {
    description: 'duration edits must not reuse an estimate from a different story snapshot',
    passes:
      appSource.includes('sequenceEstimateSourceFingerprint')
      && appSource.includes('from "./storyPacingEstimate"')
      && analyzeSequenceSource.includes('durationEstimate?.sourceFingerprint')
      && analyzeSequenceSource.includes('=== requestEstimateSourceFingerprint')
      && editSegmentSource.includes('readSequencePlanDurationEstimate(updated)')
      && /durationEstimate && savedEstimate[\s\S]*?durationEstimate\.sourceFingerprint === savedEstimate\.sourceFingerprint[\s\S]*?savedEstimate \|\| estimateStoryDurationLocally\(updated\.sourceStoryContent\)/u.test(editSegmentSource),
  },
  {
    description: 'story and planning input changes must invalidate a stale duration confirmation',
    passes:
      /const invalidateSequenceEstimate = [\s\S]{0,300}setEstimateConfirmed\(false\);[\s\S]{0,320}setDurationEstimate\(null\)/u.test(appSource)
      && storyViewSource.includes('invalidateSequenceEstimate();')
      && /setTotalDurationTouched\(true\);\s*invalidateSequenceEstimate\(false\);/u.test(plannerSource)
      && plannerSource.includes('setPlanningSegmentDurationPreset(item);')
      && appSource.includes('const sequencePlanningIdentityRef = useRef(sequencePlanningIdentity);')
      && analyzeSequenceSource.includes('requestPlanningIdentity,')
      && analyzeSequenceSource.includes('currentPlanningIdentity: sequencePlanningIdentityRef.current'),
  },
  {
    description: 'sequence planning must keep a duration preset independent from the director duration',
    passes:
      /const \[planningSegmentDurationPreset,\s*setPlanningSegmentDurationPreset\]\s*=/u.test(appSource)
      && /resolveSequenceSegmentDuration\(\s*planningSegmentDurationPreset,\s*planningCustomSegmentDuration,?\s*\)/u.test(analyzeSequenceSource)
      && plannerSource.includes('planningSegmentDurationPreset === item'),
  },
  {
    description: 'sequence timing labels must distinguish the planning target from a selected segment',
    passes:
      appSource.includes('? "每段目标时长"')
      && appSource.includes('? "每段目标秒数"')
      && appSource.includes('? "本段秒数"')
      && appSource.includes('disabled={productionMode === "sequence" && !sequenceSettingsOpen}')
      && /label=\{productionMode === "sequence" \? "本段镜头数" : "镜头数量"\}/u.test(appSource),
  },
  {
    description: 'plan confirmation must revalidate and invalid plans must disable the confirm action',
    passes:
      /validateSequencePlan\(activeSequencePlan,\s*\{[\s\S]*?requireMasterStoryboard:\s*true/u.test(confirmPlanSource)
      && confirmPlanSource.indexOf('validateSequencePlan(activeSequencePlan, {')
        < confirmPlanSource.indexOf('setSequenceStage("direct")')
      && plannerSource.includes('const planConfirmDisabled = Boolean(')
      && plannerSource.includes('planIssues.length')
      && /disabled=\{planConfirmDisabled\}\s*onClick=\{confirmSequencePlan\}/u.test(plannerSource),
  },
];
const missingSequencePlanningSpecs = sequencePlanningSpecChecks
  .filter(({ passes }) => !passes)
  .map(({ description }) => description);
assert.deepEqual(
  missingSequencePlanningSpecs,
  [],
  `sequence planner regressions: ${missingSequencePlanningSpecs.join('; ')}`,
);

for (const requiredSource of [
  'const sequencePlanInputFingerprint =',
  'sequencePlanSourceChanged(activeSequencePlan',
  'activeSequencePlanReadyForGeneration',
  '继续使用旧快照',
  '当前计划时长不足',
  '确认偏紧风险',
  'sequencePlanningAbortRef',
  'requestController.signal',
  'restoreSequenceSegmentSourceContent',
  'initialSequencePlan?.reviewConfirmedFingerprint || ""',
  'compressedRiskAcknowledgedFingerprint',
]) {
  assert.equal(
    appSource.includes(requiredSource),
    true,
    `long-story safety UI must retain ${requiredSource}`,
  );
}
for (const accessibleName of [
  '全片总秒数', '自定义单段秒数', '段标题', '本段秒数', '可拍摄摘要',
  '本段剧情正文', '入口状态', '出口状态', '段间转场',
]) {
  assert.match(
    plannerSource,
    new RegExp(`aria-label=["']${accessibleName}["']`, 'u'),
    `${accessibleName} must have an accessible name`,
  );
}
assert.match(
  plannerSource,
  /aria-pressed=\{durationMode === "ai-estimated"\}[\s\S]*aria-pressed=\{durationMode === "fixed"\}/u,
  'duration mode buttons must expose pressed state',
);
assert.doesNotMatch(
  appSource,
  /id="director-setup-(?:timing|look|motion)"[^>]*(?:role="tabpanel"|hidden=)/u,
  'director parameter groups must never be hidden behind tab panels',
);
assert.match(
  css,
  /\.job-card-header\s*\{[^}]*flex-wrap:\s*wrap/u,
  'generation task cards must wrap actions instead of overlapping at narrow widths',
);
assert.match(
  css,
  /\.prompt-validation\s*\{[^}]*overflow-wrap:\s*anywhere/u,
  'long provider errors must wrap instead of widening the generation task page',
);

assert.match(
  css,
  /\.asset-page-grid \.asset-info strong\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere/u,
  'asset names must wrap so the distinguishing storyboard and generation version are visible',
);

for (const selector of ['.asset-upload-controls', '.assets-toolbar-row', '.assets-toolbar-filters', '.assets-toolbar-actions']) {
  assert.equal(cssProperty(selector, 'min-width', `${selector} shrinking`), '0', 'asset controls must not widen their workspace');
  assert.equal(cssProperty(selector, 'flex-wrap', `${selector} wrapping`), 'wrap', 'desktop check/pager controls must wrap even above the old 1039px breakpoint');
}
assert.match(appSource, /className="row asset-upload-controls"/u);
assert.match(appSource, /className="row-between assets-toolbar-row"/u);
assert.match(appSource, /className="row assets-toolbar-filters"/u);
assert.match(appSource, /className="row assets-toolbar-actions"/u);
assert.equal(cssProperty('.assets-toolbar-filters > input', 'min-width', 'asset search shrinking'), '0');

for (const [selector, declaration] of [
  ['storyboard-shot-picker-list', 'grid-template-columns:\\s*minmax\\(0,\\s*1fr\\)'],
  ['storyboard-shot-picker-list', 'overflow-y:\\s*auto'],
  ['storyboard-shot-picker-item', 'grid-template-columns:\\s*16px\\s+5\\.5em\\s+minmax\\(0,\\s*1fr\\)'],
  ['storyboard-shot-description', 'white-space:\\s*normal'],
  ['storyboard-shot-description', 'overflow-wrap:\\s*anywhere'],
  ['storyboard-shot-picker-actions', 'flex-wrap:\\s*wrap'],
]) {
  assert.match(css, new RegExp(`\\.${selector}\\s*\\{[^}]*${declaration}`, 'u'), `${selector} must retain its long-description layout contract`);
}
assert.match(appSource, /className="storyboard-shot-index"/u);
assert.match(appSource, /className="storyboard-shot-description"/u);
assert.match(appSource, /aria-label=\{`选择第 \$\{shot\.index\} 镜`\}/u);
assert.match(appSource, /className="storyboard-shot-picker-count" role="status"/u);
assert.match(css, /\.storyboard-shot-picker-item:has\(input:focus-visible\)/u);

console.log('style accessibility regression checks passed');
