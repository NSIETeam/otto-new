/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { DurableWorkflowQueueStore } from './contracts.js';
import { handleDurableWorkflowRoutes } from './routes.js';

function storeStub(): DurableWorkflowQueueStore {
  return {
    createRun: vi.fn(),
    claimNext: vi.fn(),
    renewLease: vi.fn(),
    succeedClaim: vi.fn(),
    failClaim: vi.fn(),
    recoverExpiredWork: vi.fn(),
    listRuns: vi.fn().mockResolvedValue([]),
    getRun: vi.fn(),
    approve: vi.fn(),
    retryDeadLetter: vi.fn(),
    resolveUnknown: vi.fn(),
    requestCompensation: vi.fn(),
    cancel: vi.fn(),
  };
}

describe('durable workflow enterprise routes', () => {
  it('requires and forwards a tenant-scoped submission idempotency key', async () => {
    const sendJson = vi.fn();
    const store = storeStub();
    vi.mocked(store.createRun).mockResolvedValue({
      id: 'wf-00000000-0000-4000-8000-000000000001',
    } as never);
    await handleDurableWorkflowRoutes({
      path: '/enterprise/workflows',
      method: 'POST',
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      member: {
        id: 'account-1',
        organizationId: 'org-1',
        name: 'Admin',
        isAdmin: true,
      },
      store,
      allowedTaskTypes: new Set(['workflow.checkpoint']),
      readBody: vi.fn().mockResolvedValue({
        submissionIdempotencyKey: 'client-request-1',
        definition: {
          id: 'safe',
          version: 1,
          steps: [
            {
              id: 'checkpoint',
              taskType: 'workflow.checkpoint',
              input: {},
              sideEffect: 'none',
            },
          ],
        },
      }),
      sendJson,
    });

    expect(store.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionIdempotencyKey: 'client-request-1',
      }),
    );
    expect(sendJson).toHaveBeenCalledWith(expect.anything(), 201, {
      run: expect.objectContaining({
        id: 'wf-00000000-0000-4000-8000-000000000001',
      }),
    });
  });

  it('rejects a create request without a submission idempotency key', async () => {
    const sendJson = vi.fn();
    const store = storeStub();
    await handleDurableWorkflowRoutes({
      path: '/enterprise/workflows',
      method: 'POST',
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      member: {
        id: 'account-1',
        organizationId: 'org-1',
        name: 'Admin',
        isAdmin: true,
      },
      store,
      allowedTaskTypes: new Set(['workflow.checkpoint']),
      readBody: vi.fn().mockResolvedValue({
        definition: {
          id: 'safe',
          version: 1,
          steps: [
            {
              id: 'checkpoint',
              taskType: 'workflow.checkpoint',
              input: {},
              sideEffect: 'none',
            },
          ],
        },
      }),
      sendJson,
    });

    expect(store.createRun).not.toHaveBeenCalled();
    expect(sendJson).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: 'WORKFLOW_REQUEST_INVALID' }),
    );
  });

  it('does not expose internal repository errors to clients', async () => {
    const sendJson = vi.fn();
    const store = storeStub();
    vi.mocked(store.listRuns).mockRejectedValue(
      new Error(
        'password=database-secret postgresql://admin:hunter2@db.internal/otto',
      ),
    );
    await handleDurableWorkflowRoutes({
      path: '/enterprise/workflows',
      method: 'GET',
      req: { url: '/enterprise/workflows' } as IncomingMessage,
      res: {} as ServerResponse,
      member: {
        id: 'account-1',
        organizationId: 'org-1',
        name: 'Admin',
        isAdmin: true,
      },
      store,
      allowedTaskTypes: new Set(),
      readBody: vi.fn(),
      sendJson,
    });

    expect(sendJson).toHaveBeenCalledWith(expect.anything(), 500, {
      error: 'workflow request failed',
      code: 'WORKFLOW_INTERNAL_ERROR',
    });
    expect(JSON.stringify(sendJson.mock.calls)).not.toContain('hunter2');
  });

  it('limits non-administrator history to workflows they created', async () => {
    const sendJson = vi.fn();
    const store = storeStub();
    const handled = await handleDurableWorkflowRoutes({
      path: '/enterprise/workflows',
      method: 'GET',
      req: { url: '/enterprise/workflows' } as IncomingMessage,
      res: {} as ServerResponse,
      member: {
        id: 'account-1',
        organizationId: 'org-1',
        name: 'User',
        isAdmin: false,
      },
      store,
      allowedTaskTypes: new Set(['workflow.checkpoint']),
      readBody: vi.fn(),
      sendJson,
    });

    expect(handled).toBe(true);
    expect(store.listRuns).toHaveBeenCalledWith({
      organizationId: 'org-1',
      createdByAccountId: 'account-1',
    });
    expect(sendJson).toHaveBeenCalledWith(expect.anything(), 200, { runs: [] });
  });

  it('rejects workflow task types not installed in the Worker', async () => {
    const sendJson = vi.fn();
    const store = storeStub();
    await handleDurableWorkflowRoutes({
      path: '/enterprise/workflows',
      method: 'POST',
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      member: {
        id: 'account-1',
        organizationId: 'org-1',
        name: 'Admin',
        isAdmin: true,
      },
      store,
      allowedTaskTypes: new Set(['workflow.checkpoint']),
      readBody: vi.fn().mockResolvedValue({
        definition: {
          id: 'unsafe',
          version: 1,
          steps: [
            {
              id: 'pay',
              taskType: 'finance.pay',
              input: {},
              sideEffect: 'external',
            },
          ],
        },
      }),
      sendJson,
    });

    expect(store.createRun).not.toHaveBeenCalled();
    expect(sendJson).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: 'WORKFLOW_REQUEST_INVALID' }),
    );
  });

  it('requires an operator note before compensation or cancellation', async () => {
    const sendJson = vi.fn();
    const store = storeStub();
    await handleDurableWorkflowRoutes({
      path: '/enterprise/workflows/wf-00000000-0000-4000-8000-000000000001/cancel',
      method: 'POST',
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      member: {
        id: 'account-1',
        organizationId: 'org-1',
        name: 'Admin',
        isAdmin: true,
      },
      store,
      allowedTaskTypes: new Set(),
      readBody: vi.fn().mockResolvedValue({ note: '' }),
      sendJson,
    });

    expect(store.cancel).not.toHaveBeenCalled();
    expect(sendJson).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.anything(),
    );
  });
});
