/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { Type, type FunctionDeclaration } from '@google/genai';
import {
  ToolCallStatus,
  type ToolCall,
  type TurnVerificationCheck,
} from './protocol.js';
import {
  hasSuccessfulProcessReceipt,
  verificationKind,
} from './verificationEvidence.js';

export interface TaskAcceptance {
  id: string;
  description: string;
  kind: 'process' | 'observation' | 'manual';
  command?: string;
  directory?: string;
  toolName?: string;
}
export interface TaskObjective {
  id: string;
  description: string;
  sourceQuote: string;
  dependsOn: string[];
  criteria: TaskAcceptance[];
  evidence: Array<{ criterionId: string; toolCallId: string; quote?: string }>;
}
export interface TaskContractSnapshot {
  version: 1;
  revision: number;
  objectives: TaskObjective[];
}

const NAME = 'update_task_plan';
export const TASK_PLAN_TOOL_NAME = NAME;
const string = { type: Type.STRING };
export const TASK_PLAN_DECLARATION: FunctionDeclaration = {
  name: NAME,
  description:
    'Create/update the internal, request-specific task contract. Decompose the actual request into objectives with exact sourceQuote and acceptance criteria. For explicitly listed requirements, quote the entire requirement text, not shared keywords. IDs use letters, digits, underscore, dot or hyphen. Call before substantial execution; update evidence after tools return. This does NOT execute tools, grant permissions or confirm success. Existing objectives/criteria cannot be removed or weakened; add subtasks to replan. Use manual for conditions requiring human judgment. The response reports real coverage and revision. Never show this internal state as UI status labels.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      expectedRevision: { type: Type.INTEGER },
      objectives: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: string,
            description: string,
            sourceQuote: string,
            dependsOn: { type: Type.ARRAY, items: string },
            criteria: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: string,
                  description: string,
                  kind: {
                    type: Type.STRING,
                    enum: ['process', 'observation', 'manual'],
                  },
                  command: string,
                  directory: string,
                  toolName: string,
                },
                required: ['id', 'description', 'kind'],
              },
            },
            evidence: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  criterionId: string,
                  toolCallId: string,
                  quote: string,
                },
                required: ['criterionId', 'toolCallId'],
              },
            },
          },
          required: [
            'id',
            'description',
            'sourceQuote',
            'dependsOn',
            'criteria',
            'evidence',
          ],
        },
      },
    },
    required: ['expectedRevision', 'objectives'],
  },
};

function text(value: unknown, max = 500): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) <= 8)
  ) {
    throw new Error('Task plan contains missing or oversized text');
  }
  return value.trim();
}
function id(value: unknown): string {
  const result = text(value, 80);
  if (!/^[a-zA-Z0-9_.:-]+$/u.test(result)) throw new Error('Invalid task id');
  return result;
}
function planId(value: unknown): string {
  const result = id(value);
  if (result.includes(':'))
    throw new Error('Invalid task id: colon is reserved for evidence keys');
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected task object');
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error('Task array exceeds bounds');
  return value;
}
function definition(objective: TaskObjective): string {
  const { evidence: _evidence, ...stable } = objective;
  return JSON.stringify(stable);
}

/** Model proposes meanings; native receipts decide whether the proposed checks ran.
 * This is coverage of a reviewed contract, NOT an independent semantic quality judge. */
export class TaskContractLedger {
  private revision = 0;
  private objectives: TaskObjective[] = [];
  private mutationRevision = 0;
  private observations = new Map<
    string,
    { tool: ToolCall; revision: number }
  >();
  private writes = new Set<string>();

  constructor(
    private readonly request: string,
    snapshot?: TaskContractSnapshot,
  ) {
    if (snapshot) {
      if (
        snapshot.version !== 1 ||
        !Number.isSafeInteger(snapshot.revision) ||
        snapshot.revision < 1
      )
        throw new Error('Invalid task contract snapshot');
      this.update({ expectedRevision: 0, objectives: snapshot.objectives });
      this.revision = snapshot.revision;
    }
  }

