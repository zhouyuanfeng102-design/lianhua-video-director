import type { VideoTaskApiConfig } from './types';
import { getVideoApiModelParameterCapabilities } from './videoApiCapabilities';
import { genericVideoModelsEndpoint } from './genericVideoApi';

/** Only saved, scoped service responses can declare a generic API's capacity. */
export const getVideoApiImageCapacity = (api?: Partial<Pick<VideoTaskApiConfig, 'provider' | 'baseUrl' | 'endpoint' | 'statusEndpointTemplate' | 'model' | 'requestTemplate' | 'parameterCapabilities'>>) => {
  if (!api || api.provider && api.provider !== 'generic' || api.requestTemplate?.trim()) return undefined;
  const images = getVideoApiModelParameterCapabilities(api)?.imageReferences;
  if (!images) return undefined;
  return {
    ...images,
    fetchedAt: api.parameterCapabilities?.fetchedAt,
    sourceUrl: images.source === 'models'
      ? genericVideoModelsEndpoint({ baseUrl: api.baseUrl || '', endpoint: api.endpoint || '' })
      : api.parameterCapabilities?.sourceUrl,
  };
};
