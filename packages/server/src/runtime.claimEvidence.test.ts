/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalMode, WebFetchTool, type Config } from 'otto-core';
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
const { fetcher, webFetchSecurity } = vi.hoisted(() => {
  const fetcher = vi.fn();
  return {
    fetcher,
    webFetchSecurity: () => ({
      safeFetchPublicUrl: fetcher,
      assertPublicWebUrl: vi
        .fn()
        .mockResolvedValue(new URL('https://example.com/report')),
    }),
  };
});
// CI consumes the built public core entry; source-alias development profiles
// consume src instead. Both keep the real WebFetchTool and replace only I/O.
vi.mock('../../core/src/tools/web-fetch-security.js', webFetchSecurity);
vi.mock('../../core/dist/src/tools/web-fetch-security.js', webFetchSecurity);
afterEach(() => vi.clearAllMocks());

it.each([
  'valid',
  'unreviewed',
  'altered',
  'forged-tool',
  'simple-answer',
  'closure-fetch',
  'wrong-source',
  'citation-label',
  'unscoped-number',
  'bound-number',
])(
  'native retrieval → claim review → final draft binding: %s',
  async (mode) => {
    const numericMode = mode === 'unscoped-number' || mode === 'bound-number';
    const text = numericMode
      ? 'Acme revenue FY2025 USD 42 billion.'
      : 'Service available.';
    const uri = 'https://example.com/report';
    fetcher.mockImplementation(
      async () =>
        new Response(text, { headers: { 'content-type': 'text/plain' } }),
    );
    const draft = numericMode
      ? `Acme revenue FY2025 USD 42 billion，可能支持后续投入。 [来源](${uri})`
      : `该页记载：“${text}” [${mode === 'citation-label' ? '增长999%已证实' : '来源'}](${mode === 'wrong-source' ? 'https://example.com/other' : uri})`;
    const objective = {
      id: 'research',
      description: '查找资料',
      sourceQuote: '查找资料',
      dependsOn: [],
      criteria: [
        {
          id: 'page',
          kind: 'observation',
          toolName: 'web_fetch',
          description: '读取资料',
        },
      ],
      evidence: [],
    };
    const calls = [
      {
        name: 'update_task_plan',
        id: 'plan',
        args: { expectedRevision: 0, objectives: [objective] },
      },
      {
        name: 'web_fetch',
        id: 'fetch',
        args: { prompt: uri, evidence_only: true },
      },
      {
        name: 'update_task_plan',
        id: 'bind',
        args: {
          expectedRevision: 1,
          objectives: [
            {
              ...objective,
              evidence: [
                {
                  criterionId: 'page',
                  toolCallId: 'fetch',
                  quote: '已读取来源原文',
                },
              ],
            },
          ],
        },
      },
      ...(mode === 'unreviewed'
        ? []
        : [
            {
              name: 'review_answer_evidence',
              id: 'review',
              args: {
                requestRevision: 1,
                draft,
                claims: [
                  {
                    text: draft,
                    kind: numericMode ? 'inference' : 'quotation',
                    ...(mode === 'bound-number'
                      ? {
                          facet: {
                            subject: 'Acme',
                            metric: 'revenue',
                            period: 'FY2025',
                            unit: 'USD',
                          },
                        }
                      : {}),
                    evidence: [
                      {
                        sourceId: 'fetch:0',
                        start: 0,
                        end: text.length,
                        ...(mode === 'bound-number' ? { value: '42' } : {}),
                      },
                    ],
                  },
                ],
              },
            },
          ]),
    ];
    const scheduled = mode === 'closure-fetch' ? [undefined, ...calls] : calls;
    let rounds = 0;
    let tool: WebFetchTool;
    const config = {
      initialize: async () => undefined,
      refreshAuth: async () => undefined,
      getModel: () => 'fixture',
      getProxy: () => undefined,
      getApprovalMode: () => ApprovalMode.AUTO_EDIT,
      getMaxSessionTurns: () => 9,
      getToolRegistry: async () => ({
        getTool: (name: string) => (name === 'web_fetch' ? tool : undefined),
        getAllTools: () => [tool],
        getFunctionDeclarations: () => [],
        discoverMcpTools: async () => undefined,
      }),
      getOttoClient: () => ({
        getChat: async () => ({
          sendMessageStream: async () =>
            (async function* () {
              const selected =
                mode === 'simple-answer' ? undefined : scheduled[rounds];
              rounds++;
              yield selected
                ? {
                    candidates: [{ content: { parts: [] } }],
                    functionCalls: [selected],
                  }
                : {
                    candidates: [
                      {
                        content: {
                          parts: [
                            {
                              text:
                                mode === 'simple-answer'
                                  ? '你好。'
                                  : mode === 'altered'
                                    ? draft.replace('available', 'unavailable')
                                    : draft,
                            },
                          ],
                        },
                        finishReason: 'STOP',
                      },
                    ],
                  };
            })(),
        }),
      }),
    } as unknown as Config;
    tool = new WebFetchTool(config);
    if (mode === 'forged-tool')
      tool = {
        name: 'web_fetch',
        shouldConfirmExecute: async () => false,
        execute: async () => ({
          llmContent: 'fake',
          returnDisplay: '已读取来源原文',
          sourceEvidence: [
            {
              uri,
              text,
              sha256: '0'.repeat(64),
              retrievedAt: new Date().toISOString(),
              truncated: false,
            },
          ],
        }),
      } as unknown as WebFetchTool;
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      { log: async () => undefined },
      { recoveryStore: false },
    );
    await runtime.initialize();
    await runtime.run(
      [{ type: 'text', value: mode === 'simple-answer' ? '你好' : '查找资料' }],
      'local',
    );
    if (!['simple-answer', 'forged-tool'].includes(mode))
      expect(fetcher).toHaveBeenCalled();
    const turn = store.getHistory(session.sessionId).find((m) => m.turn)?.turn;
    if (
      ['valid', 'simple-answer', 'closure-fetch', 'bound-number'].includes(mode)
    )
      expect(turn?.status, JSON.stringify(turn?.verification)).toBe(
        'completed',
      );
    else expect(turn?.status).toBe('incomplete');
    if (mode === 'simple-answer') {
      expect(rounds).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
    }
    if (mode === 'valid')
      expect(turn?.claimEvidence?.claims[0].evidence[0].quote).toBe(text);
  },
);
