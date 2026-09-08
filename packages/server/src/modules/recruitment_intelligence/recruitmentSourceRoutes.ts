/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { RecruitmentGatewayCancelledError } from './recruitmentSourceGateway.js';
import type { RecruitmentSourceRuntime } from './recruitmentSourceRuntime.js';
import { RecruitmentMaterialError } from './recruitmentSourceMaterial.js';

export interface RecruitmentSourceRoutePrincipal {
  organizationId: string;
  accountId: string;
  isAdmin: boolean;
}

export interface RecruitmentSourceRouteInput {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  principal: RecruitmentSourceRoutePrincipal;
  runtime?: RecruitmentSourceRuntime;
  /** Explicit job ACL wiring is required before non-admin source access is enabled. */
  authorizeJob?(accountId: string, jobId: string): Promise<boolean>;
  readBody(req: IncomingMessage, maxLength?: number): Promise<Record<string, unknown>>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

class RecruitmentSourceRequestError extends Error {}

function identifier(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!IDENTIFIER.test(normalized)) {
    throw new RecruitmentSourceRequestError(`${label} is invalid`);
  }
  return normalized;
}

function stringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) {
    throw new RecruitmentSourceRequestError(`${label} is invalid`);
  }
  return [...new Set(value.map((item) => identifier(item, label)))];
}

function requireRecruitmentAdministrator(input: RecruitmentSourceRouteInput): boolean {
  if (input.principal.isAdmin) return true;
  input.sendJson(input.res, 403, {
    error: 'recruitment source access requires an enterprise administrator',
    code: 'RECRUITMENT_ADMIN_REQUIRED',
  });
  return false;
}

function requireRuntime(input: RecruitmentSourceRouteInput): RecruitmentSourceRuntime | null {
  if (input.runtime) return input.runtime;
  input.sendJson(input.res, 503, {
    error: 'recruitment source runtime is not configured',
    code: 'RECRUITMENT_SOURCES_NOT_CONFIGURED',
  });
  return null;
}

function requestSignal(req: IncomingMessage, res: ServerResponse): {
  signal: AbortSignal;
  detach(): void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const abortIfUnfinished = (): void => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', abortIfUnfinished);
  return {
    signal: controller.signal,
    detach() {
      req.removeListener('aborted', abort);
      res.removeListener('close', abortIfUnfinished);
    },
  };
}

