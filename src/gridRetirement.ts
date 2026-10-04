import type { Workflow } from './types';

/** Creation controls only. Never apply these mappings to saved assets, tasks,
 * storyboards or confirmed fingerprints: their legacy grid identity is data. */
export const activeDirectorWorkflow = (workflow?: Workflow): Workflow => (
  workflow === 'action' ? 'action' : 'drama'
);

type ImageAssetKind = 'character' | 'location' | 'prop' | 'grid';
export const activeImageAssetKind = (kind?: ImageAssetKind): ImageAssetKind => (
  kind === 'location' || kind === 'prop' ? kind : 'character'
);

export const GRID_CREATION_RETIRED_MESSAGE = '九宫格新建流程已停用；历史提示词、素材和任务仍保留。请使用智能导演新建提示词，在“分镜图片数量”填写9可生成9张独立画面，不需要九宫格母版。';
