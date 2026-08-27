/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnterpriseAccount, EnterpriseOrganizationView } from '../../preload/index.js';
import { OrganizationPage } from './OrganizationPage.js';

const account: EnterpriseAccount = {
  id: 'account-a', organizationId: 'org-a', organizationName: '测试企业',
  accountType: 'enterprise', employeeId: null, username: 'alice', phone: null,
  name: 'Alice', role: '成员', department: '产品部', positionId: null,
  positionTitle: null, isAdmin: false, status: 'active', tags: [],
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
};

const parkAdminAccount: EnterpriseAccount = {
  id: 'account-park-admin',
  organizationId: 'organization-park-admin',
  organizationName: '北控宏创科技有限公司',
  employeeId: null,
  username: 'park.admin',
  phone: '+8613800138000',
  name: '园区管理员',
  role: '企业管理员',
  department: '园区运营部',
  departmentId: 'department-operations',
  positionId: null,
  positionTitle: '总经理',
  isAdmin: true,
  status: 'active',
  tags: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
};

const ownOrganizationView: EnterpriseOrganizationView = {
  organization: {
    id: 'organization-park-admin',
    name: '北控宏创科技有限公司',
    status: 'active',
    industry: '产业园运营',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
  members: [{
    id: 'account-park-admin', username: 'park.admin', name: '园区管理员',
    role: '企业管理员', department: '园区运营部', departmentId: 'department-operations',
    positionId: null, positionTitle: '总经理', isAdmin: true, status: 'active', ottoOnline: true,
  }, {
    id: 'account-operations', username: 'park.operations', name: '运营专员',
    role: '园区运营', department: '园区运营部', departmentId: 'department-operations',
    positionId: null, positionTitle: '专员', isAdmin: false, status: 'active', ottoOnline: false,
  }],
  employeeCount: 2,
  structure: [{
    id: 'department-operations', organizationId: 'organization-park-admin',
    name: '园区运营部', parentDepartmentId: null, memberCount: 2, positions: [],
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
  }],
  park: {
    id: 'park-hongchuang', name: '北控宏创科技园', slug: 'hongchuang-park',
    brandName: '北控宏创科技园', adminOrganizationId: 'organization-park-admin',
    status: 'active', createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z', isAdminOrganization: true,
  },
};

beforeEach(() => {
  Object.assign(window.otto, {
    enterpriseOrganizationView: vi.fn(async () => ({
      organization: {
        id: 'org-a', name: '测试企业', status: 'active' as const,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
      members: [], employeeCount: 0, structure: [],
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('OrganizationPage contacts integration', () => {
  it('renders Product Workspace friends inside the organization page', async () => {
    render(<OrganizationPage
      enterpriseAccount={account}
      friends={[{
        id: 'friend-a', displayName: '常用同事', note: '财务',
        createdAt: '2026-08-01T00:00:00.000Z',
      }]}
      onBack={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByText('常用同事')).toBeTruthy());
    expect(screen.getByText('财务')).toBeTruthy();
  });

  it('delegates contact creation to the existing Product Workspace action', async () => {
    const onAddFriend = vi.fn();
    render(<OrganizationPage
      enterpriseAccount={account}
      friends={[]}
      onAddFriend={onAddFriend}
      onBack={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByRole('heading', { name: '常用联系人' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('联系人姓名'), { target: { value: '李雷' } });
    fireEvent.change(screen.getByLabelText('联系人备注'), { target: { value: '合作伙伴' } });
    fireEvent.click(screen.getByRole('button', { name: '添加联系人' }));

    expect(onAddFriend).toHaveBeenCalledWith('李雷', '合作伙伴');
  });
});

describe('OrganizationPage park administration overview', () => {
  it('始终展示园区管理企业自身，并可进入自己的完整组织架构', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ownOrganizationView);
    const enterpriseParkTenants = vi.fn(async () => []);
    Object.assign(window.otto, { enterpriseOrganizationView, enterpriseParkTenants });

    render(<OrganizationPage enterpriseAccount={parkAdminAccount} onBack={vi.fn()} />);

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledWith(undefined));
    await waitFor(() => expect(enterpriseParkTenants).toHaveBeenCalledOnce());

    const ownerSection = screen.getByRole('region', { name: '园区管理企业' });
    expect(within(ownerSection).getByText('北控宏创科技有限公司')).toBeTruthy();
    expect(within(ownerSection).getByText('管理方')).toBeTruthy();
    expect(within(ownerSection).getByText('2 人 · 1 个部门')).toBeTruthy();
    expect(screen.getByText('暂无入驻企业')).toBeTruthy();
    expect(screen.getByLabelText('园区概览数据').textContent).toContain('园区员工2人');

    fireEvent.click(within(ownerSection).getByRole('button', { name: /查看本企业架构/ }));

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledWith(
      'organization-park-admin',
    ));
    expect(screen.getByRole('button', { name: '返回园区总览' })).toBeTruthy();
    expect(screen.getByRole('tree', { name: '北控宏创科技有限公司组织架构' })).toBeTruthy();
    expect(screen.getByText('园区管理员')).toBeTruthy();
    expect(screen.getByText('运营专员')).toBeTruthy();
  });
});
