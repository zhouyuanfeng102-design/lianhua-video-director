import assert from 'node:assert/strict';
import { formatUserFacingError } from '../src/userFacingError';

for (const localH3 of [
  'AI交付identityBindings格式无效，不能静默丢弃已声明的绑定记录。',
  'AI交付第1镜shotMetadata缺少明确的来源、可见范围或连续性字段，须由AI完整返回，不能由本地猜测合并。',
  'AI交付shotSourceIds条数与新镜头数不一致，不能同步来源与可见范围。',
  'AI交付shotSourceIds含未知或重复的源shot.id，不能同步来源与可见范围。',
]) {
  const wrapped = `最终视频提示词生成失败：AI已自动重试修复交付排程3次，仍未返回可同步的数据：${localH3}`;
  assert.equal(formatUserFacingError(wrapped), wrapped);
  assert.equal(formatUserFacingError(formatUserFacingError(wrapped)), wrapped);
}
assert.match(formatUserFacingError('AI交付identityBindings格式无效。额外原因：Unexpected vendor wobble'), /未识别/u,
  'schema labels must not whitelist unrelated provider prose');

const missingImage = '图像接口请求失败：Upstream did not return the expected image. Please adjust your prompt.';
const filteredImage = '图像接口请求失败：The generated image was filtered by the safety policy. Please adjust your prompt and try again.';
const upstreamChineseSafety = '图像接口请求失败：您的请求无法用于生成图像。该请求可能因安全政策被拦截，或不适合进行图像生成。';
assert.equal(formatUserFacingError(missingImage), '图像接口请求失败：上游服务未返回预期图像，请调整提示词。');
assert.equal(formatUserFacingError(filteredImage), '图像接口请求失败：生成的图像被安全策略拦截，请调整提示词后重试。');

const queueLimit = 'api queue limit reached, please retry later | API 并发数已达上线，请降低并发或稍后重试';
const queueLimitChinese = '接口并发生成数量已达上限，请等待正在运行的任务完成后再试。';
for (const original of [
  queueLimit, 'api queue limit reached, please retry later', 'API QUEUE LIMIT REACHED',
  'api_queue_limit_reached', 'API 并发数已达上线，请降低并发或稍后重试',
  'API 并发数已达上限，请降低并发或稍后重试。',
  `Error invoking remote method 'lianhua:http-request': Error: ${queueLimit}`,
]) {
  const shown = formatUserFacingError(original);
  assert.equal(shown, queueLimitChinese, original);
  assert.equal(formatUserFacingError(shown), shown, 'queue-limit explanations remain stable when displayed repeatedly');
  assert.doesNotMatch(shown, /暂时无法识别|余额|充值|提示词|审核|安全策略|模型/u);
}
const queueDiagnostic = Object.freeze({ message: queueLimit, status: 429, code: 'RH_QUEUE_FULL' });
const queueShown = formatUserFacingError(queueDiagnostic);
assert.match(queueShown, /接口并发生成数量已达上限/u);
assert.match(queueShown, /HTTP 429/u);
assert.match(queueShown, /错误码：RH_QUEUE_FULL/u);
assert.equal(queueDiagnostic.message, queueLimit, 'the provider original is not replaced by localized display');
assert.equal(formatUserFacingError(queueShown), queueShown);
assert.equal(formatUserFacingError(`RunningHub 请求失败：${queueLimit}`), `RunningHub 请求失败：${queueLimitChinese}`);
assert.equal(
  formatUserFacingError(upstreamChineseSafety),
  '图像接口请求失败：上游图像接口返回了内容安全拒绝（不是本地提交前门禁），请调整提示词或更换支持该内容的图像后端。',
);
assert.equal(
  formatUserFacingError('请先填写图像 API 地址。'),
  '请先填写图像 API 地址。',
  'local preflight errors must remain local and must not be mislabeled as upstream model refusals',
);
assert.ok(!formatUserFacingError(filteredImage).includes('绕过'), 'translation does not suggest bypassing safety policy');

