// Single backoff formula: min(base × 2^attempts × jitter[0.8, 1.2], cap), in whole milliseconds.
export interface BackoffInput {
  attempts: number;
  baseMs: number;
  capMs: number;
  random: () => number;
}

export function computeBackoff({ attempts, baseMs, capMs, random }: BackoffInput): number {
  const jitter = 0.8 + 0.4 * random();

  return Math.floor(Math.min(baseMs * 2 ** attempts * jitter, capMs));
}
