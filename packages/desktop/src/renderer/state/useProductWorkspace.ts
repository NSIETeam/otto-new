/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 个人/企业模式、组织、好友、积分和本地日程的 renderer 状态。
 * 服务端是唯一事实源；本 hook 不向 localStorage 复制企业身份。
 */

import { useEffect, useMemo, useReducer } from 'react';
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

export interface ProductWorkspaceState {
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
  if (action.kind === 'skill_release_busy') return { ...state, skillReleaseBusy: true, skillReleaseError: null, skillReleaseStatus: '' };
  if (action.kind === 'skill_release_timeout') return { ...state, skillReleaseBusy: false, skillReleaseError: '未收到操作结果，请刷新核对当前版本。不会自动重试回滚或复核写入。', skillReleaseStatus: '' };
  if (action.kind === 'select_date') {
    return { ...state, selectedDate: action.date };
  }
  if (action.kind === 'clear_invite') return { ...state, lastInvite: null };
  if (action.kind === 'clear_error') return { ...state, error: null };
  const frame = action.frame;
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
    return {
      ...state,
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
  const [state, dispatch] = useReducer(
    productWorkspaceReducer,
    initialProductWorkspaceState,
  );
  useEffect(() => {
    if (!state.skillReleaseBusy) return;
    const timer = setTimeout(() => dispatch({ kind: 'skill_release_timeout' }), 20_000);
    return () => clearTimeout(timer);
  }, [state.skillReleaseBusy]);

  useEffect(() => {
    const off = transport.onFrame((frame) => dispatch({ kind: 'frame', frame }));
    transport.send({ type: 'get_product_workspace', payload: {} });
    transport.send({ type: 'get_schedules', payload: {} });
    transport.send({ type: 'get_pending_auto_skills', payload: {} });
    return off;
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
    refreshPendingAutoSkills: () =>
      transport.send({
        type: 'scan_pending_auto_skills' as never,
        payload: {},
      }),
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
