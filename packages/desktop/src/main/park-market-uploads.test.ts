import { it, expect } from 'vitest';
import { MarketUploadManager } from './park-market-uploads.js';
it('cancels only the chosen upload and prevents progress or results crossing account scope', async () => {
  let scope = 'first';
  const operations = new Map<
    string,
    {
      signal: AbortSignal;
      onProgress: (n: number, total: number) => void;
      resolve: (value: unknown) => void;
    }
  >();
  const manager = new MarketUploadManager(
    () => scope,
    async (input, options) =>
      new Promise((resolve, reject) => {
        operations.set(String(input), { ...options, resolve });
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('cancelled')),
          { once: true },
        );
      }),
  );
  const progress: unknown[] = [];
  const one = manager.start('one', 'one', (value) => progress.push(value));
  const rejected = expect(one).rejects.toThrow();
  const two = manager.start('two', 'two', (value) => progress.push(value));
  manager.cancel('one');
  await rejected;
  expect(operations.get('two')!.signal.aborted).toBe(false);
  scope = 'second';
  operations.get('two')!.onProgress(1, 2);
  operations.get('two')!.resolve({ id: 'old-account-image' });
  await expect(two).rejects.toThrow();
  expect(progress).toEqual([]);
});
