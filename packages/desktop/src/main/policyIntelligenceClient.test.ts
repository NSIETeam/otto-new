import { describe, expect, it, vi } from 'vitest';
import { EnterpriseClient } from './enterprise-client.js';

describe('policy v1.3 server compatibility', () => {
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
