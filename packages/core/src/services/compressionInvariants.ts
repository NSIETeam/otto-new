/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { Content } from '../types/extendedContent.js';
import { createHash } from 'node:crypto';

export interface CompressionInvariantSnapshot {
  contractVersion: 1;
  goals: string[];
  constraints: string[];
  evidence: string[];
  continuity?: {
    requests: Array<{ id: string; text: string; supersedes: string[] }>;
    activeRequestIds: string[];
    remaining: Array<{
      id: string;
      label: string;
      status: 'pending' | 'failed' | 'not_run';
    }>;
    requiresReview: boolean;
  };
}

export interface CompressionInvariantValidation {
  valid: boolean;
  missing: string[];
}

const CONSTRAINT_PATTERN =
  /(?:必须|不允许|不得|不能|不要|禁止|务必|需要保留|只能|仅限|must|must\s+not|do\s+not|never|required|prohibited)/iu;
const CONTROL_BLOCK_PATTERN =
  /<otto_(?:turn_control|task_graph)[\s\S]*?<\/otto_(?:turn_control|task_graph)>/giu;
const VAGUE_CONTINUATION_PATTERN =
  /^(?:(?:继续|接着)(?:进行|做)?|(?:继续|接着).{0,8}(?:这个|该|上述|前述)(?:功能|模块|板块|部分|任务)|往下做|好的?|可以|行|ok|okay|go\s+on|continue)[。.!！]*$/iu;
