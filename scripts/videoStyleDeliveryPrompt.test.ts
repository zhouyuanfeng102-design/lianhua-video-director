import assert from 'node:assert/strict';
import { convertStoryboardDraftToFinal } from '../src/appEffects';
import { H3_FINAL_BODY_FORMAT_RULE } from '../src/h3PromptProtocol';
import { seedanceChineseWriterRule } from '../src/seedancePromptRules';
import { selectedVideoStyleFields, VIDEO_SELECTED_STYLE_DELIVERY_RULE } from '../src/videoConversionRules';
import type { ConverterPreset, Storyboard, VideoShot } from '../src/types';

assert.deepEqual(selectedVideoStyleFields({ visualStyle: '  ', directorStyleSummary: '' }), {});
assert.deepEqual(selectedVideoStyleFields({
  visualStyle: ' 精细3D电影CG，古风仙侠写实 ',
  directorStyleSummary: ' 克制私密的长镜调度 ',
}), {
  selectedPictureStyle: '精细3D电影CG，古风仙侠写实',
  selectedDirectorStyle: '克制私密的长镜调度',
});
assert.match(VIDEO_SELECTED_STYLE_DELIVERY_RULE, /首镜光影/);
assert.match(VIDEO_SELECTED_STYLE_DELIVERY_RULE, /不改标为视觉风格参考/);
assert.match(H3_FINAL_BODY_FORMAT_RULE, /\[Shot 1\] 之前写用户已选画面风格和导演调度/);
assert.match(seedanceChineseWriterRule(), /selectedPictureStyle 与 selectedDirectorStyle/);
assert.match(seedanceChineseWriterRule(), /不改镜数、机位和运镜/);

const shot: VideoShot = {
  id: 'shot-style',
  index: 1,
  startSec: 0,
  endSec: 5,
  subject: '韩立',
  action: '站在石亭里',
  purpose: '开场',
  space: '石亭',
  direction: '面向石桌',
  performance: '站立',
  camera: '中景固定',
  transition: '无',
  lighting: '白昼天光',
  sound: '无',
  result: '仍站着',
  prompt: '',
  referenceAssetIds: [],
  locked: false,
};
const converter: ConverterPreset = {
  id: 'style-delivery-converter',
  name: '风格传递测试',
  workflow: 'all',
  inputMode: 'all',
  scope: 'video',
  systemPrompt: '',
  outputRules: '',
  enabled: true,
  version: 'test',
  updatedAt: 1,
};
const board = (visualStyle: string, directorStyleSummary: string): Storyboard => ({
  id: 'board-style',
  sceneId: 'scene',
  sourceStoryTitle: '石亭',
  sourceStoryContent: '韩立站在石亭里。',
  workflow: 'drama',
  inputMode: 'text',
  durationSec: 5,
  durationPreset: 'custom',
  shotMode: 'exact',
  shotCount: 1,
  pace: 'standard',
  aspectRatio: '16:9',
  resolution: '1080p',
  audioMode: 'none',
  stylePresetId: 'style_cinema',
  ruleSetId: '',
  converterPresetId: converter.id,
  globalLock: '',
  shots: [shot],
  finalPrompt: '【0s-5s】 主体：@韩立正在 [站在石亭里]；空间：石亭；光影：白昼天光；镜头：中景固定；台词：无；音效：无',
  visualStyle,
  directorStyleSummary,
  createdAt: 1,
  updatedAt: 1,
});

let captured = '';
await convertStoryboardDraftToFinal({
  draft: board('精细3D电影CG，古风仙侠写实', '克制私密的长镜调度'),
  converter,
  clean: (value) => value.trim(),
  request: async (system, user) => {
    captured = `${system}\n${user}`;
    return board('', '').finalPrompt;
  },
}).catch(() => undefined);
assert.match(captured, /精细3D电影CG，古风仙侠写实/);
assert.match(captured, /克制私密的长镜调度/);
assert.match(captured, /画面风格/);
assert.match(captured, /〔〕标签写进正文/);

captured = '';
await convertStoryboardDraftToFinal({
  draft: board('', ''),
  converter,
  clean: (value) => value.trim(),
  request: async (system, user) => {
    captured = `${system}\n${user}`;
    return board('', '').finalPrompt;
  },
}).catch(() => undefined);
assert.equal(captured.includes('"selectedPictureStyle"'), false);
assert.match(captured, /没有这两项时不另编画风/);

console.log('video style delivery prompt checks passed');
