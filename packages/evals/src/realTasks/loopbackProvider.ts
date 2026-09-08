/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createServer } from 'node:http';
import type { CustomModelConfig } from 'otto-core';

/** Scripted provider for exercising REAL tools/runtime only. Never a model score. */
export async function scriptedProvider(
  program: (
    round: number,
    body: Record<string, unknown>,
  ) =>
    | Promise<{ name: string; args: unknown } | string>
    | { name: string; args: unknown }
    | string,
) {
  let calls = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4_000_000) throw new Error('Oversized fixture request');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        unknown
      >;
      const result = await program(++calls, body);
      const tool =
        typeof result === 'string'
          ? undefined
          : {
              id: `fixture-${calls}`,
              type: 'function',
              function: {
                name: result.name,
                arguments: JSON.stringify(result.args),
              },
            };
      const message = {
        role: 'assistant',
        content: typeof result === 'string' ? result : null,
        ...(tool ? { tool_calls: [tool] } : {}),
      };
      const usage = {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      };
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finish_reason] of [
          [
            {
              ...message,
              ...(tool ? { tool_calls: [{ index: 0, ...tool }] } : {}),
            },
            null,
          ],
          [{}, tool ? 'tool_calls' : 'stop'],
        ]) {
          response.write(
            `data: ${JSON.stringify({ id: `fixture-${calls}`, object: 'chat.completion.chunk', model: 'loopback-fixture', created: 1, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage } : {}) })}\n\n`,
          );
        }
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: `fixture-${calls}`,
            object: 'chat.completion',
            model: 'loopback-fixture',
            created: 1,
            choices: [
              {
                index: 0,
                message,
                finish_reason: tool ? 'tool_calls' : 'stop',
              },
            ],
            usage,
          }),
        );
      }
    } catch {
      response.writeHead(500);
      response.end('{"error":"fixture failed"}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Local provider unavailable');
  return {
    model: {
      provider: 'openai',
      displayName: 'Scripted infrastructure probe',
      modelId: 'loopback-fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'loopback-not-a-secret',
      maxOutputTokens: 2048,
      timeout: 10000,
    } as CustomModelConfig,
    calls: () => calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
