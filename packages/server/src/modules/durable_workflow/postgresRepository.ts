/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';

import type {
  PostgresClientLike,
  PostgresPoolLike,
} from '../data_platform/postgresDatabaseLifecycle.js';
import {
  DurableWorkflowConflictError,
  DurableWorkflowLeaseLostError,
  type DurableWorkflowActor,
  type DurableWorkflowClaim,
  type DurableWorkflowDefinition,
  type DurableWorkflowQueueStore,
  type DurableWorkflowRunDetail,
  type DurableWorkflowRunListItem,
  type DurableWorkflowRunStatus,
  type DurableWorkflowSideEffect,
} from './contracts.js';
import {
  boundedRetryDelayMs,
  expiredLeaseDisposition,
  failureDisposition,
} from './state.js';

type Queryable =
  Pick<PostgresPoolLike, 'query'> | Pick<PostgresClientLike, 'query'>;

interface RunRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  definition_id: string;
  status: DurableWorkflowRunStatus;
  priority: number | string;
  created_by_account_id: string | null;
  failure_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RunSubmissionRow extends Record<string, unknown> {
  id: string;
  submission_request_digest: string;
  created_by_account_id: string | null;
}

interface StepRow extends Record<string, unknown> {
  run_id: string;
  organization_id: string;
  definition_id: string;
  sequence: number | string;
  step_id: string;
  task_type: string;
  status: DurableWorkflowRunDetail['steps'][number]['status'];
  side_effect: DurableWorkflowSideEffect;
  input: Record<string, unknown> | string;
  attempt: number | string;
  max_attempts: number | string;
  idempotency_key: string;
  requires_approval: boolean;
  approval_timeout_seconds: number | string;
  approval_id: string | null;
  approval_expires_at: Date | string | null;
  approved_at: Date | string | null;
  error_summary: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  lease_owner?: string | null;
  lease_token?: string | null;
  lease_expires_at?: Date | string | null;
  compensation?: Record<string, unknown> | string | null;
}

interface CompensationRow extends Record<string, unknown> {
  run_id: string;
  organization_id: string;
  definition_id: string;
  step_id: string;
  task_type: string;
  input: Record<string, unknown> | string;
  attempt: number | string;
  max_attempts: number | string;
  idempotency_key: string;
  status?: 'queued' | 'running' | 'succeeded' | 'dead_letter' | 'cancelled';
  error_summary?: string | null;
  completed_at?: Date | string | null;
  lease_owner?: string | null;
  lease_token?: string | null;
  lease_expires_at?: Date | string | null;
}

