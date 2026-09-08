import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RecruitmentArchivePanel } from './RecruitmentArchivePanel.js';
import { RecruitmentWorkspaceStore } from '../recruitmentWorkspaceStore.js';
import type { RecruitmentJobAction, RecruitmentJobResponse } from 'otto-server';
import { getRecruitmentAutosave } from '../recruitmentAutosave.js';

describe('shared recruitment archive controls', () => {
  it('keeps explicitly enabled autosave alive after closing the panel and uses the member directory for owners', async () => {
    const store = new RecruitmentWorkspaceStore('org:hr'); store.setJobTitle('前端');
    const sync = { scopeToken: 'a'.repeat(64), headerToken: 'b'.repeat(64), candidateTokens: {} };
    let job = { id: '', title: '前端', description: '', candidates: [], revision: 0, updatedAt: '', updatedBy: 'hr', ownerAccountId: 'hr', collaboratorAccountIds: [] };
    const call = vi.fn(async (action: RecruitmentJobAction): Promise<RecruitmentJobResponse> => {
      if (action.kind === 'save') job = { ...job, id: action.jobId, revision: 1 };
      if (action.kind === 'patch') job = { ...job, ...(action.metadata ?? {}), revision: job.revision + 1 };
      return { kind: 'job', job, sync, canManage: true };
    });
    const directory = vi.fn(async () => ({ organization: { id: 'org' }, members: [{ id: 'colleague', name: '同事', username: 'hr2', status: 'active' }] }));
    Object.assign(window.otto, { enterpriseRecruitmentJobs: ({ action }: { action: RecruitmentJobAction }) => call(action), enterpriseOrganizationView: directory });
    const controller = getRecruitmentAutosave(store); const stop = controller.start(call);
    const view = render(<RecruitmentArchivePanel store={store} scopeId="org:hr" disabled={false} />);
    fireEvent.click(screen.getByText(/企业共享岗位 ·/)); fireEvent.click(screen.getByLabelText(/我确认有权/));
    fireEvent.click(screen.getByRole('button', { name: '保存并开启自动保存' }));
    await waitFor(() => expect(controller.getSnapshot().enabled).toBe(true));
    fireEvent.click(screen.getByText('管理当前岗位协作者／删除共享岗位'));
    fireEvent.click(screen.getByRole('button', { name: '选择企业同事' })); await screen.findByText('同事（hr2）'); expect(directory).toHaveBeenCalledOnce();
    view.unmount(); act(() => store.setJobTitle('后端'));
    await waitFor(() => expect(call.mock.calls.some(([action]) => action.kind === 'patch')).toBe(true), { timeout: 2000 });
    stop();
  });
  it('does not apply the previous job ACL after another entry point changes the shared workspace', async () => {
    const store = new RecruitmentWorkspaceStore('org:admin');
    store.setJobTitle('前端');
    const call = vi.fn(async ({ action }) => ({ kind: 'job', canManage: true, job: { id: action.jobId, title: '前端', description: '', candidates: [], revision: 1, updatedAt: '', updatedBy: 'admin', collaboratorAccountIds: ['old-hr'] } }) as RecruitmentJobResponse);
    Object.assign(window.otto, { enterpriseRecruitmentJobs: call });
    render(<RecruitmentArchivePanel store={store} scopeId="org:admin" disabled={false} />);
    fireEvent.click(screen.getByText(/企业共享岗位 ·/));
    fireEvent.click(screen.getByLabelText(/我确认有权/));
    fireEvent.click(screen.getByRole('button', { name: '保存当前岗位' }));
    await screen.findByText('管理当前岗位协作者／删除共享岗位');
    act(() => store.restoreSharedJob('another-job', 7, '另一岗位', '', [], []));
    expect(screen.queryByText('管理当前岗位协作者／删除共享岗位')).toBeNull();
  });
  it('keeps save disabled until explicit confirmation and displays saved/dirty states', async () => {
    const store = new RecruitmentWorkspaceStore('org:admin');
    store.setJobTitle('前端'); store.setJobDescription('React');
    const call = vi.fn(async (input: { action: RecruitmentJobAction }) => {
      if (input.action.kind !== 'save') throw new Error('unexpected request');
      return { kind: 'job', canManage: true, job: { id: input.action.jobId, title: '前端', description: 'React', candidates: [], revision: 1, updatedAt: new Date().toISOString(), updatedBy: 'admin', collaboratorAccountIds: [] } } as RecruitmentJobResponse;
    });
    Object.assign(window.otto, { enterpriseRecruitmentJobs: call });
    render(<RecruitmentArchivePanel store={store} scopeId="org:admin" disabled={false} />);
    fireEvent.click(screen.getByText(/企业共享岗位 ·/));
    expect((screen.getByRole('button', { name: '保存当前岗位' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我确认有权/));
    fireEvent.click(screen.getByRole('button', { name: '保存当前岗位' }));
    await waitFor(() => expect(screen.getByText(/企业共享岗位 · 已保存 v1/)).toBeTruthy());
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0]).toMatchObject({ scopeId: 'org:admin' });
    act(() => store.setJobDescription('React + Electron'));
    await waitFor(() => expect(screen.getByText(/企业共享岗位 · 有未保存修改/)).toBeTruthy());
  });
  it('lists only server-authorized jobs and requires local replacement confirmation before loading', async () => {
    const store = new RecruitmentWorkspaceStore('org:hr');
    const call = vi.fn(async () => ({ kind: 'list', jobs: [{ id: 'j1', title: '岗位甲', description: '', revision: 2, collaboratorAccountIds: ['hr'], updatedAt: '', updatedBy: 'admin' }], nextCursor: null, canManage: false }) as RecruitmentJobResponse);
    Object.assign(window.otto, { enterpriseRecruitmentJobs: call });
    render(<RecruitmentArchivePanel store={store} scopeId="org:hr" disabled={false} />);
    fireEvent.click(screen.getByText(/企业共享岗位 ·/));
    fireEvent.click(screen.getByRole('button', { name: '刷新企业岗位列表' }));
    await waitFor(() => expect(screen.getByRole('option', { name: '岗位甲 · v2' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('选择企业共享岗位'), { target: { value: 'j1' } });
    expect((screen.getByRole('button', { name: '加载选中岗位' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('管理当前岗位协作者／删除共享岗位')).toBeNull();
  });
});
