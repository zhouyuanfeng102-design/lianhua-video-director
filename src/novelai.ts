export interface NovelAIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  endpoint?: string;
}

export interface NovelAICharacterPrompt {
  prompt: string;
  negativePrompt?: string;
  positions?: Array<{ x: number; y: number }>;
}

export interface NovelAIImageInput {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  scale?: number;
  sampler?: string;
  seed?: number;
  noiseSchedule?: string;
  qualityToggle?: boolean;
  characterPrompts?: NovelAICharacterPrompt[];
}

export interface NovelAIResponseParseOptions {
  inflateRaw?: (compressed: Uint8Array) => Promise<Uint8Array>;
}

export interface NovelAIHttpResponse {
  status: number;
  statusText?: string;
  body: string;
}

export type NovelAIReferenceImagePreflightDecision =
  | { allowed: true }
  | { allowed: false; message: string };

/**
 * NovelAI image generation currently has no verified reference-pixel protocol.
 * Callers pass only effective, readable reference asset IDs so a whole batch can
 * stop before creating work that is guaranteed to fail at the image boundary.
 */
export function checkNovelAIReferenceImagePreflight(
  backend: string,
  referenceAssetIds: readonly string[],
): NovelAIReferenceImagePreflightDecision {
  if (backend === 'novelai' && referenceAssetIds.length > 0) {
    return {
      allowed: false,
      message: 'NovelAI 当前不接收参考图像素。请取消勾选参考图，或切换到支持参考图的图像后端后再生成；本次未创建任务，也未调用文本转换或图像模型。',
    };
  }
  return { allowed: true };
}

const DEFAULT_GENERATE_PATH = 'ai/generate-image';

function parseHttpUrl(value: string, fieldName: string): URL {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName}不能为空`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${fieldName}必须是有效的 HTTP(S) 地址`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${fieldName}必须使用 HTTP(S) 协议`);
  }
  return url;
}

export function resolveNovelAIEndpoint(baseUrl: string, endpoint?: string): string {
  const base = parseHttpUrl(baseUrl, 'NovelAI 服务地址');
  const configuredEndpoint = endpoint?.trim();

  if (!configuredEndpoint && /\/ai\/generate-image\/?$/i.test(base.pathname)) {
    base.pathname = base.pathname.replace(/\/$/u, '');
    return base.toString();
  }

  if (configuredEndpoint && /^[a-z][a-z\d+.-]*:/i.test(configuredEndpoint)) {
    return parseHttpUrl(configuredEndpoint, 'NovelAI 生成端点').toString();
  }

  const baseWithTrailingSlash = new URL(base.toString());
  if (!baseWithTrailingSlash.pathname.endsWith('/')) {
    baseWithTrailingSlash.pathname += '/';
  }
  const relativePath = configuredEndpoint
    ? configuredEndpoint.replace(/^\/+/, '')
    : DEFAULT_GENERATE_PATH;
  return new URL(relativePath, baseWithTrailingSlash).toString();
}

function isV4Model(model: string): boolean {
  return /^nai-diffusion-4(?:\b|-)/i.test(model.trim());
}

function requireText(value: string, fieldName: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new Error(`${fieldName}不能为空`);
  }
  return trimmed;
}

function requirePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName}必须是正整数`);
  }
  return value;
}

function validateImageInput(input: NovelAIImageInput): void {
  requireText(input.prompt, 'NovelAI 正向提示词');
  requirePositiveInteger(input.width ?? 1024, 'width');
  requirePositiveInteger(input.height ?? 1024, 'height');

  const steps = input.steps ?? 28;
  if (!Number.isInteger(steps) || steps < 1 || steps > 50) {
    throw new Error('steps 必须是 1 至 50 之间的整数');
  }

  const scale = input.scale ?? 5;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('scale 必须是大于 0 的有限数字');
  }

  if (input.seed !== undefined
    && (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffff_ffff)) {
    throw new Error('seed 必须是 0 至 4294967295 之间的整数');
  }

  for (const character of input.characterPrompts ?? []) {
    requireText(character.prompt, 'NovelAI 角色提示词');
    for (const position of character.positions ?? []) {
      if (!Number.isFinite(position.x)
        || !Number.isFinite(position.y)
        || position.x < 0
        || position.x > 1
        || position.y < 0
        || position.y > 1) {
        throw new Error('NovelAI 角色坐标 x、y 必须是 0 至 1 之间的有限数字');
      }
    }
  }
}