interface DeadLetterRow extends Record<string, unknown> {
  id: string;
  step_id: string;
  mode: 'forward' | 'compensation';
  reason: string;
  attempt: number | string;
  created_at: Date | string;
  resolved_at: Date | string | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function jsonObject(
  value: Record<string, unknown> | string,
): Record<string, unknown> {
  const parsed =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Durable workflow payload is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function integer(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error('Durable workflow integer is invalid');
  return parsed;
}

function cleanSummary(value: string, fallback: string): string {
  const cleaned = value
    .replace(
      /(authorization|api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/giu,
      '$1=[REDACTED]',
    )
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, 1_000);
  return cleaned || fallback;
}

function assertIdentifier(value: string, label: string, max = 128): string {
  const normalized = value.trim();
  if (
    !new RegExp(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,${max - 1}}$`, 'u').test(
      normalized,
    )
  ) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function bounded(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) {
    throw new Error(`${label} must be from ${min} to ${max}`);
  }
  return selected;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Durable workflow payload contains an invalid number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Durable workflow payload is not valid JSON');
}

function submissionRequestDigest(input: {
  definition: DurableWorkflowDefinition;
  priority: number;
}): string {
  const normalized = {
    definition: {
      id: input.definition.id,
      version: input.definition.version,
      steps: input.definition.steps.map((step) => ({
        id: step.id,
        taskType: step.taskType,
        input: step.input,
        sideEffect: step.sideEffect,
        requiresApproval:
          step.requiresApproval === true || step.sideEffect === 'external',
        approvalTimeoutSeconds: step.approvalTimeoutSeconds ?? 86_400,
        maxAttempts: step.maxAttempts ?? 3,
        compensation: step.compensation
          ? {
              taskType: step.compensation.taskType,
              input: step.compensation.input,
              maxAttempts: step.compensation.maxAttempts ?? 3,
            }
          : null,
      })),
    },
    priority: input.priority,
  };
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

function validateDefinition(definition: DurableWorkflowDefinition): void {
  assertIdentifier(definition.id, 'Workflow definition id', 64);
  if (
    definition.version !== 1 ||
    definition.steps.length < 1 ||
    definition.steps.length > 500
  ) {
    throw new Error(
      'Workflow definition must use version 1 and contain 1 to 500 steps',
    );
  }
  const ids = new Set<string>();
  for (const step of definition.steps) {
    const stepId = assertIdentifier(step.id, 'Workflow step id', 64);
    if (ids.has(stepId)) throw new Error('Workflow step ids must be unique');
    ids.add(stepId);
    assertIdentifier(step.taskType, 'Workflow task type');
    if (!['none', 'idempotent', 'external'].includes(step.sideEffect)) {
      throw new Error('Workflow side effect is invalid');
    }
    if (
      !step.input ||
      typeof step.input !== 'object' ||
      Array.isArray(step.input)
    ) {
      throw new Error('Workflow step input must be a JSON object');
    }
    bounded(step.maxAttempts, 3, 1, 20, 'Workflow max attempts');
    bounded(
      step.approvalTimeoutSeconds,
      86_400,
      60,
      2_592_000,
      'Approval timeout',
    );
    const encoded = JSON.stringify(step.input);
    if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) {
      throw new Error('Workflow step input exceeds 256 KiB');
    }
    if (step.compensation) {
      assertIdentifier(step.compensation.taskType, 'Compensation task type');
      if (
        !step.compensation.input ||
        typeof step.compensation.input !== 'object' ||
        Array.isArray(step.compensation.input)
      ) {
        throw new Error('Workflow compensation input must be a JSON object');
      }
      bounded(
        step.compensation.maxAttempts,
        3,
        1,
        20,
        'Compensation max attempts',
      );
      if (
        Buffer.byteLength(JSON.stringify(step.compensation.input), 'utf8') >
        256 * 1024
      ) {
        throw new Error('Workflow compensation input exceeds 256 KiB');
      }
    }
  }
}

async function transaction<T>(
  pool: PostgresPoolLike,
  operation: (client: PostgresClientLike) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const result = await operation(client);
    await client.query('COMMIT');
    open = false;
    return result;
  } catch (error) {
    if (open) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function appendEvent(
  client: Queryable,
  input: {
    runId: string;
    organizationId: string;
    stepId?: string | null;
    actorAccountId?: string | null;
    eventType: string;
    summary: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO durable_workflow_events
       (id, run_id, organization_id, step_id, actor_account_id, event_type, summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      randomUUID(),
      input.runId,
      input.organizationId,
      input.stepId ?? null,
      input.actorAccountId ?? null,
      input.eventType,
      cleanSummary(input.summary, input.eventType),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

function claimFromStep(
  row: StepRow,
  workerId: string,
  leaseToken: string,
  leaseExpiresAt: string,
): DurableWorkflowClaim {
  const attempt = integer(row.attempt) + 1;
  return {
    mode: 'forward',
    runId: row.run_id,
    organizationId: row.organization_id,
    definitionId: row.definition_id,
    stepId: row.step_id,
    taskType: row.task_type,
    input: jsonObject(row.input),
    sideEffect: row.side_effect,
    attempt,
    maxAttempts: integer(row.max_attempts),
    idempotencyKey: row.idempotency_key,
    workerId,
    leaseToken,
    leaseExpiresAt,
  };
}

function claimFromCompensation(
  row: CompensationRow,
  workerId: string,
  leaseToken: string,
  leaseExpiresAt: string,
): DurableWorkflowClaim {
  return {
    mode: 'compensation',
    runId: row.run_id,
    organizationId: row.organization_id,
    definitionId: row.definition_id,
    stepId: row.step_id,
    taskType: row.task_type,
    input: jsonObject(row.input),
    sideEffect: 'idempotent',
    attempt: integer(row.attempt) + 1,
    maxAttempts: integer(row.max_attempts),
    idempotencyKey: row.idempotency_key,
    workerId,
    leaseToken,
    leaseExpiresAt,
  };
}

export function createPostgresDurableWorkflowRepository(input: {
  pool: PostgresPoolLike;
  clock?: () => number;
}): DurableWorkflowQueueStore {
  const clock = input.clock ?? Date.now;

  async function createRun(createInput: {
    definition: DurableWorkflowDefinition;
    actor: DurableWorkflowActor;
    submissionIdempotencyKey: string;
    priority?: number;
  }): Promise<DurableWorkflowRunDetail> {
    validateDefinition(createInput.definition);
    const organizationId = assertIdentifier(
      createInput.actor.organizationId,
      'Organization id',
    );
    const accountId = createInput.actor.accountId
      ? assertIdentifier(createInput.actor.accountId, 'Account id')
      : null;
    const priority = bounded(
      createInput.priority,
      50,
      0,
      100,
      'Workflow priority',
    );
    const submissionIdempotencyKey = assertIdentifier(
      createInput.submissionIdempotencyKey,
      'Submission idempotency key',
    );
    const requestDigest = submissionRequestDigest({
      definition: createInput.definition,
      priority,
    });
    const runId = `wf-${randomUUID()}`;
    const persistedRunId = await transaction(input.pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO durable_workflow_runs
           (id, organization_id, definition_id, definition_version, status, priority,
            created_by_account_id, submission_idempotency_key, submission_request_digest)
         VALUES ($1, $2, $3, 1, 'queued', $4, $5, $6, $7)
         ON CONFLICT (organization_id, submission_idempotency_key)
           WHERE submission_idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          runId,
          organizationId,
          createInput.definition.id,
          priority,
          accountId,
          submissionIdempotencyKey,
          requestDigest,
        ],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<RunSubmissionRow>(
          `SELECT id, submission_request_digest, created_by_account_id
             FROM durable_workflow_runs
            WHERE organization_id = $1 AND submission_idempotency_key = $2
            FOR UPDATE`,
          [organizationId, submissionIdempotencyKey],
        );
        const prior = existing.rows[0];
        if (!prior) {
          throw new Error('Durable workflow idempotency lookup failed');
        }
        if (
          prior.submission_request_digest !== requestDigest ||
          prior.created_by_account_id !== accountId
        ) {
          throw new DurableWorkflowConflictError(
            'Submission idempotency key was reused for a different workflow request',
          );
        }
        return prior.id;
      }
      for (
        let sequence = 0;
        sequence < createInput.definition.steps.length;
        sequence += 1
      ) {
        const step = createInput.definition.steps[sequence]!;
        await client.query(
          `INSERT INTO durable_workflow_steps
             (run_id, organization_id, sequence, step_id, task_type, status, side_effect,
              input, max_attempts, idempotency_key, requires_approval,
              approval_timeout_seconds, compensation)
           VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb)`,
          [
            runId,
            organizationId,
            sequence,
            step.id,
            step.taskType,
            step.sideEffect,
            JSON.stringify(step.input),
            step.maxAttempts ?? 3,
            `${runId}:${step.id}`,
            step.requiresApproval === true || step.sideEffect === 'external',
            step.approvalTimeoutSeconds ?? 86_400,
            step.compensation ? JSON.stringify(step.compensation) : null,
          ],
        );
      }
      await appendEvent(client, {
        runId,
        organizationId,
        actorAccountId: accountId,
        eventType: 'run_created',
        summary: `Workflow ${createInput.definition.id}@1 queued`,
        metadata: { priority, stepCount: createInput.definition.steps.length },
      });
      return runId;
    });
    const created = await getRun({ organizationId, runId: persistedRunId });
    if (!created) throw new Error('Durable workflow creation did not persist');
    return created;
  }

  async function claimNext(claimInput: {
    workerId: string;
    leaseMs: number;
  }): Promise<DurableWorkflowClaim | null> {
    const workerId = assertIdentifier(claimInput.workerId, 'Worker id');
    const leaseMs = bounded(
      claimInput.leaseMs,
      30_000,
      1_000,
      600_000,
      'Workflow lease',
    );
    return transaction(input.pool, async (client) => {
      const compensationResult = await client.query<CompensationRow>(
        `SELECT compensation.run_id, compensation.organization_id, run.definition_id,
                compensation.step_id, compensation.task_type, compensation.input,
                compensation.attempt, compensation.max_attempts, compensation.idempotency_key
           FROM durable_workflow_compensations compensation
           JOIN durable_workflow_runs run ON run.id = compensation.run_id
          WHERE compensation.status = 'queued'
            AND compensation.available_at <= CURRENT_TIMESTAMP
            AND run.status = 'compensating'
            AND NOT EXISTS (
              SELECT 1 FROM durable_workflow_compensations prior
               WHERE prior.run_id = compensation.run_id
                 AND prior.reverse_sequence < compensation.reverse_sequence
                 AND prior.status <> 'succeeded'
            )
          ORDER BY run.priority DESC, compensation.reverse_sequence, compensation.created_at
          LIMIT 1 FOR UPDATE OF compensation SKIP LOCKED`,
      );
      const compensation = compensationResult.rows[0];
      if (compensation) {
        const leaseToken = randomUUID();
        const leaseExpiresAt = new Date(clock() + leaseMs).toISOString();
        await client.query(
          `UPDATE durable_workflow_compensations
              SET status = 'running', attempt = attempt + 1, lease_owner = $3,
                  lease_token = $4::uuid, lease_expires_at = $5, updated_at = CURRENT_TIMESTAMP
            WHERE run_id = $1 AND step_id = $2`,
          [
            compensation.run_id,
            compensation.step_id,
            workerId,
            leaseToken,
            leaseExpiresAt,
          ],
        );
        await appendEvent(client, {
          runId: compensation.run_id,
          organizationId: compensation.organization_id,
          stepId: compensation.step_id,
          eventType: 'compensation_claimed',
          summary: 'Compensation claimed by a durable worker',
          metadata: { workerId, attempt: integer(compensation.attempt) + 1 },
        });
        return claimFromCompensation(
          compensation,
          workerId,
          leaseToken,
          leaseExpiresAt,
        );
      }

      const result = await client.query<StepRow>(
        `SELECT step.*, run.definition_id
           FROM durable_workflow_steps step
           JOIN durable_workflow_runs run ON run.id = step.run_id
          WHERE step.status = 'queued'
            AND step.available_at <= CURRENT_TIMESTAMP
            AND run.status = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM durable_workflow_steps prior
               WHERE prior.run_id = step.run_id AND prior.sequence < step.sequence
                 AND prior.status <> 'succeeded'
            )
          ORDER BY run.priority DESC, run.created_at, step.sequence, step.run_id
          LIMIT 1 FOR UPDATE OF step SKIP LOCKED`,
      );
      const row = result.rows[0];
      if (!row) return null;

      if (row.requires_approval && !row.approved_at) {
        const approvalId = randomUUID();
        const expiresAt = new Date(
          clock() + integer(row.approval_timeout_seconds) * 1_000,
        ).toISOString();
        await client.query(
          `UPDATE durable_workflow_steps
              SET status = 'waiting_approval', approval_id = $3,
                  approval_expires_at = $4, updated_at = CURRENT_TIMESTAMP
            WHERE run_id = $1 AND step_id = $2`,
          [row.run_id, row.step_id, approvalId, expiresAt],
        );
        await client.query(
          `UPDATE durable_workflow_runs
              SET status = 'waiting_approval', revision = revision + 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [row.run_id],
        );
        await appendEvent(client, {
          runId: row.run_id,
          organizationId: row.organization_id,
          stepId: row.step_id,
          eventType: 'approval_requested',
          summary: 'Workflow step is waiting for explicit approval',
          metadata: { expiresAt },
        });
        return null;
      }

      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(clock() + leaseMs).toISOString();
      await client.query(
        `UPDATE durable_workflow_steps
            SET status = 'running', attempt = attempt + 1, lease_owner = $3,
                lease_token = $4::uuid, lease_expires_at = $5,
                started_at = CURRENT_TIMESTAMP, error_summary = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE run_id = $1 AND step_id = $2`,
        [row.run_id, row.step_id, workerId, leaseToken, leaseExpiresAt],
      );
      await client.query(
        `UPDATE durable_workflow_runs
            SET status = 'running', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [row.run_id],
      );
      await appendEvent(client, {
        runId: row.run_id,
        organizationId: row.organization_id,
        stepId: row.step_id,
        eventType: 'step_claimed',
        summary: 'Workflow step claimed by a durable worker',
        metadata: { workerId, attempt: integer(row.attempt) + 1 },
      });
      return claimFromStep(row, workerId, leaseToken, leaseExpiresAt);
    });
  }

  async function renewLease(renewInput: {
    claim: DurableWorkflowClaim;
    leaseMs: number;
  }): Promise<boolean> {
    const leaseMs = bounded(
      renewInput.leaseMs,
      30_000,
      1_000,
      600_000,
      'Workflow lease',
    );
    const table =
      renewInput.claim.mode === 'forward'
        ? 'durable_workflow_steps'
        : 'durable_workflow_compensations';
    const expiresAt = new Date(clock() + leaseMs).toISOString();
    const result = await input.pool.query(
      `UPDATE ${table}
          SET lease_expires_at = $5, updated_at = CURRENT_TIMESTAMP
        WHERE run_id = $1 AND step_id = $2 AND status = 'running'
          AND lease_owner = $3 AND lease_token = $4::uuid
          AND lease_expires_at > CURRENT_TIMESTAMP`,
      [
        renewInput.claim.runId,
        renewInput.claim.stepId,
        renewInput.claim.workerId,
        renewInput.claim.leaseToken,
        expiresAt,
      ],
    );
    return result.rowCount === 1;
  }

  async function assertActiveClaim(
    client: PostgresClientLike,
    claim: DurableWorkflowClaim,
  ): Promise<void> {
    const table =
      claim.mode === 'forward'
        ? 'durable_workflow_steps'
        : 'durable_workflow_compensations';
    const result = await client.query(
      `SELECT run_id FROM ${table}
        WHERE run_id = $1 AND step_id = $2 AND status = 'running'
          AND lease_owner = $3 AND lease_token = $4::uuid
          AND lease_expires_at > CURRENT_TIMESTAMP
        FOR UPDATE`,
      [claim.runId, claim.stepId, claim.workerId, claim.leaseToken],
    );
    if (!result.rows[0]) throw new DurableWorkflowLeaseLostError();
  }

  async function succeedClaim(successInput: {
    claim: DurableWorkflowClaim;
    output: unknown;
  }): Promise<void> {
    await transaction(input.pool, async (client) => {
      await assertActiveClaim(client, successInput.claim);
      if (successInput.claim.mode === 'compensation') {
        await client.query(
          `UPDATE durable_workflow_compensations
              SET status = 'succeeded', lease_owner = NULL, lease_token = NULL,
                  lease_expires_at = NULL, error_summary = NULL,
                  completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE run_id = $1 AND step_id = $2`,
          [successInput.claim.runId, successInput.claim.stepId],
        );
        const remaining = await client.query(
          `SELECT 1 FROM durable_workflow_compensations
            WHERE run_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
          [successInput.claim.runId],
        );
        if (!remaining.rows[0]) {
          await client.query(
            `UPDATE durable_workflow_runs
                SET status = 'compensated', failure_code = NULL,
                    completed_at = CURRENT_TIMESTAMP, revision = revision + 1,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $1`,
            [successInput.claim.runId],
          );
        }
        await appendEvent(client, {
          runId: successInput.claim.runId,
          organizationId: successInput.claim.organizationId,
          stepId: successInput.claim.stepId,
          eventType: 'compensation_succeeded',
          summary: 'Explicit compensation completed',
        });
        return;
      }

      const outputJson =
        successInput.output === undefined
          ? null
          : JSON.stringify(successInput.output);
      if (outputJson && Buffer.byteLength(outputJson, 'utf8') > 1024 * 1024) {
        throw new Error('Workflow step output exceeds 1 MiB');
      }
      await client.query(
        `UPDATE durable_workflow_steps
            SET status = 'succeeded', output = $3::jsonb, error_summary = NULL,
                lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE run_id = $1 AND step_id = $2`,
        [successInput.claim.runId, successInput.claim.stepId, outputJson],
      );
      const remaining = await client.query(
        `SELECT 1 FROM durable_workflow_steps
          WHERE run_id = $1 AND status = 'queued' LIMIT 1`,
        [successInput.claim.runId],
      );
      await client.query(
        `UPDATE durable_workflow_runs
            SET status = $2, failure_code = NULL,
                completed_at = CASE WHEN $2 = 'succeeded' THEN CURRENT_TIMESTAMP ELSE NULL END,
                revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [successInput.claim.runId, remaining.rows[0] ? 'queued' : 'succeeded'],
      );
      await appendEvent(client, {
        runId: successInput.claim.runId,
        organizationId: successInput.claim.organizationId,
        stepId: successInput.claim.stepId,
        eventType: 'step_succeeded',
        summary: 'Workflow step completed',
      });
    });
  }

  async function deadLetter(
    client: PostgresClientLike,
    claim: DurableWorkflowClaim,
    reason: string,
  ): Promise<void> {
    const table =
      claim.mode === 'forward'
        ? 'durable_workflow_steps'
        : 'durable_workflow_compensations';
    await client.query(
      `UPDATE ${table}
          SET status = 'dead_letter', error_summary = $3,
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE run_id = $1 AND step_id = $2`,
      [claim.runId, claim.stepId, reason],
    );
    await client.query(
      `UPDATE durable_workflow_runs
          SET status = 'dead_letter', failure_code = 'retry_exhausted',
              revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [claim.runId],
    );
    await client.query(
      `INSERT INTO durable_workflow_dead_letters
         (id, run_id, organization_id, step_id, mode, reason, attempt)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        claim.runId,
        claim.organizationId,
        claim.stepId,
        claim.mode,
        reason,
        claim.attempt,
      ],
    );
  }

  async function failClaim(
    failureInput: Parameters<DurableWorkflowQueueStore['failClaim']>[0],
  ): Promise<void> {
    const reason = cleanSummary(
      failureInput.error,
      'Workflow execution failed',
    );
    await transaction(input.pool, async (client) => {
      await assertActiveClaim(client, failureInput.claim);
      const disposition =
        failureInput.claim.mode === 'compensation'
          ? failureInput.claim.attempt < failureInput.claim.maxAttempts
            ? 'retry'
            : 'dead_letter'
          : failureDisposition({
              sideEffect: failureInput.claim.sideEffect,
              attempt: failureInput.claim.attempt,
              maxAttempts: failureInput.claim.maxAttempts,
              certainty: failureInput.certainty,
            });
      const table =
        failureInput.claim.mode === 'forward'
          ? 'durable_workflow_steps'
          : 'durable_workflow_compensations';
      if (disposition === 'retry') {
        const availableAt = new Date(
          clock() + boundedRetryDelayMs(failureInput.claim.attempt),
        ).toISOString();
        await client.query(
          `UPDATE ${table}
              SET status = 'queued', error_summary = $3, available_at = $4,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE run_id = $1 AND step_id = $2`,
          [
            failureInput.claim.runId,
            failureInput.claim.stepId,
            reason,
            availableAt,
          ],
        );
        await client.query(
          `UPDATE durable_workflow_runs
              SET status = $2, failure_code = NULL, revision = revision + 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [
            failureInput.claim.runId,
            failureInput.claim.mode === 'forward' ? 'queued' : 'compensating',
          ],
        );
      } else if (disposition === 'unknown_outcome') {
        await client.query(
          `UPDATE durable_workflow_steps
              SET status = 'unknown_outcome', error_summary = $3,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                  completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE run_id = $1 AND step_id = $2`,
          [failureInput.claim.runId, failureInput.claim.stepId, reason],
        );
        await client.query(
          `UPDATE durable_workflow_runs
              SET status = 'unknown_outcome', failure_code = 'external_outcome_unknown',
                  revision = revision + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [failureInput.claim.runId],
        );
      } else {
        await deadLetter(client, failureInput.claim, reason);
      }
      await appendEvent(client, {
        runId: failureInput.claim.runId,
        organizationId: failureInput.claim.organizationId,
        stepId: failureInput.claim.stepId,
        eventType: `step_${disposition}`,
        summary:
          disposition === 'unknown_outcome'
            ? 'External outcome is unknown and requires human reconciliation'
            : disposition === 'retry'
              ? 'Workflow step scheduled for bounded retry'
              : 'Workflow step moved to dead letter',
        metadata: {
          attempt: failureInput.claim.attempt,
          mode: failureInput.claim.mode,
        },
      });
    });
  }

  async function recoverExpiredWork(
    recoverInput: { limit?: number } = {},
  ): Promise<number> {
    const limit = bounded(recoverInput.limit, 100, 1, 1_000, 'Recovery limit');
    const expired = await input.pool.query<StepRow>(
      `SELECT step.*, run.definition_id
         FROM durable_workflow_steps step
         JOIN durable_workflow_runs run ON run.id = step.run_id
        WHERE step.status = 'running' AND step.lease_expires_at <= CURRENT_TIMESTAMP
        ORDER BY step.lease_expires_at LIMIT $1`,
      [limit],
    );
    let recovered = 0;
    for (const row of expired.rows) {
      const claim: DurableWorkflowClaim = {
        mode: 'forward',
        runId: row.run_id,
        organizationId: row.organization_id,
        definitionId: row.definition_id,
        stepId: row.step_id,
        taskType: row.task_type,
        input: jsonObject(row.input),
        sideEffect: row.side_effect,
        attempt: integer(row.attempt),
        maxAttempts: integer(row.max_attempts),
        idempotencyKey: row.idempotency_key,
        workerId: row.lease_owner || 'expired-worker',
        leaseToken: row.lease_token || randomUUID(),
        leaseExpiresAt: iso(row.lease_expires_at) || new Date(0).toISOString(),
      };
      const changed = await recoverExpiredForwardClaim(claim);
      if (changed) recovered += 1;
    }

    let remaining = Math.max(0, limit - recovered);
    if (remaining > 0) {
      const compensations = await input.pool.query<CompensationRow>(
        `SELECT compensation.*, run.definition_id
           FROM durable_workflow_compensations compensation
           JOIN durable_workflow_runs run ON run.id = compensation.run_id
          WHERE compensation.status = 'running'
            AND compensation.lease_expires_at <= CURRENT_TIMESTAMP
          ORDER BY compensation.lease_expires_at LIMIT $1`,
        [remaining],
      );
      for (const row of compensations.rows) {
        const changed = await recoverExpiredCompensation(row);
        if (changed) recovered += 1;
      }
      remaining = Math.max(0, limit - recovered);
    }
    if (remaining > 0) {
      const approvals = await input.pool.query<StepRow>(
        `SELECT step.*, run.definition_id
           FROM durable_workflow_steps step
           JOIN durable_workflow_runs run ON run.id = step.run_id
          WHERE step.status = 'waiting_approval'
            AND step.approval_expires_at <= CURRENT_TIMESTAMP
          ORDER BY step.approval_expires_at LIMIT $1`,
        [remaining],
      );
      for (const row of approvals.rows) {
        const changed = await expireApproval(row);
        if (changed) recovered += 1;
      }
    }
    return recovered;
  }

  async function recoverExpiredCompensation(
    row: CompensationRow,
  ): Promise<boolean> {
    return transaction(input.pool, async (client) => {
      const locked = await client.query<CompensationRow>(
        `SELECT compensation.*, run.definition_id
           FROM durable_workflow_compensations compensation
           JOIN durable_workflow_runs run ON run.id = compensation.run_id
          WHERE compensation.run_id = $1 AND compensation.step_id = $2
            AND compensation.status = 'running'
            AND compensation.lease_expires_at <= CURRENT_TIMESTAMP
          FOR UPDATE OF compensation`,
        [row.run_id, row.step_id],
      );
      const current = locked.rows[0];
      if (!current) return false;
      const attempt = integer(current.attempt);
      const maxAttempts = integer(current.max_attempts);
      const reason = 'Compensation worker lease expired before completion';
      if (attempt < maxAttempts) {
        await client.query(
          `UPDATE durable_workflow_compensations
              SET status = 'queued', error_summary = $3,
                  available_at = CURRENT_TIMESTAMP, lease_owner = NULL,
                  lease_token = NULL, lease_expires_at = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE run_id = $1 AND step_id = $2`,
          [current.run_id, current.step_id, reason],
        );
      } else {
        const claim = claimFromCompensation(
          { ...current, attempt: attempt - 1 },
          current.lease_owner || 'expired-worker',
          current.lease_token || randomUUID(),
          iso(current.lease_expires_at) || new Date(0).toISOString(),
        );
        await deadLetter(client, { ...claim, attempt }, reason);
      }
      await appendEvent(client, {
        runId: current.run_id,
        organizationId: current.organization_id,
        stepId: current.step_id,
        eventType:
          attempt < maxAttempts
            ? 'compensation_lease_expired_retry'
            : 'compensation_lease_expired_dead_letter',
        summary: reason,
        metadata: { attempt },
      });
      return true;
    });
  }

  async function recoverExpiredForwardClaim(
    claim: DurableWorkflowClaim,
  ): Promise<boolean> {
    return transaction(input.pool, async (client) => {
      const locked = await client.query<StepRow>(
        `SELECT step.*, run.definition_id
           FROM durable_workflow_steps step
           JOIN durable_workflow_runs run ON run.id = step.run_id
          WHERE step.run_id = $1 AND step.step_id = $2
            AND step.status = 'running' AND step.lease_expires_at <= CURRENT_TIMESTAMP
          FOR UPDATE OF step`,
        [claim.runId, claim.stepId],
      );
      const row = locked.rows[0];
      if (!row) return false;
      const disposition = expiredLeaseDisposition({
        sideEffect: row.side_effect,
        attempt: integer(row.attempt),
        maxAttempts: integer(row.max_attempts),
      });
      const reason =
        disposition === 'unknown_outcome'
          ? 'Worker lease expired after an external side effect may have started'
          : 'Worker lease expired before completion';
      if (disposition === 'retry') {
        await client.query(
          `UPDATE durable_workflow_steps
              SET status = 'queued', error_summary = $3,
                  available_at = CURRENT_TIMESTAMP, lease_owner = NULL,
                  lease_token = NULL, lease_expires_at = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE run_id = $1 AND step_id = $2`,
          [row.run_id, row.step_id, reason],
        );
        await client.query(
          `UPDATE durable_workflow_runs
              SET status = 'queued', failure_code = NULL,
                  revision = revision + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [row.run_id],
        );
      } else if (disposition === 'unknown_outcome') {
        await client.query(
          `UPDATE durable_workflow_steps
              SET status = 'unknown_outcome', error_summary = $3,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                  completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE run_id = $1 AND step_id = $2`,
          [row.run_id, row.step_id, reason],
        );
        await client.query(
          `UPDATE durable_workflow_runs
              SET status = 'unknown_outcome', failure_code = 'external_outcome_unknown',
                  revision = revision + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [row.run_id],
        );
      } else {
        await deadLetter(
          client,
          { ...claim, attempt: integer(row.attempt) },
          reason,
        );
      }
      await appendEvent(client, {
        runId: row.run_id,
        organizationId: row.organization_id,
        stepId: row.step_id,
        eventType: `lease_expired_${disposition}`,
        summary: reason,
        metadata: { attempt: integer(row.attempt) },
      });
      return true;
    });
  }

  async function expireApproval(row: StepRow): Promise<boolean> {
    return transaction(input.pool, async (client) => {
      const locked = await client.query<StepRow>(
        `SELECT * FROM durable_workflow_steps
          WHERE run_id = $1 AND step_id = $2 AND status = 'waiting_approval'
            AND approval_expires_at <= CURRENT_TIMESTAMP FOR UPDATE`,
        [row.run_id, row.step_id],
      );
      if (!locked.rows[0]) return false;
      const reason = 'Approval deadline expired';
      await client.query(
        `UPDATE durable_workflow_steps
            SET status = 'dead_letter', error_summary = $3,
                approval_id = NULL, approval_expires_at = NULL,
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE run_id = $1 AND step_id = $2`,
        [row.run_id, row.step_id, reason],
      );
      await client.query(
        `UPDATE durable_workflow_runs
            SET status = 'dead_letter', failure_code = 'approval_timeout',
                revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [row.run_id],
      );
      await client.query(
        `INSERT INTO durable_workflow_dead_letters
           (id, run_id, organization_id, step_id, mode, reason, attempt)
         VALUES ($1::uuid, $2, $3, $4, 'forward', $5, $6)`,
        [
          randomUUID(),
          row.run_id,
          row.organization_id,
          row.step_id,
          reason,
          Math.max(1, integer(row.attempt)),
        ],
      );
      await appendEvent(client, {
        runId: row.run_id,
        organizationId: row.organization_id,
        stepId: row.step_id,
        eventType: 'approval_expired',
        summary: reason,
      });
      return true;
    });
  }

  async function listRuns(listInput: {
    organizationId: string;
    createdByAccountId?: string;
    statuses?: readonly DurableWorkflowRunStatus[];
    limit?: number;
  }): Promise<DurableWorkflowRunListItem[]> {
    const limit = bounded(listInput.limit, 100, 1, 500, 'Workflow list limit');
    const statuses = listInput.statuses?.length
      ? [...new Set(listInput.statuses)]
      : null;
    const result = await input.pool.query<RunRow>(
      `SELECT id, organization_id, definition_id, status, priority,
              created_by_account_id, failure_code, created_at, updated_at
         FROM durable_workflow_runs
        WHERE organization_id = $1
          AND ($2::text[] IS NULL OR status = ANY($2::text[]))
          AND ($3::text IS NULL OR created_by_account_id = $3)
        ORDER BY updated_at DESC, id LIMIT $4`,
      [
        listInput.organizationId,
        statuses,
        listInput.createdByAccountId ?? null,
        limit,
      ],
    );
    return result.rows.map(mapRun);
  }

  function mapRun(row: RunRow): DurableWorkflowRunListItem {
    return {
      id: row.id,
      organizationId: row.organization_id,
      definitionId: row.definition_id,
      status: row.status,
      priority: integer(row.priority),
      createdByAccountId: row.created_by_account_id,
      failureCode: row.failure_code,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
    };
  }

  async function getRun(getInput: {
    organizationId: string;
    runId: string;
  }): Promise<DurableWorkflowRunDetail | null> {
    const result = await input.pool.query<RunRow>(
      `SELECT id, organization_id, definition_id, status, priority,
              created_by_account_id, failure_code, created_at, updated_at
         FROM durable_workflow_runs WHERE organization_id = $1 AND id = $2`,
      [getInput.organizationId, getInput.runId],
    );
    const run = result.rows[0];
    if (!run) return null;
    const [steps, compensations, letters] = await Promise.all([
      input.pool.query<StepRow>(
        `SELECT run_id, organization_id, '' AS definition_id, sequence, step_id,
                task_type, status, side_effect, input, attempt, max_attempts,
                idempotency_key, requires_approval, approval_timeout_seconds,
                approval_id, approval_expires_at, approved_at, error_summary,
                started_at, completed_at
           FROM durable_workflow_steps WHERE run_id = $1 ORDER BY sequence`,
        [run.id],
      ),
      input.pool.query<CompensationRow>(
        `SELECT run_id, organization_id, '' AS definition_id, step_id,
                task_type, input, status, attempt, max_attempts,
                idempotency_key, error_summary, completed_at
           FROM durable_workflow_compensations
          WHERE run_id = $1 ORDER BY reverse_sequence`,
        [run.id],
      ),
      input.pool.query<DeadLetterRow>(
        `SELECT id, step_id, mode, reason, attempt, created_at, resolved_at
           FROM durable_workflow_dead_letters WHERE run_id = $1
          ORDER BY created_at, id`,
        [run.id],
      ),
    ]);
    return {
      ...mapRun(run),
      steps: steps.rows.map((step) => ({
        stepId: step.step_id,
        sequence: integer(step.sequence),
        taskType: step.task_type,
        status: step.status,
        sideEffect: step.side_effect,
        attempt: integer(step.attempt),
        maxAttempts: integer(step.max_attempts),
        requiresApproval: step.requires_approval,
        approvalId: step.approval_id,
        approvalExpiresAt: iso(step.approval_expires_at),
        approvedAt: iso(step.approved_at),
        errorSummary: step.error_summary,
        startedAt: iso(step.started_at),
        completedAt: iso(step.completed_at),
      })),
      compensations: compensations.rows.map((compensation) => ({
        stepId: compensation.step_id,
        taskType: compensation.task_type,
        status: compensation.status!,
        attempt: integer(compensation.attempt),
        maxAttempts: integer(compensation.max_attempts),
        errorSummary: compensation.error_summary ?? null,
        completedAt: iso(compensation.completed_at),
      })),
      deadLetters: letters.rows.map((letter) => ({
        id: letter.id,
        stepId: letter.step_id,
        mode: letter.mode,
        reason: letter.reason,
        attempt: integer(letter.attempt),
        createdAt: iso(letter.created_at)!,
        resolvedAt: iso(letter.resolved_at),
      })),
    };
  }

  async function approve(
    approveInput: Parameters<DurableWorkflowQueueStore['approve']>[0],
  ): Promise<void> {
    await transaction(input.pool, async (client) => {
      const result = await client.query<StepRow>(
        `SELECT * FROM durable_workflow_steps
          WHERE run_id = $1 AND organization_id = $2 AND step_id = $3
            AND status = 'waiting_approval' AND approval_id = $4
            AND approval_expires_at > CURRENT_TIMESTAMP FOR UPDATE`,
        [
          approveInput.runId,
          approveInput.organizationId,
          approveInput.stepId,
          approveInput.approvalId,
        ],
      );
      if (!result.rows[0])
        throw new DurableWorkflowConflictError(
          'Workflow approval is unavailable or expired',
        );
      await client.query(
        `UPDATE durable_workflow_steps
            SET status = 'queued', approved_by_account_id = $4, approved_at = CURRENT_TIMESTAMP,
                approval_id = NULL, approval_expires_at = NULL, available_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE run_id = $1 AND organization_id = $2 AND step_id = $3`,
        [
          approveInput.runId,
          approveInput.organizationId,
          approveInput.stepId,
          approveInput.actor.accountId,
        ],
      );
      await client.query(
        `UPDATE durable_workflow_runs SET status = 'queued', revision = revision + 1,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND organization_id = $2`,
        [approveInput.runId, approveInput.organizationId],
      );
      await appendEvent(client, {
        runId: approveInput.runId,
        organizationId: approveInput.organizationId,
        stepId: approveInput.stepId,
        actorAccountId: approveInput.actor.accountId,
        eventType: 'approval_recorded',
        summary: 'Explicit workflow approval recorded',
      });
    });
  }

  async function retryDeadLetter(
    retryInput: Parameters<DurableWorkflowQueueStore['retryDeadLetter']>[0],
  ): Promise<void> {
    const note = cleanSummary(retryInput.note, 'Manual retry');
    const mode = retryInput.mode ?? 'forward';
    await transaction(input.pool, async (client) => {
      const table =
        mode === 'forward'
          ? 'durable_workflow_steps'
          : 'durable_workflow_compensations';
      const result = await client.query<StepRow | CompensationRow>(
        `SELECT * FROM ${table}
          WHERE run_id = $1 AND organization_id = $2 AND step_id = $3
            AND status = 'dead_letter' FOR UPDATE`,
        [retryInput.runId, retryInput.organizationId, retryInput.stepId],
      );
      const item = result.rows[0];
      if (!item)
        throw new DurableWorkflowConflictError(
          'Dead-letter workflow work item was not found',
        );
      if (
        mode === 'forward' &&
        (item as StepRow).side_effect === 'external' &&
        !retryInput.confirmedExternalNotExecuted
      ) {
        throw new DurableWorkflowConflictError(
          'External retry requires explicit confirmation that no side effect occurred',
        );
      }
      await client.query(
        `UPDATE ${table}
            SET status = 'queued', attempt = 0, error_summary = NULL,
                completed_at = NULL, available_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE run_id = $1 AND step_id = $2`,
        [retryInput.runId, retryInput.stepId],
      );
      await client.query(
        `UPDATE durable_workflow_dead_letters
            SET resolved_by_account_id = $5, resolution_note = $6,
                resolved_at = CURRENT_TIMESTAMP
          WHERE run_id = $1 AND organization_id = $2 AND step_id = $3
            AND mode = $4
            AND resolved_at IS NULL`,
        [
          retryInput.runId,
          retryInput.organizationId,
          retryInput.stepId,
          mode,
          retryInput.actor.accountId,
          note,
        ],
      );
      await client.query(
        `UPDATE durable_workflow_runs SET status = $2, failure_code = NULL,
                completed_at = NULL, revision = revision + 1,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [retryInput.runId, mode === 'forward' ? 'queued' : 'compensating'],
      );
      await appendEvent(client, {
        runId: retryInput.runId,
        organizationId: retryInput.organizationId,
        stepId: retryInput.stepId,
        actorAccountId: retryInput.actor.accountId,
        eventType: 'dead_letter_retried',
        summary: note,
        metadata: { mode },
      });
    });
  }

  async function resolveUnknown(
    resolveInput: Parameters<DurableWorkflowQueueStore['resolveUnknown']>[0],
  ): Promise<void> {
    const note = cleanSummary(resolveInput.note, 'Manual reconciliation');
    await transaction(input.pool, async (client) => {
      const result = await client.query<StepRow>(
        `SELECT * FROM durable_workflow_steps
          WHERE run_id = $1 AND organization_id = $2 AND step_id = $3
            AND status = 'unknown_outcome' FOR UPDATE`,
        [resolveInput.runId, resolveInput.organizationId, resolveInput.stepId],
      );
      if (!result.rows[0])
        throw new DurableWorkflowConflictError(
          'Unknown workflow outcome was not found',
        );
      const stepStatus =
        resolveInput.resolution === 'mark_succeeded'
          ? 'succeeded'
          : resolveInput.resolution === 'cancel'
            ? 'cancelled'
            : 'failed';
      await client.query(
        `UPDATE durable_workflow_steps
            SET status = $3, error_summary = $4, completed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP WHERE run_id = $1 AND step_id = $2`,
        [resolveInput.runId, resolveInput.stepId, stepStatus, note],
      );
      let runStatus: DurableWorkflowRunStatus =
        stepStatus === 'cancelled' ? 'cancelled' : 'failed';
      if (stepStatus === 'succeeded') {
        const remaining = await client.query(
          `SELECT 1 FROM durable_workflow_steps WHERE run_id = $1 AND status = 'queued' LIMIT 1`,
          [resolveInput.runId],
        );
        runStatus = remaining.rows[0] ? 'queued' : 'succeeded';
      }
      await client.query(
        `UPDATE durable_workflow_runs
            SET status = $2, failure_code = NULL, revision = revision + 1,
                completed_at = CASE WHEN $2 IN ('succeeded','failed','cancelled') THEN CURRENT_TIMESTAMP ELSE NULL END,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [resolveInput.runId, runStatus],
      );
      await appendEvent(client, {
        runId: resolveInput.runId,
        organizationId: resolveInput.organizationId,
        stepId: resolveInput.stepId,
        actorAccountId: resolveInput.actor.accountId,
        eventType: `unknown_resolved_${resolveInput.resolution}`,
        summary: note,
      });
    });
  }

  async function requestCompensation(
    compensateInput: Parameters<
      DurableWorkflowQueueStore['requestCompensation']
    >[0],
  ): Promise<void> {
    const note = cleanSummary(
      compensateInput.note,
      'Manual compensation requested',
    );
    await transaction(input.pool, async (client) => {
      const steps = await client.query<StepRow>(
        `SELECT step.*, run.definition_id
           FROM durable_workflow_steps step JOIN durable_workflow_runs run ON run.id = step.run_id
          WHERE step.run_id = $1 AND step.organization_id = $2
            AND step.status = 'succeeded' AND step.compensation IS NOT NULL
          ORDER BY step.sequence DESC FOR UPDATE OF step`,
        [compensateInput.runId, compensateInput.organizationId],
      );
      if (steps.rows.length === 0)
        throw new DurableWorkflowConflictError(
          'Workflow has no completed compensable steps',
        );
      const run = await client.query<RunRow>(
        `SELECT * FROM durable_workflow_runs
          WHERE id = $1 AND organization_id = $2
            AND status IN ('failed','cancelled','unknown_outcome','dead_letter') FOR UPDATE`,
        [compensateInput.runId, compensateInput.organizationId],
      );
      if (!run.rows[0])
        throw new DurableWorkflowConflictError(
          'Workflow is not eligible for compensation',
        );
      const existing = await client.query(
        `SELECT 1 FROM durable_workflow_compensations
          WHERE run_id = $1 LIMIT 1 FOR UPDATE`,
        [compensateInput.runId],
      );
      if (existing.rows[0]) {
        throw new DurableWorkflowConflictError(
          'Workflow compensation was already requested; use dead-letter retry when required',
        );
      }
      for (let index = 0; index < steps.rows.length; index += 1) {
        const step = steps.rows[index]!;
        const compensation = jsonObject(
          step.compensation as Record<string, unknown> | string,
        );
        await client.query(
          `INSERT INTO durable_workflow_compensations
             (run_id, organization_id, step_id, reverse_sequence, task_type, input,
              status, max_attempts, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'queued', $7, $8)
           ON CONFLICT (run_id, step_id) DO NOTHING`,
          [
            step.run_id,
            step.organization_id,
            step.step_id,
            index,
            String(compensation['taskType']),
            JSON.stringify(compensation['input'] ?? {}),
            bounded(
              Number(compensation['maxAttempts']) || undefined,
              3,
              1,
              20,
              'Compensation max attempts',
            ),
            `${step.run_id}:${step.step_id}:compensate`,
          ],
        );
      }
      await client.query(
        `UPDATE durable_workflow_runs SET status = 'compensating', failure_code = NULL,
                revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [compensateInput.runId],
      );
      await appendEvent(client, {
        runId: compensateInput.runId,
        organizationId: compensateInput.organizationId,
        actorAccountId: compensateInput.actor.accountId,
        eventType: 'compensation_requested',
        summary: note,
        metadata: { stepCount: steps.rows.length },
      });
    });
  }

  async function cancel(
    cancelInput: Parameters<DurableWorkflowQueueStore['cancel']>[0],
  ): Promise<void> {
    const note = cleanSummary(
      cancelInput.note,
      'Workflow cancelled by an administrator',
    );
    await transaction(input.pool, async (client) => {
      const lockedSteps = await client.query<StepRow>(
        `SELECT * FROM durable_workflow_steps
          WHERE run_id = $1 FOR UPDATE`,
        [cancelInput.runId],
      );
      await client.query<CompensationRow>(
        `SELECT * FROM durable_workflow_compensations
          WHERE run_id = $1 FOR UPDATE`,
        [cancelInput.runId],
      );
      const run = await client.query<RunRow>(
        `SELECT * FROM durable_workflow_runs
          WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [cancelInput.runId, cancelInput.organizationId],
      );
      const current = run.rows[0];
      if (!current)
        throw new DurableWorkflowConflictError('Workflow run was not found');
      if (['succeeded', 'compensated', 'cancelled'].includes(current.status)) {
        throw new DurableWorkflowConflictError(
          'Workflow run is already terminal',
        );
      }
      const activeExternal = lockedSteps.rows.some(
        (step) => step.status === 'running' && step.side_effect === 'external',
      );
      if (activeExternal) {
        await client.query(
          `UPDATE durable_workflow_steps
              SET status = 'unknown_outcome', error_summary = $2,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                  completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE run_id = $1 AND status = 'running' AND side_effect = 'external'`,
          [
            cancelInput.runId,
            'Cancellation requested while an external side effect was running',
          ],
        );
        await client.query(
          `UPDATE durable_workflow_runs SET status = 'unknown_outcome',
                  failure_code = 'external_outcome_unknown', revision = revision + 1,
                  updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [cancelInput.runId],
        );
      } else {
        await client.query(
          `UPDATE durable_workflow_steps
              SET status = 'cancelled', error_summary = $2,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                  approval_id = NULL, approval_expires_at = NULL,
                  completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE run_id = $1 AND status IN ('queued','running','waiting_approval')`,
          [cancelInput.runId, note],
        );
        await client.query(
          `UPDATE durable_workflow_compensations
              SET status = 'cancelled', error_summary = $2,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                  completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE run_id = $1 AND status IN ('queued','running')`,
          [cancelInput.runId, note],
        );
        await client.query(
          `UPDATE durable_workflow_runs SET status = 'cancelled', failure_code = NULL,
                  completed_at = CURRENT_TIMESTAMP, revision = revision + 1,
                  updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [cancelInput.runId],
        );
      }
      await appendEvent(client, {
        runId: cancelInput.runId,
        organizationId: cancelInput.organizationId,
        actorAccountId: cancelInput.actor.accountId,
        eventType: activeExternal ? 'cancel_unknown_outcome' : 'run_cancelled',
        summary: note,
      });
    });
  }

  return {
    createRun,
    claimNext,
    renewLease,
    succeedClaim,
    failClaim,
    recoverExpiredWork,
    listRuns,
    getRun,
    approve,
    retryDeadLetter,
    resolveUnknown,
    requestCompensation,
    cancel,
  };
}
