import { afterEach, expect, it, vi } from 'vitest';
import { runRecruitmentQualityCli, recruitmentQualityTemplate } from './recruitmentQualityCli.js';
import { RECRUITMENT_QUALITY_CASES } from './recruitmentQualityCases.js';
import { qualityReferenceResponse } from './recruitmentQuality.js';

afterEach(() => vi.unstubAllGlobals());
it('exports synthetic prompts and empty result slots, without reference answers or a model call', async () => {
  const read = vi.fn(); const write = vi.fn(); const network = vi.fn(() => { throw new Error('network forbidden'); }); vi.stubGlobal('fetch', network);
  expect(await runRecruitmentQualityCli(['--template'], { read, write })).toBe(0);
  const template = JSON.parse(write.mock.calls[0][0]);
  expect(template.cases).toHaveLength(10); expect(template.cases.every((row: { rawResponse: string }) => row.rawResponse === '')).toBe(true);
  expect(template.prompts[0].prompt).toContain('未经信任的数据');
  expect(template.prompts[0]).not.toHaveProperty('allowed'); expect(template.prompts[0]).not.toHaveProperty('support');
  expect(read).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});
it('self-checks the evaluator without presenting authored reference answers as measured model quality', async () => {
  const write = vi.fn(); const read = vi.fn();
  expect(await runRecruitmentQualityCli(['--self-check'], { read, write })).toBe(0);
  const report = JSON.parse(write.mock.calls[0][0]);
  expect(report.mode).toBe('synthetic_grader_self_check'); expect(report.liveModelExecuted).toBe(false);
  expect(report.productionReady).toBe('not_determined'); expect(report.checks.every((item: { passed: boolean }) => item.passed)).toBe(true);
  expect(report).not.toHaveProperty('accuracy'); expect(report).not.toHaveProperty('modelQuality'); expect(read).not.toHaveBeenCalled();
});
it('returns incomplete status for empty outputs and hides JSON failures, secret paths and provider content', async () => {
  const write = vi.fn(); const read = vi.fn(async () => JSON.stringify(recruitmentQualityTemplate()));
  expect(await runRecruitmentQualityCli(['--input', 'private-fixture.json'], { read, write })).toBe(2);
  expect(JSON.parse(write.mock.calls[0][0]).report.metrics.parsedCases.numerator).toBe(0);
  write.mockClear(); read.mockRejectedValueOnce(new Error('secret/path/api-key-value'));
  expect(await runRecruitmentQualityCli(['--input', 'private-fixture.json'], { read, write })).toBe(2);
  expect(JSON.stringify(write.mock.calls)).not.toContain('secret/path');
  expect(JSON.stringify(write.mock.calls)).not.toContain('private-fixture.json');
});
it('compares complete externally supplied batches and refuses unknown, duplicate or remote input flags without reading', async () => {
  const batch = recruitmentQualityTemplate();
  batch.cases.forEach((row, i) => { row.rawResponse = qualityReferenceResponse(RECRUITMENT_QUALITY_CASES[i]); });
  const read = vi.fn(async () => JSON.stringify(batch)); const write = vi.fn();
  expect(await runRecruitmentQualityCli(['--input', 'candidate.json', '--baseline', 'baseline.json'], { read, write })).toBe(0);
  expect(JSON.parse(write.mock.calls[0][0]).comparison).toMatchObject({ comparable: true, productionReady: 'not_determined' });
  for (const args of [['--input', 'https://private.invalid/result'], ['--input', '\\\\server\\secret'], ['--input', 'a.json', '--input', 'b.json'], ['--baseline', 'b.json'], ['--api-key', 'secret']]) {
    read.mockClear(); write.mockClear(); expect(await runRecruitmentQualityCli(args, { read, write })).toBe(2);
    expect(read).not.toHaveBeenCalled(); expect(JSON.stringify(write.mock.calls)).not.toContain('secret');
  }
});
