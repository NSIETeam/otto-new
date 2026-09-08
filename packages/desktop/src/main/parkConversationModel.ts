/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import { buildParkConversationPrompt, parseParkConversationPlan, sanitizeParkConversationRequest, type ParkConversationPlan } from './parkConversationPlan.js';

async function generatePlan(prompt: string, signal: AbortSignal): Promise<string> {
  const { createCoreConfig } = await import('otto-server');
  const { AuthType, SceneType } = await import('otto-core');
  const config = createCoreConfig({
    sessionId: 'park-conversation-understanding', disableMcpDiscovery: true,
    disableEnvironmentContext: true, disableTools: true,
    userRules: 'Only extract park service intents as strict JSON. Never call tools or authorize actions.',
  });
  await config.initialize();
  await config.refreshAuth(AuthType.USE_PROXY_AUTH);
  signal.throwIfAborted();
  const chat = await config.getOttoClient().createTemporaryChat(SceneType.CHAT_CONVERSATION, config.getModel(),
    { type: 'sub', agentId: 'ParkConversationPlanner' }, { emptySystemPrompt: true });
  signal.throwIfAborted();
  const response = await chat.sendMessage({ message: prompt,
    config: { maxOutputTokens: 2048, temperature: 0, abortSignal: signal },
  }, `park-understanding:${randomUUID()}`, SceneType.CHAT_CONVERSATION);
  return response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
}

export function createParkConversationPlanner(options: {
  getScope(): string;
  generate?: (prompt: string, signal: AbortSignal) => Promise<string>;
  timeoutMs?: number;
}) {
  const inflight = new Map<string, Promise<ParkConversationPlan>>();
  return async (input: unknown): Promise<ParkConversationPlan> => {
    const request = sanitizeParkConversationRequest(input);
    // Date comes from the host, not from a renderer-supplied clock.
    request.now = new Date().toISOString();
    if (request.clarification) {
      const age = Date.parse(request.now) - Date.parse(request.clarification.startedAt);
      if (age < -60_000 || age > 30 * 60_000) throw new Error('追问已过期，请重新描述需求');
    }
    const scope = options.getScope();
    const key = createHash('sha256').update(JSON.stringify([scope, request.text, request.active, request.clarification, request.now.slice(0, 16)])).digest('hex');
    const running = inflight.get(key);
    if (running) return running;
    if (inflight.size >= 2) throw new Error('正在理解其他办事请求，请稍后再试');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = (async () => {
      try {
        const raw = await Promise.race([
          (options.generate ?? generatePlan)(buildParkConversationPrompt(request), controller.signal),
          new Promise<never>((_, reject) => { timer = setTimeout(() => {
            controller.abort(); reject(new Error('智能理解超时，未执行操作'));
          }, options.timeoutMs ?? 15_000); }),
        ]);
        if (scope !== options.getScope()) throw new Error('账号或服务连接已变化，旧理解结果已丢弃');
        return parseParkConversationPlan(raw, request);
      } finally {
        if (timer) clearTimeout(timer);
        inflight.delete(key);
      }
    })();
    inflight.set(key, task);
    return task;
  };
}
