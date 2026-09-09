import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EnterpriseClient } from '../../packages/desktop/src/main/enterprise-client.js';
it('streams actual image bytes with progress and honors caller cancellation', async () => {
  const server = createServer(async (req, res) => {
    let size = 0;
    try {
      for await (const chunk of req) size += chunk.length;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bytes: size }));
    } catch {
      res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = new EnterpriseClient();
    client.restore({
      serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      token: 'isolated-transport-fixture',
    });
    const bytes = Buffer.alloc(512 * 1024, 7);
    const progress: number[] = [];
    const input = {
      path: '/images?draftId=test',
      method: 'POST',
      imageBase64: bytes.toString('base64'),
    };
    expect(
      await client.requestParkMarket(input, {
        onProgress: (loaded: number) => progress.push(loaded),
      }),
    ).toEqual({ bytes: bytes.length });
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(bytes.length);
    const cancel = new AbortController();
    await expect(
      client.requestParkMarket(input, {
        signal: cancel.signal,
        onProgress: () => cancel.abort(),
      }),
    ).rejects.toThrow(/取消/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
