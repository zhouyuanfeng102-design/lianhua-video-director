/** Per-run authorization for visual frame selection, not a global LLM retry policy. */
export const VIDEO_TAIL_FRAME_MAX_ATTEMPTS = 4;

export interface VideoTailFrameAiAttempt {
  attempt: number;
  maxAttempts: number;
  maxTokens: number;
}

/** A returned answer that cannot identify a real candidate may be repaired by AI. */
export class VideoTailFrameProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoTailFrameProtocolError';
  }
}

interface RetryDecision {
  retry: boolean;
  maxTokens: number;
  providerLimit?: number;
  explanation: string;
  instruction?: string;
}

// Accept only explicit OUTPUT-token limits. Context-window/input-size errors do
// not establish an output allowance, and unknown provider limits are not guessed.
const explicitOutputLimit = (message: string): number | undefined => {
  if (/\b(?:context|input|window|prompt)\b/iu.test(message)) return undefined;
  const patterns = [
    /\bmax_(?:completion_|output_)?tokens\b[^\n.]{0,100}?(?:less than or equal to|at most|no more than|cannot exceed|must not exceed|<=|maximum(?: allowed)?(?: value| limit)?(?: is| of)?|upper (?:bound|limit)(?: is| of)?)\s*[:=]?\s*(\d[\d,]*)/iu,
    /\bmax_(?:completion_|output_)?tokens\b[^\n.]{0,80}?\[\s*\d+\s*,\s*(\d[\d,]*)\s*\]/iu,
    /(?:supports? at most|maximum(?: allowed)?(?: number of)?)\s+(\d[\d,]*)\s+(?:completion|output)\s+tokens/iu,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    const value = match ? Number(match[1].replace(/,/gu, '')) : NaN;
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
};

/** Classify provider/protocol failures only. Never inspect story/image semantics. */
export const videoTailFrameRetryDecision = (
  error: unknown,
  maxTokens: number,
  growthCeiling: number,
  providerLimit?: number,
): RetryDecision => {
  const value = error instanceof Error ? error as Error & { code?: string; status?: number } : undefined;
  const terminal: RetryDecision = { retry: false, maxTokens, providerLimit, explanation: '' };
  const jsonInstruction = '请自行检查后直接返回一个完整 JSON 对象，只含 selectedId 和简短 reason，不要输出分析过程、Markdown 或额外说明。编号必须来自本次候选清单。';
  if (value?.name === 'TextModelResponseError') {
    if (value.code === 'length' || value.code === 'reasoning_only') {
      const limit = Math.min(growthCeiling, providerLimit ?? growthCeiling);
      const nextTokens = Math.min(limit, Math.max(1024, maxTokens * 2));
      return { retry: true, maxTokens: nextTokens, providerLimit,
        explanation: value.code === 'length' ? '输出额度不足，未得到完整选帧结果' : '模型只返回了思考内容，没有返回选帧正文',
        instruction: `上一次响应未能完成选帧结果。${jsonInstruction}理由用一两句简短说明即可。` };
    }
    if (['empty_content', 'invalid_response'].includes(value.code || '')) {
      return { retry: true, maxTokens, providerLimit, explanation: '接口没有返回完整有效的选帧正文', instruction: jsonInstruction };
    }
    return terminal; // Explicit refusal/filtering is never retried here.
  }
  if (value?.name === 'VideoTailFrameProtocolError') {
    return { retry: true, maxTokens, providerLimit, explanation: value.message, instruction: jsonInstruction };
  }
  if (value?.name === 'TextModelHttpError') {
    if (value.status === 400 || value.status === 422) {
      const limit = explicitOutputLimit(value.message);
      if (limit !== undefined && limit < maxTokens) {
        return { retry: true, maxTokens: limit, providerLimit: Math.min(providerLimit ?? limit, limit),
          explanation: `接口明确限制输出上限为 ${limit} tokens，已按接口上限调整`, instruction: jsonInstruction };
      }
    }
    if ([429, 500, 502, 503].includes(value.status || 0)) {
      return { retry: true, maxTokens, providerLimit, explanation: `接口暂时不可用（HTTP ${value.status}）`, instruction: jsonInstruction };
    }
  }
  // Transport interruption/timeouts have an unknown remote outcome. Keep the
  // durable started boundary and require an explicit retry, including on restart.
  return terminal;
};
