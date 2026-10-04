import type { CSSProperties } from 'react';

/** A layout hint only: names are never shortened or rewritten. */
export function referenceImageNameUnits(name: string): number {
  let units = 0;
  for (const character of name) {
    if (/[\p{Mark}\u200d\ufe0f]/u.test(character)) continue;
    units += /\s/u.test(character) ? 0.35 : /[\x00-\x7f]/u.test(character) ? 0.55 : 1;
  }
  return Math.max(1, Math.round(units * 100) / 100);
}

export function ReferenceImageName({ name }: { name: string }) {
  const style = { '--reference-name-units': referenceImageNameUnits(name) } as CSSProperties;
  return <span className="reference-image-name" style={style}>
    <strong className="reference-image-name-text" title={name}>{name}</strong>
  </span>;
}
