/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RecruitmentJobError, type RecruitmentJobAction, type RecruitmentJobService } from './recruitmentJobs.js';

export async function handleRecruitmentJobRoute(input: {
  path: string; method: string; req: IncomingMessage; res: ServerResponse; accountId: string;
  service(): RecruitmentJobService;
  readBody(req: IncomingMessage, maxLength?: number): Promise<Record<string, unknown>>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
}): Promise<boolean> {
  if (input.path !== '/enterprise/recruitment/jobs') return false;
  if (input.method !== 'POST') { input.sendJson(input.res, 405, { error: 'method not allowed' }); return true; }
  try {
    const body = await input.readBody(input.req, 6_000_000);
    const result = await input.service().act(input.accountId, body as RecruitmentJobAction);
    input.sendJson(input.res, 200, { contract: 'otto-recruitment-jobs-v1', result });
  } catch (error) {
    input.sendJson(input.res, error instanceof RecruitmentJobError ? error.status : 500, {
      code: 'RECRUITMENT_JOB_FAILED', error: error instanceof RecruitmentJobError ? error.message : '招聘档案操作失败，请稍后重试',
    });
  }
  return true;
}
