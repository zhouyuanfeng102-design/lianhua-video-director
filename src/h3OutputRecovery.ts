/** Request-local delivery capacity. This never edits a saved API configuration,
 * inspects story semantics, truncates text, or owns an additional retry loop. */
export interface H3OutputAllowance {
  maxTokens: number;
  growthCeiling: number;
  providerLimit?: number;
}

export interface H3OutputRetryDecision {
  retry: boolean;
  allowance: H3OutputAllowance | undefined;
  explanation: string;
}

const DEFAULT_GROWTH_CEILING = 65_536;

/** A two-body Chinese delivery needs capacity for both canonical and H3 text.
 * Values above our growth ceiling were explicitly selected by the user and
 * are preserved. Missing budgets are not replaced with a guessed global default. */
export const createH3OutputAllowance = (
  configuredMaxTokens?: number,
  dualBody = false,
): H3OutputAllowance | undefined => {
  if (!Number.isSafeInteger(configuredMaxTokens) || configuredMaxTokens! <= 0) return undefined;
  const configured = configuredMaxTokens!;
  const growthCeiling = Math.max(DEFAULT_GROWTH_CEILING, configured);
  return {
    maxTokens: dualBody ? Math.min(growthCeiling, configured * 2) : configured,
    growthCeiling,
  };
};

/** Only a provider's explicit OUTPUT ceiling may lower an allowance. A total
 * context/input limit is not an output ceiling and must not be guessed as one. */
const explicitOutputLimit = (message: string): number | undefined => {
  if (/\b(?:context|input|window|prompt)\b|上下文|输入(?:长度|额度|token|令牌)|提示词(?:长度|额度)/iu.test(message)) return undefined;
  const patterns = [
    /\bmax_(?:completion_|output_)?tokens\b[^\n.]{0,100}?(?:less than or equal to|at most|no more than|cannot exceed|must not exceed|<=|maximum(?: allowed)?(?: value| limit)?(?: is| of)?|upper (?:bound|limit)(?: is| of)?)\s*[:=]?\s*(\d[\d,]*)/iu,
    /\bmax_(?:completion_|output_)?tokens\b[^\n.]{0,80}?\[\s*\d+\s*,\s*(\d[\d,]*)\s*\]/iu,
    /(?:supports? at most|maximum(?: allowed)?(?: number of)?)\s+(\d[\d,]*)\s+(?:completion|output)\s+tokens/iu,
    /(?:max_(?:completion_|output_)?tokens|(?:最大)?输出(?:token|令牌|长度|额度)?)[^\n。]{0,60}?(?:不能超过|不得超过|不超过|最多(?:为)?|最大(?:值|上限)?(?:为|是)|上限(?:为|是))\s*[:：=]?\s*(\d[\d,]*)/iu,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    const value = match ? Number(match[1].replace(/,/gu, '')) : NaN;
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
};

/** Pure error classification. The owning H3 phase must consume its existing
 * shared three-retry budget before sending another request. Serialization and
 * transport recovery must not each create a nested three-attempt loop. */
export const h3OutputRetryDecision = (
  error: unknown,
  allowance: H3OutputAllowance | undefined,
): H3OutputRetryDecision => {
  const value = error instanceof Error ? error as Error & { code?: string; status?: number } : undefined;
  const terminal: H3OutputRetryDecision = { retry: false, allowance, explanation: '' };
  if (!value || value.name === 'AbortError') return terminal;
  if (value.name === 'TextModelResponseError') {
    if (value.code === 'length' || value.code === 'reasoning_only') {
      if (!allowance) return terminal;
      const ceiling = Math.min(allowance.growthCeiling, allowance.providerLimit ?? allowance.growthCeiling);
      const next = Math.min(ceiling, Math.max(1024, allowance.maxTokens * 2));
      return {
        retry: true,
        allowance: { ...allowance, maxTokens: next },
        explanation: `${value.code === 'length' ? '模型输出达到额度后被截断，未取得完整交付' : '模型只返回思考内容，未取得交付正文'}；输出额度 ${allowance.maxTokens} → ${next} tokens`,
      };
    }
    if (value.code === 'empty_content' || value.code === 'invalid_response') {
      return { retry: true, allowance, explanation: '接口没有返回完整有效的交付正文，重新请求同一份完整结果' };
    }
    return terminal; // Explicit refusals and filtering are not recovery triggers.
  }
  if (value.name === 'TextModelHttpError' && (value.status === 400 || value.status === 422) && allowance) {
    const limit = explicitOutputLimit(value.message);
    if (limit !== undefined && limit < allowance.maxTokens) {
      return {
        retry: true,
        allowance: { ...allowance, maxTokens: limit, providerLimit: Math.min(allowance.providerLimit ?? limit, limit) },
        explanation: `接口明确限制输出上限为 ${limit} tokens，本次请求已按该上限调整`,
      };
    }
  }
  // Auth, context exhaustion, refusals, network/timeouts and unrelated HTTP
  // failures retain their original error instead of being guessed as capacity.
  return terminal;
};
