/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type {
  AgentAdaptationRecord,
  AgentTaskGraphNode,
  AgentTaskGraphNodeStatus,
  AgentTaskGraphSnapshot,
  TurnControlPolicy,
  TurnVerificationCheck,
} from './protocol.js';

export interface ObservableTaskTool {
  name: string;
  status: 'success' | 'error' | 'running' | 'cancelled';
  mutating: boolean;
  verification: boolean;
  evidenceId?: string;
}

export interface TaskGraphValidation {
  readyToDeliver: boolean;
  blockedNodeIds: string[];
  incompleteNodeIds: string[];
  invalidDependencyIds: string[];
}

function cloneNode(node: AgentTaskGraphNode): AgentTaskGraphNode {
  return {
    ...node,
    ...(node.dependsOn ? { dependsOn: [...node.dependsOn] } : {}),
    ...(node.evidenceIds ? { evidenceIds: [...node.evidenceIds] } : {}),
  };
}

function strategyFor(
  record: AgentAdaptationRecord,
): NonNullable<AgentTaskGraphNode['strategy']> {
  if (record.action === 'retry_once') return 'retry';
  if (record.action === 'compact_context') return 'compact_context';
  if (record.action === 'reconcile') return 'reconcile_outcome';
  if (record.action === 'request_input') {
    return record.category === 'permission'
      ? 'request_access'
      : 'correct_input';
  }
  switch (record.category) {
    case 'stale_state':
      return 'refresh_state';
    case 'not_found':
      return 'alternate_source';
    case 'unsupported':
      return 'supported_path';
    case 'unknown_side_effect':
      return 'reconcile_outcome';
    default:
      return 'inspect_evidence';
  }
}

function labelFor(kind: AgentTaskGraphNode['kind']): string {
  return {
    understand: '确认目标与完成条件',
    gather: '收集可复核上下文',
    execute: '完成请求范围内的执行',
    verify: '使用可观察结果验证',
    recover: '切换策略并恢复执行',
    deliver: '交付结果与证据',
    objective: '完成用户要求的子任务',
  }[kind];
}

/**
 * Internal, observable task graph. It derives structure from policy rather
 * than model prose, and only advances nodes from tool outcomes or final
 * verification.
 */
export class TaskGraphCoordinator {
  private revision = 1;
  private nodes: AgentTaskGraphNode[];
  private revisions: AgentTaskGraphSnapshot['revisions'];

  constructor(private readonly policy: TurnControlPolicy) {
    const kinds: Array<AgentTaskGraphNode['kind']> = ['understand'];
    if (
      policy.complexity.requiresTaskGraph ||
      policy.intent === 'research' ||
      policy.intent === 'diagnose'
    ) {
      kinds.push('gather');
    }
    if (
      policy.intent === 'change' ||
      policy.intent === 'create_artifact' ||
      policy.intent === 'enterprise_action'
    ) {
      kinds.push('execute');
    }
    if (policy.requiresVerification) kinds.push('verify');
    kinds.push('deliver');

    this.nodes = kinds.map((kind, index) => ({
      id: `graph-${kind}`,
      label: labelFor(kind),
      kind,
      status: kind === 'understand' ? 'completed' : 'pending',
      ...(index > 0 ? { dependsOn: [`graph-${kinds[index - 1]}`] } : {}),
    }));
    this.revisions = [
      {
        revision: 1,
        timestamp: Date.now(),
        reason: `initial:${policy.complexity.route}`,
        preservedNodeIds: [],
        changedNodeIds: this.nodes.map((node) => node.id),
      },
    ];
  }

  static restore(
    policy: TurnControlPolicy,
    snapshot: AgentTaskGraphSnapshot,
  ): TaskGraphCoordinator {
    TaskGraphCoordinator.assertRestorable(policy, snapshot);
    const coordinator = new TaskGraphCoordinator(policy);
    coordinator.revision = snapshot.revision;
    coordinator.nodes = snapshot.nodes.map(cloneNode);
    coordinator.revisions = snapshot.revisions.map((revision) => ({
      ...revision,
      preservedNodeIds: [...revision.preservedNodeIds],
      changedNodeIds: [...revision.changedNodeIds],
    }));
    return coordinator;
  }

