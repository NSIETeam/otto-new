/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
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
import { TaskContractLedger, TASK_PLAN_TOOL_NAME } from './taskContract.js';
import { refineComplexityFromObjectives } from './complexityRouter.js';
import { classifyExecutionFailure } from './adaptiveExecution.js';
import { REPAIR_PLAN_TOOL_NAME, REPAIR_FORMAT_TOOL_NAME } from './repairStrategyTools.js';
import { ClaimEvidenceLedger } from './claimEvidence.js';
import { CLAIM_REVIEW_TOOL_NAME } from './claimEvidenceTools.js';
import { toolExecutionFingerprint } from './turnRecoveryStore.js';
import { inspectArtifactFile, inspectPdfFile, observeFileBefore, readVersionedFile, sameFileVersion } from './artifactEvidence.js';
import type { DeliveryReadiness } from './deliveryClosure.js';
import {
  VerificationEvidenceLedger,
  verificationKind,
  hasSuccessfulProcessReceipt,
  hasFailedVerificationReceipt,
} from './verificationEvidence.js';

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
  return structuredClone(verification);
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

function isSuccessfulTool(tool: ToolCall): boolean {
  return (
    tool.status === ToolCallStatus.Success &&
    tool.result?.success === true &&
    !tool.result?.error &&
    (!tool.result?.process || hasSuccessfulProcessReceipt(tool))
  );
}

function isFailedTool(tool: ToolCall): boolean {
  return tool.status === ToolCallStatus.Error || tool.result?.success === false || !!tool.result?.error;
}

function isMutationTool(tool: ToolCall): boolean {
  if (tool.toolName === 'web_fetch' && tool.result?.sourceEvidence?.length) return false;
  if (verificationKind(tool)) return false;
  const name = tool.toolName.trim().toLowerCase();
  if (
    [
      'todo_write',
      'update_plan',
      'ask_user_question',
      TASK_PLAN_TOOL_NAME,
      CLAIM_REVIEW_TOOL_NAME,
      REPAIR_PLAN_TOOL_NAME,
      REPAIR_FORMAT_TOOL_NAME,
    ].includes(name) ||
    isParallelSafeToolName(name)
  ) {
    return false;
  }
  return true;
}

function isExplicitVerificationTool(tool: ToolCall): boolean {
  return verificationKind(tool) !== undefined;
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

function isDirectSourceRetrievalTool(tool: ToolCall): boolean {
  return /(?:fetch|open|browse|read[_-]?(?:url|uri|page|web)|get[_-]?(?:url|uri|page)|http[_-]?get)/iu.test(
    tool.toolName,
  );
}

function citationUris(tool: ToolCall): string[] {
  // Search queries may themselves contain a URL. That is not evidence the URL
  // was returned or retrieved, so parameters count only for direct fetch/open.
  const candidates = stringValues([
    tool.result?.data,
    ...(isDirectSourceRetrievalTool(tool) ? [tool.parameters] : []),
  ]);
  const uris = candidates.flatMap(
    (value) => value.match(/https?:\/\/[^\s<>"'`)\]}]+/giu) ?? [],
  );
  return [...new Set(uris.map(safeCitationUri).filter(Boolean))] as string[];
}

function outputStringValues(
  value: unknown,
  options: { allowGenericPath: boolean; selected?: boolean },
  depth = 0,
): string[] {
  if (depth > 4) return [];
  if (typeof value === 'string') return options.selected ? [value] : [];
  if (Array.isArray(value))
    return value.flatMap((entry) =>
      outputStringValues(entry, options, depth + 1),
    );
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, entry]) => {
      const normalized = key.replace(/[-_]/gu, '').toLowerCase();
      const selected =
        options.selected ||
        /^(?:output|outputs|destination|dest|target|save|artifact|artifacts)(?:path|paths|file|files|filename|filenames|uri|uris)?$/u.test(
          normalized,
        ) ||
        (options.allowGenericPath &&
          /^(?:path|paths|filepath|filepaths|file|files)$/u.test(normalized));
      return outputStringValues(entry, { ...options, selected }, depth + 1);
    },
  );
}

