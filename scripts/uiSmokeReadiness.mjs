import { waitForCondition } from './qaProcessHarness.mjs';

const isTransientNavigationError = (error) => /(?:execution context.*destroyed|cannot find (?:default )?context|inspected target navigated)/iu
  .test(error instanceof Error ? error.message : String(error || ''));

export const reloadAndWaitForAppShell = async ({
  intervalMs = 100,
  label = 'refreshed application shell',
  markCurrentDocument,
  readStatus,
  reload,
  timeoutMs,
}) => {
  await markCurrentDocument();
  await reload();
  await waitForCondition({
    intervalMs,
    label,
    timeoutMs,
    check: async (remainingMs) => {
      let status;
      try {
        status = await readStatus(remainingMs);
      } catch (error) {
        if (isTransientNavigationError(error)) return false;
        throw error;
      }
      return Boolean(
        status?.documentReady
        && !status.previousDocument
        && status.appShellFound
        && status.settingsTriggerFound
        && status.requiredStateReady,
      );
    },
  });
};
