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
const minimumReadableScale = 0.82;

export function calculateSidebarFit(metrics: SidebarFitMetrics): SidebarFitLayout | null {
  const { availableWidth, availableHeight, naturalWidth, naturalHeight } = metrics;
  if (![availableWidth, availableHeight, naturalWidth, naturalHeight].every(finitePositive)) return null;
  // Leave a little room for fractional device-pixel/font rounding. Round down
  // only once, against the same natural coordinate system on every pass.
  const unconstrained = Math.floor(Math.min(
    1,
    Math.max(1, availableHeight - 2) / naturalHeight,
    Math.max(1, availableWidth - 2) / naturalWidth,
  ) * 1000) / 1000;
  const scale = Math.max(minimumReadableScale, unconstrained);
  return {
    scale,
    // A fit that still reaches 0.82 keeps the utility links at the bottom.
    // Below that, keep the natural height so the nav can scroll instead of
    // shrinking the labels further.
    contentHeight: unconstrained >= minimumReadableScale
      ? Math.floor(availableHeight / scale * 64) / 64
      : naturalHeight,
  };
}
