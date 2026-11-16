export async function waitUntil(
  condition: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  const interval = opts.intervalMs ?? 50;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Condition not met within ${opts.timeoutMs} ms`);
}
