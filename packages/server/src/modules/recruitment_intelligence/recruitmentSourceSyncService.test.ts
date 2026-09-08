import { describe, expect, it, vi } from 'vitest';

import {
  createRecruitmentSourceSyncService,
  recruitmentCandidateSetFingerprint,
} from './recruitmentSourceSyncService.js';

const candidate = {
  canonicalId: 'candidate-1',
  displayName: '候选人 A',
  identityKeys: [],
  sourceCount: 1,
  sources: [{ sourceId: 'source', sourceLabel: '来源', sourceRecordId: 'record-1' }],
  fieldEvidence: {
    skills: [{ value: 'React', sourceId: 'source', sourceRecordId: 'record-1', observedAt: '2026-09-01' }],
  },
};

const result = {
  runId: 'run-new',
  candidates: [candidate],
  sources: [{ sourceId: 'source', label: '来源', status: 'ok' as const, count: 1, durationMs: 10 }],
};

const input = {
  organizationId: 'org-a',
  actorAccountId: 'admin-1',
  actorIsAdmin: true,
  requisitionId: 'frontend-1',
  query: 'React 前端工程师',
};

describe('recruitment background source synchronization', () => {
  it('requires an administrator and an enabled organization setting', async () => {
    const search = vi.fn(async () => result);
    const service = createRecruitmentSourceSyncService({
      gateway: { search },
      isEnabled: async () => false,
      previousRuns: async () => [],
    });

    await expect(service.run(input)).resolves.toMatchObject({ status: 'disabled' });
    expect(search).not.toHaveBeenCalled();
    await expect(
      service.run({ ...input, actorIsAdmin: false }),
    ).rejects.toThrow(/administrator/i);
  });

  it('does not call a model when the normalized candidate evidence is unchanged', async () => {
    const analyzeChanges = vi.fn(async () => undefined);
    const service = createRecruitmentSourceSyncService({
      gateway: { search: async () => result },
      isEnabled: async () => true,
      previousRuns: async () => [{
        ...result,
        runId: 'run-old',
        organizationId: 'org-a', actorAccountId: 'admin-1',
        requisitionId: 'frontend-1', query: 'old query', createdAt: '2026-09-01T00:00:00.000Z',
        candidates: [{
          ...candidate,
          fieldEvidence: {
            skills: [{ ...candidate.fieldEvidence.skills[0], observedAt: '2026-08-01' }],
          },
        }],
        sources: [{ ...result.sources[0], durationMs: 999 }],
      }],
      analyzeChanges,
    });

    await expect(service.run(input)).resolves.toMatchObject({
      status: 'completed', changed: false, modelInvoked: false,
    });
    expect(analyzeChanges).not.toHaveBeenCalled();
  });

  it('calls change analysis once when source evidence changes', async () => {
    const analyzeChanges = vi.fn(async () => undefined);
    const service = createRecruitmentSourceSyncService({
      gateway: { search: async () => result },
      isEnabled: async () => true,
      previousRuns: async () => [],
      analyzeChanges,
    });

    await expect(service.run(input)).resolves.toMatchObject({
      status: 'completed', changed: true, modelInvoked: true,
    });
    expect(analyzeChanges).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a', requisitionId: 'frontend-1', current: result,
    }));
  });

  it('does not let timing or observation timestamps change the content fingerprint', () => {
    const first = recruitmentCandidateSetFingerprint(result.candidates);
    const second = recruitmentCandidateSetFingerprint([{
      ...candidate,
      fieldEvidence: {
        skills: [{ ...candidate.fieldEvidence.skills[0], observedAt: '2030-01-01' }],
      },
    }]);
    expect(first).toBe(second);
  });
});