export async function handleRecruitmentSourceRoute(
  input: RecruitmentSourceRouteInput,
): Promise<boolean> {
  const base = '/enterprise/recruitment/sources';
  const runMatch = /^\/enterprise\/recruitment\/source-runs\/([^/]+)$/u.exec(
    input.path,
  );
  if (input.path !== base && input.path !== `${base}/search` && input.path !== `${base}/material` && !runMatch) {
    return false;
  }
  input.res.setHeader('Cache-Control', 'no-store');
  if (!input.authorizeJob && !requireRecruitmentAdministrator(input)) return true;
  const runtime = requireRuntime(input);
  if (!runtime) return true;
  const verifyJob = async (jobId: string): Promise<void> => {
    if (!input.authorizeJob) return;
    let allowed = false;
    try { allowed = await input.authorizeJob(input.principal.accountId, jobId); } catch { /* Fail closed. */ }
    if (!allowed) throw new RecruitmentMaterialError(403, 'RECRUITMENT_JOB_UNAUTHORIZED', '岗位不存在或授权已变化，请加载有权访问的企业共享岗位');
  };

  try {
    if (input.path === `${base}/material` && input.method === 'POST') {
      if (!runtime.getCandidateMaterial) throw new RecruitmentMaterialError(409, 'RECRUITMENT_MATERIAL_UNSUPPORTED', '服务器尚未支持候选人材料读取，请升级服务器');
      const body = await input.readBody(input.req, 8 * 1024);
      const jobId = identifier(body.requisitionId, 'requisition id');
      await verifyJob(jobId);
      const cancellation = requestSignal(input.req, input.res);
      try {
        const result = await runtime.getCandidateMaterial({
          organizationId: input.principal.organizationId, actorAccountId: input.principal.accountId,
          runId: identifier(body.runId, 'run id'), requisitionId: jobId,
          canonicalId: identifier(body.canonicalId, 'canonical id'), sourceId: identifier(body.sourceId, 'source id'),
          signal: cancellation.signal,
        });
        await verifyJob(jobId);
        input.sendJson(input.res, 200, { contract: 'otto-recruitment-material-v1', result });
      } finally { cancellation.detach(); }
      return true;
    }
    if (input.path === base && input.method === 'GET') {
      const params = new URL(input.req.url ?? base, 'http://localhost').searchParams;
      if (params.getAll('requisitionId').length > 1) throw new RecruitmentSourceRequestError('requisition id is duplicated');
      const jobId = params.has('requisitionId') ? identifier(params.get('requisitionId'), 'requisition id') : undefined;
      if (jobId) await verifyJob(jobId);
      const sources = await runtime.listSources({
        organizationId: input.principal.organizationId,
        actorAccountId: input.principal.accountId,
        ...(jobId ? { requisitionId: jobId } : {}),
      });
      if (jobId) await verifyJob(jobId);
      input.sendJson(input.res, 200, {
        contract: 'otto-recruitment-sources-v1',
        sources,
        searchableSourceCount: sources.filter((source) => source.searchable).length,
      });
      return true;
    }

    if (input.path === `${base}/search` && input.method === 'POST') {
      const body = await input.readBody(input.req, 32 * 1024);
      const jobId = identifier(body.requisitionId, 'requisition id');
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (!query || query.length > 10_000) {
        throw new RecruitmentSourceRequestError('recruitment query is invalid');
      }
      const limit = body.limitPerSource === undefined
        ? 50
        : Number(body.limitPerSource);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new RecruitmentSourceRequestError('limitPerSource is invalid');
      }
      await verifyJob(jobId);
      const cancellation = requestSignal(input.req, input.res);
      try {
        const result = await runtime.search({
          organizationId: input.principal.organizationId,
          actorAccountId: input.principal.accountId,
          requisitionId: jobId,
          query,
          sourceIds: stringList(body.sourceIds, 'source ids'),
          limitPerSource: limit,
          signal: cancellation.signal,
        });
        await verifyJob(jobId);
        input.sendJson(input.res, 200, {
          contract: 'otto-recruitment-source-results-v1',
          result,
        });
      } finally {
        cancellation.detach();
      }
      return true;
    }

    if (runMatch && input.method === 'GET') {
      const stored = await runtime.getSearchRun(
        input.principal.organizationId,
        identifier(decodeURIComponent(runMatch[1]!), 'run id'),
      );
      let run = stored?.organizationId === input.principal.organizationId && stored.actorAccountId === input.principal.accountId ? stored : null;
      if (run) {
        await verifyJob(run.requisitionId);
        const current = await runtime.getSearchRun(input.principal.organizationId, run.runId);
        run = current?.organizationId === run.organizationId && current.actorAccountId === run.actorAccountId
          && current.requisitionId === run.requisitionId && current.runId === run.runId ? current : null;
      }
      input.sendJson(
        input.res,
        run ? 200 : 404,
        run
          ? { contract: 'otto-recruitment-source-results-v1', result: run }
          : { error: '检索记录不存在、已过期或已清理，请重新检索', code: 'RECRUITMENT_RUN_NOT_FOUND' },
      );
      return true;
    }

    input.sendJson(input.res, 405, {
      error: 'method not allowed',
      code: 'METHOD_NOT_ALLOWED',
    });
    return true;
  } catch (error) {
    if (error instanceof RecruitmentMaterialError) {
      input.sendJson(input.res, error.status, { error: error.message, code: error.code });
      return true;
    }
    if (error instanceof RecruitmentGatewayCancelledError) {
      if (!input.res.headersSent) {
        input.sendJson(input.res, 499, {
          error: 'recruitment source search was cancelled',
          code: 'RECRUITMENT_SEARCH_CANCELLED',
        });
      }
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    const clientError = error instanceof RecruitmentSourceRequestError;
    input.sendJson(input.res, clientError ? 400 : 502, {
      error: clientError ? message : 'recruitment source search failed',
      code: clientError ? 'RECRUITMENT_REQUEST_INVALID' : 'RECRUITMENT_SOURCE_FAILED',
    });
    return true;
  }
}
