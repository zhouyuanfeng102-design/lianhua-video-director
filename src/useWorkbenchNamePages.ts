import { useLayoutEffect, useState } from 'react';
import { workbenchNamePageForIndex, workbenchNamePageStarts } from './workbenchNamePages';

/** Measure names independently of the visible page, so turning pages cannot change their breaks. */
export function useWorkbenchNamePages<T extends { id: string; name: string }>(items: T[]) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [starts, setStarts] = useState([0]);
  const [nameSizes, setNameSizes] = useState<Record<string, number>>({});
  const [wideNames, setWideNames] = useState<Set<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string>();
  // Playback/probe updates recreate assets. Only a name/order change needs text measurement.
  const namesKey = JSON.stringify(items.map(({ id, name }) => [id, name]));
  useLayoutEffect(() => {
    if (!element) return;
    const names = JSON.parse(namesKey) as [string, string][];
    const panel = element.closest<HTMLElement>('.vwb-sources');
    const column = element.closest<HTMLElement>('.vwb-library-column');
    const shell = element.closest('.app-shell');
    let metricsKey = '';
    let heights: number[] = [];
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const style = getComputedStyle(element);
      const overhead = panel ? Math.round(panel.getBoundingClientRect().height - rect.height) : 0;
      const maxRowHeight = column ? Math.max(49, Math.floor(column.getBoundingClientRect().height - overhead - 120)) : rect.height;
      const nextKey = [rect.width.toFixed(2), maxRowHeight, style.getPropertyValue('--ui-font-scale'), style.fontFamily].join('|');
      if (nextKey !== metricsKey) {
        // A single hidden layout pass: no media, inputs, event handlers, or duplicate accessible names.
        const measuring = document.createElement('div');
        measuring.className = 'vwb-source-measurements';
        measuring.setAttribute('aria-hidden', 'true');
        for (const [, name] of names) {
          const row = document.createElement('div'); row.className = 'vwb-source-measure';
          const copy = document.createElement('div'); copy.className = 'vwb-source-copy';
          const title = document.createElement('strong'); title.textContent = name;
          const detail = document.createElement('small'); detail.textContent = '0:15.08 · 1024×640';
          copy.append(title, detail); row.append(copy); measuring.append(row);
        }
        element.append(measuring);
        const rows = Array.from(measuring.children) as HTMLElement[];
        const sizes: Record<string, number> = {};
        // Only exceptionally long names in short windows shrink, and never below
        // a readable 10 CSS pixels. Typical names still follow the user's font setting.
        let oversized = rows.filter((row) => row.getBoundingClientRect().height > maxRowHeight);
        while (oversized.length) {
          for (const row of oversized) {
            const title = row.querySelector('strong')!;
            const size = Math.max(10, Number.parseFloat(getComputedStyle(title).fontSize) - .5);
            title.style.fontSize = size + 'px';
            sizes[names[rows.indexOf(row)][0]] = size;
          }
          oversized = oversized.filter((row) => Number.parseFloat(row.querySelector('strong')!.style.fontSize) > 10 && row.getBoundingClientRect().height > maxRowHeight);
        }
        // Extra-long imported filenames get the whole card width above the
        // controls. Only this compact fallback may go below 10px (8px minimum).
        const wide = new Set<string>();
        oversized = rows.filter((row) => row.getBoundingClientRect().height > maxRowHeight);
        for (const row of oversized) {
          row.classList.add('vwb-source--full-width-name');
          wide.add(names[rows.indexOf(row)][0]);
        }
        oversized = oversized.filter((row) => row.getBoundingClientRect().height > maxRowHeight);
        while (oversized.length) {
          for (const row of oversized) {
            const title = row.querySelector('strong')!;
            const size = Math.max(8, Number.parseFloat(getComputedStyle(title).fontSize) - .5);
            title.style.fontSize = size + 'px';
            sizes[names[rows.indexOf(row)][0]] = size;
          }
          oversized = oversized.filter((row) => Number.parseFloat(row.querySelector('strong')!.style.fontSize) > 8 && row.getBoundingClientRect().height > maxRowHeight);
        }
        heights = Array.from(measuring.children, (row) => row.getBoundingClientRect().height);
        measuring.remove();
        setNameSizes((previous) => JSON.stringify(previous) === JSON.stringify(sizes) ? previous : sizes);
        setWideNames((previous) => previous.size === wide.size && [...wide].every((id) => previous.has(id)) ? previous : wide);
        metricsKey = nextKey;
      }
      // A very long name may need more than the usual 60% library share. The minimum
      // depends on all names, never on the current page, and leaves the preview visible.
      if (panel && column) {
        const required = Math.ceil(panel.getBoundingClientRect().height - rect.height + heights.reduce((max, height) => Math.max(max, height), 0));
        const value = required + 'px';
        if (column.style.getPropertyValue('--vwb-source-required-height') !== value) column.style.setProperty('--vwb-source-required-height', value);
      }
      const next = workbenchNamePageStarts(heights, Math.floor(rect.height), Number.parseFloat(style.rowGap) || 0);
      setStarts((previous) => previous.length === next.length && previous.every((start, index) => start === next[index]) ? previous : next);
    };
    measure();
    const resize = new ResizeObserver(measure); resize.observe(element);
    const scale = new MutationObserver(measure);
    if (shell) scale.observe(shell, { attributes: true, attributeFilter: ['style', 'data-ui-font-scale'] });
    return () => { resize.disconnect(); scale.disconnect(); };
  }, [element, namesKey]);
  // Keep the first visible item in view when a resize changes page capacity.
  const validStarts = starts.filter((start) => start < Math.max(1, items.length));
  const page = workbenchNamePageForIndex(validStarts, Math.max(0, items.findIndex((item) => item.id === anchorId)));
  return {
    listRef: setElement, page, pageCount: validStarts.length, nameSizes, wideNames,
    setPage: (value: number) => setAnchorId(value <= 0 ? undefined : items[validStarts[Math.min(value, validStarts.length - 1)]]?.id),
    revealIndex: (index: number) => setAnchorId(items[Math.max(0, index)]?.id),
    items: items.slice(validStarts[page], validStarts[page + 1] ?? items.length),
  };
}
