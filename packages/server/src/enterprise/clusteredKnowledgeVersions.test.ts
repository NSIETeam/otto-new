/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import {
  handleClusteredBusinessRoute,
  type ClusteredBusinessRouteInput,
} from './clusteredBusinessRoutes.js';

function fixture(
  options: {
    admin?: boolean;
    stale?: boolean;
    conflict?: boolean;
    history?: boolean;
  } = {},
) {
  const payload = {
    title: '交付规则',
    category: '流程',
    department: '研发部',
    content: '新版正文',
    confidence: 0.8,
    sourceType: 'manual',
    sourceLabel: options.conflict ? '证据存在冲突' : null,
  };
  const record = {
    organizationId: 'org-a',
    domain: 'knowledge',
    resourceType: 'entry',
    resourceId: 'k-12',
    status: 'active',
    version: 2,
    payload,
    createdAt: '2026-09-01',
    updatedAt: '2026-09-02',
  };
  const repository = {
    getOrganizationFeatures: vi.fn(async () => ({ knowledge: true })),
    getBusinessRecord: vi.fn(async () => record),
    listBusinessEvents: vi.fn(async () =>
      options.history === false
        ? []
        : [
            {
              organizationId: 'org-a',
              domain: 'knowledge',
              resourceType: 'entry',
              resourceId: 'k-12',
              eventId: 'e-1',
              payload: {
                fromVersion: 1,
                toVersion: 2,
                previous: { ...payload, content: '历史正文', department: null },
              },
            },
          ],
    ),
    updateBusinessRecord: vi.fn(async (input) =>
      options.stale
        ? null
        : {
            ...record,
            status: input.status,
            payload: input.payload,
            version: 3,
          },
    ),
    appendBusinessEvent: vi.fn(),
  };
  const sendJson = vi.fn();
  const input = {
    path: '/enterprise/knowledge/k-12',
    method: 'PATCH',
    url: new URL('https://test/enterprise/knowledge/k-12'),
    req: { headers: {} },
    res: { setHeader: vi.fn() },
    member: {
      id: 'admin-a',
      name: '管理员',
      organizationId: 'org-a',
      isAdmin: options.admin !== false,
    },
    repository,
    sendJson,
    requireCommercialFeature: vi.fn(async () => true),
    readBody: vi.fn(async () => ({
      expectedVersion: 2,
      restoreVersion: 1,
      content: '伪造正文',
      changeNote: '流程变更后需要恢复旧内容并重新复核',
    })),
  } as unknown as ClusteredBusinessRouteInput;
  return { input, repository, sendJson };
}

describe('clustered knowledge version safety', () => {
  it('restores an authoritative tenant snapshot with unchanged ACL and atomic audit', async () => {
    const f = fixture();
    await handleClusteredBusinessRoute(f.input);
    expect(f.sendJson).toHaveBeenCalledWith(
      f.input.res,
      200,
      expect.objectContaining({
        knowledge: expect.objectContaining({
          status: 'pending_review',
          version: 3,
          content: '历史正文',
          department: '研发部',
        }),
      }),
    );
    expect(f.repository.updateBusinessRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 2,
        auditEvent: expect.objectContaining({
          eventType: 'restored',
          actorAccountId: 'admin-a',
        }),
      }),
    );
    expect(f.repository.appendBusinessEvent).not.toHaveBeenCalled();
  });

  it.each([
    { admin: false },
    { stale: true },
    { conflict: true },
    { history: false },
  ])(
    'fails closed for forbidden or unverifiable restore %j',
    async (options) => {
      const f = fixture(options);
      await handleClusteredBusinessRoute(f.input);
      expect(f.sendJson.mock.calls.at(-1)?.[1]).toBe(
        options.admin === false ? 403 : 409,
      );
      if (!options.stale)
        expect(f.repository.updateBusinessRecord).not.toHaveBeenCalled();
      else expect(f.repository.updateBusinessRecord).toHaveBeenCalledOnce();
    },
  );

  it('returns normalized snapshot history, not incomplete raw audit events', async () => {
    const f = fixture();
    f.input.path += '/revisions';
    f.input.method = 'GET';
    await handleClusteredBusinessRoute(f.input);
    expect(f.sendJson).toHaveBeenCalledWith(f.input.res, 200, {
      revisions: expect.arrayContaining([
        expect.objectContaining({ version: 1, content: '历史正文' }),
        expect.objectContaining({ version: 2, content: '新版正文' }),
      ]),
    });
  });

  it('never restores a snapshot belonging to another enterprise', async () => {
    const f = fixture();
    const events = await f.repository.listBusinessEvents();
    f.repository.listBusinessEvents.mockResolvedValue([
      { ...events[0], organizationId: 'org-other' },
    ]);
    await handleClusteredBusinessRoute(f.input);
    expect(f.sendJson.mock.calls.at(-1)?.[1]).toBe(409);
    expect(f.repository.updateBusinessRecord).not.toHaveBeenCalled();
  });

  it('rejects approving a version the administrator has not reviewed', async () => {
    const f = fixture();
    f.input.path += '/review';
    f.input.method = 'POST';
    f.input.readBody = vi.fn(async () => ({
      action: 'approve',
      expectedVersion: 1,
    }));
    await handleClusteredBusinessRoute(f.input);
    expect(f.sendJson.mock.calls.at(-1)?.[1]).toBe(409);
    expect(f.repository.updateBusinessRecord).not.toHaveBeenCalled();
  });
});
