/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 个人/企业模式、组织、好友、积分和本地日程的 renderer 状态。
 * 服务端是唯一事实源；本 hook 不向 localStorage 复制企业身份。
 */

import { useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  AutoSkillCandidateInfo,
  InstalledSkillReleases,
  SkillRollbackInput,
  SkillAcceptanceInput,
  ProductWorkspaceSnapshot,
  ScheduleItemInfo,
  ServerToClient,
} from 'otto-server';
import * as transport from '../transport.js';

export interface AutoSkillScanState {
  requestId: string;
  status: 'running' | 'completed' | 'failed' | 'uncertain';
  message: string;
}

export interface ProductWorkspaceState {
  autoSkillScan: AutoSkillScanState | null;
  skillReleases: InstalledSkillReleases[];
  skillReleaseBusy: boolean;
  skillReleaseError: string | null;
  skillReleaseStatus: string;
  workspace: ProductWorkspaceSnapshot | null;
  schedules: ScheduleItemInfo[];
  pendingAutoSkills: AutoSkillCandidateInfo[];
  lastAutoSkillAction: {
    kind: 'confirmed' | 'rejected';
    candidateId: string;
    savedPath?: string;
  } | null;
  selectedDate: string | null;
  lastInvite: {
    kind: 'position' | 'company' | 'company_link';
    link: string;
    expiresAt: string;
  } | null;
  loading: boolean;
  error: string | null;
}

export const initialProductWorkspaceState: ProductWorkspaceState = {
  autoSkillScan: null,
  skillReleases: [],
  skillReleaseBusy: false,
  skillReleaseError: null,
  skillReleaseStatus: '',
  workspace: null,
  schedules: [],
  pendingAutoSkills: [],
  lastAutoSkillAction: null,
  selectedDate: null,
  lastInvite: null,
  loading: true,
  error: null,
};

export type ProductWorkspaceAction =
  | { kind: 'auto_skill_scan'; scan: AutoSkillScanState }
  | { kind: 'skill_release_busy' }
  | { kind: 'skill_release_timeout' }
  | { kind: 'frame'; frame: ServerToClient }
  | { kind: 'select_date'; date: string }
  | { kind: 'clear_invite' }
  | { kind: 'clear_error' };

export function productWorkspaceReducer(
  state: ProductWorkspaceState,
  action: ProductWorkspaceAction,
): ProductWorkspaceState {
  if (action.kind === 'auto_skill_scan') {
    if (action.scan.status === 'uncertain' && state.autoSkillScan?.requestId !== action.scan.requestId) return state;
    return { ...state, autoSkillScan: action.scan, lastAutoSkillAction: null };
  }
  if (action.kind === 'skill_release_busy') return { ...state, skillReleaseBusy: true, skillReleaseError: null, skillReleaseStatus: '' };
  if (action.kind === 'skill_release_timeout') return { ...state, skillReleaseBusy: false, skillReleaseError: '未收到操作结果，请刷新核对当前版本。不会自动重试回滚或复核写入。', skillReleaseStatus: '' };
  if (action.kind === 'select_date') {
    return { ...state, selectedDate: action.date };
  }
  if (action.kind === 'clear_invite') return { ...state, lastInvite: null };
  if (action.kind === 'clear_error') return { ...state, error: null };
  const frame = action.frame;
  if (frame.type === 'error' && state.autoSkillScan && ['running', 'uncertain'].includes(state.autoSkillScan.status)
    && (frame.payload.code === 'auto_skill_failed' || frame.payload.code === 'offline_write_rejected')) {
    if (frame.payload.requestId && frame.payload.requestId !== state.autoSkillScan.requestId) return state;
    return { ...state, autoSkillScan: { ...state.autoSkillScan, status: 'failed', message: `分析未完成：${frame.payload.message}` } };
  }
  if (frame.type === 'skill_releases') return {
    ...state, skillReleases: frame.payload.skills, skillReleaseBusy: false, skillReleaseError: null,
    skillReleaseStatus: frame.payload.lastAction?.kind === 'rolled-back' ? '已恢复所选版本，原版本完整保留。请在新会话中使用。' : frame.payload.lastAction?.kind === 'reviewed' ? '已保存人工复核证据，仅适用于记录中的案例与环境。' : '',
  };
  if (frame.type === 'error' && (frame.payload.code === 'skill_release_failed' || state.skillReleaseBusy && ['offline_write_rejected', 'bad_payload'].includes(frame.payload.code))) return { ...state, skillReleaseBusy: false, skillReleaseError: frame.payload.message, skillReleaseStatus: '' };
  if (frame.type === 'product_workspace') {
    return { ...state, workspace: frame.payload, loading: false, error: null };
  }
  if (frame.type === 'enterprise_invite_created') {
    return { ...state, lastInvite: frame.payload, error: null };
  }
  if (frame.type === 'schedules_list') {
    return {
      ...state,
      schedules: frame.payload.schedules,
      selectedDate: frame.payload.date ?? state.selectedDate,
      error: null,
    };
  }
  if (frame.type === 'pending_auto_skills') {
    if (frame.payload.scan && frame.payload.scan.requestId !== state.autoSkillScan?.requestId) return state;
    return {
      ...state,
      ...(frame.payload.scan ? { autoSkillScan: {
        requestId: frame.payload.scan.requestId,
        status: 'completed' as const,
        message: frame.payload.scan.candidateCount > 0
          ? `扫描完成，找到 ${frame.payload.scan.candidateCount} 个待确认候选。请核对草稿与风险，尚未自动安装或执行。`
          : '扫描完成，未发现符合条件的新候选。可以先完成更多实际任务积累可复用成果，或直接让 Otto 创建一个 Skill。',
      } } : {}),
      pendingAutoSkills: frame.payload.candidates,
      lastAutoSkillAction: frame.payload.lastAction ?? null,
      error: null,
    };
  }
  if (
    frame.type === 'error' &&
    (frame.payload.code === 'workspace_failed' ||
      frame.payload.code === 'schedule_failed' ||
      frame.payload.code === 'forbidden_by_edition' ||
      frame.payload.code === 'auto_skill_failed')
  ) {
    return { ...state, loading: false, error: frame.payload.message };
  }
  return state;
}

