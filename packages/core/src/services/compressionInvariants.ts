/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { Content } from '../types/extendedContent.js';
import { createHash } from 'node:crypto';

export interface CompressionInvariantSnapshot {
  contractVersion: 1;
  goals: string[];
  constraints: string[];
  evidence: string[];
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
  const userTexts = conversation
    .filter((content) => content.role === 'user')
    .map(partText)
    .filter(Boolean);
  const goals = userTexts
    .map(goalCandidate)
    .filter(isSubstantiveGoal)
    .slice(-3)
    .reverse();
  const constraints = userTexts
    .flatMap(sentences)
    .filter((sentence) => CONSTRAINT_PATTERN.test(sentence));
  const evidence = conversation.flatMap(observableEvidence);

  return {
    contractVersion: 1,
    goals: unique(goals, 3),
    constraints: unique(constraints, 12),
    evidence: unique(evidence, 16),
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
): CompressionInvariantValidation {
  const restoredText = restoredHistory.map(partText).join('\n');
  const missing = entryLines(snapshot)
    .filter((entry) => !restoredText.includes(entry))
    .map((entry) => entry.slice(0, entry.indexOf('=')));
  return { valid: missing.length === 0, missing };
}
