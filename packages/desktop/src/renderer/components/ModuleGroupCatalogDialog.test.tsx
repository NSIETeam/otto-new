import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildModuleCatalog } from '../moduleCatalog.js';
import type { ModuleWorkspaceLayout } from '../moduleWorkspace.js';
import { ModuleGroupCatalogDialog } from './ModuleGroupCatalogDialog.js';

const layout: ModuleWorkspaceLayout = {
  version: 1,
  groups: [{ id: 'daily-office', name: '日常办公', rows: 2, moduleIds: ['agent-ppt'] }],
};

const modules = buildModuleCatalog({
  edition: 'enterprise',
  profiles: [],
  organizationFeatures: {
    enterprise_tree: true,
    park_service: true,
    feishu_auto_reply: true,
    direct_messages: true,
    atoa: true,
    knowledge: true,
    skill_market: true,
  },
  parkAuthorization: {
    hasParkContext: true,
    canViewStatistics: false,
    canViewStaffTasks: false,
  },
  customAgents: [],
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof ModuleGroupCatalogDialog>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ModuleGroupCatalogDialog
      open
      edition="enterprise"
      layout={layout}
      modules={modules}
      parkIdentity={{ name: '北控宏创科技园', slug: 'hongchuang-park', status: 'active' }}
      onConfirm={onConfirm}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onConfirm, onClose };
}

describe('ModuleGroupCatalogDialog', () => {
  it('shows fully enabled template availability independently of removed recruitment templates', () => {
    renderDialog({ modules: modules.map(module => ({ ...module, availability: 'available', disabledReason: undefined })) });
    const dialog = screen.getByRole('dialog', { name: '新增功能组' });
    expect(within(dialog).getAllByText(/当前均可用/).length).toBeGreaterThan(0);
    const parkCard = within(dialog).getByRole('heading', { name: '宏创园区服务' }).closest('article');
    if (!parkCard) throw new Error('missing park card');
    expect(within(parkCard).getByText('12 个功能 · 当前均可用')).toBeTruthy();
    expect(within(parkCard).queryByText(/将在企业启用对应服务后可用/)).toBeNull();
  });
  it('shows the official Hongchuang template with all nine functions and installs it atomically', () => {
    const { onConfirm, onClose } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: '新增功能组' });
    const parkCard = within(dialog).getByRole('heading', { name: '宏创园区服务' }).closest('article');
    if (!parkCard) throw new Error('missing park template card');

    expect(within(parkCard).getByText('园区公告')).toBeTruthy();
    expect(within(parkCard).getByText('满意度调查')).toBeTruthy();
    expect(within(parkCard).getByText('装修管理')).toBeTruthy();
    expect(within(parkCard).getByText('停车办理')).toBeTruthy();
    expect(within(parkCard).getByText('网络与固话')).toBeTruthy();
    expect(within(parkCard).getByText('会议室预约')).toBeTruthy();
    expect(within(parkCard).getByText('电卡服务')).toBeTruthy();
    expect(within(parkCard).getByText('物业报修')).toBeTruthy();
    expect(within(parkCard).getByText('车辆与访客')).toBeTruthy();

    fireEvent.click(within(parkCard).getByRole('button', { name: '添加功能组' }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      groups: expect.arrayContaining([
        expect.objectContaining({
          name: '宏创园区服务',
          moduleIds: expect.arrayContaining([
            'park-announcement',
            'park-satisfaction',
            'park-renovation',
            'park-parking',
            'park-network-phone',
            'park-meeting-room',
            'park-electric-card',
            'park-repair',
            'park-vehicle-visit',
          ]),
          package: expect.objectContaining({ source: 'official' }),
        }),
      ]),
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps a separate local-user path for a blank custom group', () => {
    const { onConfirm } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /创建空白功能组/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      groups: expect.arrayContaining([
        expect.objectContaining({
          name: '新功能组',
          package: expect.objectContaining({ source: 'user' }),
        }),
      ]),
    }));
  });

  it('blocks the Hongchuang group for enterprises outside the park without blocking other groups', () => {
    const { onConfirm, onClose } = renderDialog({
      parkIdentity: { name: '其他产业园', slug: 'another-park', status: 'active' },
    });
    const dialog = screen.getByRole('dialog', { name: '新增功能组' });
    const parkCard = within(dialog).getByRole('heading', { name: '宏创园区服务' }).closest('article');
    const dailyCard = within(dialog).getByRole('heading', { name: '日常办公' }).closest('article');
    if (!parkCard || !dailyCard) throw new Error('missing official template card');

    expect(within(parkCard).getByText(/仅北控宏创科技园企业可添加/)).toBeTruthy();
    const parkButton = within(parkCard).getByRole('button', { name: '仅园区企业可添加' }) as HTMLButtonElement;
    expect(parkButton.disabled).toBe(true);
    fireEvent.click(parkButton);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect((within(dailyCard).getByRole('button', { name: /升级功能组|添加功能组/ }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('does not offer eight duplicate recruitment entry points as a group', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '新增功能组' });
    expect(within(dialog).queryByRole('heading', { name: '智能招聘' })).toBeNull();
  });

  it('does not expose enterprise official templates in personal edition', () => {
    renderDialog({ edition: 'personal' });

    expect(screen.queryByRole('heading', { name: '宏创园区服务' })).toBeNull();
    expect(screen.getByRole('button', { name: /创建空白功能组/ })).toBeTruthy();
  });
});
