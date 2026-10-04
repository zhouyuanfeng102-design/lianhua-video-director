export const DECIMAL_RELEASE_START = '0.6.0';

// Historical releases such as 0.5.160 remain valid for ordering and preservation.
// Only newly published releases are restricted to decimal minor/patch digits.
export function parseVersion(version) {
  if (typeof version !== 'string' || version.trim() !== version
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error(`Invalid version: ${version}. Expected three non-negative integers without leading zeroes.`);
  }
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    throw new Error(`Invalid version: ${version}. Each component must be a safe integer.`);
  }
  return parts;
}

export function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export function assertReleaseVersion(version) {
  const [, minor, patch] = parseVersion(version);
  if (minor > 9 || patch > 9 || compareVersions(version, DECIMAL_RELEASE_START) < 0) {
    throw new Error(
      `Invalid release version: ${version}. New releases start at ${DECIMAL_RELEASE_START}; `
        + 'minor and patch must each be 0-9 (0.6.9 -> 0.7.0, 0.9.9 -> 1.0.0).',
    );
  }
  return version;
}

export function nextReleaseVersion(version) {
  const parts = parseVersion(version);
  if (compareVersions(version, DECIMAL_RELEASE_START) < 0) return DECIMAL_RELEASE_START;
  assertReleaseVersion(version);

  parts[2] += 1;
  if (parts[2] === 10) {
    parts[2] = 0;
    parts[1] += 1;
  }
  if (parts[1] === 10) {
    parts[1] = 0;
    parts[0] += 1;
  }
  return assertReleaseVersion(parts.join('.'));
}