const unavailableImageQuota = '图像接口请求失败：No available image quota. Please try again later.';
const overloadedImageService = '图像接口请求失败：System is overloaded. Please try again later.';
for (const [original, expected] of [
  [unavailableImageQuota, '图像接口请求失败：上游当前没有可用的图像生成额度，请稍后重试。'],
  [overloadedImageService, '图像接口请求失败：上游服务当前负载过高，请稍后重试。'],
  ['No available image quota.', '上游当前没有可用的图像生成额度。'],
  ['System is overloaded.', '上游服务当前负载过高。'],
  ['System overloaded. Please try again later.', '上游服务当前负载过高，请稍后重试。'],
  ['NO AVAILABLE IMAGE QUOTA. PLEASE TRY AGAIN LATER.', '上游当前没有可用的图像生成额度，请稍后重试。'],
]) {
  assert.equal(formatUserFacingError(original), expected, original);
  assert.equal(formatUserFacingError(expected), expected, 'localized provider errors remain stable when displayed again');
  assert.doesNotMatch(formatUserFacingError(original), /未识别|余额|充值|本地|安全策略/u, 'upstream capacity errors must not invent a local, account-balance or moderation cause');
}
assert.equal(
  formatUserFacingError("Error invoking remote method 'lianhua:http-request': Error: " + overloadedImageService),
  '图像接口请求失败：上游服务当前负载过高，请稍后重试。',
);
for (const [message, status, code, reason] of [
  [unavailableImageQuota, 429, 'image_quota_exhausted', '上游当前没有可用的图像生成额度'],
  [overloadedImageService, 503, 'server_overloaded', '上游服务当前负载过高'],
] as const) {
  const diagnostic = Object.freeze({ message, status, code });
  const beforeDiagnostic = JSON.stringify(diagnostic);
  const localized = formatUserFacingError(diagnostic);
  assert.ok(localized.startsWith(`图像接口请求失败：${reason}，请稍后重试`));
  assert.ok(localized.includes(`HTTP ${status}`), 'known provider errors retain the HTTP status');
  assert.ok(localized.includes(`错误码：${code}`), 'known provider errors retain the provider code');
  assert.equal(formatUserFacingError(localized), localized, 'status and code remain stable across repeated display');
  assert.equal(JSON.stringify(diagnostic), beforeDiagnostic, 'display localization must not replace the raw stored diagnostic');
}
for (const moderationError of [filteredImage, upstreamChineseSafety]) {
  assert.doesNotMatch(formatUserFacingError(moderationError), /额度|负载|繁忙/u, 'content-policy rejections must not become capacity errors');
}

// Regression: real 0.5.151 desktop image failures contain only this transport
// rejection, with no HTTP response/body or provider moderation decision.
const preTlsDisconnect = 'Client network socket disconnected before secure TLS connection was established';
const preTlsChinese = '与接口的 TLS 加密连接尚未建立就已断开，请检查服务地址、代理及网络连接；仅凭此错误无法确定具体断开原因。';
for (const original of [
  preTlsDisconnect,
  `Error invoking remote method 'lianhua:http-request': Error: ${preTlsDisconnect}`,
  `Error: Error invoking remote method 'lianhua:http-request': Error: ${preTlsDisconnect}\n    at TLSSocket.onConnectEnd (node:_tls_wrap:1732:19)`,
  'network socket disconnected before a secure SSL connection was established.',
]) {
  const localized = formatUserFacingError(original);
  assert.equal(localized, preTlsChinese, original);
  assert.equal(formatUserFacingError(localized), localized, 'TLS presentation must remain stable when logs format it again');
  assert.doesNotMatch(localized, /暂时无法识别|提示词|审核|余额|额度|充值|关闭.*校验|忽略.*证书/u);
}
assert.equal(formatUserFacingError(`图像接口请求失败：${preTlsDisconnect}`), `图像接口请求失败：${preTlsChinese}`);
const tlsDiagnostic = Object.freeze({ message: preTlsDisconnect, code: 'ECONNRESET', status: 503 });
const tlsDiagnosticBefore = JSON.stringify(tlsDiagnostic);
const tlsShown = formatUserFacingError(tlsDiagnostic);
assert.match(tlsShown, /TLS 加密连接尚未建立就已断开/u);
assert.match(tlsShown, /HTTP 503/u);
assert.match(tlsShown, /错误码：ECONNRESET/u);
assert.equal(formatUserFacingError(tlsShown), tlsShown, 'HTTP status and connection code must not be translated twice');
assert.equal(JSON.stringify(tlsDiagnostic), tlsDiagnosticBefore);
const tlsWithModel = formatUserFacingError(`${preTlsDisconnect}; model="gpt-image-2.5-sunburst"`);
assert.match(tlsWithModel, /TLS 加密连接尚未建立就已断开/u);
assert.match(tlsWithModel, /模型：gpt-image-2.5-sunburst/u, 'specific network diagnostics keep the requested model available');

