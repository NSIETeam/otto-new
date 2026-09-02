import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RecruitmentWorkbenchDialog } from './RecruitmentWorkbenchDialog.js';
import { RecruitmentWorkspaceStore } from '../recruitmentWorkspaceStore.js';

const resumeText = `李明
电话：13900139000
邮箱：liming@example.com
2022-2026 星河科技 前端工程师
使用 React 和 TypeScript 开发企业系统
负责性能优化，最终首屏时间降低 30%`;

beforeEach(() => {
  Object.assign(window.otto, {
    selectFiles: vi.fn(async () => ['D:\\resume\\liming.pdf']),
    extractEditableDocument: vi.fn(async () => ({
      filePath: 'D:\\resume\\liming.pdf',
      fileName: 'liming.pdf',
      sourceFormat: 'pdf' as const,
      editableFormat: 'markdown' as const,
      content: resumeText,
      readonly: false,
      message: '已提取',
    })),
    recruitmentTranscribe: vi.fn(async () => ({
      backend: 'whisperx' as const,
      model: 'large-v3',
      language: 'zh',
      diarized: true,
      segments: [
        { speaker: '面试官', startSeconds: 1, endSeconds: 4, text: '请介绍项目。' },
        { speaker: '候选人', startSeconds: 5, endSeconds: 16, text: '当时系统很慢，我负责优化，最终首屏降低 30%。' },
      ],
    })),
    enterpriseKnowledgeList: vi.fn(async () => [{
      id: 'knowledge-1', organizationId: 'org-1', sourceId: 'manual-1',
      title: '前端交付规范', department: '研发部', category: '工程规范',
      content: '桌面端功能必须说明异常恢复和测试方法。', contributor: 'admin',
      confidence: 0.95, status: 'active' as const, createdAt: '2026-09-01T00:00:00.000Z',
    }]),
    recruitmentAnalyzeResume: vi.fn(async () => ({
      summary: '候选人具备企业前端和性能优化经验，技术背景与岗位较为贴合。',
      overallScore: 84, matchLevel: 'good' as const, evidenceCoverage: 80,
      dimensions: [
        { id: 'core_capability' as const, label: '核心能力', score: 88, assessment: '核心技术与岗位匹配', evidence: [{ line: 5, quote: '使用 React 和 TypeScript 开发企业系统' }], uncertainties: [] },
        { id: 'experience_depth' as const, label: '经验深度', score: 82, assessment: '有连续相关经历', evidence: [{ line: 4, quote: '2022-2026 星河科技 前端工程师' }], uncertainties: [] },
        { id: 'delivery_impact' as const, label: '交付与结果', score: 86, assessment: '有量化交付结果', evidence: [{ line: 6, quote: '最终首屏时间降低 30%' }], uncertainties: [] },
        { id: 'role_scope' as const, label: '职责范围', score: 78, assessment: '说明了本人职责', evidence: [{ line: 6, quote: '负责性能优化' }], uncertainties: ['团队边界待核实'] },
        { id: 'transferability' as const, label: '可迁移能力', score: 82, assessment: '企业系统经验可迁移', evidence: [{ line: 5, quote: '开发企业系统' }], uncertainties: [] },
      ],
      hardRequirements: [
        { requirement: '掌握 React 和 TypeScript', status: 'met' as const, explanation: '有直接项目实践', evidence: [{ line: 5, quote: '使用 React 和 TypeScript 开发企业系统' }] },
        { requirement: '熟悉 Rust', status: 'not_demonstrated' as const, explanation: '全文尚未提供证据', evidence: [] },
      ],
      strengths: ['企业应用交付', '性能优化'], risks: ['团队范围未知'], missingInformation: ['复杂系统规模'],
      interviewQuestions: [{ criterion: '性能优化', question: '请说明性能指标基线与关键取舍。', rationale: '核实能力深度', followUps: ['如何验证结果？'], goodSignals: ['能说明指标与方法'], concernSignals: ['只复述团队结果'] }],
      evidenceGraph: [
        { criterion: 'React 与 TypeScript 交付', status: 'verified' as const, assessment: '简历有直接交付证据', evidence: [{ line: 5, quote: '使用 React 和 TypeScript 开发企业系统', source: 'resume' as const }], gaps: [], nextQuestion: '' },
        { criterion: '性能优化方法', status: 'partially_verified' as const, assessment: '有结果但缺少基线和验证方法', evidence: [{ line: 6, quote: '最终首屏时间降低 30%', source: 'resume' as const }], gaps: ['性能基线和验证方式'], nextQuestion: '请说明性能指标基线与关键取舍。' },
      ],
      workSample: {
        title: '企业桌面端性能诊断任务', scenario: '分析一个首屏加载缓慢的桌面端页面，并给出可验证改进。',
        timeboxMinutes: 90, deliverables: ['诊断说明', '改进方案'], constraints: ['不使用真实客户数据'],
        rubric: [{ criterion: '问题定位', weight: 50, observableSignals: ['建立可复现基线'] }],
        followUpQuestions: ['为什么优先处理这个瓶颈？'],
      },
      enterpriseContextUsed: true,
      analysisVersion: 'otto-recruitment-semantic-v3.0', modelProvider: 'test-model',
      inputTokens: 100, outputTokens: 80, createdAt: '2026-09-02T02:00:00.000Z',
    })),
    saveTextFile: vi.fn(async () => 'D:\\reports\\report.md'),
  });
});

