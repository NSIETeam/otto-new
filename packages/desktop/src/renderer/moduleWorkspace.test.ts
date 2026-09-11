import { describe, expect, it } from 'vitest';

import {
  addOrMoveModules,
  createModuleGroup,
  createParkServicesModuleGroup,
  createDefaultModuleWorkspace,
  deleteModuleGroup,
  getModuleWorkspaceStorageKey,
  normalizeModuleWorkspace,
  parseModuleWorkspace,
  removeModuleFromGroup,
  renameModuleGroup,
  reorderModuleGroups,
  reorderModulesInGroup,
  resolveModuleGridColumns,
  restoreDefaultModuleWorkspace,
  updateGroupModuleSelection,
  updateModuleGroupRows,
  validateModuleGroupName,
  type ModuleWorkspaceCapabilities,
  type ModuleWorkspaceLayout,
} from './moduleWorkspace.js';

const enterpriseCapabilities: ModuleWorkspaceCapabilities = {
  edition: 'enterprise',
  availableModuleIds: [
    'park-announcement',
    'park-satisfaction',
    'park-renovation',
    'park-parking',
    'park-network-phone',
    'park-meeting-room',
    'park-carpool',
    'agent-enterprise-work',
    'agent-ppt',
    'agent-meeting',
    'agent-word',
    'agent-excel',
    'enterprise-memory',
    'policy-intelligence',
  ],
};

const personalCapabilities: ModuleWorkspaceCapabilities = {
  edition: 'personal',
  availableModuleIds: ['agent-personal-otto', 'auto-skill'],
};

const sampleLayout = (): ModuleWorkspaceLayout => ({
  version: 1,
  groups: [
    {
      id: 'park-services',
      name: '园区服务',
      rows: 2,
      moduleIds: ['park-announcement', 'park-satisfaction'],
    },
    {
      id: 'daily-office',
      name: '日常办公',
      rows: 2,
      moduleIds: ['agent-ppt', 'agent-word'],
    },
  ],
});

describe('module workspace defaults', () => {
  it('migrates the official recruitment group into one module without touching unrelated groups', () => {
    const old: ModuleWorkspaceLayout = { version: 1, groups: [
      { id: 'daily-office', name: '我的办公', rows: 2, moduleIds: ['agent-ppt'] },
      { id: 'smart-recruitment', name: '智能招聘', rows: 3, moduleIds: ['recruitment-resume-analysis', 'recruitment-interview-kit'],
        package: { source: 'official', packageId: 'otto.group.smart-recruitment', publisherId: 'otto.official', version: '2.0.0' } },
    ] };
    const next = parseModuleWorkspace(JSON.stringify(old), enterpriseCapabilities);
    expect(next.groups).toHaveLength(1);
    expect(next.groups[0]).toMatchObject({ name: '我的办公', moduleIds: ['agent-ppt', 'recruitment-intelligence'] });
    expect(parseModuleWorkspace(JSON.stringify(next), enterpriseCapabilities)).toEqual(next);
    const removed = removeModuleFromGroup(next, 'daily-office', 'recruitment-intelligence');
    expect(parseModuleWorkspace(JSON.stringify(removed), enterpriseCapabilities).groups[0].moduleIds).toEqual(['agent-ppt']);
  });
  it('keeps custom layouts and modules while deduplicating legacy recruitment shortcuts', () => {
    const layout = parseModuleWorkspace(JSON.stringify({ version: 1, groups: [
      { id: 'custom', name: '我的招聘', rows: 3, moduleIds: ['recruitment-evidence-graph', 'custom-tool'] },
      { id: 'smart-recruitment', name: '智能招聘', rows: 3, moduleIds: ['recruitment-interview-audio', 'agent-ppt'],
        package: { source: 'official', packageId: 'otto.group.smart-recruitment', publisherId: 'otto.official', version: '2.0.0' } },
    ] }), enterpriseCapabilities);
    expect(layout.groups[0]).toMatchObject({ name: '我的招聘', rows: 3, moduleIds: ['recruitment-intelligence', 'custom-tool'] });
    expect(layout.groups[1]).toMatchObject({ moduleIds: ['agent-ppt'] });
    expect(layout.groups.flatMap(group => group.moduleIds).filter(id => id === 'recruitment-intelligence')).toHaveLength(1);
  });
  it('creates a daily-office destination when the only installed group is recruitment', () => {
    const result = parseModuleWorkspace(JSON.stringify({ version: 1, groups: [
      { id: 'smart-recruitment', name: '智能招聘', rows: 3, moduleIds: ['recruitment-privacy-audit'] },
    ] }), enterpriseCapabilities);
    expect(result.groups).toEqual([{ id: 'daily-office', name: '日常办公', rows: 2, moduleIds: ['recruitment-intelligence'] }]);
  });
  it('auto-installs only the official daily-office group for a new enterprise workspace', () => {
    expect(createDefaultModuleWorkspace(enterpriseCapabilities)).toEqual({
      version: 1,
      groups: [
        {
          id: 'daily-office',
          name: '日常办公',
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
          package: {
            source: 'official',
            packageId: 'otto.group.daily-office',
            publisherId: 'otto.official',
            version: '1.2.0',
          },
        },
      ],
    });
  });

  it('does not synthesize enterprise or park modules for personal edition', () => {
    const layout = createDefaultModuleWorkspace(personalCapabilities);
    const moduleIds = layout.groups.flatMap((group) => group.moduleIds);

    expect(layout.groups).toHaveLength(1);
    expect(moduleIds).toEqual(['agent-personal-otto', 'auto-skill']);
    expect(moduleIds.some((id) => id.startsWith('park-'))).toBe(false);
    expect(moduleIds).not.toContain('enterprise-memory');
    expect(moduleIds).not.toContain('agent-enterprise-work');
  });

  it('recomputes restored defaults from the current capability snapshot', () => {
    const restored = restoreDefaultModuleWorkspace(sampleLayout(), personalCapabilities);

    expect(restored).toEqual(createDefaultModuleWorkspace(personalCapabilities));
  });
});

