import { describe, expect, it, vi } from 'vitest';
import { EnterpriseClient } from './enterprise-client.js';

describe('policy v1.3 server compatibility', () => {
  it.each([
    { runId: 'invalid', view: {}, expected: '回执无效', cancel: 0 },
    { runId: '12345678-1234-1234-1234-123456789abc', view: { status: 'failed', error: 'fixture assessment failed' }, expected: 'fixture assessment failed', cancel: 1 },
    { runId: '12345678-1234-1234-1234-123456789abc', view: { status: 'unknown' }, expected: '任务状态无效', cancel: 1 },
    { runId: '12345678-1234-1234-1234-123456789abc', view: { status: 'running' }, expected: '先核对已有结果', cancel: 1 },
  ])('stops invalid or exhausted executions without replay, even when cancellation fails (%#)', async ({ runId, view, expected, cancel }) => {
    const invoke = vi.fn();
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok', apiVersion: 3, capabilities: ['policy_intelligence_v3', 'policy_client_model_v1'] }));
      if (target.endsWith('/executions')) return new Response(JSON.stringify({ runId }));
      if (target.endsWith('/cancel')) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify(view));
    });
    const client = new EnterpriseClient(fetcher, undefined, undefined, async () => ({ name: 'fixture-model', invoke }));
    client.restore({ serverUrl: 'https://enterprise.example', token: 'fixture-session' });
    await expect(client.actPolicyIntelligence({ action: 'sync' })).rejects.toThrow(expected);
    expect(invoke).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/executions'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/cancel'))).toHaveLength(cancel);
  });
  it('runs requested model work locally without sending credentials or replaying a result', async () => {
    const runId = '12345678-1234-1234-1234-123456789abc';
    let polls = 0;
    const invoke = vi.fn(async () => ({ relevant: true }));
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok', apiVersion: 3, capabilities: ['policy_intelligence_v3', 'policy_client_model_v1'] }));
      if (path.endsWith('/executions')) return new Response(JSON.stringify({ runId }));
      if (path.endsWith('/reply')) return new Response('{"accepted":true}');
      if (!init?.method || init.method === 'GET') return new Response(JSON.stringify(++polls === 1
        ? { status: 'model', requestId: 'r1', instruction: '检查原文', data: { policy: 'official text' } }
        : { status: 'done', result: { enabled: true, modelName: 'dialogue-model' } }));
      throw new Error('unexpected request');
    });
    const client = new EnterpriseClient(fetcher, undefined, undefined, async () => ({ name: 'dialogue-model', invoke }));
    client.restore({ serverUrl: 'https://enterprise.example', token: 'enterprise-session' });
    expect(await client.actPolicyIntelligence({ action: 'sync' })).toMatchObject({ modelName: 'dialogue-model' });
    expect(invoke).toHaveBeenCalledOnce();
    const bodies = fetcher.mock.calls.flatMap(([, init]) => init?.body ? [String(init.body)] : []);
    expect(bodies).toEqual([JSON.stringify({ action: { action: 'sync' }, modelName: 'dialogue-model' }), JSON.stringify({ requestId: 'r1', result: { relevant: true } })]);
    expect(bodies.join('')).not.toMatch(/apiKey|enterprise-session/);
  });
  it('blocks model actions on old servers instead of falling back to another enterprise model', async () => {
    const { client, fetcher } = harness(['policy_intelligence_v3']);
    await expect(client.actPolicyIntelligence({ action: 'sync' })).rejects.toThrow('当前对话模型');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('stops repeated model requests instead of billing twice', async () => {
    const runId = '12345678-1234-1234-1234-123456789abc';
    const invoke = vi.fn(async () => ({ relevant: true }));
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok', apiVersion: 3, capabilities: ['policy_intelligence_v3', 'policy_client_model_v1'] }));
      if (path.endsWith('/executions')) return new Response(JSON.stringify({ runId }));
      if (path.endsWith('/cancel') || path.endsWith('/reply')) return new Response('{}');
      return new Response(JSON.stringify({ status: 'model', requestId: 'r1', instruction: '检查', data: {} }));
    });
    const client = new EnterpriseClient(fetcher, undefined, undefined, async () => ({ name: 'dialogue-model', invoke }));
    client.restore({ serverUrl: 'https://enterprise.example', token: 'enterprise-session' });
    await expect(client.actPolicyIntelligence({ action: 'sync' })).rejects.toThrow('避免重复计费');
    expect(invoke).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(true);
  });
  it('allows a bounded state operation past 10 seconds without replaying a mutation', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith('/health')) return new Response(JSON.stringify({status:'ok',apiVersion:3,capabilities:['policy_intelligence_v3']}));
        await new Promise<void>((resolve,reject) => {
          setTimeout(resolve,15_000);
          init?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
        });
        return new Response(JSON.stringify({state:{enabled:true}}));
      });
      const client = new EnterpriseClient(fetcher);
      client.restore({serverUrl:'https://enterprise.example',token:'fixture-token'});
      const result = client.actPolicyIntelligence({action:'configure',enabled:true,consent:true});
      const assertion = expect(result).resolves.toEqual({enabled:true});
      await vi.advanceTimersByTimeAsync(15_001);
      await assertion;
      expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith('/actions'))).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  const harness = (capabilities: string[]) => {
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('/health')
              ? { status: 'ok', apiVersion: 3, capabilities }
              : { state: { enabled: true } },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = new EnterpriseClient(fetcher);
    client.restore({
      serverUrl: 'https://enterprise.example',
      token: 'fixture-token',
    });
    return { client, fetcher };
  };
  it('does not use an older policy implementation that lacks exclusion/feedback rules', async () => {
    const { client, fetcher } = harness(['policy_intelligence_v2']);
    await expect(client.getPolicyIntelligence()).rejects.toThrow(/升级/);
    await expect(
      client.actPolicyIntelligence({ action: 'sync' }),
    ).rejects.toThrow(/升级/);
    expect(
      fetcher.mock.calls.every(([url]) => String(url).endsWith('/health')),
    ).toBe(true);
  });
  it('does not send inbox read requests to a server without the notification capability', async () => {
    const { client, fetcher } = harness(['policy_intelligence_v3']);
    await expect(client.getPolicyInbox()).rejects.toThrow(/升级/);
    await expect(client.readPolicyInbox(['a'.repeat(64)])).rejects.toThrow(/升级/);
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/health'))).toBe(true);
  });
  it('keeps the authenticated state and action endpoints on an upgraded server', async () => {
    const { client, fetcher } = harness([
      'policy_intelligence_v2',
      'policy_intelligence_v3',
    ]);
    expect(await client.getPolicyIntelligence()).toEqual({ enabled: true });
    await client.actPolicyIntelligence({
      action: 'feedback',
      policyId: 'p',
      revision: 0,
      consent: true,
      feedback: { outcome: 'submitted', reason: 'none', note: '' },
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://enterprise.example/enterprise/health',
      'https://enterprise.example/enterprise/policy-intelligence',
      'https://enterprise.example/enterprise/policy-intelligence/actions',
    ]);
  });
});
