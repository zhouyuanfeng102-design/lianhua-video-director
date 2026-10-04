import fs from 'node:fs';
import path from 'node:path';

export const captureOptionalQaArtifact = async (label, createArtifact) => {
  try {
    await createArtifact();
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${label}: ${detail}`;
  }
};

const writeQaReport = (outputDirectory, report) => {
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
};

export const runWithPersistentQaReport = async (outputDirectory, report, run) => {
  Object.assign(report, { passed: false, status: 'running', error: null });
  writeQaReport(outputDirectory, report);
  try {
    await run();
  } catch (error) {
    Object.assign(report, {
      passed: false,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    writeQaReport(outputDirectory, report);
    throw error;
  }
  Object.assign(report, { passed: true, status: 'passed', error: null });
  writeQaReport(outputDirectory, report);
  return report;
};
