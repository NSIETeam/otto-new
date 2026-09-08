import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RecruitmentIntakePanel } from './RecruitmentIntakePanel.js';
import { RecruitmentWorkspaceStore } from '../recruitmentWorkspaceStore.js';
import { updateRecruitmentIntake } from '../recruitmentArchive.js';
import { recruitmentArchiveFingerprint } from '../recruitmentArchiveMerge.js';
import type { RecruitmentIncomingMaterial, RecruitmentJobResponse, RecruitmentSharedJob } from 'otto-server';

function setup(canManage = true) {
  const store = new RecruitmentWorkspaceStore('org:hr'); store.setJobTitle('前端'); store.setJobDescription('React');
  const sync = { scopeToken: 'a'.repeat(64), headerToken: 'b'.repeat(64), candidateTokens: {} };
  const job: RecruitmentSharedJob = { id: 'job', title: '前端', description: 'React', candidates: [], revision: 1, ownerAccountId: 'hr', collaboratorAccountIds: [], updatedBy: 'hr', updatedAt: new Date().toISOString() };
  store.setSharedJob({ id: job.id, base: job, revision: job.revision, canManage, sync, savedFingerprint: recruitmentArchiveFingerprint(store.getSnapshot()) });
  const call = vi.fn(async (): Promise<RecruitmentJobResponse> => ({ kind: 'job', job: { ...job, revision: 2 }, sync, canManage }));
  Object.assign(window.otto, { enterpriseRecruitmentJobs: call });
  return { store, call, job, sync };
}
describe('recruitment intake controls and archive response boundary', () => {
  it('lets a collaborator confirm one server resume and the saved job requirements without enabling background or switching desktop models', async () => {
    const h = setup(false); const item = claimedItem(); delete item.manualAnalysis;
    item.material.material.fileName = '待分析简历';
    h.job.incomingMaterials = [item];
    h.job.backgroundAnalysis = { enabled: false, generation: 'g', actorAccountId: 'owner', confirmedAt: new Date().toISOString(), ...h.sync, modelVersion: 'model-v1', modelId: 'enterprise-model', dailyRequestLimit: 2, dailyReservedTokenLimit: 100_000, message: '未开启', usage: [] };
    h.store.setSharedJob({ ...h.store.getSnapshot().sharedJob!, base: h.job });
    h.store.setJobDescription('本地尚未保存的岗位要求');
    h.store.setConsentConfirmed(true);
    const onImport = vi.fn();
    render(<RecruitmentIntakePanel store={h.store} scopeId="org:hr" disabled={false} onImport={onImport} />);
    fireEvent.click(screen.getByText(/后台接收简历 ·/));
    const article = within(screen.getByText(/待分析简历 ·/).closest('article')!);
    fireEvent.click(article.getByText('用企业模型分析这一份'));
    const button = article.getByRole('button', { name: '只分析这一份（企业模型）' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(article.getByText('服务器已保存岗位：前端')).toBeTruthy();
    expect(article.getByText('React')).toBeTruthy();
    expect(article.getByText(/不会使用尚未保存的本地岗位修改/)).toBeTruthy();
    fireEvent.click(article.getByLabelText(/我确认本份简历可发送给/)); fireEvent.click(button);
    await waitFor(() => expect(h.call).toHaveBeenCalledWith({ scopeId: 'org:hr', action: { kind: 'analyze_intake_once', jobId: 'job', itemId: item.id, expectedRevision: 1, scopeToken: h.sync.scopeToken, headerToken: h.sync.headerToken, modelVersion: 'model-v1', confirmed: true } }));
    expect(h.call).toHaveBeenCalledOnce(); expect(onImport).not.toHaveBeenCalled();
  });
  it('requires separate auto-archive consent and sends a finite retention window', async () => {
    const h = setup(); render(<RecruitmentIntakePanel store={h.store} scopeId="org:hr" disabled={false} onImport={vi.fn()} />);
    fireEvent.click(screen.getByText(/后台接收简历 ·/));
    const button = screen.getByRole('button', { name: '开启 / 更新自动入档' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我确认有权后台读取/));
    fireEvent.click(screen.getByLabelText(/接受模型费用/)); expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我授权将已完成的后台结果自动/));
    fireEvent.change(screen.getByLabelText('自动入档授权与新档案保存窗口'), { target: { value: '7' } });
    fireEvent.click(button);
    await waitFor(() => expect(h.call).toHaveBeenCalledWith({ scopeId: 'org:hr', action: { kind: 'configure_auto_archive', jobId: 'job', expectedRevision: 1, enabled: true, confirmed: true, retentionDays: 7 } }));
  });
  it('shows the automatic filing receipt without offering duplicate import', () => {
    const h = setup(); const item = claimedItem(); delete item.manualAnalysis;
    item.archive = { status: 'created', at: new Date().toISOString(), candidateId: 'candidate', message: '后台已创建正式档案' };
    h.job.incomingMaterials = [item]; h.store.setConsentConfirmed(true);
    h.store.setSharedJob({ ...h.store.getSnapshot().sharedJob!, base: h.job });
    const onImport = vi.fn(); render(<RecruitmentIntakePanel store={h.store} scopeId="org:hr" disabled={false} onImport={onImport} />);
    fireEvent.click(screen.getByText(/后台接收简历 ·/));
    expect(screen.getByText(/后台已创建正式档案/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '导入工作台并分析' })).toBeNull();
    expect(onImport).not.toHaveBeenCalled();
  });
  function claimedItem(): RecruitmentIncomingMaterial {
    const now = Date.now();
    return { id: 'c'.repeat(64), receivedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(),
      material: { runId: 'run', requisitionId: 'job', canonicalId: 'person', source: { sourceId: 'workable', sourceLabel: 'Workable', sourceRecordId: 'person' }, acquisitionMode: 'authorized_mcp', contentHash: 'd'.repeat(64), retrievedAt: new Date(now).toISOString(), material: { sourceRecordId: 'person', text: 'React 应用项目经历与单元测试开发', completeness: 'full_text' } },
      manualAnalysis: { id: 'claim', requestId: 'request', candidateId: 'candidate', actorAccountId: 'other-hr', status: 'started', createdAt: new Date(now - 300_000).toISOString(), expiresAt: new Date(now - 1_000).toISOString(), scopeToken: 'a'.repeat(64), headerToken: 'b'.repeat(64), message: '原客户端正在分析' } };
  }
  it('blocks duplicate manual imports and requires a separate cost acknowledgement before resetting an expired claim', async () => {
    const h = setup(); const item = claimedItem(); h.job.incomingMaterials = [item]; h.store.setConsentConfirmed(true);
    h.store.setSharedJob({ ...h.store.getSnapshot().sharedJob!, base: h.job });
    const onImport = vi.fn(); render(<RecruitmentIntakePanel store={h.store} scopeId="org:hr" disabled={false} onImport={onImport} />);
    fireEvent.click(screen.getByText(/后台接收简历 ·/));
    expect(screen.getByText(/处理截止时间已过/)).toBeTruthy();
    const importButton = screen.getByRole('button', { name: '已由同事认领，请刷新档案' }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true); fireEvent.click(importButton); expect(onImport).not.toHaveBeenCalled();
    const reset = screen.getByRole('button', { name: '确认重新处理' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true); fireEvent.click(screen.getByLabelText(/我确认有权后台读取/)); expect(reset.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我已核对原客户端与厂商用量/)); fireEvent.click(reset);
    await waitFor(() => expect(h.call).toHaveBeenCalledWith({ scopeId: 'org:hr', action: { kind: 'reset_intake_analysis', jobId: 'job', itemId: item.id, claimId: 'claim', scopeToken: h.sync.scopeToken, headerToken: h.sync.headerToken, confirmed: true } }));
  });
  it('hides claim reset from collaborators and rejects malformed claim status from another client', async () => {
    const h = setup(false); const item = claimedItem(); h.job.incomingMaterials = [item]; h.store.setSharedJob({ ...h.store.getSnapshot().sharedJob!, base: h.job });
    render(<RecruitmentIntakePanel store={h.store} scopeId="org:hr" disabled={false} onImport={vi.fn()} />); fireEvent.click(screen.getByText(/后台接收简历 ·/));
    expect(screen.queryByRole('button', { name: '确认重新处理' })).toBeNull();
    h.call.mockResolvedValueOnce({ kind: 'job', canManage: false, sync: h.sync, job: { ...h.job, incomingMaterials: [{ ...item, manualAnalysis: { ...item.manualAnalysis!, status: 'unrecognized' } }] } } as unknown as RecruitmentJobResponse);
    await expect(updateRecruitmentIntake(h.store, h.call, { kind: 'get', jobId: 'job' })).rejects.toThrow('待处理材料');
  });
  it('requires separate paid-analysis consent and sends the explicit daily caps', async () => {
    const h = setup(); render(<RecruitmentIntakePanel store={h.store} scopeId="org:hr" disabled={false} onImport={vi.fn()} />);
    fireEvent.click(screen.getByText(/后台接收简历 ·/));
    const button = screen.getByRole('button', { name: '开启 / 更新后台分析' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(screen.getByLabelText(/我确认有权后台读取/)); expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/接受模型费用/));
    fireEvent.change(screen.getByLabelText('每天最多调用次数'), { target: { value: '2' } });
    fireEvent.click(button);
    await waitFor(() => expect(h.call).toHaveBeenCalledWith({ scopeId: 'org:hr', action: expect.objectContaining({ kind: 'configure_background_analysis', enabled: true, confirmed: true, dailyRequestLimit: 2, dailyReservedTokenLimit: 100000 }) }));
  });
  it('requires explicit background sharing consent and resets it when the job changes', async () => {
    const h = setup(); render(<RecruitmentIntakePanel store={h.store} scopeId="org:hr" disabled={false} onImport={vi.fn()} />);
    fireEvent.click(screen.getByText(/后台接收简历 ·/));
    expect((screen.getByRole('button', { name: '开启 / 更新后台接收' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我确认有权后台读取/));
    fireEvent.click(screen.getByRole('button', { name: '开启 / 更新后台接收' }));
    await waitFor(() => expect(h.call).toHaveBeenCalledWith({ scopeId: 'org:hr', action: expect.objectContaining({ kind: 'configure_intake', expectedRevision: 1, enabled: true, confirmed: true, maxMaterials: 5 }) }));
    await waitFor(() => expect(h.store.getSnapshot().sharedJob?.revision).toBe(2));
    fireEvent.click(screen.getByLabelText(/我确认有权后台读取/));
    act(() => h.store.restoreSharedJob('other', 1, '后端', 'Node', [], []));
    expect(screen.queryByRole('button', { name: '开启 / 更新后台接收' })).toBeNull();
  });
  it('does not expose management actions to a collaborator', () => {
    const h = setup(false); render(<RecruitmentIntakePanel store={h.store} scopeId="org:hr" disabled={false} onImport={vi.fn()} />);
    fireEvent.click(screen.getByText(/后台接收简历 ·/));
    expect(screen.queryByLabelText(/我确认有权后台读取/)).toBeNull();
    expect(screen.queryByRole('button', { name: '开启 / 更新后台分析' })).toBeNull();
    expect(h.call).not.toHaveBeenCalled();
  });
  it('preserves local job edits while refreshing inbox state, and rejects malformed material', async () => {
    const h = setup(); h.store.setJobDescription('尚未保存的新要求');
    await updateRecruitmentIntake(h.store, h.call, { kind: 'get', jobId: 'job' });
    expect(h.store.getSnapshot().jobDescription).toBe('尚未保存的新要求');
    expect(h.store.getSnapshot().sharedJob?.base?.description).toBe('React');
    h.call.mockResolvedValueOnce({ kind: 'job', canManage: true, sync: h.sync, job: { ...h.job, incomingMaterials: [{ id: 'malformed' }] } } as RecruitmentJobResponse);
    await expect(updateRecruitmentIntake(h.store, h.call, { kind: 'get', jobId: 'job' })).rejects.toThrow('待处理材料');
    expect(h.store.getSnapshot().jobDescription).toBe('尚未保存的新要求');
  });
});
