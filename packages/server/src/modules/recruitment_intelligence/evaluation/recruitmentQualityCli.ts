#!/usr/bin/env node
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRecruitmentPrompt } from '../recruitmentSemanticModel.js';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION } from '../recruitmentSemantic.js';
import { RECRUITMENT_QUALITY_CASES, RECRUITMENT_QUALITY_SUITE } from './recruitmentQualityCases.js';
import { compareRecruitmentQuality, evaluateRecruitmentQuality, qualityCaseFingerprint, qualityReferenceResponse, type RecruitmentQualityRun } from './recruitmentQuality.js';

const MAX_FILE_BYTES = 8_000_000;
function localPath(value: string): boolean { return Boolean(value && !value.includes('\0') && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) && !value.startsWith('\\\\') && !value.startsWith('//')); }
async function readLocalFile(file: string): Promise<string> {
  if (!localPath(file)) throw new Error('仅接受本地结果文件');
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('结果文件超过限制');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1); let total = 0;
    while (total <= MAX_FILE_BYTES) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break; total += bytesRead;
    }
    if (total > MAX_FILE_BYTES) throw new Error('结果文件超过限制');
    return buffer.subarray(0, total).toString('utf8');
  } finally { await handle.close(); }
}
export function recruitmentQualityTemplate(): RecruitmentQualityRun & { notice: string; prompts: Array<{ caseId: string; promptHash: string; prompt: string }> } {
  return { schemaVersion: 1, suiteVersion: RECRUITMENT_QUALITY_SUITE, runId: 'replace-run-id', modelId: 'replace-model-id', analysisVersion: RECRUITMENT_SEMANTIC_ANALYSIS_VERSION,
    notice: '全部材料为合成。仅将 prompts 中对应 prompt 发给获准模型；保留原始响应，不修答案，不传评分标注。条件名保持岗位原文，无法映射的改写需人工复核。未知用量用 null。此模板未调用模型。',
    cases: RECRUITMENT_QUALITY_CASES.map((item) => ({ caseId: item.id, caseFingerprint: qualityCaseFingerprint(item), rawResponse: '', inputTokens: null, outputTokens: null, requests: null, costCny: null, elapsedMs: null, hrReviewSeconds: null })),
    prompts: RECRUITMENT_QUALITY_CASES.map((item) => { const prompt = buildRecruitmentPrompt(item.input, item.input.redactedResume); return { caseId: item.id, promptHash: createHash('sha256').update(prompt).digest('hex'), prompt }; }) };
}
function selfCheck() {
  const fixture = recruitmentQualityTemplate(); fixture.runId = 'synthetic-self-check'; fixture.modelId = 'not-a-model';
  fixture.cases.forEach((row, index) => { row.rawResponse = qualityReferenceResponse(RECRUITMENT_QUALITY_CASES[index]); });
  const correct = evaluateRecruitmentQuality(fixture);
  const invented = structuredClone(fixture); const raw = JSON.parse(invented.cases[0].rawResponse);
  raw.dimensions[0].evidence = ['合成的编造引用，不存在于任何样本']; invented.cases[0].rawResponse = JSON.stringify(raw);
  const falseCitation = evaluateRecruitmentQuality(invented);
  const missing = structuredClone(fixture); missing.cases.pop(); const omitted = evaluateRecruitmentQuality(missing);
  const checks = [
    { id: 'reference_contract_parses', passed: correct.metrics.parsedCases.rate === 1 && correct.metrics.supportAccuracy.rate === 1 },
    { id: 'invented_citation_detected', passed: falseCitation.cases[0].issues.includes('citation_not_found') },
    { id: 'omitted_case_not_comparable', passed: omitted.missingCases === 1 && !compareRecruitmentQuality(correct, omitted).comparable },
  ];
  return { mode: 'synthetic_grader_self_check', suiteVersion: RECRUITMENT_QUALITY_SUITE, cases: fixture.cases.length, liveModelExecuted: false, productionReady: 'not_determined', checks,
    notice: '只自检评测器是否能发现已知错误。参照输出直接来自预先标注，不是模型评测结果，不能宣称准确率或招聘效果。' };
}
const usage = '用法：npm run recruitment:eval -- --self-check | --template | --input <本地结果.json> [--baseline <旧版结果.json>]\n只读离线评测，不读取模型凭据、不调用模型、不写文件。退出 0 仅表示处理完成，不代表质量达标；2 表示无效或不完整，3 表示同套件比较发现指标退步。';
export async function runRecruitmentQualityCli(args: string[], io: { read(file: string): Promise<string>; write(text: string): void } = { read: readLocalFile, write: console.log }): Promise<number> {
  if (!args.length || (args.length === 1 && args[0] === '--help')) { io.write(usage); return 0; }
  if (args.length === 1 && args[0] === '--template') { io.write(JSON.stringify(recruitmentQualityTemplate(), null, 2)); return 0; }
  if (args.length === 1 && args[0] === '--self-check') { const report = selfCheck(); io.write(JSON.stringify(report, null, 2)); return report.checks.every((item) => item.passed) ? 0 : 3; }
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--input', '--baseline'].includes(args[i]) || flags.has(args[i]) || !args[i + 1] || !localPath(args[i + 1])) { io.write(usage); return 2; }
    flags.set(args[i], args[i + 1]);
  }
  if (!flags.has('--input')) { io.write(usage); return 2; }
  try {
    const read = async (file: string) => { const text = await io.read(file); if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error(); return evaluateRecruitmentQuality(JSON.parse(text.replace(/^\uFEFF/u, '')) as unknown); };
    const report = await read(flags.get('--input')!);
    const baseline = flags.has('--baseline') ? await read(flags.get('--baseline')!) : null;
    const comparison = baseline ? compareRecruitmentQuality(baseline, report) : null;
    const incomplete = Boolean(report.missingCases || report.metrics.parsedCases.rate !== 1 || baseline && (baseline.missingCases || baseline.metrics.parsedCases.rate !== 1));
    io.write(JSON.stringify({ status: incomplete ? 'incomplete' : 'evaluated', report, ...(comparison ? { baseline, comparison } : {}) }, null, 2));
    return incomplete ? 2 : comparison?.regressions.length ? 3 : 0;
  } catch { io.write('无法评测：请核对本地 JSON、套件和样本指纹、重复条目、输出大小及用量字段；未回显文件路径或原始内容。'); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await runRecruitmentQualityCli(process.argv.slice(2));
