import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getOrganization: vi.fn(() => null),
  listAccounts: vi.fn(() => []),
  listEmployees: vi.fn(() => []),
  getParkForOrganization: vi.fn(() => null),
  listAccountPresence: vi.fn(() => []),
  listOrganizationStructure: vi.fn(() => []),
  getOrganizationFeatures: vi.fn(() => ({ enterprise_tree: true })),
  listParkServices: vi.fn(() => []),
}));

vi.mock('./db.js', () => db);

import { organizationViewPayload } from './communicationRoutes.js';

describe('organizationViewPayload', () => {
  beforeEach(() => vi.clearAllMocks());

  it('coalesces identical reads within one event-loop turn', async () => {
    expect(organizationViewPayload('org-1')).toBe(organizationViewPayload('org-1'));
    expect(db.getOrganization).toHaveBeenCalledTimes(1);

    await new Promise<void>((resolve) => setImmediate(resolve));
    organizationViewPayload('org-1');
    expect(db.getOrganization).toHaveBeenCalledTimes(2);
  });
});
