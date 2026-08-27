/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from '../../enterprise/postgresMigrations.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryResult,
} from '../data_platform/postgresDatabaseLifecycle.js';
import {
  DurableWorkflowConflictError,
  type DurableWorkflowClaim,
  type DurableWorkflowDefinition,
} from './contracts.js';
import { createPostgresDurableWorkflowRepository } from './postgresRepository.js';

function result<Row extends Record<string, unknown>>(
  rows: Row[] = [],
  rowCount = rows.length,
): PostgresQueryResult<Row> {
  return { rows, rowCount };
}

function expectBoundParameters(sql: string, values: readonly unknown[]): void {
  const indexes = [...sql.matchAll(/\$(\d+)/gu)].map((match) =>
    Number(match[1]),
  );
  const highest = Math.max(0, ...indexes);
  expect(values).toHaveLength(highest);
  expect(new Set(indexes)).toEqual(
    new Set(Array.from({ length: highest }, (_, index) => index + 1)),
  );
}

describe('Postgres durable workflow repository', () => {
  it('ships a tenant-scoped queue, lease, dead-letter, compensation and audit schema', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 16,
    );
    expect(migration).toMatchObject({
      version: 16,
      name: 'durable-workflow-queue',
    });
    for (const table of [
      'durable_workflow_runs',
      'durable_workflow_steps',
      'durable_workflow_compensations',
      'durable_workflow_dead_letters',
      'durable_workflow_events',
    ]) {
      expect(migration!.sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration!.sql).toContain('lease_token UUID');
    expect(migration!.sql).toContain('approval_expires_at TIMESTAMPTZ');
    expect(migration!.sql).toContain('FOREIGN KEY (run_id, organization_id)');
    const idempotencyMigration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 17,
    );
    expect(idempotencyMigration).toMatchObject({
      version: 17,
      name: 'durable-workflow-submission-idempotency',
    });
    expect(idempotencyMigration!.sql).toContain(
      'durable_workflow_runs_submission_idempotency',
    );
    expect(idempotencyMigration!.sql).toContain(
      'submission_request_digest',
    );
  });

  it('returns the original run for the same submission key and rejects a changed request', async () => {
    let persisted: {
      id: string;
      organization_id: string;
      definition_id: string;
      priority: number;
      created_by_account_id: string | null;
      submission_idempotency_key: string;
      submission_request_digest: string;
    } | null = null;
    let stepInsertions = 0;
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes('INSERT INTO durable_workflow_runs')) {
          if (persisted) return result([]);
          persisted = {
            id: String(values[0]),
            organization_id: String(values[1]),
            definition_id: String(values[2]),
            priority: Number(values[3]),
            created_by_account_id:
              values[4] === null ? null : String(values[4]),
            submission_idempotency_key: String(values[5]),
            submission_request_digest: String(values[6]),
          };
          return result([{ id: persisted.id }]);
        }
        if (sql.includes('SELECT id, submission_request_digest')) {
          return result(
            persisted
              ? [
                  {
                    id: persisted.id,
                    submission_request_digest:
                      persisted.submission_request_digest,
                    created_by_account_id: persisted.created_by_account_id,
                  },
                ]
              : [],
          );
        }
        if (sql.includes('INSERT INTO durable_workflow_steps')) {
          stepInsertions += 1;
        }
        return result([]);
      }),
      release: vi.fn(),
    };
    const pool: PostgresPoolLike = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM durable_workflow_runs')) {
          return result(
            persisted
              ? [
                  {
                    id: persisted.id,
                    organization_id: persisted.organization_id,
                    definition_id: persisted.definition_id,
                    status: 'queued',
                    priority: persisted.priority,
                    created_by_account_id: persisted.created_by_account_id,
                    failure_code: null,
                    created_at: new Date('2026-08-24T00:00:00.000Z'),
                    updated_at: new Date('2026-08-24T00:00:00.000Z'),
                  },
                ]
              : [],
          );
        }
        if (sql.includes('FROM durable_workflow_steps')) {
          return result([
            {
              run_id: persisted!.id,
              organization_id: persisted!.organization_id,
              definition_id: '',
              sequence: 0,
              step_id: 'checkpoint',
              task_type: 'workflow.checkpoint',
              status: 'queued',
              side_effect: 'none',
              input: {},
              attempt: 0,
              max_attempts: 3,
              idempotency_key: `${persisted!.id}:checkpoint`,
              requires_approval: false,
              approval_timeout_seconds: 86_400,
              approval_id: null,
              approval_expires_at: null,
              approved_at: null,
              error_summary: null,
              started_at: null,
              completed_at: null,
            },
          ]);
        }
        return result([]);
      }),
      end: vi.fn(),
    };
    const repository = createPostgresDurableWorkflowRepository({ pool });
    const definition: DurableWorkflowDefinition = {
      id: 'safe',
      version: 1,
      steps: [
        {
          id: 'checkpoint',
          taskType: 'workflow.checkpoint',
          input: { beta: 2, alpha: 1 },
          sideEffect: 'none',
        },
      ],
    };
    const common = {
      actor: {
        organizationId: 'org-1',
        accountId: 'account-1',
        display: 'Admin',
      },
      submissionIdempotencyKey: 'client-request-1',
    };

    const first = await repository.createRun({ definition, ...common });
    const replay = await repository.createRun({
      ...common,
      definition: {
        ...definition,
        steps: [
          {
            ...definition.steps[0]!,
            input: { alpha: 1, beta: 2 },
          },
        ],
      },
    });

    expect(replay.id).toBe(first.id);
    expect(stepInsertions).toBe(1);
    await expect(
      repository.createRun({
        ...common,
        definition: {
          ...definition,
          steps: [
            {
              ...definition.steps[0]!,
              input: { alpha: 1, beta: 3 },
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(DurableWorkflowConflictError);
    expect(stepInsertions).toBe(1);
  });

  it('claims one ready step with SKIP LOCKED and a stable idempotency key', async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.includes('FROM durable_workflow_compensations compensation')) {
          return result([]);
        }
        if (
          sql.includes('FROM durable_workflow_steps step') &&
          sql.includes('FOR UPDATE OF step SKIP LOCKED')
        ) {
          return result([
            {
              run_id: 'wf-00000000-0000-4000-8000-000000000001',
              organization_id: 'org-1',
              definition_id: 'monthly-report',
              sequence: 0,
              step_id: 'compile',
              task_type: 'report.compile',
              status: 'queued',
              side_effect: 'idempotent',
              input: { month: '2026-08' },
              attempt: 0,
              max_attempts: 3,
              idempotency_key: 'wf-1:compile',
              requires_approval: false,
              approval_timeout_seconds: 3600,
              approval_id: null,
              approval_expires_at: null,
              approved_at: null,
              error_summary: null,
              started_at: null,
              completed_at: null,
            },
          ]);
        }
        return result([]);
      }),
      release: vi.fn(),
    };
    const pool: PostgresPoolLike = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn(),
      end: vi.fn(),
    };
    const repository = createPostgresDurableWorkflowRepository({
      pool,
      clock: () => Date.parse('2026-08-24T00:00:00.000Z'),
    });

    const claim = await repository.claimNext({
      workerId: 'worker-1',
      leaseMs: 30_000,
    });

    expect(claim).toMatchObject({
      mode: 'forward',
      stepId: 'compile',
      attempt: 1,
      idempotencyKey: 'wf-1:compile',
      workerId: 'worker-1',
      leaseExpiresAt: '2026-08-24T00:00:30.000Z',
    });
    expect(
      statements.some(({ sql }) =>
        sql.includes('FOR UPDATE OF step SKIP LOCKED'),
      ),
    ).toBe(true);
    expect(
      statements.some(
        ({ sql }) =>
          sql.includes('FROM durable_workflow_compensations prior') &&
          sql.includes("prior.status <> 'succeeded'"),
      ),
    ).toBe(true);
    expect(
      statements.some(
        ({ sql }) =>
          sql.includes("SET status = 'running'") &&
          sql.includes('lease_token = $4::uuid'),
      ),
    ).toBe(true);
  });

  it('renews only the active worker fencing token before lease expiry', async () => {
    const query = vi.fn().mockResolvedValue(result([], 1));
    const pool: PostgresPoolLike = {
      connect: vi.fn(),
      query,
      end: vi.fn(),
    };
    const repository = createPostgresDurableWorkflowRepository({ pool });
    const claim: DurableWorkflowClaim = {
      mode: 'forward',
      runId: 'wf-00000000-0000-4000-8000-000000000001',
      organizationId: 'org-1',
      definitionId: 'monthly-report',
      stepId: 'compile',
      taskType: 'report.compile',
      input: {},
      sideEffect: 'none',
      attempt: 1,
      maxAttempts: 3,
      idempotencyKey: 'wf-1:compile',
      workerId: 'worker-1',
      leaseToken: '00000000-0000-4000-8000-000000000002',
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    };

    await expect(
      repository.renewLease({ claim, leaseMs: 30_000 }),
    ).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('lease_token = $4::uuid'),
      expect.arrayContaining([claim.workerId, claim.leaseToken]),
    );
    expect(query.mock.calls[0]![0]).toContain(
      'lease_expires_at > CURRENT_TIMESTAMP',
    );
  });

  it('records approval in one transaction without an unbound parameter gap', async () => {
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        expectBoundParameters(sql, values);
        if (
          sql.includes("status = 'waiting_approval'") &&
          sql.includes('FOR UPDATE')
        ) {
          return result([
            {
              run_id: 'wf-00000000-0000-4000-8000-000000000001',
              organization_id: 'org-1',
              definition_id: 'monthly-report',
              sequence: 0,
              step_id: 'approve',
              task_type: 'workflow.checkpoint',
              status: 'waiting_approval',
              side_effect: 'none',
              input: {},
              attempt: 0,
              max_attempts: 3,
              idempotency_key: 'wf-1:approve',
              requires_approval: true,
              approval_timeout_seconds: 3600,
              approval_id: 'approval-1',
              approval_expires_at: new Date(Date.now() + 60_000),
              approved_at: null,
              error_summary: null,
              started_at: null,
              completed_at: null,
            },
          ]);
        }
        return result([]);
      }),
      release: vi.fn(),
    };
    const repository = createPostgresDurableWorkflowRepository({
      pool: {
        connect: vi.fn().mockResolvedValue(client),
        query: vi.fn(),
        end: vi.fn(),
      },
    });

    await expect(
      repository.approve({
        organizationId: 'org-1',
        runId: 'wf-00000000-0000-4000-8000-000000000001',
        stepId: 'approve',
        approvalId: 'approval-1',
        actor: {
          organizationId: 'org-1',
          accountId: 'account-1',
          display: 'Admin',
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('queues explicit compensations in reverse successful-step order', async () => {
    const captured: unknown[][] = [];
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (
          sql.includes('FROM durable_workflow_runs') &&
          sql.includes('FOR UPDATE')
        ) {
          return result([
            {
              id: 'wf-00000000-0000-4000-8000-000000000001',
              organization_id: 'org-1',
              definition_id: 'monthly-report',
              status: 'failed',
              priority: 50,
              created_by_account_id: 'account-1',
              failure_code: 'step_failed',
              created_at: new Date(),
              updated_at: new Date(),
            },
          ]);
        }
        if (sql.includes('step.compensation IS NOT NULL')) {
          return result([
            {
              run_id: 'wf-00000000-0000-4000-8000-000000000001',
              organization_id: 'org-1',
              definition_id: 'monthly-report',
              sequence: 2,
              step_id: 'publish',
              task_type: 'report.publish',
              status: 'succeeded',
              side_effect: 'idempotent',
              input: {},
              attempt: 1,
              max_attempts: 3,
              idempotency_key: 'wf-1:publish',
              requires_approval: false,
              approval_timeout_seconds: 3600,
              approval_id: null,
              approval_expires_at: null,
              approved_at: null,
              error_summary: null,
              started_at: new Date(),
              completed_at: new Date(),
              compensation: {
                taskType: 'report.unpublish',
                input: { reportId: 'r-1' },
              },
            },
            {
              run_id: 'wf-00000000-0000-4000-8000-000000000001',
              organization_id: 'org-1',
              definition_id: 'monthly-report',
              sequence: 0,
              step_id: 'reserve',
              task_type: 'report.reserve',
              status: 'succeeded',
              side_effect: 'idempotent',
              input: {},
              attempt: 1,
              max_attempts: 3,
              idempotency_key: 'wf-1:reserve',
              requires_approval: false,
              approval_timeout_seconds: 3600,
              approval_id: null,
              approval_expires_at: null,
              approved_at: null,
              error_summary: null,
              started_at: new Date(),
              completed_at: new Date(),
              compensation: {
                taskType: 'report.release',
                input: { reservationId: 'hold-1' },
              },
            },
          ]);
        }
        if (sql.includes('INSERT INTO durable_workflow_compensations')) {
          captured.push([...values]);
        }
        return result([]);
      }),
      release: vi.fn(),
    };
    const repository = createPostgresDurableWorkflowRepository({
      pool: {
        connect: vi.fn().mockResolvedValue(client),
        query: vi.fn(),
        end: vi.fn(),
      },
    });

    await repository.requestCompensation({
      organizationId: 'org-1',
      runId: 'wf-00000000-0000-4000-8000-000000000001',
      actor: {
        organizationId: 'org-1',
        accountId: 'account-1',
        display: 'Admin',
      },
      note: 'rollback failed publication',
    });

    expect(captured.map((values) => [values[2], values[3], values[4]])).toEqual(
      [
        ['publish', 0, 'report.unpublish'],
        ['reserve', 1, 'report.release'],
      ],
    );
  });

  it('fences queued and running compensation when an administrator cancels', async () => {
    const statements: string[] = [];
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (
          sql.includes('FROM durable_workflow_runs') &&
          sql.includes('FOR UPDATE')
        ) {
          return result([
            {
              id: 'wf-00000000-0000-4000-8000-000000000001',
              organization_id: 'org-1',
              definition_id: 'monthly-report',
              status: 'compensating',
              priority: 50,
              created_by_account_id: 'account-1',
              failure_code: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ]);
        }
        return result([]);
      }),
      release: vi.fn(),
    };
    const repository = createPostgresDurableWorkflowRepository({
      pool: {
        connect: vi.fn().mockResolvedValue(client),
        query: vi.fn(),
        end: vi.fn(),
      },
    });

    await repository.cancel({
      organizationId: 'org-1',
      runId: 'wf-00000000-0000-4000-8000-000000000001',
      actor: {
        organizationId: 'org-1',
        accountId: 'account-1',
        display: 'Admin',
      },
      note: 'operator stopped rollback',
    });

    expect(
      statements.some(
        (sql) =>
          sql.includes('UPDATE durable_workflow_compensations') &&
          sql.includes("status = 'cancelled'") &&
          sql.includes('lease_token = NULL'),
      ),
    ).toBe(true);
  });
});
