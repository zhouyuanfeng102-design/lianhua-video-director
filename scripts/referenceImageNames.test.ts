import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferenceImageName, referenceImageNameUnits } from '../src/components/ReferenceImageName';

assert.equal(referenceImageNameUnits(''), 1, 'empty names never produce a zero divisor');
assert.equal(referenceImageNameUnits('abc'), 1.65);
assert.equal(referenceImageNameUnits('参考图'), 3);
assert.equal(referenceImageNameUnits('A 段'), 1.9);
assert.equal(referenceImageNameUnits('cafe\u0301'), referenceImageNameUnits('cafe'), 'combining marks do not add a whole character width');
assert.equal(referenceImageNameUnits('山'.repeat(1000)), 1000, 'long names are not capped or sliced');

const names = [
  '首帧',
  '51321 · 方案 O9JET1 · 夜色下山门至城镇街市三人并肩行进交接药草 · 第 23 段 · 第 9 镜',
  `${'UnbrokenEnglishReferenceImageName'.repeat(6)}_Segment_27_Shot_9`,
  `${'非常长的参考图名称'.repeat(50)} · 第 128 段 · 第 96 镜`,
  '人物🌙原始形态 · 第 4 段',
];
for (const name of names) {
  const html = renderToStaticMarkup(createElement(ReferenceImageName, { name }));
  assert.ok(html.includes(`>${name}</strong>`), 'visible text must preserve the entire name, including the final segment and shot');
  assert.ok(html.includes('class="reference-image-name-text"'));
  assert.ok(html.includes(`--reference-name-units:${referenceImageNameUnits(name)}`));
  assert.ok(!html.includes('…'), 'the display component must not introduce an ellipsis');
}
const escaped = renderToStaticMarkup(createElement(ReferenceImageName, { name: 'A & <B> "第 7 段"' }));
assert.ok(escaped.includes('>A &amp; &lt;B&gt; &quot;第 7 段&quot;</strong>'), 'React must still escape names as text');

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const directorCss = readFileSync(new URL('../src/videoDirector.css', import.meta.url), 'utf8');
const nameStyle = styles.match(/\.reference-image-name-text\s*\{([^}]+)\}/)?.[1] || '';
assert.match(styles, /\.reference-image-name\s*\{[^}]*container-type:\s*inline-size;/, 'resize from each actual card, not the viewport');
assert.match(nameStyle, /white-space:\s*normal;/);
assert.match(nameStyle, /overflow-wrap:\s*anywhere;/, 'unbroken filenames must wrap');
assert.doesNotMatch(nameStyle, /ellipsis|line-clamp|overflow:\s*hidden|(?:^|[;\s])(?:max-)?height:/, 'complete names must be free to grow vertically');
assert.match(styles, /font-size:\s*clamp\(calc\(10px \* var\(--ui-font-scale, 1\)\), calc\(300cqw \/ var\(--reference-name-units, 1\)\), calc\(11px \* var\(--ui-font-scale, 1\)\)\)/, 'adaptive sizing keeps a legible floor and honors the user font scale');
assert.doesNotMatch(directorCss, /\.vd-(?:reference-info|image-pick) strong\s*\{[^}]*ellipsis/, 'legacy truncation rules must not override the shared component');
const footerStyle = styles.match(/\.reference-image-picker-footer > \.field-hint\s*\{([^}]+)\}/)?.[1] || '';
assert.doesNotMatch(footerStyle, /ellipsis|nowrap|overflow:\s*hidden/);

console.log('Reference image full-name, adaptive sizing, escaping and no-truncation checks passed.');
