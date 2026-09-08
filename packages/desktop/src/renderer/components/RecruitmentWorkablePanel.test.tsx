import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { RecruitmentWorkablePanel } from './RecruitmentWorkablePanel.js';
import type { WorkableConnectionView } from 'otto-server';

const state: WorkableConnectionView = { revision: 1, status: 'binding_required', authorizationAvailable: false, targets: [{ account: 'acme', shortcode: 'FRONT', label: '前端工程师' }] };
it('requires separate sample consent and labels a partial check without claiming production readiness', async () => {
  const bound: WorkableConnectionView = { ...state, status: 'bound_pending_acceptance', binding: { account: 'acme', shortcode: 'FRONT' }, materialAcceptanceAvailable: true };
  window.otto.enterpriseRecruitmentWorkable = vi.fn(async ({ action }): Promise<WorkableConnectionView> => action.kind === 'material_probe' ? { ...bound, revision: 2, materialCheck: { runId: 'check', checkedAt: new Date().toISOString(), status: 'partial', candidatesRead: 1, materialChars: 50, modelInvoked: false, productionAccepted: false } } : bound);
  render(<RecruitmentWorkablePanel scopeId="org:hr" jobId="job" disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: '刷新本人授权' }));
  const sample = await screen.findByRole('button', { name: '读取一份测试简历（不调用模型）' });
  fireEvent.click(screen.getByLabelText(/我确认本次浏览器只读授权/)); expect((sample as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/我确认此绑定岗位仅用于获准样本验收/)); fireEvent.click(sample);
  await screen.findByText(/仅取得部分资料，尚未通过全文读取验收/);
  expect(window.otto.enterpriseRecruitmentWorkable).toHaveBeenLastCalledWith({ scopeId: 'org:hr', action: { kind: 'material_probe', jobId: 'job', expectedRevision: 1, confirmed: true } });
});
it('requires confirmation for a limited connection check and refreshes source readiness without claiming acceptance', async () => {
  const bound: WorkableConnectionView = { ...state, status: 'bound_pending_acceptance', binding: { account: 'acme', shortcode: 'FRONT' } };
  window.otto.enterpriseRecruitmentWorkable = vi.fn(async ({ action }): Promise<WorkableConnectionView> => action.kind === 'probe' ? { ...bound, connectionCheck: { checkedAt: '2026-09-08T00:00:00Z', scope: 'protocol_and_account_only', candidateReadVerified: false, resumeReadVerified: false } } : bound);
  const onChanged = vi.fn();
  render(<RecruitmentWorkablePanel scopeId="org:hr" jobId="job" disabled={false} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole('button', { name: '刷新本人授权' }));
  await screen.findByText(/当前绑定：/);
  const probe = screen.getByRole('button', { name: '检查账号连接（只读）' });
  expect((probe as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(probe);
  await screen.findByText(/协议与账号检查通过/);
  expect(window.otto.enterpriseRecruitmentWorkable).toHaveBeenLastCalledWith({ scopeId: 'org:hr', action: { kind: 'probe', jobId: 'job', expectedRevision: 1, confirmed: true } });
  expect(onChanged).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/未验证候选人或简历读取/)).toBeTruthy();
});
it('requires explicit account/job selection and confirmation, and never offers a token input', async () => {
  window.otto.enterpriseRecruitmentWorkable = vi.fn(async () => state);
  render(<RecruitmentWorkablePanel scopeId="org:hr" jobId="job" disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: '刷新本人授权' }));
  await screen.findByText('请为当前 Otto 岗位选择 Workable 岗位');
  expect(screen.queryByRole('textbox')).toBeNull();
  expect((screen.getByRole('button', { name: '绑定选中岗位' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Workable 账号与岗位'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '绑定选中岗位' }));
  await waitFor(() => expect(window.otto.enterpriseRecruitmentWorkable).toHaveBeenCalledWith({ scopeId: 'org:hr', action: { kind: 'bind', jobId: 'job', expectedRevision: 1, account: 'acme', shortcode: 'FRONT', confirmed: true } }));
});
it('clears choices and discards a late response after switching enterprise or job', async () => {
  let finish!: (result: WorkableConnectionView) => void;
  window.otto.enterpriseRecruitmentWorkable = vi.fn(() => new Promise<WorkableConnectionView>((resolve) => { finish = resolve; }));
  const rendered = render(<RecruitmentWorkablePanel scopeId="org:hr" jobId="job" disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: '刷新本人授权' }));
  rendered.rerender(<RecruitmentWorkablePanel scopeId="other:hr" jobId="other" disabled={false} />);
  await act(async () => finish(state));
  await waitFor(() => expect(screen.queryByText('前端工程师', { exact: false })).toBeNull());
  expect((screen.getByRole('button', { name: '绑定选中岗位' }) as HTMLButtonElement).disabled).toBe(true);
});
it('explains the missing OAuth entry without suggesting shared administrator credentials', async () => {
  window.otto.enterpriseRecruitmentWorkable = vi.fn(async (): Promise<WorkableConnectionView> => ({ revision: 0, status: 'authorization_required', authorizationAvailable: false, targets: [] }));
  render(<RecruitmentWorkablePanel scopeId="org:hr" jobId="job" disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: '刷新本人授权' }));
  expect(await screen.findByText(/浏览器 OAuth 授权入口尚未接通/)).toBeTruthy();
  expect((screen.getByRole('button', { name: '绑定选中岗位' }) as HTMLButtonElement).disabled).toBe(true);
});
it('offers browser authorization only when enabled, requires confirmation and supports cancellation', async () => {
  window.otto.enterpriseRecruitmentWorkable = vi.fn(async (): Promise<WorkableConnectionView> => ({ ...state, authorizationAvailable: true }));
  let finish!: (value: WorkableConnectionView) => void;
  window.otto.enterpriseRecruitmentWorkableLogin = vi.fn(() => new Promise<WorkableConnectionView>((resolve) => { finish = resolve; }));
  window.otto.enterpriseRecruitmentWorkableCancel = vi.fn(async () => undefined);
  render(<RecruitmentWorkablePanel scopeId="org:hr" jobId="job" disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: '刷新本人授权' }));
  const login = await screen.findByRole('button', { name: '在浏览器登录 Workable' });
  expect((login as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(login);
  await waitFor(() => expect(window.otto.enterpriseRecruitmentWorkableLogin).toHaveBeenCalledWith({ scopeId: 'org:hr', expectedRevision: 1 }));
  fireEvent.click(screen.getByRole('button', { name: '取消本次登录' }));
  expect(window.otto.enterpriseRecruitmentWorkableCancel).toHaveBeenCalledWith('org:hr');
  await act(async () => finish(state));
});
