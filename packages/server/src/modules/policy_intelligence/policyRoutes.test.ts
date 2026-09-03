import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isMemberRoute } from '../authorization/enterpriseRoutePolicy.js';
import { commercialFeatureForEnterpriseRoute } from '../authorization/commercialRoutePolicy.js';
import { handlePolicyRoute } from './policyRoutes.js';
import type { EnterprisePolicyService } from './policyService.js';
describe('policy HTTP authorization boundary', () => {
  it('requires member authentication, not a park commercial module', () => {
    for (const path of [
      '/enterprise/policy-intelligence',
      '/enterprise/policy-intelligence/actions',
    ]) {
      expect(isMemberRoute(path)).toBe(true);
      expect(commercialFeatureForEnterpriseRoute(path)).toBeNull();
    }
    expect(isMemberRoute('/enterprise/policy-intelligence-evil')).toBe(false);
  });
  it('rejects unauthenticated reads and derives identity from the server session', async () => {
    const state = vi.fn(async () => ({}));
    const act = vi.fn(async () => ({}));
    const sendJSON = vi.fn();
    const service = () =>
      ({ state, act }) as unknown as EnterprisePolicyService;
    const input = {
      path: '/enterprise/policy-intelligence',
      method: 'GET',
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      readBody: vi.fn(async () => ({
        action: 'diagnose',
        accountId: 'victim',
      })),
      sendJSON,
      service,
    };
    await handlePolicyRoute(input);
    expect(sendJSON).toHaveBeenLastCalledWith(
      input.res,
      401,
      expect.anything(),
    );
    expect(state).not.toHaveBeenCalled();
    await handlePolicyRoute({
      ...input,
      accountId: 'real-account',
      path: '/enterprise/policy-intelligence/actions',
      method: 'POST',
    });
    expect(act).toHaveBeenCalledWith(
      'real-account',
      expect.objectContaining({ accountId: 'victim' }),
    );
  });
  it('never exposes database or provider secrets in raw infrastructure errors', async () => {
    const sendJSON = vi.fn();
    const input = {
      path: '/enterprise/policy-intelligence',
      method: 'GET',
      accountId: 'a',
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      readBody: vi.fn(),
      sendJSON,
      service: () =>
        ({
          state: async () => {
            throw new Error('database password=DO_NOT_EXPOSE');
          },
        }) as unknown as EnterprisePolicyService,
    };
    await handlePolicyRoute(input);
    expect(sendJSON).toHaveBeenCalledWith(
      input.res,
      503,
      expect.objectContaining({
        error: expect.not.stringContaining('DO_NOT_EXPOSE'),
      }),
    );
  });
});
