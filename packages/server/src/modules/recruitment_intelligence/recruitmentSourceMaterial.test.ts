import { describe, expect, it, vi } from 'vitest';
import { createRecruitmentSourceRuntime } from './recruitmentSourceRuntime.js';
import type { RecruitmentSourceAdapter } from './recruitmentSourceGateway.js';

async function fixture() {
  let clock = Date.now();
  let authorized = true;
  const getCandidate = vi.fn(async () => ({
    sourceRecordId: 'person-1', fileName: 'resume.txt',
    completeness: 'full_text' as const,
    text: '前端工程师，使用 React 和 TypeScript 交付企业应用，负责性能优化与异常恢复。',
  }));
  const adapter: RecruitmentSourceAdapter = {
    id: 'official', label: '企业授权人才库',
    capabilities: ['search_candidates', 'get_candidate'],
    search: async () => ({ candidates: [{ sourceRecordId: 'person-1', displayName: '候选人' }] }),
    getCandidate,
  };
  const auditMaterial = vi.fn();
  const runtime = createRecruitmentSourceRuntime({
    registrations: [{ adapter, accessMode: 'official_api', productionEnabled: true, authorizationReference: 'review-1' }],
    authorizeSource: async () => ({ allowed: authorized }),
    sourceTimeoutMs: 100,
    auditMaterial,
    now: () => new Date(clock),
  });
  const principal = { organizationId: 'org-a', actorAccountId: 'hr-a' };
  const result = await runtime.search({ ...principal, requisitionId: 'job-1', query: '前端工程师' });
  const request = { ...principal, runId: result.runId, requisitionId: 'job-1', canonicalId: result.candidates[0]!.canonicalId, sourceId: 'official' };
  return { runtime, request, getCandidate, auditMaterial, advance: () => { clock += 86_400_000; }, revoke: () => { authorized = false; } };
}

describe('recruitment source material retrieval', () => {
  it.each(['retrieval', 'audit'])('discards material if its search expires during %s', async (stage) => {
    const h = await fixture();
    if (stage === 'retrieval') h.getCandidate.mockImplementation(async () => {
      h.advance();
      return { sourceRecordId: 'person-1', fileName: 'resume.txt', completeness: 'full_text', text: 'private material' };
    });
    else h.auditMaterial.mockImplementation(async () => { h.advance(); });
    await expect(h.runtime.getCandidateMaterial!(h.request)).rejects.toMatchObject({ code: 'RECRUITMENT_SEARCH_EXPIRED' });
  });
  it('loads only a stored search reference, fingerprints text and audits metadata without resume content', async () => {
    const h = await fixture();
    const result = await h.runtime.getCandidateMaterial!(h.request);
    expect(result).toMatchObject({
      runId: h.request.runId, requisitionId: 'job-1',
      source: { sourceId: 'official', sourceRecordId: 'person-1' },
      acquisitionMode: 'authorized_api', material: { completeness: 'full_text' },
    });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(h.getCandidate).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a', actorAccountId: 'hr-a', sourceRecordId: 'person-1',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(h.auditMaterial).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.auditMaterial.mock.calls)).not.toContain(result.material.text);
  });

  it.each([
    { organizationId: 'org-b' }, { actorAccountId: 'hr-b' },
    { requisitionId: 'job-other' }, { canonicalId: 'f'.repeat(64) }, { sourceId: 'unlisted' },
  ])('blocks guessed or cross-scope references: %j', async (override) => {
    const h = await fixture();
    await expect(h.runtime.getCandidateMaterial!({ ...h.request, ...override })).rejects.toMatchObject({ status: 404 });
    expect(h.getCandidate).not.toHaveBeenCalled();
  });

  it('checks authorization again instead of relying on a successful earlier search', async () => {
    const h = await fixture(); h.revoke();
    await expect(h.runtime.getCandidateMaterial!(h.request)).rejects.toMatchObject({ status: 403 });
    expect(h.getCandidate).not.toHaveBeenCalled();
  });

  it('discards returned material if authorization is revoked during retrieval', async () => {
    const h = await fixture();
    h.getCandidate.mockImplementation(async () => {
      h.revoke();
      return { sourceRecordId: 'person-1', fileName: 'resume.txt', completeness: 'full_text', text: 'private material' };
    });
    await expect(h.runtime.getCandidateMaterial!(h.request)).rejects.toMatchObject({ status: 403 });
  });

  it('does not promote a summary to full text', async () => {
    const h = await fixture();
    h.getCandidate.mockResolvedValue({ sourceRecordId: 'person-1', text: 'React 工程师' } as never);
    await expect(h.runtime.getCandidateMaterial!(h.request)).resolves.toMatchObject({ material: { completeness: 'partial' } });
  });

  it('reports unavailable material rather than claiming full text for an empty response', async () => {
    const h = await fixture();
    h.getCandidate.mockResolvedValue({ sourceRecordId: 'person-1', completeness: 'full_text', text: '' } as never);
    await expect(h.runtime.getCandidateMaterial!(h.request)).resolves.toMatchObject({ material: { completeness: 'unavailable' } });
  });

  it.each([
    { sourceRecordId: 'other', completeness: 'full_text', text: 'wrong candidate' },
    { sourceRecordId: 'person-1', completeness: 'full_text', text: 'x'.repeat(80_001) },
  ])('rejects mismatched identities and oversized material without truncation', async (material) => {
    const h = await fixture(); h.getCandidate.mockResolvedValue(material as never);
    await expect(h.runtime.getCandidateMaterial!(h.request)).rejects.toMatchObject({ status: 502 });
  });

  it('bounds a connector that ignores cancellation and redacts connector errors', async () => {
    const h = await fixture();
    h.getCandidate.mockImplementation(() => new Promise(() => {}));
    await expect(h.runtime.getCandidateMaterial!(h.request)).rejects.toMatchObject({ status: 504 });
    h.getCandidate.mockRejectedValue(new Error('secret-token-private-resume'));
    await expect(h.runtime.getCandidateMaterial!(h.request)).rejects.toThrow('候选人材料读取失败');
  });

  it('does not invoke a connector when the request is already cancelled', async () => {
    const h = await fixture();
    await expect(h.runtime.getCandidateMaterial!({ ...h.request, signal: AbortSignal.abort() })).rejects.toThrow(/cancelled/u);
    expect(h.getCandidate).not.toHaveBeenCalled();
  });
});