describe('module workspace parsing and normalization', () => {
  it('falls back for corrupt or unsupported records', () => {
    const defaults = createDefaultModuleWorkspace(enterpriseCapabilities);

    expect(parseModuleWorkspace('{bad json', enterpriseCapabilities)).toEqual(defaults);
    expect(parseModuleWorkspace(JSON.stringify({ version: 99 }), enterpriseCapabilities)).toEqual(defaults);
  });

  it('migrates ordinary park services without rearranging existing modules', () => {
    const parsed = parseModuleWorkspace(JSON.stringify({
      version: 1,
      groups: [
        {
          id: 'park-services', name: '园区服务', rows: 2,
          moduleIds: ['park-announcement', 'park-repair', 'park-meeting-room'],
        },
        { id: 'daily-office', name: '日常办公', rows: 2, moduleIds: ['agent-ppt'] },
      ],
    }), enterpriseCapabilities);

    expect(parsed.groups[0].moduleIds).toEqual(['park-announcement', 'park-repair', 'park-meeting-room', 'park-satisfaction', 'park-renovation', 'park-parking', 'park-network-phone', 'park-carpool']);
  });

  it('migrates the official daily-office group once to add policy intelligence', () => {
    const parsed = parseModuleWorkspace(JSON.stringify({
      version: 1,
      groups: [{
        id: 'daily-office', name: '日常办公', rows: 2,
        moduleIds: ['agent-ppt', 'enterprise-memory'],
        package: { source: 'official', packageId: 'otto.group.daily-office', publisherId: 'otto.official', version: '1.0.0' },
      }],
    }), enterpriseCapabilities);

    expect(parsed.groups[0].moduleIds).toContain('policy-intelligence');
    expect(parsed.groups[0].package?.version).toBe('1.2.0');
    expect(parseModuleWorkspace(JSON.stringify({
      ...parsed,
      groups: parsed.groups.map((group) => ({ ...group, moduleIds: group.moduleIds.filter((id) => id !== 'policy-intelligence') })),
    }), enterpriseCapabilities).groups[0].moduleIds).not.toContain('policy-intelligence');
  });

  it('upgrades an installed enterprise-memory experience without restoring a removed module', () => {
    const upgraded = parseModuleWorkspace(JSON.stringify({
      version: 1,
      groups: [{
        id: 'daily-office', name: '日常办公', rows: 2,
        moduleIds: ['agent-ppt', 'enterprise-memory'],
        package: { source: 'official', packageId: 'otto.group.daily-office', publisherId: 'otto.official', version: '1.1.0' },
      }],
    }), enterpriseCapabilities);
    expect(upgraded.groups[0].package?.version).toBe('1.2.0');

    const removed = parseModuleWorkspace(JSON.stringify({
      ...upgraded,
      groups: upgraded.groups.map((group) => ({
        ...group,
        moduleIds: group.moduleIds.filter((id) => id !== 'enterprise-memory'),
      })),
    }), enterpriseCapabilities);
    expect(removed.groups[0].moduleIds).not.toContain('enterprise-memory');
  });

  it('migrates an installed Hongchuang group once to add carpool without restoring it after removal', () => {
    const parsed = parseModuleWorkspace(JSON.stringify({
      version: 1,
      groups: [{
        id: 'park-services', name: '宏创园区服务', rows: 3,
        moduleIds: ['park-announcement', 'park-repair'],
        package: {
          source: 'official',
          packageId: 'otto.group.hongchuang-park-services',
          publisherId: 'otto.official',
          version: '1.1.0',
        },
      }],
    }), enterpriseCapabilities);

    expect(parsed.groups[0].moduleIds).toContain('park-carpool');
    expect(parsed.groups[0].package?.version).toBe('1.2.0');

    const afterRemoval = parseModuleWorkspace(JSON.stringify({
      ...parsed,
      groups: parsed.groups.map((group) => ({
        ...group,
        moduleIds: group.moduleIds.filter((id) => id !== 'park-carpool'),
      })),
    }), enterpriseCapabilities);
    expect(afterRemoval.groups[0].moduleIds).not.toContain('park-carpool');
    expect(afterRemoval.groups[0].package?.version).toBe('1.2.0');
  });

  it('adds carpool once to custom park groups while preserving other groups and manual removal', () => {
    const original = {version: 1, groups: [
      {id: 'custom-park', name: '园区服务', rows: 3, moduleIds: ['park-repair', 'park-announcement']},
      {id: 'custom-other', name: '其他', rows: 2, moduleIds: ['park-meeting-room', 'agent-ppt']},
    ]};
    const migrated = parseModuleWorkspace(JSON.stringify(original), enterpriseCapabilities);
    expect(migrated.groups[0].moduleIds).toEqual(['park-repair', 'park-announcement', 'park-satisfaction', 'park-renovation', 'park-parking', 'park-network-phone', 'park-carpool']);
    expect(migrated.groups[1]).toMatchObject(original.groups[1]);
    const removed = {...migrated, groups: migrated.groups.map(g => ({...g, moduleIds: g.moduleIds.filter(id => id !== 'park-carpool')}))};
    expect(parseModuleWorkspace(JSON.stringify(removed), enterpriseCapabilities).groups.flatMap(g=>g.moduleIds)).not.toContain('park-carpool');
    const unavailable = {...enterpriseCapabilities, availableModuleIds: enterpriseCapabilities.availableModuleIds.filter(id=>id !== 'park-carpool')};
    const delayed = parseModuleWorkspace(JSON.stringify(original), unavailable);
    expect(parseModuleWorkspace(JSON.stringify(delayed), enterpriseCapabilities).groups[0].moduleIds).toContain('park-carpool');
    const moved = {...original, groups: [...original.groups, {id:'mine',name:'我的',rows:2,moduleIds:['park-carpool']}]};
    expect(parseModuleWorkspace(JSON.stringify(moved), enterpriseCapabilities).groups[2].moduleIds).toContain('park-carpool');
  });

  it('deduplicates module IDs globally, repairs group IDs, clamps rows, and keeps unknown modules', () => {
    const normalized = normalizeModuleWorkspace({
      version: 1,
      groups: [
        {
          id: 'same',
          name: '  园区服务  ',
          rows: 99,
          moduleIds: ['park-announcement', 'future-module', 'park-announcement'],
        },
        {
          id: 'same',
          name: '日常办公',
          rows: 3,
          moduleIds: ['future-module', 'agent-ppt'],
        },
      ],
    });

    expect(normalized.groups[0]).toMatchObject({
      id: 'same',
      name: '园区服务',
      rows: 2,
      moduleIds: ['park-announcement', 'future-module'],
    });
    expect(normalized.groups[1]).toMatchObject({
      id: 'same-2',
      rows: 3,
      moduleIds: ['agent-ppt'],
    });
  });

  it('truncates long names and supplies a safe name for blank groups', () => {
    const normalized = normalizeModuleWorkspace({
      version: 1,
      groups: [
        { id: 'blank', name: '   ', rows: 2, moduleIds: [] },
        { id: 'long', name: '很'.repeat(80), rows: 2, moduleIds: [] },
      ],
    });

    expect(normalized.groups[0].name).toBe('未命名功能组');
    expect(normalized.groups[1].name).toHaveLength(40);
  });
});

