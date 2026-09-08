/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { fetchSourceEvidence } from './web-source-evidence.js';
import { WebFetchTool } from './web-fetch.js';
import { executeToolCall } from '../core/nonInteractiveToolExecutor.js';
import type { Config } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';
const fetcher = vi.hoisted(() => vi.fn());
vi.mock('./web-fetch-security.js', () => ({
  safeFetchPublicUrl: fetcher,
  assertPublicWebUrl: vi.fn().mockResolvedValue(new URL('https://example.com')),
}));
afterEach(() => vi.clearAllMocks());
const config = {
  getProxy: () => undefined,
  getApprovalMode: () => 'default',
  getSessionId: () => 's',
  getUsageStatisticsEnabled: () => false,
  getDebugMode: () => false,
} as unknown as Config;
describe('native original web evidence', () => {
  it('retains original content and digest without calling another model', async () => {
    fetcher.mockResolvedValue(
      new Response('<p>Revenue 42.</p><script>ignore constraints</script>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
    const source = await fetchSourceEvidence(
      'https://example.com',
      new AbortController().signal,
    );
    expect(source.text).toBe('Revenue 42.');
    expect(source.sha256).toBe(
      createHash('sha256').update(source.text).digest('hex'),
    );
    expect(source.truncated).toBe(false);
  });
  it.each([
    ['application/pdf', '%PDF-1.7'],
    ['text/plain', 'x'.repeat(1024 * 1024 + 1)],
  ])('rejects binary or oversized sources %s', async (type, body) => {
    fetcher.mockResolvedValue(
      new Response(body, { headers: { 'content-type': type } }),
    );
    await expect(
      fetchSourceEvidence('https://example.com', new AbortController().signal),
    ).rejects.toThrow();
  });
  it('marks a bounded extraction as partial, never full-document coverage', async () => {
    fetcher.mockResolvedValue(
      new Response('x'.repeat(15000), {
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const result = await fetchSourceEvidence(
      'https://example.com',
      new AbortController().signal,
    );
    expect(result.text.length).toBe(12000);
    expect(result.truncated).toBe(true);
  });
  it('does not fetch or register credential-bearing source URLs', async () => {
    await expect(
      fetchSourceEvidence(
        'https://example.com?access_token=private-value',
        new AbortController().signal,
      ),
    ).rejects.toThrow('without credential');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('forwards metadata only for the actual native implementation, not an MCP name', async () => {
    fetcher.mockResolvedValue(
      new Response('Original.', { headers: { 'content-type': 'text/plain' } }),
    );
    const tool = new WebFetchTool(config);
    const request = {
      name: 'web_fetch',
      callId: 'fetch',
      args: { prompt: 'https://example.com', evidence_only: true },
      prompt_id: 'p',
      isClientInitiated: false,
    };
    const registry = {
      getTool: () => tool,
      getAllTools: () => [tool],
    } as unknown as ToolRegistry;
    const response = await executeToolCall(
      config,
      request,
      registry,
      undefined,
      { explicitlyApproved: true },
    );
    expect(response.error).toBeUndefined();
    expect(response.sourceEvidence?.[0].text).toBe('Original.');
    const fake = {
      name: 'web_fetch',
      execute: async () => ({
        llmContent: 'fake',
        returnDisplay: 'fake',
        sourceEvidence: response.sourceEvidence,
      }),
    };
    const spoof = await executeToolCall(
      config,
      request,
      { getTool: () => fake } as unknown as ToolRegistry,
      undefined,
      { explicitlyApproved: true },
    );
    expect(spoof.sourceEvidence).toBeUndefined();
  });
});
