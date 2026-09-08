/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { Type, type FunctionDeclaration } from '@google/genai';
import path from 'node:path';
import { statSync, realpathSync } from 'node:fs';
import { passedTestCases } from './testCaseEvidence.js';
import { WorkspacePathIdentity } from './workspacePathIdentity.js';
import { inspectTestSemantics, type TestSemanticReview } from './semanticAcceptance.js';
import {
  auditTaskCoverage,
  extractTaskRequirements,
} from './taskRequirements.js';
import {
  ToolCallStatus,
  type ToolCall,
  type TurnVerificationCheck,
  type AgentArtifactReference,
} from './protocol.js';
import { readVersionedFile, sameFileVersion, type FileVersion } from './artifactEvidence.js';
import {
  hasSuccessfulProcessReceipt,
  verificationKind,
  verificationScopeId,
} from './verificationEvidence.js';

export interface TaskAcceptance {
  id: string;
  description: string;
  kind: 'process' | 'observation' | 'manual' | 'constraint' | 'artifact';
  artifactPath?: string;
  inputFiles?: string[];
  command?: string;
  directory?: string;
  toolName?: string;
  requirementQuote?: string;
  testCase?: {
    name: string;
    scenario: 'normal' | 'error' | 'boundary';
    expectedOutcome?: 'must_happen' | 'must_not_happen';
  };
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
  revisions?: Array<{
    revision: number;
    reason: string;
    replacements?: ExecutionReplacement[];
  }>;
}
interface ExecutionReplacement {
  objectiveId: string;
  criterionId: string;
  fromCommand: string;
  toCommand: string;
  directory: string;
  originalToolCallId: string;
  replacementToolCallId: string;
}

const NAME = 'update_task_plan';
export const TASK_PLAN_TOOL_NAME = NAME;
const string = { type: Type.STRING };
export const TASK_PLAN_DECLARATION: FunctionDeclaration = {
  name: NAME,
  description:
    'Create/update the internal task contract. Cite the actual request in sourceQuote. Bind each acceptance condition to one exact requirementQuote; table rows include their module and conditions. Treat prohibitions, preservation rules, scope limits and preconditions as first-class requirements. Behavioral changes and constraints require a named testCase with scenario normal/error/boundary, or manual judgment. A prohibition must use expectedOutcome=must_not_happen; other requirements use must_happen. Declare each output before generation with kind=artifact and an absolute artifactPath; bind its producing tool receipt. Pair it with a named content test using inputFiles containing that artifactPath. Native format inspection is not proof of content or visual quality. Research acceptance must retain retrievable sources beside the conclusions they support. Plan normal, error and boundary cases where applicable. Different requirements need distinct cases; a shared passing command is not coverage. Run with TAP or Vitest/Jest JSON output so cases can be checked natively; unknown/truncated reports cannot pass named acceptance. Add stronger conditions or dependency edges with revisionReason; existing acceptance must not be removed or weakened. A broken runner can be replaced only with native receipts and the same case/scope; a successful unreadable report permits a reporter-format-only change. Supply the new successful receipt and a revisionReason before changing the command. Update evidence after tools return. This does not execute tools, grant permission or assert semantic quality. Never expose this internal state as UI labels.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      revisionReason: string,
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
                  requirementQuote: string,
                  kind: {
                    type: Type.STRING,
                    enum: ['process', 'observation', 'manual', 'constraint', 'artifact'],
                  },
                  artifactPath: string,
                  inputFiles: { type: Type.ARRAY, items: string, description: 'Declare both changed business inputs and the actual .test/.spec JS/TS source before running the check. Named test source must contain executable assertions. Empty, skipped, constant or unreachable assertions cannot pass delivery review; unsupported test syntax remains unreviewed, not passed.' },
                  command: string,
                  directory: string,
                  toolName: string,
                  testCase: {
                    type: Type.OBJECT,
                    properties: {
                      name: string,
                      scenario: {
                        type: Type.STRING,
                        enum: ['normal', 'error', 'boundary'],
                      },
                      expectedOutcome: {
                        type: Type.STRING,
                        enum: ['must_happen', 'must_not_happen'],
                      },
                    },
                    required: ['name', 'scenario'],
                  },
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

/** Reporter format may change; executable, selectors, cwd and all other flags may not. */
function commandWithoutReporter(command: string): string | undefined {
  const argv = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/gu) ?? [];
  const scope: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const match = argv[i].match(/^--(?:test-)?reporter(?:=(.*))?$/u);
    if (!match) {
      scope.push(argv[i]);
      continue;
    }
    const value = match[1] ?? argv[++i];
    if (!value || !/^(?:tap|json|dot|spec|default|verbose)$/u.test(value))
      return;
  }
  if (scope.at(-1) === '--') scope.pop();
  return JSON.stringify(scope);
}

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
function parseExpectedOutcome(
  value: unknown,
): NonNullable<NonNullable<TaskAcceptance['testCase']>['expectedOutcome']> {
  if (value === undefined) return 'must_happen';
  if (value === 'must_happen' || value === 'must_not_happen') return value;
  throw new Error('Invalid expected test outcome');
}
function parseTestCase(
  value: unknown,
): NonNullable<TaskAcceptance['testCase']> {
  const item = record(value);
  if (!['normal', 'error', 'boundary'].includes(String(item.scenario)))
    throw new Error('Invalid test scenario');
  return {
    name: text(item.name),
    scenario: item.scenario as 'normal' | 'error' | 'boundary',
    expectedOutcome: parseExpectedOutcome(item.expectedOutcome),
  };
}
interface NativeFileIdentity {
  path: string;
  fileId: string;
}
/** Native-only checkpoint. Never accepted by update_task_plan. Raw tool output,
 * write contents, credentials and confirmation permissions are not serialized. */