function artifactPaths(tool: ToolCall): string[] {
  const parameterValues = outputStringValues(tool.parameters, {
    allowGenericPath:
      /(?:^|[_-])(?:write|save|export|render)(?:[_-]|$)|^(?:write|save|export|render)/iu.test(
        tool.toolName,
      ),
  });
  const structuredResultValues = outputStringValues(tool.result?.data, {
    allowGenericPath: true,
  });
  const values =
    parameterValues.length || structuredResultValues.length
      ? [...parameterValues, ...structuredResultValues]
      : typeof tool.result?.data === 'string'
        ? [tool.result.data]
        : [];
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

type NativeArtifactVerification = NonNullable<
  AgentArtifactReference['verification']
>;
export interface TurnNativeEvidenceCheckpoint {
  version: 1;
  requestRevision: number;
  contract: import('./taskContract.js').TaskNativeEvidenceSnapshot;
  artifacts: AgentArtifactReference[];
}

function resolveArtifactPath(
  artifactPath: string,
  tool: ToolCall,
  workspacePath?: string,
): string | undefined {
  let candidate = artifactPath.trim();
  if (!candidate) return undefined;
  if (/^~[\\/]/u.test(candidate)) {
    candidate = path.join(homedir(), candidate.slice(2));
  }
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    return path.normalize(candidate);
  }
  const directory =
    tool.result?.process?.directory ??
    (typeof tool.parameters.directory === 'string'
      ? tool.parameters.directory
      : undefined) ??
    workspacePath ??
    process.cwd();
  if (!path.isAbsolute(directory) && !path.win32.isAbsolute(directory))
    return undefined;
  return path.resolve(directory, candidate);
}

function inspectArtifact(
  artifactPath: string,
  tool: ToolCall,
  workspacePath?: string,
): NativeArtifactVerification {
  const resolved = resolveArtifactPath(artifactPath, tool, workspacePath);
  return resolved
    ? inspectArtifactFile(resolved, tool.id)
    : { status: 'unresolved', check: 'native_format', toolCallId: tool.id };
}

/**
 * Owns one turn's semantic lifecycle while legacy chat/tool frames remain
 * intact. Mutations are persisted to the root assistant message before the
 * versioned snapshot event is broadcast.
 */
export class AgentTurnTracker {
  private verificationEvidence = new VerificationEvidenceLedger();
  readonly turnId: string;
  private readonly startedAt = Date.now();
  private control: TurnControlPolicy;
  private taskGraph: TaskGraphCoordinator;
  private verification: TurnVerification;
  private readonly lineage: TurnRunLineage;
  private retries: AgentRetryRecord[] = [];
  private adaptations: AgentAdaptationRecord[] = [];
  private artifacts: AgentArtifactReference[] = [];
  private readonly artifactReceipts = new Map<string, NativeArtifactVerification>();
  private readonly collectedArtifactCalls = new Set<string>();
  private readonly artifactBefore = new Map<string, Map<string, ReturnType<typeof observeFileBefore>>>();
  private citations: AgentCitationReference[] = [];
  private claimEvidence = new ClaimEvidenceLedger();
  private deliveryDraft = '';

  reviewAnswerEvidence(value: unknown): import('./claimEvidence.js').ClaimReview {
    return this.claimEvidence.review(value, this.request?.revision ?? 1, this.request?.text ?? '');
  }
  setDeliveryDraft(text: string): void { this.deliveryDraft = text; }
  offersClaimReview(): boolean { return this.control.evidenceRequirement === 'primary_sources' || this.claimEvidence.hasEvidence(); }
  private claimChecks(): TurnVerificationCheck[] {
    return this.control.evidenceRequirement === 'primary_sources' || !!this.claimEvidence.snapshot()
      ? this.claimEvidence.checks(this.deliveryDraft, this.request?.revision ?? 1) : [];
  }
  private outcome: AgentTurnOutcome | undefined;
  private rootMessageId: string | null = null;
  private status: AgentTurnStatus = 'in_progress';
  private items: AgentTurnItem[] = [];
  private sequence = 0;
  private modelRound = 0;
  private deliveryClosureAttempts = 0;
  private currentStageId: string | null = null;
  private currentToolGroupId: string | null = null;
  private completedAt: number | undefined;
  private sawAssistantContent = false;
  private sawConfirmation = false;
  private reconciliationReason: string | undefined;
  private readonly observedTools = new Map<string, ToolCall>();
  private taskContract?: TaskContractLedger;
  private constraintState?: ReturnType<import('./turnConstraints.js').TurnConstraintGuard['snapshot']>;
  private constraintChecks: TurnVerificationCheck[] = [];
  private constraintsNeedDirection = false;
  updateConstraints(guard: import('./turnConstraints.js').TurnConstraintGuard, text: string): void {
    guard.setSemanticEvidence(this.taskContract?.semanticConstraintEvidence() ?? new Map());
    this.constraintState = guard.active ? guard.snapshot() : undefined;
    this.constraintChecks = guard.checks(text);
    this.constraintsNeedDirection = guard.needsDirection(text);
    this.taskContract?.setNativeConstraintChecks(this.constraintChecks);
  }
  private requiresTaskContract: boolean;
  private request?: import('./protocol.js').AgentTaskRequest;

