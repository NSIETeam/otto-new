/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SessionStore } from './sessions.js';
import {
  ToolCallStatus,
  type AgentArtifactReference,
  type AgentCitationReference,
  type AgentTaskGraphSnapshot,
  type AgentRetryRecord,
  type AgentTurnEventMsg,
  type AgentAdaptationRecord,
  type AgentTurnItem,
  type AgentTurnItemStatus,
  type AgentTurnOutcome,
  type AgentTurnPlanStep,
  type AgentTurnSnapshot,
  type AgentTurnStatus,
  type ToolCall,
  type TurnControlPolicy,
  type TurnRunLineage,
  type TurnSuccessCriterion,
  type TurnVerification,
  type TurnVerificationCheck,
} from './protocol.js';
import {
  deriveTurnControlPolicy,
  isParallelSafeToolName,
} from './turnControlPolicy.js';
import { TaskGraphCoordinator } from './taskGraph.js';

type TurnEventName = AgentTurnEventMsg['payload']['event'];

function itemStatusOfTool(status: ToolCallStatus): AgentTurnItemStatus {
  switch (status) {
    case ToolCallStatus.WaitingForConfirmation:
      return 'awaiting_confirmation';
    case ToolCallStatus.Success:
    case ToolCallStatus.BackgroundRunning:
      return 'completed';
    case ToolCallStatus.Error:
      return 'failed';
    case ToolCallStatus.Canceled:
      return 'cancelled';
    default:
      return 'in_progress';
  }
}

