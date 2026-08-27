/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnterpriseAccount, EnterpriseOrganizationView } from '../../preload/index.js';
import { OrganizationPage } from './OrganizationPage.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

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
    id: 'account-park-admin',
    username: 'park.admin',
    name: '园区管理员',
    role: '企业管理员',
    department: '园区运营部',
    departmentId: 'department-operations',
    positionId: null,
    positionTitle: '总经理',
    isAdmin: true,
    status: 'active',
    ottoOnline: true,
  }, {
    id: 'account-operations',
    username: 'park.operations',
    name: '运营专员',
    role: '园区运营',
    department: '园区运营部',
    departmentId: 'department-operations',
    positionId: null,
    positionTitle: '专员',
    isAdmin: false,
    status: 'active',
    ottoOnline: false,
  }],
  employeeCount: 2,
  structure: [{
    id: 'department-operations',
    organizationId: 'organization-park-admin',
    name: '园区运营部',
    parentDepartmentId: null,
    memberCount: 2,
    positions: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  }],
  park: {
    id: 'park-hongchuang',
    name: '北控宏创科技园',
    slug: 'hongchuang-park',
    brandName: '北控宏创科技园',
    adminOrganizationId: 'organization-park-admin',
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    isAdminOrganization: true,
  },
};

describe('OrganizationPage park administration overview', () => {
  it('始终展示园区管理企业自身，并可进入自己的完整组织架构', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ownOrganizationView);
    const enterpriseParkTenants = vi.fn(async () => []);
    Object.assign(window.otto, {
      enterpriseOrganizationView,
      enterpriseParkTenants,
    });

    render(
      <OrganizationPage
        enterpriseAccount={parkAdminAccount}
        onBack={vi.fn()}
      />,
    );

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
