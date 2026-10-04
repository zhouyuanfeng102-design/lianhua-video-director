/** The inputs must all be measured at zoom: 1. Never feed the previous
 * rendered/rounded card dimensions back into the next fit calculation. */
export interface SidebarFitMetrics {
  availableWidth: number;
  availableHeight: number;
  naturalWidth: number;
  naturalHeight: number;
}

export interface SidebarFitLayout {
  scale: number;
  contentHeight: number;
}

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

export function calculateSidebarFit(metrics: SidebarFitMetrics): SidebarFitLayout | null {
  const { availableWidth, availableHeight, naturalWidth, naturalHeight } = metrics;
  if (![availableWidth, availableHeight, naturalWidth, naturalHeight].every(finitePositive)) return null;
  // Leave a little room for fractional device-pixel/font rounding. Round down
  // only once, against the same natural coordinate system on every pass.
  const scale = Math.max(0.001, Math.floor(Math.min(
    1,
    Math.max(1, availableHeight - 2) / naturalHeight,
    Math.max(1, availableWidth - 2) / naturalWidth,
  ) * 1000) / 1000);
  return {
    scale,
    // Keep the utility links at the bottom without exceeding the viewport
    // when Chromium rounds CSS lengths to 1/64 px.
    contentHeight: Math.floor(availableHeight / scale * 64) / 64,
  };
}