  observeTools(tools: readonly ObservableTaskTool[]): void {
    const grouped = new Map<AgentTaskGraphNode['kind'], ObservableTaskTool[]>();
    for (const tool of tools) {
      const kind = tool.verification
        ? 'verify'
        : tool.mutating
          ? 'execute'
          : 'gather';
      grouped.set(kind, [...(grouped.get(kind) ?? []), tool]);
    }
    for (const [kind, observations] of grouped) {
      const statuses = observations.map((observation) => observation.status);
      if (statuses.includes('error')) {
        this.setNodeStatus(kind, 'failed');
      } else if (statuses.includes('cancelled')) {
        this.setNodeStatus(kind, 'cancelled');
      } else if (statuses.includes('running')) {
        this.setNodeStatus(kind, 'in_progress');
      } else if (statuses.every((status) => status === 'success')) {
        const pendingRecovery = [...this.nodes]
          .reverse()
          .find((node) => node.kind === 'recover' && node.status === 'pending');
        if (pendingRecovery) pendingRecovery.status = 'completed';
        for (const observation of observations) {
          this.setNodeStatus(kind, 'completed', observation.evidenceId);
        }
      }
      this.refreshDependencyStatuses();
    }
  }

  applyAdaptation(record: AgentAdaptationRecord): void {
    if (record.action === 'retry_once') {
      const failed = this.nodes.find((node) => node.status === 'failed');
      if (failed) {
        failed.status = 'pending';
        failed.attempt = Math.max(failed.attempt ?? 1, record.attempt + 1);
      }
      this.refreshDependencyStatuses();
      return;
    }

    const preservedNodeIds = this.nodes
      .filter((node) => node.status === 'completed')
      .map((node) => node.id);
    this.revision += 1;
    const recoveryId = `graph-recover-${this.revision}`;
    const recovery: AgentTaskGraphNode = {
      id: recoveryId,
      label: labelFor('recover'),
      kind: 'recover',
      status: 'pending',
      attempt: record.attempt,
      strategy: strategyFor(record),
      ...(preservedNodeIds.length > 0
        ? { dependsOn: [preservedNodeIds[preservedNodeIds.length - 1]] }
        : {}),
    };
    this.nodes.push(recovery);

    const next = this.nodes.find(
      (node) =>
        node.id !== recoveryId &&
        node.status !== 'completed' &&
        node.kind !== 'recover',
    );
    if (next) next.dependsOn = [recoveryId];
    if (next && ['failed', 'cancelled', 'blocked'].includes(next.status)) {
      next.status = 'pending';
    }
    this.refreshDependencyStatuses();

    this.revisions.push({
      revision: this.revision,
      timestamp: record.timestamp,
      reason: `adapt:${record.category}:${record.action}`,
      preservedNodeIds,
      changedNodeIds: [recoveryId, ...(next ? [next.id] : [])],
    });
  }

  markDelivered(): boolean {
    const validation = this.validate();
    if (!validation.readyToDeliver) {
      this.refreshDependencyStatuses();
      return false;
    }
    this.setNodeStatus('deliver', 'completed');
    return true;
  }

