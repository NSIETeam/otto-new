/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { parseRecruitmentSemanticAnalysis } from '../recruitmentSemanticModel.js';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION, RECRUITMENT_SEMANTIC_DIMENSIONS, type RecruitmentSemanticEvidence } from '../recruitmentSemantic.js';
import { RECRUITMENT_QUALITY_CASES, RECRUITMENT_QUALITY_SUITE, type RecruitmentQualityCase } from './recruitmentQualityCases.js';

const resourceNames = ['inputTokens', 'outputTokens', 'requests', 'costCny', 'elapsedMs', 'hrReviewSeconds'] as const;
type ResourceName = typeof resourceNames[number];
export interface RecruitmentQualityRecord extends Record<ResourceName, number | null> { caseId: string; caseFingerprint: string; rawResponse: string }
export interface RecruitmentQualityRun { schemaVersion: 1; suiteVersion: string; runId: string; modelId: string; analysisVersion: string; cases: RecruitmentQualityRecord[] }
export interface QualityRate { numerator: number; denominator: number; rate: number | null }
const rate = (numerator: number, denominator: number): QualityRate => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });
const normalized = (value: string) => value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN');
export function qualityCaseFingerprint(item: RecruitmentQualityCase): string {
  return createHash('sha256').update(JSON.stringify([RECRUITMENT_QUALITY_SUITE, item])).digest('hex');
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function validateRun(value: unknown): asserts value is RecruitmentQualityRun {
  if (!object(value) || value.schemaVersion !== 1 || value.suiteVersion !== RECRUITMENT_QUALITY_SUITE || !Array.isArray(value.cases) || value.cases.length > RECRUITMENT_QUALITY_CASES.length) throw new Error('评测文件格式、套件版本或样本数量无效（也可能有重复样本）');
  for (const field of ['runId', 'modelId', 'analysisVersion']) if (typeof value[field] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/u.test(value[field])) throw new Error('评测元数据无效，请使用不含个人资料的版本标识');
  const seen = new Set<string>();
  for (const row of value.cases) {
    if (!object(row) || typeof row.caseId !== 'string' || typeof row.rawResponse !== 'string' || row.rawResponse.length > 200_000) throw new Error('评测样本格式或输出大小无效');
    if (seen.has(row.caseId)) throw new Error('评测样本重复'); seen.add(row.caseId);
    const test = RECRUITMENT_QUALITY_CASES.find((item) => item.id === row.caseId);
    if (!test || qualityCaseFingerprint(test) !== row.caseFingerprint) throw new Error('评测样本版本不一致，不能混用不同材料');
    for (const name of resourceNames) {
      const number = row[name];
      if (number !== null && (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1_000_000_000 || (['inputTokens', 'outputTokens', 'requests'].includes(name) && !Number.isSafeInteger(number)))) throw new Error('评测用量或耗时字段无效；没有数据请使用 null');
    }
  }
}
function rawObject(text: string): Record<string, unknown> | null {
  // Match the production parser's fenced/prefixed JSON boundary; do not expose parse errors or payloads.
  try { const value: unknown = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); return object(value) ? value : null; } catch { return null; }
}
function rows(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter(object) : []; }
function citations(raw: Record<string, unknown>): unknown[] {
  return ['dimensions', 'hardRequirements', 'evidenceGraph'].flatMap((key) => rows(raw[key]).flatMap((entry) => Array.isArray(entry.evidence) ? entry.evidence : []));
}
function lines(test: RecruitmentQualityCase): RecruitmentSemanticEvidence[] {
  return ([['resume', test.input.redactedResume], ['interview', test.input.interviewTranscript ?? ''], ['work_sample', test.input.workSampleArtifact ?? '']] as const)
    .flatMap(([source, text]) => text.split('\n').map((quote, index) => ({ quote, line: index + 1, source })));
}
function citationCheck(value: unknown, material: RecruitmentSemanticEvidence[]): { grounded: boolean; issue?: string } {
  const quote = typeof value === 'string' ? value : object(value) ? value.quote : undefined;
  if (typeof quote !== 'string' || !quote.trim()) return { grounded: false, issue: 'citation_not_found' };
  const matches = material.filter((line) => normalized(line.quote).includes(normalized(quote)));
  if (!matches.length) return { grounded: false, issue: 'citation_not_found' };
  if (object(value) && !matches.some((line) => (value.source === undefined || value.source === line.source) && (value.line === undefined || value.line === line.line))) return { grounded: false, issue: 'citation_source_or_line_mismatch' };
  return { grounded: true };
}
function matchesSupport(value: RecruitmentSemanticEvidence, expected: RecruitmentSemanticEvidence): boolean {
  const quote = normalized(value.quote); const gold = normalized(expected.quote);
  // Exact authored spans, plus longer quotations containing that span; mere keyword overlap is insufficient.
  return value.source === expected.source && value.line === expected.line && (quote === gold || quote.includes(gold));
}
interface CaseResult {
  caseId: string; supplied: boolean; parsed: boolean; requirements: number; covered: number; rawCorrect: number; correct: number;
  citations: number; grounded: number; supportExpected: number; supportFound: number; absent: number; falseNegatives: number;
  questionsExpected: number; questionsFound: number; unmapped: number; issues: string[];
}
function evaluateCase(test: RecruitmentQualityCase, record?: RecruitmentQualityRecord): CaseResult {
  const result: CaseResult = { caseId: test.id, supplied: Boolean(record), parsed: false, requirements: test.requirements.length, covered: 0, rawCorrect: 0, correct: 0, citations: 0, grounded: 0,
    supportExpected: test.requirements.filter((item) => item.support.length).length, supportFound: 0, absent: test.requirements.filter((item) => item.basis === 'absent').length, falseNegatives: 0,
    questionsExpected: test.requirements.filter((item) => item.needsQuestion).length, questionsFound: 0, unmapped: 0, issues: [] };
  if (!record) { result.issues.push('missing_case'); return result; }
  const raw = rawObject(record.rawResponse);
  if (raw) for (const cite of citations(raw)) { result.citations++; const checked = citationCheck(cite, lines(test)); if (checked.grounded) result.grounded++; else result.issues.push(checked.issue!); }
  let parsed;
  try {
    parsed = parseRecruitmentSemanticAnalysis(record.rawResponse, test.input.redactedResume, { modelProvider: 'offline-eval', inputTokens: 0, outputTokens: 0, interviewTranscript: test.input.interviewTranscript, workSampleArtifact: test.input.workSampleArtifact });
    result.parsed = true;
  } catch { result.issues.push('invalid_model_output'); }
  const requirements = rows(raw?.hardRequirements);
  const labels = (test.requirements.flatMap((item) => [item.label, ...item.aliases ?? []])).map(normalized);
  result.unmapped = requirements.filter((item) => typeof item.requirement !== 'string' || !labels.includes(normalized(item.requirement))).length;
  if (result.unmapped) result.issues.push('unmapped_requirement');
  for (const gold of test.requirements) {
    const names = [gold.label, ...gold.aliases ?? []].map(normalized);
    const identified = requirements.filter((item) => typeof item.requirement === 'string' && names.includes(normalized(item.requirement)));
    if (gold.basis === 'absent' && identified.some((item) => item.status === 'not_met')) { result.falseNegatives++; result.issues.push('absence_as_failure'); }
    if (identified.length !== 1) { result.issues.push(identified.length > 1 ? 'duplicate_requirement' : 'missing_requirement'); continue; }
    result.covered++;
    const item = identified[0];
    if (gold.allowed.some((status) => status === item.status)) result.rawCorrect++;
    const analyzed = parsed?.hardRequirements.find((entry) => names.includes(normalized(entry.requirement)));
    if (analyzed && gold.allowed.includes(analyzed.status)) result.correct++; else result.issues.push('unexpected_support_status');
    if (gold.support.length && gold.support.every((expected) => analyzed?.evidence.some((actual) => matchesSupport(actual, expected)))) result.supportFound++;
    else if (gold.support.length) result.issues.push('missing_relevant_support');
    if (analyzed?.evidence.some((entry) => !gold.support.some((expected) => matchesSupport(entry, expected)))) result.issues.push('irrelevant_requirement_evidence');
    if (gold.needsQuestion) {
      if (parsed?.interviewQuestions.some((question) => names.includes(normalized(question.criterion)) && question.question.trim().length >= 8)) result.questionsFound++;
      else result.issues.push('missing_follow_up');
    }
  }
  result.issues = [...new Set(result.issues)]; return result;
}
/** Evaluates supplied outputs only. No transport, tools, filesystem or candidate decisions. */
export function evaluateRecruitmentQuality(value: unknown) {
  validateRun(value);
  const cases = RECRUITMENT_QUALITY_CASES.map((item) => evaluateCase(item, value.cases.find((row) => row.caseId === item.id)));
  const sum = (key: keyof Omit<CaseResult, 'caseId' | 'issues' | 'supplied' | 'parsed'>) => cases.reduce((total, item) => total + item[key], 0);
  const updates = RECRUITMENT_QUALITY_CASES.filter((item) => item.updateOf);
  const updateCorrect = updates.filter((item) => [item.id, item.updateOf!].every((id) => { const row = cases.find((r) => r.caseId === id)!; return row.parsed && row.correct === row.requirements && row.supportFound === row.supportExpected; })).length;
  const resources = Object.fromEntries(resourceNames.map((name) => {
    const known = value.cases.map((item) => item[name]).filter((number): number is number => number !== null);
    const knownTotal = known.reduce((total, number) => total + number, 0);
    return [name, { knownCases: known.length, expectedCases: cases.length, knownTotal, total: known.length === cases.length ? knownTotal : null }];
  })) as Record<ResourceName, { knownCases: number; expectedCases: number; knownTotal: number; total: number | null }>;
  return { kind: 'otto-recruitment-quality-report-v1', suiteVersion: RECRUITMENT_QUALITY_SUITE, runId: value.runId, modelId: value.modelId, analysisVersion: value.analysisVersion,
    evaluatorVersion: '1', currentParserVersion: RECRUITMENT_SEMANTIC_ANALYSIS_VERSION, liveModelExecuted: false, humanReview: 'required', resourceProvenance: 'imported_unverified',
    caseCount: cases.length, missingCases: cases.filter((item) => !item.supplied).length,
    metrics: { parsedCases: rate(cases.filter((item) => item.parsed).length, cases.length), requirementCoverage: rate(sum('covered'), sum('requirements')),
      rawSupportAccuracy: rate(sum('rawCorrect'), sum('requirements')), supportAccuracy: rate(sum('correct'), sum('requirements')),
      groundedCitations: rate(sum('grounded'), sum('citations')), relevantSupport: rate(sum('supportFound'), sum('supportExpected')),
      absenceFalseNegatives: rate(sum('falseNegatives'), sum('absent')), followUpCoverage: rate(sum('questionsFound'), sum('questionsExpected')), materialUpdates: rate(updateCorrect, updates.length) },
    resources, cases,
    limitations: ['合成边界样本不是行业准确率；不能据此排序、淘汰或录用真实候选人。', '引用出现不等于事实属实；相关性只按预先标注的条件与原文片段核对。', '条件名需原样保留或命中预先审核的别名；改写未映射须人工复核，不表示候选人不具备能力。', '摘要夸大、面试问题质量、保护属性偏见与真实能力仍需人工盲审；耗时和费用为导入数据而非厂商账单核验。'] };
}
export type RecruitmentQualityReport = ReturnType<typeof evaluateRecruitmentQuality>;
export function compareRecruitmentQuality(baseline: RecruitmentQualityReport, candidate: RecruitmentQualityReport) {
  const comparable = baseline.suiteVersion === candidate.suiteVersion && baseline.currentParserVersion === candidate.currentParserVersion && !baseline.missingCases && !candidate.missingCases;
  const metricNames = Object.keys(candidate.metrics) as Array<keyof typeof candidate.metrics>;
  const delta = Object.fromEntries(metricNames.map((name) => [name, comparable && baseline.metrics[name].rate !== null && candidate.metrics[name].rate !== null ? candidate.metrics[name].rate! - baseline.metrics[name].rate! : null])) as Record<typeof metricNames[number], number | null>;
  const regressions = metricNames.filter((name) => delta[name] !== null && (name === 'absenceFalseNegatives' ? delta[name]! > 0 : delta[name]! < 0));
  const resourceDelta = Object.fromEntries(resourceNames.map((name) => [name, comparable && baseline.resources[name].total !== null && candidate.resources[name].total !== null ? candidate.resources[name].total! - baseline.resources[name].total! : null]));
  return { kind: 'otto-recruitment-quality-comparison-v1', comparable, baseline: baseline.runId, candidate: candidate.runId, metricDelta: delta, resourceDelta, regressions, productionReady: 'not_determined',
    notice: comparable ? '同一套件在当前解析器下重放；正向指标增加为改善，absenceFalseNegatives 增加为退步。版本与模型可不同，未控制的其他因素须另行记录。' : '样本不齐或套件、解析器口径不同，不输出可比差值；不得用部分样本宣称更好。' };
}
/** Grader self-check only: derived from authored labels, NEVER a model or a measured baseline. */
export function qualityReferenceResponse(item: RecruitmentQualityCase): string {
  return JSON.stringify({ summary: '合成的评分器自检数据，不是模型输出或人工核实。',
    dimensions: RECRUITMENT_SEMANTIC_DIMENSIONS.map((dimension) => ({ id: dimension.id, score: 50, assessment: '只描述材料支持', evidence: [] })),
    hardRequirements: item.requirements.map((requirement) => ({ requirement: requirement.label, status: requirement.allowed[0], explanation: '依据预先标注的材料范围', evidence: requirement.support })),
    interviewQuestions: item.requirements.filter((requirement) => requirement.needsQuestion).map((requirement) => ({ criterion: requirement.label, question: '请结合一个实际项目说明你的个人职责、验证方式及结果。', rationale: '仅用于自检问题覆盖，不代表题目质量通过' })) });
}
