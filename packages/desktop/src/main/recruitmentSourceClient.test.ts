import { describe, expect, it, vi } from 'vitest';
import { EnterpriseClient } from './enterprise-client.js';

describe('recruitment source enterprise client', () => {
  it('requires the one-off capability and does not retry an ambiguous paid response', async () => {
    const action = { kind: 'analyze_intake_once' as const, jobId: 'job', itemId: 'a'.repeat(64), expectedRevision: 1, scopeToken: 'b'.repeat(64), headerToken: 'c'.repeat(64), modelVersion: 'v', confirmed: true as const };
    const old = harness(['recruitment_jobs_v1', 'recruitment_organization_budget_v1']);
    await expect(old.client.recruitmentJobs(action)).rejects.toThrow(/升级/);
    expect(old.fetcher.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
    const h = harness(['recruitment_jobs_v1', 'recruitment_intake_once_v1', 'recruitment_organization_budget_v1']);
    h.fetcher.mockImplementation(async (_url, init) => init?.method === 'POST' ? new Response('unavailable', { status: 503 }) : Response.json({ status: 'ok', apiVersion: 3, capabilities: ['recruitment_jobs_v1', 'recruitment_intake_once_v1', 'recruitment_organization_budget_v1'] }));
    await expect(h.client.recruitmentJobs(action)).rejects.toThrow();
    expect(h.fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('refuses new paid background consent on an older server but still allows pausing', async () => {
    const h = harness(['recruitment_jobs_v1']);
    await expect(h.client.recruitmentJobs({ kind: 'configure_background_analysis', jobId: 'job', expectedRevision: 1, enabled: true, confirmed: true })).rejects.toThrow(/升级/);
    expect(h.fetcher.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
    await h.client.recruitmentJobs({ kind: 'configure_background_analysis', jobId: 'job', expectedRevision: 1, enabled: false, confirmed: true });
    expect(h.fetcher.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(true);
  });
  it('does not send sample-read consent to a server without the acceptance capability', async () => {
    const h = harness(['recruitment_workable_connections_v1']);
    await expect(h.client.workableConnection({ kind: 'material_probe', jobId: 'job', expectedRevision: 1, confirmed: true })).rejects.toThrow(/升级/);
    expect(h.fetcher.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
  });
  it('never sends auto-archive consent to an older server', async () => {
    const h = harness(['recruitment_jobs_v1', 'recruitment_intake_v1']);
    await expect(h.client.recruitmentJobs({ kind: 'configure_auto_archive', jobId: 'job', expectedRevision: 1, enabled: true, confirmed: true, retentionDays: 7 })).rejects.toThrow(/升级/);
    expect(h.fetcher.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
  });
  it('does not post analysis claims to a server without the new coordination capability', async () => {
    const h = harness(['recruitment_shared_jobs_v1', 'recruitment_server_intake_v1']);
    await expect(h.client.recruitmentJobs({ kind: 'claim_intake_analysis', jobId: 'job', itemId: 'a'.repeat(64), requestId: 'request', candidateId: 'candidate', scopeToken: 'b'.repeat(64), headerToken: 'c'.repeat(64), confirmed: true })).rejects.toThrow(/升级/);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.fetcher.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
  });
  it('requires a material-capable server and posts identifiers only', async () => {
    const old = harness(['recruitment_source_gateway_v1']);
    await expect(old.client.getRecruitmentSourceMaterial({ runId: 'r', requisitionId: 'j', canonicalId: 'c', sourceId: 's' })).rejects.toThrow(/升级/u);
    const h = harness(['recruitment_source_material_v1']);
    await h.client.getRecruitmentSourceMaterial({ runId: 'r', requisitionId: 'j', canonicalId: 'c', sourceId: 's' });
    expect(h.fetcher.mock.calls[1]?.[0]).toContain('/enterprise/recruitment/sources/material');
    expect(JSON.parse(String(h.fetcher.mock.calls[1]?.[1]?.body))).toEqual({ runId: 'r', requisitionId: 'j', canonicalId: 'c', sourceId: 's' });
  });
  const harness = (capabilities: string[]) => {
    const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = path === '/enterprise/health'
        ? { status: 'ok', apiVersion: 3, capabilities }
        : path === '/enterprise/recruitment/sources'
          ? { sources: [{ id: 'official', searchable: true }] }
          : path.startsWith('/enterprise/recruitment/source-runs/')
            ? { result: { runId: 'run-1', candidates: [], sources: [] } }
            : { result: { runId: 'run-1', candidates: [], sources: [] } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new EnterpriseClient(fetcher);
    client.restore({ serverUrl: 'https://enterprise.example', token: 'fixture-token' });
    return { client, fetcher };
  };

  it('requires an upgraded server before exposing candidate source access', async () => {
    const { client, fetcher } = harness([]);
    await expect(client.listRecruitmentSources()).rejects.toThrow(/升级/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('passes the selected job as a bounded query parameter and rejects invalid identifiers', async () => {
    const { client, fetcher } = harness(['recruitment_source_gateway_v1']);
    await client.listRecruitmentSources('frontend:1');
    expect(String(fetcher.mock.calls[1]![0])).toContain('?requisitionId=frontend%3A1');
    const count = fetcher.mock.calls.length;
    await expect(client.listRecruitmentSources('j&actor=other')).rejects.toThrow(/标识/);
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it('discards source readiness if the enterprise session changes during the response', async () => {
    const { client, fetcher } = harness(['recruitment_source_gateway_v1']);
    await client.listRecruitmentSources('job');
    fetcher.mockImplementationOnce(async () => {
      client.restore({ serverUrl: 'https://other.example', token: 'another-token' });
      return Response.json({ sources: [{ id: 'private-old-account', searchable: true }] });
    });
    await expect(client.listRecruitmentSources('job')).rejects.toThrow();
  });

  it('lists, searches and reloads an audited search run through authenticated routes', async () => {
    const { client, fetcher } = harness(['recruitment_source_gateway_v1']);
    await expect(client.listRecruitmentSources()).resolves.toEqual([
      { id: 'official', searchable: true },
    ]);
    await expect(client.searchRecruitmentSources({
      requisitionId: 'frontend-1', query: 'Electron 前端', sourceIds: ['official'],
    })).resolves.toMatchObject({ runId: 'run-1' });
    await expect(client.getRecruitmentSourceRun('run-1')).resolves.toMatchObject({ runId: 'run-1' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/enterprise/health',
      '/enterprise/recruitment/sources',
      '/enterprise/recruitment/sources/search',
      '/enterprise/recruitment/source-runs/run-1',
    ]);
    const searchRequest = fetcher.mock.calls[2]?.[1];
    expect(searchRequest?.method).toBe('POST');
    expect(JSON.parse(String(searchRequest?.body))).toEqual({
      requisitionId: 'frontend-1', query: 'Electron 前端', sourceIds: ['official'],
    });
  });
});
