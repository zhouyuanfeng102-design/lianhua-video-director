import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { importRunningHubImageWorkflow } from '../src/runningHubImage';
import { requestRunningHubImage } from '../src/services/runningHubImage';
import type { ImageApiConfig } from '../src/types';

test('a failed result download preserves the successful cloud image for save retry without another run', async () => {
  const imported = importRunningHubImageWorkflow(readFileSync('public/workflows/krea2-runninghub-image.json', 'utf8'), 'Krea2');
  const config: ImageApiConfig = {
    backend: 'runninghub', enabled: true, baseUrl: imported.baseUrl!, apiKey: 'FAKE_OFFLINE_KEY', model: '',
    runningHubWorkflows: [imported.workflow], activeRunningHubWorkflowId: imported.workflow.id,
  };
  let submissions = 0;
  let downloads = 0;
  const url = 'https://example.invalid/completed.png';
  const result = await requestRunningHubImage(config, { prompt: '测试已生成结果保存恢复' }, {
    request: async endpoint => {
      assert.match(endpoint, /\/run\/ai-app\//u);
      submissions += 1;
      return { status: 200, body: JSON.stringify({ taskId: 'completed-original-task', status: 'SUCCESS',
        results: [{ nodeId: '78', outputType: 'png', url }] }) };
    },
    downloadImage: async () => { downloads += 1; throw new Error('offline download interruption'); },
  });
  assert.equal(submissions, 1);
  assert.equal(downloads, 1);
  assert.equal(result.url, url);
  assert.equal(result.dataUrl, undefined);
  assert.equal(JSON.parse(result.raw).taskId, 'completed-original-task');
  assert.equal(JSON.parse(result.raw).status, 'SUCCESS');
});