export interface ProductWorkspaceActions {
  refreshSkillReleases(): void;
  rollbackSkillRelease(input: SkillRollbackInput): void;
  recordSkillAcceptance(input: SkillAcceptanceInput): void;
  refresh(): void;
  configureEnterprise(input: {
    managerName: string;
    companyName: string;
    industry?: string;
    employeeScale?: string;
  }): void;
  switchToPersonal(): void;
  joinEnterprise(link: string, userId: string, displayName: string): void;
  createInvite(input:
    | { kind: 'position'; departmentId: string; positionId: string; expiresInSeconds?: number }
    | { kind: 'company'; expiresInSeconds?: number }
    | {
        kind: 'company_link';
        direction: 'parent_invites_child' | 'child_requests_parent';
        targetCompanyId?: string;
        expiresInSeconds?: number;
      }): void;
  acceptCompanyLink(link: string): void;
  addFriend(displayName: string, note?: string): void;
  refreshPendingAutoSkills(): void;
  confirmPendingAutoSkill(candidateId: string): void;
  rejectPendingAutoSkill(candidateId: string): void;
  selectDate(date: string, timezone?: string): void;
  refreshSchedules(date?: string, timezone?: string): void;
  createSchedule(input: {
    title: string;
    startAt: string;
    endAt?: string;
    notes?: string;
    reason?: string;
  }): void;
  updateSchedule(input: {
    id: string;
    title?: string;
    startAt?: string;
    endAt?: string | null;
    notes?: string | null;
    reason?: string | null;
  }): void;
  deleteSchedule(id: string): void;
  clearInvite(): void;
  clearError(): void;
}

export interface UseProductWorkspace {
  state: ProductWorkspaceState;
  actions: ProductWorkspaceActions;
}

