import { describe, expect, it } from 'vitest';

import {
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

describe('official module group catalog', () => {
  it('defines the Hongchuang park group as exactly nine official service modules', () => {
    expect(parkTemplate.name).toBe('宏创园区服务');
    expect(parkTemplate.moduleIds).toEqual(HONGCHUANG_PARK_SERVICE_MODULE_IDS);
    expect(parkTemplate.moduleIds).toHaveLength(9);
    expect(parkTemplate.package).toEqual({
      source: 'official',
      packageId: 'otto.group.hongchuang-park-services',
      publisherId: 'otto.official',
      version: '1.0.0',
    });
  });

  it('does not expose enterprise-only official groups to a personal workspace', () => {
    expect(listModuleGroupTemplates('personal')).toEqual([]);
  });

  it('defines intelligent recruitment as one official five-function group', () => {
    expect(recruitmentTemplate).toMatchObject({
      name: '智能招聘',
      groupId: 'smart-recruitment',
      rows: 2,
      autoInstall: false,
      package: {
        source: 'official',
        packageId: 'otto.group.smart-recruitment',
        publisherId: 'otto.official',
        version: '1.0.0',
      },
    });
    expect(recruitmentTemplate.moduleIds).toEqual(SMART_RECRUITMENT_MODULE_IDS);
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
    const installed = installModuleGroupTemplate(legacy, parkTemplate);
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
    expect(installModuleGroupTemplate(installed, parkTemplate)).toBe(installed);
  });

  it('adds the official group to a new layout with all nine IDs retained', () => {
    const layout: ModuleWorkspaceLayout = {
      version: 1,
      groups: [{ id: 'daily-office', name: '日常办公', rows: 2, moduleIds: ['agent-ppt'] }],
    };
    const installed = installModuleGroupTemplate(layout, parkTemplate);

    expect(getModuleGroupTemplateInstallState(layout, parkTemplate)).toBe('available');
    expect(installed.groups.at(-1)).toMatchObject({
      id: 'park-services',
      name: '宏创园区服务',
      moduleIds: HONGCHUANG_PARK_SERVICE_MODULE_IDS,
    });
  });
});
