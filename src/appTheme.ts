export type AppColorMode = 'light' | 'dark' | 'system';
export type AppColorTheme = 'classic' | 'lotus' | 'blue' | 'jade' | 'amber' | 'violet';

export const appColorModes: ReadonlyArray<{ id: AppColorMode; name: string }> = [
  { id: 'light', name: '日间' },
  { id: 'dark', name: '夜间' },
  { id: 'system', name: '跟随系统' },
];

export const appColorThemes: ReadonlyArray<{ id: AppColorTheme; name: string; accent: string; background: string }> = [
  { id: 'classic', name: '经典原色', accent: '#c84f86', background: '#f2f4f7' },
  { id: 'lotus', name: '莲华粉', accent: '#c84f86', background: '#f6f1f5' },
  { id: 'blue', name: '湖蓝', accent: '#2865ab', background: '#eff4f9' },
  { id: 'jade', name: '青竹', accent: '#227556', background: '#eff5f1' },
  { id: 'amber', name: '暖砂', accent: '#976322', background: '#f7f3ec' },
  { id: 'violet', name: '紫藤', accent: '#7151a5', background: '#f3f0f8' },
];

/** Legacy "ink" was displayed as the light UI; keep that appearance on restore. */
export function normalizeAppColorMode(value: unknown): AppColorMode {
  return value === 'dark' || value === 'system' ? value : 'light';
}

export function normalizeAppColorTheme(value: unknown): AppColorTheme {
  return appColorThemes.some((theme) => theme.id === value) ? value as AppColorTheme : 'classic';
}

export function resolveAppColorMode(mode: AppColorMode, systemDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? systemDark ? 'dark' : 'light' : mode;
}
