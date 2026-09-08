import { describe, expect, it, vi } from 'vitest';
import { inspectRecruitmentReadiness, runRecruitmentReadinessCli } from './recruitmentReadinessCli.js';
const scope = { organizationId: 'org', actorAccountId: 'hr', requisitionId: 'job' };
describe('recruitment offline preflight', () => {
  it('reports missing prerequisites without touching a network, database or model', () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not call'));
    try {
      const report = inspectRecruitmentReadiness({}, scope);
      expect(report).toMatchObject({ networkUsed: false, databaseConnected: false, modelInvoked: false, liveAcceptance: 'not_run' });
      expect(report.checks.every((entry) => entry.status === 'missing')).toBe(true); expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it('never presents configuration as live acceptance or emits credentials', () => {
    const env = { OTTO_WORKABLE_OAUTH_ENABLED: '1', OTTO_WORKABLE_REAL_ACCOUNT_VERIFIED: '1', OTTO_WORKABLE_AUTHORIZATION_REFERENCE: 'private-approval',
      OTTO_WORKABLE_ACCEPTANCE_SCOPES: JSON.stringify([{ ...scope, jobId: 'job', approvalReference: 'private-approval', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }]),
      OTTO_WORKABLE_RESUME_ORIGINS: '["https://files.example.test"]', OTTO_RECRUITMENT_BACKGROUND_ANALYSIS_ENABLED: '1', OTTO_RECRUITMENT_MODEL_ORGANIZATION_IDS: 'org',
      OTTO_RECRUITMENT_MODEL_API_URL: 'https://model.example.test/v1/chat/completions', OTTO_RECRUITMENT_MODEL_API_KEY: 'private-key', OTTO_RECRUITMENT_MODEL: 'model', OTTO_RECRUITMENT_MODEL_APPROVAL: 'private-approval',
      OTTO_RECRUITMENT_ORGANIZATION_BUDGETS: JSON.stringify([{ organizationId: 'org', dailyRequests: 10, dailyReservedTokens: 200_000 }]),
      OTTO_POSTGRES_URL: 'postgresql://private-user:private-password@localhost/test' };
    const report = inspectRecruitmentReadiness(env, scope);
    expect(report.checks.every((entry) => entry.status === 'configured')).toBe(true);
    expect(report.liveAcceptance).toBe('not_run'); expect(JSON.stringify(report)).not.toMatch(/private-|postgresql:\/\/|model.example/u);
    expect(inspectRecruitmentReadiness({ ...env, OTTO_RECRUITMENT_ORGANIZATION_BUDGETS: '' }, scope).checks.find((entry) => entry.id === 'organization_budget')?.status).toBe('missing');
    expect(inspectRecruitmentReadiness({ ...env, OTTO_WORKABLE_RESUME_ORIGINS: '["https://*.example.test"]' }, scope).checks.find((entry) => entry.id === 'resume_origins')?.status).toBe('invalid');
  });
  it('rejects unknown or duplicate CLI arguments and gives a nonzero exit for missing configuration', () => {
    const output = vi.fn(); expect(runRecruitmentReadinessCli(['--org', 'org', '--actor', 'hr', '--job', 'job'], {}, output)).toBe(2);
    expect(output).toHaveBeenCalledOnce();
    expect(runRecruitmentReadinessCli(['--token', 'private-token'], {}, output)).toBe(2);
    expect(runRecruitmentReadinessCli(['--org', 'org', '--org', 'again'], {}, output)).toBe(2);
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-token');
  });
});
