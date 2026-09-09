import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnterprisePublicProfilePanel } from './EnterprisePublicProfilePanel.js';
const profile = {
  organizationId: 'a',
  organizationName: '本企业',
  summary: '企业介绍',
  website: '',
  industryTags: ['旧标签'],
  productsServices: ['产品'],
  capabilities: [],
  cooperationNeeds: [],
  publicContact: '',
  isPublic: false,
  updatedAt: null,
  primaryIndustryCode: null,
};
beforeEach(() => {
  Object.defineProperty(window, 'otto', {
    configurable: true,
    value: {
      enterprisePublicProfile: vi.fn(async () => profile),
      enterprisePublicProfileUpdate: vi.fn(async (input) => ({
        ...profile,
        ...input,
      })),
    },
  });
});
afterEach(cleanup);
describe('primary industry editing in existing company profile', () => {
  it('saves an explicitly selected standard code without changing the publication flag', async () => {
    render(<EnterprisePublicProfilePanel />);
    fireEvent.change(
      await screen.findByRole('combobox', { name: '主营行业' }),
      { target: { value: 'it_services' } },
    );
    fireEvent.click(screen.getByRole('button', { name: '保存企业资料' }));
    await waitFor(() =>
      expect(window.otto.enterprisePublicProfileUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryIndustryCode: 'it_services',
          isPublic: false,
          industryTags: ['旧标签'],
        }),
      ),
    );
  });
  it('does not expose an editable form after a failed profile read', async () => {
    vi.mocked(window.otto.enterprisePublicProfile).mockRejectedValueOnce(
      new Error('读取失败'),
    );
    render(<EnterprisePublicProfilePanel />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存企业资料' })).toBeNull();
  });
  it('disables non-admin edits and reports dirty state while preserving failed input', async () => {
    const dirty = vi.fn();
    const { unmount } = render(
      <EnterprisePublicProfilePanel canEdit={false} />,
    );
    expect(
      (await screen.findByRole('combobox', { name: '主营行业' })).closest(
        'fieldset',
      )?.disabled,
    ).toBe(true);
    unmount();
    vi.mocked(window.otto.enterprisePublicProfileUpdate).mockRejectedValueOnce(
      new Error('保存失败'),
    );
    render(<EnterprisePublicProfilePanel onDirtyChange={dirty} />);
    fireEvent.change(
      await screen.findByRole('combobox', { name: '主营行业' }),
      { target: { value: 'medical_devices' } },
    );
    expect(dirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: '保存企业资料' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '保存失败',
    );
    expect(
      (screen.getByRole('combobox', { name: '主营行业' }) as HTMLSelectElement)
        .value,
    ).toBe('medical_devices');
  });
});
