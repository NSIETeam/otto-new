/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { ModuleIconSource } from './components/ModuleIcon.js';
import {
  OTTO_OFFICIAL_PUBLISHER_ID,
  type ComponentPackageReference,
} from './modulePackages.js';
import type {
  ModuleGroupLayout,
  ModuleWorkspaceEdition,
  ModuleWorkspaceLayout,
} from './moduleWorkspace.js';

export interface ModuleGroupTemplateDefinition {
  package: ComponentPackageReference;
  groupId: string;
  name: string;
  description: string;
  icon: ModuleIconSource;
  editions: readonly ModuleWorkspaceEdition[];
  rows: 2 | 3;
  moduleIds: readonly string[];
  autoInstall: boolean;
  access: 'all-enterprises' | 'hongchuang-park-members';
}

export type ModuleGroupTemplateInstallState = 'available' | 'update' | 'installed';

export interface ModuleGroupParkIdentity {
  name: string;
  slug: string;
  status: 'active' | 'disabled';
}

export interface ModuleGroupCatalogAccessContext {
  park: ModuleGroupParkIdentity | null;
}

export interface ModuleGroupTemplateAccess {
  allowed: boolean;
  reason?: string;
}

const HONGCHUANG_PARK_NAMES = new Set(['北控宏创科技园']);
const HONGCHUANG_PARK_SLUGS = new Set([
  'hongchuang',
  'hongchuang-park',
  'beikong-hongchuang',
  'beikong-hongchuang-technology-park',
]);

export const HONGCHUANG_PARK_SERVICE_MODULE_IDS = [
  'park-announcement',
  'park-satisfaction',
  'park-renovation',
  'park-parking',
  'park-network-phone',
  'park-meeting-room',
  'park-electric-card',
  'park-repair',
  'park-vehicle-visit',
  'park-enterprise-star-map',
  'park-carpool',
] as const;

export const SMART_RECRUITMENT_MODULE_IDS = [
  'recruitment-resume-analysis',
  'recruitment-candidate-screening',
  'recruitment-interview-audio',
  'recruitment-interview-kit',
  'recruitment-privacy-audit',
] as const;

export const OFFICIAL_MODULE_GROUP_TEMPLATES: readonly ModuleGroupTemplateDefinition[] = [
  {
    package: {
      source: 'official',
      packageId: 'otto.group.hongchuang-park-services',
      publisherId: OTTO_OFFICIAL_PUBLISHER_ID,
      version: '1.2.0',
    },
    groupId: 'park-services',
    name: '宏创园区服务',
    description: '面向北控宏创科技园的十一项官方能力，新增隐私友好的拼车匹配助手。',
    icon: 'park-overview',
    editions: ['enterprise'],
    rows: 3,
    moduleIds: HONGCHUANG_PARK_SERVICE_MODULE_IDS,
    autoInstall: false,
    access: 'hongchuang-park-members',
  },
  {
    package: {
      source: 'official',
      packageId: 'otto.group.smart-recruitment',
      publisherId: OTTO_OFFICIAL_PUBLISHER_ID,
      version: '1.0.0',
    },
    groupId: 'smart-recruitment',
    name: '智能招聘',
    description: '基于脱敏简历全文进行语义评估、批量横向比较和针对性面试设计，并保留音频分析与隐私审计；所有招聘决定均由人员复核确认。',
    icon: 'generated:agent-hr-recruiting',
    editions: ['enterprise'],
    rows: 2,
    moduleIds: SMART_RECRUITMENT_MODULE_IDS,
    autoInstall: false,
    access: 'all-enterprises',
  },
  {
    package: {
      source: 'official',
      packageId: 'otto.group.daily-office',
      publisherId: OTTO_OFFICIAL_PUBLISHER_ID,
      version: '1.1.0',
    },
    groupId: 'daily-office',
    name: '日常办公',
    description: 'Otto 官方办公专家与企业记忆入口。',
    icon: 'agent',
    editions: ['enterprise'],
    rows: 2,
    moduleIds: [
      'agent-enterprise-work',
      'agent-ppt',
      'agent-meeting',
      'agent-word',
      'agent-excel',
      'enterprise-memory',
      'policy-intelligence',
    ],
    autoInstall: true,
    access: 'all-enterprises',
  },
] as const;

