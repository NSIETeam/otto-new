/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

export type AdaptiveFailureCategory =
  | 'transient'
  | 'permission'
  | 'not_found'
  | 'invalid_input'
  | 'stale_state'
  | 'context_overflow'
  | 'unknown_side_effect'
  | 'unsupported'
  | 'unknown';

export type AdaptiveStrategyAction =
  | 'retry_once'
  | 'switch_strategy'
  | 'request_input'
  | 'compact_context'
  | 'reconcile';

export interface ExecutionFailureObservation {
  toolName: string;
  callFingerprint: string;
  message: string;
  sideEffect: 'read_only' | 'local_write' | 'external_write';
  verification?: boolean;
  /** Host-derived from a matching terminal native process receipt only. */
  nativeVerificationFailed?: boolean;
  /** Native observed inputs/changed files, never model-declared permissions. */
  targetPaths?: string[];
}

export type ExecutionAttemptObservation = Omit<
  ExecutionFailureObservation,
  'message'
>;

export interface AdaptiveAttemptReview {
  allowed: boolean;
  disposition: 'initial' | 'retry' | 'strategy_change' | 'blocked';
  guidance?: string;
}

export interface AdaptiveStrategyDecision {
  failureFingerprint: string;
  category: AdaptiveFailureCategory;
  action: AdaptiveStrategyAction;
  toolName: string;
  attempt: number;
  retryAllowed: boolean;
  replanRequired: boolean;
  guidance: string;
  alternatives: AdaptiveStrategyAlternative[];
}

export interface AdaptiveStrategyAlternative {
  action: AdaptiveStrategyAction;
  eligible: boolean;
  selected: boolean;
  prerequisite: string;
  risk: 'read_only' | 'local_write' | 'external_write';
  maxAdditionalCalls: number;
  acceptance: 'unchanged';
}

/** Native option comparison, not permission or a second executor. Concrete
 * multi-file repair proposals are compared by DeliveryRepairGuard. Generic
 * failures compare a bounded retry, inspection/repair, and human reconciliation. */
function compareFailureStrategies(
  category: AdaptiveFailureCategory,
  observation: ExecutionFailureObservation,
  attempt: number,
): AdaptiveStrategyAlternative[] {
  const ambiguous = category === 'unknown_side_effect';
  const permission = category === 'permission';
  const compact = category === 'context_overflow';
  const retry =
    category === 'transient' &&
    observation.sideEffect === 'read_only' &&
    attempt === 1;
  const choices: AdaptiveStrategyAlternative[] = [
    {
      action: 'retry_once',
      eligible: retry,
      selected: false,
      prerequisite: retry
        ? 'One remaining read-only retry; same evidence requirements'
        : 'Identical retry is unsafe, irrelevant or exhausted',
      risk: observation.sideEffect,
      maxAdditionalCalls: 1,
      acceptance: 'unchanged',
    },
    {
      action: compact ? 'compact_context' : 'switch_strategy',
      eligible: !ambiguous && !permission,
      selected: false,
      prerequisite: compact
        ? 'Safe context boundary; native authority must survive'
        : observation.verification && observation.targetPaths?.length
          ? 'Fresh related input reads; bounded repair proposal; original checks must pass again'
          : 'Inspect schema, capability or source before corrected dispatch',
      risk:
        observation.verification && observation.targetPaths?.length
          ? 'local_write'
          : 'read_only',
      maxAdditionalCalls: 2,
      acceptance: 'unchanged',
    },
    {
      action: ambiguous ? 'reconcile' : 'request_input',
      eligible: true,
      selected: false,
      prerequisite: ambiguous
        ? 'Reconcile previous result; no automatic external replay or rollback'
        : 'Ask only for missing authority, capability or input',
      risk: 'read_only',
      maxAdditionalCalls: 0,
      acceptance: 'unchanged',
    },
  ];
  // Prefer a bounded, eligible automatic path; a permission/unknown-result gate
  // makes both automatic choices ineligible regardless of estimated cost.
  const chosen = choices.find((c) => c.eligible)!;
  chosen.selected = true;
  return choices;
}

