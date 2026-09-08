import { describe, expect, it } from 'vitest';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION } from '../recruitmentSemantic.js';
import { RECRUITMENT_QUALITY_CASES, RECRUITMENT_QUALITY_SUITE } from './recruitmentQualityCases.js';
import { compareRecruitmentQuality, evaluateRecruitmentQuality, qualityCaseFingerprint, qualityReferenceResponse, type RecruitmentQualityRun } from './recruitmentQuality.js';

function run(): RecruitmentQualityRun {
  return { schemaVersion: 1, suiteVersion: RECRUITMENT_QUALITY_SUITE, runId: 'synthetic-fixture', modelId: 'synthetic-not-a-model', analysisVersion: RECRUITMENT_SEMANTIC_ANALYSIS_VERSION,
    cases: RECRUITMENT_QUALITY_CASES.map((item) => ({ caseId: item.id, caseFingerprint: qualityCaseFingerprint(item), rawResponse: qualityReferenceResponse(item), inputTokens: null, outputTokens: null, requests: null, costCny: null, elapsedMs: null, hrReviewSeconds: null })) };
}

describe('recruitment quality evaluation, not candidate ranking', () => {
  it('evaluates every annotated condition against the production parser with explicit denominators and unknown costs', () => {
    const report = evaluateRecruitmentQuality(run());
    expect(report.caseCount).toBe(RECRUITMENT_QUALITY_CASES.length);
    expect(report.missingCases).toBe(0); expect(report.metrics.parsedCases).toEqual({ numerator: report.caseCount, denominator: report.caseCount, rate: 1 });
    expect(report.metrics.requirementCoverage.rate).toBe(1); expect(report.metrics.supportAccuracy.rate).toBe(1);
    expect(report.metrics.groundedCitations.rate).toBe(1); expect(report.metrics.relevantSupport.rate).toBe(1);
    expect(report.metrics.materialUpdates.rate).toBe(1);
    expect(report.resources.costCny).toMatchObject({ total: null, knownCases: 0 });
    expect(report.resources.hrReviewSeconds).toMatchObject({ total: null, knownCases: 0 });
    expect(report.liveModelExecuted).toBe(false); expect(report.humanReview).toBe('required');
    expect(JSON.stringify(report)).not.toContain(RECRUITMENT_QUALITY_CASES[0].input.redactedResume);
  });
  it('counts invented quotations before the parser drops them, rather than reporting perfect precision', () => {
    const result = run(); const raw = JSON.parse(result.cases[0].rawResponse);
    raw.dimensions[0].evidence = ['我领导了一个从未出现在材料里的项目'];
    result.cases[0].rawResponse = JSON.stringify(raw);
    const report = evaluateRecruitmentQuality(result);
    expect(report.metrics.groundedCitations.rate).toBeLessThan(1);
    expect(report.cases[0].issues).toContain('citation_not_found');
    expect(report.cases[0].parsed).toBe(true);
  });
  it('distinguishes a real but irrelevant quote from evidence for a requirement and catches missing-as-incapable', () => {
    const result = run(); const item = RECRUITMENT_QUALITY_CASES.find((entry) => entry.id === 'missing-testing')!;
    const record = result.cases.find((entry) => entry.caseId === item.id)!; const raw = JSON.parse(record.rawResponse);
    raw.hardRequirements[0] = { requirement: item.requirements[0].label, status: 'not_met', explanation: '没有看到测试', evidence: [item.input.redactedResume] };
    record.rawResponse = JSON.stringify(raw);
    const report = evaluateRecruitmentQuality(result); const row = report.cases.find((entry) => entry.caseId === item.id)!;
    expect(row.issues).toContain('absence_as_failure'); expect(row.issues).toContain('irrelevant_requirement_evidence');
    expect(report.metrics.absenceFalseNegatives.numerator).toBe(1);
    expect(report.metrics.groundedCitations.rate).toBe(1); // Occurrence alone does not prove relevance.
    expect(report.metrics.supportAccuracy.rate).toBeLessThan(1);
  });
  it('uses the full suite denominator when difficult cases or requirements are omitted, and rejects duplicates', () => {
    const result = run(); result.cases.pop();
    const raw = JSON.parse(result.cases[0].rawResponse); raw.hardRequirements = []; result.cases[0].rawResponse = JSON.stringify(raw);
    const report = evaluateRecruitmentQuality(result);
    expect(report.missingCases).toBe(1); expect(report.metrics.requirementCoverage.rate).toBeLessThan(1);
    expect(report.metrics.supportAccuracy.rate).toBeLessThan(1);
    const repeated = run(); repeated.cases.push(repeated.cases[0]);
    expect(() => evaluateRecruitmentQuality(repeated)).toThrow('重复');
    const contradictory = run(); const response = JSON.parse(contradictory.cases[0].rawResponse);
    response.hardRequirements.push({ ...response.hardRequirements[0], status: 'met' }); contradictory.cases[0].rawResponse = JSON.stringify(response);
    expect(evaluateRecruitmentQuality(contradictory).cases[0].issues).toContain('duplicate_requirement');
  });
  it('rejects stale material fingerprints and records schema failures without echoing private model output', () => {
    const result = run(); result.cases[0].caseFingerprint = 'a'.repeat(64);
    expect(() => evaluateRecruitmentQuality(result)).toThrow('样本版本');
    const malformed = run(); malformed.cases[0].rawResponse = 'private-provider-token-response';
    const report = evaluateRecruitmentQuality(malformed);
    expect(report.metrics.parsedCases.numerator).toBe(report.caseCount - 1);
    expect(report.cases[0].issues).toContain('invalid_model_output');
    expect(JSON.stringify(report)).not.toContain('private-provider-token-response');
  });
  it('checks source and line claims independently and does not treat contradictory new material as verified ability', () => {
    const result = run(); const row = result.cases.find((entry) => entry.caseId === 'work-sample-testing')!;
    const raw = JSON.parse(row.rawResponse);
    raw.hardRequirements[0].evidence[0].source = 'interview'; raw.hardRequirements[0].evidence[0].line = 99;
    row.rawResponse = JSON.stringify(raw);
    const report = evaluateRecruitmentQuality(result);
    expect(report.cases.find((entry) => entry.caseId === row.caseId)!.issues).toContain('citation_source_or_line_mismatch');
    expect(report.metrics.relevantSupport.rate).toBeLessThan(1);
    const before = result.cases.find((entry) => entry.caseId === 'resume-testing')!;
    const after = result.cases.find((entry) => entry.caseId === 'interview-contradiction')!;
    after.rawResponse = before.rawResponse;
    expect(evaluateRecruitmentQuality(result).metrics.materialUpdates.rate).toBeLessThan(1);
  });
  it('compares the same complete suite, reports direction-specific regressions and keeps missing measurements unknown', () => {
    const baseline = run(); const candidate = run(); candidate.runId = 'candidate-version'; candidate.analysisVersion = 'candidate-rules';
    candidate.cases[0].rawResponse = 'invalid';
    const comparison = compareRecruitmentQuality(evaluateRecruitmentQuality(baseline), evaluateRecruitmentQuality(candidate));
    expect(comparison.comparable).toBe(true); expect(comparison.regressions).toContain('supportAccuracy');
    expect(comparison.resourceDelta.costCny).toBeNull(); expect(comparison.productionReady).toBe('not_determined');
    baseline.cases.pop();
    expect(compareRecruitmentQuality(evaluateRecruitmentQuality(baseline), evaluateRecruitmentQuality(candidate)).comparable).toBe(false);
  });
  it('does not average away unsupported resource measurements or use negative or nonfinite values', () => {
    const result = run(); result.cases[0].costCny = 0; result.cases[0].requests = 1;
    const report = evaluateRecruitmentQuality(result);
    expect(report.resources.costCny).toMatchObject({ knownCases: 1, knownTotal: 0, total: null });
    result.cases[0].inputTokens = -1; expect(() => evaluateRecruitmentQuality(result)).toThrow('用量');
    result.cases[0].inputTokens = null; result.cases[0].hrReviewSeconds = Infinity;
    expect(() => evaluateRecruitmentQuality(result)).toThrow('用量');
  });
});