function renderDialog(target: React.ComponentProps<typeof RecruitmentWorkbenchDialog>['target'] = 'resume-analysis') {
  return render(
    <RecruitmentWorkbenchDialog
      open
      target={target}
      reviewerId="hr-1"
      organizationName="星河科技"
      enterpriseMemoryEnabled
      workspaceStore={new RecruitmentWorkspaceStore()}
      onClose={vi.fn()}
    />,
  );
}

async function importResume(): Promise<void> {
  fireEvent.change(screen.getByRole('textbox', { name: '招聘目标' }), {
    target: { value: '我要招一名高级前端工程师，必须熟练掌握 React 和 TypeScript，熟悉 Rust' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /已取得本次所选候选人/ }));
  fireEvent.click(screen.getByRole('button', { name: '选择简历或面试视频，开始分析' }));
  await screen.findByText(/已导入 \d+ 份简历/);
}

describe('RecruitmentWorkbenchDialog', () => {
  it('requires candidate consent, isolates PII and shows full-text semantic evidence', async () => {
    renderDialog();
    expect(screen.getByText('一句话加一份材料就够了')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '智能招聘功能' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '招聘目标' }), {
      target: { value: '我要招一名高级前端工程师，必须熟练掌握 React 和 TypeScript，熟悉 Rust' },
    });
    fireEvent.click(screen.getByRole('button', { name: '选择简历或面试视频，开始分析' }));
    expect(screen.getByRole('alert').textContent).toContain('候选人');
    expect(window.otto.selectFiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: /已取得本次所选候选人/ }));
    fireEvent.click(screen.getByRole('button', { name: '选择简历或面试视频，开始分析' }));
    await screen.findByText(/已导入 1 份简历/);
    expect(document.body.textContent).not.toContain('13900139000');
    expect(document.body.textContent).not.toContain('liming@example.com');

    expect(screen.getByText('简历全文结论')).toBeTruthy();
    expect(screen.getAllByText('84').length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole('button', { name: '查看原文证据' }));
    expect(screen.getAllByText(/第 5 行：使用 React 和 TypeScript/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('全文尚未证明')).toBeTruthy();
  });

  it('requires explicit recruiter confirmation for a final decision', async () => {
    renderDialog();
    await importResume();
    fireEvent.click(screen.getByRole('button', { name: '记录人工结论' }));
    fireEvent.change(screen.getByRole('textbox', { name: '人工判断依据' }), {
      target: { value: '关键岗位证据需要下一轮继续核实' },
    });
    fireEvent.click(screen.getByRole('button', { name: '记录人工决定' }));
    expect(screen.getByRole('alert').textContent).toContain('人工确认');

    fireEvent.click(screen.getByRole('checkbox', { name: /我已人工复核/ }));
    fireEvent.click(screen.getByRole('button', { name: '记录人工决定' }));
    expect(screen.getByRole('status').textContent).toContain('人工决定已记录');
  });

  it('analyzes every resume in a batch and compares candidates without exposing contact details', async () => {
    Object.assign(window.otto, {
      selectFiles: vi.fn(async () => [
        'D:\\resume\\liming.pdf',
        'D:\\resume\\wangfang.docx',
      ]),
      extractEditableDocument: vi.fn(async (filePath: string) => ({
        filePath,
        fileName: filePath.endsWith('.pdf') ? 'liming.pdf' : 'wangfang.docx',
        sourceFormat: filePath.endsWith('.pdf') ? 'pdf' as const : 'docx' as const,
        editableFormat: 'markdown' as const,
        content: filePath.endsWith('.pdf')
          ? resumeText
          : '王芳\n手机：13800138000\n邮箱：wangfang@example.com\n负责企业管理系统交付并降低接口延迟 25%',
        readonly: false,
        message: '已提取',
      })),
    });
    renderDialog();
    await importResume();

    expect(window.otto.recruitmentAnalyzeResume).toHaveBeenCalledTimes(2);
    for (const [input] of vi.mocked(window.otto.recruitmentAnalyzeResume).mock.calls) {
      expect(input.redactedResume).not.toMatch(/13900139000|13800138000|liming@example\.com|wangfang@example\.com/);
    }
    fireEvent.click(screen.getByRole('button', { name: '比较 2 位候选人' }));
    expect(screen.getByText('候选人横向比较')).toBeTruthy();
    expect(screen.getByText('统一岗位口径，保持导入顺序，不自动排名')).toBeTruthy();
  });

  it('keeps a failed resume available for retry and never substitutes keyword scoring', async () => {
    Object.assign(window.otto, {
      recruitmentAnalyzeResume: vi.fn(async () => {
        throw new Error('模型服务暂不可用');
      }),
    });
    renderDialog();
    await importResume();
    expect(screen.getByText(/1 份可重试/)).toBeTruthy();

    expect(screen.getByText('Otto 暂时没有完成这份材料的智能分析')).toBeTruthy();
    expect(screen.getByText('模型服务暂不可用')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新分析' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('关键词命中率');
  });

  it('uses WhisperX segments for timestamped content analysis and exposes privacy audit', async () => {
    renderDialog();
    await importResume();
    Object.assign(window.otto, {
      selectFiles: vi.fn(async () => ['D:\\audio\\interview.wav']),
    });
    fireEvent.click(screen.getByRole('button', { name: '加入面试录音或视频' }));

    await waitFor(() => expect(window.otto.recruitmentTranscribe)
      .toHaveBeenCalledWith('D:\\audio\\interview.wav'));
    await screen.findByText(/已把面试回答与简历全文联合分析/);
    expect(window.otto.recruitmentAnalyzeResume).toHaveBeenLastCalledWith(expect.objectContaining({
      interviewTranscript: expect.stringContaining('[00:05] 候选人'),
    }));
    expect(screen.getByText('简历 + 面试联合结论')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '完整面试方案' }));
    expect((screen.getByRole('textbox', { name: '面试转写' }) as HTMLTextAreaElement).value)
      .toContain('[00:05] 候选人');
    expect(screen.getByText('面试已与简历联合分析')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: '面试人员备注' }), {
      target: { value: '待复核项目中的个人贡献' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导出完整面试记录' }));
    await waitFor(() => expect(window.otto.saveTextFile).toHaveBeenCalledWith(
      expect.stringContaining('面试记录.md'),
      expect.stringContaining('待复核项目中的个人贡献'),
    ));

    fireEvent.click(screen.getByRole('button', { name: '资料与隐私' }));
    expect(screen.getByText('敏感属性不参与评价')).toBeTruthy();
    expect(screen.getByText(/WhisperX 完成/)).toBeTruthy();
    expect(screen.getByText(/模型已阅读脱敏简历全文/)).toBeTruthy();
  });

  it('connects enterprise evidence, dynamic follow-up and work-sample results in one dossier', async () => {
    renderDialog('evidence-graph');
    await importResume();

    fireEvent.click(screen.getByRole('button', { name: '岗位证据图谱' }));
    expect(screen.getByText('岗位—候选人证据图谱')).toBeTruthy();
    expect(screen.getByText(/已结合企业记忆/)).toBeTruthy();
    expect(screen.getByText('性能优化方法')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '动态面试追问' }));
    expect(screen.getByText('现在最值得问')).toBeTruthy();
    expect(screen.getAllByText('请说明性能指标基线与关键取舍。').length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole('button', { name: '岗位实战验证' }));
    expect(screen.getByText('企业桌面端性能诊断任务')).toBeTruthy();
    expect(screen.getByText('建立可复现基线')).toBeTruthy();

    Object.assign(window.otto, {
      selectFiles: vi.fn(async () => ['D:\\work-sample\\submission.md']),
      extractEditableDocument: vi.fn(async () => ({
        filePath: 'D:\\work-sample\\submission.md', fileName: 'submission.md',
        sourceFormat: 'markdown' as const, editableFormat: 'markdown' as const,
        content: '先记录首屏性能基线，再逐项验证资源加载和渲染耗时。',
        readonly: false, message: '已提取',
      })),
    });
    fireEvent.click(screen.getByRole('button', { name: '加入候选人实战成果' }));
    await screen.findByText(/岗位实战成果已加入候选人证据图谱/);
    expect(window.otto.recruitmentAnalyzeResume).toHaveBeenLastCalledWith(expect.objectContaining({
      workSampleArtifact: expect.stringContaining('记录首屏性能基线'),
      enterpriseContext: expect.stringContaining('桌面端功能必须说明异常恢复'),
    }));
  });

  it('can create a candidate dossier directly from an interview video without a resume', async () => {
    Object.assign(window.otto, {
      selectFiles: vi.fn(async () => ['D:\\video\\candidate-interview.mp4']),
    });
    renderDialog();
    fireEvent.change(screen.getByRole('textbox', { name: '招聘目标' }), {
      target: { value: '我要招一名高级前端工程师，重点看复杂项目和性能优化能力' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /已取得本次所选候选人/ }));
    fireEvent.click(screen.getByRole('button', { name: '选择简历或面试视频，开始分析' }));

    await screen.findByText(/已从面试材料建立候选人档案/);
    expect(window.otto.extractEditableDocument).not.toHaveBeenCalled();
    expect(window.otto.recruitmentAnalyzeResume).toHaveBeenCalledWith(expect.objectContaining({
      jobTitle: '高级前端工程师',
      redactedResume: expect.stringContaining('未提供简历'),
      interviewTranscript: expect.stringContaining('[00:05] 候选人'),
    }));
    expect(screen.getByText('面试材料结论')).toBeTruthy();
    expect(screen.getByText('面试材料已分析')).toBeTruthy();
  });
});
