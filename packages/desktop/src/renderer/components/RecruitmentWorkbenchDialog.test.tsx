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
      analysisVersion: 'otto-recruitment-semantic-v2.0', modelProvider: 'test-model',
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
      workspaceStore={new RecruitmentWorkspaceStore()}
      onClose={vi.fn()}
    />,
  );
}

async function importResume(): Promise<void> {
  fireEvent.change(screen.getByRole('textbox', { name: '岗位名称' }), {
    target: { value: '高级前端工程师' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '岗位要求' }), {
    target: { value: '必须熟练掌握 React 和 TypeScript\n熟悉 Rust' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /已取得候选人/ }));
  fireEvent.click(screen.getByRole('button', { name: '批量导入并智能分析简历' }));
  await screen.findByText(/已导入 \d+ 份简历/);
}

describe('RecruitmentWorkbenchDialog', () => {
  it('requires candidate consent, isolates PII and shows full-text semantic evidence', async () => {
    renderDialog();
    fireEvent.change(screen.getByRole('textbox', { name: '岗位名称' }), {
      target: { value: '高级前端工程师' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '岗位要求' }), {
      target: { value: '必须熟练掌握 React 和 TypeScript\n熟悉 Rust' },
    });
    fireEvent.click(screen.getByRole('button', { name: '批量导入并智能分析简历' }));
    expect(screen.getByRole('alert').textContent).toContain('候选人');
    expect(window.otto.selectFiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: /已取得候选人/ }));
    fireEvent.click(screen.getByRole('button', { name: '批量导入并智能分析简历' }));
    await screen.findByText(/已导入 1 份简历/);
    expect(screen.getByText('身份信息已与模型评价输入隔离')).toBeTruthy();
    expect(document.body.textContent).not.toContain('13900139000');
    expect(document.body.textContent).not.toContain('liming@example.com');

    fireEvent.click(screen.getByRole('button', { name: '综合评估' }));
    expect(screen.getByText('全文综合判断')).toBeTruthy();
    expect(screen.getAllByText('84').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/第 5 行：使用 React 和 TypeScript/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('全文尚未证明')).toBeTruthy();
  });

  it('requires explicit recruiter confirmation for a final decision', async () => {
    renderDialog();
    await importResume();
    fireEvent.click(screen.getByRole('button', { name: '综合评估' }));
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
    fireEvent.click(screen.getByRole('button', { name: '综合评估' }));
    expect(screen.getByText('候选人横向对比')).toBeTruthy();
    expect(screen.getByText('2 人')).toBeTruthy();
    expect(screen.getByText('保持导入顺序，不自动排名')).toBeTruthy();
  });

  it('keeps a failed resume available for retry and never substitutes keyword scoring', async () => {
    Object.assign(window.otto, {
      recruitmentAnalyzeResume: vi.fn(async () => {
        throw new Error('模型服务暂不可用');
      }),
    });
    renderDialog();
    await importResume();
    expect(screen.getByText(/1 份可稍后重试/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '综合评估' }));
    expect(screen.getByText('全文智能分析尚未完成')).toBeTruthy();
    expect(screen.getByText('模型服务暂不可用')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试全文分析' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('关键词命中率');
  });

  it('uses WhisperX segments for timestamped content analysis and exposes privacy audit', async () => {
    renderDialog();
    await importResume();
    Object.assign(window.otto, {
      selectFiles: vi.fn(async () => ['D:\\audio\\interview.wav']),
    });
    fireEvent.click(screen.getByRole('button', { name: '音频面试分析' }));
    fireEvent.click(screen.getByRole('button', { name: '选择面试录音' }));

    await waitFor(() => expect(window.otto.recruitmentTranscribe)
      .toHaveBeenCalledWith('D:\\audio\\interview.wav'));
    await screen.findByText(/面试转写与内容分析完成/);
    expect((screen.getByRole('textbox', { name: '面试转写' }) as HTMLTextAreaElement).value)
      .toContain('[00:05] 候选人');
    expect(screen.getByText('仅分析回答内容')).toBeTruthy();
    expect(screen.getByText('岗位知识证据')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '面试材料' }));
    fireEvent.change(screen.getByRole('textbox', { name: '面试人员备注' }), {
      target: { value: '待复核项目中的个人贡献' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导出面试记录' }));
    await waitFor(() => expect(window.otto.saveTextFile).toHaveBeenCalledWith(
      expect.stringContaining('面试记录.md'),
      expect.stringContaining('待复核项目中的个人贡献'),
    ));

    fireEvent.click(screen.getByRole('button', { name: '隐私与审计' }));
    expect(screen.getByText('敏感属性不参与评价')).toBeTruthy();
    expect(screen.getByText(/WhisperX 转写完成/)).toBeTruthy();
    expect(screen.getByText(/whisperx\/large-v3/)).toBeTruthy();
    expect(screen.getByText(/模型已阅读脱敏简历全文/)).toBeTruthy();
  });
});
