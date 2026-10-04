/** Presentation only: callers retain the original error in their state/logs.
 * No stored values, requests, prompts, retry policies or safety decisions change. */
const UNKNOWN_ERROR = '操作失败，暂时无法识别具体原因。';
const UNKNOWN_DETAIL = '服务返回了未识别的错误，暂时无法确定具体原因。';
const LOCAL_UNKNOWN_DETAIL = '暂时无法确定具体原因，请检查本地文件与存储状态。';
const LOCAL_STRUCTURE_UNKNOWN_DETAIL = '本地结构读取未完成，具体字段暂时无法识别；这不是上游接口错误。';
const LOCAL_ARCHIVE_UNKNOWN_DETAIL = '压缩包在本地读取或解压失败；请重试获取原任务结果，不需要重新生成。';
const TLS_DISCONNECTED_DETAIL = '与接口的 TLS 加密连接尚未建立就已断开，请检查服务地址、代理及网络连接；仅凭此错误无法确定具体断开原因';
const API_QUEUE_LIMIT_DETAIL = '接口并发生成数量已达上限，请等待正在运行的任务完成后再试';
const certificateReasons: Readonly<Record<string, string>> = {
  CERT_HAS_EXPIRED: '服务证书已过期，无法建立受信任的 TLS 连接；请检查系统时间，并联系服务提供方更新证书',
  CERT_NOT_YET_VALID: '服务证书尚未到生效时间，无法建立受信任的 TLS 连接；请检查系统时间和服务证书有效期',
  ERR_TLS_CERT_ALTNAME_INVALID: '服务地址与证书上的域名不匹配；请检查 API 服务地址，并联系服务提供方核对证书域名',
  DEPTH_ZERO_SELF_SIGNED_CERT: '服务使用了不受信任的自签名证书；请检查服务或代理的证书信任配置',
  SELF_SIGNED_CERT_IN_CHAIN: '服务证书链包含不受信任的自签名证书；请检查服务或代理的证书信任配置',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证服务证书链；请联系服务提供方检查证书链是否完整，如使用代理也请检查其证书信任配置',
  UNABLE_TO_GET_ISSUER_CERT: '找不到可验证服务证书的签发者证书；请检查服务证书链和证书信任配置',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: '本机无法找到可验证服务证书的签发者证书；请检查服务证书链，如使用代理也请检查其证书信任配置',
};
const hasChinese = (value: string): boolean => /[\u3400-\u9fff]/u.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';
const fileSystemReasons: Readonly<Record<string, string>> = {
  ENOSPC: '磁盘空间不足，请释放保存目录所在磁盘的空间后重试',
  EDQUOT: '磁盘存储配额已用尽，请增加配额或更换保存目录',
  EACCES: '没有文件访问权限，请检查保存目录权限',
  EPERM: '文件操作被系统拒绝，请检查目录权限或文件占用',
  EBUSY: '文件被其他程序占用，请关闭占用程序后重试',
  EROFS: '目标磁盘或目录为只读，请改用可写目录',
  ENOENT: '文件或目录不存在，或磁盘已断开，请检查文件路径',
  ENOTDIR: '文件路径中的目录无效，请检查保存路径',
  EISDIR: '目标文件路径指向了目录，请检查保存路径',
  EIO: '磁盘读写失败，请检查磁盘连接和健康状态',
  EMFILE: '打开的文件过多，请关闭其他占用程序后重试',
  ENFILE: '系统可用文件句柄不足，请关闭其他占用程序后重试',
};

const httpReasons: Record<number, string> = {
  400: '请求格式或参数不正确', 401: '身份验证失败', 403: '没有访问权限', 404: '请求的资源不存在',
  408: '请求等待超时', 409: '请求与当前状态冲突', 413: '请求数据过大', 415: '不支持此媒体格式',
  422: '请求参数无法处理', 429: '请求受到限流', 500: '服务内部错误', 502: '上游服务响应异常',
  503: '服务暂时不可用', 504: '网关等待上游服务超时',
};
const httpDescription = (status: number): string => httpReasons[status]
  ? `${httpReasons[status]}（HTTP ${status}）` : `接口返回错误（HTTP ${status}）`;