describe('module workspace layout operations', () => {
  it('resolves two columns only for a genuinely narrow side panel', () => {
    expect(resolveModuleGridColumns('panel', 240)).toBe(2);
    expect(resolveModuleGridColumns('panel', 250)).toBe(2);
    expect(resolveModuleGridColumns('panel', 251)).toBe(3);
    expect(resolveModuleGridColumns('panel', 0)).toBe(3);
    expect(resolveModuleGridColumns('page', 220)).toBe(3);
  });

  it('creates groups with stable unique default names and IDs', () => {
    const first = createModuleGroup(sampleLayout());
    const second = createModuleGroup(first);

    expect(first.groups.at(-1)).toMatchObject({
      id: 'custom-group', name: '新功能组', rows: 2, moduleIds: [],
      package: { source: 'user', packageId: 'user.group.custom-group' },
    });
    expect(second.groups.at(-1)).toMatchObject({
      id: 'custom-group-2', name: '新功能组 2', rows: 2, moduleIds: [],
      package: { source: 'user', packageId: 'user.group.custom-group-2' },
    });
  });

  it('adds park services as one complete function group and removes duplicate park entries', () => {
    const withoutParkGroup: ModuleWorkspaceLayout = {
      version: 1,
      groups: [{
        id: 'daily-office', name: '日常办公', rows: 2,
        moduleIds: ['agent-ppt', 'park-announcement'],
      }],
    };
    const next = createParkServicesModuleGroup(withoutParkGroup, [
      'park-announcement', 'park-repair', 'park-parking',
    ]);

    expect(next.groups[0].moduleIds).toEqual(['agent-ppt']);
    expect(next.groups[1]).toEqual({
      id: 'park-services',
      name: '园区服务',
      rows: 2,
      moduleIds: ['park-announcement', 'park-parking', 'park-repair'],
    });
    expect(createParkServicesModuleGroup(next, ['park-announcement'])).toBe(next);
  });

  it('rejects blank and duplicate group names without mutating layout', () => {
    expect(validateModuleGroupName(sampleLayout(), 'park-services', '   ')).toBe('功能组名称不能为空');
    expect(validateModuleGroupName(sampleLayout(), 'park-services', '日常办公')).toBe('功能组名称不能重复');
    expect(validateModuleGroupName(sampleLayout(), 'park-services', '园区协作')).toBeNull();
  });

  it('moves modules between groups without duplicates', () => {
    const next = addOrMoveModules(sampleLayout(), 'park-services', ['agent-ppt', 'agent-excel']);

    expect(next.groups[0].moduleIds).toEqual([
      'park-announcement',
      'park-satisfaction',
      'agent-ppt',
      'agent-excel',
    ]);
    expect(next.groups[1].moduleIds).toEqual(['agent-word']);
  });

  it('applies additions and removals for one group as a single selection', () => {
    const next = updateGroupModuleSelection(
      sampleLayout(),
      'park-services',
      ['park-satisfaction', 'agent-ppt', 'agent-excel', 'agent-ppt'],
    );

    expect(next.groups[0].moduleIds).toEqual([
      'park-satisfaction',
      'agent-ppt',
      'agent-excel',
    ]);
    expect(next.groups[1].moduleIds).toEqual(['agent-word']);
  });

  it('ignores a group selection update when the target group does not exist', () => {
    const current = sampleLayout();

    expect(updateGroupModuleSelection(current, 'missing', ['agent-ppt'])).toBe(current);
  });

  it('removes only the requested module from layout', () => {
    const next = removeModuleFromGroup(sampleLayout(), 'daily-office', 'agent-ppt');

    expect(next.groups[1].moduleIds).toEqual(['agent-word']);
  });

  it('protects the last group and removes deleted group modules from the workspace', () => {
    const oneGroup = { version: 1 as const, groups: [sampleLayout().groups[0]] };
    expect(deleteModuleGroup(oneGroup, 'park-services')).toEqual(oneGroup);

    const next = deleteModuleGroup(sampleLayout(), 'park-services');
    expect(next.groups.map((group) => group.id)).toEqual(['daily-office']);
    expect(next.groups[0].moduleIds).toEqual(['agent-ppt', 'agent-word']);
    expect(next.groups.flatMap((group) => group.moduleIds)).not.toContain(
      'park-announcement',
    );
  });

  it('renames, updates row count, and reorders groups and modules', () => {
    const renamed = renameModuleGroup(sampleLayout(), 'daily-office', '  我的办公  ');
    const resized = updateModuleGroupRows(renamed, 'daily-office', 3);
    const groupsReordered = reorderModuleGroups(resized, ['daily-office', 'park-services']);
    const modulesReordered = reorderModulesInGroup(
      groupsReordered,
      'daily-office',
      ['agent-word', 'agent-ppt'],
    );

    expect(modulesReordered.groups[0]).toMatchObject({
      id: 'daily-office',
      name: '我的办公',
      rows: 3,
      moduleIds: ['agent-word', 'agent-ppt'],
    });
  });
});

