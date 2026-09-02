import { describe, expect, it } from 'vitest';

import {
  getModuleGroupTemplateAccess,
  getModuleGroupTemplateInstallState,
  HONGCHUANG_PARK_SERVICE_MODULE_IDS,
  SMART_RECRUITMENT_MODULE_IDS,
  installModuleGroupTemplate,
  listModuleGroupTemplates,
} from './moduleGroupCatalog.js';
import type { ModuleWorkspaceLayout } from './moduleWorkspace.js';

const parkTemplate = listModuleGroupTemplates('enterprise').find((template) => (
  template.package.packageId === 'otto.group.hongchuang-park-services'
))!;
const recruitmentTemplate = listModuleGroupTemplates('enterprise').find((template) => (
  template.package.packageId === 'otto.group.smart-recruitment'
))!;
const dailyOfficeTemplate = listModuleGroupTemplates('enterprise').find((template) => (
  template.package.packageId === 'otto.group.daily-office'
))!;
const hongchuangAccess = {
  park: { name: '北控宏创科技园', slug: 'hongchuang-park', status: 'active' as const },
};

describe('official module group catalog', () => {
  it('defines the Hongchuang park group as eleven official abilities including carpool', () => {
    expect(parkTemplate.name).toBe('宏创园区服务');
    expect(parkTemplate.moduleIds).toEqual(HONGCHUANG_PARK_SERVICE_MODULE_IDS);
    expect(parkTemplate.moduleIds).toHaveLength(11);
    expect(parkTemplate.moduleIds).toContain('park-enterprise-star-map');
    expect(parkTemplate.moduleIds).toContain('park-carpool');
    expect(parkTemplate.package).toEqual({
      source: 'official',
      packageId: 'otto.group.hongchuang-park-services',
      publisherId: 'otto.official',
      version: '1.2.0',
    });
  });

  it('does not expose enterprise-only official groups to a personal workspace', () => {
    expect(listModuleGroupTemplates('personal')).toEqual([]);
  });

  it('allows the park group only for an active server-authenticated Hongchuang membership', () => {
    expect(getModuleGroupTemplateAccess(parkTemplate, hongchuangAccess)).toEqual({ allowed: true });
    expect(getModuleGroupTemplateAccess(parkTemplate, {
      park: { name: '其他产业园', slug: 'another-park', status: 'active' },
    })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('仅北控宏创科技园企业可添加'),
    });
    expect(getModuleGroupTemplateAccess(parkTemplate, {
      park: { name: '北控宏创科技园', slug: 'hongchuang-park', status: 'disabled' },
    })).toMatchObject({ allowed: false });
  });

  it('defines intelligent recruitment as one official evidence-driven group', () => {
    expect(recruitmentTemplate).toMatchObject({
      name: '智能招聘',
      groupId: 'smart-recruitment',
      rows: 3,
      autoInstall: false,
      package: {
        source: 'official',
        packageId: 'otto.group.smart-recruitment',
        publisherId: 'otto.official',
        version: '2.0.0',
      },
    });
    expect(recruitmentTemplate.moduleIds).toEqual(SMART_RECRUITMENT_MODULE_IDS);
    expect(recruitmentTemplate.moduleIds).toHaveLength(8);
    expect(recruitmentTemplate.moduleIds).toContain('recruitment-evidence-graph');
    expect(recruitmentTemplate.moduleIds).toContain('recruitment-interview-copilot');
    expect(recruitmentTemplate.moduleIds).toContain('recruitment-work-sample');
  });

  it('upgrades daily office with the evidence-driven enterprise memory experience', () => {
    expect(dailyOfficeTemplate).toMatchObject({
      name: '日常办公',
      description: expect.stringContaining('持续验证'),
      package: {
        source: 'official',
        packageId: 'otto.group.daily-office',
        publisherId: 'otto.official',
        version: '1.2.0',
      },
    });
    expect(dailyOfficeTemplate.moduleIds).toContain('enterprise-memory');
  });

  it('upgrades a legacy six-module park group in place and moves duplicates atomically', () => {
    const legacy: ModuleWorkspaceLayout = {
      version: 1,
      groups: [
        {
          id: 'park-services',
          name: '园区服务',
          rows: 2,
          moduleIds: [...HONGCHUANG_PARK_SERVICE_MODULE_IDS.slice(0, 6)],
        },
        {
          id: 'daily-office',
          name: '日常办公',
          rows: 2,
          moduleIds: ['agent-ppt', 'park-repair'],
        },
      ],
    };

    expect(getModuleGroupTemplateInstallState(legacy, parkTemplate)).toBe('update');
    const installed = installModuleGroupTemplate(legacy, parkTemplate, hongchuangAccess);
    const park = installed.groups.find((group) => group.id === 'park-services');

    expect(installed.groups).toHaveLength(2);
    expect(park).toMatchObject({
      name: '宏创园区服务',
      rows: 3,
      moduleIds: HONGCHUANG_PARK_SERVICE_MODULE_IDS,
      package: parkTemplate.package,
    });
    expect(installed.groups[1].moduleIds).toEqual(['agent-ppt']);
    expect(getModuleGroupTemplateInstallState(installed, parkTemplate)).toBe('installed');
    expect(installModuleGroupTemplate(installed, parkTemplate, hongchuangAccess)).toBe(installed);
  });

  it('adds the official group to a new layout with all eleven IDs retained', () => {
    const layout: ModuleWorkspaceLayout = {
      version: 1,
      groups: [{ id: 'daily-office', name: '日常办公', rows: 2, moduleIds: ['agent-ppt'] }],
    };
    const installed = installModuleGroupTemplate(layout, parkTemplate, hongchuangAccess);

    expect(getModuleGroupTemplateInstallState(layout, parkTemplate)).toBe('available');
    expect(installed.groups.at(-1)).toMatchObject({
      id: 'park-services',
      name: '宏创园区服务',
      moduleIds: HONGCHUANG_PARK_SERVICE_MODULE_IDS,
    });
  });

  it('refuses a direct park-group install when the enterprise is not eligible', () => {
    const layout: ModuleWorkspaceLayout = {
      version: 1,
      groups: [{ id: 'daily-office', name: '日常办公', rows: 2, moduleIds: ['agent-ppt'] }],
    };

    expect(installModuleGroupTemplate(layout, parkTemplate)).toBe(layout);
    expect(installModuleGroupTemplate(layout, parkTemplate, {
      park: { name: '其他园区', slug: 'other-park', status: 'active' },
    })).toBe(layout);
  });
});
