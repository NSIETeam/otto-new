import { describe, expect, it } from 'vitest';

import {
  analyzeCandidateResume,
  analyzeInterviewTranscript,
  buildInterviewRecord,
  createHumanHiringDecision,
  generateInterviewKit,
} from './recruitmentAnalysis.js';

const resume = `张三
电话：13800138000
邮箱：zhangsan@example.com
性别：男
2022-2026 星河科技 前端工程师
负责 React、TypeScript 企业工作台开发
项目：将首屏加载时间降低 35%，带领 4 人完成交付`;

const jobDescription = `必须熟练掌握 React 和 TypeScript
要求 3 年以上前端开发经验
有团队协作和项目交付经验优先
熟悉 Rust`;

describe('recruitment evidence analysis', () => {
  it('isolates identity fields and produces evidence, gaps and verification questions without a score', () => {
    const analysis = analyzeCandidateResume({
      candidateId: 'candidate-1',
      resumeText: resume,
      jobDescription,
      now: '2026-08-29T08:00:00.000Z',
    });

    expect(analysis.identity).toMatchObject({
      name: '张三',
      phone: '13800138000',
      email: 'zhangsan@example.com',
      gender: '男',
    });
    expect(analysis.redactedResume).not.toContain('13800138000');
    expect(analysis.redactedResume).not.toContain('zhangsan@example.com');
    expect(analysis.redactedResume).not.toContain('性别：男');
    expect(analysis.findings.some((finding) => (
      finding.status === 'supported'
      && finding.evidence.some((evidence) => evidence.quote.includes('React'))
    ))).toBe(true);
    expect(analysis.findings.some((finding) => (
      finding.criterion.includes('Rust') && finding.status === 'missing'
    ))).toBe(true);
    expect(analysis.questions.some((question) => question.includes('Rust'))).toBe(true);
    expect(analysis.experiences).toContain('2022-2026 星河科技 前端工程师');
    expect(analysis.projects.some((project) => project.includes('首屏加载时间'))).toBe(true);
    expect(analysis.timeline).toContain('2022-2026');
    expect('score' in analysis).toBe(false);
  });

  it('generates structured interview questions from weak and missing evidence', () => {
    const analysis = analyzeCandidateResume({
      candidateId: 'candidate-1', resumeText: resume, jobDescription,
    });
    const kit = generateInterviewKit(analysis);

    expect(kit.questions.length).toBeGreaterThan(0);
    expect(kit.questions.some((question) => question.rubric.includes('可核验'))).toBe(true);
    expect(kit.questions.some((question) => question.followUps.length > 0)).toBe(true);
  });

  it('analyzes timestamped transcript content and STAR evidence without emotion or personality labels', () => {
    const transcript = `[00:00:04] 面试官：请介绍一次项目交付。
[00:00:11] 候选人：当时首屏很慢，我负责性能优化。我先做了指标基线，再拆包和缓存，最终加载时间降低 35%。
[00:01:20] 候选人：这个项目有 12 人。`;
    const report = analyzeInterviewTranscript({
      transcript,
      redactedResume: resume,
      jobDescription: '必须掌握性能优化\n熟悉 Rust',
    });

    expect(report.segments[1]).toMatchObject({ speaker: '候选人', startSeconds: 11 });
    expect(report.starEvidence.some((item) => item.result)).toBe(true);
    expect(report.inconsistencies.some((item) => item.includes('12'))).toBe(true);
    expect(report.knowledgeEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ criterion: '必须掌握性能优化', status: 'supported' }),
      expect.objectContaining({ criterion: '熟悉 Rust', status: 'missing' }),
    ]));
    expect(report.contentNotice).toContain('仅分析回答内容和证据');
    expect(Object.keys(report)).not.toEqual(expect.arrayContaining([
      'emotion', 'personality', 'accent', 'confidencePersonality',
    ]));
  });

  it('flags internally conflicting numeric claims as questions, not automatic conclusions', () => {
    const report = analyzeInterviewTranscript({
      transcript: `[00:10] 候选人：这个项目团队有 8 人。\n[00:30] 候选人：这个项目团队有 12 人。`,
      redactedResume: '项目：负责团队交付',
      jobDescription: '有团队协作经验',
    });

    expect(report.inconsistencies.some((item) => (
      item.includes('团队') && item.includes('8') && item.includes('12')
    ))).toBe(true);
    expect(report.inconsistencies.every((item) => item.includes('人工核实'))).toBe(true);
  });

  it('builds an interview record with transcript evidence and no automatic hiring conclusion', () => {
    const analysis = analyzeCandidateResume({
      candidateId: 'candidate-1', resumeText: resume, jobDescription,
    });
    const transcriptReport = analyzeInterviewTranscript({
      transcript: '[00:11] 候选人：我负责 React 性能优化，最终首屏降低 35%。',
      redactedResume: analysis.redactedResume,
      jobDescription,
    });
    const record = buildInterviewRecord({
      jobTitle: '高级前端工程师',
      candidate: analysis,
      transcript: transcriptReport,
      reviewerNotes: '待复核 Rust 项目经验',
    });

    expect(record).toContain('# 面试记录');
    expect(record).toContain('[00:11]');
    expect(record).toContain('岗位知识证据');
    expect(record).toContain('待复核 Rust 项目经验');
    expect(record).toContain('不包含自动录用、淘汰或排序结论');
  });

  it('requires explicit human confirmation and rationale for the final hiring decision', () => {
    expect(() => createHumanHiringDecision({
      candidateId: 'candidate-1', reviewerId: 'hr-1', decision: 'reject',
      rationale: '岗位关键证据不足', confirmed: false,
    })).toThrow('人工确认');

    expect(createHumanHiringDecision({
      candidateId: 'candidate-1', reviewerId: 'hr-1', decision: 'hold',
      rationale: '需要补充核实 Rust 项目经验', confirmed: true,
      now: '2026-08-29T09:00:00.000Z',
    })).toMatchObject({
      actorType: 'human', decision: 'hold', modelVersion: null,
    });
  });
});
