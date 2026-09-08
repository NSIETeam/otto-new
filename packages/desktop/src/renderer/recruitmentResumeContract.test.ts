import { afterEach, expect, it, vi } from 'vitest';
import { createWorkableRecruitmentAdapter, createRecruitmentResumeReader, createRecruitmentSourceRuntime } from 'otto-server';
import { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';
import { importRecruitmentSourceCandidate, type RecruitmentSourceImportInput } from './recruitmentSourceImport.js';
import { parseRecruitmentCandidateDocument } from './recruitmentArchive.js';
import type { RecruitmentSemanticEvaluation } from '../main/recruitmentSemantic.js';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION } from '../main/recruitmentSemantic.js';

afterEach(() => vi.unstubAllGlobals());

it('roundtrips Workable search, authorized attachment extraction, dossier import, model analysis and archive restoration', async () => {
  const resume = '电话：13900139000\n邮箱：person@example.test\n使用 React 与 TypeScript 交付企业办公系统，负责性能优化、测试与上线。';
  const fetcher = vi.fn(async () => new Response(resume, { headers: { 'content-type': 'text/plain' } }));
  vi.stubGlobal('fetch', fetcher);
  const source = createWorkableRecruitmentAdapter({
    resumeReader: createRecruitmentResumeReader({ approvedOrigins: ['https://files.example.test'], lookup: async () => [{ address: '8.8.8.8', family: 4 }] }),
    openSession: async () => ({ account: 'acme', jobShortcode: 'FRONT', bindingRevision: '1', assertAuthorized: async () => undefined, close: async () => undefined,
      listTools: async () => [
        { name: 'get_accounts', inputSchema: { type: 'object', properties: {}, required: [] } },
        { name: 'get_candidates', inputSchema: { type: 'object', properties: { account: { type: 'string' }, shortcode: { type: 'string' }, limit: { type: 'integer' } }, required: ['account', 'shortcode'] } },
        { name: 'get_candidate', inputSchema: { type: 'object', properties: { account: { type: 'string' }, id: { type: 'string' } }, required: ['account', 'id'] } },
      ],
      callTool: async (name) => name === 'get_accounts' ? { accounts: [{ subdomain: 'acme' }] } : name === 'get_candidates' ? { candidates: [{ id: '1', name: '候选人' }] } : { candidate: { id: '1', resume_url: 'https://files.example.test/resume?signature=private' } },
    }),
  });
  const scope = { organizationId: 'org', actorAccountId: 'hr', requisitionId: 'job' };
  const audit = vi.fn(async () => undefined);
  const runtime = createRecruitmentSourceRuntime({ registrations: [{ adapter: source, accessMode: 'authorized_mcp', productionEnabled: true, authorizationReference: 'synthetic-fixture-only' }], authorizeSource: async () => ({ allowed: true }), auditMaterial: audit });
  const result = await runtime.search({ ...scope, query: 'React' });
  const store = new RecruitmentWorkspaceStore('org:hr');
  store.setJobTitle('前端'); store.setJobDescription('React'); store.setConsentConfirmed(true);
  store.setSourceSearch({ requisitionId: 'job', jobTitle: '前端', jobDescription: 'React', result });
  const analyzeResume = vi.fn(async () => ({ summary: '测试分析结果', overallScore: 70, matchLevel: 'good', evidenceCoverage: 80, dimensions: [], hardRequirements: [], strengths: [], risks: [], missingInformation: [], interviewQuestions: [], analysisVersion: RECRUITMENT_SEMANTIC_ANALYSIS_VERSION, modelProvider: 'fixture', inputTokens: 1, outputTokens: 1, createdAt: new Date().toISOString() }) as RecruitmentSemanticEvaluation);
  const input: RecruitmentSourceImportInput = { store, canonicalId: result.candidates[0].canonicalId, sourceId: 'workable', getMaterial: (request) => runtime.getCandidateMaterial!({ ...scope, ...request }), analyzeResume };
  const imported = await importRecruitmentSourceCandidate(input);
  expect(imported.status).toBe('analyzed');
  expect(imported.candidate.sourceMaterial?.material.attachment?.format).toBe('txt');
  expect(JSON.stringify(analyzeResume.mock.calls)).not.toContain('13900139000');
  expect(JSON.stringify(audit.mock.calls)).not.toContain('signature');
  const parsed = parseRecruitmentCandidateDocument(JSON.stringify(imported.candidate));
  expect(parsed.candidate.sourceMaterial?.material.attachment).toEqual(imported.candidate.sourceMaterial?.material.attachment);
  const malformed = structuredClone(imported.candidate);
  malformed.sourceMaterial!.material.attachment!.bytes = -1;
  expect(() => parseRecruitmentCandidateDocument(JSON.stringify(malformed))).toThrow(/格式/);
  analyzeResume.mockResolvedValueOnce({ ...imported.candidate.semanticEvaluation!, execution: {
    runId: 'cached-run', disposition: 'reused', requestedAt: new Date().toISOString(), inputFingerprint: 'a'.repeat(64), inputTokens: 1, outputTokens: 1,
  } });
  expect((await importRecruitmentSourceCandidate(input)).status).toBe('unchanged');
  expect(analyzeResume).toHaveBeenCalledTimes(2); // The trusted boundary, not this renderer adapter, decides reuse.
  expect(store.getSnapshot().candidates).toHaveLength(1);
});