  syncObjectives(
    contract: import('./taskContract.js').TaskContractSnapshot,
    checks: TurnVerificationCheck[],
  ): void {
    const before = new Map(
      this.nodes.map((node) => [node.id, JSON.stringify(node)]),
    );
    this.nodes = this.nodes.filter((node) => node.kind !== 'objective');
    const completed = new Set<string>();
    const pending = [...contract.objectives];
    while (pending.length) {
      const index = pending.findIndex((objective) =>
        objective.dependsOn.every(
          (dependency) =>
            !pending.some((candidate) => candidate.id === dependency),
        ),
      );
      if (index < 0) throw new Error('Invalid task dependencies');
      const [objective] = pending.splice(index, 1);
      const evidence = checks.filter((check) =>
        check.id.startsWith(`objective:${objective.id}:`),
      );
      const dependenciesReady = objective.dependsOn.every((dependency) =>
        completed.has(dependency),
      );
      const passed =
        dependenciesReady &&
        evidence.length > 0 &&
        evidence.every((check) => check.status === 'passed');
      if (passed) completed.add(objective.id);
      this.nodes.push({
        id: `objective-${objective.id}`,
        kind: 'objective',
        label: objective.description,
        status: passed
          ? 'completed'
          : dependenciesReady
            ? 'pending'
            : 'blocked',
        dependsOn: objective.dependsOn.length
          ? objective.dependsOn.map((dependency) => `objective-${dependency}`)
          : ['graph-understand'],
        evidenceIds: [
          ...new Set(evidence.flatMap((check) => check.evidence ?? [])),
        ].slice(0, 16),
      });
    }
    const deliver = this.nodes.find((node) => node.kind === 'deliver');
    if (deliver)
      deliver.dependsOn = [
        ...(deliver.dependsOn ?? []).filter(
          (id) => !id.startsWith('objective-'),
        ),
        ...contract.objectives.map((o) => `objective-${o.id}`),
      ];
    const changed = this.nodes.filter(
      (node) => before.get(node.id) !== JSON.stringify(node),
    );
    if (changed.length) {
      this.revision++;
      this.revisions.push({
        revision: this.revision,
        timestamp: Date.now(),
        reason: `task-contract:${contract.revision}`,
        preservedNodeIds: this.nodes
          .filter(
            (node) => node.status === 'completed' && !changed.includes(node),
          )
          .map((node) => node.id),
        changedNodeIds: changed.map((node) => node.id),
      });
    }
  }

  markVerificationPassed(): void {
    this.setNodeStatus('verify', 'completed');
    this.refreshDependencyStatuses();
  }

  validate(): TaskGraphValidation {
    const nodeIds = new Set(this.nodes.map((node) => node.id));
    const invalidDependencyIds = [
      ...new Set(
        this.nodes.flatMap((node) =>
          (node.dependsOn ?? []).filter(
            (dependency) => !nodeIds.has(dependency),
          ),
        ),
      ),
    ];
    const blockedNodeIds = this.nodes
      .filter((node) => node.status === 'blocked')
      .map((node) => node.id);
    const incompleteNodeIds = this.nodes
      .filter((node) => node.kind !== 'deliver' && node.status !== 'completed')
      .map((node) => node.id);
    return {
      readyToDeliver:
        invalidDependencyIds.length === 0 && incompleteNodeIds.length === 0,
      blockedNodeIds,
      incompleteNodeIds,
      invalidDependencyIds,
    };
  }

  snapshot(): AgentTaskGraphSnapshot {
    return {
      contractVersion: 1,
      revision: this.revision,
      route: this.policy.complexity.route,
      nodes: this.nodes.map(cloneNode),
      revisions: this.revisions.map((revision) => ({
        ...revision,
        preservedNodeIds: [...revision.preservedNodeIds],
        changedNodeIds: [...revision.changedNodeIds],
      })),
    };
  }

  /** Bounded model directive. Labels and raw user content are excluded. */
  directive(): string {
    const graph = this.snapshot();
    const nodes = graph.nodes.map((node) => {
      const dependencies = node.dependsOn?.join(',') ?? '-';
      const strategy = node.strategy ? ` strategy=${node.strategy}` : '';
      const evidenceCount = node.evidenceIds?.length ?? 0;
      return `${node.id} kind=${node.kind} status=${node.status} depends_on=${dependencies} evidence_count=${evidenceCount}${strategy}`;
    });
    return [
      `<otto_task_graph contract_version="1" revision="${graph.revision}" route="${graph.route}">`,
      ...nodes,
      'Advance nodes only from tool results and verification. Preserve completed nodes when replanning. Do not expose this graph as user-facing status chrome.',
      '</otto_task_graph>',
    ]
      .join('\n')
      .slice(0, 2_399);
  }

