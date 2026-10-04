import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build, preview } from 'vite';
import { chromium } from 'playwright';
import { findAvailableTcpPort } from './qaProcessHarness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = path.join(root, '.runtime-temp');
const maximumJavaScriptChunkBytes = 500 * 1024;

const findJavaScriptFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });

test('production JavaScript chunks stay within the 500 KiB delivery budget', { timeout: 120_000 }, async () => {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const outputDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'bundle-budget-'));

  try {
    const built = await build({
      configFile: path.join(root, 'vite.config.ts'),
      root,
      logLevel: 'silent',
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
      },
    });

    const outputs = (Array.isArray(built) ? built : [built]).flatMap((result) => result.output || []);
    const contracts = outputs.find((output) => output.type === 'chunk' && output.name === 'generation-contracts');
    assert.ok(contracts, 'shared generation contracts must have their own leaf chunk');
    assert.deepEqual(contracts.imports, [], 'the shared contracts chunk must not import domain/renderer state and introduce an initialization cycle');
    assert.deepEqual(contracts.dynamicImports, [], 'contract splitting must not add lazy-loading runtime paths');
    const containsSource = (chunk, file) => chunk.moduleIds.some((id) => id.replace(/\\/gu, '/').endsWith(`/src/${file}`));
    for (const file of ['h3IdentityBindings.ts', 'h3StagingMetadata.ts', 'h3DeliverySchema.ts', 'h3DeliveryRepair.ts', 'h3OutputRecovery.ts', 'videoH3ReferenceBinding.ts', 'storyboardImagePlanJson.ts', 'rhtvBridge.ts', 'imagePromptIdentityContext.ts']) {
      assert.ok(containsSource(contracts, file), `${file} must remain in the shared leaf layer, not introduce a contracts -> domain back edge`);
    }
    const delivery = outputs.find((output) => output.type === 'chunk' && output.name === 'h3-delivery');
    assert.ok(delivery && containsSource(delivery, 'h3StagingDelivery.ts'), 'H3 staging serialization depends on the prompt foundation and belongs in the delivery layer, not the leaf contracts');
    const settings = outputs.find((output) => output.type === 'chunk' && output.name === 'video-workflow-settings');
    assert.ok(settings && containsSource(settings, 'components/RhTvBridgeSettings.tsx'), 'rhTV controls belong with the video settings UI, not the shared domain layer');

    const chunks = findJavaScriptFiles(outputDirectory).map((filePath) => ({
      file: path.relative(outputDirectory, filePath),
      size: fs.statSync(filePath).size,
    }));
    assert.ok(chunks.length > 0, 'the production build must emit at least one JavaScript chunk');

    const oversizedChunks = chunks.filter(({ size }) => size > maximumJavaScriptChunkBytes);
    assert.deepEqual(
      oversizedChunks,
      [],
      `JavaScript chunks over 500 KiB: ${oversizedChunks
        .map(({ file, size }) => `${file} (${(size / 1024).toFixed(2)} KiB)`)
        .join(', ')}`,
    );

    // Budget reductions must also survive eager ES-module initialization.
    // Serve the actual production output to a fresh browser, never a desktop
    // profile; external/API traffic is blocked and not part of this smoke.
    let server;
    let browser;
    try {
      const port = await findAvailableTcpPort();
      const origin = `http://127.0.0.1:${port}`;
      server = await preview({ configFile: false, root, logLevel: 'silent', build: { outDir: outputDirectory },
        preview: { host: '127.0.0.1', port, strictPort: true } });
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const pageErrors = [];
      const unexpectedRequests = [];
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      await page.route('**/*', async (route) => {
        const request = route.request(); const url = new URL(request.url());
        if (/^https?:$/u.test(url.protocol) && (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()))) {
          unexpectedRequests.push(`${request.method()} ${url.pathname}`);
          await route.abort('blockedbyclient'); return;
        }
        await route.continue();
      });
      await page.goto(`${origin}/`, { waitUntil: 'networkidle', timeout: 20000 });
      await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
      await page.locator('.source-settings-card').waitFor({ state: 'visible' });
      assert.deepEqual(pageErrors, [], 'production chunks must initialize without TDZ/circular-import crashes');
      assert.deepEqual(unexpectedRequests, [], 'fresh production entry must not make paid or external API calls');
    } finally {
      await browser?.close();
      if (server) await new Promise((resolve) => server.httpServer.close(resolve));
    }
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});