const ARTIFACT_PATH_PATTERN =
  /(?:[A-Za-z]:[\\/]|~[\\/]|\.{0,2}[\\/])?[^\s<>"'|?*]+?\.(?:cjs|css|csv|docx?|gif|html?|jpe?g|js|json|md|mjs|pdf|png|pptx?|py|rs|svg|ts|tsx|txt|webp|xlsx?|xml|yaml|yml|zip)/giu;

function partText(content: Content): string {
  return (content.parts ?? [])
    .map((part) => {
      const value = (part as { text?: unknown }).text;
      return typeof value === 'string' ? value : '';
    })
    .filter(Boolean)
    .join('\n')
    .replace(CONTROL_BLOCK_PATTERN, '')
    .trim();
}

function sanitize(value: string, limit = 800): string {
  const withoutControls = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join('');
  return withoutControls
    .replace(/\b(?:bearer\s+)[a-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(token|api[_-]?key|secret|password|passwd|authorization)\s*[:=]\s*[^\s,;，；]+/giu,
      '$1=[REDACTED]',
    )
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function unique(values: string[], limit: number): string[] {
  return [
    ...new Set(values.map((value) => sanitize(value)).filter(Boolean)),
  ].slice(0, limit);
}

function sentences(value: string): string[] {
  return value
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((item) => sanitize(item, 500))
    .filter(Boolean);
}

function goalCandidate(value: string): string {
  const negativeConstraint =
    /(?:不允许|不得|不能|不要|禁止|must\s+not|do\s+not|never|prohibited)/iu;
  const positiveConstraintPrefix = /^(?:必须|务必|required\s+to|must)\s*/iu;
  return sentences(value)
    .flatMap((sentence) => sentence.split(/[，,]+/u))
    .map((clause) => sanitize(clause, 500))
    .filter((clause) => !negativeConstraint.test(clause))
    .map((clause) => clause.replace(positiveConstraintPrefix, ''))
    .filter((clause) => clause && !CONSTRAINT_PATTERN.test(clause))
    .join(' ')
    .trim();
}

function isSubstantiveGoal(value: string): boolean {
  return value.length >= 6 && !VAGUE_CONTINUATION_PATTERN.test(value);
}

function objectStrings(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => objectStrings(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap((item) =>
    objectStrings(item, depth + 1),
  );
}

function observableEvidence(content: Content): string[] {
  return (content.parts ?? []).flatMap((part) => {
    const responsePart = part as {
      functionResponse?: { id?: unknown; name?: unknown; response?: unknown };
    };
    const functionResponse = responsePart.functionResponse;
    if (!functionResponse) return [];
    const response = functionResponse.response;
    const responseRecord =
      response && typeof response === 'object'
        ? (response as Record<string, unknown>)
        : undefined;
    if (
      responseRecord?.success === false ||
      ['cancelled', 'canceled', 'declined', 'error', 'failed'].includes(
        String(responseRecord?.status ?? responseRecord?.outcome ?? '')
          .trim()
          .toLowerCase(),
      ) ||
      (typeof responseRecord?.error === 'string' && responseRecord.error.trim())
    ) {
      return [];
    }
    const toolName =
      sanitize(String(functionResponse.name ?? 'tool'), 80).replace(
        /[^a-zA-Z0-9_.:-]/gu,
        '',
      ) || 'tool';
    const safePaths = unique(
      objectStrings(response).flatMap(
        (value) => value.match(ARTIFACT_PATH_PATTERN) ?? [],
      ),
      4,
    );
    const callId = sanitize(String(functionResponse.id ?? ''), 120).replace(
      /[^a-zA-Z0-9_.:-]/gu,
      '',
    );
    const outcomeDigest = createHash('sha256')
      .update(JSON.stringify(response)?.slice(0, 20_000) ?? '')
      .digest('hex')
      .slice(0, 12);
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          toolName,
          callId,
          safePaths,
          outcomeDigest,
          success: true,
        }),
      )
      .digest('hex')
      .slice(0, 12);
    return [
      `tool:${toolName}:success:${digest}${
        safePaths.length > 0 ? ` paths=${safePaths.join(',')}` : ''
      }`,
    ];
  });
}

function entryLines(snapshot: CompressionInvariantSnapshot): string[] {
  const encode = (value: string): string =>
    JSON.stringify(value)
      .replace(/</gu, '\\u003c')
      .replace(/>/gu, '\\u003e')
      .replace(/&/gu, '\\u0026');
  return [
    ...snapshot.goals.map(
      (value, index) => `goal:${index + 1}=${encode(value)}`,
    ),
    ...snapshot.constraints.map(
      (value, index) => `constraint:${index + 1}=${encode(value)}`,
    ),
    ...snapshot.evidence.map(
      (value, index) => `evidence:${index + 1}=${encode(value)}`,
    ),
    ...(snapshot.continuity
      ? [`continuity=${encode(JSON.stringify(snapshot.continuity))}`]
      : []),
  ];
}

/** Capture only bounded semantic invariants, never the entire hidden context. */
export function captureCompressionInvariants(
  history: Content[],
  skipEnvironmentMessages = 2,
): CompressionInvariantSnapshot {
  const conversation = history.slice(
    Math.min(skipEnvironmentMessages, history.length),
  );
  const previous = [...conversation]
    .reverse()
    .find((content) => content.compressionSnapshot)?.compressionSnapshot;
  const userMessages = conversation
    .filter(
      (content) =>
        content.role === 'user' &&
        !content.compressionSnapshot &&
        !(content.parts ?? []).some((part) => 'functionResponse' in part),
    )
    .map((content) => ({
      text: partText(content),
      promptId: content.prompt_id,
    }))
    .filter((entry) => entry.text);
  const userTexts = userMessages.map((entry) => entry.text);
  const requests = structuredClone(previous?.continuity?.requests ?? []);
  let activeRequestIds = [...(previous?.continuity?.activeRequestIds ?? [])];
  let requiresReview = previous?.continuity?.requiresReview ?? false;
  for (const { text: value, promptId } of userMessages) {
    const candidate = goalCandidate(value);
    if (!isSubstantiveGoal(candidate)) continue;
    const text = sanitize(value, 1600);
    const id = createHash('sha256')
      .update(`${promptId ?? ''}:${text}`)
      .digest('hex')
      .slice(0, 16);
    if (requests.some((request) => request.id === id)) continue;
    // Only an explicit whole-task replacement retires prior goals. Partial changes
    // and ambiguous switches remain visible and must be reconciled by the agent.
    const replaces =
      /(?:取消|放弃|停止)(?:之前|原来|上一个|原先|全部)的?(?:任务|需求|工作)|(?:cancel|abandon|replace)\s+(?:the\s+)?(?:previous|earlier)\s+(?:task|request)/iu.test(
        value,
      );
    const supersedes = replaces ? [...activeRequestIds] : [];
    if (replaces) activeRequestIds = [];
    if (
      !replaces &&
      activeRequestIds.length &&
      /改为|改成|换成|instead|rather\s+than/iu.test(value)
    )
      requiresReview = true;
    requests.push({ id, text, supersedes });
    activeRequestIds.push(id);
  }
  const goals = requests
    .filter((request) => activeRequestIds.includes(request.id))
    .map((request) => goalCandidate(request.text))
    .reverse();
  const constraints = [
    ...(previous?.constraints ?? []),
    ...userTexts
      .flatMap(sentences)
      .filter((sentence) => CONSTRAINT_PATTERN.test(sentence)),
  ];
  if (
    constraints.length &&
    userTexts.some((value) =>
      /(?:现在允许|现在授权|解除限制|撤销限制|now\s+(?:allow|authorize))/iu.test(
        value,
      ),
    )
  )
    requiresReview = true;
  const evidence = [
    ...(previous?.evidence ?? []),
    ...conversation.flatMap(observableEvidence),
  ];
  let remaining = structuredClone(previous?.continuity?.remaining ?? []);
  for (const content of conversation) {
    for (const part of content.parts ?? []) {
      const response = part.functionResponse;
      if (
        response?.name !== 'update_task_plan' ||
        response.response?.success !== true
      )
        continue;
      const checks = response.response.checks;
      if (!Array.isArray(checks)) continue;
      remaining = checks.flatMap((check) => {
        if (!check || typeof check !== 'object') return [];
        if (
          !['passed', 'pending', 'failed', 'not_run'].includes(check.status) ||
          typeof check.id !== 'string' ||
          typeof check.label !== 'string'
        ) {
          requiresReview = true;
          return [];
        }
        // Text history cannot establish whether a later write invalidated this receipt.
        // Keep prior passes pending reconciliation with the live native ledger; never
        // require a redundant execution if that ledger still has current evidence.
        return [
          {
            id: sanitize(check.id, 180),
            label: sanitize(check.label),
            status: (check.status === 'passed' ? 'pending' : check.status) as
              'pending' | 'failed' | 'not_run',
          },
        ];
      });
    }
  }
  requiresReview ||=
    requests.length > 16 ||
    remaining.length > 128 ||
    new Set(constraints).size > 12;
  const boundedRequests = requests.slice(-16);

  return {
    contractVersion: 1,
    goals: unique(goals.length ? goals : (previous?.goals ?? []), 16),
    constraints: unique(constraints, 12),
    evidence: unique(evidence, 16),
    continuity: {
      requests: boundedRequests,
      activeRequestIds: activeRequestIds.filter((id) =>
        boundedRequests.some((request) => request.id === id),
      ),
      remaining: remaining.slice(0, 128),
      requiresReview,
    },
  };
}

export function appendCompressionInvariantSnapshot(
  summary: string,
  snapshot: CompressionInvariantSnapshot,
): string {
  const canonical = [
    '<otto_compaction_invariants contract_version="1">',
    ...entryLines(snapshot),
    '</otto_compaction_invariants>',
  ].join('\n');
  return `${summary.trim()}\n\n${canonical}`.trim();
}

/** Validate exact canonical entries after all history cleanup/role repair. */
export function validateCompressionInvariants(
  snapshot: CompressionInvariantSnapshot,
  restoredHistory: Content[],
  requireNativeState = false,
): CompressionInvariantValidation {
  const restoredText = restoredHistory.map(partText).join('\n');
  const missing = entryLines(snapshot)
    .filter((entry) => !restoredText.includes(entry))
    .map((entry) => entry.slice(0, entry.indexOf('=')));
  if (requireNativeState) {
    const state = restoredHistory.find(
      (content) => content.compressionSnapshot,
    )?.compressionSnapshot;
    if (
      !state ||
      JSON.stringify(state.continuity) !== JSON.stringify(snapshot.continuity)
    )
      missing.push('native-task-continuity');
    const requests = snapshot.continuity?.requests ?? [];
    const seen = new Set<string>();
    for (const request of requests) {
      if (seen.has(request.id) || request.supersedes.includes(request.id))
        missing.push('invalid-request-chronology');
      seen.add(request.id);
    }
    if (snapshot.continuity?.activeRequestIds.some((id) => !seen.has(id)))
      missing.push('unknown-active-request');
  }
  return { valid: missing.length === 0, missing };
}
