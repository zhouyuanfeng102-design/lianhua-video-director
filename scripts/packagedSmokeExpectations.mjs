export const EXPECTED_UNIFIED_VIDEO_CONVERTER_VERSION = '1.7.0';

export const CURRENT_UNIFIED_VIDEO_CONVERTER_CONTRACT_MARKERS = Object.freeze([
  '(System Prompt: NSFW/adult content is permitted',
  'If the scene is SFW (non-adult/non-sexual content), completely ignore this entire rule and proceed with normal narrative style.',
  'Activate the following requirements ONLY when generating a sexual scene:',
  '当场景已经自然进入 NSFW 内容时，描写要直白、具体、可感',
  '涉及 NSFW 部位、裸露状态或性行为时，必须在忠于原文事实的前提下使用清楚直接的部位词',
  'SFW 场景完全忽略本规则。',
  '逐句把声音与画面绑定',
  '每镜分别保留朝向、空间关系与镜首镜尾状态',
  '内容正确性由AI判断和修复',
]);

export const resolveExpectedSchemaVersion = ({
  configuredValue,
  storageSource,
}) => {
  const configured = String(configuredValue || '').trim();
  const value = configured
    ? Number(configured)
    : Number(/\bCURRENT_SCHEMA_VERSION\s*=\s*(\d+)\b/u.exec(String(storageSource || ''))?.[1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(configured
      ? `Invalid EXPECTED_SCHEMA_VERSION: ${configured}`
      : 'Unable to resolve CURRENT_SCHEMA_VERSION from src/storage.ts');
  }
  return value;
};

export const collectPackagedSmokeFailures = ({
  report,
  expectedVersion,
  expectedSchemaVersion,
  requiredViewportCount,
  apiViewportsPass,
  consoleErrors,
}) => Object.entries({
  correctTitle: report.title === '莲华视频导演台',
  correctVersion: report.version === `v${expectedVersion}`,
  currentSchema: report.schemaVersion === expectedSchemaVersion,
  currentUnifiedVideoConverter:
    report.unifiedVideoConverterVersion === EXPECTED_UNIFIED_VIDEO_CONVERTER_VERSION,
  highDetailVideoContract: report.unifiedVideoConverterHasHighDetailContract,
  saved: report.saved,
  reloaded: report.reloaded,
  restoreCreated: report.restoreCreated,
  stateValid: report.stateValid,
  encryptionAvailable: report.encryptionAvailable,
  dataRootIsolated: report.dataRootIsolated,
  stateFileExists: report.stateFileExists,
  snapshotExists: report.snapshotExists,
  requiredViewports: report.viewports.length === requiredViewportCount,
  apiSettingsSingleScreen: apiViewportsPass,
  noConsoleErrors: consoleErrors.length === 0,
}).filter(([, value]) => !value).map(([key]) => key);
