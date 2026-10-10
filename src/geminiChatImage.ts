import { normalizeGeneratedImageData } from './generatedImageData';
import { imageResolutionAspectRatio, type ImageResolutionPlan } from './imageResolution';

/** Relay-specific OpenAI chat image transport. This is not Google's native API. */
export const resolveGeminiChatImageEndpoint = (baseUrl: string): string => {
  const trimmed = baseUrl.trim();
  const suffixStart = trimmed.search(/[?#]/u);
  const suffix = suffixStart >= 0 ? trimmed.slice(suffixStart) : '';
  const path = (suffixStart >= 0 ? trimmed.slice(0, suffixStart) : trimmed).replace(/\/+$/u, '');
  if (/\/chat\/completions$/iu.test(path)) return `${path}${suffix}`;
  if (/\/images\/(?:generations|edits|variations)$/iu.test(path)) {
    return `${path.replace(/\/images\/(?:generations|edits|variations)$/iu, '/chat/completions')}${suffix}`;
  }
  if (/\/(?:v1|v1beta\/openai|api\/paas\/v4)$/iu.test(path)) return `${path}/chat/completions${suffix}`;
  return `${path}/v1/chat/completions${suffix}`;
};

export const buildGeminiChatImageBody = (input: {
  model: string; prompt: string; negativePrompt?: string; references: readonly string[];
  width: number; height: number; sizeOverride?: boolean; plan?: ImageResolutionPlan;
}): Record<string, unknown> => {
  const pixelRequest = input.sizeOverride && (!input.plan || input.plan.encoding.kind !== 'tier')
    ? `\nRequested output canvas: ${input.width} × ${input.height} pixels. Use this canvas and aspect ratio when supported.` : '';
  const text = `${input.prompt}${pixelRequest}${input.negativePrompt?.trim() ? `\nAvoid: ${input.negativePrompt.trim()}` : ''}`;
  const content = [
    { type: 'text', text },
    ...input.references.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
  return {
    // Billing/provider aliases belong to the relay. Never strip or rename them.
    model: input.model.trim(), stream: false,
    messages: [{ role: 'user', content }],
    // OpenAI-compatible image relays expose these extensions; support depends
    // on the selected channel. They are not arbitrary pixel/native guarantees.
    modalities: ['image', 'text'],
    image_config: {
      aspect_ratio: input.plan?.logicalAspectRatio || imageResolutionAspectRatio(input.width, input.height),
      ...(input.plan?.encoding.kind === 'tier' ? { image_size: input.plan.encoding.value } : {}),
    },
  };
};

export type GeminiChatImageOutput = { url?: string; dataUrl?: string };
const record = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
);
const imageUrl = (value: unknown): GeminiChatImageOutput | undefined => {
  if (typeof value !== 'string') return undefined;
  const url = value.trim();
  if (/^data:image\/(?:png|jpeg|webp);base64,/iu.test(url)) return { dataUrl: normalizeGeneratedImageData(url) };
  if (/^https?:\/\/\S+$/iu.test(url)) return { url };
  return undefined;
};
const imagePart = (value: unknown): GeminiChatImageOutput | undefined => {
  const part = record(value);
  if (!part || part.thought === true) return undefined;
  const inline = record(part.inlineData || part.inline_data);
  if (inline && typeof inline.data === 'string' && typeof (inline.mimeType || inline.mime_type) === 'string'
    && /^image\/(?:png|jpeg|webp)$/iu.test(String(inline.mimeType || inline.mime_type))) {
    return imageUrl(`data:${inline.mimeType || inline.mime_type};base64,${inline.data}`);
  }
  const nestedUrl = record(part.image_url)?.url;
  return imageUrl(nestedUrl || part.image_url || part.url)
    || (typeof part.b64_json === 'string' ? { dataUrl: normalizeGeneratedImageData(part.b64_json) } : undefined);
};
const imageText = (value: unknown): GeminiChatImageOutput | undefined => {
  if (typeof value !== 'string') return undefined;
  const direct = imageUrl(value);
  if (direct) return direct;
  // Ordinary links, quoted prose and bare base64 are not generated images.
  const markdown = /!\[[^\]\r\n]*\]\(\s*<?(data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=_-]+|https?:\/\/[^\s<>]+?)>?(?:\s+["'][^\r\n]*?["'])?\s*\)/iu.exec(value);
  if (markdown) return imageUrl(markdown[1]);
  const inline = /data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=_-]+/iu.exec(value);
  return inline ? imageUrl(inline[0]) : undefined;
};

/** Inspect only final image/content fields. Reasoning/debug/thought are ignored. */
export const readGeminiChatImageOutput = (payload: unknown): GeminiChatImageOutput | undefined => {
  const body = record(payload);
  for (const choice of Array.isArray(body?.choices) ? body.choices : []) {
    const message = record(record(choice)?.message);
    if (!message || message.thought === true) continue;
    for (const image of Array.isArray(message.images) ? message.images : []) {
      const output = typeof image === 'string' ? imageUrl(image) : imagePart(image);
      if (output) return output;
    }
    if (typeof message.content === 'string') {
      const output = imageText(message.content);
      if (output) return output;
    } else for (const value of Array.isArray(message.content) ? message.content : []) {
      const part = record(value);
      if (!part || part.thought === true || /^(?:reasoning|thinking|thought)$/u.test(String(part.type))) continue;
      const output = imagePart(part) || (part.type === 'text' || part.type === 'output_text' ? imageText(part.text) : undefined);
      if (output) return output;
    }
  }
  // Some compatible relays keep Google's native image response shape.
  for (const candidate of Array.isArray(body?.candidates) ? body.candidates : []) {
    const content = record(record(candidate)?.content);
    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      const output = imagePart(part);
      if (output) return output;
    }
  }
  return undefined;
};
