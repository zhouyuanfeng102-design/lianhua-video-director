/** Complete variable-height rows, kept in source order; no item is split or dropped. */
export function workbenchNamePageStarts(heights: readonly number[], availableHeight: number, gap: number): number[] {
  const starts = [0];
  let used = 0;
  for (let index = 0; index < heights.length; index += 1) {
    const height = Math.max(1, Math.ceil(heights[index] || 1));
    const next = used ? used + Math.max(0, gap) + height : height;
    if (used && next > Math.max(0, availableHeight)) {
      starts.push(index);
      used = height;
    } else used = next;
  }
  return starts;
}

export function workbenchNamePageForIndex(starts: readonly number[], index: number): number {
  let page = 0;
  while (page + 1 < starts.length && starts[page + 1] <= index) page += 1;
  return page;
}
