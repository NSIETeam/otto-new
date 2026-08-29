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

  it('企业记忆保留最近工作成果候选，并按成果来源沉淀', async () => {
    Object.assign(window.otto, {
      workLogRecent: vi.fn(async () => [{
        date: '2026-08-27',
        entries: [{
          time: '10:30', category: '文档', action: '完成客户方案', success: true,
          details: '交付最终版', entryType: 'work_result', taskTitle: '客户方案定稿',
        }],
      }]),
    });
    render(<EnterpriseMemoryDialog open role="company_admin" onClose={vi.fn()} />);

    await screen.findByText('客户方案定稿');
    fireEvent.click(screen.getByRole('button', { name: '沉淀' }));

    await waitFor(() => expect(window.otto.enterpriseKnowledgeRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'work_result',
        title: '客户方案定稿',
        content: '客户方案定稿\n交付最终版',
      }),
    ));
    await waitFor(() => expect(
      (screen.getByRole('button', { name: '沉淀' }) as HTMLButtonElement).disabled,
    ).toBe(false));
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
    expect(screen.getByText('3 条证据')).toBeTruthy();
    expect(screen.getByText('来源：项目复盘')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '记忆沿革' }));
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
    fireEvent.click(screen.getByRole('button', { name: '复核有效' }));
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
    fireEvent.click(screen.getByRole('button', { name: '证据' }));
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
    fireEvent.click(screen.getByRole('button', { name: '新增知识' }));
    fireEvent.change(screen.getByRole('textbox', { name: '知识标题' }), {
      target: { value: '尚未保存的制度' },
    });
    fireEvent.click(screen.getByRole('button', { name: '关闭企业记忆' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('尚未保存的制度')).toBeTruthy();
  });

  it('自动 Skill 弹窗保留确认、拒绝和分析动作', () => {
    const onRefresh = vi.fn(); const onConfirm = vi.fn(); const onReject = vi.fn();
    render(<AutoSkillDialog open candidates={[{
      id: 'candidate-1', name: '周报生成', description: '自动整理周报',
      detectedPattern: '重复周报', occurrenceCount: 3, reason: '存在稳定重复流程', recommendation: 'create',
    }]} lastAction={null} onRefresh={onRefresh} onConfirm={onConfirm} onReject={onReject} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '立即分析' }));
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    fireEvent.click(screen.getByRole('button', { name: '不再建议' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('candidate-1');
    expect(onReject).toHaveBeenCalledWith('candidate-1');
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
