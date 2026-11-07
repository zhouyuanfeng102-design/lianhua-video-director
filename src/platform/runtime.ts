import { Capacitor } from '@capacitor/core';

export type LianhuaPlatform = 'android' | 'desktop' | 'web';

declare global {
  interface Window {
    lianhuaPlatform?: LianhuaPlatform;
  }
}

/** Native capability detection also applies when a phone is in landscape. */
export const isAndroidRuntime = (): boolean => (
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
);

export const currentPlatform = (): LianhuaPlatform => (
  isAndroidRuntime() ? 'android' : typeof window !== 'undefined' && window.lianhuaDesktop ? 'desktop' : 'web'
);

