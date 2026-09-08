/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import path from 'node:path';
import {
  executeLiveCase,
  LIVE_CASES,
  liveCasePrompt,
  LIVE_ACCEPTANCE_COMMAND,
} from './liveRuntimeEval.js';
import { extractTaskRequirements } from '../../server/src/taskRequirements.js';
import { FEEDBACK_BASELINE } from './feedbackBaseline.js';

// Scripted loopback provider: checks wiring only, never counted as model quality.
it.each([LIVE_CASES[0], ...FEEDBACK_BASELINE])(
  'runs the real runtime with an independent grader (scripted provider, not a quality score): $id',
  async (testCase) => {
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
      const requirements = extractTaskRequirements(
        liveCasePrompt(testCase, directory),
      ).flatMap((r) => r.scenarios.map((scenario) => ({ ...r, scenario })));
      // Same fixed oracle; declare the file version consumed by that check.
      const criteria = requirements.flatMap((requirement, index) => [{
              id: `test-${index}`,
              requirementQuote: requirement.quote,
              testCase: {
                name: `acceptance-${requirement.id}-${requirement.scenario}`,
                scenario: requirement.scenario,
                // Carry the current contract's polarity. The fixed data oracle
                // still checks exact output; this is not proof of GUI side effects.
                expectedOutcome: requirement.expectedOutcome,
              },
              description: '固定验收测试通过',
              kind: 'process',
              command: LIVE_ACCEPTANCE_COMMAND,
              directory,
              inputFiles: [path.join(directory, 'result.json'), path.join(directory, 'acceptance.test.cjs')],
            }, ...(requirement.kind === 'behavior' && requirement.quote.includes('生成') ? [{
              id: `artifact-${index}`, requirementQuote: requirement.quote, description: '实际生成的 JSON 文件',
              kind: 'artifact', artifactPath: path.join(directory, 'result.json'),
            }] : [])]);
      const objectives = Array.from(
        { length: Math.ceil(criteria.length / 8) },
        (_, group) => ({
          id: `result-${group}`,
          description: '生成 result.json 并验收',
          sourceQuote: liveCasePrompt(testCase, directory),
          dependsOn: [],
          criteria: criteria.slice(group * 8, group * 8 + 8),
          evidence: [],
        }),
      );
      const tool = [
        {
          name: 'update_task_plan',
          arguments: JSON.stringify({
            expectedRevision: 0,
            objectives,
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
            content: JSON.stringify(testCase.expected),
          }),
        },
        {
          name: 'run_shell_command',
          arguments: JSON.stringify({
            command: LIVE_ACCEPTANCE_COMMAND,
          }),
        },
        {
          name: 'update_task_plan',
          arguments: JSON.stringify({
            expectedRevision: 1,
            objectives: objectives.map((objective) => ({
              ...objective,
              evidence: objective.criteria.map((c) => ({
                criterionId: c.id,
                toolCallId: c.kind === 'artifact' ? 'call-3' : 'call-4',
              })),
            })),
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
      const result = await executeLiveCase(testCase, {
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
      expect(result.unverifiedTextChunks).toBe(0);
      expect(result.firstVisibleTextMs).toBeGreaterThan(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  30000,
);
