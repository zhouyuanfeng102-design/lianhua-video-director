import fs from 'node:fs';
import path from 'node:path';
import { nextReleaseVersion } from './releaseVersion.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error('Usage: npm run next-version -- [current-version]');
  const currentVersion = args[0] ?? JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
  ).version;
  // This command only prints a suggestion. It never edits metadata or publishes.
  console.log(nextReleaseVersion(currentVersion));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
