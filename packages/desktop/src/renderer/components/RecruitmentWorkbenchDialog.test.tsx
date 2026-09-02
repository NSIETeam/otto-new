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
  fireEvent.click(screen.getByRole('button', { name: '导入 PDF / DOCX 简历' }));
  await screen.findByText(/简历解析完成/);
}

describe('RecruitmentWorkbenchDialog', () => {
  it('requires candidate consent, isolates PII and shows evidence instead of an opaque score', async () => {
    renderDialog();
    fireEvent.change(screen.getByRole('textbox', { name: '岗位名称' }), {
      target: { value: '高级前端工程师' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '岗位要求' }), {
      target: { value: '必须熟练掌握 React 和 TypeScript\n熟悉 Rust' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导入 PDF / DOCX 简历' }));
    expect(screen.getByRole('alert').textContent).toContain('候选人');
    expect(window.otto.selectFiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: /已取得候选人/ }));
    fireEvent.click(screen.getByRole('button', { name: '导入 PDF / DOCX 简历' }));
    await screen.findByText(/简历解析完成/);
    expect(screen.getByText('身份信息已与能力分析隔离')).toBeTruthy();
    expect(document.body.textContent).not.toContain('13900139000');
    expect(document.body.textContent).not.toContain('liming@example.com');

    fireEvent.click(screen.getByRole('button', { name: '人员初步分析' }));
    expect(screen.getByText('无自动淘汰')).toBeTruthy();
    expect(screen.getByText(/第 5 行：使用 React 和 TypeScript/)).toBeTruthy();
    expect(screen.getByText(/没有找到可直接引用的简历原文/)).toBeTruthy();
  });

  it('requires explicit recruiter confirmation for a final decision', async () => {
    renderDialog();
    await importResume();
    fireEvent.click(screen.getByRole('button', { name: '人员初步分析' }));
    fireEvent.change(screen.getByRole('textbox', { name: '人工判断依据' }), {
      target: { value: '关键岗位证据需要下一轮继续核实' },
    });
    fireEvent.click(screen.getByRole('button', { name: '记录人工决定' }));
    expect(screen.getByRole('alert').textContent).toContain('人工确认');

    fireEvent.click(screen.getByRole('checkbox', { name: /我已人工复核/ }));
    fireEvent.click(screen.getByRole('button', { name: '记录人工决定' }));
    expect(screen.getByRole('status').textContent).toContain('人工决定已记录');
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
    expect(screen.getByText(/已解析 PDF 简历/)).toBeTruthy();
  });
});
