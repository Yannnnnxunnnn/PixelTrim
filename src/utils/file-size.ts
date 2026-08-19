interface Unit {
  readonly suffix: string;
  readonly factor: number;
  readonly decimals: number;
}

const UNITS: readonly Unit[] = [
  { suffix: "GB", factor: 1024 ** 3, decimals: 2 },
  { suffix: "MB", factor: 1024 ** 2, decimals: 2 },
  { suffix: "KB", factor: 1024, decimals: 1 },
  { suffix: "B", factor: 1, decimals: 0 },
];

/** Formats a byte count as a human-readable size, e.g. `524 B`, `12.4 KB`, `5.20 MB`. */
export function formatBytes(bytes: number): string {
  const magnitude = Math.abs(bytes);
  const unit = UNITS.find((candidate) => magnitude >= candidate.factor) ?? UNITS[UNITS.length - 1]!;
  const value = bytes / unit.factor;
  return `${value.toFixed(unit.decimals)} ${unit.suffix}`;
}

/**
 * Formats a byte delta with an explicit sign so growth is never mistaken for a
 * saving, e.g. `+50.0 KB`.
 */
export function formatSignedBytes(bytes: number): string {
  const sign = bytes >= 0 ? "+" : "-";
  return `${sign}${formatBytes(Math.abs(bytes))}`;
}

/** Formats a percentage with two decimal places, e.g. `58.85%`, `-10.00%`. */
export function formatPercentage(percentage: number): string {
  return `${percentage.toFixed(2)}%`;
}
