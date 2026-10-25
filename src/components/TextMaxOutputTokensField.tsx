import { useState } from 'react';

export const TEXT_OUTPUT_TOKEN_PRESETS = [
  { label: '32k', value: 32_768 },
  { label: '64k', value: 65_536 },
  { label: '128k', value: 131_072 },
  { label: '256k', value: 262_144 },
] as const;

export const DEFAULT_TEXT_OUTPUT_TOKENS = 65_536;

export function TextMaxOutputTokensField({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const matchesPreset = TEXT_OUTPUT_TOKEN_PRESETS.some((item) => item.value === value);
  const [custom, setCustom] = useState(!matchesPreset);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setCustom(!TEXT_OUTPUT_TOKEN_PRESETS.some((item) => item.value === value));
  }
  return (
    <div className="text-max-tokens-control">
      <select
        aria-label="最大输出 Token"
        value={custom ? 'custom' : String(value)}
        onChange={(event) => {
          const next = event.target.value;
          if (next === 'custom') {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(Number(next));
        }}
      >
        {TEXT_OUTPUT_TOKEN_PRESETS.map((item) => (
          <option key={item.value} value={item.value}>{item.label}</option>
        ))}
        <option value="custom">自定义</option>
      </select>
      {custom && (
        <input
          type="number"
          min={1}
          step={1}
          aria-label="自定义最大输出 Token"
          value={Number.isFinite(value) ? value : ''}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next) || next < 1) return;
            onChange(Math.floor(next));
          }}
        />
      )}
    </div>
  );
}
