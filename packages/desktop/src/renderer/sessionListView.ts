import type { SessionSummary } from 'otto-server';

import type { UiModePreferenceScope } from './uiModePreference.js';

export type SessionListMode = 'kind' | 'time' | 'workspace';
export type SessionListSection = 'projects' | 'conversations';

export interface SidebarSessionGroup {
  key: string;
  label: string;
  fullPath?: string;
  section?: SessionListSection;
  collapsible: boolean;
  sessions: SessionSummary[];
}

export interface SessionListPreference {
  version: 1;
  mode: SessionListMode;
  collapsedWorkspaceKeys: string[];
  /** 用户从项目区移除的目录；只解除项目归类，不删除目录或历史会话。 */
  removedProjectPaths: string[];
}

export const DEFAULT_SESSION_LIST_PREFERENCE: SessionListPreference = {
  version: 1,
  mode: 'kind',
  collapsedWorkspaceKeys: [],
  removedProjectPaths: [],
};

const STORAGE_PREFIX = 'otto.session-list.v1';
const DEFAULT_WORKSPACE_KEY = 'workspace:default';

function normalizeServerUrl(value: string | null | undefined): string {
  const normalized = value?.trim().replace(/\/+$/, '').toLowerCase();
  return normalized || 'local';
}

export function sessionListPreferenceStorageKey(scope: UiModePreferenceScope): string {
  return [
    STORAGE_PREFIX,
    normalizeServerUrl(scope.serverUrl),
    scope.organizationId.trim() || 'personal',
    scope.accountId.trim() || 'anonymous',
  ].map(encodeURIComponent).join(':');
}

function normalizePreference(value: unknown): SessionListPreference {
  if (!value || typeof value !== 'object') return DEFAULT_SESSION_LIST_PREFERENCE;
  const candidate = value as Partial<SessionListPreference>;
  if (candidate.version !== 1
    || (candidate.mode !== 'kind' && candidate.mode !== 'time' && candidate.mode !== 'workspace')) {
    return DEFAULT_SESSION_LIST_PREFERENCE;
  }
  const collapsedWorkspaceKeys = Array.isArray(candidate.collapsedWorkspaceKeys)
    ? [...new Set(candidate.collapsedWorkspaceKeys.filter(
      (key): key is string => typeof key === 'string' && key.trim().length > 0,
    ))]
    : [];
  const removedProjectPaths = Array.isArray(candidate.removedProjectPaths)
    ? [...new Set(candidate.removedProjectPaths.filter(
      (workspacePath): workspacePath is string => (
        typeof workspacePath === 'string' && workspacePath.trim().length > 0
      ),
    ).map((workspacePath) => workspacePath.trim()))]
    : [];
  return { version: 1, mode: candidate.mode, collapsedWorkspaceKeys, removedProjectPaths };
}

export function readSessionListPreference(
  scope: UiModePreferenceScope,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): SessionListPreference {
  try {
    const serialized = storage.getItem(sessionListPreferenceStorageKey(scope));
    if (!serialized) return DEFAULT_SESSION_LIST_PREFERENCE;
    return normalizePreference(JSON.parse(serialized));
  } catch {
    return DEFAULT_SESSION_LIST_PREFERENCE;
  }
}

export function writeSessionListPreference(
  scope: UiModePreferenceScope,
  preference: SessionListPreference,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): boolean {
  try {
    storage.setItem(
      sessionListPreferenceStorageKey(scope),
      JSON.stringify(normalizePreference(preference)),
    );
    return true;
  } catch {
    return false;
  }
}

