import { expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleWorkableConnectionRoute } from './workableConnectionRoutes.js';
import { WorkableConnectionError, type WorkableConnectionService } from './workableConnections.js';

it('routes self-service with authenticated identity and exposes no token-import action', async () => {
  const act = vi.fn(async () => ({ revision: 0, status: 'authorization_required', targets: [], authorizationAvailable: false }));
  const sendJson = vi.fn();
  const input = { path: '/enterprise/recruitment/workable', method: 'POST', accountId: 'hr', req: {} as IncomingMessage, res: { setHeader: vi.fn() } as unknown as ServerResponse,
    service: () => ({ act }) as unknown as WorkableConnectionService,
    readBody: vi.fn(async () => ({ kind: 'status', jobId: 'job', actorAccountId: 'admin', organizationId: 'foreign', accessToken: 'secret' })), sendJson };
  await handleWorkableConnectionRoute(input);
  expect(act).toHaveBeenCalledWith('hr', expect.objectContaining({ kind: 'status', jobId: 'job' }));
  act.mockRejectedValueOnce(new Error('secret-provider-error') as never);
  await handleWorkableConnectionRoute(input);
  expect(JSON.stringify(sendJson.mock.calls)).not.toContain('secret-provider-error');
  act.mockRejectedValueOnce(new WorkableConnectionError(409, '请刷新') as never);
  await handleWorkableConnectionRoute(input);
  expect(sendJson).toHaveBeenLastCalledWith(input.res, 409, expect.objectContaining({ error: '请刷新' }));
  await handleWorkableConnectionRoute({ ...input, method: 'GET' });
  expect(sendJson).toHaveBeenLastCalledWith(input.res, 405, expect.anything());
});
