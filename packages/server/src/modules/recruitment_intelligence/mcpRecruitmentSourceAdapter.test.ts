import { describe, expect, it, vi } from 'vitest';

import { createMcpRecruitmentSourceAdapter } from './mcpRecruitmentSourceAdapter.js';

const signal = new AbortController().signal;

describe('MCP recruitment source adapter', () => {
  it.each(['direct', 'structured', 'content'] as const)('reads a real material payload in the %s MCP envelope without invoking outbound tools', async (envelope) => {
    const material = { sourceRecordId: 'person-1', text: '使用 React 和 TypeScript 交付企业应用，负责完整测试与上线。', completeness: 'full_text' };
    const invoke = vi.fn(async () => envelope === 'direct' ? material : envelope === 'structured'
      ? { structuredContent: material } : { content: [{ type: 'text', text: JSON.stringify(material) }] });
    const adapter = createMcpRecruitmentSourceAdapter({
      sourceId: 'official', label: '企业人才库', serverName: 'official', trusted: true,
      tools: ['search_candidates', 'get_candidate', 'send_outreach'].map((name) => ({ name: `official__${name}`, serverToolName: name })), invoke,
    });
    await expect(adapter.getCandidate!({ organizationId: 'org-a', actorAccountId: 'hr-a', requisitionId: 'job-1', sourceRecordId: 'person-1' }, { signal })).resolves.toMatchObject(material);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'official__get_candidate', arguments: { organizationId: 'org-a', requisitionId: 'job-1', sourceRecordId: 'person-1' } }));
  });

  it('requires a trusted server and the complete read-only recruitment contract', () => {
    const invoke = vi.fn();
    expect(() =>
      createMcpRecruitmentSourceAdapter({
        sourceId: 'boss',
        label: 'BOSS直聘',
        serverName: 'boss-recruitment',
        trusted: false,
        tools: [
          { name: 'boss-recruitment__search_candidates', serverToolName: 'search_candidates' },
          { name: 'boss-recruitment__get_candidate', serverToolName: 'get_candidate' },
        ],
        invoke,
      }),
    ).toThrow(/trusted/i);
    expect(() =>
      createMcpRecruitmentSourceAdapter({
        sourceId: 'boss',
        label: 'BOSS直聘',
        serverName: 'boss-recruitment',
        trusted: true,
        tools: [{ name: 'boss-recruitment__search_candidates', serverToolName: 'search_candidates' }],
        invoke,
      }),
    ).toThrow(/get_candidate/);
  });

  it('invokes only the reviewed search tool and parses the recruitment MCP v1 result', async () => {
    const invoke = vi.fn(async () => ({
      candidates: [
        {
          sourceRecordId: 'candidate-1',
          displayName: '候选人 A',
          headline: '前端工程师',
          location: '北京',
          profileUrl: 'https://example.test/candidates/1',
          identityKeys: [`sha256:${'a'.repeat(64)}`],
          evidence: [{ field: 'skills', value: 'React, TypeScript' }],
        },
      ],
      nextCursor: 'next-1',
    }));
    const adapter = createMcpRecruitmentSourceAdapter({
      sourceId: 'boss',
      label: 'BOSS直聘',
      serverName: 'boss-recruitment',
      trusted: true,
      tools: [
        { name: 'boss-recruitment__search_candidates', serverToolName: 'search_candidates' },
        { name: 'boss-recruitment__get_candidate', serverToolName: 'get_candidate' },
        { name: 'boss-recruitment__send_outreach', serverToolName: 'send_outreach' },
      ],
      invoke,
    });

    const result = await adapter.search(
      {
        organizationId: 'org-a',
        actorAccountId: 'account-private',
        requisitionId: 'frontend-1',
        query: 'React 前端工程师',
        cursor: 'cursor-1',
        limit: 20,
      },
      { signal },
    );

    expect(invoke).toHaveBeenCalledWith({
      serverName: 'boss-recruitment',
      toolName: 'boss-recruitment__search_candidates',
      arguments: {
        organizationId: 'org-a',
        requisitionId: 'frontend-1',
        query: 'React 前端工程师',
        cursor: 'cursor-1',
        limit: 20,
      },
      signal,
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('account-private');
    expect(result).toEqual({
      candidates: [expect.objectContaining({ sourceRecordId: 'candidate-1' })],
      nextCursor: 'next-1',
    });
    expect(adapter.capabilities).toContain('send_outreach');
  });

  it('accepts fenced JSON tool displays but rejects malformed or oversized output', async () => {
    const base = {
      sourceId: 'custom',
      label: '自定义来源',
      serverName: 'custom-recruitment',
      trusted: true,
      tools: [
        { name: 'custom__search_candidates', serverToolName: 'search_candidates' },
        { name: 'custom__get_candidate', serverToolName: 'get_candidate' },
      ],
    };
    const valid = createMcpRecruitmentSourceAdapter({
      ...base,
      invoke: async () => ({
        returnDisplay: '```json\n{"candidates":[],"nextCursor":"n"}\n```',
      }),
    });
    await expect(
      valid.search(
        {
          organizationId: 'org-a', actorAccountId: 'a', requisitionId: 'r',
          query: 'q', limit: 1,
        },
        { signal },
      ),
    ).resolves.toEqual({ candidates: [], nextCursor: 'n' });

    const malformed = createMcpRecruitmentSourceAdapter({
      ...base,
      invoke: async () => ({ candidates: 'not-an-array' }),
    });
    await expect(
      malformed.search(
        {
          organizationId: 'org-a', actorAccountId: 'a', requisitionId: 'r',
          query: 'q', limit: 1,
        },
        { signal },
      ),
    ).rejects.toThrow(/contract/i);

    const oversized = createMcpRecruitmentSourceAdapter({
      ...base,
      invoke: async () => ({
        candidates: Array.from({ length: 201 }, (_, index) => ({
          sourceRecordId: String(index), displayName: 'candidate',
        })),
      }),
    });
    await expect(
      oversized.search(
        {
          organizationId: 'org-a', actorAccountId: 'a', requisitionId: 'r',
          query: 'q', limit: 200,
        },
        { signal },
      ),
    ).rejects.toThrow(/too many/i);
  });
});