  reviseRequest(request: import('./protocol.js').AgentTaskRequest, control: TurnControlPolicy): void {
    this.request = structuredClone(request);
    this.control = cloneControl(control);
    this.taskContract = this.taskContract?.rebase(request.text) ?? new TaskContractLedger(request.text, undefined, request.workspacePath);
    this.requiresTaskContract = control.requiresVerification && control.executionMode !== 'restricted';
    this.taskGraph = new TaskGraphCoordinator(control);
    this.sawAssistantContent = false;
    this.sawConfirmation = false;
    // Old cancelled/unstarted directions remain in message audit, not current acceptance.
    for (const [id, tool] of this.observedTools) if (tool.status !== ToolCallStatus.Success) this.observedTools.delete(id);
    this.verificationEvidence = new VerificationEvidenceLedger();
    for (const tool of this.taskContract.boundNativeTools()) this.verificationEvidence.observe(tool, false);
    this.taskGraph.observeTools(this.taskContract.boundNativeTools().filter(isSuccessfulTool).map(tool => ({ name: tool.toolName, status: 'success', evidenceId: tool.id, mutating: isMutationTool(tool), verification: Boolean(verificationKind(tool)) })));
    this.emit('item_updated');
  }

  nativeCheckpoint(): TurnNativeEvidenceCheckpoint | undefined {
    if (!this.taskContract) return;
    this.refreshNativeArtifacts();
    return { version: 1, requestRevision: this.request?.revision ?? 1, contract: this.taskContract.nativeCheckpoint(),
      artifacts: structuredClone(this.artifacts.filter(a => a.verification && this.artifactReceipts.has(a.id)).slice(-128)) };
  }
  restoreNativeCheckpoint(checkpoint: TurnNativeEvidenceCheckpoint): void {
    if (checkpoint.version !== 1 || checkpoint.requestRevision !== (this.request?.revision ?? 1) ||
      !Array.isArray(checkpoint.artifacts) || checkpoint.artifacts.length > 128) throw new Error('Invalid turn evidence revision');
    this.taskContract?.restoreNativeCheckpoint(checkpoint.contract);
    for (const tool of this.taskContract?.boundNativeTools() ?? []) {
      this.observedTools.set(tool.id, tool);
      this.verificationEvidence.observe(tool, false);
    }
    for (const artifact of checkpoint.artifacts) {
      const receipt = artifact.verification;
      if (typeof artifact.id !== 'string' || !receipt || typeof receipt.toolCallId !== 'string') throw new Error('Invalid artifact checkpoint');
      this.artifacts.push(structuredClone(artifact));
      if (this.observedTools.has(receipt.toolCallId)) this.artifactReceipts.set(artifact.id, structuredClone(receipt));
    }
    this.refreshNativeArtifacts();
  }

