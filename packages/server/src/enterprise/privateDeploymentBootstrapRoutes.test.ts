/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { handlePrivateDeploymentBootstrapRoute } from './privateDeploymentBootstrapRoutes.js';

const readiness = {
  state: 'ready_for_identity' as const,
  canAuthenticate: true,
  canUseLicensedFeatures: true,
  bootstrap: {
    phase: 'activated' as const,
    lastAttemptAt: '2026-08-29T00:00:00.000Z',
    lastSuccessAt: '2026-08-29T00:00:00.000Z',
    errorCode: null,
  },
  steps: [],
};

describe('private deployment bootstrap route', () => {
  it('keeps the legacy prepare path reachable without client credentials', async () => {
    const prepare = vi.fn(async () => readiness);
    const sendJSON = vi.fn();
    const req = { resume: vi.fn() } as unknown as IncomingMessage;
    const res = {} as ServerResponse;

    await expect(handlePrivateDeploymentBootstrapRoute({
      path: '/enterprise/bootstrap/prepare',
      method: 'POST',
      req,
      res,
      readBody: async () => ({}),
      services: { prepare, readiness: () => readiness },
      sendJSON,
    })).resolves.toBe(true);

    expect(prepare).toHaveBeenCalledOnce();
    expect(sendJSON).toHaveBeenCalledWith(res, 200, { readiness });
  });

  it('rejects methods other than POST on the same route', async () => {
    const sendJSON = vi.fn();
    await expect(handlePrivateDeploymentBootstrapRoute({
      path: '/enterprise/bootstrap/prepare',
      method: 'GET',
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      readBody: async () => ({}),
      services: { prepare: vi.fn(), readiness: () => readiness },
      sendJSON,
    })).resolves.toBe(true);
    expect(sendJSON).toHaveBeenCalledWith(expect.anything(), 405, {
      error: 'method not allowed',
    });
  });
});
