const MANAGED_ASSET_PREFIX = 'lianhua-asset://local/';

/** Resolve pixels/audio only at the display boundary. Persisted asset and
 * task URLs keep their canonical desktop protocol on every platform. */
export const mapManagedAssetDisplayUrl = (
  source: string,
  android = typeof window !== 'undefined' && window.lianhuaPlatform === 'android',
): string => {
  if (!android || !source.startsWith(MANAGED_ASSET_PREFIX)) return source;
  const local = new URL(source);
  return `https://localhost/_lianhua_asset${local.pathname}${local.search}${local.hash}`;
};
