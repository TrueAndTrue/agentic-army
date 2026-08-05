const UNITS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a human duration string into milliseconds.
 *
 * Known to be wrong in several places. See test/duration.test.js.
 */
export function parseDuration(input) {
  const value = parseFloat(input);
  const unit = String(input).replace(/[0-9.\s]/g, '');
  return value * (UNITS[unit] ?? 1000);
}
