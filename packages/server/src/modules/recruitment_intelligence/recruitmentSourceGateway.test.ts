import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  RecruitmentGatewayCancelledError,
  createRecruitmentSourceGateway,
  type RecruitmentSourceAdapter,
} from './recruitmentSourceGateway.js';
import { MemoryRecruitmentSourceStore } from './recruitmentSourceStore.js';

function identity(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function adapter(
  id: string,
  search: RecruitmentSourceAdapter['search'],
): RecruitmentSourceAdapter {
  return {
    id,
    label: id,
    capabilities: ['search_candidates', 'get_candidate'],
    search,
  };
}

const request = {
  organizationId: 'org-alpha',
  actorAccountId: 'account-1',
  requisitionId: 'frontend-1',
  query: 'React 前端工程师',
};

describe('recruitment source gateway', () => {
  it('fails a source closed unless the organization has an explicit authorization', async () => {
    const search = vi.fn(async () => ({ candidates: [] }));
    const gateway = createRecruitmentSourceGateway({
      adapters: [adapter('boss', search)],
      authorizeSource: async () => ({ allowed: false, reason: '未授权' }),
    });

    const result = await gateway.search(request);

    expect(search).not.toHaveBeenCalled();
    expect(result.sources).toEqual([
      expect.objectContaining({
        sourceId: 'boss',
        status: 'unauthorized',
        message: '未授权',
      }),
    ]);
    expect(result.candidates).toEqual([]);
  });

  it('starts authorized sources concurrently and isolates a broken source', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = vi.fn(async () => {
      await firstBlocked;
      return {
        candidates: [
          {
            sourceRecordId: 'a-1',
            displayName: '候选人 A',
            identityKeys: [],
          },
        ],
      };
    });
    const broken = vi.fn(async () => {
      throw new Error('upstream unavailable');
    });
    const gateway = createRecruitmentSourceGateway({
      adapters: [adapter('first', first), adapter('broken', broken)],
      authorizeSource: async () => ({ allowed: true }),
    });

    const pending = gateway.search(request);
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledOnce();
      expect(broken).toHaveBeenCalledOnce();
    });
    releaseFirst();
    const result = await pending;

    expect(result.candidates).toHaveLength(1);
    expect(result.sources).toEqual([
      expect.objectContaining({ sourceId: 'first', status: 'ok' }),
      expect.objectContaining({ sourceId: 'broken', status: 'error' }),
    ]);
  });

  it('isolates an authorization backend failure without calling that source', async () => {
    const unavailable = vi.fn(async () => ({ candidates: [] }));
    const available = vi.fn(async () => ({
      candidates: [{ sourceRecordId: 'ok-1', displayName: '候选人', identityKeys: [] }],
    }));
    const gateway = createRecruitmentSourceGateway({
      adapters: [adapter('unavailable-auth', unavailable), adapter('available', available)],
      authorizeSource: async ({ sourceId }) => {
        if (sourceId === 'unavailable-auth') throw new Error('authorization database unavailable');
        return { allowed: true };
      },
    });

    const result = await gateway.search(request);

    expect(unavailable).not.toHaveBeenCalled();
    expect(available).toHaveBeenCalledOnce();
    expect(result.candidates).toHaveLength(1);
    expect(result.sources).toEqual([
      expect.objectContaining({
        sourceId: 'unavailable-auth', status: 'error', message: '来源授权检查失败',
      }),
      expect.objectContaining({ sourceId: 'available', status: 'ok' }),
    ]);
  });

  it('does not expose connector secrets through per-source failure messages', async () => {
    const broken = adapter('broken', async () => {
      throw new Error('invalid bearer secret: highly-sensitive-value');
    });
    const gateway = createRecruitmentSourceGateway({
      adapters: [broken],
      authorizeSource: async () => ({ allowed: true }),
    });
    const result = await gateway.search({
      organizationId: 'org-a', actorAccountId: 'admin-a',
      requisitionId: 'frontend-1', query: '前端',
    });
    expect(result.sources[0]).toMatchObject({
      status: 'error', message: '来源检索失败',
    });
    expect(JSON.stringify(result)).not.toContain('highly-sensitive-value');
  });

  it('deduplicates only with opaque identity hashes and retains conflicting evidence', async () => {
    const sameEmail = identity('alice@example.test');
    const gateway = createRecruitmentSourceGateway({
      adapters: [
        adapter('talent-pool', async () => ({
          candidates: [
            {
              sourceRecordId: 'local-7',
              displayName: 'Alice',
              headline: '高级前端工程师',
              location: '北京',
              identityKeys: [sameEmail],
              evidence: [{ field: 'years', value: '6', observedAt: '2026-09-01T00:00:00.000Z' }],
            },
          ],
        })),
        adapter('authorized-mcp', async () => ({
          candidates: [
            {
              sourceRecordId: 'remote-9',
              displayName: 'A. Chen',
              headline: '前端负责人',
              location: '上海',
              identityKeys: [sameEmail],
              evidence: [{ field: 'years', value: '7', observedAt: '2026-09-02T00:00:00.000Z' }],
            },
          ],
        })),
      ],
      authorizeSource: async () => ({ allowed: true }),
    });

    const result = await gateway.search(request);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceCount: 2,
      sources: [
        expect.objectContaining({ sourceId: 'talent-pool', sourceRecordId: 'local-7' }),
        expect.objectContaining({ sourceId: 'authorized-mcp', sourceRecordId: 'remote-9' }),
      ],
    });
    expect(result.candidates[0].fieldEvidence.location).toEqual([
      expect.objectContaining({ value: '北京', sourceId: 'talent-pool' }),
      expect.objectContaining({ value: '上海', sourceId: 'authorized-mcp' }),
    ]);
    expect(result.candidates[0].fieldEvidence.years).toHaveLength(2);
  });

  it('does not merge equal names or raw personal identifiers', async () => {
    const gateway = createRecruitmentSourceGateway({
      adapters: [
        adapter('one', async () => ({
          candidates: [
            {
              sourceRecordId: '1',
              displayName: '张伟',
              identityKeys: ['zhangwei@example.test'],
            },
          ],
        })),
        adapter('two', async () => ({
          candidates: [
            {
              sourceRecordId: '2',
              displayName: '张伟',
              identityKeys: ['zhangwei@example.test'],
            },
          ],
        })),
      ],
      authorizeSource: async () => ({ allowed: true }),
    });

    const result = await gateway.search(request);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((candidate) => candidate.identityKeys.length === 0)).toBe(true);
  });

  it('collapses duplicate copies of the same source record without requiring PII', async () => {
    const gateway = createRecruitmentSourceGateway({
      adapters: [
        adapter('source', async () => ({
          candidates: [
            { sourceRecordId: 'same-1', displayName: '候选人', headline: '前端工程师' },
            { sourceRecordId: 'same-1', displayName: '候选人', location: '北京' },
          ],
        })),
      ],
      authorizeSource: async () => ({ allowed: true }),
    });

    const result = await gateway.search(request);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceCount: 1,
      headline: '前端工程师',
      location: '北京',
      sources: [expect.objectContaining({ sourceId: 'source', sourceRecordId: 'same-1' })],
    });
  });

  it('times out one source without discarding results from the others', async () => {
    vi.useFakeTimers();
    try {
      const gateway = createRecruitmentSourceGateway({
        adapters: [
          adapter('stuck', async () => new Promise(() => undefined)),
          adapter('fast', async () => ({
            candidates: [{ sourceRecordId: 'fast-1', displayName: '候选人', identityKeys: [] }],
          })),
        ],
        authorizeSource: async () => ({ allowed: true }),
        sourceTimeoutMs: 500,
      });

      const pending = gateway.search(request);
      await vi.advanceTimersByTimeAsync(501);
      const result = await pending;

      expect(result.candidates).toHaveLength(1);
      expect(result.sources).toEqual([
        expect.objectContaining({ sourceId: 'stuck', status: 'timeout' }),
        expect.objectContaining({ sourceId: 'fast', status: 'ok' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates caller cancellation instead of presenting partial results as complete', async () => {
    const controller = new AbortController();
    const gateway = createRecruitmentSourceGateway({
      adapters: [
        adapter('source', async (_input, context) => {
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
          });
          return { candidates: [] };
        }),
      ],
      authorizeSource: async () => ({ allowed: true }),
    });

    const pending = gateway.search({ ...request, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(RecruitmentGatewayCancelledError);
  });

  it('writes a tenant-scoped audit receipt without candidate personal data', async () => {
    const audit = vi.fn(async () => undefined);
    const gateway = createRecruitmentSourceGateway({
      adapters: [
        adapter('source', async () => ({
          candidates: [
            {
              sourceRecordId: 'secret-record',
              displayName: '真实姓名',
              identityKeys: [identity('private@example.test')],
            },
          ],
        })),
      ],
      authorizeSource: async () => ({ allowed: true }),
      audit,
    });

    const result = await gateway.search(request);
    const serializedAudit = JSON.stringify(audit.mock.calls);

    expect(result.candidates).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-alpha',
      actorAccountId: 'account-1',
      action: 'recruitment.sources.searched',
      sourceCounts: { source: 1 },
    }));
    expect(serializedAudit).not.toContain('真实姓名');
    expect(serializedAudit).not.toContain('secret-record');
    expect(serializedAudit).not.toContain('private@example.test');
  });

  it('loads and advances server-side cursors only after persisting the search run', async () => {
    const store = new MemoryRecruitmentSourceStore({ now: () => Date.parse('2026-09-07T00:00:00.000Z') });
    await store.setCursor({
      organizationId: 'org-alpha',
      sourceId: 'source',
      cursor: 'before',
      updatedAt: '2026-09-06T12:00:00.000Z',
    });
    const search = vi.fn(async () => ({ candidates: [], nextCursor: 'after' }));
    const gateway = createRecruitmentSourceGateway({
      adapters: [adapter('source', search)],
      authorizeSource: async () => ({ allowed: true }),
      persistence: store,
      createId: () => 'run-persisted',
      now: () => new Date('2026-09-07T00:00:00.000Z'),
    });

    await gateway.search(request);

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'before' }),
      expect.anything(),
    );
    expect(await store.getSearchRun('org-alpha', 'run-persisted')).toMatchObject({
      organizationId: 'org-alpha',
      requisitionId: 'frontend-1',
      query: 'React 前端工程师',
    });
    expect(await store.getCursor('org-alpha', 'source')).toMatchObject({
      cursor: 'after',
      updatedAt: '2026-09-07T00:00:00.000Z',
    });
  });
});
