import type {
  RunningHubVideoInputBinding, RunningHubVideoNodeCatalogEntry, RunningHubVideoNodeInfo,
} from './runningHubVideoTypes';

export type RunningHubVideoFieldPurpose = 'prompt' | 'images' | 'audios' | 'parameters';

const normalized = (value: string) => value.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()
  .replace(/[^a-z0-9\u3400-\u9fff]+/gu, '_').replace(/^_+|_+$/gu, '');
const compact = (value: string) => normalized(value).replace(/_/gu, '');
const keyOf = (nodeId: string, fieldName: string) => JSON.stringify([nodeId, fieldName]);
const descriptionOf = (node: RunningHubVideoNodeInfo) => typeof node.description === 'string' ? node.description : '';

const parameterNames = new Set([
  'width', 'height', 'imagewidth', 'imageheight', 'videowidth', 'videoheight', 'outputwidth', 'outputheight',
  'targetwidth', 'targetheight', 'framewidth', 'frameheight', 'fps', 'framerate', 'frames', 'numframes',
  'framecount', 'duration', 'durationseconds', 'videoduration', 'videolength', 'seconds', 'seed', 'noiseseed',
  'randomseed', 'samplingseed', 'steps', 'numsteps', 'samplingsteps', 'inferencesteps', 'numinferencesteps',
  'cfg', 'cfgscale', 'guidance', 'guidancescale', 'aspectratio', 'resolution', 'imageresolution', 'videoresolution', 'megapixel', 'megapixels', '百万像素',
  '宽度', '高度', '帧率', '帧数', '时长', '视频时长', '种子', '步数', '采样步数', '分辨率', '宽高比', '引导强度',
]);
const advancedName = /(?:^|_)(?:model|models|checkpoint|ckpt|lora|vae|clip|unet|sampler|scheduler|filename|prefix|suffix|directory|folder|format|codec|container|extension|upload|resize|interpolation|crop|mode|method|template|system|regex|separator|delimiter|apikey|token|password|secret)(?:_|$)|模型|采样器|调度器|文件名前缀|输出目录/iu;
const advancedCompactNames = new Set(['filenameprefix', 'fileprefix', 'outputprefix', 'outputpath', 'savepath', 'modelname', 'ckptname', 'loraname', 'samplername', 'schedulername', 'uploadimage', 'imageupload', 'imagemode', 'resizemethod']);
const negativeLabel = /(?:^|_)(?:negative|neg)(?:_|$)|negativeprompt|negprompt|负向|反向|负面|反面/iu;
const genericNames = new Set(['value', 'string', 'input', 'stringvalue', 'inputvalue', 'textvalue', 'textinput', '内容', '文本', '输入', '值']);
const promptName = /^(?:(?:positive|video|main|user|input|scene)_)?(?:prompt|text|caption)(?:_(?:text|prompt|input|g|l)|_?\d+)?$|^positive$|^(?:正向)?提示词(?:\d+)?$|^字幕$/iu;
const imageName = /^(?:(?:input|reference|ref|first|last|start|end|source|init)_)?images?(?:_?(?:\d+)|_(?:path|url|file|input))?$|^(?:first|last|start|end)_frame(?:_image)?$|^(?:reference|input)_image_\d+$|^(?:参考)?(?:图片|图像)(?:\d+)?$|^[首尾]帧$/iu;
const technicalDescription = /(?:^|_)(?:width|height|size|resolution|fps|seed|steps|duration|model|checkpoint|lora|sampler|scheduler|resize|interpolation|format)(?:_|$)|宽度|高度|尺寸|分辨率|帧率|种子|步数|时长|模型|采样器|调度器|缩放方式/iu;
const promptDescription = /(?:^|_)(?:prompt|text|caption)(?:_|$)|clip_?text_?encode|提示词|文本输入|输入文本|字幕/iu;
const imageDescription = /load_?image|(?:^|_)(?:(?:reference|input|first|last|start|end)_image|image_(?:input|path|url)|(?:first|last|start|end)_frame)(?:_|$)|^(?:image|images)$|参考(?:图|图片|图像)|图片(?:输入|路径)|图像输入|输入(?:图片|图像)|^[首尾]帧$|^(?:图片|图像)$/iu;
const audioName = /^(?:(?:input|reference|ref|source|voice)_)?audio(?:s|_?(?:\d+)|_(?:path|url|file|input))?$|^(?:reference|input)_audio_\d+$|^(?:参考|输入|声音)?音频(?:\d+)?$/iu;
const audioTechnicalName = /(?:^|_)(?:model|encoder|decoder|codec|format|duration|rate|samplerate|sample_rate|channels|output|save|prefix|device|tensor|latent|features)(?:_|$)|模型|编码|解码|采样率|声道|输出/iu;
const audioProcessingClass = /(?:audio.*(?:encode|decode|concat|combine|resample|trim|crop|save|output|tensor|latent|feature|spectrum|process)|(?:encode|decode|concat|combine|resample|trim|crop|save|preview|process).*audio)/iu;