  update(input: unknown): TaskContractSnapshot {
    const data = record(input);
    if (data.expectedRevision !== this.revision)
      throw new Error(`Task plan revision conflict; expected ${this.revision}`);
    const objectives = list(data.objectives, 16).map((raw): TaskObjective => {
      const item = record(raw);
      const sourceQuote = text(item.sourceQuote, 800);
      if (!this.request.includes(sourceQuote))
        throw new Error('Objective must cite the actual user request');
      const criteria = list(item.criteria, 8).map(
        (rawCriterion): TaskAcceptance => {
          const criterion = record(rawCriterion);
          const kind = criterion.kind;
          if (kind !== 'process' && kind !== 'observation' && kind !== 'manual')
            throw new Error('Invalid acceptance kind');
          return {
            id: planId(criterion.id),
            description: text(criterion.description),
            kind,
            ...(kind === 'process'
              ? {
                  command: text(criterion.command, 2000),
                  directory: text(criterion.directory, 1000),
                }
              : {}),
            ...(kind === 'observation'
              ? { toolName: id(criterion.toolName) }
              : {}),
          };
        },
      );
      if (
        !criteria.length ||
        new Set(criteria.map((c) => c.id)).size !== criteria.length
      )
        throw new Error('Missing or duplicate acceptance criteria');
      const evidence = list(item.evidence, 32).map((rawEvidence) => {
        const entry = record(rawEvidence);
        const criterionId = planId(entry.criterionId);
        if (!criteria.some((c) => c.id === criterionId))
          throw new Error('Evidence references an unknown criterion');
        return {
          criterionId,
          toolCallId: id(entry.toolCallId),
          ...(entry.quote !== undefined
            ? { quote: text(entry.quote, 1000) }
            : {}),
        };
      });
      return {
        id: planId(item.id),
        description: text(item.description),
        sourceQuote,
        dependsOn: list(item.dependsOn, 16).map(planId),
        criteria,
        evidence,
      };
    });
    if (
      !objectives.length ||
      new Set(objectives.map((o) => o.id)).size !== objectives.length
    )
      throw new Error('Missing or duplicate objectives');
    const explicitRequirements = this.request
      .split(/\r?\n/u)
      .flatMap((line) => {
        const match = line.match(/^\s*(?:\d+[.)、]|[-*])\s+(.+)$/u);
        return match &&
          !/^(?:不要|不得|禁止|do\s+not\b|never\b)/iu.test(match[1])
          ? [match[1].trim()]
          : [];
      });
    if (
      explicitRequirements.some(
        (requirement) =>
          !objectives.some((objective) =>
            objective.sourceQuote.includes(requirement),
          ),
      )
    ) {
      throw new Error('The plan omits an explicitly listed user requirement');
    }
    for (const previous of this.objectives) {
      const next = objectives.find((o) => o.id === previous.id);
      if (!next || definition(next) !== definition(previous))
        throw new Error(
          'Existing objectives and acceptance cannot be removed or weakened',
        );
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): void => {
      if (visiting.has(nodeId)) throw new Error('Task dependency cycle');
      if (visited.has(nodeId)) return;
      const node = objectives.find((o) => o.id === nodeId);
      if (!node) throw new Error('Unknown task dependency');
      visiting.add(nodeId);
      node.dependsOn.forEach(visit);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    objectives.forEach((o) => visit(o.id));
    this.objectives = objectives;
    this.revision++;
    return this.snapshot();
  }

  observe(tool: ToolCall, mutating: boolean): void {
    if (
      tool.toolName === NAME ||
      ['todo_write', 'update_plan'].includes(tool.toolName)
    )
      return;
    if (
      [
        ToolCallStatus.Scheduled,
        ToolCallStatus.Validating,
        ToolCallStatus.WaitingForConfirmation,
      ].includes(tool.status)
    )
      return;
    if (mutating && !this.writes.has(tool.id)) {
      this.writes.add(tool.id);
      this.mutationRevision++;
    }
    const previous = this.observations.get(tool.id);
    this.observations.set(tool.id, {
      tool: structuredClone(tool),
      revision: previous?.revision ?? this.mutationRevision,
    });
  }

  checks(): TurnVerificationCheck[] {
    return this.objectives.flatMap((objective) =>
      objective.criteria.map((criterion) => {
        const accepted = objective.evidence.filter((entry) => {
          if (entry.criterionId !== criterion.id || criterion.kind === 'manual')
            return false;
          const observed = this.observations.get(entry.toolCallId);
          if (!observed || observed.revision !== this.mutationRevision)
            return false;
          const tool = observed.tool;
          if (
            tool.status !== ToolCallStatus.Success ||
            tool.result?.success !== true ||
            tool.result.error
          )
            return false;
          if (criterion.kind === 'process') {
            const latest = [...this.observations.values()]
              .reverse()
              .find(
                (candidate) =>
                  candidate.tool.toolName === 'run_shell_command' &&
                  candidate.tool.parameters.command === criterion.command &&
                  (candidate.tool.result?.process?.directory ??
                    candidate.tool.parameters.directory) ===
                    criterion.directory,
              );
            if (latest?.tool.id !== entry.toolCallId) return false;
            return (
              Boolean(verificationKind(tool)) &&
              hasSuccessfulProcessReceipt(tool) &&
              tool.result.process?.command === criterion.command &&
              tool.result.process?.directory === criterion.directory
            );
          }
          // A quote proves a source observation exists, not that its conclusions are correct.
          const output =
            typeof tool.result.data === 'string'
              ? tool.result.data
              : JSON.stringify(tool.result.data ?? '');
          return (
            tool.toolName === criterion.toolName &&
            Boolean(entry.quote && output.includes(entry.quote))
          );
        });
        return {
          id: `objective:${objective.id}:${criterion.id}`,
          label: `${objective.description}：${criterion.description}`,
          status: accepted.length ? ('passed' as const) : ('not_run' as const),
          evidence: accepted.map((entry) => entry.toolCallId),
        };
      }),
    );
  }

  snapshot(): TaskContractSnapshot {
    return structuredClone({
      version: 1,
      revision: this.revision,
      objectives: this.objectives,
    });
  }

  directive(): string {
    const checks = this.checks();
    return JSON.stringify({
      revision: this.revision,
      objectives: this.objectives.map((o) => {
        const remaining = checks.filter(
          (c) => c.id.startsWith(`objective:${o.id}:`) && c.status !== 'passed',
        );
        return {
          id: o.id,
          description: o.description.slice(0, 100),
          openChecks: remaining.length,
          nextCheck: remaining[0]?.label.slice(0, 100),
        };
      }),
    });
  }
}