export function useProductWorkspace(activeSessionId?: string | null): UseProductWorkspace {
  const scanInFlight = useRef<string | null>(null);
  const [state, dispatch] = useReducer(
    productWorkspaceReducer,
    initialProductWorkspaceState,
  );
  useEffect(() => {
    const scan = state.autoSkillScan;
    if (scan?.status !== 'running') return;
    const timer = setTimeout(() => {
      if (scanInFlight.current === scan.requestId) scanInFlight.current = null;
      dispatch({ kind: 'auto_skill_scan', scan: { ...scan, status: 'uncertain', message: '尚未收到分析结果，后台可能仍在处理。不会自动重试；请稍后核对候选。若持续出现，请检查本地服务和客户端是否为配套版本。' } });
    }, 120_000);
    return () => clearTimeout(timer);
  }, [state.autoSkillScan]);
  useEffect(() => {
    if (!state.skillReleaseBusy) return;
    const timer = setTimeout(() => dispatch({ kind: 'skill_release_timeout' }), 20_000);
    return () => clearTimeout(timer);
  }, [state.skillReleaseBusy]);

  useEffect(() => {
    const off = transport.onFrame((frame) => {
      if ((frame.type === 'pending_auto_skills' && frame.payload.scan?.requestId === scanInFlight.current)
        || (frame.type === 'error' && ['auto_skill_failed', 'offline_write_rejected'].includes(frame.payload.code)
          && (!frame.payload.requestId || frame.payload.requestId === scanInFlight.current))) scanInFlight.current = null;
      dispatch({ kind: 'frame', frame });
    });
    const offConnection = window.otto.onConnectionChange?.(connected => {
      if (connected || !scanInFlight.current) return;
      const requestId = scanInFlight.current;
      scanInFlight.current = null;
      dispatch({ kind: 'auto_skill_scan', scan: { requestId, status: 'uncertain', message: '连接已断开，暂时无法确认本次分析结果。恢复连接后请核对候选；不会自动重发分析。' } });
    });
    transport.send({ type: 'get_product_workspace', payload: {} });
    transport.send({ type: 'get_schedules', payload: {} });
    transport.send({ type: 'get_pending_auto_skills', payload: {} });
    return () => { off(); offConnection?.(); };
  }, []);

  const actions = useMemo<ProductWorkspaceActions>(() => ({
    refreshSkillReleases: () => {
      dispatch({ kind: 'skill_release_busy' });
      transport.send({ type: 'get_skill_releases', payload: {} });
    },
    rollbackSkillRelease: (input) => {
      dispatch({ kind: 'skill_release_busy' });
      transport.send({ type: 'rollback_skill_release', payload: input });
    },
    recordSkillAcceptance: (input) => {
      dispatch({ kind: 'skill_release_busy' });
      transport.send({ type: 'record_skill_acceptance', payload: input });
    },
    refresh: () => transport.send({ type: 'get_product_workspace', payload: {} }),
    configureEnterprise: (input) =>
      transport.send({ type: 'configure_enterprise', payload: input }),
    switchToPersonal: () => transport.send({ type: 'switch_to_personal', payload: {} }),
    joinEnterprise: (link, userId, displayName) =>
      transport.send({
        type: 'join_enterprise',
        payload: { link: link.trim(), userId: userId.trim(), displayName: displayName.trim() },
      }),
    createInvite: (input) =>
      transport.send({ type: 'create_enterprise_invite', payload: input }),
    acceptCompanyLink: (link) =>
      transport.send({ type: 'accept_company_link', payload: { link: link.trim() } }),
    addFriend: (displayName, note) =>
      transport.send({
        type: 'add_friend',
        payload: { displayName: displayName.trim(), ...(note?.trim() ? { note: note.trim() } : {}) },
      }),
    refreshPendingAutoSkills: () => {
      if (scanInFlight.current) return;
      const requestId = crypto.randomUUID();
      if (!window.otto.isConnected?.()) {
        dispatch({ kind: 'auto_skill_scan', scan: { requestId, status: 'failed', message: '本地服务尚未连接，本次分析未发送。请恢复连接后重新分析。' } });
        return;
      }
      scanInFlight.current = requestId;
      dispatch({ kind: 'auto_skill_scan', scan: { requestId, status: 'running', message: '正在扫描最近的工作成果并整理 Skill 候选，请稍候。不会自动安装或执行。' } });
      try {
        transport.send({ type: 'scan_pending_auto_skills', payload: { requestId } });
      } catch {
        scanInFlight.current = null;
        dispatch({ kind: 'auto_skill_scan', scan: { requestId, status: 'failed', message: '未能发送分析请求，请检查本地服务连接后重新分析。' } });
      }
    },
    confirmPendingAutoSkill: (candidateId) =>
      transport.send({
        type: 'confirm_pending_auto_skill',
        payload: {
          candidateId,
          ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        },
      }),
    rejectPendingAutoSkill: (candidateId) =>
      transport.send({ type: 'reject_pending_auto_skill', payload: { candidateId } }),
    selectDate: (date, timezone) => {
      dispatch({ kind: 'select_date', date });
      transport.send({
        type: 'get_schedules',
        payload: { date, ...(timezone ? { timezone } : {}) },
      });
    },
    refreshSchedules: (date, timezone) =>
      transport.send({
        type: 'get_schedules',
        payload: { ...(date ? { date } : {}), ...(timezone ? { timezone } : {}) },
      }),
    createSchedule: (input) => transport.send({ type: 'create_schedule', payload: input }),
    updateSchedule: (input) => transport.send({ type: 'update_schedule', payload: input }),
    deleteSchedule: (id) => transport.send({ type: 'delete_schedule', payload: { id } }),
    clearInvite: () => dispatch({ kind: 'clear_invite' }),
    clearError: () => dispatch({ kind: 'clear_error' }),
  }), [activeSessionId]);

  return { state, actions };
}
