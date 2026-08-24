/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  DurableWorkflowConflictError,
  type DurableWorkflowActor,
  type DurableWorkflowDefinition,
  type DurableWorkflowQueueStore,
  type DurableWorkflowRunStatus,
} from './contracts.js';

type JsonBody = Record<string, unknown>;
const RUN_STATUSES = new Set<DurableWorkflowRunStatus>([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'unknown_outcome',
  'dead_letter',
  'compensating',
  'compensated',
]);

interface WorkflowRouteMember {
  id: string;
  organizationId: string;
  name: string;
  isAdmin: boolean;
}

function routeParts(path: string): string[] | null {
  if (
    path !== '/enterprise/workflows' &&
    !path.startsWith('/enterprise/workflows/')
  ) {
    return null;
  }
  try {
    return path
      .split('/')
      .filter(Boolean)
      .slice(2)
      .map((part) => decodeURIComponent(part));
  } catch {
    return ['__invalid__'];
  }
}

function actor(member: WorkflowRouteMember): DurableWorkflowActor {
  return {
    organizationId: member.organizationId,
    accountId: member.id,
    display: member.name,
  };
}

function text(body: JsonBody, key: string): string {
  return typeof body[key] === 'string' ? body[key].trim() : '';
}

function assertDefinition(
  value: unknown,
  allowedTaskTypes: ReadonlySet<string>,
): DurableWorkflowDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow definition is required');
  }
  const definition = value as Partial<DurableWorkflowDefinition>;
  if (
    typeof definition.id !== 'string' ||
    definition.version !== 1 ||
    !Array.isArray(definition.steps)
  ) {
    throw new Error('workflow definition is invalid');
  }
  for (const step of definition.steps) {
    if (
      !step ||
      typeof step !== 'object' ||
      !allowedTaskTypes.has(step.taskType) ||
      !['none', 'idempotent', 'external'].includes(step.sideEffect) ||
      !step.input ||
      typeof step.input !== 'object' ||
      Array.isArray(step.input)
    ) {
      throw new Error(
        `workflow task is not allowed: ${String(step?.taskType || '')}`,
      );
    }
  }
  return definition as DurableWorkflowDefinition;
}

export async function handleDurableWorkflowRoutes(input: {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  member: WorkflowRouteMember;
  store: DurableWorkflowQueueStore;
  allowedTaskTypes: ReadonlySet<string>;
  readBody(req: IncomingMessage): Promise<JsonBody>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
}): Promise<boolean> {
  const parts = routeParts(input.path);
  if (!parts) return false;

  try {
    if (parts.length === 0 && input.method === 'GET') {
      const statuses = new URL(
        input.req.url || '/',
        'http://127.0.0.1',
      ).searchParams.getAll('status') as DurableWorkflowRunStatus[];
      if (statuses.some((status) => !RUN_STATUSES.has(status))) {
        throw new Error('workflow status filter is invalid');
      }
      input.sendJson(input.res, 200, {
        runs: await input.store.listRuns({
          organizationId: input.member.organizationId,
          ...(input.member.isAdmin
            ? {}
            : { createdByAccountId: input.member.id }),
          ...(statuses.length ? { statuses } : {}),
        }),
      });
      return true;
    }
    if (parts.length === 0 && input.method === 'POST') {
      const body = await input.readBody(input.req);
      const definition = assertDefinition(
        body['definition'],
        input.allowedTaskTypes,
      );
      const priority =
        body['priority'] === undefined ? undefined : Number(body['priority']);
      const run = await input.store.createRun({
        definition,
        actor: actor(input.member),
        ...(priority === undefined ? {} : { priority }),
      });
      input.sendJson(input.res, 201, { run });
      return true;
    }

    const [runId, segment, stepId, action] = parts;
    if (!/^wf-[0-9a-f-]{36}$/u.test(runId || '')) {
      input.sendJson(input.res, 404, { error: 'workflow route not found' });
      return true;
    }
    if (parts.length === 1 && input.method === 'GET') {
      const run = await input.store.getRun({
        organizationId: input.member.organizationId,
        runId: runId!,
      });
      if (
        run &&
        !input.member.isAdmin &&
        run.createdByAccountId !== input.member.id
      ) {
        input.sendJson(input.res, 404, { error: 'workflow run not found' });
        return true;
      }
      input.sendJson(
        input.res,
        run ? 200 : 404,
        run ? { run } : { error: 'workflow run not found' },
      );
      return true;
    }
    if (!input.member.isAdmin) {
      input.sendJson(input.res, 403, {
        error: 'enterprise administrator permission required',
        code: 'ADMIN_REQUIRED',
      });
      return true;
    }
    if (parts.length === 2 && input.method === 'POST') {
      const body = await input.readBody(input.req);
      const common = {
        organizationId: input.member.organizationId,
        runId: runId!,
        actor: actor(input.member),
        note: text(body, 'note'),
      };
      if (!common.note) throw new Error('operator note is required');
      if (segment === 'cancel') await input.store.cancel(common);
      else if (segment === 'compensate')
        await input.store.requestCompensation(common);
      else return false;
      input.sendJson(input.res, 200, { ok: true });
      return true;
    }
    if (segment === 'steps' && stepId && action && input.method === 'POST') {
      const body = await input.readBody(input.req);
      const base = {
        organizationId: input.member.organizationId,
        runId: runId!,
        stepId,
        actor: actor(input.member),
      };
      if (action === 'approve') {
        const approvalId = text(body, 'approvalId');
        if (!approvalId) throw new Error('approvalId is required');
        await input.store.approve({ ...base, approvalId });
      } else if (action === 'retry') {
        const note = text(body, 'note');
        const mode = body['mode'] ?? 'forward';
        if (!note || !['forward', 'compensation'].includes(String(mode))) {
          throw new Error('retry mode and operator note are required');
        }
        await input.store.retryDeadLetter({
          ...base,
          note,
          mode: mode as 'forward' | 'compensation',
          confirmedExternalNotExecuted:
            body['confirmedExternalNotExecuted'] === true,
        });
      } else if (action === 'resolve') {
        const note = text(body, 'note');
        const resolution = body['resolution'];
        if (
          !note ||
          !['mark_succeeded', 'mark_failed', 'cancel'].includes(
            String(resolution),
          )
        ) {
          throw new Error('resolution and operator note are required');
        }
        await input.store.resolveUnknown({
          ...base,
          note,
          resolution: resolution as 'mark_succeeded' | 'mark_failed' | 'cancel',
        });
      } else {
        return false;
      }
      input.sendJson(input.res, 200, { ok: true });
      return true;
    }
    return false;
  } catch (error) {
    const conflict = error instanceof DurableWorkflowConflictError;
    input.sendJson(input.res, conflict ? 409 : 400, {
      error: error instanceof Error ? error.message : 'workflow request failed',
      code: conflict ? 'WORKFLOW_CONFLICT' : 'WORKFLOW_REQUEST_INVALID',
    });
    return true;
  }
}