function planStatus(value: unknown): AgentTurnPlanStep['status'] {
  switch (String(value ?? '').toLowerCase()) {
    case 'completed':
    case 'done':
      return 'completed';
    case 'in_progress':
    case 'inprogress':
    case 'active':
      return 'in_progress';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function planFromToolCalls(
  toolCalls: readonly ToolCall[],
): AgentTurnItem | null {
  const planTool = [...toolCalls]
    .reverse()
    .find((tool) =>
      ['todo_write', 'update_plan'].includes(
        tool.toolName.trim().toLowerCase(),
      ),
    );
  if (!planTool) return null;

  const rawSteps = Array.isArray(planTool.parameters.todos)
    ? planTool.parameters.todos
    : Array.isArray(planTool.parameters.plan)
      ? planTool.parameters.plan
      : [];
  const steps = rawSteps.flatMap((raw, index): AgentTurnPlanStep[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const entry = raw as Record<string, unknown>;
    const label = String(
      entry.content ?? entry.step ?? entry.label ?? entry.activeForm ?? '',
    ).trim();
    if (!label) return [];
    const rawDependencies = entry.dependsOn ?? entry.depends_on;
    return [
      {
        id: String(entry.id ?? `plan-step-${index + 1}`),
        label,
        status: planStatus(entry.status),
        ...(Array.isArray(rawDependencies)
          ? {
              dependsOn: rawDependencies
                .map((value) => String(value).trim())
                .filter(Boolean),
            }
          : {}),
        ...(Number.isSafeInteger(entry.attempt) && Number(entry.attempt) > 0
          ? { attempt: Number(entry.attempt) }
          : {}),
      },
    ];
  });
  if (steps.length === 0) return null;

  return {
    id: 'turn-plan',
    type: 'plan',
    status: itemStatusOfTool(planTool.status),
    label: '任务计划',
    steps,
  };
}

function toolGroupStatus(toolCalls: readonly ToolCall[]): AgentTurnItemStatus {
  const statuses = toolCalls.map((tool) => itemStatusOfTool(tool.status));
  if (statuses.includes('awaiting_confirmation'))
    return 'awaiting_confirmation';
  if (statuses.includes('in_progress') || statuses.includes('pending')) {
    return 'in_progress';
  }
  if (
    statuses.length > 0 &&
    statuses.every((status) => status === 'cancelled')
  ) {
    return 'cancelled';
  }
  if (statuses.includes('failed')) return 'failed';
  return 'completed';
}

function cloneItem(item: AgentTurnItem): AgentTurnItem {
  if (item.type === 'plan') {
    return {
      ...item,
      steps: item.steps.map((step) => ({
        ...step,
        ...(step.dependsOn ? { dependsOn: [...step.dependsOn] } : {}),
      })),
    };
  }
  if (item.type === 'verification') {
    return {
      ...item,
      verification: cloneVerification(item.verification),
    };
  }
  return { ...item };
}

function cloneControl(policy: TurnControlPolicy): TurnControlPolicy {
  return {
    ...policy,
    complexity: {
      ...policy.complexity,
      reasons: [...policy.complexity.reasons],
      budget: { ...policy.complexity.budget },
    },
    presentation: {
      ...policy.presentation,
      finalSections: [...policy.presentation.finalSections],
    },
    successCriteria: policy.successCriteria.map((criterion) => ({
      ...criterion,
    })),
  };
}

function cloneVerification(verification: TurnVerification): TurnVerification {
  return {
    ...verification,
    checks: verification.checks.map((check) => ({
      ...check,
      ...(check.evidence ? { evidence: [...check.evidence] } : {}),
    })),
  };
}

function intentLabel(policy: TurnControlPolicy): string {
  switch (policy.intent) {
    case 'research':
      return '检索并核实信息';
    case 'diagnose':
      return '定位并验证问题';
    case 'change':
      return '规划并完成变更';
    case 'create_artifact':
      return '创建并校验产物';
    case 'enterprise_action':
      return '执行企业业务操作';
    default:
      return '直接回答问题';
  }
}

function serializedParameters(tool: ToolCall): string {
  try {
    return JSON.stringify(tool.parameters).toLowerCase();
  } catch {
    return '';
  }
}

function isSuccessfulTool(tool: ToolCall): boolean {
  return tool.status === ToolCallStatus.Success;
}

function isFailedTool(tool: ToolCall): boolean {
  return tool.status === ToolCallStatus.Error;
}

function isMutationTool(tool: ToolCall): boolean {
  const name = tool.toolName.trim().toLowerCase();
  if (
    ['todo_write', 'update_plan', 'ask_user_question'].includes(name) ||
    isParallelSafeToolName(name)
  ) {
    return false;
  }
  return true;
}

function isExplicitVerificationTool(tool: ToolCall): boolean {
  const name = tool.toolName.trim().toLowerCase();
  const input = `${name} ${serializedParameters(tool)}`;
  return /(?:test|typecheck|lint|doctor|build|verify|validat|check|audit)/iu.test(
    input,
  );
}

function isSourceTool(tool: ToolCall): boolean {
  const name = tool.toolName.trim().toLowerCase();
  return /(?:web|search|browse|fetch|knowledge|http)/iu.test(name);
}

const ARTIFACT_EXTENSION =
  /\.(?:csv|docx?|gif|html?|jpe?g|json|md|pdf|png|pptx?|svg|tar|txt|webp|xlsx?|xml|yaml|yml|zip)$/iu;

function referenceId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function stringValues(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => stringValues(entry, depth + 1));
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value as Record<string, unknown>).flatMap((entry) =>
    stringValues(entry, depth + 1),
  );
}

