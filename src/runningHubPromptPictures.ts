import type { VideoTaskApiConfig } from './types';

type RunningHubH3AutoPromptContext = Pick<VideoTaskApiConfig, 'provider' | 'runningHubAppId' | 'runningHubMappedFields'>
  & Partial<Pick<VideoTaskApiConfig, 'endpoint'>>;
const autoPromptAppId = '2104753059472990209';
const autoPromptImageNodes = ['438', '435', '437', '439', '431', '429'];

/** This published app sends 456.text through its own prompt generator before
 * T8 consumes the final text. Match its exact frozen input/count profile,
 * never infer a rewrite path or a Picture limit from an arbitrary app name. */
export const isRunningHubH3AutoPromptInput = (config: RunningHubH3AutoPromptContext): boolean => {
  if (config.provider !== 'runninghub' || config.runningHubAppId?.trim() !== autoPromptAppId) return false;
  if (config.endpoint) {
    let pathname: string;
    try { pathname = new URL(config.endpoint).pathname; } catch { return false; }
    if (!/\/openapi\/v2\/run\/ai-app\/(?:2104753059472990209|\{appId\}|%7BappId%7D)\/?$/u.test(pathname)) return false;
  }
  const fields = config.runningHubMappedFields || [];
  const prompts = fields.filter((field) => field.kind === 'prompt');
  const counts = fields.filter((field) => field.kind === 'image-count');
  const images = fields.filter((field) => field.kind === 'image');
  return prompts.length === 1 && prompts[0].nodeId === '456' && prompts[0].fieldName === 'text'
    && counts.length === 1 && counts[0].nodeId === '827' && counts[0].fieldName === 'value' && counts[0].imageCountMode === 'prefix'
    && images.length === autoPromptImageNodes.length && autoPromptImageNodes.every((nodeId, index) => (
      images.filter((field) => field.imageIndex === index).length === 1
      && images.find((field) => field.imageIndex === index)?.nodeId === nodeId
      && images.find((field) => field.imageIndex === index)?.fieldName === 'image'
    ));
};

/** Input-side guidance for the app's remote generator, not a native bypass or
 * a guarantee that a remote model follows it. The authored body occurs once
 * verbatim; selected images, their order and saved task snapshots are intact. */
export const runningHubH3AutoPromptInput = (prompt: string, pictureCount: number): string => {
  if (!Number.isSafeInteger(pictureCount) || pictureCount < 0 || pictureCount > autoPromptImageNodes.length) {
    throw new Error('该已验证 RunningHub 应用的实际连接图片数无效，请核对原图槽；不会补图或修改正文。');
  }
  const allowed = Array.from({ length: pictureCount }, (_, index) => `<Picture ${index + 1}>`);
  const isCompletedH3 = /(?:^|\r?\n)[ \t]*(?:subject_definitions|integrated_multimodal_description)[ \t]*:/u.test(prompt);
  const bodyAuthority = isCompletedH3
    ? '下方是已经完成的 H3 正文，不再重新规划或扩写。逐字保留原主体身份、完整对白及其语言和说话人、镜头结构、时码切点、音效与参考图绑定；原文已正确的描述保持不变。'
    : '下方是本次原始视频内容；如需转换为 H3，仅整理已有内容，保留原主体、完整对白及其语言和说话人、事件与已有时码，不新增剧情或图片。';
  const contract = [
    `本次实际连接 ${pictureCount} 张图片；有效图片引用标签仅为 ${allowed.join('、') || '无（不要生成任何图片引用标签）'}。`,
    '图片按本次实际上传顺序编号；不得新增图片引用编号、猜测未提供的图片、补图或为填充画面复制人物。',
    '多视图中的面板、人物/Subject 编号、分镜/Shot 编号和镜头数量都不是新增图片；同一张图可跨镜重复引用其原有效标签。',
    bodyAuthority,
    '不要把本传输图序说明写入最终 H3 正文。提交给视频节点前只核对原文标签是否属于上述实际连接集合，不生成额外编号。',
  ].join('\n');
  return [
    '【本次图序与正文保持合同：请先遵守，再处理原文】', contract,
    '<lianhua_original_video_body>', prompt, '</lianhua_original_video_body>',
    '【最后再次核对本次实际输入】', contract,
  ].join('\n\n');
};

/** T8's H3 node canonicalizes picture/image aliases across the entire prompt,
 * including dialogue and quoted literals, before strict media-tag validation.
 * This is transport validation only: it never edits those authored literals.
 * Upstream: T8mars/comfyui-minimax-h3-audio-T8/prompt_tags.py. */
export const runningHubWholePromptPictureNumbers = (prompt: string): string[] => {
  const pattern = /<\s*(?:Image|Picture)\s*(\d+)\s*>|(?<![\p{L}\p{N}_<])(?:Image|Picture)\s*#?\s*(\d+)(?![\p{L}\p{N}_]|\s*>)/giu;
  return [...new Set([...prompt.matchAll(pattern)].map((match) => (match[1] || match[2]).replace(/^0+(?=\d)/u, '')))];
};

/** Only an already verified prefix-count protocol proves the actual list fed
 * to the H3 node. Unknown graphs may include static images or reorder inputs;
 * configured editable slots alone do not establish their final model count. */
export const assertRunningHubPromptPictureSlots = (
  mappedFields: NonNullable<VideoTaskApiConfig['runningHubMappedFields']>,
  prompt: string,
  occupiedSlots: readonly number[],
): void => {
  if (!mappedFields.some((field) => field.kind === 'image-count' && field.imageCountMode === 'prefix')) return;
  const occupied = new Set(occupiedSlots.map((slot) => String(slot + 1)));
  const unavailable = runningHubWholePromptPictureNumbers(prompt).filter((number) => !occupied.has(number));
  if (!unavailable.length) return;
  const labels = unavailable.map((number) => `<Picture ${number.length > 32 ? `${number.slice(0, 29)}…` : number}>`).join('、');
  const available = [...occupiedSlots].sort((left, right) => left - right).map((slot) => slot + 1).join('、') || '无';
  throw new Error(`RunningHub 本次实际连接 ${occupied.size} 张图片，可用 Picture 编号为 ${available}，但视频提示词仍引用未连接的 ${labels}。请按本次选图和原参考图清单重新绑定正文；缺少原图来源时请重新生成对应 H3 提示词，不要猜测图片身份或补图。对白或引号中的图片标签也会被该 H3 节点严格校验，本次没有提交视频生成。`);
};
