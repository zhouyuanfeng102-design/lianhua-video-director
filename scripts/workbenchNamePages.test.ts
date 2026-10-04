import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workbenchNamePageForIndex, workbenchNamePageStarts } from '../src/workbenchNamePages';

assert.deepEqual(workbenchNamePageStarts([], 100, 5), [0]);
assert.deepEqual(workbenchNamePageStarts([49, 49, 49], 103, 5), [0, 2]);
assert.deepEqual(workbenchNamePageStarts([49, 100, 49, 70], 155, 5), [0, 2]);
assert.deepEqual(workbenchNamePageStarts([120, 50, 50], 110, 5), [0, 1]);
assert.deepEqual(workbenchNamePageStarts([49.1, 49.1], 104, 5), [0, 1]);
assert.deepEqual(workbenchNamePageStarts([49, 49], 0, 5), [0, 1]);
for (const height of [80, 100, 120, 170, 240]) {
  const heights = [49, 75, 65, 120, 49, 90, 49, 51, 60];
  const starts = workbenchNamePageStarts(heights, height, 5);
  const visited = starts.flatMap((start, page) => {
    const end = starts[page + 1] ?? heights.length;
    for (let index = start; index < end; index += 1) assert.equal(workbenchNamePageForIndex(starts, index), page);
    if (end - start > 1) assert.ok(heights.slice(start, end).reduce((sum, value) => sum + value, 0) + (end - start - 1) * 5 <= height);
    return heights.slice(start, end);
  });
  assert.deepEqual(visited, heights, 'resizing must not omit, duplicate, or reorder a source');
}
const css = readFileSync(new URL('../src/videoWorkbench.css', import.meta.url), 'utf8');
const titleRule = css.match(/\.vwb-source-copy strong\s*\{([^}]+)\}/u)?.[1] || '';
assert.match(titleRule, /white-space:\s*normal/u);
assert.match(titleRule, /overflow-wrap:\s*anywhere/u);
assert.doesNotMatch(titleRule, /ellipsis|nowrap|line-clamp|overflow:\s*hidden/u);
const view = readFileSync(new URL('../src/components/VideoWorkbenchView.tsx', import.meta.url), 'utf8');
assert.match(view, /sourcePages = useWorkbenchNamePages\(filteredVideos\)/u);
assert.match(view, /clipPages = usePagedItems\(draft\.clips\)/u, 'timeline keeps its fixed-height/global-index pagination');
const hook = readFileSync(new URL('../src/useWorkbenchNamePages.ts', import.meta.url), 'utf8');
assert.match(hook, /\[element, namesKey\]/u, 'same-count renames remeasure; playback updates do not');
assert.match(hook, /ResizeObserver/u);
assert.match(hook, /MutationObserver/u);
assert.doesNotMatch(hook, /createElement\('(video|img|button|input)'\)/u, 'measurement must not load media or expose duplicate controls');
console.log('Workbench full-name pagination checks passed.');