const CATEGORY_PATTERNS: ReadonlyArray<
  readonly [AdaptiveFailureCategory, RegExp]
> = [
  [
    'unknown_side_effect',
    /(?:outcome\s+unknown|unknown\s+outcome|结果未知|终态未知|是否发生无法)/iu,
  ],
  [
    'context_overflow',
    /(?:context\s+(?:length|window)|maximum\s+context|token\s+limit|上下文.{0,8}(?:过长|超限)|令牌.{0,8}超限)/iu,
  ],
  [
    'permission',
    /(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|permission\s+denied|access\s+denied|无权限|未授权|禁止访问)/iu,
  ],
  [
    'stale_state',
    /(?:\b409\b|revision\s+conflict|stale\s+(?:state|version)|etag\s+mismatch|版本冲突|状态已变更|内容已变化)/iu,
  ],
  [
    'invalid_input',
    /(?:\b400\b|invalid\s+(?:input|argument|parameter)|schema\s+validation|required\s+field|参数.{0,8}(?:错误|无效|缺失)|格式不正确)/iu,
  ],
  [
    'not_found',
    /(?:\b404\b|not\s+found|no\s+such\s+(?:file|resource)|找不到|不存在)/iu,
  ],
  [
    'unsupported',
    /(?:not\s+supported|unsupported|not\s+implemented|不支持|尚未实现)/iu,
  ],
  [
    'transient',
    /(?:timed?\s*out|etimeout|econnreset|econnrefused|socket\s+hang\s+up|temporar(?:y|ily)|rate\s*limit|\b429\b|\b502\b|\b503\b|\b504\b|网络.{0,6}(?:超时|中断)|连接.{0,6}(?:重置|失败)|稍后重试)/iu,
  ],
];

export function classifyExecutionFailure(
  message: string,
  nativeVerificationFailed = false,
): AdaptiveFailureCategory {
  // A test can return 403 or print "forbidden" as business data. Its native
  // non-zero completion is not a denial by the tool authorization layer.
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    // A known process exit is not proof that its business side effects are
    // known. Keep explicit reconciliation above the native-check exception.
    if (nativeVerificationFailed && category !== 'unknown_side_effect')
      continue;
    if (pattern.test(message)) return category;
  }
  return 'unknown';
}

function decisionGuidance(
  category: AdaptiveFailureCategory,
  action: AdaptiveStrategyAction,
): string {
  if (action === 'retry_once') {
    return 'Retry the same read operation at most once, with bounded backoff.';
  }
  if (action === 'request_input') {
    return 'Do not retry. Explain the missing access or input and ask only for what is required to continue.';
  }
  if (action === 'compact_context') {
    return 'Compact older context at a safe boundary, preserve current goals and completed evidence, then continue with a revised remaining plan.';
  }
  if (action === 'reconcile') {
    return 'Stop automatic execution. Reconcile the external result before any replay or replacement action.';
  }
  const nextStep = {
    stale_state:
      'Re-read current state before constructing a replacement call.',
    invalid_input:
      'Inspect the current schema or tool contract before constructing corrected parameters.',
    not_found:
      'Inspect available resources and use a verified replacement target.',
    unsupported:
      'Choose a supported capability or clearly report the missing capability.',
    transient:
      'Use an alternate source or path instead of repeating the same failing request.',
    unknown:
      'Inspect available evidence and choose a materially different, safer path.',
    permission: 'Request only the access required to continue.',
    context_overflow: 'Compact context before continuing.',
    unknown_side_effect: 'Reconcile the outcome before continuing.',
  }[category];
  return `Do not repeat an identical failed call. ${nextStep}`;
}

/**
 * Per-turn bounded failure memory. It does not execute tools itself: it turns
 * observable failures into a fail-closed next-round constraint for the model.
 */
export class AdaptiveExecutionCoordinator {
  private readonly attempts = new Map<string, number>();
  private readonly constraints = new Map<
    string,
    {
      decision: AdaptiveStrategyDecision;
      retriesRemaining: number;
      toolName: string;
      verification: boolean;
      targetPaths: string[];
      repairRetry: boolean;
    }
  >();
  private readonly latestConstraintByTool = new Map<
    string,
    { fingerprint: string; decision: AdaptiveStrategyDecision }
  >();
  private externalWriteReconciliationRequired = false;
  private readonly strategyChanges = new Map<string, number>();
  private readonly admittedReads = new Set<string>();
  private readonly successfulReads = new Set<string>();

