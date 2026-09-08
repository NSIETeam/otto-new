/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type {
  RecruitmentCandidateEvidenceInput,
  RecruitmentCandidateHit,
  RecruitmentSourceAdapter,
  RecruitmentSourceCapability,
  RecruitmentSourceSearchResult,
} from './recruitmentSourceGateway.js';
import { normalizeRecruitmentMaterial } from './recruitmentSourceMaterial.js';

export interface RecruitmentMcpToolDescriptor {
  /** Registered name in Otto's tool registry. */
  name: string;
  /** Original, unqualified MCP tool name. */
  serverToolName: string;
}

export interface RecruitmentMcpInvocation {
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
}

export type RecruitmentMcpInvoker = (
  invocation: RecruitmentMcpInvocation,
) => Promise<unknown>;

const CAPABILITIES = new Set<RecruitmentSourceCapability>([
  'search_candidates',
  'get_candidate',
  'sync_candidates',
  'draft_outreach',
  'send_outreach',
  'publish_job',
  'schedule_interview',
]);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/u;

function contractError(detail: string): Error {
  return new Error(`recruitment MCP v1 contract violation: ${detail}`);
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function parseJson(value: string): unknown {
  if (value.length > 2_000_000) throw contractError('tool output is too large');
  try {
    return JSON.parse(stripJsonFence(value));
  } catch {
    throw contractError('tool output is not valid JSON');
  }
}

function unwrapOutput(raw: unknown): unknown {
  if (typeof raw === 'string') return parseJson(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const object = raw as Record<string, unknown>;
  if (object.isError === true) throw contractError('tool returned an error');
  if (object.structuredContent) return object.structuredContent;
  if ('candidates' in object || 'sourceRecordId' in object) return object;
  if (typeof object.returnDisplay === 'string') return parseJson(object.returnDisplay);
  if (typeof object.text === 'string') return parseJson(object.text);
  if (Array.isArray(object.content) && object.content.length === 1) {
    const content = object.content[0];
    if (
      content &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      typeof (content as Record<string, unknown>).text === 'string'
    ) {
      return parseJson((content as Record<string, unknown>).text as string);
    }
  }
  return raw;
}

function optionalString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maxLength)
    throw contractError(`${label} is invalid`);
  return value;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  const result = optionalString(value, label, maxLength)?.trim();
  if (!result) throw contractError(`${label} is required`);
  return result;
}

function evidence(value: unknown): RecruitmentCandidateEvidenceInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100)
    throw contractError('candidate evidence is invalid');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw contractError('candidate evidence item is invalid');
    const record = item as Record<string, unknown>;
    return {
      field: requiredString(record.field, 'candidate evidence field', 100),
      value: requiredString(record.value, 'candidate evidence value', 4_000),
      ...(optionalString(record.observedAt, 'candidate evidence observedAt', 80)
        ? { observedAt: record.observedAt as string }
        : {}),
    };
  });
}

function candidate(value: unknown): RecruitmentCandidateHit {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw contractError('candidate is invalid');
  const record = value as Record<string, unknown>;
  if (
    record.identityKeys !== undefined &&
    (!Array.isArray(record.identityKeys) ||
      record.identityKeys.length > 20 ||
      record.identityKeys.some(
        (key) => typeof key !== 'string' || key.length > 100,
      ))
  ) {
    throw contractError('candidate identityKeys are invalid');
  }
  return {
    sourceRecordId: requiredString(
      record.sourceRecordId,
      'candidate sourceRecordId',
      500,
    ),
    displayName: requiredString(record.displayName, 'candidate displayName', 200),
    headline: optionalString(record.headline, 'candidate headline', 500),
    location: optionalString(record.location, 'candidate location', 500),
    profileUrl: optionalString(record.profileUrl, 'candidate profileUrl', 2_000),
    identityKeys: record.identityKeys as string[] | undefined,
    evidence: evidence(record.evidence),
  };
}

function parseSearchResult(raw: unknown): RecruitmentSourceSearchResult {
  const unwrapped = unwrapOutput(raw);
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped))
    throw contractError('search result must be an object');
  const record = unwrapped as Record<string, unknown>;
  if (!Array.isArray(record.candidates))
    throw contractError('candidates must be an array');
  if (record.candidates.length > 200)
    throw contractError('too many candidates');
  const nextCursor = optionalString(record.nextCursor, 'nextCursor', 4_000)?.trim();
  return {
    candidates: record.candidates.map(candidate),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export function createMcpRecruitmentSourceAdapter(input: {
  sourceId: string;
  label: string;
  serverName: string;
  trusted: boolean;
  tools: readonly RecruitmentMcpToolDescriptor[];
  invoke: RecruitmentMcpInvoker;
}): RecruitmentSourceAdapter {
  if (!input.trusted) throw new Error('recruitment MCP server must be trusted');
  const tools = new Map<string, RecruitmentMcpToolDescriptor>();
  for (const tool of input.tools) {
    if (!TOOL_NAME.test(tool.name) || !TOOL_NAME.test(tool.serverToolName))
      throw new Error('recruitment MCP tool name is invalid');
    if (tools.has(tool.serverToolName))
      throw new Error('recruitment MCP tool is duplicated');
    tools.set(tool.serverToolName, tool);
  }
  for (const required of ['search_candidates', 'get_candidate']) {
    if (!tools.has(required)) throw new Error(`recruitment MCP requires ${required}`);
  }
  const capabilities = [...tools.keys()].filter(
    (name): name is RecruitmentSourceCapability =>
      CAPABILITIES.has(name as RecruitmentSourceCapability),
  );
  const searchTool = tools.get('search_candidates')!;
  const detailTool = tools.get('get_candidate')!;
  return {
    id: input.sourceId,
    label: input.label,
    capabilities,
    async getCandidate(detailInput, context) {
      const raw = await input.invoke({
        serverName: input.serverName, toolName: detailTool.name,
        arguments: {
          organizationId: detailInput.organizationId, requisitionId: detailInput.requisitionId,
          sourceRecordId: detailInput.sourceRecordId,
        }, signal: context.signal,
      });
      return normalizeRecruitmentMaterial(unwrapOutput(raw), detailInput.sourceRecordId);
    },
    async search(searchInput, context) {
      const raw = await input.invoke({
        serverName: input.serverName,
        toolName: searchTool.name,
        arguments: {
          organizationId: searchInput.organizationId,
          requisitionId: searchInput.requisitionId,
          query: searchInput.query,
          ...(searchInput.cursor ? { cursor: searchInput.cursor } : {}),
          limit: searchInput.limit,
        },
        signal: context.signal,
      });
      return parseSearchResult(raw);
    },
  };
}
