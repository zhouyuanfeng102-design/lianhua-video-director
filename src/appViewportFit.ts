/** Desktop layout the window is opened at. A smaller laptop keeps this
 * arrangement and scales the whole shell down to the window. */
export const APP_FIT_DESIGN_WIDTH = 1280;
export const APP_FIT_DESIGN_HEIGHT = 800;

export const MOBILE_APP_MAX_WIDTH = 600;

export function isMobileAppViewport(width: number, height: number, nativeAndroid = false, coarsePointer = false): boolean {
  return nativeAndroid || width <= MOBILE_APP_MAX_WIDTH
    || (coarsePointer && width <= 960 && height <= MOBILE_APP_MAX_WIDTH);
}

export interface AppViewportFit {
  scale: number;
  layoutWidth: number;
  layoutHeight: number;
}

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

/** Scale is 1 when the window already holds the design size. Below that, the
 * layout stays at least 1280×800 and zoom brings it back to the real window. */
export function calculateAppViewportFit(viewportWidth: number, viewportHeight: number): AppViewportFit | null {
  if (!finitePositive(viewportWidth) || !finitePositive(viewportHeight)) return null;
  const scale = Math.floor(Math.min(
    1,
    viewportWidth / APP_FIT_DESIGN_WIDTH,
    viewportHeight / APP_FIT_DESIGN_HEIGHT,
  ) * 1000) / 1000;
  if (scale >= 1) return { scale: 1, layoutWidth: viewportWidth, layoutHeight: viewportHeight };
  return {
    scale,
    layoutWidth: viewportWidth / scale,
    layoutHeight: viewportHeight / scale,
  };
}