export function listModuleGroupTemplates(
  edition: ModuleWorkspaceEdition,
): readonly ModuleGroupTemplateDefinition[] {
  return OFFICIAL_MODULE_GROUP_TEMPLATES.filter((template) => (
    template.editions.includes(edition)
  ));
}

function normalizeParkIdentity(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN');
}

/**
 * Decide whether the current server-authenticated enterprise may install a
 * template. Park identity comes from enterpriseParkView(), never local input.
 */
export function getModuleGroupTemplateAccess(
  template: ModuleGroupTemplateDefinition,
  context?: ModuleGroupCatalogAccessContext,
): ModuleGroupTemplateAccess {
  if (template.access === 'all-enterprises') return { allowed: true };
  const park = context?.park;
  if (!park || park.status !== 'active') {
    return {
      allowed: false,
      reason: '仅加入北控宏创科技园的企业可添加',
    };
  }
  const name = normalizeParkIdentity(park.name);
  const slug = normalizeParkIdentity(park.slug);
  const allowed = HONGCHUANG_PARK_NAMES.has(name) || HONGCHUANG_PARK_SLUGS.has(slug);
  return allowed
    ? { allowed: true }
    : {
      allowed: false,
      reason: `当前企业属于“${park.name || '其他园区'}”，仅北控宏创科技园企业可添加`,
    };
}

function findInstalledGroup(
  layout: ModuleWorkspaceLayout,
  template: ModuleGroupTemplateDefinition,
): ModuleGroupLayout | undefined {
  return layout.groups.find((group) => (
    group.package?.packageId === template.package.packageId
    || group.id === template.groupId
  ));
}

export function getModuleGroupTemplateInstallState(
  layout: ModuleWorkspaceLayout,
  template: ModuleGroupTemplateDefinition,
): ModuleGroupTemplateInstallState {
  const group = findInstalledGroup(layout, template);
  if (!group) return 'available';
  const installed = new Set(group.moduleIds);
  const complete = template.moduleIds.every((moduleId) => installed.has(moduleId));
  return complete && group.package?.version === template.package.version
    ? 'installed'
    : 'update';
}

function uniqueId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

/** Install a whole group atomically while preserving the global one-module/one-group rule. */
export function installModuleGroupTemplate(
  layout: ModuleWorkspaceLayout,
  template: ModuleGroupTemplateDefinition,
  accessContext?: ModuleGroupCatalogAccessContext,
): ModuleWorkspaceLayout {
  if (!getModuleGroupTemplateAccess(template, accessContext).allowed) return layout;
  const existing = findInstalledGroup(layout, template);
  if (getModuleGroupTemplateInstallState(layout, template) === 'installed') return layout;
  const moving = new Set(template.moduleIds);
  const retainedGroups = layout.groups.map((group) => ({
    ...group,
    package: group.package ? { ...group.package } : undefined,
    moduleIds: group.moduleIds.filter((moduleId) => !moving.has(moduleId)),
  }));

  if (existing) {
    return {
      ...layout,
      groups: retainedGroups.map((group) => group.id === existing.id
        ? {
          ...group,
          name: template.name,
          rows: template.rows,
          moduleIds: [...template.moduleIds],
          package: { ...template.package },
        }
        : group),
    };
  }

  const ids = new Set(retainedGroups.map((group) => group.id));
  const names = new Set(retainedGroups.map((group) => group.name));
  return {
    ...layout,
    groups: [...retainedGroups, {
      id: uniqueId(template.groupId, ids),
      name: uniqueName(template.name, names),
      rows: template.rows,
      moduleIds: [...template.moduleIds],
      package: { ...template.package },
    }],
  };
}
