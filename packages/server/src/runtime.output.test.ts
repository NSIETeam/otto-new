/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import type { Config } from 'otto-core';
import type { GenerateContentResponse, Part } from '@google/genai';
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
import type { ServerToClient } from './protocol.js';

const textResponse = (text: string) =>
  ({
    candidates: [{ content: { parts: [{ text }] } }],
  }) as GenerateContentResponse;

function harness(options: {
  prompt: string;
  previousPrompt?: string;
  tools?: boolean;
  stop?: 'cancel' | 'error';
  toolRounds?: number;
  compressAt?: number;
  toolFree?: boolean;
  answer?: string;
}) {
  const store = new InMemorySessionStore();
  const session = store.createSession();
  const frames: ServerToClient[] = [];
  const duringStream: string[] = [];
  const requests: string[][] = [];
  const history: Array<{ role: string; parts: Part[] }> = [];
  if (options.previousPrompt) {
    store.appendMessage(session.sessionId, {
      role: 'user',
      source: 'local',
      content: [{ type: 'text', value: options.previousPrompt }],
    });
  }
  let round = 0;
  store.subscribe(session.sessionId, (frame) => frames.push(frame));
  const readTool = {
    name: 'read_file',
    shouldConfirmExecute: async () => false,
    execute: async () => ({ llmContent: 'source', returnDisplay: 'source' }),
  };
  const chat = {
    getHistory: () => history,
    sendMessageStream: async ({ message }: { message: Part[] }) => {
      requests.push(message.flatMap((part) => (part.text ? [part.text] : [])));
      history.push({ role: 'user', parts: message });
      return (async function* () {
        const toolRound = round++ < (options.toolRounds ?? 0);
        for (const text of toolRound
          ? ['已完成。']
          : options.answer
            ? [options.answer]
            : ['已', '完成。']) {
          yield textResponse(text);
          duringStream.push(
            JSON.stringify(store.getHistory(session.sessionId)),
          );
        }
        if (options.stop === 'cancel') runtime.cancel();
        if (options.stop === 'error')
          throw new Error('fixture provider failure');
        if (toolRound)
          yield {
            candidates: [{ content: { parts: [] } }],
            functionCalls: [
              {
                name: 'read_file',
                id: `read-${round}`,
                args: { file_path: '/repo/a.ts' },
              },
            ],
          } as GenerateContentResponse;
        if (round === options.compressAt) history.splice(0, history.length);
      })();
    },
  };
  const config = {
    initialize: async () => undefined,
    refreshAuth: async () => undefined,
    getModel: () => 'test-model',
    getMaxSessionTurns: () => 10,
    getToolRegistry: async () => ({
      getTool: () => readTool,
      getAllTools: () => (options.tools ? [readTool] : []),
      getFunctionDeclarations: () =>
        options.tools
          ? [{ name: 'read_file', description: 'Read a fixture' }]
          : [],
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
  return {
    store,
    session,
    frames,
    duringStream,
    requests,
    async run() {
      await runtime.initialize();
      await runtime.run([{ type: 'text', value: options.prompt }], 'local');
    },
  };
}

describe('verified delivery publication', () => {
  it('restores task instructions after an ordinary answer actually uses a tool', async () => {
    const h = harness({
      prompt: '解释这段文字',
      tools: true,
      toolRounds: 1,
      answer: '这段文字说明了连接行为。',
    });
    await h.run();
    expect(h.requests[0].join('')).not.toContain('Internal task acceptance:');
    expect(h.requests[1].join('')).toContain('Internal task acceptance:');
  });
  it('does not omit constraints just because the main intent is answering', async () => {
    const h = harness({
      prompt: '解释这段文字，不要打开 WPS',
      tools: true,
      answer: '这段文字描述了连接行为。',
    });
    await h.run();
    expect(h.requests[0].join('')).toContain('Internal task acceptance:');
  });
  it.each(['你好', '1 + 1 是多少？', '用一句话解释向量数据库'])(
    'answers an ordinary question in one provider round without native review tools: %s',
    async (prompt) => {
      const h = harness({ prompt, tools: true, answer: '这是直接回答。' });
      await h.run();
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0].join('')).not.toContain('Internal task acceptance:');
      expect(h.requests[0].join('')).not.toContain('Current contract:');
      expect(h.frames.some((f) => f.type === 'tool_confirmation_request')).toBe(
        false,
      );
      const final = h.frames.filter((f) => f.type === 'chat_complete').at(-1);
      expect(final?.type === 'chat_complete' && final.payload.text).toBe(
        '这是直接回答。',
      );
      const turn = h.store
        .getHistory(h.session.sessionId)
        .find((m) => m.turn)?.turn;
      expect(turn?.status).toBe('completed');
    },
  );
  it.each([undefined, 'cancel', 'error'] as const)(
    'never publishes or persists unverified stream text (stop=%s)',
    async (stop) => {
      const h = harness({ prompt: '修改代码并运行测试', stop });
      await h.run();
      expect(
        h.frames.filter((frame) => frame.type === 'chat_chunk'),
      ).toHaveLength(0);
      expect(h.duringStream.some((text) => text.includes('已完成。'))).toBe(
        false,
      );
      const terminal = h.frames
        .filter((f) => f.type === 'chat_complete')
        .at(-1);
      expect(
        terminal?.type === 'chat_complete' && terminal.payload.text,
      ).not.toBe('已完成。');
      expect(
        h.store.getHistory(h.session.sessionId).some((m) => m.isStreaming),
      ).toBe(false);
    },
  );

  it('keeps explicitly tool-free ordinary answers streaming', async () => {
    const h = harness({ prompt: '你好', toolFree: true });
    await h.run();
    expect(h.frames.filter((f) => f.type === 'chat_chunk')).toHaveLength(2);
    expect(h.duringStream.some((text) => text.includes('已完成。'))).toBe(true);
  });

  it.each(['把这个弄好', '照刚才说的做', '让它能用就行', '照办', 'go ahead'])(
    'holds short instructions before late tool calls: %s',
    async (prompt) => {
      const h = harness({
        prompt,
        previousPrompt: '修改代码并运行测试',
        tools: true,
        toolRounds: 1,
      });
      await h.run();
      expect(h.requests.length).toBeGreaterThan(1);
      expect(h.frames.filter((f) => f.type === 'chat_chunk')).toHaveLength(0);
      expect(h.duringStream.some((text) => text.includes('已完成。'))).toBe(
        false,
      );
      expect(
        h.frames.some(
          (f) =>
            f.type === 'chat_complete' &&
            f.payload.phase === 'commentary' &&
            f.payload.text === '已完成。',
        ),
      ).toBe(false);
    },
  );

  it.each(['cancel', 'error'] as const)(
    'does not expose a short-instruction draft on %s before tool calls arrive',
    async (stop) => {
      const h = harness({
        prompt: '照刚才说的做',
        previousPrompt: '修改代码并运行测试',
        tools: true,
        toolRounds: 1,
        stop,
      });
      await h.run();
      expect(h.frames.filter((f) => f.type === 'chat_chunk')).toHaveLength(0);
      expect(h.duringStream.some((text) => text.includes('已完成。'))).toBe(
        false,
      );
      expect(
        h.store.getHistory(h.session.sessionId).some((m) => m.isStreaming),
      ).toBe(false);
      expect(
        h.frames
          .filter((f) => f.type === 'chat_complete')
          .some(
            (f) => f.type === 'chat_complete' && f.payload.text === '已完成。',
          ),
      ).toBe(false);
    },
  );

  it('does not leak completion through tool-round commentary and sends no unchanged rules', async () => {
    const h = harness({
      prompt: '修改代码并运行测试',
      tools: true,
      toolRounds: 3,
    });
    await h.run();
    const texts = h.requests.flat();
    expect(
      texts.filter((t) => t.includes('Model assertions cannot verify work.')),
    ).toHaveLength(1);
    expect(texts.filter((t) => t.includes('otto_turn_control'))).toHaveLength(
      1,
    );
    expect(h.requests[1].join('')).not.toContain('Current contract:');
    expect(
      h.frames
        .filter(
          (f) => f.type === 'chat_complete' && f.payload.phase === 'commentary',
        )
        .some(
          (f) => f.type === 'chat_complete' && f.payload.text === '已完成。',
        ),
    ).toBe(false);
  });

  it('restores runtime instructions after context is replaced', async () => {
    const h = harness({
      prompt: '修改代码并运行测试',
      tools: true,
      toolRounds: 3,
      compressAt: 2,
    });
    await h.run();
    expect(h.requests[1].join('')).not.toContain(
      'Model assertions cannot verify work.',
    );
    expect(h.requests[2].join('')).toContain(
      'Model assertions cannot verify work.',
    );
    expect(h.requests[3].join('')).not.toContain(
      'Model assertions cannot verify work.',
    );
  });
});
