/** A normal release always contains both clients. A single-client build is an
 * explicit exception for a UI fix isolated to that client. */
export function deliveryTargets(args = []) {
  if (args.length === 0) return ['windows', 'android'];
  if (args.length === 1 && args[0] === '--ui-only=windows') return ['windows'];
  if (args.length === 1 && args[0] === '--ui-only=android') return ['android'];
  throw new Error('Usage: [--ui-only=windows|--ui-only=android]. Omit the option to build and deliver both EXE and APK.');
}

export function includeRecoverySource(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const name = normalized.split('/').at(-1);
  if (/\.(?:jks|keystore|p12|pfx|pem|key)$/iu.test(name)) return false;
  if (/^(?:local|keystore|signing)\.properties$/iu.test(name)) return false;
  if (normalized.startsWith('android/')) {
    const parts = normalized.split('/');
    if (parts.some((part) => ['build', '.gradle', '.idea', '.cxx', 'node_modules'].includes(part))) return false;
    if (/\.(?:apk|aab|iml)$/iu.test(name)) return false;
    if (normalized.startsWith('android/app/src/main/assets/public/')) return false;
  }
  return true;
}
