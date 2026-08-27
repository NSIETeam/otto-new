/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { ServerResponse } from 'node:http';
import type {
  PrivateDeploymentBootstrapCoordinator,
  PrivateDeploymentReadiness,
} from '../modules/deployment_lifecycle/index.js';

export interface PrivateDeploymentBootstrapRouteServices {
  prepare(): Promise<PrivateDeploymentReadiness>;
  readiness(): PrivateDeploymentReadiness;
}

export async function handlePrivateDeploymentBootstrapRoute(input: {
  path: string;
  method: string;
  res: ServerResponse;
  services: Pick<PrivateDeploymentBootstrapCoordinator, 'prepare' | 'readiness'>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}): Promise<boolean> {
  if (input.path !== '/enterprise/bootstrap/prepare') return false;
  if (input.method !== 'POST') {
    input.sendJSON(input.res, 405, { error: 'method not allowed' });
    return true;
  }
  const readiness = await input.services.prepare();
  input.sendJSON(input.res, readiness.state === 'blocked' ? 503 : 200, {
    readiness,
  });
  return true;
}