export interface TaskNativeEvidenceSnapshot {
  version: 1;
  mutationRevision: number;
  observations: Array<{ tool: ToolCall; revision: number; inputs: Array<[string, FileVersion | null]>; passedCases: string[] }>;
}
function nativeFilePath(tool: ToolCall, workspacePath?: string): NativeFileIdentity | undefined {
  // Never probe filesystem metadata for denied, pending or failed operations.
  if (tool.status !== ToolCallStatus.Success || tool.result?.success !== true)
    return;
  if (!['read_file', 'write_file', 'replace'].includes(tool.toolName)) return;
  const value =
    tool.parameters.file_path ??
    tool.parameters.path ??
    tool.parameters.absolute_path;
  if (typeof value !== 'string') return;
  const absolute = path.isAbsolute(value) ? value : workspacePath ? path.resolve(workspacePath, value) : undefined;
  if (!absolute) return;
  try {
    // Follow links and compare native file identity, not lexical paths: aliases
    // and hardlinks can name the same file. Unknown identities invalidate all.
    const stats = statSync(absolute, { bigint: true });
    const realPath = realpathSync(absolute);
    if (stats.isFile() && stats.ino !== 0n)
      return {
        path: process.platform === 'win32' ? realPath.toLowerCase() : realPath,
        fileId: `${stats.dev}:${stats.ino}`,
      };
  } catch {
    /* unavailable/deleted/remote paths cannot establish independence */
  }
  // Relative paths or unknown tool implementations are not enough to prove
  // independence. No model-supplied affectedPaths are trusted here.
  return;
}

/** Model proposes meanings; native receipts decide whether the proposed checks ran.
 * This is coverage of a reviewed contract, NOT an independent semantic quality judge. */