  constructor(
    private readonly store: SessionStore,
    private readonly sessionId: string,
    control?: TurnControlPolicy,
    options: {
      turnId?: string;
      attempt?: number;
      resumedFromSequence?: number;
      taskGraphSnapshot?: AgentTaskGraphSnapshot;
      taskText?: string;
      request?: import('./protocol.js').AgentTaskRequest;
      taskContractSnapshot?: import('./taskContract.js').TaskContractSnapshot;
    } = {},
  ) {
    this.turnId = options.turnId ?? randomUUID();
    this.request = options.request ? { ...options.request } : undefined;
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
    this.taskContract =
      options.taskText !== undefined
        ? new TaskContractLedger(
            options.taskText,
            options.taskGraphSnapshot?.taskContract ??
              options.taskContractSnapshot,
            this.request?.workspacePath,
          )
        : undefined;
    this.requiresTaskContract = Boolean(
      this.taskContract &&
      this.control.executionMode !== 'restricted' &&
      (this.control.requiresVerification || ['complex', 'orchestrated'].includes(this.control.complexity.level) ||
        (['change', 'create_artifact'].includes(this.control.intent) &&
          this.taskContract
            .requirements()
            .filter(
              (r) =>
                r.behavioral &&
                !/^(?:运行|执行)?(?:测试|验证|类型检查|构建)|^(?:run\s+)?(?:tests?|verify|build)\b/iu.test(
                  r.quote,
                ),
            ).length > 0)),
    );
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
    this.sawAssistantContent = false;
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
    const current = this.items.find((item) => item.id === this.currentStageId);
    if (!current || current.type !== 'stage' || current.detail) return;
    this.upsertItem({ ...current, detail: '正在生成可读结果' }, 'item_updated');
  }

  completeAssistantMessage(hasContent = true): void {
    this.sawAssistantContent = hasContent;
    this.finishCurrentStage('completed');
  }