/** 按用户本地自然日计算相对日期，避免跨时区或夏令时把“昨天”算成同一天。 */
function formatRelativeDay(timestamp: number, now: number): string {
  const current = new Date(now);
  const target = new Date(timestamp);
  const currentDay = Date.UTC(current.getFullYear(), current.getMonth(), current.getDate());
  const targetDay = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
  const days = Math.max(0, Math.round((currentDay - targetDay) / 86_400_000));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days}天前`;
}

function workspaceKey(workspacePath: string | undefined): string {
  const value = workspacePath?.trim();
  return value ? `workspace:${value}` : DEFAULT_WORKSPACE_KEY;
}

function pathParts(workspacePath: string): string[] {
  return workspacePath.split(/[\\/]+/).filter(Boolean);
}

export function workspaceDisplayName(workspacePath: string | undefined): string {
  const value = workspacePath?.trim();
  if (!value) return '默认工作目录';
  if (/^[\\/]+$/.test(value) || /^[A-Za-z]:[\\/]?$/.test(value)) return value;
  const parts = pathParts(value);
  return parts.at(-1) ?? value;
}

function workspaceAncestorLabel(workspacePath: string | undefined, depth: number): string | undefined {
  const value = workspacePath?.trim();
  if (!value) return undefined;
  const parts = pathParts(value);
  const ancestors = parts.slice(0, -1);
  return ancestors.slice(-depth).join('/') || undefined;
}

function sortSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
}

function groupByTime(sessions: readonly SessionSummary[], now: number): SidebarSessionGroup[] {
  const groups: SidebarSessionGroup[] = [];
  const byLabel = new Map<string, SidebarSessionGroup>();
  for (const session of sortSessions(sessions)) {
    const label = formatRelativeDay(session.updatedAt, now);
    const existing = byLabel.get(label);
    if (existing) existing.sessions.push(session);
    else {
      const group = { key: `time:${label}`, label, collapsible: false, sessions: [session] };
      byLabel.set(label, group);
      groups.push(group);
    }
  }
  return groups;
}

function groupByWorkspace(sessions: readonly SessionSummary[]): SidebarSessionGroup[] {
  const byKey = new Map<string, SidebarSessionGroup>();
  for (const session of sortSessions(sessions)) {
    const key = workspaceKey(session.workspacePath);
    const existing = byKey.get(key);
    if (existing) existing.sessions.push(session);
    else {
      byKey.set(key, {
        key,
        label: workspaceDisplayName(session.workspacePath),
        fullPath: session.workspacePath?.trim() || undefined,
        collapsible: true,
        sessions: [session],
      });
    }
  }

  const groups = [...byKey.values()];
  const groupsByBaseLabel = new Map<string, SidebarSessionGroup[]>();
  for (const group of groups) {
    const matches = groupsByBaseLabel.get(group.label);
    if (matches) matches.push(group);
    else groupsByBaseLabel.set(group.label, [group]);
  }
  for (const [baseLabel, matches] of groupsByBaseLabel) {
    if (matches.length < 2) continue;
    const maxDepth = Math.max(...matches.map((group) => pathParts(group.fullPath ?? '').length));
    let assigned = false;
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const labels = matches.map((group) => {
        const ancestor = workspaceAncestorLabel(group.fullPath, depth);
        return ancestor ? `${baseLabel} — ${ancestor}` : group.fullPath ?? baseLabel;
      });
      if (new Set(labels).size !== matches.length) continue;
      matches.forEach((group, index) => { group.label = labels[index]; });
      assigned = true;
      break;
    }
    if (!assigned) {
      matches.forEach((group) => { group.label = group.fullPath ?? baseLabel; });
    }
  }
  return groups;
}

function normalizeWorkspacePath(workspacePath: string | null | undefined): string {
  const value = workspacePath?.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!value) return '';
  return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}

export function sameWorkspacePath(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeWorkspacePath(left);
  const normalizedRight = normalizeWorkspacePath(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

/**
 * Otto 项目沿用真实工作目录作为稳定身份。默认目录中的会话属于普通会话；
 * 绑定其他目录的会话属于项目，因此旧会话无需迁移数据库即可自动归档。
 */
export function isProjectSession(
  session: Pick<SessionSummary, 'workspacePath'>,
  defaultWorkspacePath: string | null | undefined,
): boolean {
  if (!session.workspacePath?.trim() || !defaultWorkspacePath?.trim()) return false;
  return !sameWorkspacePath(session.workspacePath, defaultWorkspacePath);
}

function groupByKind(
  sessions: readonly SessionSummary[],
  defaultWorkspacePath: string | null | undefined,
  now: number,
  removedProjectPaths: readonly string[],
): SidebarSessionGroup[] {
  const projectSessions = sessions.filter((session) => (
    isProjectSession(session, defaultWorkspacePath)
    && !removedProjectPaths.some((workspacePath) => (
      sameWorkspacePath(session.workspacePath, workspacePath)
    ))
  ));
  const conversationSessions = sessions.filter((session) => (
    !isProjectSession(session, defaultWorkspacePath)
    || removedProjectPaths.some((workspacePath) => (
      sameWorkspacePath(session.workspacePath, workspacePath)
    ))
  ));
  return [
    ...groupByWorkspace(projectSessions).map((group) => ({
      ...group,
      section: 'projects' as const,
    })),
    ...groupByTime(conversationSessions, now).map((group) => ({
      ...group,
      section: 'conversations' as const,
    })),
  ];
}

export function groupSessionsForSidebar(
  sessions: readonly SessionSummary[],
  mode: SessionListMode,
  now = Date.now(),
  defaultWorkspacePath?: string,
  removedProjectPaths: readonly string[] = [],
): SidebarSessionGroup[] {
  if (mode === 'kind') {
    return groupByKind(sessions, defaultWorkspacePath, now, removedProjectPaths);
  }
  return mode === 'workspace' ? groupByWorkspace(sessions) : groupByTime(sessions, now);
}
