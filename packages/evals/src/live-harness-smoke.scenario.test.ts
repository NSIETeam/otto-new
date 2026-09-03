/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { executeLiveCase, LIVE_CASES } from './liveRuntimeEval.js';

// Scripted loopback provider: checks wiring only, never counted as model quality.
it('runs the real runtime, fixture tools and independent grader with a loopback scripted provider', async () => {
  let round = 0;
  let directory = '';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!directory) {
      const requestText = (body.messages ?? [])
        .filter((message: { role: string }) => message.role === 'user')
        .map((message: { content: string | Array<{ text?: string }> }) =>
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => part.text ?? '').join('\n'),
        )
        .join('\n');
      directory = requestText.match(/工作目录：([^\n<]+)/u)?.[1].trim() ?? '';
    }
    const objective = {
      id: 'result',
      description: '生成 result.json 并验收',
      sourceQuote: '生成 result.json',
      dependsOn: [],
      criteria: [
        {
          id: 'test',
          description: '固定验收测试通过',
          kind: 'process',
          command: 'node --test acceptance.test.cjs',
          directory,
        },
      ],
      evidence: [],
    };
    const tool = [
      {
        name: 'update_task_plan',
        arguments: JSON.stringify({
          expectedRevision: 0,
          objectives: [objective],
        }),
      },
      {
        name: 'read_file',
        arguments: JSON.stringify({ file_path: 'input.json' }),
      },
      {
        name: 'write_file',
        arguments: JSON.stringify({
          file_path: 'result.json',
          content: '{"totalCents":4000}',
        }),
      },
      {
        name: 'run_shell_command',
        arguments: JSON.stringify({
          command: 'node --test acceptance.test.cjs',
        }),
      },
      {
        name: 'update_task_plan',
        arguments: JSON.stringify({
          expectedRevision: 1,
          objectives: [
            {
              ...objective,
              evidence: [{ criterionId: 'test', toolCallId: 'call-4' }],
            },
          ],
        }),
      },
    ][round++];
    const toolCalls = tool
      ? [{ index: 0, id: `call-${round}`, type: 'function', function: tool }]
      : undefined;
    const content = tool ? null : '已生成 result.json，验收测试通过。';
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    };
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (
        delta: object,
        finishReason: string | null,
        includeUsage = false,
      ) =>
        response.write(
          `data: ${JSON.stringify({ id: `smoke-${round}`, object: 'chat.completion.chunk', created: 1, model: 'loopback-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }], ...(includeUsage ? { usage } : {}) })}\n\n`,
        );
      emit(
        {
          role: 'assistant',
          ...(toolCalls ? { tool_calls: toolCalls } : { content }),
        },
        null,
      );
      emit({}, tool ? 'tool_calls' : 'stop', true);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `smoke-${round}`,
          object: 'chat.completion',
          created: 1,
          model: 'loopback-fixture',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content,
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: tool ? 'tool_calls' : 'stop',
            },
          ],
          usage,
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Loopback server unavailable');
    const result = await executeLiveCase(LIVE_CASES[0], {
      displayName: 'Loopback fixture',
      provider: 'openai',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'loopback-not-a-secret',
      modelId: 'loopback-fixture',
      maxOutputTokens: 512,
      timeout: 10000,
    });
    expect(result.correct).toBe(true);
    expect(result.completed, JSON.stringify(result)).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.toolCalls).toBe(5);
    expect(round).toBe(6);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 30000);
