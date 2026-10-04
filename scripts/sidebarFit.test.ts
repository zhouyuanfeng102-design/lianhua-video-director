import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateSidebarFit, type SidebarFitMetrics } from '../src/sidebarFit';

const fit = (input: SidebarFitMetrics) => {
  const result = calculateSidebarFit(input);
  assert.ok(result);
  return result;
};
const base = { availableWidth: 173, availableHeight: 640, naturalWidth: 167, naturalHeight: 704 };

assert.equal(fit({ ...base, availableHeight: 900 }).scale, 1, 'a tall window must release its previous shrink');
assert.equal(fit(base).scale, 0.906, 'height fit rounds down with a 2 px safety margin');
assert.equal(fit({ ...base, naturalWidth: 220, availableHeight: 900 }).scale, 0.777, 'large text must also fit horizontally');

let combinations = 0;
for (const availableWidth of [167, 173, 173 + 1 / 64]) {
  for (const availableHeight of [215.25, 345 + 1 / 64, 499.5, 576.5, 640, 777.5]) {
    for (const fontScale of [1, 1.3, 1.5]) {
      for (const errorHeight of [0, 14, 17.5]) {
        // Fixed icon/card heights plus proportional labels and error metadata.
        const naturalHeight = 588 + 72 * fontScale + errorHeight;
        const naturalWidth = 82 + 72 * fontScale;
        const metrics = { availableWidth, availableHeight, naturalHeight, naturalWidth };
        const result = fit(metrics);
        assert.ok(result.scale > 0 && result.scale <= 1);
        assert.ok(naturalHeight * result.scale <= availableHeight - 2 + 1e-9, 'every card and bottom utility must fit');
        assert.ok(naturalWidth * result.scale <= availableWidth - 2 + 1e-9, 'every label must fit');
        assert.ok(result.contentHeight * result.scale <= availableHeight + 1e-9, 'bottom alignment must not overflow the nav');
        assert.ok(availableHeight - result.contentHeight * result.scale < 1 / 64 + 1e-9, 'only subpixel bottom slack is allowed');
        // 60 consecutive frames at integer/fractional DPI must select the
        // exact same fit: rasterized previous card dimensions are not inputs.
        for (const deviceScale of [1, 1.25, 1.5, 2.25]) {
          let previous = result;
          for (let frame = 0; frame < 60; frame += 1) {
            const rasterizedCardHeight = Math.round(48 * previous.scale * deviceScale) / deviceScale;
            assert.ok(rasterizedCardHeight > 0);
            previous = fit(metrics);
            assert.deepEqual(previous, result, 'fractional rasterization must not feed back into the next scale');
          }
        }
        combinations += 1;
      }
    }
  }
}

const stableFit = fit(base);
for (const availableHeight of [345, 799, 576.5, 215.25, 900, 640]) {
  fit({ ...base, availableHeight });
  assert.deepEqual(fit(base), stableFit, 'resize history must never trap the sidebar at a stale smaller/larger scale');
}
assert.ok(fit({ ...base, availableHeight: 580 }).scale < stableFit.scale, 'showing a taller footer must reserve its space');
assert.ok(fit({ ...base, naturalHeight: base.naturalHeight + 18 }).scale < stableFit.scale, 'showing the latest error must fit without hiding utility entries');
for (const value of [0, -1, NaN, Infinity, -Infinity]) {
  for (const key of Object.keys(base) as Array<keyof SidebarFitMetrics>) {
    assert.equal(calculateSidebarFit({ ...base, [key]: value }), null, 'hidden or invalid metrics must not write invalid CSS');
  }
}

const source = readFileSync(new URL('../src/components/AutoFitSidebarNav.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const resetIndex = source.indexOf("content.style.setProperty('zoom', '1')");
assert.ok(resetIndex > 0 && resetIndex < source.indexOf('const naturalHeight = content.getBoundingClientRect().height'),
  'live measurements must establish zoom:1 before reading natural sizes');
assert.match(source, /content\.style\.height = 'auto';[\s\S]*const naturalHeight/u, 'natural measurement must exclude the utility auto-margin spacer');
assert.doesNotMatch(source, /observer\.observe\(content\)|observer\.observe\(child\)|appliedScale|offsetHeight|label\.clientWidth/u,
  'fit output/rounded previous geometry must never be a ResizeObserver input');
assert.match(source, /mutations\.observe\(content,\s*\{[\s\S]*?attributeFilter: \['class', 'hidden'\]/u,
  'DOM edits must trigger measurement without observing our own style writes');
assert.match(source, /attributeFilter: \['style', 'class', 'data-ui-font-scale'\]/u, 'global font changes must invalidate the fit');
assert.match(source, /document\.fonts\?\.addEventListener\('loadingdone', schedule\)/u, 'late loaded fonts must invalidate the natural measurement');
assert.match(source, /observer\.disconnect\(\);[\s\S]*mutations\.disconnect\(\)/u, 'unmount must disconnect both observers');
assert.match(css, /\.nav\.sidebar-nav-fit\s*\{[^}]*contain:\s*size/u, 'scaled content must not affect the nav allocation');
assert.match(css, /\.sidebar > \.brand, \.sidebar > \.sidebar-footer\s*\{[^}]*flex-shrink:\s*0/u,
  'branding and the project/footer must retain their actual reserved heights');
const navItemStyle = css.match(/\.nav-item\s*\{(?<body>[^}]*)\}/u)?.groups?.body || '';
assert.match(navItemStyle, /transition:\s*color /u);
assert.doesNotMatch(navItemStyle, /transition:\s*(?:all|\.\d|\d)/u,
  'breakpoint card dimensions must not animate while their natural sizes are measured');

console.log(`sidebar fit regression checks passed (${combinations} geometry/font/error cases, 38,880 steady-state frames)`);