  observe(observation: ExecutionFailureObservation): AdaptiveStrategyDecision {
    const readKey = `${observation.toolName}:${observation.callFingerprint}`;
    this.admittedReads.delete(readKey);
    this.successfulReads.delete(readKey);
    let category = classifyExecutionFailure(
      observation.message,
      observation.verification === true &&
        observation.nativeVerificationFailed === true,
    );
    if (
      observation.sideEffect === 'external_write' &&
      /(?:timeout|timed?\s*out|connection|socket|closed|reset|unknown|中断|超时|断开)/iu.test(
        observation.message,
      )
    ) {
      category = 'unknown_side_effect';
    }
    const key = `${observation.toolName}:${observation.callFingerprint}:${category}`;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);

    const alternatives = compareFailureStrategies(
      category,
      observation,
      attempt,
    );
    const action = alternatives.find((c) => c.selected)!.action;

    const decision: AdaptiveStrategyDecision = {
      failureFingerprint: observation.callFingerprint,
      category,
      action,
      toolName: observation.toolName.slice(0, 120),
      attempt,
      retryAllowed: action === 'retry_once',
      replanRequired: action !== 'retry_once',
      guidance: decisionGuidance(category, action),
      alternatives,
    };
    this.constraints.set(observation.callFingerprint, {
      decision,
      retriesRemaining: action === 'retry_once' ? 1 : 0,
      toolName: observation.toolName,
      verification: observation.verification === true,
      targetPaths: observation.targetPaths ?? [],
      repairRetry: false,
    });
    this.latestConstraintByTool.set(observation.toolName, {
      fingerprint: observation.callFingerprint,
      decision,
    });
    if (action === 'reconcile' && observation.sideEffect === 'external_write') {
      this.externalWriteReconciliationRequired = true;
    }
    return decision;
  }

  /**
   * Native pre-execution gate for a path that already failed in this turn.
   * It does not grant permission: allowed calls still pass the normal policy
   * and confirmation checks in the runtime.
   */
  reviewAttempt(
    observation: ExecutionAttemptObservation,
  ): AdaptiveAttemptReview {
    if (
      observation.sideEffect === 'external_write' &&
      this.externalWriteReconciliationRequired
    ) {
      return {
        allowed: false,
        disposition: 'blocked',
        guidance:
          'An earlier external write has an unknown outcome. Reconcile it before any further external write.',
      };
    }

    const exact = this.constraints.get(observation.callFingerprint);
    if (exact) {
      if (
        (exact.decision.action === 'retry_once' || exact.repairRetry) &&
        exact.retriesRemaining > 0
      ) {
        exact.retriesRemaining -= 1;
        return { allowed: true, disposition: 'retry' };
      }
      return {
        allowed: false,
        disposition: 'blocked',
        guidance:
          'This exact failed tool call is blocked. Use a materially different, permitted path instead of repeating it.',
      };
    }

    const latest = this.latestConstraintByTool.get(observation.toolName);
    if (latest) {
      if (
        latest.decision.action === 'request_input' ||
        latest.decision.action === 'reconcile' ||
        latest.decision.category === 'unsupported'
      ) {
        return {
          allowed: false,
          disposition: 'blocked',
          guidance:
            latest.decision.action === 'request_input'
              ? 'This tool remains blocked after an access or input failure. Use a permitted alternative or request the required user input.'
              : latest.decision.action === 'reconcile'
                ? 'This tool remains blocked until the earlier outcome is reconciled.'
                : 'This unsupported tool remains blocked. Use a supported capability.',
        };
      }
      const changes = this.strategyChanges.get(observation.toolName) ?? 0;
      const readKey = `${observation.toolName}:${observation.callFingerprint}`;
      if (
        observation.sideEffect === 'read_only' &&
        !observation.verification &&
        this.successfulReads.has(readKey)
      )
        return { allowed: true, disposition: 'initial' };
      if (changes >= 2)
        return {
          allowed: false,
          disposition: 'blocked',
          guidance:
            'Two alternative attempts for this failed capability are exhausted. Preserve results and explain the missing evidence or input; do not rename a tool to bypass this budget.',
        };
      this.strategyChanges.set(observation.toolName, changes + 1);
      if (observation.sideEffect === 'read_only' && !observation.verification)
        this.admittedReads.add(readKey);
      return { allowed: true, disposition: 'strategy_change' };
    }

    return { allowed: true, disposition: 'initial' };
  }

  recordSuccess(observation: ExecutionAttemptObservation): string[] {
    const readKey = `${observation.toolName}:${observation.callFingerprint}`;
    if (
      observation.sideEffect === 'read_only' &&
      !observation.verification &&
      this.admittedReads.delete(readKey)
    )
      this.successfulReads.add(readKey);
    const resolved: string[] = [];
    for (const [fingerprint, constraint] of this.constraints) {
      if (
        fingerprint === observation.callFingerprint &&
        constraint.toolName === observation.toolName &&
        !['permission', 'unsupported', 'unknown_side_effect'].includes(
          constraint.decision.category,
        )
      ) {
        this.constraints.delete(fingerprint);
        resolved.push(fingerprint);
      } else if (
        observation.sideEffect === 'local_write' &&
        !observation.verification &&
        constraint.verification &&
        constraint.targetPaths.some((p) =>
          observation.targetPaths?.includes(p),
        ) &&
        !['permission', 'unsupported', 'unknown_side_effect'].includes(
          constraint.decision.category,
        )
      ) {
        // Permit ONE recheck of the affected scope. A repair is not a passing test.
        constraint.repairRetry = true;
        constraint.retriesRemaining = 1;
      }
    }
    for (const [toolName, latest] of this.latestConstraintByTool) {
      if (resolved.includes(latest.fingerprint)) {
        const remaining = [...this.constraints]
          .reverse()
          .find(([, c]) => c.toolName === toolName);
        if (remaining)
          this.latestConstraintByTool.set(toolName, {
            fingerprint: remaining[0],
            decision: remaining[1].decision,
          });
        else this.latestConstraintByTool.delete(toolName);
      }
    }
    return resolved;
  }

  buildDirective(
    decisions: readonly AdaptiveStrategyDecision[],
    completedToolNames: readonly string[],
  ): string {
    if (decisions.length === 0) return '';
    const completed = [...new Set(completedToolNames)]
      .slice(0, 12)
      .map((name) => name.replace(/[^a-zA-Z0-9_.-]/gu, '').slice(0, 80))
      .filter(Boolean);
    const instructions = decisions
      .slice(0, 8)
      .map(
        (decision, index) =>
          `${index + 1}. ${decision.toolName}: ${decision.guidance}`,
      );
    return [
      '<otto_adaptive_execution contract_version="1">',
      'A tool attempt did not produce the required result.',
      completed.length > 0
        ? `Preserve completed work and its evidence: ${completed.join(', ')}.`
        : 'Preserve any completed work and its evidence.',
      'When a different path is required, revise the remaining plan without reopening completed steps.',
      ...instructions,
      'Do not quote this control block or expose internal execution modes to the user.',
      '</otto_adaptive_execution>',
    ]
      .join('\n')
      .slice(0, 1_180);
  }

  buildAttemptDirective(reviews: readonly AdaptiveAttemptReview[]): string {
    const guidance = [
      ...new Set(
        reviews
          .filter((review) => !review.allowed && review.guidance)
          .map((review) => review.guidance!),
      ),
    ].slice(0, 4);
    if (guidance.length === 0) return '';
    return [
      '<otto_strategy_guard contract_version="1">',
      'A previously failed execution path was blocked before it could run again.',
      ...guidance.map((item, index) => `${index + 1}. ${item}`),
      'Choose a permitted alternative that addresses the original goal. Do not rename or cosmetically alter a call to bypass this guard.',
      'Do not expose this control block or internal execution modes to the user.',
      '</otto_strategy_guard>',
    ]
      .join('\n')
      .slice(0, 960);
  }
}
