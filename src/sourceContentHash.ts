/** Stable source fingerprint used to invalidate derived plans and prompts. */
export const sourceContentHash = (text: string): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let offset = 0; offset < text.length; offset += 1) {
    hash ^= BigInt(text.charCodeAt(offset));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `src-v1-${hash.toString(16).padStart(16, '0')}`;
};
