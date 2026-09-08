import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRecruitmentBackgroundModel } from './recruitmentBackgroundModel.js';

const env = { OTTO_RECRUITMENT_BACKGROUND_ANALYSIS_ENABLED: '1', OTTO_RECRUITMENT_MODEL_ORGANIZATION_IDS: 'org-a', OTTO_RECRUITMENT_MODEL_API_KEY: 'synthetic-test-only', OTTO_RECRUITMENT_MODEL: 'test-model', OTTO_RECRUITMENT_MODEL_APPROVAL: 'approval-1', OTTO_RECRUITMENT_MODEL_API_URL: 'https://model.example.test/v1/chat/completions' };
afterEach(() => vi.unstubAllGlobals());
describe('explicitly approved recruitment model routing', () => {
  it('fails closed without opt-in, exact tenant or HTTPS approval and changes identity when routing changes', () => {
    expect(resolveRecruitmentBackgroundModel('org-a', {})).toBeNull();
    expect(resolveRecruitmentBackgroundModel('org-b', env)).toBeNull();
    expect(resolveRecruitmentBackgroundModel('org-a', { ...env, OTTO_ENTERPRISE_CANARY_MODE: '1' })).toBeNull();
    expect(resolveRecruitmentBackgroundModel('org-a', { ...env, OTTO_RECRUITMENT_MODEL_ORGANIZATION_IDS: '*' })).toBeNull();
    for (const url of ['http://model.example.test', 'https://user:pass@model.example.test', 'https://model.example.test?secret=1']) expect(resolveRecruitmentBackgroundModel('org-a', { ...env, OTTO_RECRUITMENT_MODEL_API_URL: url })).toBeNull();
    expect(resolveRecruitmentBackgroundModel('org-a', env)?.version).not.toBe(resolveRecruitmentBackgroundModel('org-a', { ...env, OTTO_RECRUITMENT_MODEL_APPROVAL: 'approval-2' })?.version);
  });
  it('uses bounded no-tool requests, blocks redirects and does not invent missing usage', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })));
    vi.stubGlobal('fetch', fetcher); const model = resolveRecruitmentBackgroundModel('org-a', env)!;
    expect(await model.invoke('synthetic resume', new AbortController().signal)).toEqual({ raw: '{}', inputTokens: null, outputTokens: null });
    const options = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(options[1].redirect).toBe('error'); expect(JSON.parse(String(options[1].body))).toMatchObject({ max_tokens: 4096 });
    expect(JSON.parse(String(options[1].body))).not.toHaveProperty('tools');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })));
    await expect(model.invoke('resume', new AbortController().signal)).rejects.toThrow('不完整');
    fetcher.mockResolvedValueOnce(new Response('secret upstream content', { status: 403 }));
    await expect(model.invoke('resume', new AbortController().signal)).rejects.toThrow('未完成');
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(1_000_001)));
    await expect(model.invoke('resume', new AbortController().signal)).rejects.toThrow('上限');
  });
});
