import type { VideoTaskApiConfig } from './types';

type LegacyFileConfig = Pick<VideoTaskApiConfig, 'provider' | 'baseUrl' | 'endpoint' | 'requestTemplate' | 'fileIdPath' | 'fileEndpointTemplate' | 'fileUrlPath'>;
const formerMiniMaxFileEndpoint = 'https://api.minimaxi.com/v1/files/retrieve?file_id={id}';

/** V2.1.8 address switching left this exact former provider mapping behind. */
export const hasObsoleteVideoFileMapping = (config: LegacyFileConfig): boolean => {
  if (config.provider && config.provider !== 'generic' || typeof config.baseUrl !== 'string' || !config.baseUrl.trim()
    || typeof config.requestTemplate === 'string' && config.requestTemplate.trim()) return false;
  if (typeof config.fileEndpointTemplate !== 'string' || config.fileEndpointTemplate.trim() !== formerMiniMaxFileEndpoint
    || config.fileIdPath !== 'file_id' || config.fileUrlPath !== 'file.download_url') return false;
  try {
    const target = new URL(config.endpoint.trim() || config.baseUrl.trim());
    if (!/^https?:$/u.test(target.protocol) || /(?:^|\.)minimaxi\.com$|(?:^|\.)minimax\.io$/iu.test(target.hostname)) return false;
    return !config.endpoint.trim() || /\/videos\/?$/u.test(target.pathname);
  } catch { return false; }
};

/** Repair connection settings only; historical task snapshots are immutable. */
export const repairLegacyVideoApiConfig = <T extends LegacyFileConfig>(config: T): T => {
  if (!hasObsoleteVideoFileMapping(config)) return config;
  const next = { ...config };
  delete next.fileIdPath;
  delete next.fileEndpointTemplate;
  delete next.fileUrlPath;
  return next;
};

/** Frozen affected tasks must never query the former provider with this key. */
export const videoApiFileQueryEndpoint = (config: LegacyFileConfig): string =>
  hasObsoleteVideoFileMapping(config) ? '' : config.fileEndpointTemplate || '';