/** A text file widget can be suggested; AUDIO tensors and graph links cannot. */
export const isRunningHubAudioFileField = (node: RunningHubVideoNodeInfo): boolean => {
  if (typeof node.fieldValue !== 'string') return false;
  const name = normalized(node.fieldName);
  const classType = typeof node.classType === 'string' ? compact(node.classType) : '';
  if (audioTechnicalName.test(name) || audioProcessingClass.test(classType)) return false;
  if (node.audioUpload === true) return true;
  const fileLoader = /^(?:vhs|rh|runninghub)?(?:(?:load|upload|input|reference)audio(?:file)?|audio(?:loader|upload))(?:\d+)?$/u.test(classType);
  if (!fileLoader && (/^(?:true|false)$/iu.test(node.fieldValue.trim())
    || /开关|开启|启用|禁用|(?:^|_)(?:enable|enabled|disable|disabled|switch)(?:_|$)/iu.test(normalized(descriptionOf(node))))) return false;
  // AUDIO denotes a processing port unless a real file widget/loader proves
  // otherwise. Unknown API graph classes remain available for explicit mapping.
  if ((classType && !fileLoader) || (typeof node.fieldType === 'string' && node.fieldType.toUpperCase() === 'AUDIO' && !fileLoader)) return false;
  if (audioName.test(name)) return true;
  const fileName = /^(?:file|filename|path|url|value|input|audio_upload)$/u.test(name);
  return fileName && fileLoader;
};

/** A display suggestion only: never infer a binding, inspect prompt content, or reject a request. */
export const classifyRunningHubVideoField = (
  node: RunningHubVideoNodeInfo,
): RunningHubVideoFieldPurpose | 'other' => {
  const name = normalized(node.fieldName);
  const flatName = compact(node.fieldName);
  if (isRunningHubAudioFileField(node)) return 'audios';
  if (advancedName.test(name) || advancedCompactNames.has(flatName)) return 'other';
  if (parameterNames.has(flatName)) return 'parameters';
  if (typeof node.fieldValue !== 'string') return 'other';
  const description = normalized(descriptionOf(node));
  if (negativeLabel.test(name) || negativeLabel.test(description)) return 'other';
  if (promptName.test(name)) return 'prompt';
  if (imageName.test(name)) return 'images';
  if (!genericNames.has(flatName) || technicalDescription.test(description)) return 'other';
  if (promptDescription.test(description)) return 'prompt';
  if (imageDescription.test(description)) return 'images';
  return 'other';
};

export interface RunningHubVideoFieldChoiceOptions {
  showAll?: boolean;
  search?: string;
  keepBindings?: RunningHubVideoInputBinding[];
  catalog?: RunningHubVideoNodeCatalogEntry[];
}

/** Filter the view only. Selected fields survive filters; request values always remain authoritative. */
export const selectRunningHubVideoFieldChoices = (
  nodes: RunningHubVideoNodeInfo[],
  purpose: RunningHubVideoFieldPurpose,
  { showAll = false, search = '', keepBindings = [], catalog = [] }: RunningHubVideoFieldChoiceOptions = {},
): RunningHubVideoNodeInfo[] => {
  const descriptions = new Map<string, string>();
  const evidence = new Map(catalog.map((node) => [keyOf(node.nodeId, node.fieldName), node]));
  for (const node of catalog) {
    const key = keyOf(node.nodeId, node.fieldName);
    if (!descriptions.has(key) && typeof node.description === 'string' && node.description.trim()) descriptions.set(key, node.description);
  }
  const kept = new Set(keepBindings.map((binding) => keyOf(binding.nodeId, binding.inputName)));
  const query = search.trim().toLowerCase();
  return nodes.map((node) => {
    const fallback = descriptions.get(keyOf(node.nodeId, node.fieldName));
    const metadata = evidence.get(keyOf(node.nodeId, node.fieldName));
    return { ...node, ...(!descriptionOf(node).trim() && fallback ? { description: fallback } : {}),
      ...(node.fieldType === undefined && metadata?.fieldType ? { fieldType: metadata.fieldType } : {}),
      ...(node.classType === undefined && metadata?.classType ? { classType: metadata.classType } : {}),
      ...(node.audioUpload === undefined && metadata?.audioUpload !== undefined ? { audioUpload: metadata.audioUpload } : {}) };
  }).filter((node) => kept.has(keyOf(node.nodeId, node.fieldName)) || (
    (showAll || classifyRunningHubVideoField(node) === purpose)
    && (!query || `${node.nodeId}.${node.fieldName} ${descriptionOf(node)}`.toLowerCase().includes(query))
  ));
};
