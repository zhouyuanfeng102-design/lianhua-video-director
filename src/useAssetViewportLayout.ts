import { useLayoutEffect, useState, type CSSProperties } from "react";

/** Reserve room for the real controls, then fit complete cards into the remaining viewport. */
export function useAssetViewportLayout(enabled: boolean, total: number, fontScalePercent: number) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState({ columns: 4, rows: 2, detailHeight: 120 });
  useLayoutEffect(() => {
    if (!enabled || !element) return;
    let frame = 0;
    const scale = fontScalePercent / 100;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      const gap = Number.parseFloat(getComputedStyle(element).gap) || 10;
      const columns = Math.max(1, Math.min(4, Math.floor((width + gap) / (240 * scale + gap))));
      const infoHeight = Math.max(150 * scale, ...Array.from(element.querySelectorAll<HTMLElement>(".asset-info"),
        (info) => info.getBoundingClientRect().height));
      const minimumHeight = infoHeight + 86 * scale + 2;
      const rows = Math.max(1, Math.min(3, Math.ceil(Math.max(1, total) / columns),
        Math.floor((height + gap) / (minimumHeight + gap))));
      const detailHeight = Math.max(40, Math.min(180, Math.floor((height - gap * (rows - 1)) / rows - infoHeight + 24)));
      setLayout((current) => current.columns === columns && current.rows === rows && current.detailHeight === detailHeight
        ? current : { columns, rows, detailHeight });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    const observeControls = () => {
      resize.disconnect();
      resize.observe(element);
      element.querySelectorAll(".asset-info").forEach((info) => resize.observe(info));
      schedule();
    };
    const children = new MutationObserver(observeControls);
    children.observe(element, { childList: true });
    observeControls();
    measure();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); children.disconnect(); };
  }, [element, enabled, total, fontScalePercent]);
  return {
    gridRef: setElement,
    pageSize: enabled ? layout.columns * layout.rows : 8,
    rows: layout.rows,
    columns: layout.columns,
    style: enabled ? {
      "--asset-columns": layout.columns,
      "--asset-rows": layout.rows,
      "--asset-detail-height": `${layout.detailHeight}px`,
    } as CSSProperties : undefined,
  };
}
