/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from 'otto-core';
import type { GenerateContentResponse } from '@google/genai';
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
import type { ServerToClient } from './protocol.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function harness(options: {
  prompt: string;
  answer?: string;
  tool?: string;
  stop?: 'cancel' | 'error';
  manual?: 'approved' | 'always_approve' | 'rejected';
  toolFree?: boolean;
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'otto-constraints-runtime-'));
  dirs.push(root);
  const store = new InMemorySessionStore();
  const session = store.createSession({ workspacePath: root });
  const frames: ServerToClient[] = [];
  const observedDuringStream: string[] = [];
  const tool = {
    name: options.tool ?? 'read_file',
    shouldConfirmExecute: vi.fn(async () => false),
    execute: vi.fn(async () => ({ llmContent: 'OK', returnDisplay: 'OK' })),
  };
  let round = 0;
  const chat = {
    getHistory: () => [],
    sendMessageStream: async () =>
      (async function* () {
        const first = round++ === 0;
        const answer = options.answer ?? '这是一份待核对的回答。';
        // Split a drive path across chunks to check the actual publication boundary.
        for (const text of [answer.slice(0, 5), answer.slice(5)]) {
          yield {
            candidates: [{ content: { parts: [{ text }] } }],
          } as GenerateContentResponse;
          observedDuringStream.push(
            JSON.stringify(store.getHistory(session.sessionId)),
          );
        }
        if (options.stop === 'cancel') runtime.cancel();
        if (options.stop === 'error')
          throw new Error('fixture failed at C:\\private\\secret.txt');
        if (options.tool && first)
          yield {
            candidates: [{ content: { parts: [] } }],
            functionCalls: [
              {
                id: 'call',
                name: options.tool,
                args: {
                  command: 'python bypass.py',
                  file_path: '../outside.txt',
                },
              },
            ],
          } as GenerateContentResponse;
      })(),
  };
  const config = {
    initialize: async () => undefined,
    refreshAuth: async () => undefined,
    getModel: () => 'fixture',
    getMaxSessionTurns: () => 8,
    getToolRegistry: async () => ({
      getTool: () => tool,
      getAllTools: () => [tool],
      getFunctionDeclarations: () => [{ name: tool.name }],
      discoverMcpTools: async () => undefined,
    }),
    getOttoClient: () => ({ getChat: async () => chat }),
  } as unknown as Config;
  const runtime = new CoreSessionRuntime(
    store,
    session.sessionId,
    config,
    { log: async () => undefined },
    { recoveryStore: false, toolFree: options.toolFree },
  );
  store.subscribe(session.sessionId, (frame) => {
    frames.push(frame);
    if (frame.type === 'tool_confirmation_request' && options.manual)
      runtime.resolveToolConfirmation(frame.payload.callId, options.manual);
  });
  return {
    store,
    session,
    frames,
    tool,
    observedDuringStream,
    runtime,
    async run() {
      await runtime.initialize();
      await runtime.run([{ type: 'text', value: options.prompt }], 'local');
    },
    latest() {
      return store
        .getHistory(session.sessionId)
        .filter((m) => m.role === 'assistant')
        .at(-1);
    },
  };
}
it.each(['run_shell_command', 'open_file', 'mcp__launcher', 'task'])(
  'blocks %s before any confirmation or native execution',
  async (tool) => {
    const h = harness({ prompt: '你好，不要打开 WPS。', tool });
    await h.run();
    expect(h.tool.execute).not.toHaveBeenCalled();
    expect(h.tool.shouldConfirmExecute).not.toHaveBeenCalled();
    expect(JSON.stringify(h.store.getHistory(h.session.sessionId))).toContain(
      '用户约束阻止执行',
    );
  },
);
it('blocks a native write outside the workspace without granting permission', async () => {
  const h = harness({ prompt: '只允许修改当前工作区。', tool: 'write_file' });
  await h.run();
  expect(h.tool.execute).not.toHaveBeenCalled();
});
it.each([undefined, 'cancel', 'error'] as const)(
  'never publishes visible absolute paths on %s',
  async (stop) => {
    const h = harness({
      prompt: '你好，不要把绝对路径展示给用户。',
      answer: '文件 C:\\private\\secret.txt',
      stop,
      toolFree: true,
    });
    await h.run();
    expect(h.observedDuringStream.some((t) => t.includes('secret.txt'))).toBe(
      false,
    );
    const published = h.frames.filter((f) =>
      ['chat_chunk', 'chat_complete', 'error'].includes(f.type),
    );
    expect(JSON.stringify(published)).not.toContain('secret.txt');
    expect(h.latest()?.content).not.toEqual([
      { type: 'text', value: '文件 C:\\private\\secret.txt' },
    ]);
  },
);
it.each(['approved', 'always_approve', 'rejected'] as const)(
  'binds a %s manual response to the native draft review',
  async (manual) => {
    const h = harness({ prompt: '你好，回答后由我人工确认。', manual });
    await h.run();
    const reviews = h.frames.filter(
      (f) => f.type === 'tool_confirmation_request',
    );
    expect(reviews).toHaveLength(1);
    const snapshots = h.store
      .getHistory(h.session.sessionId)
      .map((m) => m.turn)
      .filter(Boolean);
    const check = snapshots
      .at(-1)
      ?.verification.checks.find((c) => c.id.startsWith('constraint:'));
    expect(check?.status).toBe(manual === 'approved' ? 'passed' : 'not_run');
    expect(h.tool.execute).not.toHaveBeenCalled();
  },
);