function safeCitationUri(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(?:token|key|secret|signature|auth|password)/iu.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function citationUris(tool: ToolCall): string[] {
  const candidates = stringValues([tool.parameters, tool.result?.data]);
  const uris = candidates.flatMap(
    (value) => value.match(/https?:\/\/[^\s<>"'`)\]}]+/giu) ?? [],
  );
  return [...new Set(uris.map(safeCitationUri).filter(Boolean))] as string[];
}

function artifactPaths(tool: ToolCall): string[] {
  const values = stringValues([tool.parameters, tool.result?.data]);
  const candidates = values.flatMap((value) => {
    const direct = value.trim().replace(/^['"]|['"]$/gu, '');
    const embedded =
      value.match(
        /(?:[A-Za-z]:[\\/]|~[\\/]|\.{0,2}[\\/])[^\r\n<>"|?*]+?\.(?:csv|docx?|gif|html?|jpe?g|json|md|pdf|png|pptx?|svg|tar|txt|webp|xlsx?|xml|yaml|yml|zip)/giu,
      ) ?? [];
    const looksLikeStandalonePath =
      ARTIFACT_EXTENSION.test(direct) &&
      (/^(?:[A-Za-z]:[\\/]|~[\\/]|\.{0,2}[\\/])/u.test(direct) ||
        !/\s/u.test(direct));
    return looksLikeStandalonePath ? [direct, ...embedded] : embedded;
  });
  return [
    ...new Set(
      candidates
        .map((candidate) => candidate.trim().replace(/[),.;:]+$/gu, ''))
        .filter((candidate) => !/^https?:\/\//iu.test(candidate)),
    ),
  ];
}

function isArtifactProducingTool(tool: ToolCall): boolean {
  return /(?:artifact|create|document|export|generate|image|patch|pdf|ppt|render|save|sheet|write)/iu.test(
    tool.toolName,
  );
}

function mimeTypeForPath(filePath: string): string | undefined {
  const extension = filePath.split('.').at(-1)?.toLowerCase();
  return {
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    json: 'application/json',
    md: 'text/markdown',
    pdf: 'application/pdf',
    png: 'image/png',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  }[extension ?? ''];
}

/**
 * Owns one turn's semantic lifecycle while legacy chat/tool frames remain
 * intact. Mutations are persisted to the root assistant message before the
 * versioned snapshot event is broadcast.
 */
export class AgentTurnTracker {
  readonly turnId: string;
  private readonly startedAt = Date.now();
  private readonly control: TurnControlPolicy;
  private readonly taskGraph: TaskGraphCoordinator;
  private verification: TurnVerification;
  private readonly lineage: TurnRunLineage;
  private retries: AgentRetryRecord[] = [];
  private adaptations: AgentAdaptationRecord[] = [];
  private artifacts: AgentArtifactReference[] = [];
  private citations: AgentCitationReference[] = [];
  private outcome: AgentTurnOutcome | undefined;
  private rootMessageId: string | null = null;
  private status: AgentTurnStatus = 'in_progress';
  private items: AgentTurnItem[] = [];
  private sequence = 0;
  private modelRound = 0;
  private currentStageId: string | null = null;
  private currentToolGroupId: string | null = null;
  private completedAt: number | undefined;
  private sawAssistantContent = false;
  private sawConfirmation = false;
  private reconciliationReason: string | undefined;
  private readonly observedTools = new Map<string, ToolCall>();

  constructor(
    private readonly store: SessionStore,
    private readonly sessionId: string,
    control?: TurnControlPolicy,
    options: {
      turnId?: string;
      attempt?: number;
      resumedFromSequence?: number;
      taskGraphSnapshot?: AgentTaskGraphSnapshot;
    } = {},
  ) {
    this.turnId = options.turnId ?? randomUUID();
    this.lineage = {
      runId: this.turnId,
      attempt: Math.max(1, options.attempt ?? 1),
      ...(options.resumedFromSequence !== undefined
        ? { resumedFromSequence: options.resumedFromSequence }
        : {}),
    };
    this.control = cloneControl(
      control ??
        deriveTurnControlPolicy({
          text: '',
          source: 'local',
          toolFree: false,
        }),
    );
    this.taskGraph = options.taskGraphSnapshot
      ? TaskGraphCoordinator.restore(this.control, options.taskGraphSnapshot)
      : new TaskGraphCoordinator(this.control);
    this.verification = {
      status: this.control.requiresVerification ? 'pending' : 'not_required',
      checks: this.control.successCriteria.map((criterion) => ({
        id: criterion.id,
        label: criterion.label,
        status: 'pending',
      })),
    };
    this.items = [
      {
        id: 'turn-control',
        type: 'control',
        status: 'completed',
        label: intentLabel(this.control),
        intent: this.control.intent,
        executionMode: this.control.executionMode,
        riskLevel: this.control.riskLevel,
        evidenceRequirement: this.control.evidenceRequirement,
      },
    ];
  }

  attachAssistantMessage(messageId: string): void {
    this.modelRound += 1;
    this.currentToolGroupId = null;
    if (this.rootMessageId === null) {
      this.rootMessageId = messageId;
      this.emit('turn_started');
    }
    this.currentStageId = `model-round-${this.modelRound}`;
    this.upsertItem(
      {
        id: this.currentStageId,
        type: 'stage',
        status: 'in_progress',
        label:
          this.modelRound === 1 ? '理解任务并组织回答' : '结合执行结果继续回答',
      },
      'item_started',
    );
  }

  markStreaming(): void {
    if (!this.currentStageId) return;
    this.sawAssistantContent = true;
    const current = this.items.find((item) => item.id === this.currentStageId);
    if (!current || current.type !== 'stage' || current.detail) return;
    this.upsertItem({ ...current, detail: '正在生成可读结果' }, 'item_updated');
  }

  completeAssistantMessage(hasContent = true): void {
    this.sawAssistantContent ||= hasContent;
    this.finishCurrentStage('completed');
  }

  updateToolCalls(toolCalls: readonly ToolCall[]): void {
    if (toolCalls.length === 0) return;
    this.taskGraph.observeTools(
      toolCalls.map((tool) => ({
        name: tool.toolName,
        status:
          tool.status === ToolCallStatus.Success
            ? 'success'
            : tool.status === ToolCallStatus.Error
              ? 'error'
              : tool.status === ToolCallStatus.Canceled
                ? 'cancelled'
                : 'running',
        mutating: isMutationTool(tool),
        verification: isExplicitVerificationTool(tool),
        evidenceId: tool.id,
      })),
    );
    for (const tool of toolCalls) {
      this.observedTools.set(tool.id, {
        ...tool,
        parameters: { ...tool.parameters },
      });
      if (tool.status === ToolCallStatus.WaitingForConfirmation) {
        this.sawConfirmation = true;
      }
      this.collectAutomaticReferences(tool);
    }
    const groupId = this.currentToolGroupId ?? `tool-group-${this.modelRound}`;
    const existed = this.items.some((item) => item.id === groupId);
    this.currentToolGroupId = groupId;

    const statuses = toolCalls.map((tool) => itemStatusOfTool(tool.status));
    const completed = statuses.filter(
      (status) => status === 'completed',
    ).length;
    const failed = statuses.filter((status) => status === 'failed').length;
    const awaitingConfirmation = statuses.filter(
      (status) => status === 'awaiting_confirmation',
    ).length;
    const status = toolGroupStatus(toolCalls);
    this.upsertItem(
      {
        id: groupId,
        type: 'tool_group',
        status,
        label:
          awaitingConfirmation > 0
            ? '等待确认后继续'
            : status === 'in_progress'
              ? '执行必要步骤'
              : failed > 0
                ? '部分步骤需要处理'
                : '执行步骤已完成',
        total: toolCalls.length,
        completed,
        failed,
        awaitingConfirmation,
      },
      !existed
        ? 'item_started'
        : ['completed', 'cancelled', 'failed'].includes(status)
          ? 'item_completed'
          : 'item_updated',
    );

    const plan = planFromToolCalls(toolCalls);
    if (plan) {
      this.upsertItem(
        plan,
        this.items.some((item) => item.id === plan.id)
          ? plan.status === 'completed'
            ? 'item_completed'
            : 'item_updated'
          : 'item_started',
      );
    }
  }

  complete(): void {
    if (this.reconciliationReason) {
      this.interruptUnknown(this.reconciliationReason);
      return;
    }
    this.finishCurrentStage('completed');
    const satisfied = this.finalizeVerification();
    if (satisfied) {
      if (this.control.requiresVerification) {
        this.taskGraph.markVerificationPassed();
      }
      this.taskGraph.markDelivered();
      this.finishTurn('completed', { type: 'success' });
      return;
    }
    this.finishTurn('incomplete', {
      type: 'incomplete',
      reason: '成功条件或验证要求尚未全部满足',
    });
  }

  cancel(): void {
    if (this.reconciliationReason) {
      this.interruptUnknown(this.reconciliationReason);
      return;
    }
    this.finishCurrentStage('cancelled');
    this.finalizeVerification();
    this.finishTurn('cancelled', {
      type: 'cancelled',
      reason: '用户停止了本轮任务',
    });
  }

  fail(detail: string): void {
    if (this.reconciliationReason) {
      this.interruptUnknown(this.reconciliationReason);
      return;
    }
    this.finishCurrentStage('failed');
    this.finalizeVerification();
    this.upsertItem(
      {
        id: 'turn-failure',
        type: 'notice',
        status: 'failed',
        label: '本轮未能完成',
        detail,
        level: 'error',
      },
      'item_completed',
    );
    this.finishTurn('failed', { type: 'failed', reason: detail });
  }

  interruptUnknown(detail: string): void {
    if (this.status !== 'in_progress') return;
    this.finishCurrentStage('failed');
    this.recordRetry(detail, 'unknown_outcome');
    this.finalizeVerification();
    this.upsertItem(
      {
        id: 'turn-interrupt',
        type: 'notice',
        status: 'failed',
        label: '执行结果需要核对',
        detail,
        level: 'warning',
      },
      'item_completed',
    );
    this.finishTurn('interrupted', {
      type: 'unknown_outcome',
      reason: detail,
      requiresReconciliation: true,
    });
  }

  markReconciliationRequired(detail: string): void {
    if (this.status !== 'in_progress') return;
    this.reconciliationReason = detail.slice(0, 1_000);
    this.upsertItem(
      {
        id: 'turn-reconciliation-required',
        type: 'notice',
        status: 'awaiting_confirmation',
        label: '需要核对上次执行结果',
        detail: this.reconciliationReason,
        level: 'warning',
      },
      this.items.some((item) => item.id === 'turn-reconciliation-required')
        ? 'item_updated'
        : 'item_started',
    );
  }

  recordRetry(
    reason: string,
    outcome: AgentRetryRecord['outcome'] = 'retrying',
  ): void {
    this.retries = [
      ...this.retries,
      {
        attempt: this.retries.length + 1,
        reason: reason.slice(0, 1_000),
        timestamp: Date.now(),
        outcome,
      },
    ];
  }

  recordAdaptation(
    adaptation: Omit<AgentAdaptationRecord, 'revision' | 'timestamp'>,
  ): void {
    const record: AgentAdaptationRecord = {
      ...adaptation,
      revision: this.adaptations.length + 1,
      timestamp: Date.now(),
    };
    this.adaptations = [...this.adaptations, record];
    this.taskGraph.applyAdaptation(record);
    if (this.rootMessageId) this.emit('item_updated');
  }

  /** Internal model directive; callers must not render it as UI status. */
  taskGraphDirective(): string {
    return this.control.complexity.requiresTaskGraph
      ? this.taskGraph.directive()
      : '';
  }

  taskGraphSnapshot(): AgentTaskGraphSnapshot {
    return this.taskGraph.snapshot();
  }

  recordArtifact(reference: AgentArtifactReference): void {
    this.artifacts = [
      ...this.artifacts.filter((artifact) => artifact.id !== reference.id),
      { ...reference },
    ];
  }

  recordCitation(reference: AgentCitationReference): void {
    this.citations = [
      ...this.citations.filter((citation) => citation.id !== reference.id),
      { ...reference },
    ];
  }

  private collectAutomaticReferences(tool: ToolCall): void {
    if (!isSuccessfulTool(tool)) return;

    if (isSourceTool(tool)) {
      const uris = citationUris(tool);
      if (uris.length === 0) {
        this.recordCitation({
          id: referenceId('citation', `${tool.id}:${tool.toolName}`),
          label: `来源工具：${tool.displayName || tool.toolName}`,
          sourceType: /(?:enterprise|knowledge|organization)/iu.test(
            tool.toolName,
          )
            ? 'enterprise'
            : 'tool',
          verified: true,
        });
      }
      for (const uri of uris) {
        let label = uri;
        try {
          const parsed = new URL(uri);
          label = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
        } catch {
          // safeCitationUri already validated it; keep URI as a defensive fallback.
        }
        this.recordCitation({
          id: referenceId('citation', uri),
          label,
          uri,
          sourceType: 'web',
          verified: true,
        });
      }
    }

    const paths = artifactPaths(tool);
    if (isArtifactProducingTool(tool)) {
      for (const artifactPath of paths) {
        this.recordArtifact({
          id: referenceId('artifact', artifactPath),
          label: artifactPath.split(/[\\/]/u).at(-1) || artifactPath,
          path: artifactPath,
          mimeType: mimeTypeForPath(artifactPath),
          verified: false,
        });
      }
    }

    if (isExplicitVerificationTool(tool) && this.artifacts.length > 0) {
      const normalizedPaths = new Set(
        paths.map((artifactPath) => artifactPath.replace(/\\/gu, '/')),
      );
      this.artifacts = this.artifacts.map((artifact) => {
        const normalized = artifact.path?.replace(/\\/gu, '/');
        const appliesToArtifact =
          normalizedPaths.size === 0 ||
          (normalized ? normalizedPaths.has(normalized) : false);
        return appliesToArtifact ? { ...artifact, verified: true } : artifact;
      });
    }
  }

  snapshot(): AgentTurnSnapshot {
    const updatedAt = Date.now();
    return {
      contractVersion: 1,
      turnId: this.turnId,
      sequence: this.sequence,
      status: this.status,
      items: this.items.map(cloneItem),
      startedAt: this.startedAt,
      updatedAt,
      control: cloneControl(this.control),
      verification: cloneVerification(this.verification),
      lineage: { ...this.lineage },
      retries: this.retries.map((retry) => ({ ...retry })),
      adaptations: this.adaptations.map((adaptation) => ({ ...adaptation })),
      artifacts: this.artifacts.map((artifact) => ({ ...artifact })),
      citations: this.citations.map((citation) => ({ ...citation })),
      taskGraph: this.taskGraph.snapshot(),
      ...(this.outcome ? { outcome: { ...this.outcome } } : {}),
      ...(this.completedAt ? { completedAt: this.completedAt } : {}),
    };
  }

  private finalizeVerification(): boolean {
    const checks = this.control.successCriteria.map((criterion) =>
      this.evaluateCriterion(criterion),
    );
    const passed = checks.filter((check) => check.status === 'passed').length;
    const failed = checks.filter((check) => check.status === 'failed').length;
    const allSatisfied = checks.length === 0 || passed === checks.length;
    const status: TurnVerification['status'] = allSatisfied
      ? this.control.requiresVerification
        ? 'passed'
        : 'not_required'
      : passed > 0
        ? 'partial'
        : failed > 0
          ? 'failed'
          : 'not_run';
    this.verification = { status, checks };

    if (this.control.requiresVerification || !allSatisfied) {
      this.upsertItem(
        {
          id: 'turn-verification',
          type: 'verification',
          status:
            status === 'passed' || status === 'not_required'
              ? 'completed'
              : 'failed',
          label:
            status === 'passed'
              ? '验证已通过'
              : status === 'partial'
                ? '部分验证已完成'
                : status === 'failed'
                  ? '验证未通过'
                  : '尚未执行必要验证',
          verification: cloneVerification(this.verification),
        },
        'item_completed',
      );
    }
    return allSatisfied;
  }

  private evaluateCriterion(
    criterion: TurnSuccessCriterion,
  ): TurnVerificationCheck {
    const tools = [...this.observedTools.values()];
    const successful = tools.filter(isSuccessfulTool);
    const failed = tools.filter(isFailedTool);
    const successfulMutations = successful.filter(isMutationTool);
    const failedMutations = failed.filter(isMutationTool);
    const successfulVerification = successful.filter(
      isExplicitVerificationTool,
    );
    const successfulSources = successful.filter(isSourceTool);

    let satisfied = false;
    let explicitlyFailed = false;
    let evidence: string[] | undefined;
    switch (criterion.kind) {
      case 'answer':
        satisfied = this.sawAssistantContent;
        explicitlyFailed = !satisfied;
        break;
      case 'change':
        satisfied = successfulMutations.length > 0;
        explicitlyFailed = failedMutations.length > 0;
        evidence = satisfied
          ? [`已收到 ${successfulMutations.length} 项成功执行结果`]
          : undefined;
        break;
      case 'artifact':
        satisfied =
          this.artifacts.some((artifact) => artifact.verified) ||
          successfulMutations.some((tool) =>
            /(?:write|create|generate|export|ppt|image|document|file)/iu.test(
              tool.toolName,
            ),
          );
        explicitlyFailed = failedMutations.length > 0;
        evidence = this.artifacts
          .filter((artifact) => artifact.verified)
          .map((artifact) => artifact.label);
        break;
      case 'evidence':
        if (this.control.evidenceRequirement === 'primary_sources') {
          satisfied = successfulSources.length > 0;
          explicitlyFailed =
            tools.some(isSourceTool) && successfulSources.length === 0;
        } else {
          satisfied =
            successfulVerification.length > 0 ||
            (this.control.intent === 'diagnose' && successful.length > 0);
          explicitlyFailed = failed.length > 0 && !satisfied;
        }
        evidence = satisfied ? ['已获得可复核的工具结果'] : undefined;
        break;
      case 'verification':
        if (this.control.evidenceRequirement === 'primary_sources') {
          satisfied = successfulSources.length > 0;
        } else if (
          this.control.evidenceRequirement === 'deterministic_receipt'
        ) {
          satisfied = successfulMutations.some(
            (tool) => tool.result?.success === true,
          );
          if (this.control.confirmationMode === 'always') {
            satisfied &&= this.sawConfirmation;
          }
        } else {
          satisfied = successfulVerification.length > 0;
        }
        explicitlyFailed = failed.length > 0 && !satisfied;
        evidence = satisfied ? ['已完成与任务匹配的验证'] : undefined;
        break;
      case 'receipt':
        satisfied = successfulMutations.some(
          (tool) => tool.result?.success === true,
        );
        if (this.control.confirmationMode === 'always') {
          satisfied &&= this.sawConfirmation;
        }
        explicitlyFailed = failedMutations.length > 0 && !satisfied;
        evidence = satisfied ? ['外部操作具有成功回执'] : undefined;
        break;
      default: {
        const unreachable: never = criterion.kind;
        throw new Error(
          `Unsupported success criterion: ${String(unreachable)}`,
        );
      }
    }

    return {
      id: criterion.id,
      label: criterion.label,
      status: satisfied ? 'passed' : explicitlyFailed ? 'failed' : 'not_run',
      ...(evidence?.length ? { evidence } : {}),
    };
  }

  private finishCurrentStage(status: AgentTurnItemStatus): void {
    if (!this.currentStageId) return;
    const current = this.items.find((item) => item.id === this.currentStageId);
    if (!current || current.status !== 'in_progress') return;
    this.upsertItem({ ...current, status }, 'item_completed');
  }

  private finishTurn(status: AgentTurnStatus, outcome: AgentTurnOutcome): void {
    if (this.status !== 'in_progress') return;
    this.status = status;
    this.outcome = outcome;
    this.completedAt = Date.now();
    this.emit('turn_completed');
  }

  private upsertItem(item: AgentTurnItem, event: TurnEventName): void {
    const index = this.items.findIndex((existing) => existing.id === item.id);
    if (
      index >= 0 &&
      JSON.stringify(this.items[index]) === JSON.stringify(item)
    ) {
      return;
    }
    this.items =
      index >= 0
        ? this.items.map((existing) =>
            existing.id === item.id ? item : existing,
          )
        : [...this.items, item];
    this.emit(event, item.id);
  }

  private emit(event: TurnEventName, itemId?: string): void {
    if (!this.rootMessageId) return;
    const sequence = ++this.sequence;
    const snapshot = this.snapshot();
    this.store.patchMessage(this.sessionId, this.rootMessageId, {
      turn: snapshot,
    });
    this.store.publish(this.sessionId, {
      type: 'turn_event',
      payload: {
        contractVersion: 1,
        sessionId: this.sessionId,
        messageId: this.rootMessageId,
        turnId: this.turnId,
        sequence,
        timestamp: snapshot.updatedAt,
        event,
        ...(itemId ? { itemId } : {}),
        snapshot,
      },
    });
  }
}
