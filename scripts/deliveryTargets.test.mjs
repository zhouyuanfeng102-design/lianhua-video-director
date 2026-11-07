import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryTargets, includeRecoverySource } from './deliveryTargets.mjs';

test('delivery targets default to both clients and require an explicit UI-only exception', () => {
  assert.deepEqual(deliveryTargets(), ['windows', 'android']);
  assert.deepEqual(deliveryTargets(['--ui-only=windows']), ['windows']);
  assert.deepEqual(deliveryTargets(['--ui-only=android']), ['android']);
  for (const args of [['android'], ['--windows'], ['--ui-only=ios'], ['--ui-only=android', '--ui-only=windows']]) {
    assert.throws(() => deliveryTargets(args), /Usage/u);
  }
});

test('recovery sources retain Android code while excluding signing secrets and generated files', () => {
  for (const file of [
    'android/app/src/main/java/com/lianhua/video_director/MainActivity.java',
    'android/app/src/main/AndroidManifest.xml', 'android/app/build.gradle',
    'android/gradle/wrapper/gradle-wrapper.properties', 'android/gradlew.bat',
    'capacitor.config.ts', 'src/platform/androidBridge.ts',
  ]) assert.equal(includeRecoverySource(file), true, `${file} must be recoverable`);
  for (const file of [
    'android/app/release.jks', 'android/secret.keystore', 'android/signing.properties',
    'android/local.properties', 'android/keystore.properties', 'android/app/private.key',
    'android/.gradle/cache.bin', 'android/app/build/outputs/apk/release/app-release.apk',
    'android/app/.cxx/cache', 'android/.idea/workspace.xml',
    'android/app/src/main/assets/public/index.html', 'android/app/release.aab',
    'android\\app\\build\\intermediates\\cache.bin',
  ]) assert.equal(includeRecoverySource(file), false, `${file} must stay local`);
});