const readProperty = (value: unknown, key: string): unknown => {
  try { return record(value) ? value[key] : undefined; } catch { return undefined; }
};
const errorMessage = (input: unknown, seen = new Set<unknown>()): string => {
  if (typeof input === 'string') return input.trim();
  if (!record(input) || seen.has(input)) return '';
  seen.add(input);
  for (const key of ['message', 'error_description', 'detail', 'error', 'cause', 'statusText']) {
    const message = errorMessage(readProperty(input, key), seen);
    if (message) return message;
  }
  return '';
};

const unwrapError = (input: string): string => {
  let value = input.split(/\r?\n\s+at\s/u)[0].trim();
  for (let count = 0; count < 5; count += 1) {
    const next = value
      .replace(/(^|[：:]\s*)(?:Error:\s*)?Error invoking remote method\s+(['"])[^'"\r\n]+\2\s*:\s*/giu, '$1')
      .replace(/(^|[：:]\s*)(?:Error|TypeError|NetworkError|AxiosError|HttpError|TextModelResponseError)\s*:\s*/gu, '$1').trim();
    if (next === value) break;
    value = next;
  }
  return value;
};

const referenceRoleLabels: Readonly<Record<string, string>> = {
  'first-frame': '首帧', 'last-frame': '尾帧', composition: '构图参考',
  character: '人物参考', subject: '主体参考', general: '通用参考', unknown: '未分类',
  scene: '场景参考', prop: '道具参考', style: '风格参考', motion: '动作参考',
  camera: '摄影参考', audio: '声音参考', dialogue: '对白参考',
  'clay-render': '白模参考', creative: '创意参考',
};

const translations: ReadonlyArray<readonly [RegExp, string | ((...matches: string[]) => string)]> = [
  // This is our explicit protocol-field label, not a body-text refusal heuristic.
  [/（接口返回 refusal 标记）/gu, '（接口返回拒绝标记）'],
  // These are local slot/selection enum values, not untranslated provider prose.
  // Limit the translation to the explicit labels; do not whitelist these common
  // English words globally or hide an unrelated upstream error after the token.
  [/((?:图片槽|所选|选图|不能接收)用途为\s*)(first-frame|last-frame|composition|character|subject|general|unknown|scene|prop|style|motion|camera|audio|dialogue|clay-render|creative)(?![A-Za-z0-9_.-])/giu,
    (_whole, label, role) => `${label}${referenceRoleLabels[role.toLowerCase()]}`],
  // This old message came from a local source-ID coverage heuristic, not the
  // provider. Preserve its cause even when viewing logs saved by older builds.
  [/AI 分镜未覆盖全部原文\s+sourceUnits[，,]\s*缺少[：:]/gu, '旧版本地原文定位检查未通过（不是接口错误），缺少片段：'],
  [/不属于\s+allowedSubjects\s+允许的稳定主体[：:]/gu, '未通过旧版本地人物名单检查（不是接口错误），本地允许的名称：'],
  // Older H3 protocol diagnostics contain static English labels inside Chinese
  // explanations. Translate only those known diagnostic sentences, including
  // saved logs; globally allowing section/Shot/At would hide unknown vendor
  // prose. The original diagnostic remains unchanged in storage/details.
  [/缺少完整H3官方section、连续\[Shot N\]或逐镜At切点，或返回了普通六字段时间轴。/gu,
    'H3格式未完成：缺少官方章节、连续镜头编号或逐镜切点，或返回了普通六字段时间轴。'],
  [/H3官方section名称或顺序与格式基准不一致。/gu,
    'H3格式未完成：官方章节名称或顺序与格式基准不一致。'],
  [/H3镜头数量、\[Shot N\]顺序或At切点与格式基准不一致。/gu,
    'H3格式未完成：镜头数量、编号顺序或逐镜切点与格式基准不一致。'],
  [/H3的Subject\/Picture\/Video\/Audio参考标签集合与格式基准不一致。/gu,
    'H3格式未完成：主体、图片、视频或音频参考标签集合与格式基准不一致。'],
  [/Upstream did not return the expected image\.?\s*Please adjust your prompt\.?/giu, '上游服务未返回预期图像，请调整提示词'],
  [/The generated image was filtered by the safety policy\.?\s*Please adjust your prompt and try again\.?/giu, '生成的图像被安全策略拦截，请调整提示词后重试'],
  [/The generated image was filtered by the safety policy\.?/giu, '生成的图像被安全策略拦截'],
  [/您的请求无法用于生成图像[。.!！]?\s*该请求可能因安全政策被拦截[，,]?\s*或不适合进行图像生成[。.!！]?/iu,
    '上游图像接口返回了内容安全拒绝（不是本地提交前门禁），请调整提示词或更换支持该内容的图像后端'],
  [/Upstream did not return the expected image\.?/giu, '上游服务未返回预期图像'],
  // Do not translate the HTTP marker again inside an already Chinese-labelled
  // status such as “请求受到限流（HTTP 429）”. Logs may be formatted twice.
  [/\b(?:request failed with status code\s+(\d{3})|(?<![\u3400-\u9fff]（)HTTP[ /]*(\d{3})(?:\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Request Timeout|Conflict|Payload Too Large|Unsupported Media Type|Unprocessable Entity|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout))?)\b\.?/giu,
    (_whole, requestStatus, httpStatus) => httpDescription(Number(requestStatus || httpStatus))],
  [/\b(?:the\s+)?model\s+[`'"“]([^`'"”]+)[`'"”]\s+(?:does not exist|was not found|not found)(?:\s+or you do not have access to it)?\.?/giu,
    (whole, model) => /or you do not have access/iu.test(whole) ? `模型“${model}”不存在，或当前账号无权访问该模型` : `未找到模型“${model}”`],
  [/\bmodel\s+not\s+found\s*[:=]\s*([\w./:-]+)\.?/giu, (_whole, model) => `未找到模型“${model.replace(/\.$/u, '')}”`],
  [/\b(?:the\s+)?model\s+([\w./-]+)\s+(?:does not exist|was not found|not found)(?:\s+or you do not have access to it)?\.?/giu,
    (whole, model) => /or you do not have access/iu.test(whole) ? `模型“${model}”不存在，或当前账号无权访问该模型` : `未找到模型“${model}”`],
  [/\b(?:unknown|unsupported|invalid)\s+model\s*[:=]\s*([\w./:-]+)\.?/giu, (_whole, model) => `模型“${model.replace(/\.$/u, '')}”无效或不受支持`],
  [/\bno available (?:channel|distributor) for model\s+([\w./:-]+)\.?/giu, (_whole, model) => `模型“${model.replace(/\.$/u, '')}”暂无可用服务通道`],
  [/\bmissing\s+(?:a\s+)?required\s+(?:parameter|field)\s*[:=]\s*[`'"]?([\w.\[\]-]+)[`'"]?\.?/giu, (_whole, field) => `缺少必需参数“${field.replace(/\.$/u, '')}”`],
  [/\bmissing\s+(?:parameter|field)\s*[:=]\s*[`'"]?([\w.\[\]-]+)[`'"]?\.?/giu, (_whole, field) => `缺少参数“${field.replace(/\.$/u, '')}”`],
  [/\binvalid\s+(?:parameter|argument|field)\s*[:=]\s*[`'"]?([\w.\[\]-]+)[`'"]?\.?/giu, (_whole, field) => `参数“${field.replace(/\.$/u, '')}”无效`],
  [/\b(?:incorrect|invalid)\s+api[ _-]?key(?:\s+provided)?\b\.?/giu, 'API 密钥无效'],
  [/\b(?:missing|no)\s+api[ _-]?key\.?/giu, '缺少 API 密钥'],
  [/\b(?:expired|invalid)\s+(?:access\s+)?token\.?/giu, '认证凭据已过期或无效'],
  [/\b(?:authentication|authorization)\s+failed\.?/giu, '身份验证失败'],
  [/\bunauthorized\b/giu, '身份验证失败'],
  [/\bforbidden\b/giu, '没有访问权限'],
  // RunningHub can return both languages joined by " | ". This is the API's
  // concurrent-job limit, not a content refusal or exhausted account balance.
  [/\bapi[ _-]+queue[ _-]+limit[ _-]+(?:reached|exceeded)\b[,.]?(?:\s*please\s+(?:retry|try\s+again)\s+later\.?)?(?:\s*\|\s*API\s*并发数已达上[限线][，,]?\s*请降低并发或稍后重试[。.]?)?/giu, API_QUEUE_LIMIT_DETAIL],
  [/API\s*并发数已达上[限线](?:[，,]?\s*请降低并发或稍后重试)?[。.]?/giu, API_QUEUE_LIMIT_DETAIL],
  [/\b(?:rate[ _-]?limit(?:[ _-]?exceeded)?|too many requests)\b\.?/giu, '请求受到限流'],
  // These provider messages describe upstream capacity, not a proven lack of
  // funds in the user's account. Keep that distinction and any retry advice.
  [/\bno available image quota\b\.?(?:\s+(please try again later)\.?)?/giu,
    (_whole, retry) => `上游当前没有可用的图像生成额度${retry ? '，请稍后重试' : ''}`],
  [/\b(?:the\s+)?system\s+(?:is\s+)?overloaded\b\.?(?:\s+(please try again later)\.?)?/giu,
    (_whole, retry) => `上游服务当前负载过高${retry ? '，请稍后重试' : ''}`],
  [/\b(?:you exceeded your current quota|insufficient[ _-]?quota|quota exceeded|insufficient balance)\b\.?/giu, '当前接口额度不足'],
  [/\b(?:(?:the\s+)?(?:request|read|connection|operation)\s+)?timed out(?:\s+after\s+(\d+)\s*(ms|milliseconds?|seconds?|s))?\.?/giu,
    (_whole, amount, unit) => amount ? `请求等待超时（${amount}${/^m/iu.test(unit) ? '毫秒' : '秒'}）` : '请求等待超时'],
  [/\btimeout of\s+(\d+)\s*ms exceeded\.?/giu, (_whole, amount) => `请求等待超时（${amount}毫秒）`],
  [/\b(?:context deadline exceeded|request timeout|connection timeout|gateway timeout|TimeoutError)\b\.?/giu, '请求等待超时'],
  [/\b(?:the operation was aborted|this operation was aborted|request (?:was )?cancelled|request (?:was )?canceled|AbortError)\b\.?/giu, '操作已取消'],
  [/\b(?:networkerror when attempting to fetch resource|failed to fetch|fetch failed|network request failed|network error)\b\.?/giu, '网络请求失败'],
  // The desktop transport can reject before it receives an HTTP response.
  // This describes the failed TLS connection phase, not a moderation decision,
  // bad prompt, exhausted quota or proof of which network component disconnected.
  [/\b(?:client\s+)?network socket disconnected before (?:a\s+)?secure (?:TLS|SSL) connection was established\b\.?/giu, TLS_DISCONNECTED_DETAIL],
  [/\bcertificate (?:has expired|expired)\b\.?/giu, certificateReasons.CERT_HAS_EXPIRED],
  [/\bcertificate is not yet valid\b\.?/giu, certificateReasons.CERT_NOT_YET_VALID],
  [/\bHostname\/IP does not match certificate['’]s altnames\b(?::[^\r\n]*)?\.?/giu, certificateReasons.ERR_TLS_CERT_ALTNAME_INVALID],
  [/\bself[- ]signed certificate in (?:certificate )?chain\b\.?/giu, certificateReasons.SELF_SIGNED_CERT_IN_CHAIN],
  [/\bself[- ]signed certificate\b\.?/giu, certificateReasons.DEPTH_ZERO_SELF_SIGNED_CERT],
  [/\bunable to verify (?:the )?first certificate\b\.?/giu, certificateReasons.UNABLE_TO_VERIFY_LEAF_SIGNATURE],
  [/\bunable to get local issuer certificate\b\.?/giu, certificateReasons.UNABLE_TO_GET_ISSUER_CERT_LOCALLY],
  [/\bunable to get issuer certificate\b\.?/giu, certificateReasons.UNABLE_TO_GET_ISSUER_CERT],
  [/\bcertificate verify failed\b\.?/giu, '服务证书校验失败；请检查系统时间、服务证书及代理的证书信任配置'],
  // Leave codes inside our own Chinese diagnostics intact on repeated display.
  [/\b(?:connect\s+)?ECONNREFUSED\b(?!）)/gu, '无法连接到服务（ECONNREFUSED）'],
  [/\b(?:read\s+)?ECONNRESET\b(?!）)/gu, '连接被对端中断（ECONNRESET）'],
  [/\b(?:getaddrinfo\s+)?ENOTFOUND\b(?!）)/gu, '无法解析服务地址（ENOTFOUND）'],
  [/\bEAI_AGAIN\b(?!）)/gu, '服务地址解析暂时失败（EAI_AGAIN）'],
  [/\bETIMEDOUT\b(?!）)/gu, '连接等待超时（ETIMEDOUT）'],
  [/\bsocket hang up\b\.?/giu, '连接被对端中断'],
  [/\binvalid (PNG|JPEG|JPG|WebP) (?:file )?signature\b\.?/giu, (_whole, format) => `${format} 文件签名无效`],
  [/\b(PNG|JPEG|JPG|WebP) (?:file )?signature (?:is )?invalid\b\.?/giu, (_whole, format) => `${format} 文件签名无效`],
  [/\binternal server error\b\.?/giu, '服务内部错误'],
  [/\bservice unavailable\b\.?/giu, '服务暂时不可用'],
  [/\bbad gateway\b\.?/giu, '上游服务响应异常'],
  [/\bbad request\b\.?/giu, '请求格式或参数不正确'],
  [/\b(?:invalid request|invalid parameters)\b\.?/giu, '请求参数无效'],
  [/\bmodel not found\b\.?/giu, '未找到请求的模型'],
  [/\bnot found\b\.?/giu, '请求的资源不存在'],
  [/\bplease adjust your prompt and try again\b\.?/giu, '请调整提示词后重试'],
  [/\bplease adjust your prompt\b\.?/giu, '请调整提示词'],
  [/\bplease try again later\b\.?/giu, '请稍后重试'],
];

const H3_DIAGNOSTIC_SECTION_NAME = '(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)';
const H3_DIAGNOSTIC_SECTION_LABEL = new RegExp(`H3(?:章节|缺少必需章节：|章节顺序错误；正式顺序应为)“${H3_DIAGNOSTIC_SECTION_NAME}”(?:、“${H3_DIAGNOSTIC_SECTION_NAME}”)*`, 'gu');
const SEMANTIC_SEGMENT_TEXT_FIELD = '(?:title|content|summary|narrativePurpose|entryState|exitState|transitionHint|boundaryReason|continuityPack)';
// Match only sentences produced by our semantic-plan parser, including older
// saved diagnostics. These common field names are not a global English allowlist.
const SEMANTIC_SEQUENCE_DIAGNOSTICS: readonly RegExp[] = [
  /(?<![\w$.])segmentCount 必须(?:为 1–900 的整数|等于 segments 数量)/gu,
  /（segmentCount 与 segments 数量不一致）/gu,
  /固定模式 segmentCount 必须准确等于 T ÷ D(?![\w.-])/gu,
  /(?<![\w$.])segments 必须是非空数组/gu,
  /(?<![\w$.])reason 必须是字符串/gu,
  /(?<![\w$.])D × N 不得超过全片 3600 秒上限/gu,
  /(?<![\w$.])segmentDurationSec 必须等于输入 D(?![\w.-])/gu,
  /(?<![\w$.])totalDurationSec 必须等于 D × N(?![\w.-])/gu,
  new RegExp(`第 \\d+ 段字符串字段无效：${SEMANTIC_SEGMENT_TEXT_FIELD}(?:、${SEMANTIC_SEGMENT_TEXT_FIELD})*(?![\\w.$])`, 'gu'),
  /第 \d+ 段缺少 content 正文/gu,
  /第 \d+ 段 (?:durationSec|globalStartSec|globalEndSec|index) 与 D 固定窗口不一致/gu,
  /第 \d+ 段 缺少 semanticSource 对象/gu,
  /第 \d+ 段\.(?:sourceEvidence|events|dialogues) 必须是数组/gu,
  /第 \d+ 段\.sourceEvidence\[\d+\]\.text 必须是字符串/gu,
  /第 \d+ 段\.sourceEvidence\[\d+\] 原文位置必须成对提供有效范围/gu,
  /第 \d+ 段\.(?:events|dialogues)\[\d+\] 字段格式无效/gu,
];

/** These are local protocol diagnostics, never an allowlist for response prose.
 * Keep the same offsets so a later unknown English suffix is still localized. */
const maskSemanticSequenceDiagnostics = (value: string, blanks: (text: string) => string): string => {
  if (!/AI 语义分段结构无效[：:]/u.test(value)) return value;
  let result = value
    .replace(/(?<![\w$.])(?:\$\.)?fitStatus(?=\s*(?:枚举无效|缺失|不能为空|必须是字符串|不能是空字符串|不是支持的状态值))/gu, blanks)
    .replace(/允许值为 comfortable（宽裕）、balanced（适中）、compressed（紧凑）、insufficient（不足），必须仅返回一个英文状态，解释写入 reason(?![\w.-])/gu, blanks);
  for (const diagnostic of SEMANTIC_SEQUENCE_DIAGNOSTICS) result = result.replace(diagnostic, blanks);
  return result;
};

/** These names are our image-plan schema, not untranslated vendor prose. Time
 * values are accepted only in the exact boundary diagnostic and only when the
 * entire quoted value is a conventional numeric time; arbitrary text remains
 * subject to the normal unknown-English fallback. */
const maskGenerationStructureDiagnostics = (value: string, blanks: (text: string) => string): string => {
  let result = value;
  if (/AI (?:分镜)?图片规划|第 \d+ 张图片规划/u.test(result)) {
    result = result.replace(/\b(?:frames|framePlans|imageFrames|data|result|sourceShotId|description|timeSec)\b/gu, blanks);
  }
  if (/第 \d+ 镜时间边界无效/u.test(result)) {
    result = result.replace(/字段“(?:startSec|endSec|globalStartSec|globalEndSec|startTime|endTime|start|end)”=("[^"\\\r\n]*")/gu,
      (whole, quoted: string) => {
        const time = quoted.slice(1, -1).normalize('NFKC').trim();
        return /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:s|sec|secs|second|seconds|ms|秒|毫秒)?|(?:\d+:)?\d{1,2}:[0-5]\d(?:\.\d+)?)$/iu.test(time)
          ? blanks(whole) : whole;
      });
  }
  return result;
};

/** Leave technical names readable without treating them as untranslated prose. */
const unknownEnglishIndex = (value: string): number => {
  const blanks = (text: string) => ' '.repeat(text.length);
  const technical = /^(?:HTTP|HTTPS|API|AI|NSFW|SFW|NAI|NOVELAI|LLM|GPT|PNG|JPEG|JPG|WEBP|GIF|JSON|BASE64|UTF-8|DNS|TCP|TLS|SSL|URL|URI|IP|GPU|CPU|COMFYUI|WORKFLOW|LOADIMAGE|IPADAPTER|ELECTRON|MINIMAX|DEEPSEEK|OPENAI|ASR|MP4|WAV|B|KB|MB|GB|TB|KiB|MiB|GiB|TiB|BYTES|ENOSPC|EDQUOT|EACCES|EPERM|EBUSY|EROFS|ENOENT|ENOTDIR|EISDIR|EIO|EMFILE|ENFILE|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|sourceUnits|sourceUnitIds|sourceExcerpt|sourceShotIds|sourceBeatIds|sourceSceneIds|shots|masterShots|startSec|endSec|globalStartSec|globalEndSec|durationSec|boundaryAfterShotId)$/iu;
  const schemaAware = /AI交付|本次交付|交付对象|本轮已声明|本地交付数据校验/u.test(value)
    ? value.replace(/\b(?:identityBindings|shotMetadata|shotSourceIds|canonicalPrompt|h3Prompt|metadataPatch|characters)\b(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*/gu, blanks) : value;
  const remaining = maskGenerationStructureDiagnostics(maskSemanticSequenceDiagnostics(schemaAware, blanks), blanks)
    .replace(/人物“[^”\r\n]+”的原名或 Subject \/ 声源编号被改变，须保留已确认映射/gu, blanks)
    .replace(/\b(?:RunningHub|ZIP|ZIP64|CRC|CRC32|FFmpeg|FFprobe|MOV|WebM|Deflate)\b/giu, blanks)
    .replace(/\b(?:application|video|audio|text)\/[A-Za-z0-9.+-]+/gu, blanks)
    .replace(/https?:\/\/[^\s，。；）]+|[A-Za-z]:[\\/][^\r\n，；]+/giu, blanks)
    // A unit without whitespace (64MB) has no word boundary before M.
    // Preserve the whole numeric quantity and the Chinese detail after it.
    .replace(/\d+(?:\.\d+)?\s*(?:[KMGT]i?B|bytes?|B)\b/giu, blanks)
    // Keep identifiers only in explicit schema labels. Ordinary English prose
    // elsewhere must still reach the unknown-error fallback.
    .replace(/缺少必需字段[：:]\s*[A-Za-z][\w.\[\]-]*(?:\s*[、,，]\s*[A-Za-z][\w.\[\]-]*)*/gu, blanks)
    .replace(/（[A-Za-z]\w*(?:\s*或\s*[A-Za-z]\w*)*\s+单字段）/gu, blanks)
    .replace(/(?:模型|参数|字段|节点|状态码|错误码|代码)[：:\s“"'`]*([A-Za-z][\w.[\]/:-]*)/gu,
      (whole, token: string) => whole.slice(0, whole.length - token.length) + blanks(token))
    // The H3 parser emits these exact static syntax examples, not model prose.
    // Match their Chinese diagnostic context as well as the known markers; an
    // arbitrary quoted English sentence must still reach the fallback below.
    .replace(/H3章节“(?:integrated_multimodal_description|detailed_description)”未找到镜头标记“\[Shot N\]”/gu, blanks)
    .replace(/H3章节“integrated_multimodal_description”必须直接以首镜标记“\[Shot 1\]”开始/gu, blanks)
    .replace(/H3第\d+处镜头标记编号不连续；应为“\[Shot \d+\]”/gu, blanks)
    .replace(/H3第\d+镜缺少有效切点，要求“\[Shot \d+\] At MM:SS\.mmm”/gu, blanks)
    .replace(/H3首镜不应带切点；“\[Shot 1\]”之后应直接书写镜头正文/gu, blanks)
    .replace(H3_DIAGNOSTIC_SECTION_LABEL, blanks)
    // H3 sidecar identifiers in Chinese local diagnostics are schema labels,
    // not untranslated provider prose. Keep the exact path/reason visible.
    .replace(/(?:AI交付(?:第\d+镜)?|缺少|遗漏|声明|清空|包含|的)(?:identityBindings|shotMetadata|shotSourceIds|canonicalPrompt|h3Prompt|characters)(?:\.[A-Za-z]+|\[\d+\])*/gu, blanks)
    .replace(/源shot\.id/gu, blanks)
    // These are explicit AI segmentation schema diagnostics.  Keep both the
    // field names and their returned IDs visible in the final message while
    // excluding them from the untranslated-English fallback.  They are
    // protocol identifiers, not evidence that the provider returned opaque
    // English prose (for example, "master shot ID" is a field label here).
    .replace(/\bmaster\s+shots?\s+IDs?\b\s*[：:]?\s*[A-Za-z][\w.-]*/giu, blanks)
    .replace(/\b(?:boundaryAfterShotId|source(?:Beat|Shot|Scene)Ids?|global(?:Start|End)Sec|(?:start|end|duration)Sec)\b\s*[：:]?\s*[A-Za-z][\w.-]*/giu, blanks)
    .replace(/剧情节拍\s+ID\b\s*[：:]?\s*[A-Za-z][\w.-]*/gu, blanks)
    .replace(/\bmaster\s+shots?\b/giu, blanks)
    .replace(/\b[A-Za-z][A-Za-z0-9_.-]*\b/gu, (token) => technical.test(token) || /[\d_.-]/u.test(token) ? blanks(token) : token);
  return remaining.search(/[A-Za-z]/u);
};
const finish = (value: string): string => /[。！？!?]$/u.test(value) ? value : `${value}。`;

export const formatUserFacingError = (input: unknown, fallback?: string): string => {
  const safeFallback = typeof fallback === 'string' && hasChinese(fallback) ? fallback.trim() : UNKNOWN_ERROR;
  const response = readProperty(input, 'response');
  const statusValue = readProperty(input, 'status') ?? readProperty(input, 'statusCode') ?? readProperty(response, 'status');
  const numericStatus = (typeof statusValue === 'number' && Number.isFinite(statusValue))
    || (typeof statusValue === 'string' && /^-?\d{1,8}$/u.test(statusValue)) ? Number(statusValue) : undefined;
  const explicitStatus = numericStatus !== undefined && numericStatus >= 400 && numericStatus <= 599 ? numericStatus : undefined;
  const codeValue = readProperty(input, 'code');
  const code = typeof codeValue === 'string' || typeof codeValue === 'number' ? String(codeValue).trim() : '';
  let original = unwrapError(errorMessage(input));
  if (!original && readProperty(input, 'name') === 'AbortError') original = 'AbortError';
  if (!original && code) original = code;
  const inlineStatus = Number(original.match(/\b(?:HTTP[ /]*|status code\s+)([45]\d{2})\b/iu)?.[1]);
  const status = explicitStatus ?? (inlineStatus || undefined);
  // Older records stored only this generic parser failure. Explain the lack of
  // evidence without fabricating a provider response, refusal or finish reason.
  if (!code && numericStatus === undefined && /^(?:[^。\r\n]*[：:]\s*)?文本模型返回的[^。\r\n：:]{1,160}不是有效\s*JSON\s*对象[。.!]?$/u.test(original)) {
    original = `${original.replace(/[。.!]$/u, '')}；该旧记录未保存原始响应/结束原因，无法进一步确定`;
  }
  if (!original) return status ? finish(httpDescription(status)) : numericStatus !== undefined
    ? finish(`${safeFallback.replace(/。$/u, '')}（状态码：${numericStatus}）`) : safeFallback;
  const fileSystemCode = Object.prototype.hasOwnProperty.call(fileSystemReasons, code) ? code
    : original.match(/\b(?:ENOSPC|EDQUOT|EACCES|EPERM|EBUSY|EROFS|ENOENT|ENOTDIR|EISDIR|EIO|EMFILE|ENFILE)\b/u)?.[0];
  if (fileSystemCode && !status) {
    const codeIndex = original.indexOf(fileSystemCode);
    const prefix = codeIndex > 0 ? original.slice(0, codeIndex).trim() : '';
    const remoteContext = /(?:图像|视频|模型|文本|API)接口|上游|远端|远程服务|ComfyUI.*(?:请求|返回|服务)/iu.test(original);
    if (remoteContext) {
      const reason = fileSystemReasons[fileSystemCode].split('，')[0];
      const context = hasChinese(prefix) ? prefix.replace(/[：:，,（(\s]+$/u, '') : '上游服务错误';
      return finish(`${context}：远端文件系统${reason}（${fileSystemCode}），请联系服务提供方检查；这不表示本机磁盘或目录存在相同问题`);
    }
    const alreadyExplained = original.includes(fileSystemCode)
      && /磁盘空间不足|配额.*用尽|权限|系统拒绝|占用|只读|不存在|目录无效|指向.*目录|读写失败|文件过多|句柄不足/u.test(original);
    if (alreadyExplained && unknownEnglishIndex(original) < 0) return finish(original);
    const contextText = hasChinese(prefix) ? prefix : hasChinese(original) && unknownEnglishIndex(original) < 0 ? original : '本地文件操作失败';
    const context = contextText.replace(/[：:，,（(。\s]+$/u, '');
    return finish(`${context}：${fileSystemReasons[fileSystemCode]}（${fileSystemCode}）`);
  }
  const modelMatch = original.match(/\bmodel(?:_id)?\s*[:=]?\s*[`'"“]([^`'"”]+)[`'"”]|\bmodel(?:_id)?\s*[:=]\s*([\w./-]+)/iu);
  const model = modelMatch?.[1] || modelMatch?.[2];
  const certificateCodeOnly = Object.prototype.hasOwnProperty.call(certificateReasons, original) ? original : undefined;
  let localized = certificateCodeOnly ? `${certificateReasons[certificateCodeOnly]}（错误码：${certificateCodeOnly}）` : original;
  for (const [pattern, replacement] of translations) {
    localized = typeof replacement === 'string' ? localized.replace(pattern, replacement)
      : localized.replace(pattern, (...matches) => replacement(...matches));
  }
  const unknownAt = unknownEnglishIndex(localized);
  if (unknownAt >= 0 || !hasChinese(localized)) {
    const prefix = unknownAt > 0 ? localized.slice(0, unknownAt).trim() : '';
    const unknownDetail = !status && /(?:ZIP|压缩包).*(?:解压|提取|CRC|读取|校验|路径|无效|损坏)|(?:解压|提取).*(?:ZIP|压缩包)/iu.test(original)
      ? LOCAL_ARCHIVE_UNKNOWN_DETAIL
      : !status && /本地.*(?:结构|字段|时间轴|时轴)|(?:结构|字段|时轴).*本地/u.test(original)
      ? LOCAL_STRUCTURE_UNKNOWN_DETAIL
      : !status && /本地|磁盘|文件|目录|项目状态|恢复点|浏览器.*存储/u.test(original)
        ? LOCAL_UNKNOWN_DETAIL : UNKNOWN_DETAIL;
    localized = hasChinese(prefix)
      ? `${prefix}${/[：:。！？]$/u.test(prefix) ? '' : '：'}${unknownDetail}`
      : safeFallback;
  }
  if (status && !new RegExp(`HTTP\\s*${status}`, 'iu').test(localized)) localized = localized.replace(/。$/u, '') + `（${httpDescription(status)}）`;
  if (!status && numericStatus !== undefined && !localized.includes(String(numericStatus))) localized = localized.replace(/。$/u, '') + `（状态码：${numericStatus}）`;
  if (code && !localized.includes(code) && /^[\w.-]{1,80}$/u.test(code)) localized = localized.replace(/。$/u, '') + `（错误码：${code}）`;
  if (model && !localized.includes(model)) localized = localized.replace(/。$/u, '') + `（模型：${model}）`;
  return finish(localized.trim());
};
