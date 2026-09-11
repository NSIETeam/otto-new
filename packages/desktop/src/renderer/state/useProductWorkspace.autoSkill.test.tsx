import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientToServer, ServerToClient } from 'otto-server';
import { AutoSkillDialog } from '../components/WorkspaceDialogs.js';
import { useProductWorkspace } from './useProductWorkspace.js';

let incoming: (frame: ServerToClient) => void;
let connection: (connected: boolean) => void;
const send = vi.fn();

function Harness() {
  const { state, actions } = useProductWorkspace();
  return <AutoSkillDialog open candidates={state.pendingAutoSkills} lastAction={state.lastAutoSkillAction}
    scan={state.autoSkillScan} onRefresh={actions.refreshPendingAutoSkills}
    onConfirm={actions.confirmPendingAutoSkill} onReject={actions.rejectPendingAutoSkill} onClose={vi.fn()} />;
}

function scanRequest() {
  return send.mock.calls.map(([frame]) => frame as ClientToServer).find(frame => frame.type === 'scan_pending_auto_skills')!;
}
function reply(candidates: unknown[] = []) {
  const request = scanRequest();
  act(() => incoming({ type: 'pending_auto_skills', payload: {
    candidates, scan: { requestId: request.payload.requestId, candidateCount: candidates.length },
  } } as ServerToClient));
}

beforeEach(() => {
  send.mockReset();
  Object.assign(window.otto, {
    send,
    isConnected: vi.fn(() => true),
    onFrame: vi.fn(handler => { incoming = handler; return vi.fn(); }),
    onConnectionChange: vi.fn(handler => { connection = handler; return vi.fn(); }),
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('立即分析完整界面反馈', () => {
  it('点击即显示分析中、阻止连点，只由本次扫描回执结束等待', () => {
    render(<Harness />);
    const button = screen.getByRole('button', { name: '立即分析' });
    fireEvent.click(button); fireEvent.click(button);
    expect(screen.getByRole('button', { name: '分析中…' })).toHaveProperty('disabled', true);
    expect(scanRequest().payload).toEqual({ requestId: expect.any(String) });
    expect(send.mock.calls.filter(([frame]) => frame.type === 'scan_pending_auto_skills')).toHaveLength(1);
    act(() => incoming({ type: 'pending_auto_skills', payload: { candidates: [] } }));
    act(() => incoming({ type: 'pending_auto_skills', payload: { candidates: [], scan: { requestId: 'old-scan', candidateCount: 0 } } }));
    expect(screen.getByRole('button', { name: '分析中…' })).toHaveProperty('disabled', true);
    reply();
    expect(screen.getByRole('status').textContent).toContain('未发现符合条件的新候选');
    expect(screen.getByRole('button', { name: '立即分析' })).toHaveProperty('disabled', false);
    expect(send.mock.calls.some(([frame]) => frame.type === 'confirm_pending_auto_skill')).toBe(false);
  });

  it('服务错误在当前弹窗展示，其他工作区消息不会将它清掉', () => {
    render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '立即分析' }));
    act(() => incoming({ type: 'error', payload: { code: 'auto_skill_failed', requestId: scanRequest().payload.requestId, message: '模型服务暂不可用' } }));
    expect(screen.getByRole('alert').textContent).toContain('模型服务暂不可用');
    act(() => incoming({ type: 'schedules_list', payload: { schedules: [] } }));
    expect(screen.getByRole('alert').textContent).toContain('模型服务暂不可用');
    expect(screen.getByRole('button', { name: '重新分析' })).toHaveProperty('disabled', false);
  });

  it('找到候选时显示数量和草稿，安装仍必须另行确认', () => {
    render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '立即分析' }));
    reply([{ id: 'report-1', name: '报告整理', description: '生成报告草稿', detectedPattern: '整理报告', occurrenceCount: 3, reason: '重复流程' }]);
    expect(screen.getByRole('status').textContent).toContain('找到 1 个待确认候选');
    expect(screen.getByRole('article', { name: '报告整理 Skill 草稿' })).toBeTruthy();
    expect(send.mock.calls.some(([frame]) => frame.type === 'confirm_pending_auto_skill')).toBe(false);
  });

  it('重新分析后忽略旧请求迟到的成功和错误，不覆盖当前状态', () => {
    vi.useFakeTimers(); render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '立即分析' }));
    const oldId = scanRequest().payload.requestId;
    act(() => vi.advanceTimersByTime(120_000));
    fireEvent.click(screen.getByRole('button', { name: '重新分析' }));
    act(() => incoming({ type: 'error', payload: { code: 'auto_skill_failed', requestId: oldId, message: '过期错误' } }));
    reply();
    expect(screen.getByRole('button', { name: '分析中…' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('离线不发送扫描，明确提示连接问题', () => {
    vi.mocked(window.otto.isConnected).mockReturnValue(false);
    render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '立即分析' }));
    expect(screen.getByRole('alert').textContent).toContain('连接');
    expect(scanRequest()).toBeUndefined();
  });

  it('超时不谎称完成、不自动重试，迟到的真实回执仍可恢复结果', () => {
    vi.useFakeTimers(); render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '立即分析' }));
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByRole('alert').textContent).toContain('尚未收到');
    expect(send.mock.calls.filter(([frame]) => frame.type === 'scan_pending_auto_skills')).toHaveLength(1);
    reply();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('扫描完成');
  });

  it('分析中断线提示结果未知，不自动重发', () => {
    render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '立即分析' }));
    act(() => connection(false));
    expect(screen.getByRole('alert').textContent).toContain('连接已断开');
    act(() => connection(true));
    expect(send.mock.calls.filter(([frame]) => frame.type === 'scan_pending_auto_skills')).toHaveLength(1);
  });

  it('传输同步抛错也能退出等待', () => {
    render(<Harness />);
    send.mockImplementation(() => { throw new Error('bridge unavailable'); });
    fireEvent.click(screen.getByRole('button', { name: '立即分析' }));
    expect(screen.getByRole('alert').textContent).toContain('未能发送');
    expect(screen.getByRole('button', { name: '重新分析' })).toHaveProperty('disabled', false);
  });
});
