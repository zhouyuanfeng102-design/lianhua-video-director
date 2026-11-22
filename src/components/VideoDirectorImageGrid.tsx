import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ReferenceAsset } from '../types';

interface GridProps {
  assets: readonly ReferenceAsset[];
  query: string;
  revision: object;
  scrollPosition: { current: number };
  render: (asset: ReferenceAsset) => ReactNode;
}

/** Window only the DOM. Search results and selected original assets remain complete. */
export const VideoDirectorImageGrid = memo(function VideoDirectorImageGrid({ assets, query, revision: _revision, scrollPosition, render }: GridProps) {
  const host = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<number, number>());
  const previousQuery = useRef(query);
  const [measurement, setMeasurement] = useState(0);
  const [viewport, setViewport] = useState({ columns: 1, height: 500, top: 0, gap: 10 });
  const offsets = [0];
  const count = Math.ceil(assets.length / viewport.columns);
  for (let index = 0; index < count; index += 1) offsets.push(offsets[index] + (heights.current.get(index) || 230) + viewport.gap);
  let first = 0;
  while (first + 1 < count && offsets[first + 1] < viewport.top) first += 1;
  let last = first;
  while (last < count && offsets[last] < viewport.top + viewport.height) last += 1;
  const from = Math.max(0, first - 2), to = Math.min(count, last + 2);

  useLayoutEffect(() => {
    const grid = host.current;
    const root = grid?.closest<HTMLElement>('.vd-batch-dialog-body');
    if (!grid || !root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const style = getComputedStyle(grid);
      const gap = parseFloat(style.getPropertyValue('--vd-image-grid-gap')) || 10;
      const minWidth = parseFloat(style.getPropertyValue('--vd-image-card-min-width')) || 140;
      const columns = Math.max(1, Math.floor((grid.clientWidth + gap) / (minWidth + gap)));
      const top = Math.max(0, root.getBoundingClientRect().top + root.clientTop - grid.getBoundingClientRect().top);
      scrollPosition.current = root.scrollTop;
      setViewport((previous) => {
        if (previous.columns !== columns) heights.current.clear();
        return previous.columns === columns && previous.height === root.clientHeight && Math.abs(previous.top - top) < .5 && previous.gap === gap
          ? previous : { columns, height: root.clientHeight, top, gap };
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    root.scrollTop = scrollPosition.current;
    update();
    // The grid's own height changes when a card is selected. Watching that
    // box feeds the new height back into the window and shifts the header.
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    resize?.observe(root);
    root.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => { resize?.disconnect(); root.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); if (frame) cancelAnimationFrame(frame); };
  }, [scrollPosition]);

  useLayoutEffect(() => {
    const grid = host.current;
    const root = grid?.closest<HTMLElement>('.vd-batch-dialog-body');
    if (previousQuery.current === query) return;
    previousQuery.current = query;
    heights.current.clear();
    if (root) { root.scrollTop = 0; scrollPosition.current = 0; }
    setViewport((previous) => previous.top ? { ...previous, top: 0 } : previous);
    setMeasurement((value) => value + 1);
  }, [query]);

  useLayoutEffect(() => {
    const grid = host.current;
    if (!grid) return;
    const measure = () => {
      let changed = false;
      for (const row of grid.querySelectorAll<HTMLElement>('[data-image-row]')) {
        const index = Number(row.dataset.imageRow);
        const height = row.getBoundingClientRect().height;
        if (height > 0 && Math.abs((heights.current.get(index) || 0) - height) > .5) { heights.current.set(index, height); changed = true; }
      }
      if (changed) setMeasurement((value) => value + 1);
    };
    measure();
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    for (const row of grid.querySelectorAll<HTMLElement>('[data-image-row]')) resize?.observe(row);
    return () => resize?.disconnect();
  }, [from, to, viewport.columns, assets, measurement]);

  return <div ref={host} className="vd-image-picker-grid vd-batch-image-grid vd-windowed-image-grid" data-image-total={assets.length}>
    <div aria-hidden="true" style={{ height: offsets[from] || 0 }} />
    {Array.from({ length: to - from }, (_, offset) => {
      const index = from + offset;
      return <div className="vd-windowed-image-row" data-image-row={index} key={index}
        style={{ gridTemplateColumns: `repeat(${viewport.columns}, minmax(0, 1fr))`, marginBottom: viewport.gap }}>
        {assets.slice(index * viewport.columns, (index + 1) * viewport.columns).map((asset) => <div className="vd-windowed-image-cell" key={asset.id}>{render(asset)}</div>)}
      </div>;
    })}
    <div aria-hidden="true" style={{ height: Math.max(0, offsets[count] - (offsets[to] || 0)) }} />
    {!assets.length && <div className="vd-empty">没有匹配的图片，可先在图片资产库导入。</div>}
  </div>;
});
