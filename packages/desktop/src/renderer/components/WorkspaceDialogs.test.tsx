import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AutoSkillDialog,
  CustomAgentManagerDialog,
  EnterpriseMemoryDialog,
} from './WorkspaceDialogs.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

beforeEach(() => {
  Object.assign(window.otto, {
    enterpriseKnowledgeList: vi.fn(async () => []),
    enterpriseKnowledgeRecord: vi.fn(async () => ({ status: 'added', added: true })),
    enterpriseKnowledgeRevise: vi.fn(async () => ({ status: 'updated' })),
    enterpriseKnowledgeRevalidate: vi.fn(async () => ({ status: 'active' })),
    enterpriseKnowledgeReview: vi.fn(async () => ({ status: 'approved' })),
    enterpriseKnowledgeDelete: vi.fn(async (id: string) => ({ id, deleted: true as const })),
    enterpriseKnowledgeAnalyze: vi.fn(async (input) => ({
      shouldUpdate: false,
      title: input.title,
      category: input.category,
      content: input.content,
      confidence: input.confidence,
      rationale: '当前内容已经准确概括现有证据。',
      changes: [],
      uncertainties: [],
      usedEvidenceIds: [],
      analysisVersion: 'test',
      modelProvider: 'test-model',
      inputTokens: 0,
      outputTokens: 0,
    })),
    enterpriseKnowledgeRevisions: vi.fn(async () => []),
    enterpriseKnowledgeEvidence: vi.fn(async () => []),
    workLogRecent: vi.fn(async () => []),
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('WorkspaceDialogs', () => {
  it('关闭再打开后，旧范围的企业记忆响应不能覆盖新结果', async () => {
    const oldRequest = deferred<Awaited<ReturnType<typeof window.otto.enterpriseKnowledgeList>>>();
    const newRequest = deferred<Awaited<ReturnType<typeof window.otto.enterpriseKnowledgeList>>>();
    const list = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    Object.assign(window.otto, { enterpriseKnowledgeList: list });
    const props = { role: 'company_admin' as const, onClose: vi.fn() };
    const view = render(<EnterpriseMemoryDialog open {...props} />);
    view.rerender(<EnterpriseMemoryDialog open={false} {...props} />);
    view.rerender(<EnterpriseMemoryDialog open {...props} />);

    newRequest.resolve([{
      id: 'new', title: '新组织制度', category: '制度', content: '只显示新结果',
      organizationId: 'org-new', sourceId: null, department: null, contributor: null,
      confidence: 0.9, createdAt: '2026-08-27T00:00:00.000Z', status: 'active',
    }]);
    await screen.findByText('新组织制度');
    oldRequest.resolve([{
      id: 'old', title: '旧组织制度', category: '制度', content: '不得回填',
      organizationId: 'org-old', sourceId: null, department: null, contributor: null,
      confidence: 0.9, createdAt: '2026-08-26T00:00:00.000Z', status: 'active',
    }]);
    await Promise.resolve();
    expect(screen.queryByText('旧组织制度')).toBeNull();
  });

  it('企业记忆直接解释自动学习和自动调用，不再要求用户手动沉淀最近成果', async () => {
    render(<EnterpriseMemoryDialog open role="company_admin" onClose={vi.fn()} />);

    await screen.findByText('Otto 正在学习这家企业怎样工作');
    expect(screen.getByText(/完成对话和工作后，Otto 会自动识别/)).toBeTruthy();
    expect(screen.getByText(/已经确认的记忆会在相关问题中自动调用/)).toBeTruthy();
    expect(screen.queryByText('最近成果候选')).toBeNull();
    expect(screen.queryByRole('button', { name: '沉淀' })).toBeNull();
    expect(window.otto.workLogRecent).not.toHaveBeenCalled();
  });

  it('企业知识保留部门、证据、来源和完整记忆沿革', async () => {
    Object.assign(window.otto, {
      enterpriseKnowledgeList: vi.fn(async () => [{
        id: 'knowledge-1', organizationId: 'org-a', sourceId: 'source-1',
        sourceLabel: '项目复盘', sourceType: 'work_result', title: '交付规范',
        department: '客户成功部', category: '流程', content: '先审核再交付',
        contributor: '小周', confidence: 0.92, status: 'active', version: 2,
        evidenceCount: 3, distinctSessionCount: 2, distinctContributorCount: 2,
        lastObservedAt: '2026-08-27T08:00:00.000Z', createdAt: '2026-08-26T00:00:00.000Z',
      }]),
      enterpriseKnowledgeRevisions: vi.fn(async () => [{
        id: 'revision-1', knowledgeId: 'knowledge-1', version: 1, title: '交付规范',
        category: '流程', content: '初版流程', status: 'active', changedBy: '管理员',
        changeNote: '形成知识', createdAt: '2026-08-26T00:00:00.000Z',
      }]),
    });
    render(<EnterpriseMemoryDialog open role="company_admin" onClose={vi.fn()} />);

    await screen.findByText('交付规范');
    expect(screen.getByText('客户成功部')).toBeTruthy();
    expect(screen.getByText('已被 3 次工作验证')).toBeTruthy();
    expect(screen.getByText(/遇到相关问题时，Otto 会自动参考/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '如何变得更准确' }));
    await screen.findByText('初版流程');
    expect(screen.getByText(/管理员 · 形成知识/)).toBeTruthy();
  });

  it('杨锦航新版企业记忆界面保留生命周期展示和管理员复核', async () => {
    Object.assign(window.otto, {
      enterpriseKnowledgeList: vi.fn(async () => [{
        id: 'knowledge-lifecycle', organizationId: 'org-a', sourceId: 'manual-1',
        sourceLabel: '管理员录入', sourceType: 'manual', title: '合同审批规则',
        department: '法务部', category: '制度', content: '合同签署前必须完成法务复核。',
        contributor: '管理员', confidence: 0.98, status: 'active', version: 3,
        reviewDueAt: '2026-09-30T00:00:00.000Z', expiresAt: '2027-08-27T00:00:00.000Z',
        createdAt: '2026-08-20T00:00:00.000Z',
      }]),
    });
    render(<EnterpriseMemoryDialog open role="company_admin" onClose={vi.fn()} />);

    await screen.findByText('合同审批规则');
    expect(screen.getByText(/复核日期/)).toBeTruthy();
    expect(screen.getByText(/有效期至/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '仍然有效' }));
    fireEvent.change(screen.getByRole('textbox', { name: '复核依据' }), {
      target: { value: '已核对最新合同制度原文并由法务负责人确认有效' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '知识有效期' }), {
      target: { value: '180' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认复核' }));

    await waitFor(() => expect(window.otto.enterpriseKnowledgeRevalidate).toHaveBeenCalledWith(
      'knowledge-lifecycle',
      { rationale: '已核对最新合同制度原文并由法务负责人确认有效', validForDays: 180 },
    ));
  });

  it('管理员可以让 AI 结合新增证据深化记忆，检查后再形成新版本', async () => {
    Object.assign(window.otto, {
      enterpriseKnowledgeList: vi.fn(async () => [{
        id: 'knowledge-ai', organizationId: 'org-a', sourceId: 'auto-1',
        sourceType: 'auto_capture', title: '客户交付规则', department: '客户成功部',
        category: '流程', content: '交付前需要检查。', contributor: null,
        confidence: 0.78, status: 'active', version: 2, evidenceCount: 2,
        createdAt: '2026-08-20T00:00:00.000Z',
      }]),
      enterpriseKnowledgeEvidence: vi.fn(async () => [{
        id: 'evidence-ai', knowledgeId: 'knowledge-ai', sourceId: 'session-1',
        content: '客户验收前必须完成安全扫描并留存报告。', tags: ['交付'], contributor: '项目经理',
        confidence: 0.96, verified: true, impactScore: 0.9, impactReasons: ['重复验证'],
        observedAt: '2026-09-01T08:00:00.000Z', stance: 'affirmative', contested: false,
      }]),
      enterpriseKnowledgeAnalyze: vi.fn(async () => ({
        shouldUpdate: true,
        title: '客户交付前安全检查规则',
        category: '交付流程',
        content: '客户验收前必须完成安全扫描，并留存扫描报告。',
        confidence: 0.94,
        rationale: '新增证据补全了检查项目和留痕要求。',
        changes: ['明确安全扫描', '补充报告留存'],
        uncertainties: ['未明确报告保管期限'],
        usedEvidenceIds: ['evidence-ai'],
        analysisVersion: 'test',
        modelProvider: 'test-model',
        inputTokens: 30,
        outputTokens: 20,
      })),
    });
    render(<EnterpriseMemoryDialog open role="company_admin" onClose={vi.fn()} />);

    await screen.findByText('客户交付规则');
    fireEvent.click(screen.getByRole('button', { name: 'AI 深化' }));
    await screen.findByText('新增证据补全了检查项目和留痕要求。');
    expect(screen.getByDisplayValue('客户验收前必须完成安全扫描，并留存扫描报告。')).toBeTruthy();
    expect(window.otto.enterpriseKnowledgeRevise).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '应用并形成新版本' }));

    await waitFor(() => expect(window.otto.enterpriseKnowledgeRevise).toHaveBeenCalledWith(
      'knowledge-ai',
      expect.objectContaining({
        title: '客户交付前安全检查规则',
        category: '交付流程',
        content: '客户验收前必须完成安全扫描，并留存扫描报告。',
        confidence: 0.94,
        changeNote: expect.stringContaining('管理员确认 AI 深化建议'),
      }),
    ));
  });

  it('企业管理员确认后可以永久删除记忆及其学习依据', async () => {
    Object.assign(window.otto, {
      enterpriseKnowledgeList: vi.fn(async () => [{
        id: 'knowledge-delete', organizationId: 'org-a', sourceId: 'auto-delete',
        sourceType: 'auto_capture', title: '已废止制度', department: null,
        category: '制度', content: '这条制度已经废止。', contributor: null,
        confidence: 0.88, status: 'active', version: 1, evidenceCount: 1,
        createdAt: '2026-08-20T00:00:00.000Z',
      }]),
    });
    render(<EnterpriseMemoryDialog open role="company_admin" onClose={vi.fn()} />);

    await screen.findByText('已废止制度');
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));

    await waitFor(() => expect(window.otto.enterpriseKnowledgeDelete).toHaveBeenCalledWith('knowledge-delete'));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('无法撤销'));
    await waitFor(() => expect(screen.queryByText('已废止制度')).toBeNull());
  });

  it('冲突知识必须在新版界面完成证据取舍后才可形成裁决版本', async () => {
    Object.assign(window.otto, {
      enterpriseKnowledgeList: vi.fn(async () => [{
        id: 'knowledge-conflict', organizationId: 'org-a', sourceId: 'auto-1',
        sourceLabel: '自动提炼 · 证据存在冲突', sourceType: 'auto_capture', title: '退款审批规则',
        department: '财务部', category: '流程', content: '退款审批规则存在冲突，等待管理员判断。',
        contributor: null, confidence: 0.74, status: 'pending_review', version: 1,
        evidenceCount: 2, createdAt: '2026-08-27T00:00:00.000Z',
      }]),
      enterpriseKnowledgeEvidence: vi.fn(async () => [{
        id: 'evidence-accept', knowledgeId: 'knowledge-conflict', sourceId: 'session-1',
        content: '最新版制度要求财务经理审批。', tags: ['正式制度'], contributor: '财务主管',
        confidence: 0.96, verified: true, impactScore: 0.9, impactReasons: ['多人确认'],
        observedAt: '2026-08-27T08:00:00.000Z', stance: 'affirmative', contested: true,
      }, {
        id: 'evidence-reject', knowledgeId: 'knowledge-conflict', sourceId: 'session-2',
        content: '旧流程称无需财务经理审批。', tags: ['旧流程'], contributor: '历史会话',
        confidence: 0.61, verified: false, impactScore: 0.5, impactReasons: [],
        observedAt: '2026-08-20T08:00:00.000Z', stance: 'negative', contested: true,
      }]),
    });
    render(<EnterpriseMemoryDialog open role="company_admin" onClose={vi.fn()} />);

    await screen.findByText('退款审批规则');
    expect((screen.getByRole('button', { name: '先裁决冲突' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '查看学习依据' }));
    await screen.findByText('最新版制度要求财务经理审批。');
    fireEvent.click(screen.getAllByRole('button', { name: '采纳' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: '排除' })[1]);
    fireEvent.change(screen.getByRole('textbox', { name: '裁决依据' }), {
      target: { value: '以最新版正式制度和财务负责人书面确认为准' },
    });
    await waitFor(() => expect(
      (screen.getByRole('button', { name: '审查并裁决' }) as HTMLButtonElement).disabled,
    ).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '审查并裁决' }));
    fireEvent.click(screen.getByRole('button', { name: '保存裁决版本' }));

    await waitFor(() => expect(window.otto.enterpriseKnowledgeRevise).toHaveBeenCalledWith(
      'knowledge-conflict',
      expect.objectContaining({
        resolveConflict: true,
        adjudication: {
          acceptedEvidenceIds: ['evidence-accept'],
          rejectedEvidenceIds: ['evidence-reject'],
          rationale: '以最新版正式制度和财务负责人书面确认为准',
        },
      }),
    ));
  });

  it('有未保存的企业知识草稿时，关闭前需要确认', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const onClose = vi.fn();
    render(<EnterpriseMemoryDialog open role="company_admin" onClose={onClose} />);
    await screen.findByText('暂无企业知识。');
    fireEvent.click(screen.getByRole('button', { name: '手动补充' }));
    fireEvent.change(screen.getByRole('textbox', { name: '知识标题' }), {
      target: { value: '尚未保存的制度' },
    });
    fireEvent.click(screen.getByRole('button', { name: '关闭企业记忆' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('尚未保存的制度')).toBeTruthy();
  });

  it('Skill 草稿弹窗保留确认安装、拒绝和分析动作', () => {
    const onRefresh = vi.fn(); const onConfirm = vi.fn(); const onReject = vi.fn();
    render(<AutoSkillDialog open candidates={[{
      id: 'candidate-1', name: '周报生成', description: '自动整理周报',
      detectedPattern: '重复周报', occurrenceCount: 3, reason: '存在稳定重复流程', recommendation: 'create',
    }]} lastAction={null} onRefresh={onRefresh} onConfirm={onConfirm} onReject={onReject} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '立即分析' }));
    fireEvent.click(screen.getByRole('button', { name: '确认安装' }));
    fireEvent.click(screen.getByRole('button', { name: '拒绝草稿' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('candidate-1');
    expect(onReject).toHaveBeenCalledWith('candidate-1');
  });

  it('脚本型 Skill 安装前展示文件、权限、风险和禁执行说明', () => {
    render(<AutoSkillDialog open candidates={[{
      id: 'candidate-script', name: 'report-exporter', description: '导出结构化报告',
      detectedPattern: '用户主动要求沉淀报告导出流程', occurrenceCount: 1,
      reason: '主动需求', recommendation: 'create', source: 'proactive',
      draft: {
        validationPassed: true,
        validationErrors: [],
        validationWarnings: [],
        packageReady: true,
        packageRelativePath: 'skill-drafts/pending/candidate-script/report-exporter.otto-skill',
        tests: [{ name: '脚本行为测试', status: 'needs-review', detail: '未执行脚本' }],
        risk: {
          scriptFiles: ['scripts/export.py'],
          permissions: ['写入或删除本地文件'],
          fileChanges: ['新增 skills/report-exporter/scripts/export.py'],
          securityRisks: ['脚本可能修改用户文件'],
          executionBlocked: true,
        },
      },
    }]} lastAction={null} onRefresh={vi.fn()} onConfirm={vi.fn()} onReject={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText(/检查通过，等待确认/)).toBeTruthy();
    expect(screen.getByText(/生成、打包和安装均不会执行/)).toBeTruthy();
    fireEvent.click(screen.getByText('文件变更（1）'));
    fireEvent.click(screen.getByText('权限（1）'));
    fireEvent.click(screen.getByText('安全风险（1）'));
    expect(screen.getByText('新增 skills/report-exporter/scripts/export.py')).toBeTruthy();
    expect(screen.getByText('写入或删除本地文件')).toBeTruthy();
    expect(screen.getByText('脚本可能修改用户文件')).toBeTruthy();
  });

  it('自定义专家草稿在关闭后清空', async () => {
    const props = {
      agents: [], onGenerate: vi.fn(), onCreate: vi.fn(), onDelete: vi.fn(), onUpdateIcon: vi.fn(), onClose: vi.fn(),
    };
    const view = render(<CustomAgentManagerDialog open {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: '专家名称' }), { target: { value: '未保存草稿' } });
    view.rerender(<CustomAgentManagerDialog open={false} {...props} />);
    view.rerender(<CustomAgentManagerDialog open {...props} />);
    await waitFor(() => expect((screen.getByRole('textbox', { name: '专家名称' }) as HTMLInputElement).value).toBe(''));
  });

  it('输入一句需求后生成专家并直接加入我的专家', async () => {
    const onGenerate = vi.fn().mockResolvedValue(undefined);
    render(<CustomAgentManagerDialog
      open
      agents={[]}
      onGenerate={onGenerate}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onUpdateIcon={vi.fn()}
      onClose={vi.fn()}
    />);

    fireEvent.change(screen.getByRole('textbox', { name: '一句话专家需求' }), {
      target: { value: '帮我审查合同风险并给出修改建议' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成并加入我的专家' }));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledWith('帮我审查合同风险并给出修改建议'));
    expect((await screen.findByRole('status')).textContent).toContain('已生成并加入“我的专家”');
    expect((screen.getByRole('textbox', { name: '一句话专家需求' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('自动生成失败时保留需求并显示真实错误', async () => {
    const onGenerate = vi.fn().mockRejectedValue(new Error('当前没有可用模型'));
    render(<CustomAgentManagerDialog
      open
      agents={[]}
      onGenerate={onGenerate}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onUpdateIcon={vi.fn()}
      onClose={vi.fn()}
    />);

    const input = screen.getByRole('textbox', { name: '一句话专家需求' });
    fireEvent.change(input, { target: { value: '生成周报专家' } });
    fireEvent.click(screen.getByRole('button', { name: '生成并加入我的专家' }));

    expect((await screen.findByRole('alert')).textContent).toContain('当前没有可用模型');
    expect((input as HTMLTextAreaElement).value).toBe('生成周报专家');
  });

  it('创建专家时可以从 30 个预置图标中选择模块头像', async () => {
    const onCreate = vi.fn();
    render(<CustomAgentManagerDialog
      open
      agents={[]}
      onGenerate={vi.fn()}
      onCreate={onCreate}
      onDelete={vi.fn()}
      onUpdateIcon={vi.fn()}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '选择模块图标' }));
    expect(screen.getAllByRole('button', { name: /^选择图标：/ })).toHaveLength(30);
    fireEvent.click(screen.getByRole('button', { name: '选择图标：客户成功' }));
    await waitFor(() => expect(
      screen.queryByRole('region', { name: '模块图标选择器' }),
    ).toBeNull());
    fireEvent.change(screen.getByRole('textbox', { name: '专家名称' }), {
      target: { value: '续费助手' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '职责说明' }), {
      target: { value: '跟进客户续费风险。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建专家' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      name: '续费助手',
      instructions: '跟进客户续费风险。',
      icon: { kind: 'preset', name: 'agent-customer-success' },
    }));
  });

  it('已有专家可以更换图标，并提供本地图片上传入口', async () => {
    const onUpdateIcon = vi.fn();
    render(<CustomAgentManagerDialog
      open
      agents={[{
        id: 'custom-bid',
        name: '招投标助手',
        instructions: '整理投标材料。',
        createdAt: '2026-08-27T00:00:00.000Z',
      }]}
      onGenerate={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onUpdateIcon={onUpdateIcon}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '更换招投标助手的图标' }));
    fireEvent.click(screen.getByRole('button', { name: '选择图标：财务分析' }));
    await waitFor(() => expect(onUpdateIcon).toHaveBeenCalledWith(
      'custom-bid',
      { kind: 'preset', name: 'agent-finance-analysis' },
    ));
    await waitFor(() => expect(
      screen.queryByRole('region', { name: '模块图标选择器' }),
    ).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '更换招投标助手的图标' }));
    fireEvent.click(screen.getByRole('tab', { name: '上传图片' }));
    expect(screen.getByLabelText('选择本地图片')).toBeTruthy();
  });

  it('已有专家可在我的专家中确认后永久删除', () => {
    const onDelete = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CustomAgentManagerDialog
      open
      agents={[{
        id: 'custom-bid',
        name: '招投标助手',
        instructions: '整理投标材料。',
        createdAt: '2026-08-27T00:00:00.000Z',
      }]}
      onGenerate={vi.fn()}
      onCreate={vi.fn()}
      onDelete={onDelete}
      onUpdateIcon={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(screen.getByText('删除后，该专家会同时从所有功能组移除。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除专家 招投标助手' }));

    expect(onDelete).toHaveBeenCalledWith('custom-bid');
  });

  it('图标选择面板可以明确关闭，且不会修改当前图标', () => {
    const onUpdateIcon = vi.fn();
    render(<CustomAgentManagerDialog
      open
      agents={[{
        id: 'custom-bid',
        name: '招投标助手',
        instructions: '整理投标材料。',
        createdAt: '2026-08-27T00:00:00.000Z',
      }]}
      onGenerate={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onUpdateIcon={onUpdateIcon}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '更换招投标助手的图标' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭图标选择器' }));

    expect(screen.queryByRole('region', { name: '模块图标选择器' })).toBeNull();
    expect(onUpdateIcon).not.toHaveBeenCalled();
  });

  it('更换图标保存失败时保留选择器并显示错误', async () => {
    render(<CustomAgentManagerDialog
      open
      agents={[{
        id: 'custom-risk',
        name: '风险助手',
        instructions: '识别风险。',
        createdAt: '2026-08-27T00:00:00.000Z',
      }]}
      onGenerate={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onUpdateIcon={() => { throw new Error('本机存储不可用，专家未保存'); }}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '更换风险助手的图标' }));
    fireEvent.click(screen.getByRole('button', { name: '选择图标：经营管理' }));

    expect((await screen.findByRole('alert')).textContent).toContain('本机存储不可用，专家未保存');
    expect(screen.getByRole('region', { name: '模块图标选择器' })).toBeTruthy();
  });
});
