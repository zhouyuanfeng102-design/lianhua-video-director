import type { AppSettings, VideoTaskApiConfig } from './types';
import type { VideoApiParameterCapabilities } from './videoApiCapabilityTypes';
import { videoApiCapabilityScope } from './videoApiCapabilities';

/** In-memory request identity only. This value contains a key and must not be persisted. */
export const videoApiParameterReadIdentity = (config: VideoTaskApiConfig): string => JSON.stringify([
  config.provider || 'generic', config.baseUrl || '', config.endpoint, config.statusEndpointTemplate,
  config.apiKey, config.authHeader, config.authScheme, config.model || '',
]);

export const applyVideoApiParameterCapabilities = (
  settings: AppSettings, profileId: string | undefined, expected: VideoTaskApiConfig,
  capabilities: VideoApiParameterCapabilities,
): AppSettings => {
  const target = profileId ? settings.videoApiProfiles?.find((profile) => profile.id === profileId) : settings.videoTaskApi;
  if (!target || videoApiParameterReadIdentity(target) !== videoApiParameterReadIdentity(expected)
    || videoApiCapabilityScope(target) !== capabilities.scope) return settings;
  const active = !profileId || profileId === settings.activeVideoApiProfileId;
  const selectedProfileId = profileId || settings.activeVideoApiProfileId;
  return {
    ...settings,
    ...(active ? { videoTaskApi: { ...settings.videoTaskApi, parameterCapabilities: structuredClone(capabilities) } } : {}),
    videoApiProfiles: settings.videoApiProfiles?.map((profile) => profile.id === selectedProfileId
      ? { ...profile, parameterCapabilities: structuredClone(capabilities), updatedAt: Date.now() } : profile),
  };
};