export function buildNovelAIImageRequest(
  config: NovelAIConfig,
  input: NovelAIImageInput,
): {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
} {
  const apiKey = requireText(config.apiKey, 'NovelAI Token/密钥');
  const model = requireText(config.model, 'NovelAI 模型');
  validateImageInput(input);

  const characterPrompts = input.characterPrompts ?? [];
  const useCoords = characterPrompts.some((character) => (character.positions?.length ?? 0) > 0);
  const parameters: Record<string, unknown> = {
    params_version: 3,
    width: input.width ?? 1024,
    height: input.height ?? 1024,
    scale: input.scale ?? 5,
    sampler: input.sampler?.trim() || 'k_euler_ancestral',
    steps: input.steps ?? 28,
    n_samples: 1,
    ucPreset: 4,
    qualityToggle: input.qualityToggle ?? true,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: false,
    legacy_v3_extend: false,
    seed: input.seed,
    noise_schedule: input.noiseSchedule?.trim() || 'karras',
    negative_prompt: input.negativePrompt ?? '',
  };

  if (isV4Model(model)) {
    const positiveCharacters = characterPrompts.map((character) => ({
      char_caption: character.prompt,
      centers: character.positions ?? [],
    }));
    const negativeCharacters = characterPrompts.map((character) => ({
      char_caption: character.negativePrompt ?? '',
      centers: character.positions ?? [],
    }));
    parameters.v4_prompt = {
      use_coords: useCoords,
      use_order: characterPrompts.length > 0,
      caption: {
        base_caption: input.prompt,
        char_captions: positiveCharacters,
      },
      legacy_uc: false,
    };
    parameters.v4_negative_prompt = {
      use_coords: useCoords,
      use_order: characterPrompts.length > 0,
      caption: {
        base_caption: input.negativePrompt ?? '',
        char_captions: negativeCharacters,
      },
      legacy_uc: false,
    };
  }

  return {
    url: resolveNovelAIEndpoint(config.baseUrl, config.endpoint),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/zip, application/json, image/png, image/jpeg, image/webp',
    },
    body: JSON.stringify({
      input: input.prompt,
      model,
      action: 'generate',
      parameters,
    }),
  };
}

function decodeBase64(value: string): Uint8Array | undefined {
  const compact = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!compact || !/^[A-Za-z\d+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    return undefined;
  }

  const padded = compact.padEnd(compact.length + ((4 - (compact.length % 4)) % 4), '=');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    for (let index = 0; index < chunk.length; index += 1) {
      binary += String.fromCharCode(chunk[index]);
    }
  }
  return btoa(binary);
}

function detectImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return undefined;
}

function imageBytesToDataUrl(bytes: Uint8Array): string | undefined {
  const mime = detectImageMime(bytes);
  return mime ? `data:${mime};base64,${encodeBase64(bytes)}` : undefined;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04)
      || (bytes[2] === 0x05 && bytes[3] === 0x06)
      || (bytes[2] === 0x07 && bytes[3] === 0x08));
}

function readUint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) {
    throw new Error('NovelAI ZIP 结构不完整');
  }
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) {
    throw new Error('NovelAI ZIP 结构不完整');
  }
  return view.getUint32(offset, true);
}

async function inflateWithBrowser(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前运行环境不支持 NovelAI ZIP deflate 解压，请让代理返回 base64 图片');
  }
  const DecompressionStreamConstructor = DecompressionStream as unknown as new (
    format: string,
  ) => DecompressionStream;
  const stream = new Blob([compressed.slice().buffer])
    .stream()
    .pipeThrough(new DecompressionStreamConstructor('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extractFirstImageFromZip(
  bytes: Uint8Array,
  options: NovelAIResponseParseOptions,
): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEndOffset = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimumEndOffset; offset -= 1) {
    if (readUint32(view, offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error('NovelAI ZIP 缺少中央目录，响应可能不完整');
  }

  const entryCount = readUint16(view, endOffset + 10);
  let centralOffset = readUint32(view, endOffset + 16);
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (readUint32(view, centralOffset) !== 0x02014b50) {
      throw new Error('NovelAI ZIP 中央目录结构无效');
    }

    const flags = readUint16(view, centralOffset + 8);
    const method = readUint16(view, centralOffset + 10);
    const compressedSize = readUint32(view, centralOffset + 20);
    const uncompressedSize = readUint32(view, centralOffset + 24);
    const filenameLength = readUint16(view, centralOffset + 28);
    const extraLength = readUint16(view, centralOffset + 30);
    const commentLength = readUint16(view, centralOffset + 32);
    const localOffset = readUint32(view, centralOffset + 42);
    centralOffset += 46 + filenameLength + extraLength + commentLength;

    if ((flags & 0x01) !== 0) {
      continue;
    }
    if (compressedSize === 0xffff_ffff || uncompressedSize === 0xffff_ffff) {
      throw new Error('NovelAI ZIP 使用了暂不支持的 ZIP64 图片条目');
    }
    if (readUint32(view, localOffset) !== 0x04034b50) {
      throw new Error('NovelAI ZIP 本地文件头无效');
    }

    const localFilenameLength = readUint16(view, localOffset + 26);
    const localExtraLength = readUint16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localFilenameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.length) {
      throw new Error('NovelAI ZIP 图片数据不完整');
    }

    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    let candidate: Uint8Array;
    if (method === 0) {
      candidate = compressed;
    } else if (method === 8) {
      candidate = await (options.inflateRaw ?? inflateWithBrowser)(compressed);
    } else {
      continue;
    }

    if (uncompressedSize !== 0 && candidate.length !== uncompressedSize) {
      throw new Error('NovelAI ZIP 图片解压后的长度不匹配');
    }
    if (detectImageMime(candidate)) {
      return candidate;
    }
  }
  throw new Error('NovelAI ZIP 中没有找到 PNG、JPEG 或 WebP 图片');
}

