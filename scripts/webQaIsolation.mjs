import net from 'node:net';
import path from 'node:path';

const normalizedPath = (value) => {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const commandLineValue = (argumentsList, option) => {
  const prefix = `${option}=`;
  const inline = argumentsList.find((argument) => String(argument).startsWith(prefix));
  if (inline !== undefined) return String(inline).slice(prefix.length);
  const optionIndex = argumentsList.findIndex((argument) => argument === option);
  return optionIndex >= 0 ? argumentsList[optionIndex + 1] : undefined;
};

export const assertLoopbackPortAvailable = (port, label = 'CDP_PORT') => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      reject(new Error(`${label} ${port} is already in use; refusing to attach to an existing service`));
      return;
    }
    reject(error);
  });
  server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

export const assertIsolatedBrowserIdentity = (
  argumentsList,
  { browserData, cdpPort },
) => {
  if (!Array.isArray(argumentsList)) {
    throw new Error('Edge debugger did not expose its browser command line');
  }
  const actualProfile = commandLineValue(argumentsList, '--user-data-dir');
  if (!actualProfile || normalizedPath(actualProfile) !== normalizedPath(browserData)) {
    throw new Error('Edge debugger does not belong to the expected QA profile');
  }
  const actualPort = Number(commandLineValue(argumentsList, '--remote-debugging-port'));
  if (!Number.isInteger(actualPort) || actualPort !== Number(cdpPort)) {
    throw new Error('Edge debugger does not belong to the expected QA CDP port');
  }
};

export const requestVerifiedBrowserClose = async ({
  browserData,
  browserCloseMethod = 'Browser.close',
  cdpPort,
  command,
}) => {
  const commandLine = await command('Browser.getBrowserCommandLine');
  assertIsolatedBrowserIdentity(commandLine?.arguments, { browserData, cdpPort });
  await command(browserCloseMethod, {}, { allowDisconnect: true });
};

export const cleanupIsolatedBrowser = async ({ closeBrowser, stopBrowserByProfile }) => {
  const errors = [];
  try {
    await closeBrowser();
  } catch (error) {
    errors.push(error);
  }
  try {
    await stopBrowserByProfile();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'isolated Edge cleanup failed');
};
