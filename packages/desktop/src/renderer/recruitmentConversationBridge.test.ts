/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  RecruitmentConversationDraftRegistry,
  handleRecruitmentConversation,
} from './recruitmentConversationBridge.js';
import { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';

const resume = `李明
电话：13900139000
邮箱：liming@example.com
2022-2026 星河科技 前端工程师
使用 React 和 TypeScript 开发企业系统
负责性能优化，最终首屏时间降低 30%`;

function harness() {
  const store = new RecruitmentWorkspaceStore();
  const registry = new RecruitmentConversationDraftRegistry();
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  const selectFiles = vi.fn()
    .mockResolvedValueOnce(['D:\\resume\\liming.pdf'])
    .mockResolvedValue(['D:\\resume\\interview.mp3']);
  const extractDocument = vi.fn(async () => ({
    filePath: 'D:\\resume\\liming.pdf', fileName: 'liming.pdf', sourceFormat: 'pdf', content: resume,
  }));
  const analyzeResume = vi.fn(async () => ({
    summary: '候选人有完整的企业前端与性能优化交付经验。',
    overallScore: 84, matchLevel: 'good' as const, evidenceCoverage: 80,
    dimensions: [
      { id: 'core_capability' as const, label: '核心能力', score: 88, assessment: '核心技术与岗位匹配', evidence: [{ line: 5, quote: '使用 React 和 TypeScript 开发企业系统' }], uncertainties: [] },
      { id: 'experience_depth' as const, label: '经验深度', score: 82, assessment: '连续相关经历', evidence: [{ line: 4, quote: '2022-2026 星河科技 前端工程师' }], uncertainties: [] },
      { id: 'delivery_impact' as const, label: '交付与结果', score: 86, assessment: '有量化结果', evidence: [{ line: 6, quote: '最终首屏时间降低 30%' }], uncertainties: [] },
      { id: 'role_scope' as const, label: '职责范围', score: 78, assessment: '负责性能优化', evidence: [{ line: 6, quote: '负责性能优化' }], uncertainties: ['团队范围待核实'] },
      { id: 'transferability' as const, label: '可迁移能力', score: 82, assessment: '企业应用经验可迁移', evidence: [{ line: 5, quote: '开发企业系统' }], uncertainties: [] },
    ],
    hardRequirements: [{ requirement: 'React 和 TypeScript', status: 'met' as const, explanation: '有项目证据', evidence: [{ line: 5, quote: '使用 React 和 TypeScript 开发企业系统' }] }],
    strengths: ['企业应用', '性能优化'], risks: ['团队范围未知'], missingInformation: ['团队规模'],
    interviewQuestions: [{ criterion: '性能优化', question: '请说明性能优化的指标基线和关键取舍。', rationale: '核实能力深度', followUps: ['如何验证？'], goodSignals: ['有指标和方法'], concernSignals: ['仅复述结果'] }],
    evidenceGraph: [
      { criterion: '前端交付', status: 'verified' as const, assessment: '有直接交付证据', evidence: [{ line: 5, quote: '使用 React 和 TypeScript 开发企业系统', source: 'resume' as const }], gaps: [], nextQuestion: '' },
      { criterion: '性能优化方法', status: 'partially_verified' as const, assessment: '缺少基线与验证方法', evidence: [{ line: 6, quote: '最终首屏时间降低 30%', source: 'resume' as const }], gaps: ['指标基线与验证方式'], nextQuestion: '请说明性能优化的指标基线和关键取舍。' },
    ],
    workSample: {
      title: '桌面端性能诊断任务', scenario: '诊断一个加载缓慢的桌面端页面。',
      timeboxMinutes: 90, deliverables: ['诊断说明'], constraints: ['不得使用客户数据'],
      rubric: [{ criterion: '问题定位', weight: 100, observableSignals: ['建立基线并验证'] }],
      followUpQuestions: ['为什么这样排序？'],
    },
    enterpriseContextUsed: true,
    analysisVersion: 'otto-recruitment-semantic-v3.0', modelProvider: 'test-model',
    inputTokens: 100, outputTokens: 80, createdAt: '2026-09-02T02:00:00.000Z',
  }));
  const transcribe = vi.fn(async () => ({
    model: 'large-v3', warning: undefined,
    segments: [
      { speaker: '面试官', startSeconds: 0, text: '请介绍项目' },
      { speaker: '候选人', startSeconds: 5, text: '当时项目很慢，我负责优化，最终首屏降低30%' },
    ],
  }));
  const loadEnterpriseContext = vi.fn(async () => '已发布企业记忆：桌面端改动必须说明异常恢复与测试方法。');
  return {
    store, registry, messages, selectFiles, extractDocument, analyzeResume, transcribe, loadEnterpriseContext,
    common: {
      text: '', sessionId: 'session-1', accountId: 'hr-1', enabled: true,
      store, registry, selectFiles, extractDocument, analyzeResume, transcribe,
      loadEnterpriseContext,
      postMessage: (role: 'user' | 'assistant', text: string) => messages.push({ role, text }),
      now: () => Date.parse('2026-09-02T10:00:00+08:00'),
    },
  };
}

async function importResume(h: ReturnType<typeof harness>): Promise<void> {
  await handleRecruitmentConversation({ ...h.common, text: '帮我分析一份简历' });
  await handleRecruitmentConversation({
    ...h.common,
    text: '岗位名称：高级前端工程师；岗位要求：必须熟练掌握 React 和 TypeScript；保存期限：30天；我确认已取得候选人授权',
  });
  await handleRecruitmentConversation({ ...h.common, text: '确认选择简历' });
}

describe('招聘对话共享桥', () => {
  it('在统一草稿中心展示招聘确认并拒绝过期卡片', async () => {
    const h = harness();
    await handleRecruitmentConversation({ ...h.common, text: '帮我分析一份简历' });
    expect(h.registry.summary('session-1', 'hr-1', h.store, h.common.now())).toMatchObject({
      source: 'recruitment', title: '候选人材料分析', phase: 'collecting',
      missingFields: ['岗位名称', '岗位要求', '明确确认已取得候选人授权'],
    });
    const currentId = h.registry.get('session-1', 'hr-1', h.common.now())!.id;
    await handleRecruitmentConversation({
      ...h.common, text: '确认选择简历', expectedDraftId: `${currentId}:stale`,
    });
    expect(h.selectFiles).not.toHaveBeenCalled();
    expect(h.messages.at(-1)?.text).toContain('已变化或过期');
  });

  it('文件选择在途时重复确认不会解除首个操作的并发锁', async () => {
    const h = harness();
    let finishSelection: ((paths: string[]) => void) | undefined;
    const selectFiles = vi.fn(() => new Promise<string[]>((resolve) => { finishSelection = resolve; }));
    const common = { ...h.common, selectFiles };
    await handleRecruitmentConversation({ ...common, text: '帮我分析一份简历' });
    await handleRecruitmentConversation({
      ...common,
      text: '岗位名称：高级前端工程师；岗位要求：熟练 React；保存期限：30天；我确认已取得候选人授权',
    });
    const first = handleRecruitmentConversation({ ...common, text: '确认选择简历' });
    await Promise.resolve();
    await handleRecruitmentConversation({ ...common, text: '确认选择简历' });
    expect(selectFiles).toHaveBeenCalledTimes(1);
    expect(h.messages.at(-1)?.text).toContain('正在进行');
    finishSelection?.([]);
    await first;
  });

  it('收集岗位、保存期限和明确授权后才允许选择简历', async () => {
    const h = harness();
    expect(await handleRecruitmentConversation({ ...h.common, text: '帮我分析一份简历' })).toBe(true);
    expect(h.messages.at(-1)?.text).toContain('岗位名称');
    expect(h.messages.at(-1)?.text).toContain('岗位要求');
    expect(h.messages.at(-1)?.text).toContain('候选人授权');
    expect(h.selectFiles).not.toHaveBeenCalled();

    await handleRecruitmentConversation({
      ...h.common,
      text: '岗位名称：高级前端工程师；岗位要求：必须熟练掌握 React 和 TypeScript；保存期限：30天；我确认已取得候选人授权',
    });
    expect(h.store.getSnapshot()).toMatchObject({
      jobTitle: '高级前端工程师', consentConfirmed: true, retentionDays: 30,
    });
    expect(h.messages.at(-1)?.text).toContain('确认候选人已授权并选择材料');
    expect(h.selectFiles).not.toHaveBeenCalled();
  });

  it('导入后右侧工作区与对话共享候选人，输出不泄露手机号邮箱', async () => {
    const h = harness();
    await importResume(h);
    expect(h.selectFiles).toHaveBeenCalledTimes(1);
    expect(h.store.getSnapshot().candidates).toHaveLength(1);
    expect(h.store.activeCandidate()?.analysis.findings.length).toBeGreaterThan(0);
    const output = h.messages.at(-1)?.text ?? '';
    expect(output).toContain('候选人档案已生成');
    expect(output).not.toContain('13900139000');
    expect(output).not.toContain('liming@example.com');
  });

  it('人员初步分析只展示证据状态，不自动给出淘汰决定', async () => {
    const h = harness();
    await importResume(h);
    await handleRecruitmentConversation({ ...h.common, text: '查看候选人人员初步分析' });
    const output = h.messages.at(-1)?.text ?? '';
    expect(output).toContain('原文证据');
    expect(output).toContain('最终招聘决定必须由招聘人员作出');
    expect(output).not.toContain('自动淘汰');
  });

  it('面试材料可直接从共享候选人生成', async () => {
    const h = harness();
    await importResume(h);
    await handleRecruitmentConversation({ ...h.common, text: '生成这个候选人的面试材料' });
    expect(h.messages.at(-1)?.text).toContain('结构化面试问题');
    expect(h.messages.at(-1)?.text).toContain('评价规则');
  });

  it('在对话中提供证据图谱、动态下一题和岗位实战任务', async () => {
    const h = harness();
    await importResume(h);
    expect(h.analyzeResume).toHaveBeenCalledWith(expect.objectContaining({
      enterpriseContext: expect.stringContaining('异常恢复与测试方法'),
    }));

    await handleRecruitmentConversation({ ...h.common, text: '查看候选人的岗位证据图谱' });
    expect(h.messages.at(-1)?.text).toContain('性能优化方法｜部分验证');
    expect(h.messages.at(-1)?.text).toContain('简历第 6 行');

    await handleRecruitmentConversation({ ...h.common, text: '下一步最值得问什么' });
    expect(h.messages.at(-1)?.text).toContain('请说明性能优化的指标基线和关键取舍');

    await handleRecruitmentConversation({ ...h.common, text: '生成岗位实战任务' });
    expect(h.messages.at(-1)?.text).toContain('桌面端性能诊断任务');
    expect(h.messages.at(-1)?.text).toContain('建立基线并验证');
  });

  it('音频分析需确认选择文件，并只分析回答内容', async () => {
    const h = harness();
    await importResume(h);
    await handleRecruitmentConversation({ ...h.common, text: '分析这个候选人的面试录音' });
    expect(h.messages.at(-1)?.text).toContain('确认选择面试录音');
    expect(h.transcribe).not.toHaveBeenCalled();
    await handleRecruitmentConversation({ ...h.common, text: '确认选择面试录音' });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.store.activeCandidate()?.transcriptReport).toBeTruthy();
    expect(h.messages.at(-1)?.text).toContain('不分析口音、音高、表情或情绪');
  });

  it('隐私审计可查询，删除当前候选人材料需要强确认', async () => {
    const h = harness();
    await importResume(h);
    await handleRecruitmentConversation({ ...h.common, text: '查看招聘隐私与审计' });
    expect(h.messages.at(-1)?.text).toContain('保存期限 30 天');
    await handleRecruitmentConversation({ ...h.common, text: '删除当前候选人材料' });
    expect(h.store.getSnapshot().candidates).toHaveLength(1);
    expect(h.messages.at(-1)?.text).toContain('确认删除候选人材料');
    await handleRecruitmentConversation({ ...h.common, text: '确认删除候选人材料' });
    expect(h.store.getSnapshot().candidates).toHaveLength(0);
    expect(h.store.getSnapshot().audits[0]?.action).toBe('candidate_purged');
  });

  it('功能介绍、普通聊天和无候选人的误触不会启动外部文件选择', async () => {
    const h = harness();
    for (const text of ['介绍一下简历分析功能', '今天天气如何']) {
      expect(await handleRecruitmentConversation({ ...h.common, text })).toBe(false);
    }
    expect(h.selectFiles).not.toHaveBeenCalled();
  });

  it('直接理解自然语言招聘目标，并能只用面试视频建立候选人档案', async () => {
    const h = harness();
    h.selectFiles.mockReset();
    h.selectFiles.mockResolvedValue(['D:\\video\\frontend-candidate.mp4']);

    await handleRecruitmentConversation({
      ...h.common,
      text: '我要招一名高级前端工程师，重点看复杂项目和性能优化能力，帮我分析这个视频',
    });
    expect(h.store.getSnapshot()).toMatchObject({
      jobTitle: '高级前端工程师',
      jobDescription: expect.stringContaining('复杂项目和性能优化能力'),
      consentConfirmed: false,
    });
    expect(h.registry.summary('session-1', 'hr-1', h.store, h.common.now())).toMatchObject({
      phase: 'collecting',
      missingFields: ['明确确认已取得候选人授权'],
    });
    expect(h.messages.at(-1)?.text).toContain('只需补充：明确确认已取得候选人授权');

    await handleRecruitmentConversation({
      ...h.common,
      text: '确认候选人已授权并选择材料',
    });
    expect(h.selectFiles).toHaveBeenCalledTimes(1);
    expect(h.extractDocument).not.toHaveBeenCalled();
    expect(h.analyzeResume).toHaveBeenCalledWith(expect.objectContaining({
      jobTitle: '高级前端工程师',
      redactedResume: expect.stringContaining('未提供简历'),
      interviewTranscript: expect.stringContaining('[00:05] 候选人'),
    }));
    expect(h.store.activeCandidate()).toMatchObject({
      semanticMaterials: 'interview',
      transcriptText: expect.stringContaining('[00:05] 候选人'),
    });
    expect(h.messages.at(-1)?.text).toContain('候选人档案已生成');
    expect(h.messages.at(-1)?.text).toContain('未提供的履历信息已标为待核实');
  });
});