describe('module workspace storage scope', () => {
  it('normalizes server URL and separates edition, organization, and account', () => {
    const first = getModuleWorkspaceStorageKey({
      serverUrl: ' HTTPS://EXAMPLE.COM/// ',
      edition: 'enterprise',
      organizationId: 'org-a',
      accountId: 'user-a',
    });
    const same = getModuleWorkspaceStorageKey({
      serverUrl: 'https://example.com',
      edition: 'enterprise',
      organizationId: 'org-a',
      accountId: 'user-a',
    });
    const personal = getModuleWorkspaceStorageKey({
      serverUrl: 'https://example.com',
      edition: 'personal',
      accountId: 'user-a',
    });

    expect(first).toBe(same);
    expect(first).not.toBe(personal);
    expect(first).toContain('https%3A%2F%2Fexample.com');
  });
});

describe('legacy park module additive migration', () => {
  it('adds newly authorized legacy entries once without moving existing or restoring removed entries', () => {
    const input = {
      version: 1,
      groups: [
        {
          id: 'park-services',
          name: '园区服务',
          rows: 2,
          moduleIds: ['park-repair', 'park-announcement'],
        },
        {
          id: 'other',
          name: '其他',
          rows: 2,
          moduleIds: ['park-meeting-room'],
        },
      ],
    };
    const limited = {
      ...enterpriseCapabilities,
      availableModuleIds: [
        'park-announcement',
        'park-repair',
        'park-meeting-room',
      ],
    };
    const first = parseModuleWorkspace(JSON.stringify(input), limited);
    const upgraded = parseModuleWorkspace(JSON.stringify(first), {
      ...limited,
      availableModuleIds: [...limited.availableModuleIds, 'park-satisfaction'],
    });
    expect(upgraded.groups[0].moduleIds).toEqual([
      'park-repair',
      'park-announcement',
      'park-satisfaction',
    ]);
    expect(upgraded.groups[1].moduleIds).toEqual(['park-meeting-room']);
    const removed = removeModuleFromGroup(
      upgraded,
      'park-services',
      'park-satisfaction',
    );
    const revoked = parseModuleWorkspace(JSON.stringify(removed), limited);
    expect(
      parseModuleWorkspace(JSON.stringify(revoked), enterpriseCapabilities)
        .groups[0].moduleIds,
    ).not.toContain('park-satisfaction');
  });
});