function latin1StringToBytes(value: string): Uint8Array | undefined {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0xff) {
      return undefined;
    }
    bytes[index] = code;
  }
  return bytes;
}

function collectJsonStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > 8 || output.length >= 256) {
    return;
  }
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonStrings(item, output, depth + 1);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectJsonStrings(nested, output, depth + 1);
    }
  }
}

function getJsonErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['error', 'message', 'detail']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
    if (candidate && typeof candidate === 'object') {
      const nested = getJsonErrorMessage(candidate);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

async function parseOpaqueImageCandidate(
  value: string,
  options: NovelAIResponseParseOptions,
): Promise<string | undefined> {
  const trimmed = value.trim();
  const dataUrlMatch = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z\d+/=_-]+)$/i.exec(trimmed);
  if (dataUrlMatch) {
    const decoded = decodeBase64(dataUrlMatch[1]);
    if (decoded) {
      return imageBytesToDataUrl(decoded);
    }
  }

  const decodedBase64 = decodeBase64(trimmed);
  if (decodedBase64) {
    const directImage = imageBytesToDataUrl(decodedBase64);
    if (directImage) {
      return directImage;
    }
    if (isZip(decodedBase64)) {
      return imageBytesToDataUrl(await extractFirstImageFromZip(decodedBase64, options));
    }
  }

  const binaryBytes = latin1StringToBytes(value);
  if (binaryBytes) {
    const directImage = imageBytesToDataUrl(binaryBytes);
    if (directImage) {
      return directImage;
    }
    if (isZip(binaryBytes)) {
      return imageBytesToDataUrl(await extractFirstImageFromZip(binaryBytes, options));
    }
  }
  return undefined;
}

export async function parseNovelAIImageResponse(
  body: string,
  options: NovelAIResponseParseOptions = {},
): Promise<string> {
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error('NovelAI 返回了空响应，没有可用图片');
  }
  if (body.includes('\ufffd')) {
    throw new Error(
      'NovelAI 二进制响应已被 UTF-8 文本解码损坏；请让代理返回 base64 ZIP、JSON base64 或 data URL',
    );
  }

  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('NovelAI 返回了无效 JSON，无法读取图片');
    }

    const candidates: string[] = [];
    collectJsonStrings(parsed, candidates);
    for (const candidate of candidates) {
      const image = await parseOpaqueImageCandidate(candidate, options);
      if (image) {
        return image;
      }
    }
    const apiError = getJsonErrorMessage(parsed);
    throw new Error(apiError
      ? `NovelAI 返回错误：${apiError}`
      : 'NovelAI JSON 响应中没有找到可用图片');
  }

  const image = await parseOpaqueImageCandidate(body, options);
  if (image) {
    return image;
  }
  throw new Error('NovelAI 响应中没有找到可识别的 PNG、JPEG、WebP 或 ZIP 图片');
}

function describeHttpErrorBody(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return getJsonErrorMessage(parsed) ?? '服务返回了错误 JSON';
    } catch {
      return '服务返回了无法解析的错误 JSON';
    }
  }
  if (/^[\x20-\x7e\r\n\t]+$/.test(trimmed) && trimmed.length <= 500) {
    return trimmed.replace(/\s+/g, ' ');
  }
  return '服务返回了非文本错误响应';
}

export async function parseNovelAIHttpResponse(
  response: NovelAIHttpResponse,
  options: NovelAIResponseParseOptions = {},
): Promise<string> {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new Error('NovelAI HTTP 状态码无效');
  }
  if (response.status < 200 || response.status >= 300) {
    const statusText = response.statusText?.trim();
    const detail = describeHttpErrorBody(response.body);
    throw new Error([
      `NovelAI 请求失败（HTTP ${response.status}${statusText ? ` ${statusText}` : ''}）`,
      detail,
    ].filter(Boolean).join('：'));
  }
  return parseNovelAIImageResponse(response.body, options);
}
