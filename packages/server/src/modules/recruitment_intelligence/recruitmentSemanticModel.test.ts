import { describe, expect, it } from 'vitest';
import { buildRecruitmentPrompt, parseRecruitmentSemanticAnalysis, sanitizeRecruitmentModelInput } from './recruitmentSemanticModel.js';
import { RECRUITMENT_SEMANTIC_DIMENSIONS } from './recruitmentSemantic.js';

describe('shared recruitment analysis contract', () => {
  it('describes the actual material scope without contradicting work samples or inventing a resume for interview-only input', () => {
    const resume = '参与订单页面开发';
    const prompt = buildRecruitmentPrompt({ candidateId: 'test', jobTitle: '前端', jobDescription: '自动化测试', redactedResume: resume, workSampleArtifact: '编写了四个测试用例及复现说明' }, resume);
    expect(prompt).toContain('本次实际提供的材料：简历、实战成果');
    expect(prompt).not.toContain('本次只包含简历');
    expect(prompt).toContain('本次未提供面试转写');
    const interview = buildRecruitmentPrompt({ candidateId: 'test', jobTitle: '前端', jobDescription: '自动化测试', redactedResume: '无简历占位符', resumeProvided: false, interviewTranscript: '我负责测试工具开发' }, '无简历占位符');
    expect(interview).toContain('本次实际提供的材料：面试转写');
    expect(interview).not.toContain('脱敏简历全文 JSON');
    expect(interview).not.toContain('请把简历与面试回答');
    expect(interview).not.toContain('无简历占位符');
  });
  it('uses the desktop evidence and privacy rules on the server too', () => {
    const resume = sanitizeRecruitmentModelInput('姓名：张三\n手机：13800138000\nReact 企业系统交付。');
    const input = { candidateId: 'private-id', jobTitle: '前端', jobDescription: 'React', redactedResume: resume };
    const prompt = buildRecruitmentPrompt(input, resume);
    expect(prompt).not.toContain('13800138000'); expect(prompt).not.toContain('private-id');
    expect(prompt).toContain('不得输出录用/淘汰决定');
    const result = parseRecruitmentSemanticAnalysis(JSON.stringify({ summary: '仅为材料支持', dimensions: RECRUITMENT_SEMANTIC_DIMENSIONS.map((item) => ({ id: item.id, score: 90, assessment: '有经历', evidence: ['编造的原文'], uncertainties: [] })), hardRequirements: [{ requirement: 'React', status: 'not_met', evidence: [] }] }), resume, { modelProvider: 'fixture', inputTokens: 1, outputTokens: 1 });
    expect(result.evidenceCoverage).toBe(0); expect(result.hardRequirements[0].status).toBe('unclear');
    expect(result.dimensions.every((item) => item.evidence.length === 0)).toBe(true);
  });
});