  private setNodeStatus(
    kind: AgentTaskGraphNode['kind'],
    status: AgentTaskGraphNodeStatus,
    evidenceId?: string,
  ): void {
    const node = this.nodes.find((candidate) => candidate.kind === kind);
    if (!node) return;
    if (evidenceId && status === 'completed') {
      const safeEvidenceId = evidenceId
        .replace(/[^a-zA-Z0-9_.:-]/gu, '')
        .slice(0, 120);
      if (safeEvidenceId) {
        node.evidenceIds = [
          ...new Set([...(node.evidenceIds ?? []), safeEvidenceId]),
        ].slice(-16);
      }
    }
    if (node.status !== 'completed') node.status = status;
  }

  private refreshDependencyStatuses(): void {
    for (let iteration = 0; iteration < this.nodes.length; iteration += 1) {
      let changed = false;
      const byId = new Map(this.nodes.map((node) => [node.id, node] as const));
      for (const node of this.nodes) {
        if (['completed', 'failed', 'cancelled'].includes(node.status))
          continue;
        const dependencies = (node.dependsOn ?? [])
          .map((id) => byId.get(id))
          .filter(Boolean) as AgentTaskGraphNode[];
        const shouldBlock = dependencies.some((dependency) =>
          ['failed', 'cancelled', 'blocked'].includes(dependency.status),
        );
        const nextStatus = shouldBlock
          ? 'blocked'
          : node.status === 'blocked'
            ? 'pending'
            : node.status;
        if (nextStatus !== node.status) {
          node.status = nextStatus;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  private static assertRestorable(
    policy: TurnControlPolicy,
    snapshot: AgentTaskGraphSnapshot,
  ): void {
    if (snapshot.contractVersion !== 1) {
      throw new Error('Unsupported task graph contract version');
    }
    if (snapshot.route !== policy.complexity.route) {
      throw new Error('Task graph route does not match current policy');
    }
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
      throw new Error('Task graph revision is invalid');
    }
    if (
      snapshot.revisions.length === 0 ||
      snapshot.revisions.at(-1)?.revision !== snapshot.revision
    ) {
      throw new Error('Task graph revision history is inconsistent');
    }
    if (snapshot.nodes.length === 0 || snapshot.nodes.length > 64) {
      throw new Error('Task graph node count is outside the safe range');
    }
    const ids = snapshot.nodes.map((node) => node.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error('Task graph contains duplicate node ids');
    }
    const idSet = new Set(ids);
    const allowedKinds = new Set<AgentTaskGraphNode['kind']>([
      'understand',
      'gather',
      'execute',
      'verify',
      'recover',
      'deliver',
      'objective',
    ]);
    const allowedStatuses = new Set<AgentTaskGraphNodeStatus>([
      'pending',
      'in_progress',
      'completed',
      'failed',
      'blocked',
      'cancelled',
    ]);
    for (const node of snapshot.nodes) {
      if (!allowedKinds.has(node.kind) || !allowedStatuses.has(node.status)) {
        throw new Error('Task graph contains an invalid node');
      }
      if (
        (node.evidenceIds?.length ?? 0) > 16 ||
        node.evidenceIds?.some(
          (evidenceId) =>
            evidenceId.length > 120 || !/^[a-zA-Z0-9_.:-]+$/u.test(evidenceId),
        )
      ) {
        throw new Error('Task graph contains invalid evidence ids');
      }
      for (const dependency of node.dependsOn ?? []) {
        if (!idSet.has(dependency)) {
          throw new Error(
            `Task graph contains unknown dependency: ${dependency}`,
          );
        }
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(
      snapshot.nodes.map((node) => [node.id, node] as const),
    );
    const visit = (id: string): void => {
      if (visiting.has(id))
        throw new Error('Task graph contains a dependency cycle');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of ids) visit(id);

    const baseKinds = new TaskGraphCoordinator(policy)
      .snapshot()
      .nodes.map((node) => node.kind);
    for (const kind of baseKinds) {
      if (snapshot.nodes.filter((node) => node.kind === kind).length !== 1) {
        throw new Error(`Task graph must contain exactly one ${kind} node`);
      }
    }
    const deliver = snapshot.nodes.find((node) => node.kind === 'deliver');
    if (
      deliver?.status === 'completed' &&
      snapshot.nodes.some(
        (node) => node.kind !== 'deliver' && node.status !== 'completed',
      )
    ) {
      throw new Error('Task graph cannot restore a premature delivery');
    }
  }
}
