import { describe, expect, it } from 'vitest';

import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import { Database } from '../data_platform/sqliteCompat.js';
import {
  MemoryRecruitmentSourceStore,
  createSqliteRecruitmentSourceStore,
} from './recruitmentSourceStore.js';

const run = {
  runId: 'run-1',
  organizationId: 'org-a',
  actorAccountId: 'account-1',
  requisitionId: 'frontend-1',
  query: 'React 前端工程师',
  createdAt: '2026-09-07T00:00:00.000Z',
  candidates: [
    {
      canonicalId: 'candidate-hash',
      displayName: '张三',
      identityKeys: [],
      sourceCount: 1,
      sources: [{ sourceId: 'mcp-a', sourceLabel: '渠道 A', sourceRecordId: 'private-1' }],
      fieldEvidence: {},
    },
  ],
  sources: [{ sourceId: 'mcp-a', label: '渠道 A', status: 'ok' as const, count: 1, durationMs: 12 }],
};

describe('recruitment source persistence', () => {
  it('isolates in-memory search runs and cursors by organization', async () => {
    const store = new MemoryRecruitmentSourceStore({ now: () => Date.parse('2026-09-07T00:02:00Z') });
    await store.saveSearchRun(run);
    await store.setCursor({
      organizationId: 'org-a',
      sourceId: 'mcp-a',
      cursor: 'cursor-secret',
      updatedAt: '2026-09-07T00:01:00.000Z',
    });

    expect(await store.listSearchRuns('org-a', 'frontend-1', 10)).toEqual([run]);
    expect(await store.listSearchRuns('org-b', 'frontend-1', 10)).toEqual([]);
    expect(await store.getCursor('org-a', 'mcp-a')).toMatchObject({ cursor: 'cursor-secret' });
    expect(await store.getCursor('org-b', 'mcp-a')).toBeNull();
  });

  it('encrypts candidate payloads and synchronization cursors at rest', async () => {
    const database = new Database(':memory:');
    database.exec("CREATE TABLE accounts (id TEXT, organization_id TEXT, status TEXT, deleted_at TEXT); INSERT INTO accounts VALUES ('account-1','org-a','active',NULL);");
    const cipher = createEncryptedFieldCipher({
      keyProvider: { getKey: () => Buffer.alloc(32, 17), clear() {} },
    });
    try {
      const store = createSqliteRecruitmentSourceStore(() => database, cipher, { now: () => Date.parse('2026-09-07T00:02:00Z') });
      await store.saveSearchRun(run);
      await store.setCursor({
        organizationId: 'org-a',
        sourceId: 'mcp-a',
        cursor: 'cursor-secret',
        updatedAt: '2026-09-07T00:01:00.000Z',
      });
      const raw = JSON.stringify(
        database.prepare('SELECT * FROM enterprise_recruitment_records_v1').all(),
      );

      expect(raw).not.toContain('张三');
      expect(raw).not.toContain('private-1');
      expect(raw).not.toContain('cursor-secret');
      expect(await store.getSearchRun('org-a', 'run-1')).toEqual(run);
      expect(await store.getSearchRun('org-b', 'run-1')).toBeNull();
      expect(await store.getCursor('org-a', 'mcp-a')).toMatchObject({ cursor: 'cursor-secret' });
    } finally {
      database.close();
    }
  });

  it('rejects cross-tenant records whose embedded owner does not match the storage key', async () => {
    const store = new MemoryRecruitmentSourceStore();

    await expect(
      store.saveSearchRun({ ...run, organizationId: 'org-a', runId: '../org-b' }),
    ).rejects.toThrow(/run id/i);
    await expect(
      store.setCursor({
        organizationId: 'org-a',
        sourceId: '../mcp-b',
        cursor: 'cursor',
        updatedAt: '2026-09-07T00:01:00.000Z',
      }),
    ).rejects.toThrow(/source id/i);
  });
});
