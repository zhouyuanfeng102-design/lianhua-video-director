import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const defaultPorts = { 'desktopQa.mjs': 9331, 'mediaQa.mjs': 9332 };

const listen = (port) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server));
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

const withoutCdpPort = () => {
  const environment = { ...process.env };
  delete environment.CDP_PORT;
  return environment;
};

const createFixture = (scriptName) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-qa-launcher-port-'));
  const workingDirectory = path.join(temporaryRoot, 'workspace');
  const scriptsDirectory = path.join(workingDirectory, 'scripts');
  const electronExecutable = path.join(workingDirectory, 'node_modules', 'electron', 'dist', 'electron.exe');
  const configured = {
    backup: path.join(temporaryRoot, 'isolated-backup'),
    data: path.join(temporaryRoot, 'isolated-data'),
    output: path.join(temporaryRoot, 'isolated-output'),
  };
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(electronExecutable), { recursive: true });
  try {
    fs.linkSync(process.execPath, electronExecutable);
  } catch {
    fs.copyFileSync(process.execPath, electronExecutable);
  }
  fs.writeFileSync(path.join(workingDirectory, 'package.json'), JSON.stringify({
    main: 'fakeElectron.mjs',
    type: 'module',
  }));
  fs.writeFileSync(path.join(workingDirectory, 'fakeElectron.mjs'), `
    import fs from 'node:fs';
    import net from 'node:net';
    import path from 'node:path';
    const portArgument = process.argv.find((argument) => argument.startsWith('--remote-debugging-port='));
    const port = Number(portArgument?.split('=').at(-1));
    const outputDirectory = path.resolve(process.env.QA_OUTPUT);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const server = net.createServer();
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      fs.writeFileSync(path.join(outputDirectory, 'electron-observed.json'), JSON.stringify({ port }));
    });
    setInterval(() => {}, 1000);
  `);
  const waitForElectron = `
    import fs from 'node:fs';
    import path from 'node:path';
    const observed = path.join(path.resolve(process.env.QA_OUTPUT), 'electron-observed.json');
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(observed) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!fs.existsSync(observed)) throw new Error('fake Electron did not bind its QA port');
  `;
  fs.writeFileSync(path.join(scriptsDirectory, 'electronSmoke.mjs'), waitForElectron);
  fs.writeFileSync(path.join(scriptsDirectory, 'mediaUiSmoke.mjs'), waitForElectron);
  fs.writeFileSync(path.join(scriptsDirectory, 'videoTaskIpcSmoke.mjs'), 'process.exitCode = 0;\n');

  const environment = {
    ...withoutCdpPort(),
    LIANHUA_DATA_DIR: configured.data,
    LIANHUA_QA_BACKUP_DIR: configured.backup,
    QA_CLOSE_TIMEOUT_MS: '3000',
    QA_OUTPUT: configured.output,
    QA_RUN_TIMEOUT_MS: '5000',
  };
  const run = (extraEnvironment = {}) => spawnSync(
    process.execPath,
    [path.join(root, 'scripts', scriptName)],
    {
      cwd: workingDirectory,
      encoding: 'utf8',
      env: { ...environment, ...extraEnvironment },
      timeout: 10_000,
    },
  );
  return { configured, run, temporaryRoot };
};

test('desktop and media QA dynamically avoid the legacy fixed ports and release their chosen ports', async (t) => {
  const occupied = [];
  for (const port of Object.values(defaultPorts)) occupied.push(await listen(port));
  t.after(async () => Promise.all(occupied.map(close)));

  for (const [scriptName, legacyPort] of Object.entries(defaultPorts)) {
    const fixture = createFixture(scriptName);
    try {
      const result = fixture.run();
      assert.equal(result.status, 0, `${scriptName}\n${result.stdout}\n${result.stderr}`);
      const observedPath = path.join(fixture.configured.output, 'electron-observed.json');
      const observed = JSON.parse(fs.readFileSync(observedPath, 'utf8'));
      assert.ok(Number.isInteger(observed.port) && observed.port > 0 && observed.port <= 65_535);
      assert.notEqual(observed.port, legacyPort);
      const released = await listen(observed.port);
      await close(released);
    } finally {
      fs.rmSync(fixture.temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

for (const scriptName of Object.keys(defaultPorts)) {
  test(`${scriptName} rejects an explicitly invalid CDP_PORT before Electron starts`, () => {
    const fixture = createFixture(scriptName);
    try {
      const result = fixture.run({ CDP_PORT: 'not-a-port' });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /Invalid CDP_PORT: not-a-port/u);
      assert.equal(fs.existsSync(path.join(fixture.configured.output, 'electron-observed.json')), false);
    } finally {
      fs.rmSync(fixture.temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
}