  updateToolCalls(toolCalls: readonly ToolCall[]): void {
    if (toolCalls.length === 0) return;
    for (const tool of toolCalls) {
      if (tool.status === ToolCallStatus.Executing && isMutationTool(tool) && !this.artifactBefore.has(tool.id)) {
        const targets = [...artifactPaths(tool), ...(this.taskContract?.declaredArtifactPaths() ?? [])];
        this.artifactBefore.set(tool.id, new Map(targets.flatMap(p => {
          const resolved = resolveArtifactPath(p, tool, this.request?.workspacePath);
          return resolved ? [[resolved, observeFileBefore(resolved)] as const] : [];
        })));
      }
      this.verificationEvidence.observe(tool, isMutationTool(tool));
      this.taskContract?.observe(tool, isMutationTool(tool));
    }
    this.taskGraph.observeTools(
      toolCalls
        .filter((tool) => tool.toolName !== TASK_PLAN_TOOL_NAME)
        .map((tool) => ({
          name: tool.toolName,
          status: isSuccessfulTool(tool)
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
        ...structuredClone({ ...tool, confirmationDetails: undefined }),
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
    this.refreshNativeArtifacts();
    if (this.reconciliationReason) {
      this.interruptUnknown(this.reconciliationReason);
      return;
    }
    this.finishCurrentStage('completed');
    if (this.taskContract?.snapshot().objectives.length)
      this.taskGraph.syncObjectives(
        this.taskContract.snapshot(),
        this.taskContract.checks(),
      );
    const satisfied = this.finalizeVerification();
    if (satisfied) {
      if (this.control.requiresVerification) {
        this.taskGraph.markVerificationPassed();
      }
      if (!this.taskGraph.markDelivered()) {
        const validation = this.taskGraph.validate();
        const reason = '任务图尚未满足交付条件，不能标记整轮成功';
        this.finalizeVerification([
          {
            id: 'criterion-task-graph',
            label: '所有任务图依赖已完成',
            status: 'failed',
            evidence: [
              ...validation.incompleteNodeIds,
              ...validation.invalidDependencyIds,
            ],
          },
        ]);
        this.finishTurn('incomplete', { type: 'incomplete', reason });
        return;
      }
      this.finishTurn('completed', { type: 'success' });
      return;
    }
    this.finishTurn('incomplete', {
      type: 'incomplete',
      reason: '成功条件或验证要求尚未全部满足',
    });
  }

  /** Inspect without emitting a terminal outcome or marking the turn delivered. */
  deliveryReadiness(): DeliveryReadiness {
    this.taskGraphSnapshot();
    const satisfied = this.finalizeVerification([], false);
    if (satisfied && this.control.requiresVerification)
      this.taskGraph.markVerificationPassed();
    const missing = this.verification.checks.filter(
      (check) => check.status !== 'passed',
    );
    const graph = this.taskGraph.validate();
    if (!missing.length && !graph.readyToDeliver)
      missing.push({
        id: 'criterion-task-graph',
        label: '任务图仍有未完成的依赖',
        status: 'not_run',
        evidence: [...graph.incompleteNodeIds, ...graph.invalidDependencyIds],
      });
    const blocked = Boolean(
      this.reconciliationReason ||
      this.constraintsNeedDirection ||
      this.taskContract?.hasManualChecks() ||
      [...this.observedTools.values()].some(
        (tool) =>
          [
            ToolCallStatus.Canceled,
            ToolCallStatus.WaitingForConfirmation,
            ToolCallStatus.BackgroundRunning,
          ].includes(tool.status) ||
          (tool.status === ToolCallStatus.Error &&
            ['permission', 'unknown_side_effect'].includes(
              classifyExecutionFailure(tool.result?.error ?? '', hasFailedVerificationReceipt(tool)),
            )),
      ),
    );
    const blockers: string[] = [];
    if (this.constraintChecks.some(c => c.status !== 'passed'))
      blockers.push('用户约束尚未通过原生核对或人工确认；不会把缺失观察视为通过。');
    if (this.reconciliationReason)
      blockers.push('先核对上次操作是否已经生效，避免重复执行。');
    if (this.taskContract?.hasManualChecks())
      blockers.push(
        '存在需要人工判断的验收项，请按待核对列表确认；模型不能代替人工通过。',
      );
    for (const tool of this.observedTools.values()) {
      if (tool.status === ToolCallStatus.Canceled)
        blockers.push('有操作被取消；如仍需执行，请重新明确请求。');
      if (tool.status === ToolCallStatus.WaitingForConfirmation)
        blockers.push('有操作等待权限确认，请先处理确认请求。');
      if (tool.status === ToolCallStatus.BackgroundRunning)
        blockers.push('后台操作尚未结束，需要先核对其结果。');
      if (tool.status === ToolCallStatus.Error) {
        const failure = classifyExecutionFailure(tool.result?.error ?? '', hasFailedVerificationReceipt(tool));
        if (failure === 'permission')
          blockers.push('有工具被拒绝访问，请确认所需权限；不会自动绕过拒绝。');
        if (failure === 'unknown_side_effect')
          blockers.push('有操作结果不明确，需要先核对是否生效，不能直接重试。');
      }
    }
    return {
      missing: structuredClone(missing),
      blocked,
      blockers: [...new Set(blockers)],
      progress: this.verification.checks
        .filter(
          (c) =>
            c.status === 'passed' &&
            (c.id.startsWith('coverage:') || c.id.startsWith('objective:')),
        )
        .map((c) => c.id),
    };
  }

  recordDeliveryClosure(): void {
    this.deliveryClosureAttempts++;
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

  requestClarification(detail: string): void {
    this.finishTurn('interrupted', {
      type: 'interrupt',
      reason: detail,
      resumable: false,
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
    if (this.taskContract?.snapshot().objectives.length)
      this.taskGraph.syncObjectives(
        this.taskContract.snapshot(),
        this.taskContract.checks(),
      );
    return {
      ...this.taskGraph.snapshot(),
      ...(this.taskContract?.snapshot().objectives.length
        ? { taskContract: this.taskContract.snapshot() }
        : {}),
    };
  }
  observedInputPaths(toolCallId: string): string[] {
    return this.taskContract?.observedInputPaths(toolCallId) ?? [];
  }

  repairContext(): import('./deliveryRepair.js').RepairContext {
    const definitions = this.taskContract?.snapshot().objectives.map(({ evidence: _evidence, ...definition }) => definition) ?? [];
    return { workspacePath: this.request?.workspacePath, requestRevision: this.request?.revision ?? 1,
      acceptanceKey: createHash('sha256').update(JSON.stringify(definitions)).digest('hex') };
  }
  hasObservedTool(toolCallId: string): boolean { return this.observedTools.has(toolCallId); }
  resolveRecoveries(fingerprints: readonly string[], toolCallId: string): void {
    const tool = this.observedTools.get(toolCallId);
    if (tool && isSuccessfulTool(tool)) this.taskGraph.resolveRecoveries(fingerprints, toolCallId);
  }

  updateTaskContract(input: unknown): {
    taskPlan: import('./taskContract.js').TaskContractSnapshot;
    checks: TurnVerificationCheck[];
    coverage: TurnVerificationCheck[];
    requirements: ReturnType<TaskContractLedger['requirements']>;
  } {
    if (!this.taskContract) throw new Error('Task contract unavailable');
    this.refreshNativeArtifacts();
    const taskPlan = this.taskContract.update(input);
    const checks = this.taskContract.checks();
    this.control.complexity = refineComplexityFromObjectives(
      this.control.complexity,
      taskPlan.objectives,
      this.control.riskLevel,
    );
    this.taskGraph.syncObjectives(taskPlan, checks);
    return {
      taskPlan,
      checks,
      coverage: this.taskContract.coverageChecks(),
      requirements: this.taskContract.requirements().slice(0, 48),
    };
  }

  taskContractInstructions(): { rules: string; state: string } {
    if (!this.taskContract) return { rules: '', state: '' };
    // Omit planning prose only for an untouched, unconstrained ordinary answer.
    // The native ledger and completion checks still exist; observing a tool or
    // accepting a plan/steering restores these instructions on the next round.
    if (this.control.intent === 'answer' && !this.control.requiresPlan &&
      !this.requiresTaskContract && !this.control.requiresVerification &&
      this.observedTools.size === 0 && this.taskContract.snapshot().revision === 0 &&
      this.taskContract.requirements().every(r => r.kind === 'behavior' && !r.behavioral)) {
      return { rules: '', state: '' };
    }
    return {
      rules: `Internal task acceptance: ${this.requiresTaskContract ? 'A request-specific plan is required before delivery.' : 'For nontrivial work, use update_task_plan to decompose actual requirements.'} Use exact quotes from the user request, explicit dependencies, and scoped process/observation/manual criteria. Use constraint criteria with exact requirementQuote for native operational constraints; only native observations or an actual user review can pass them. Never infer permission from this plan. Model assertions cannot verify work. Missing checks must be disclosed.`,
      state: `Current contract: ${this.taskContract.directive()}`,
    };
  }

  recordArtifact(reference: AgentArtifactReference): void {
    this.artifacts = [
      ...this.artifacts.filter((artifact) => artifact.id !== reference.id),
      structuredClone(reference),
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
    if (tool.result?.sourceEvidence) this.claimEvidence.observe(tool.id, tool.result.sourceEvidence);

    if (isSourceTool(tool)) {
      const uris = citationUris(tool);
      if (
        uris.length === 0 &&
        /(?:enterprise|knowledge|organization)/iu.test(tool.toolName)
      ) {
        this.recordCitation({
          id: referenceId('citation', `${tool.id}:${tool.toolName}`),
          label: `来源工具：${tool.displayName || tool.toolName}`,
          sourceType: 'enterprise',
          verified: false,
          toolCallId: tool.id,
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
          verified: false,
          toolCallId: tool.id,
        });
      }
    }

    const paths = [...new Set([...artifactPaths(tool), ...(tool.toolName === 'run_shell_command' && !verificationKind(tool) ? this.taskContract?.declaredArtifactPaths() ?? [] : [])])];
    if ((isArtifactProducingTool(tool) || (tool.toolName === 'run_shell_command' && !verificationKind(tool))) && !this.collectedArtifactCalls.has(tool.id)) {
      this.collectedArtifactCalls.add(tool.id);
      for (const artifactPath of paths) {
        const verification = inspectArtifact(
          artifactPath,
          tool,
          this.request?.workspacePath,
        );
        const resolved = resolveArtifactPath(artifactPath, tool, this.request?.workspacePath);
        const before = resolved && this.artifactBefore.get(tool.id)?.get(resolved);
        verification.provenance = before && verification.version
          ? before.absent || (before.version && !sameFileVersion(before.version, verification.version)) ? 'created_or_changed' : before.version ? 'unchanged' : 'unobserved'
          : 'unobserved';
        const id = referenceId('artifact', verification.version?.path ?? artifactPath);
        this.artifactReceipts.set(id, verification);
        this.recordArtifact({
          id,
          label: artifactPath.split(/[\\/]/u).at(-1) || artifactPath,
          path: artifactPath,
          mimeType: mimeTypeForPath(artifactPath),
          verified: verification.status === 'verified',
          verification,
        });
      }
    }

    // A successful test/build is not an artifact inspection receipt. Local
    // paths receive a native existence/signature check; external artifacts
    // still require an explicit verified record from their owning adapter.
  }

  private refreshNativeArtifacts(): void {
    this.artifacts = this.artifacts.map((artifact) => {
      const receipt = this.artifactReceipts.get(artifact.id);
      if (!receipt || !artifact.path) return { ...artifact, verified: false };
      const tool = this.observedTools.get(receipt.toolCallId);
      const resolved = tool && resolveArtifactPath(artifact.path, tool, this.request?.workspacePath);
      const current = resolved && readVersionedFile(resolved);
      const verification: NativeArtifactVerification = !current
        ? { ...receipt, status: 'missing' }
        : !sameFileVersion(receipt.version, current.version)
          ? { ...receipt, status: 'stale' }
          : receipt;
      return {
        ...artifact,
        verified: verification.status === 'verified',
        verification,
      };
    });
    this.taskContract?.setNativeArtifacts(this.artifacts);
  }

  async prepareDeliveryEvidence(): Promise<void> {
    await this.taskContract?.prepareSemanticReview();
    for (const [id, receipt] of this.artifactReceipts) {
      if (receipt.status !== 'pending' || !receipt.version || !receipt.version.path.endsWith('.pdf')) continue;
      this.artifactReceipts.set(id, await inspectPdfFile(receipt.version.path, receipt));
    }
    this.refreshNativeArtifacts();
    for (const replacement of this.taskContract?.resolvedExecutionReplacements() ?? []) {
      const original = this.observedTools.get(replacement.originalToolCallId);
      const current = this.observedTools.get(replacement.replacementToolCallId);
      const denied = this.adaptations.some(a => a.failedToolCallId === replacement.originalToolCallId &&
        (a.action === 'reconcile' || a.category === 'permission'));
      if (original && current && !denied && hasSuccessfulProcessReceipt(current))
        this.taskGraph.resolveRecoveries([toolExecutionFingerprint(original.toolName, original.parameters)], current.id);
    }
  }

  snapshot(): AgentTurnSnapshot {
    const updatedAt = Date.now();
    return {
      contractVersion: 1,
      turnId: this.turnId,
      ...(this.request ? { request: { ...this.request } } : {}),
      ...(this.constraintState ? { constraints: structuredClone(this.constraintState) } : {}),
      sequence: this.sequence,
      status: this.status,
      items: this.items.map(cloneItem),
      startedAt: this.startedAt,
      updatedAt,
      control: cloneControl(this.control),
      deliveryClosureAttempts: this.deliveryClosureAttempts,
      verification: cloneVerification(this.verification),
      lineage: { ...this.lineage },
      retries: this.retries.map((retry) => ({ ...retry })),
      adaptations: this.adaptations.map((adaptation) => ({ ...adaptation })),
      artifacts: structuredClone(this.artifacts),
      citations: this.citations.map((citation) => ({ ...citation })),
      ...(this.claimEvidence.snapshot() ? { claimEvidence: this.claimEvidence.snapshot() } : {}),
      taskGraph: this.taskGraphSnapshot(),
      ...(this.outcome ? { outcome: { ...this.outcome } } : {}),
      ...(this.completedAt ? { completedAt: this.completedAt } : {}),
    };
  }

  private currentVerificationChecks(
    kind?: import('./protocol.js').TurnVerificationKind,
  ): TurnVerificationCheck[] {
    const superseded =
      this.taskContract?.supersededVerificationScopes() ?? new Set<string>();
    return this.verificationEvidence
      .checks(kind)
      .filter((check) => !superseded.has(check.id));
  }

  private finalizeVerification(
    extraChecks: TurnVerificationCheck[] = [],
    publish = true,
  ): boolean {
    this.refreshNativeArtifacts();
    const checks = [
      ...this.control.successCriteria.map((criterion) =>
        this.evaluateCriterion(criterion),
      ),
      ...this.currentVerificationChecks(),
      ...this.constraintChecks,
      ...this.claimChecks(),
      ...[...this.observedTools.values()].filter(tool => ![ToolCallStatus.Success, ToolCallStatus.Error].includes(tool.status)).map(tool => ({
        id: `unsettled:${tool.id}`, label: `操作尚未取得终态回执：${tool.displayName ?? tool.toolName}`, status: 'not_run' as const, evidence: [tool.id],
      })),
      ...(this.taskContract?.checks() ?? []),
      ...(this.taskContract?.coverageChecks() ?? []),
      ...(this.taskContract?.semanticChecks() ?? []),
      ...(this.requiresTaskContract &&
      !this.taskContract?.snapshot().objectives.length
        ? [
            {
              id: 'criterion-task-contract',
              label: '按实际需求拆分子任务与验收条件',
              status: 'not_run' as const,
            },
          ]
        : []),
      ...extraChecks,
    ];
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

    if (publish && (this.control.requiresVerification || !allSatisfied)) {
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
    const latestMutations = new Map<string, ToolCall>();
    for (const tool of tools.filter(isMutationTool)) latestMutations.set(toolExecutionFingerprint(tool.toolName, tool.parameters), tool);
    const failedMutations = [...latestMutations.values()].filter(isFailedTool);
    const verificationChecks = this.currentVerificationChecks(
      criterion.verificationKind,
    );
    const verified =
      verificationChecks.length > 0 &&
      verificationChecks.every((check) => check.status === 'passed');
    const traceableSources = this.citations.filter(
      (citation) =>
        citation.verified &&
        (Boolean(citation.uri) || citation.sourceType === 'enterprise'),
    );

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
        satisfied = this.artifacts.length > 0 && this.artifacts.every((artifact) => artifact.verified);
        explicitlyFailed =
          failedMutations.length > 0 ||
          this.artifacts.some(
            (artifact) =>
              !artifact.verified,
          );
        evidence = this.artifacts
          .filter((artifact) => artifact.verified)
          .map((artifact) => artifact.label);
        break;
      case 'evidence':
        if (this.control.evidenceRequirement === 'primary_sources') {
          satisfied = this.claimChecks().length > 0 && this.claimChecks().every(c => c.status === 'passed');
          explicitlyFailed = tools.some(isSourceTool) && !satisfied;
        } else {
          satisfied =
            verified ||
            (this.control.intent === 'diagnose' && successful.length > 0);
          explicitlyFailed = failed.length > 0 && !satisfied;
        }
        evidence = satisfied
          ? traceableSources.length > 0
            ? traceableSources.map((source) => source.label)
            : ['已获得可复核的工具结果']
          : undefined;
        break;
      case 'verification':
        if (this.control.evidenceRequirement === 'primary_sources') {
          satisfied = this.claimChecks().length > 0 && this.claimChecks().every(c => c.status === 'passed');
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
          satisfied = verified;
        }
        explicitlyFailed =
          !satisfied &&
          (failed.length > 0 ||
            verificationChecks.some((check) => check.status === 'failed'));
        evidence = satisfied
          ? ['各项要求均有对应执行回执，具体范围见独立检查项']
          : undefined;
        break;
      case 'receipt':
        satisfied = successfulMutations.some(
          (tool) => tool.result?.success === true,
        );
        if (this.control.confirmationMode === 'always') {
          satisfied &&= this.sawConfirmation;
        }
        explicitlyFailed = failedMutations.length > 0;
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
      label: this.control.evidenceRequirement === 'primary_sources' && ['evidence', 'verification'].includes(criterion.kind)
        ? '当前结论已核对原文归属或明确证据不足；不代表一手来源身份和事实真伪已认证'
        : criterion.label,
      status: explicitlyFailed ? 'failed' : satisfied ? 'passed' : 'not_run',
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