export class TaskContractLedger {
  private readonly workspaceIdentity?: WorkspacePathIdentity;
  private semanticCache = new Map<string, TestSemanticReview>();
  private semanticInputs(criterion: TaskAcceptance) {
    // Inspect native-observed verification inputs only, not model-provided paths.
    const bound = new Set(this.objectives.flatMap(o => o.evidence.filter(e => e.criterionId === criterion.id && o.criteria.includes(criterion)).map(e => e.toolCallId)));
    const files = [...new Set([...bound].flatMap(id => [...(this.observations.get(id)?.inputs.keys() ?? [])]))]
      .filter(file => /(?:^|[\\/])[^\\/]+\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(file));
    if (files.length > 64) return []; // no silently truncated passing coverage
    const unique = new Set<string>();
    return files.flatMap(file => {
        const observed = readVersionedFile(file);
        if (!observed || observed.bytes.length > 256000) return [];
        if (this.workspacePath) {
          const root = this.workspaceIdentity?.currentPath();
          if (!root) return [];
          const relative = path.relative(root, observed.version.path);
          if (relative.startsWith('..') || path.isAbsolute(relative)) return [];
        }
        if (unique.has(observed.version.fileId)) return [];
        unique.add(observed.version.fileId);
        return [{ ...observed, key: `${observed.version.path}:${observed.version.sha256}:${criterion.testCase?.name}` }];
      });
  }
  async prepareSemanticReview(): Promise<void> {
    this.semanticCache.clear();
    let remaining = 64;
    for (const criterion of this.objectives.flatMap(o => o.criteria).filter(c => c.kind === 'process' && c.testCase)) {
      for (const input of this.semanticInputs(criterion)) {
        if (--remaining < 0) return; // unreviewed cases remain not_run
        this.semanticCache.set(input.key, await inspectTestSemantics(input.bytes.toString('utf8'), criterion.testCase!.name));
      }
    }
  }
  semanticChecks(): TurnVerificationCheck[] {
    return this.objectives.flatMap(o => o.criteria.filter(c => c.kind === 'process' && c.testCase).map(c => {
      const inputs = this.semanticInputs(c);
      const reviews = inputs.map(input => this.semanticCache.get(input.key));
      const accepted = reviews.filter(r => r?.status === 'passed');
      return { id: `semantic:${o.id}:${c.id}`, label: accepted.length === 1
        ? '具名测试包含动态断言（结构审查，不代表业务语义充分）'
        : `${c.testCase!.name}：${reviews.find(r => r?.status !== 'passed')?.reason ?? '缺少当前版本可审查的用例源码；先读取测试文件，并将它与业务文件列入验收 inputFiles，再执行测试'}`,
        status: accepted.length === 1 && !reviews.some(r => r?.status === 'failed') ? 'passed' as const : 'not_run' as const,
        evidence: inputs.flatMap((input, i) => reviews[i]?.status === 'passed' ? [`${input.version.path}#${input.version.sha256}`, ...reviews[i]!.assertionRanges.map(r => `UTF16:${r.join(':')}`)] : []),
      };
    }));
  }
  nativeCheckpoint(): TaskNativeEvidenceSnapshot {
    const bound = new Set(this.objectives.flatMap(o => o.evidence.map(e => e.toolCallId)));
    const artifactCalls = new Set(this.nativeArtifacts.map(a => a.verification?.toolCallId));
    const observations: TaskNativeEvidenceSnapshot['observations'] = [];
    for (const [id, entry] of this.observations) {
      if (!bound.has(id) || entry.tool.status !== ToolCallStatus.Success || entry.tool.result?.success !== true) continue;
      const process = entry.tool.result.process;
      if (!artifactCalls.has(id) && !(process && hasSuccessfulProcessReceipt(entry.tool) && entry.inputs.size > 0)) continue;
      if (entry.inputs.size > 256 || entry.passedCases.size > 1024) continue; // omitted evidence must be rerun
      observations.push({ revision: entry.revision, inputs: [...entry.inputs].map(([p, v]) => [p, v ?? null]), passedCases: [...entry.passedCases],
        tool: { id, toolName: entry.tool.toolName, status: ToolCallStatus.Success,
          parameters: process ? { command: process.command, directory: process.directory } : {},
          result: { success: true, toolName: entry.tool.toolName, executionTime: 0, ...(process ? { process: structuredClone(process) } : {}) } } });
    }
    return { version: 1, mutationRevision: this.mutationRevision, observations: observations.slice(-256) };
  }
  restoreNativeCheckpoint(snapshot: TaskNativeEvidenceSnapshot): void {
    if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.mutationRevision) || snapshot.mutationRevision < 0 ||
      !Array.isArray(snapshot.observations) || snapshot.observations.length > 256) throw new Error('Invalid native evidence checkpoint');
    this.mutationRevision = snapshot.mutationRevision;
    for (const item of snapshot.observations) {
      if (!item || !item.tool || typeof item.tool.id !== 'string' || typeof item.tool.toolName !== 'string' || item.tool.result?.success !== true ||
        item.tool.status !== ToolCallStatus.Success || !Number.isSafeInteger(item.revision) || item.revision < 0 || item.revision > snapshot.mutationRevision ||
        !Array.isArray(item.inputs) || item.inputs.length > 256 || !Array.isArray(item.passedCases) || item.passedCases.length > 1024 ||
        item.passedCases.some(c => typeof c !== 'string' || c.length > 4096)) throw new Error('Invalid native observation');
      const inputs = new Map<string, FileVersion | undefined>();
      for (const pair of item.inputs) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || pair[0].length > 4096) throw new Error('Invalid native input identity');
        const [file, version] = pair;
        if (!version || !sameFileVersion(version, readVersionedFile(file)?.version)) continue;
        inputs.set(file, version);
      }
      // Missing/stale input => do not restore a passing test, even if exit code was zero.
      if (item.tool.result.process && (!item.inputs.length || inputs.size !== item.inputs.length || !hasSuccessfulProcessReceipt(item.tool))) continue;
      this.observations.set(item.tool.id, { tool: structuredClone(item.tool), revision: item.revision, inputs, passedCases: new Set(item.passedCases) });
      for (const value of inputs.values()) if (value) this.knownFiles.add(value.path);
    }
  }
  boundNativeTools(): ToolCall[] {
    const ids = new Set(this.objectives.flatMap(o => o.evidence.map(e => e.toolCallId)));
    return [...this.observations].filter(([id]) => ids.has(id)).map(([, e]) => structuredClone(e.tool));
  }
  private revision = 0;
  private objectives: TaskObjective[] = [];
  private mutationRevision = 0;
  private observations = new Map<
    string,
    {
      tool: ToolCall;
      revision: number;
      file?: NativeFileIdentity;
      passedCases: Set<string>;
      inputs: Map<string, FileVersion | undefined>;
    }
  >();
  private writes = new Map<string, ToolCallStatus>();
  private knownFiles = new Set<string>();
  private nativeArtifacts: AgentArtifactReference[] = [];
  setNativeArtifacts(artifacts: readonly AgentArtifactReference[]): void {
    this.nativeArtifacts = structuredClone([...artifacts]);
  }
  observedInputPaths(toolCallId: string): string[] {
    return [...(this.observations.get(toolCallId)?.inputs.values() ?? [])].filter((v): v is FileVersion => !!v).map(v => v.path);
  }
  declaredArtifactPaths(): string[] { return this.objectives.flatMap(o => o.criteria.flatMap(c => c.artifactPath ? [c.artifactPath] : [])); }
  private mutations: Array<{
    revision: number;
    path?: NativeFileIdentity;
    toolId: string;
  }> = [];
  private revisions: NonNullable<TaskContractSnapshot['revisions']> = [];
  // Only native decisions made in this process suppress failed runner scopes.
  // Restored audit records never restore permission or execution evidence.
  private executionReplacements: ExecutionReplacement[] = [];
  private requirementInventory?: ReturnType<typeof extractTaskRequirements>;

  constructor(
    private readonly request: string,
    snapshot?: TaskContractSnapshot,
    private readonly workspacePath?: string,
  ) {
    this.workspaceIdentity = workspacePath ? new WorkspacePathIdentity(workspacePath) : undefined;
    if (snapshot) {
      if (
        snapshot.version !== 1 ||
        !Number.isSafeInteger(snapshot.revision) ||
        snapshot.revision < 1
      )
        throw new Error('Invalid task contract snapshot');
      this.update({ expectedRevision: 0, objectives: snapshot.objectives });
      this.revision = snapshot.revision;
      if (snapshot.revisions) {
        let previous = 0;
        this.revisions = list(snapshot.revisions, 32).map((raw) => {
          const entry = record(raw);
          if (
            !Number.isSafeInteger(entry.revision) ||
            Number(entry.revision) <= previous ||
            Number(entry.revision) > snapshot.revision
          )
            throw new Error('Invalid task revision history');
          previous = Number(entry.revision);
          return {
            revision: previous,
            reason: text(entry.reason),
            ...(entry.replacements
              ? {
                  replacements: list(entry.replacements, 128).map((raw) => {
                    const replacement = record(raw);
                    return {
                      objectiveId: planId(replacement.objectiveId),
                      criterionId: planId(replacement.criterionId),
                      fromCommand: text(replacement.fromCommand, 2000),
                      toCommand: text(replacement.toCommand, 2000),
                      directory: text(replacement.directory, 1000),
                      originalToolCallId: id(replacement.originalToolCallId),
                      replacementToolCallId: id(
                        replacement.replacementToolCallId,
                      ),
                    };
                  }),
                }
              : {}),
          };
        });
      }
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
          if (kind !== 'process' && kind !== 'observation' && kind !== 'manual' && kind !== 'constraint' && kind !== 'artifact')
            throw new Error('Invalid acceptance kind');
          return {
            id: planId(criterion.id),
            description: text(criterion.description),
            kind,
            ...(kind === 'artifact' ? { artifactPath: text(criterion.artifactPath, 1000) } : {}),
            ...(criterion.requirementQuote !== undefined
              ? { requirementQuote: text(criterion.requirementQuote, 1600) }
              : {}),
            ...(kind === 'process'
              ? {
                  command: text(criterion.command, 2000),
                  directory: text(criterion.directory, 1000),
                  ...(criterion.inputFiles !== undefined ? { inputFiles: list(criterion.inputFiles, 32).map(p => text(p, 1000)) } : {}),
                  ...(criterion.testCase !== undefined
                    ? { testCase: parseTestCase(criterion.testCase) }
                    : {}),
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
      for (const criterion of criteria) {
        if (
          criterion.requirementQuote &&
          (!sourceQuote.includes(criterion.requirementQuote) ||
            !this.requirements().some(
              (r) => r.quote === criterion.requirementQuote,
            ))
        )
          throw new Error(
            'Acceptance must bind an exact native requirement quote within its objective',
          );
      }
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
        return match ? [match[1].trim()] : [];
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
    const replacements: ExecutionReplacement[] = [];
    for (const previous of this.objectives) {
      const next = objectives.find((o) => o.id === previous.id);
      if (
        !next ||
        next.sourceQuote !== previous.sourceQuote ||
        next.description !== previous.description ||
        previous.criteria.some((criterion) => {
          const replacement = next.criteria.find((c) => c.id === criterion.id);
          if (!replacement) return true;
          // Adding an explicit binding tightens a legacy unbound criterion.
          const {
            requirementQuote: oldBinding,
            testCase: oldCase,
            ...oldDefinition
          } = criterion;
          const {
            requirementQuote: newBinding,
            testCase: newCase,
            ...newDefinition
          } = replacement;
          if (
            oldDefinition.command !== newDefinition.command &&
            JSON.stringify({
              ...oldDefinition,
              command: newDefinition.command,
            }) === JSON.stringify(newDefinition) &&
            oldBinding === newBinding &&
            oldCase &&
            JSON.stringify(oldCase) === JSON.stringify(newCase)
          ) {
            text(data.revisionReason);
            const validated = this.validateExecutionReplacement(
              previous.id,
              criterion,
              replacement,
            );
            if (validated) {
              replacements.push(validated);
              return false;
            }
          }
          return (
            JSON.stringify(oldDefinition) !== JSON.stringify(newDefinition) ||
            Boolean(oldBinding && oldBinding !== newBinding) ||
            Boolean(
              oldCase && JSON.stringify(oldCase) !== JSON.stringify(newCase),
            )
          );
        })
      )
        throw new Error(
          'Existing objectives and acceptance cannot be removed or weakened',
        );
      const changedDependencies =
        JSON.stringify(next.dependsOn) !== JSON.stringify(previous.dependsOn);
      if (changedDependencies) {
        text(data.revisionReason);
        // Only completed prerequisites may be detached. Their goals/checks
        // remain mandatory at delivery, so reordering cannot erase acceptance.
        const checks = this.checks();
        const satisfied = (
          dependency: string,
          visiting = new Set<string>(),
        ): boolean => {
          if (visiting.has(dependency)) return false;
          visiting.add(dependency);
          const node = this.objectives.find((o) => o.id === dependency);
          return Boolean(
            node &&
            node.criteria.every((c) =>
              checks.some(
                (check) =>
                  check.id === `objective:${node.id}:${c.id}` &&
                  check.status === 'passed',
              ),
            ) &&
            node.dependsOn.every((id) => satisfied(id, new Set(visiting))),
          );
        };
        if (
          previous.dependsOn.some(
            (id) => !next.dependsOn.includes(id) && !satisfied(id),
          )
        )
          throw new Error('Cannot detach an unfinished prerequisite');
      }
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
    const reason =
      data.revisionReason === undefined
        ? 'acceptance/evidence update'
        : text(data.revisionReason);
    this.objectives = objectives;
    this.executionReplacements.push(...replacements);
    this.revision++;
    this.revisions = [
      ...this.revisions,
      {
        revision: this.revision,
        reason,
        ...(replacements.length ? { replacements } : {}),
      },
    ].slice(-32);
    return this.snapshot();
  }

  private validateExecutionReplacement(
    objectiveId: string,
    previous: TaskAcceptance,
    next: TaskAcceptance,
  ): ExecutionReplacement | undefined {
    if (
      previous.kind !== 'process' ||
      !previous.testCase ||
      !previous.command ||
      !next.command ||
      !previous.directory
    )
      return;
    const latest = (command: string) =>
      [...this.observations.values()]
        .reverse()
        .find(
          ({ tool }) =>
            tool.toolName === 'run_shell_command' &&
            tool.parameters.command === command &&
            (tool.result?.process?.directory ?? tool.parameters.directory) ===
              previous.directory,
        );
    const failed = latest(previous.command);
    const replacement = latest(next.command);
    if (
      !failed ||
      !replacement ||
      replacement.revision !== this.mutationRevision
    )
      return;
    const receipt = failed.tool.result?.process;
    const diagnostic =
      String(failed.tool.result?.error ?? '') +
      '\n' +
      String(failed.tool.result?.data ?? '');
    const brokenHarness =
      receipt &&
      receipt.status === 'exited' &&
      !receipt.signal &&
      receipt.exitCode !== null &&
      receipt.exitCode !== 0 &&
      /(?:missing script|command not found|is not recognized|unknown option|cannot find module|no test files found)/iu.test(
        diagnostic,
      ) &&
      !/(?:AssertionError|assertion failed|FAIL\s|not ok \d)/iu.test(
        diagnostic,
      );
    const oldScope = commandWithoutReporter(previous.command);
    const reportOnly =
      hasSuccessfulProcessReceipt(failed.tool) &&
      Boolean(verificationKind(failed.tool)) &&
      !failed.passedCases.has(previous.testCase.name) &&
      oldScope !== undefined &&
      oldScope === commandWithoutReporter(next.command);
    // A broken harness or formatting-only change; never a failed assertion.
    if (
      !receipt ||
      receipt.command !== previous.command ||
      receipt.status !== 'exited' ||
      receipt.signal ||
      (!brokenHarness && !reportOnly) ||
      !verificationKind(replacement.tool) ||
      !hasSuccessfulProcessReceipt(replacement.tool) ||
      !replacement.passedCases.has(previous.testCase.name)
    )
      return;
    return {
      objectiveId,
      criterionId: previous.id,
      fromCommand: previous.command,
      toCommand: next.command,
      directory: previous.directory,
      originalToolCallId: failed.tool.id,
      replacementToolCallId: replacement.tool.id,
    };
  }

  private currentExecutionReplacements(): ExecutionReplacement[] {
    const checks = this.checks();
    return this.executionReplacements.filter(
      (entry) =>
        checks.some(
          (c) => c.id === `objective:${entry.objectiveId}:${entry.criterionId}` && c.status === 'passed',
        ) &&
        [...this.observations.values()].reverse().find(
          ({ tool }) => tool.toolName === 'run_shell_command' &&
            tool.parameters.command === entry.fromCommand &&
            (tool.result?.process?.directory ?? tool.parameters.directory) === entry.directory,
        )?.tool.id === entry.originalToolCallId,
    );
  }

  supersededVerificationScopes(): Set<string> {
    return new Set(
      this.currentExecutionReplacements().map(entry => verificationScopeId(entry.fromCommand, entry.directory)),
    );
  }

  /** Native-approved equivalent runners only, with current source/receipt and
   * semantic lower-bound checks. Restored audit history is not in this list. */
  resolvedExecutionReplacements(): ExecutionReplacement[] {
    const current = this.currentExecutionReplacements();
    const semantics = this.semanticChecks();
    return current.filter(entry => {
      const group = this.executionReplacements.filter(
        other => other.originalToolCallId === entry.originalToolCallId,
      );
      return group.every(other =>
        current.includes(other) &&
        semantics.some(check => check.id === `semantic:${other.objectiveId}:${other.criterionId}` && check.status === 'passed') &&
        this.objectives.some(objective =>
          objective.id === other.objectiveId && objective.evidence.some(
            e => e.criterionId === other.criterionId && e.toolCallId === other.replacementToolCallId,
          ),
        ),
      );
    }).map(entry => ({ ...entry }));
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
    const previous = this.observations.get(tool.id);
    if (mutating && this.writes.get(tool.id) !== tool.status) {
      this.writes.set(tool.id, tool.status);
      this.mutationRevision++;
      this.mutations.push({
        revision: this.mutationRevision,
        path: nativeFilePath(tool, this.workspacePath),
        toolId: tool.id,
      });
    }
    if (mutating && tool.status === ToolCallStatus.Success) {
      const mutation = this.mutations.find((entry) => entry.toolId === tool.id);
      if (mutation) mutation.path = nativeFilePath(tool, this.workspacePath);
    }
    const file = nativeFilePath(tool, this.workspacePath);
    if (file) this.knownFiles.add(file.path);
    const inputs = previous?.inputs ?? new Map<string, FileVersion | undefined>();
    if (file && !verificationKind(tool) && !inputs.has(file.path)) inputs.set(file.path, readVersionedFile(file.path)?.version);
    if (!previous && verificationKind(tool)) {
      const declared = this.objectives.flatMap(o => o.criteria.filter(c => c.kind === 'process' && c.command === tool.parameters.command && c.directory === (tool.result?.process?.directory ?? tool.parameters.directory ?? this.workspacePath)).flatMap(c => c.inputFiles ?? []));
      for (const input of new Set([...this.knownFiles, ...declared])) inputs.set(input, readVersionedFile(input)?.version);
    }
    this.observations.set(tool.id, {
      tool: structuredClone({ ...tool, confirmationDetails: undefined }),
      revision: previous?.revision ?? this.mutationRevision,
      file: previous?.file ?? nativeFilePath(tool, this.workspacePath),
      inputs,
      passedCases: new Set(
        verificationKind(tool) && hasSuccessfulProcessReceipt(tool)
          ? passedTestCases(tool.result?.data)
          : [],
      ),
    });
  }

  checks(): TurnVerificationCheck[] {
    return this.objectives.flatMap((objective) =>
      objective.criteria.map((criterion) => {
        if (criterion.kind === 'constraint' || criterion.kind === 'manual') {
          const requirement = this.requirements().find(r => r.quote === (criterion.requirementQuote ?? objective.sourceQuote));
          const native = requirement && (criterion.kind !== 'manual' || requirement.kind === 'manual')
            ? this.nativeConstraintChecks.get(`constraint:${requirement.id}`) : undefined;
          return { id: `objective:${objective.id}:${criterion.id}`, label: `${objective.description}：${criterion.description}`,
            status: native?.status ?? 'not_run', evidence: native?.evidence ?? [] };
        }
        const accepted = objective.evidence.filter((entry) => {
          if (entry.criterionId !== criterion.id)
            return false;
          const observed = this.observations.get(entry.toolCallId);
          if (!observed) return false;
          if (criterion.kind === 'artifact') {
            if (observed.tool.status !== ToolCallStatus.Success || observed.tool.result?.success !== true || observed.tool.result.error) return false;
            const expected = readVersionedFile(criterion.artifactPath ?? '')?.version;
            return this.nativeArtifacts.some(a => a.verified && a.verification?.provenance === 'created_or_changed' && a.verification?.toolCallId === entry.toolCallId && sameFileVersion(a.verification?.version, expected));
          }
          if (observed.revision !== this.mutationRevision) {
            const source =
              criterion.kind === 'observation' &&
              observed.tool.toolName === 'read_file'
                ? observed.file
                : undefined;
            if (
              !source ||
              this.mutations.some(
                (mutation) =>
                  mutation.revision > observed.revision &&
                  (!mutation.path ||
                    mutation.path.path === source.path ||
                    mutation.path.fileId === source.fileId),
              )
            )
              return false;
          }
          const tool = observed.tool;
          if (
            tool.status !== ToolCallStatus.Success ||
            tool.result?.success !== true ||
            tool.result.error
          )
            return false;
          if (criterion.kind === 'process') {
            if ((criterion.inputFiles ?? []).some(p => ![...observed.inputs.values()].some(version => sameFileVersion(version, readVersionedFile(p)?.version))) ||
              [...observed.inputs].some(([p, version]) => !sameFileVersion(version, readVersionedFile(p)?.version))) return false;
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
              tool.result.process?.directory === criterion.directory &&
              (!criterion.testCase ||
                observed.passedCases.has(criterion.testCase.name))
            );
          }
          // A quote proves a source observation exists, not that its conclusions are correct.
          if (observed.file && !sameFileVersion(observed.inputs.get(observed.file.path), readVersionedFile(observed.file.path)?.version)) return false;
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
          receiptBinding: {
            requirementId: this.requirements().find(r => r.quote === (criterion.requirementQuote ?? objective.sourceQuote))?.id,
            contractRevision: this.revision,
            mutationRevision: this.mutationRevision,
            toolCallIds: accepted.map(e => e.toolCallId),
            inputVersions: [...new Map(accepted.flatMap(e => [...(this.observations.get(e.toolCallId)?.inputs.values() ?? [])].filter((v): v is FileVersion => !!v)).map(v => [v.path, v])).values()],
          },
        };
      }),
    );
  }

  snapshot(): TaskContractSnapshot {
    return structuredClone({
      version: 1,
      revision: this.revision,
      objectives: this.objectives,
      revisions: this.revisions,
    });
  }

  directive(): string {
    const checks = this.checks();
    return JSON.stringify({
      revision: this.revision,
      // Control metadata contains positions, never duplicates of raw user text.
      // Full quotes are available in the original request and the plan response.
      requirements: this.requirements()
        .slice(0, 48)
        .map((r) => ({
          id: r.id,
          start: this.request.indexOf(r.quote),
          length: r.quote.length,
          behavioral: r.behavioral,
          kind: r.kind,
          expectedOutcome: r.expectedOutcome,
          scenarios: r.scenarios,
        })),
      uncovered: this.coverageChecks()
        .filter((c) => c.status !== 'passed')
        .map((c) => c.id),
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

  requirements() {
    this.requirementInventory ??= extractTaskRequirements(this.request);
    return structuredClone(this.requirementInventory);
  }

  /** Rebase definitions against native current text; keep native observations only in this process. */
  rebase(request: string): TaskContractLedger {
    const next = new TaskContractLedger(request, undefined, this.workspacePath);
    const retained = this.objectives.filter(o => request.includes(o.sourceQuote));
    if (retained.length) {
      const ids = new Set(retained.map(o => o.id));
      next.update({ expectedRevision: 0, objectives: retained.map(o => ({ ...o, dependsOn: o.dependsOn.filter(id => ids.has(id)) })) });
    }
    next.observations = new Map(this.observations);
    next.mutationRevision = this.mutationRevision;
    next.mutations = [...this.mutations];
    next.writes = new Map(this.writes);
    next.knownFiles = new Set(this.knownFiles);
    next.nativeArtifacts = structuredClone(this.nativeArtifacts);
    return next;
  }

  coverageChecks(): TurnVerificationCheck[] {
    return this.objectives.length
      ? [...auditTaskCoverage(this.requirements(), this.objectives), ...this.artifactCoverageChecks()]
      : [];
  }

  private artifactCoverageChecks(): TurnVerificationCheck[] {
    return this.requirements().filter(r => r.kind === 'behavior' && /生成|创建|制作|导出|\b(?:create|generate|export)\b/iu.test(r.quote)).flatMap(r => {
      const named = [...r.quote.matchAll(/`([^`]+\.(?:pptx|pdf|docx|xlsx|json|csv|md|txt|zip))`/giu)].map(m => m[1]);
      const extensions = [...new Set([
        ...named.map(p => path.extname(p).toLowerCase()),
        ...[...r.quote.matchAll(/\b(pptx?|pdf|docx?|xlsx?|json|csv|zip)\b/giu)].map(m => `.${({ ppt: 'pptx', doc: 'docx', xls: 'xlsx' } as Record<string, string>)[m[1].toLowerCase()] ?? m[1].toLowerCase()}`),
      ])];
      if (!named.length && !extensions.length && !/文档|报告|表格|幻灯片|图片|图像|文件|压缩包|\b(?:document|report|spreadsheet|slides?|image|file|package)\b/iu.test(r.quote)) return [];
      const bound = this.objectives.flatMap(o => o.criteria.filter(c => (c.requirementQuote ?? o.sourceQuote) === r.quote));
      const artifacts = bound.filter(c => c.kind === 'artifact');
      const targets = [...named, ...extensions.filter(ext => !named.some(file => path.extname(file).toLowerCase() === ext))];
      if (!targets.length) targets.push('*');
      return targets.map((target, index) => {
        const candidates = artifacts.filter(c => !!c.artifactPath && (target === '*' || (target.startsWith('.') ? path.extname(c.artifactPath).toLowerCase() === target :
          path.isAbsolute(target) ? path.resolve(c.artifactPath) === path.resolve(target) : c.artifactPath.replace(/\\/gu, '/').endsWith('/' + target.replace(/\\/gu, '/')))));
        const adequate = candidates.some(c => bound.some(test => test.kind === 'process' && !!test.testCase && test.inputFiles?.includes(c.artifactPath!)));
        return { id: `coverage-artifact:${r.id}:${index}`, label: `产物须逐项绑定当前文件及内容验收：${target === '*' ? r.quote : target}`, status: adequate ? 'passed' as const : 'not_run' as const };
      });
    });
  }

  hasManualChecks(): boolean {
    const checks = this.checks();
    return this.objectives.some(o => o.criteria.some(c => c.kind === 'manual' &&
      checks.find(check => check.id === `objective:${o.id}:${c.id}`)?.status !== 'passed'));
  }

  private nativeConstraintChecks = new Map<string, TurnVerificationCheck>();
  /** Only named, polarity/scenario-bound process receipts; never native/manual
   * claims feeding back into themselves. Unknown or stale receipts stay not_run. */
  semanticConstraintEvidence(): Map<string, TurnVerificationCheck[]> {
    const results = this.checks();
    const coverage = this.coverageChecks();
    return new Map(this.requirements().filter(r => r.kind !== 'behavior').map(r => {
      const bound = r.scenarios.map(scenario => {
        for (const objective of this.objectives) for (const c of objective.criteria) {
          if (c.kind === 'process' && c.requirementQuote === r.quote && c.testCase?.scenario === scenario &&
            (c.testCase.expectedOutcome ?? 'must_happen') === r.expectedOutcome &&
            coverage.find(check => check.id === `coverage:${r.id}`)?.status === 'passed') {
            const check = results.find(item => item.id === `objective:${objective.id}:${c.id}`);
            if (check) return check;
          }
        }
        return { id: `semantic:${r.id}:${scenario}`, label: r.quote, status: 'not_run' as const };
      });
      return [r.id, bound];
    }));
  }
  /** Host evidence only. Never deserialized from update_task_plan or snapshots. */
  setNativeConstraintChecks(checks: TurnVerificationCheck[]): void {
    this.nativeConstraintChecks = new Map(checks.map(c => [c.id, structuredClone(c)]));
  }
}