for (const [message, code, reason] of [
  ['certificate has expired', 'CERT_HAS_EXPIRED', '服务证书已过期'],
  ['certificate is not yet valid', 'CERT_NOT_YET_VALID', '服务证书尚未到生效时间'],
  ["Hostname/IP does not match certificate's altnames: Host: api.example.test. is not in the cert's altnames: DNS:another.example.test", 'ERR_TLS_CERT_ALTNAME_INVALID', '服务地址与证书上的域名不匹配'],
  ['self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT', '服务使用了不受信任的自签名证书'],
  ['self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN', '服务证书链包含不受信任的自签名证书'],
  ['unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', '无法验证服务证书链'],
  ['unable to get issuer certificate', 'UNABLE_TO_GET_ISSUER_CERT', '找不到可验证服务证书的签发者证书'],
  ['unable to get local issuer certificate', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', '本机无法找到可验证服务证书的签发者证书'],
] as const) {
  for (const original of [{ message, code }, { code }, code, `Error invoking remote method 'lianhua:http-request': Error: ${message}`]) {
    const localized = formatUserFacingError(original);
    assert.ok(localized.startsWith(reason), `${message}: ${localized}`);
    assert.equal(formatUserFacingError(localized), localized, 'certificate reasons remain stable on repeated display');
    assert.doesNotMatch(localized, /暂时无法识别|提示词|安全策略|审核|余额|充值|关闭.*校验|忽略.*证书/u, 'certificate failures must not be mislabeled or suggest disabling certificate verification');
    if (typeof original !== 'string' || original === code) assert.ok(localized.includes(code), 'certificate errors preserve diagnostic codes');
  }
}
assert.match(formatUserFacingError('certificate verify failed'), /服务证书校验失败/u);

assert.equal(formatUserFacingError("Error invoking remote method 'lianhua:store-generated-image': Error: PNG 文件签名无效"), 'PNG 文件签名无效。');
assert.equal(formatUserFacingError("图片保存失败：Error invoking remote method 'lianhua:store-generated-image': Error: JPEG 文件签名无效"), '图片保存失败：JPEG 文件签名无效。');
assert.equal(formatUserFacingError("Error: Error invoking remote method 'lianhua:http-request': Error: " + missingImage), '图像接口请求失败：上游服务未返回预期图像，请调整提示词。');
assert.equal(formatUserFacingError('ComfyUI 连接失败，请检查服务是否启动。'), 'ComfyUI 连接失败，请检查服务是否启动。');
assert.equal(
  formatUserFacingError('当前 ComfyUI Workflow 没有连接到输出的 LoadImage 参考图节点。请导入带 LoadImage/IPAdapter 或图生图链路的 API Workflow。'),
  '当前 ComfyUI Workflow 没有连接到输出的 LoadImage 参考图节点。请导入带 LoadImage/IPAdapter 或图生图链路的 API Workflow。',
  'known ComfyUI graph terminology must not hide the actionable Chinese error detail',
);
assert.equal(formatUserFacingError('模型 qwen-image-2512 参数 seed 无效。'), '模型 qwen-image-2512 参数 seed 无效。');
assert.equal(formatUserFacingError('PNG/JPEG/WebP 文件签名无效。'), 'PNG/JPEG/WebP 文件签名无效。');
const slotMismatch = 'RunningHub 第 1 个图片槽用途为 first-frame，所选用途为 composition；请确认槽位用途，不会擅自将普通参考图当成首尾帧。';
const slotMismatchChinese = 'RunningHub 第 1 个图片槽用途为 首帧，所选用途为 构图参考；请确认槽位用途，不会擅自将普通参考图当成首尾帧。';
assert.equal(formatUserFacingError(slotMismatch), slotMismatchChinese);
assert.equal(formatUserFacingError(slotMismatchChinese), slotMismatchChinese, 'local slot diagnostic stays stable on repeated display');
assert.doesNotMatch(formatUserFacingError(slotMismatch), /未识别|服务返回|接口错误/u, 'local selection validation must not become an upstream failure');
assert.equal(
  formatUserFacingError('批量第 2 项的第 1 个图片槽用途为 first-frame，选图用途为 last-frame。'),
  '批量第 2 项的第 1 个图片槽用途为 首帧，选图用途为 尾帧。',
);
for (const [role, label] of [
  ['first-frame', '首帧'], ['last-frame', '尾帧'], ['composition', '构图参考'],
  ['character', '人物参考'], ['subject', '主体参考'], ['general', '通用参考'], ['unknown', '未分类'],
  ['scene', '场景参考'], ['prop', '道具参考'], ['style', '风格参考'], ['motion', '动作参考'],
  ['camera', '摄影参考'], ['audio', '声音参考'], ['dialogue', '对白参考'],
  ['clay-render', '白模参考'], ['creative', '创意参考'],
]) {
  const original = `第 2 个图片槽用途为 ${role}，不能接收用途为 character 的人物图；请调整映射，所有人物图都会保留。`;
  const expected = `第 2 个图片槽用途为 ${label}，不能接收用途为 人物参考 的人物图；请调整映射，所有人物图都会保留。`;
  assert.equal(formatUserFacingError(original), expected, role);
  assert.equal(formatUserFacingError(expected), expected, `${role}: localized slot roles remain stable`);
}
for (const unrelated of ['composition', 'character', 'subject', 'general', 'unknown', 'scene']) {
  assert.equal(
    formatUserFacingError(`图像接口请求失败：${unrelated} Unexpected vendor wobble`),
    '图像接口请求失败：服务返回了未识别的错误，暂时无法确定具体原因。',
    'local enum translations must not whitelist unknown English provider prose',
  );
}
assert.match(
  formatUserFacingError('RunningHub 第 1 个图片槽用途为 first-frame，所选用途为 compositionUnexpected'),
  /所选用途为：服务返回了未识别/u,
  'an unknown token beginning with a known role must not be partially translated',
);
const slotDiagnostic = Object.freeze({ message: slotMismatch, code: 'REFERENCE_SLOT_MISMATCH' });
assert.match(formatUserFacingError(slotDiagnostic), /所选用途为 构图参考/u);
assert.match(formatUserFacingError(slotDiagnostic), /错误码：REFERENCE_SLOT_MISMATCH/u);
assert.equal(slotDiagnostic.message, slotMismatch, 'localization must not mutate the stored original');
assert.equal(
  formatUserFacingError('分镜图片提示词转换失败，图像模型未调用：生图提示词自动修复后仍不合格：最终生图提示词淡化或遗漏了原文 NSFW 可见事实：男性生殖器细节、体液、射精或高潮反应'),
  '分镜图片提示词转换失败，图像模型未调用：生图提示词自动修复后仍不合格：最终生图提示词淡化或遗漏了原文 NSFW 可见事实：男性生殖器细节、体液、射精或高潮反应。',
  'known AI-domain acronyms in an otherwise Chinese diagnostic must not hide its concrete detail',
);

for (const [original, expected] of [
  ['Failed to fetch', '网络请求失败。'],
  ['NetworkError when attempting to fetch resource.', '网络请求失败。'],
  ['图像接口请求失败：fetch failed', '图像接口请求失败：网络请求失败。'],
  ['socket hang up', '连接被对端中断。'],
  ['connect ECONNREFUSED 127.0.0.1:8188', '无法连接到服务（ECONNREFUSED） 127.0.0.1:8188。'],
  ['getaddrinfo ENOTFOUND api.example.test', '无法解析服务地址（ENOTFOUND） api.example.test。'],
  ['Request timed out after 60000 ms', '请求等待超时（60000毫秒）。'],
  ['The operation timed out', '请求等待超时。'],
  ['timeout of 30000ms exceeded', '请求等待超时（30000毫秒）。'],
  ['context deadline exceeded', '请求等待超时。'],
  ['The operation was aborted', '操作已取消。'],
  ['Invalid API key', 'API 密钥无效。'],
  ['Invalid API key：请检查当前连接设置。', 'API 密钥无效：请检查当前连接设置。'],
  ['Authentication failed', '身份验证失败。'],
  ['Rate limit exceeded', '请求受到限流。'],
  ['Too Many Requests', '请求受到限流。'],
  ['insufficient_quota', '当前接口额度不足。'],
  ['Model "gpt-image-1" not found', '未找到模型“gpt-image-1”。'],
  ['The model `vendor-image` does not exist or you do not have access to it.', '模型“vendor-image”不存在，或当前账号无权访问该模型。'],
  ['model not found: krea-2', '未找到模型“krea-2”。'],
  ['Model qwen-image not found', '未找到模型“qwen-image”。'],
  ['Missing required parameter: prompt', '缺少必需参数“prompt”。'],
  ['Invalid parameter: seed', '参数“seed”无效。'],
  ['PNG file signature invalid', 'PNG 文件签名无效。'],
  ['Request failed with status code 429', '请求受到限流（HTTP 429）。'],
  ['HTTP 401 Unauthorized', '身份验证失败（HTTP 401）。'],
  ['接口调用失败：HTTP 403 Forbidden', '接口调用失败：没有访问权限（HTTP 403）。'],
  ['HTTP 502 Bad Gateway', '上游服务响应异常（HTTP 502）。'],
  ['HTTP 504 Gateway Timeout', '网关等待上游服务超时（HTTP 504）。'],
]) assert.equal(formatUserFacingError(original), expected, original);

for (const original of ['connect ECONNREFUSED 127.0.0.1:8188', 'read ECONNRESET', 'getaddrinfo ENOTFOUND api.example.test', 'EAI_AGAIN', 'ETIMEDOUT']) {
  const localized = formatUserFacingError(original);
  assert.equal(formatUserFacingError(localized), localized, 'existing connection codes stay stable across repeated presentation');
}

for (const empty of [undefined, null, '', '   ', new Error(), {}, { message: '' }]) {
  assert.equal(formatUserFacingError(empty), '操作失败，暂时无法识别具体原因。');
  assert.equal(formatUserFacingError(empty, '图像保存失败。'), '图像保存失败。');
}
assert.equal(formatUserFacingError(Object.assign(new Error(), { name: 'AbortError' })), '操作已取消。');
assert.match(formatUserFacingError({ code: 'ECONNRESET' }), /连接被对端中断.*ECONNRESET/u);
assert.equal(formatUserFacingError({ status: 401 }), '身份验证失败（HTTP 401）。');
assert.equal(formatUserFacingError({ response: { status: '429' } }), '请求受到限流（HTTP 429）。');
assert.match(formatUserFacingError({ status: 1004 }), /暂时无法识别具体原因.*状态码：1004/u);
assert.ok(!formatUserFacingError({ status: 1004 }).includes('HTTP'), 'proprietary API status codes remain visible without being called HTTP');
assert.match(formatUserFacingError({ code: 1004 }), /暂时无法识别具体原因.*错误码：1004/u);
assert.ok(!formatUserFacingError({ code: 1004 }).includes('HTTP'), 'vendor codes are not guessed to be HTTP status codes');

assert.equal(formatUserFacingError('Unexpected vendor wobble'), '操作失败，暂时无法识别具体原因。');
assert.equal(formatUserFacingError('图像接口请求失败：Unexpected vendor wobble'), '图像接口请求失败：服务返回了未识别的错误，暂时无法确定具体原因。');
const legacyH3MissingProtocol = '缺少完整H3官方section、连续[Shot N]或逐镜At切点，或返回了普通六字段时间轴。';
const legacyH3MissingProtocolShown = 'H3格式未完成：缺少官方章节、连续镜头编号或逐镜切点，或返回了普通六字段时间轴。';
const h3RetryPrefix = '最终视频提示词生成失败：AI已自动重试修复H3格式3次，但返回内容仍不符合官方格式：';
const h3PreservationSuffix = '本次新结果未保存，原有结果保持不变。';
const h3ScreenshotError = `${h3RetryPrefix}${legacyH3MissingProtocol}${h3PreservationSuffix}`;
const h3ScreenshotExpected = `${h3RetryPrefix}${legacyH3MissingProtocolShown}${h3PreservationSuffix}`;
for (const original of [
  h3ScreenshotError,
  new Error(h3ScreenshotError),
  `Error invoking remote method 'lianhua:http-request': Error: ${h3ScreenshotError}`,
  `Error: Error invoking remote method 'lianhua:http-request': Error: ${h3ScreenshotError}\n    at convert (converter.ts:42:1)`,
]) {
  const shownH3Error = formatUserFacingError(original);
  assert.equal(shownH3Error, h3ScreenshotExpected, 'the screenshot failure keeps its concrete H3 format cause and original-result protection');
  assert.doesNotMatch(shownH3Error, /服务返回|未识别|无法确定/u, 'a known H3 protocol diagnostic is not an unidentified provider failure');
  assert.equal(formatUserFacingError(shownH3Error), shownH3Error, 'H3 diagnostics remain stable on repeated formatting');
}
for (const [original, expected] of [
  [legacyH3MissingProtocol, legacyH3MissingProtocolShown],
  ['H3官方section名称或顺序与格式基准不一致。', 'H3格式未完成：官方章节名称或顺序与格式基准不一致。'],
  ['H3镜头数量、[Shot N]顺序或At切点与格式基准不一致。', 'H3格式未完成：镜头数量、编号顺序或逐镜切点与格式基准不一致。'],
  ['H3的Subject/Picture/Video/Audio参考标签集合与格式基准不一致。', 'H3格式未完成：主体、图片、视频或音频参考标签集合与格式基准不一致。'],
]) {
  const originalDiagnostic = Object.freeze({ message: original, code: 'H3_PROTOCOL_INVALID' });
  assert.equal(formatUserFacingError(original), expected);
  assert.equal(formatUserFacingError(expected), expected);
  assert.match(formatUserFacingError(originalDiagnostic), /H3格式未完成/u);
  assert.match(formatUserFacingError(originalDiagnostic), /错误码：H3_PROTOCOL_INVALID/u);
  assert.equal(originalDiagnostic.message, original, 'localization must not modify the original diagnostic or log');
  const withUnknownSuffix = formatUserFacingError(`${original}附加原因：Unexpected vendor wobble`);
  assert.equal(withUnknownSuffix, `${expected}附加原因：服务返回了未识别的错误，暂时无法确定具体原因。`);
  assert.doesNotMatch(withUnknownSuffix, /Unexpected|vendor|wobble/u, 'known H3 context must not whitelist an appended provider error');
}
for (const token of ['section', 'Shot', 'At', 'Subject', 'Picture', 'Video', 'Audio']) {
  assert.equal(
    formatUserFacingError(`图像接口请求失败：${token} Unexpected vendor wobble`),
    '图像接口请求失败：服务返回了未识别的错误，暂时无法确定具体原因。',
    `${token} remains unknown outside the exact H3 diagnostic`,
  );
}
for (const explicitH3Diagnostic of [
  'H3缺少必需章节：“integrated_multimodal_description”、“overall_soundscape”、“non_diegetic_music”；章节标题必须使用正式字段名和半角冒号。',
  'H3缺少必需章节：“subject_definitions”、“summary”、“retention_analysis”；章节标题必须使用正式字段名和半角冒号。',
  'H3章节顺序错误；正式顺序应为“subject_definitions”、“summary”、“retention_analysis”、“detailed_description”、“overall_soundscape”、“non_diegetic_music”。',
  'H3章节“integrated_multimodal_description”未找到镜头标记“[Shot N]”。',
  'H3章节“detailed_description”未找到镜头标记“[Shot N]”。',
  'H3章节“integrated_multimodal_description”必须直接以首镜标记“[Shot 1]”开始。',
  'H3第2处镜头标记编号不连续；应为“[Shot 2]”。',
  'H3第2镜缺少有效切点，要求“[Shot 2] At MM:SS.mmm”。',
  'H3首镜不应带切点；“[Shot 1]”之后应直接书写镜头正文。',
  'H3第3镜的切点“00:04.000”不晚于上一切点“00:05.000”；后续镜头的切点必须严格递增。',
  'H3章节“overall_soundscape”重复出现2次。',
  'H3章节“summary”重复出现2次。',
]) {
  assert.equal(formatUserFacingError(explicitH3Diagnostic), explicitH3Diagnostic, 'precise H3 parser diagnostics keep static protocol markers and timestamps');
  assert.equal(formatUserFacingError(formatUserFacingError(explicitH3Diagnostic)), explicitH3Diagnostic);
  const withUnknownSuffix = formatUserFacingError(`${explicitH3Diagnostic}附加原因：Unexpected vendor wobble`);
  assert.equal(withUnknownSuffix, `${explicitH3Diagnostic}附加原因：服务返回了未识别的错误，暂时无法确定具体原因。`);
}
for (const unrecognizedH3Diagnostic of [
  'H3第2镜缺少有效切点，要求“[Shot 2] At Unexpected vendor wobble”。',
  'H3章节“Unexpected vendor wobble”重复出现2次。',
  'H3缺少必需章节：“summary”、“Unexpected vendor wobble”。',
]) {
  assert.match(formatUserFacingError(unrecognizedH3Diagnostic), /服务返回了未识别/u,
    'a similar Chinese prefix must not allow arbitrary English prose in quotes');
  assert.doesNotMatch(formatUserFacingError(unrecognizedH3Diagnostic), /Unexpected|vendor|wobble/u);
}
const sequenceSchemaError = 'AI 长剧情分段及结构修复均未通过：AI 返回未知 master shot ID：master-shot-17；boundaryAfterShotId：master-shot-17；sourceBeatIds：beat-9；未知剧情节拍 ID：beat-9';
const sequenceSchemaShown = formatUserFacingError(sequenceSchemaError);
assert.equal(sequenceSchemaShown, `${sequenceSchemaError}。`, 'AI segmentation schema identifiers remain a concrete diagnostic');
assert.doesNotMatch(sequenceSchemaShown, /服务返回了未识别的错误|暂时无法确定具体原因/u);
assert.match(sequenceSchemaShown, /master shot ID：master-shot-17.*boundaryAfterShotId：master-shot-17.*sourceBeatIds：beat-9.*剧情节拍 ID：beat-9/u);
assert.equal(formatUserFacingError(sequenceSchemaShown), sequenceSchemaShown, 'segmentation schema diagnostics remain stable when shown repeatedly');
const semanticFitContract = '允许值为 comfortable（宽裕）、balanced（适中）、compressed（紧凑）、insufficient（不足），必须仅返回一个英文状态，解释写入 reason';
const semanticRetryPrefix = 'AI 语义分段结构无效：AI 分段已自动重试 3 次（共 4 次请求），最后仍未取得完整结果。；';
const semanticLegacyError = `${semanticRetryPrefix}fitStatus 枚举无效`;
for (const original of [
  'AI 语义分段结构无效：fitStatus 枚举无效', semanticLegacyError, new Error(semanticLegacyError),
  `AI 剧情分段失败：${semanticLegacyError}`,
  `Error invoking remote method 'lianhua:http-request': Error: ${semanticLegacyError}`,
]) {
  const shownSemantic = formatUserFacingError(original);
  assert.match(shownSemantic, /AI 语义分段结构无效：.*fitStatus 枚举无效。$/u);
  assert.doesNotMatch(shownSemantic, /未识别|暂时无法确定/u, 'a known semantic protocol field must not hide its Chinese diagnosis');
  assert.equal(formatUserFacingError(shownSemantic), shownSemantic, 'semantic diagnostics remain stable on repeated display');
}
for (const cause of ['缺失', '不能为空', '必须是字符串（收到数组）', '必须是字符串（收到对象）', '必须是字符串（收到数字）', '必须是字符串（收到布尔值）', '不能是空字符串', '不是支持的状态值']) {
  const original = `${semanticRetryPrefix}$.fitStatus ${cause}；${semanticFitContract}`;
  const expected = `${original}。`;
  assert.equal(formatUserFacingError(original), expected, cause);
  assert.equal(formatUserFacingError(expected), expected, `${cause}: repeated display preserves the explicit path and legal values`);
  const appended = formatUserFacingError(`${expected}附加原因：Unexpected vendor wobble`);
  assert.equal(appended, `${expected}附加原因：服务返回了未识别的错误，暂时无法确定具体原因。`);
  assert.doesNotMatch(appended, /Unexpected|vendor|wobble/u, 'the semantic context must not whitelist unrelated provider prose');
}
for (const cause of [
  'segmentCount 必须等于 segments 数量',
  'segmentCount 必须为 1–900 的整数',
  '旧格式段数字段 segmentCount 必须为 1–900 的整数；新格式无需填写该字段',
  '分段数量不一致：AI 声明 8 段，实际返回 6 段（segmentCount 与 segments 数量不一致）',
  '固定模式 segmentCount 必须准确等于 T ÷ D',
  '固定总时长需要 6 段（90 秒 ÷ 每段 15 秒），实际返回 5 段',
  'segments 必须是非空数组',
  'reason 必须是字符串',
  'D × N 不得超过全片 3600 秒上限',
  'segmentDurationSec 必须等于输入 D',
  'totalDurationSec 必须等于 D × N',
  '第 1 段字符串字段无效：title、content、summary、narrativePurpose、entryState、exitState、transitionHint、boundaryReason、continuityPack',
  '第 1 段缺少 content 正文',
  ...['durationSec', 'globalStartSec', 'globalEndSec', 'index'].map((field) => `第 1 段 ${field} 与 D 固定窗口不一致`),
  '第 1 段 缺少 semanticSource 对象',
  ...['sourceEvidence', 'events', 'dialogues'].map((field) => `第 1 段.${field} 必须是数组`),
  '第 1 段.sourceEvidence[0].text 必须是字符串',
  '第 1 段.sourceEvidence[0] 原文位置必须成对提供有效范围',
  '第 1 段.events[0] 字段格式无效',
  '第 1 段.dialogues[0] 字段格式无效',
]) {
  const original = `${semanticRetryPrefix}${cause}`;
  const expected = `${original}。`;
  assert.equal(formatUserFacingError(original), expected, `known local semantic cause stays visible: ${cause}`);
  assert.equal(formatUserFacingError(new Error(original)), expected, 'Error values use the same display path');
  assert.equal(formatUserFacingError(expected), expected, 'redisplay preserves retry counts, numeric evidence and protocol fields');
  assert.equal(formatUserFacingError(`${expected}附加原因：Unexpected vendor wobble`),
    `${expected}附加原因：服务返回了未识别的错误，暂时无法确定具体原因。`,
    'recognizing a local schema diagnostic must not allow an unrelated English suffix');
}
for (const token of ['fitStatus', 'comfortable', 'balanced', 'compressed', 'insufficient', 'reason',
  'segmentCount', 'segments', 'segmentDurationSec', 'totalDurationSec', 'content', 'semanticSource',
  'title', 'summary', 'narrativePurpose', 'entryState', 'exitState', 'transitionHint', 'boundaryReason', 'continuityPack',
  'sourceEvidence', 'events', 'dialogues', 'index']) {
  assert.equal(formatUserFacingError(`图像接口请求失败：${token}`), '图像接口请求失败：服务返回了未识别的错误，暂时无法确定具体原因。',
    `${token} is not an English allowlist entry outside the semantic diagnostic`);
  assert.equal(formatUserFacingError(`AI 语义分段结构无效：${token} Unexpected vendor wobble`), 'AI 语义分段结构无效：服务返回了未识别的错误，暂时无法确定具体原因。',
    `${token} still needs its exact Chinese diagnostic context`);
}
for (const original of [
  'AI 语义分段结构无效：fitStatusUnexpected 枚举无效',
  'AI 语义分段结构无效：segmentCountUnexpected 必须等于 segments 数量',
  'AI 语义分段结构无效：segmentsUnexpected 必须是非空数组',
  'AI 语义分段结构无效：分段数量不一致：AI 声明 8 段，实际返回 6 段（segmentCount 与 Unexpected 数量不一致）',
  'AI 语义分段结构无效：第 1 段字符串字段无效：title、Unexpected',
  'AI 语义分段结构无效：第 1 段缺少 contentUnexpected 正文',
  `AI 语义分段结构无效：$.fitStatus 不是支持的状态值；${semanticFitContract.replace('balanced（适中）', 'Unexpected vendor wobble（适中）')}`,
  `AI 语义分段结构无效：$.fitStatus 不是支持的状态值；${semanticFitContract.replace('reason', 'reasonUnexpected')}`,
]) {
  assert.match(formatUserFacingError(original), /服务返回了未识别/u, 'near-matching protocol words must not bypass unknown-English localization');
  assert.doesNotMatch(formatUserFacingError(original), /Unexpected|vendor|wobble/u);
}
for (const unrelated of ['segmentCount 必须等于 segments 数量', 'segments 必须是非空数组', 'reason 必须是字符串']) {
  assert.equal(formatUserFacingError(`图像接口请求失败：${unrelated}`),
    '图像接口请求失败：服务返回了未识别的错误，暂时无法确定具体原因。',
    'known local diagnostics still require the semantic-sequence error context');
}
const frozenSemanticDiagnostic = Object.freeze({ message: semanticLegacyError, code: 'SEMANTIC_PROTOCOL_INVALID' });
assert.match(formatUserFacingError(frozenSemanticDiagnostic), /fitStatus 枚举无效.*错误码：SEMANTIC_PROTOCOL_INVALID/u);
assert.equal(frozenSemanticDiagnostic.message, semanticLegacyError, 'presentation leaves the original technical diagnostic unchanged');
assert.equal(formatUserFacingError('Unexpected vendor wobble', '图像生成失败。'), '图像生成失败。');
assert.equal(formatUserFacingError('Oops', 'Image failed'), '操作失败，暂时无法识别具体原因。');
assert.match(formatUserFacingError('Weird failure for model "qwen-image" (HTTP 520)'), /暂时无法识别具体原因.*HTTP 520.*模型：qwen-image/u);
assert.doesNotMatch(formatUserFacingError('Unexpected vendor wobble'), /提示词|额度|安全策略|日志/u, 'unknown errors do not guess a cause or claim logs exist');
assert.equal(
  formatUserFacingError('AI 分镜未覆盖全部原文 sourceUnits，缺少：source-2、source-9'),
  '旧版本地原文定位检查未通过（不是接口错误），缺少片段：source-2、source-9。',
);
assert.equal(
  formatUserFacingError('本地无法读取 AI 分镜结构：文本模型返回的第 2 镜缺少文本字段“subject”'),
  '本地无法读取 AI 分镜结构：文本模型返回的第 2 镜缺少文本字段“subject”。',
);
const localSubjectLog = formatUserFacingError('最终视频提示词生成失败：转化器本次自动修复未完成（已调用同一 API 修复 1 次，未覆盖已有结果）：第 1 镜主体“@林沐”不属于 allowedSubjects 允许的稳定主体：@我。');
assert.match(localSubjectLog, /旧版本地人物名单检查（不是接口错误）/u);
assert.match(localSubjectLog, /@林沐.*@我/u);
assert.doesNotMatch(localSubjectLog, /服务返回了未识别|文件与存储状态/u);
const localStructureLog = formatUserFacingError('本地转换结构读取失败：Unexpected structure text');
assert.match(localStructureLog, /本地结构读取未完成/u);
assert.doesNotMatch(localStructureLog, /服务返回了未识别|文件与存储状态/u);
assert.equal(formatUserFacingError('RunningHub 已生成 ZIP，正在解压保存'), 'RunningHub 已生成 ZIP，正在解压保存。');
assert.match(formatUserFacingError('ZIP 解压失败：invalid central directory'), /压缩包在本地读取或解压失败/u);
assert.doesNotMatch(formatUserFacingError('ZIP 解压失败：invalid central directory'), /服务返回了未识别/u);
assert.match(formatUserFacingError('结果地址返回了非媒体内容：text/html'), /text\/html/u);

const raw = Object.freeze({ message: missingImage, code: 'VENDOR_42', response: Object.freeze({ status: 502 }) });
const before = JSON.stringify(raw);
const shown = formatUserFacingError(raw);
assert.match(shown, /^图像接口请求失败：上游服务未返回预期图像/u);
assert.match(shown, /HTTP 502/u);
assert.match(shown, /VENDOR_42/u);
assert.equal(JSON.stringify(raw), before, 'raw error remains untouched for existing state/log diagnostics');
assert.equal(raw.message, missingImage);
const circular: { cause?: unknown } = {}; circular.cause = circular;
assert.doesNotThrow(() => formatUserFacingError(circular));
const getterError = Object.defineProperty({}, 'message', { get() { throw new Error('bad getter'); } });
assert.doesNotThrow(() => formatUserFacingError(getterError));

for (const message of [
  'AI 图片规划的 JSON 未包含 frames 图片规划数组；也支持根数组或 data/result 封套（响应 15 字符）。',
  'AI 图片规划包含多个 frames/data/result 规划，无法确定唯一结果（响应 30 字符）。',
  '第 1 张图片规划的 sourceShotId 不属于当前视频分镜。',
  '第 2 张图片规划缺少 description 画面描述。',
  '第 3 张图片规划的 timeSec 必须是数字，不能确定时请省略。',
  '文本模型返回的第 1 镜时间边界无效：字段“startSec”不是有效秒数；收到字段“startSec”=空值，字段“endSec”="15 seconds"；当前输出范围0–15秒。',
]) {
  assert.equal(formatUserFacingError(message), message, 'structured errors keep the exact field, reason and range visible');
  assert.equal(formatUserFacingError(formatUserFacingError(message)), message);
}
for (const message of [
  'AI 图片规划失败：frames unexpected vendor explanation',
  '第 1 张图片规划失败：descriptionUnexpected',
  '文本模型返回的第 1 镜时间边界无效：字段“endSec”="15 seconds vendor explanation"',
  '外部服务异常：frames data result',
]) assert.match(formatUserFacingError(message), /未识别/u, 'schema handling never whitelists unrelated English prose');
console.log('userFacingError: Chinese contexts, exact image errors, Electron wrappers, TLS/certificate/network/auth/rate/timeout/model/parameter/status, stable redisplay, unknown fallbacks and immutable inputs passed');
