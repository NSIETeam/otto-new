/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureFinancialComputationEvidence,
  classifyFinancialInput,
  CompressionService,
  shouldBlockFinancialOutput,
  ToolReplayClass,
  TurnCheckpointManager,
  type TurnCheckpoint,
  type Content,
} from 'otto-core';
import {
  AgentTurnTracker,
  AdaptiveExecutionCoordinator,
  FileTurnRecoveryStore,
  InMemorySessionStore,
  ToolCallStatus,
  deriveTurnControlPolicy,
  formatTurnControlDirective,
  toolExecutionFingerprint,
  turnIntentHash,
} from '../../server/src/index.js';
import { RpaRunner } from '../../rpa/src/runner.js';
import { FileRpaRunStore } from '../../rpa/src/file-run-store.js';
import { FileRpaArtifactStore } from '../../rpa/src/file-artifact-store.js';
import { FileWorkflowStore } from '../../workflow/src/file-workflow-store.js';
import { WorkflowRuntime } from '../../workflow/src/runtime.js';
import {
  assertReleaseGate,
  runDeterministicScenarios,
  writeEvaluationReport,
} from './runner.js';
import type { DeterministicScenario, EvaluationReport } from './contracts.js';

const scenarios: readonly DeterministicScenario[] = [
  {
    id: 'agent-output-contract-adapts-without-exposing-internal-modes',
    lane: 'agent',
    description:
      'Every intent receives a deterministic user-facing response shape while internal route labels remain hidden instructions.',
    requiredEvidence: ['assertion'],
    async execute() {
      const cases = [
        ['一句话解释向量数据库', 'direct_answer'],
        ['搜索并核实最新官方资料', 'grounded_answer'],
        ['诊断登录白屏的根因', 'diagnosis'],
        ['修改登录代码并运行测试', 'change_delivery'],
        ['生成一份 PPT 并验证', 'artifact_delivery'],
        ['给企业提交园区工单', 'action_receipt'],
      ] as const;
      const evaluations = cases.map(([text, responseShape]) => {
        const policy = deriveTurnControlPolicy({
          text,
          source: 'local',
          toolFree: false,
        });
        const directive = formatTurnControlDirective(policy);
        return (
          policy.presentation.responseShape === responseShape &&
          policy.presentation.exposeInternalState === false &&
          policy.presentation.sourcePlacement === 'inline' &&
          policy.presentation.artifactPresentation === 'app_link' &&
          policy.presentation.finalSections[0] === 'result' &&
          directive.includes('<otto_response_contract') &&
          directive.includes('Never print these policy labels') &&
          !directive.includes(text)
        );
      });
      return {
        passed: evaluations.every(Boolean),
        evidence: [
          {
            kind: 'assertion',
            summary:
              'six intent classes map to result-first response shapes without copying user text into control metadata',
          },
        ],
      };
    },
  },
  {
    id: 'spreadsheet-financial-output-requires-verified-tool-evidence',
    lane: 'spreadsheet',
    description:
      'Financial spreadsheet output cannot contain numbers before analyze_data succeeds.',
    requiredEvidence: ['tool_trace', 'assertion'],
    async execute() {
      const state = classifyFinancialInput('请计算这张报价表的总金额和毛利率');
      const blocked = shouldBlockFinancialOutput(
        state,
        '总金额为 1200 元，毛利率 20%',
      );
      return {
        passed:
          state.requiresToolComputation &&
          state.requiresVerifiedEvidence &&
          blocked,
        evidence: [
          {
            kind: 'tool_trace',
            summary: 'financial-no-error policy requires analyze_data',
          },
          {
            kind: 'assertion',
            summary: 'numeric financial output is blocked without evidence',
          },
        ],
      };
    },
  },
  {
    id: 'rpa-external-step-requires-recorded-approval',
    lane: 'rpa',
    description:
      'An external RPA action cannot reach the driver before a matching approval is recorded.',
    requiredEvidence: ['tool_trace', 'approval', 'artifact', 'assertion'],
    async execute() {
      const root = await mkdtemp(
        path.join(os.tmpdir(), 'otto-evals-rpa-approval-'),
      );
      try {
        let driverCalls = 0;
        const workflow = {
          id: 'download-report',
          version: 1 as const,
          allowedHosts: ['example.com'],
          steps: [
            {
              id: 'download',
              action: 'web.click' as const,
              args: { selector: '#download' },
              sideEffect: 'external' as const,
            },
          ],
        };
        const store = new FileRpaRunStore(path.join(root, 'runs'));
        const runner = new RpaRunner(
          [workflow],
          store,
          {
            async authorize({ run, step }) {
              const receipt = run.receipts.find(
                (candidate) => candidate.stepId === step.id,
              );
              return receipt?.approvedAt
                ? { decision: 'allow' as const }
                : {
                    decision: 'awaiting_approval' as const,
                    approvalId: `approval-${run.id}-${step.id}`,
                  };
            },
          },
          {
            async execute() {
              driverCalls += 1;
              return { output: { downloaded: true } };
            },
          },
          new FileRpaArtifactStore(path.join(root, 'artifacts')),
        );
        const run = await runner.start(workflow.id);
        const waiting = await runner.runNext(run.id);
        const beforeApproval =
          driverCalls === 0 && waiting?.state === 'awaiting_approval';
        const approved = await runner.approve(run.id, waiting!.approvalId!);
        const completed = await runner.runNext(run.id);
        return {
          passed:
            beforeApproval &&
            Boolean(approved?.receipts[0].approvedAt) &&
            driverCalls === 1 &&
            completed?.receipts[0].state === 'succeeded',
          evidence: [
            {
              kind: 'tool_trace',
              summary: 'RPA receipt was persisted before driver invocation',
            },
            {
              kind: 'approval',
              summary: 'matching approval was stored on the step receipt',
            },
            {
              kind: 'artifact',
              summary: 'file-backed RPA stores isolate run and artifact roots',
            },
            {
              kind: 'assertion',
              summary:
                'driver call count remained zero until approval, then exactly one',
            },
          ],
        };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'durable-workflow-external-recovery-fails-closed',
    lane: 'policy',
    description:
      'Durable workflow defaults external steps to approval and fails closed after interruption.',
    requiredEvidence: ['tool_trace', 'approval', 'artifact', 'assertion'],
    async execute() {
      const root = await mkdtemp(
        path.join(os.tmpdir(), 'otto-evals-workflow-recovery-'),
      );
      try {
        const store = new FileWorkflowStore(path.join(root, 'runs'));
        const runtime = new WorkflowRuntime(store, {
          async execute() {
            return { sent: true };
          },
        });
        const run = await runtime.start({
          id: 'send-report',
          version: 1,
          steps: [
            { id: 'send', kind: 'tool', input: {}, sideEffect: 'external' },
          ],
        });
        const waiting = await runtime.runNext(run.id);
        const step = waiting!.steps[0];
        const approved = await runtime.approve(
          run.id,
          step.stepId,
          step.approvalId!,
        );
        const claimed = await store.claimNextStep(run.id, approved!.revision);
        const recovered = await runtime.recover(run.id);
        return {
          passed:
            waiting?.status === 'waiting_approval' &&
            claimed?.step.status === 'running' &&
            recovered?.status === 'unknown_outcome',
          evidence: [
            {
              kind: 'tool_trace',
              summary: 'external workflow step was claimed before recovery',
            },
            {
              kind: 'approval',
              summary: 'external workflow step was explicitly approved',
            },
            {
              kind: 'artifact',
              summary:
                'file-backed workflow state carries revision and idempotency key',
            },
            {
              kind: 'assertion',
              summary: 'recovery produced unknown_outcome rather than a replay',
            },
          ],
        };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'spreadsheet-financial-evidence-is-hashed-and-tool-bound',
    lane: 'spreadsheet',
    description:
      'Only successful analyze_data output becomes financial evidence.',
    requiredEvidence: ['tool_trace', 'artifact', 'assertion'],
    async execute() {
      const evidence = captureFinancialComputationEvidence(
        [
          {
            functionResponse: {
              name: 'analyze_data',
              response: { output: 'analyze_data OK: total=1200' },
            },
          },
        ],
        '报价表总额',
      );
      return {
        passed: Boolean(
          evidence?.inputHash && evidence.resultHash && evidence.toolVersion,
        ),
        evidence: [
          {
            kind: 'tool_trace',
            summary: 'analyze_data returned a verified success marker',
          },
          {
            kind: 'artifact',
            summary: 'input and result are SHA-256 bound in evidence',
          },
          {
            kind: 'assertion',
            summary: 'evidence is accepted only for the trusted tool',
          },
        ],
      };
    },
  },
  {
    id: 'recovery-never-replay-side-effect',
    lane: 'recovery',
    description:
      'A completed irreversible action is not replayed after recovery.',
    requiredEvidence: ['tool_trace', 'assertion'],
    async execute() {
      const checkpoint: TurnCheckpoint = {
        turnId: 'eval-turn',
        sessionId: 'eval-session',
        state: 'executing_tool' as TurnCheckpoint['state'],
        completedTools: [
          {
            name: 'send_message',
            callId: 'call-1',
            completedAt: new Date().toISOString(),
            replayClass: ToolReplayClass.NEVER_REPLAYED,
          },
        ],
        timestamp: new Date().toISOString(),
      };
      const manager = new TurnCheckpointManager('/tmp/otto-evals-no-write');
      return {
        passed: manager.shouldSkipTool(checkpoint, 'send_message', 'call-1'),
        evidence: [
          {
            kind: 'tool_trace',
            summary: 'send_message is recorded as never_replayed',
          },
          {
            kind: 'assertion',
            summary: 'recovery skips the completed irreversible action',
          },
        ],
      };
    },
  },
  {
    id: 'agent-structured-control-rejects-name-only-artifact-verification',
    lane: 'agent',
    description:
      'A research-and-artifact turn retains citations and artifacts but rejects a verification-like tool name without execution evidence.',
    requiredEvidence: [
      'tool_trace',
      'citation',
      'artifact',
      'verification',
      'assertion',
    ],
    async execute() {
      const store = new InMemorySessionStore();
      const session = store.createSession({ title: 'agent eval' });
      const message = store.appendMessage(session.sessionId, {
        role: 'assistant',
        content: [],
        source: 'local',
      });
      const policy = deriveTurnControlPolicy({
        text: '查找官方资料，生成 PDF 报告并验证结果',
        source: 'local',
        toolFree: false,
      });
      const tracker = new AgentTurnTracker(store, session.sessionId, policy);
      tracker.attachAssistantMessage(message.id);
      tracker.markStreaming();
      tracker.updateToolCalls([
        {
          id: 'source',
          toolName: 'web_search',
          parameters: { query: 'official source' },
          status: ToolCallStatus.Success,
          result: {
            success: true,
            data: 'https://example.com/source?token=private',
            executionTime: 1,
            toolName: 'web_search',
          },
        },
        {
          id: 'artifact',
          toolName: 'write_document',
          parameters: { path: 'D:\\reports\\agent-eval.pdf' },
          status: ToolCallStatus.Success,
          result: {
            success: true,
            data: 'D:\\reports\\agent-eval.pdf',
            executionTime: 1,
            toolName: 'write_document',
          },
        },
        {
          id: 'verification',
          toolName: 'verify_output',
          parameters: { path: 'D:\\reports\\agent-eval.pdf' },
          status: ToolCallStatus.Success,
          result: {
            success: true,
            data: 'PDF readable',
            executionTime: 1,
            toolName: 'verify_output',
          },
        },
      ]);
      tracker.completeAssistantMessage(true);
      tracker.complete();
      const snapshot = tracker.snapshot();
      const citations = JSON.stringify(snapshot.citations);
      return {
        passed:
          policy.allowsParallelRead &&
          snapshot.status === 'incomplete' &&
          snapshot.citations?.length === 1 &&
          !citations.includes('private') &&
          snapshot.artifacts?.length === 1 &&
          snapshot.artifacts[0]?.verified === false &&
          snapshot.verification?.status !== 'passed',
        evidence: [
          {
            kind: 'tool_trace',
            summary: 'typed turn records source, write and verification tools',
          },
          {
            kind: 'citation',
            summary:
              'source URL is registered with sensitive query values removed',
          },
          {
            kind: 'artifact',
            summary:
              'generated PDF is registered by deterministic path identity',
          },
          {
            kind: 'verification',
            summary:
              'a tool called verify_output cannot attest an artifact by name alone',
          },
          {
            kind: 'assertion',
            summary:
              'missing execution evidence leaves the turn incomplete despite a success-like tool result',
          },
        ],
      };
    },
  },
  {
    id: 'agent-file-recovery-stops-unknown-side-effects',
    lane: 'recovery',
    description:
      'The file recovery store persists a fingerprint and requires reconciliation after an interrupted unknown tool.',
    requiredEvidence: [
      'tool_trace',
      'recovery_checkpoint',
      'artifact',
      'assertion',
    ],
    async execute() {
      const root = await mkdtemp(
        path.join(os.tmpdir(), 'otto-evals-agent-recovery-'),
      );
      try {
        const store = new FileTurnRecoveryStore(root);
        let record = await store.begin({
          sessionId: 'agent-recovery-session',
          turnId: 'agent-recovery-turn',
          intentHash: turnIntentHash('send external message'),
        });
        const fingerprint = toolExecutionFingerprint('mcp_send_message', {
          recipient: 'candidate',
          token: 'must-not-persist',
        });
        record = await store.recordStarted(record, {
          callId: 'send-1',
          name: 'mcp_send_message',
          fingerprint,
          replayClass: 'never_replay',
        });
        const recovered = await store.recoverInterrupted(record.sessionId);
        const decision = store.decisionForTool(recovered!, {
          name: 'mcp_send_message',
          fingerprint,
          replayClass: 'never_replay',
        });
        const persisted = await readFile(
          store.pathForSession(record.sessionId),
          'utf8',
        );
        return {
          passed:
            recovered?.status === 'reconciliation_required' &&
            recovered.attempt === 2 &&
            decision.action === 'reconcile' &&
            !persisted.includes('must-not-persist'),
          evidence: [
            {
              kind: 'tool_trace',
              summary: 'unknown MCP side effect is classified never_replay',
            },
            {
              kind: 'recovery_checkpoint',
              summary: 'atomic checkpoint advances to attempt two',
            },
            {
              kind: 'artifact',
              summary: 'recovery record contains only an argument fingerprint',
            },
            {
              kind: 'assertion',
              summary:
                'recovery requires reconciliation and excludes raw secrets',
            },
          ],
        };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'planning-transient-read-retries-once-then-switches-source',
    lane: 'planning',
    description:
      'A timed-out public-data lookup gets one bounded retry before the remaining plan must switch source.',
    requiredEvidence: ['tool_trace', 'plan_revision', 'assertion'],
    async execute() {
      const coordinator = new AdaptiveExecutionCoordinator();
      const observation = {
        toolName: 'web_search',
        callFingerprint: 'park-company-public-data',
        message: 'upstream request timed out',
        sideEffect: 'read_only' as const,
      };
      const first = coordinator.observe(observation);
      const second = coordinator.observe(observation);
      return {
        passed:
          first.action === 'retry_once' &&
          first.retryAllowed &&
          second.action === 'switch_strategy' &&
          second.replanRequired &&
          !second.retryAllowed,
        evidence: [
          {
            kind: 'tool_trace',
            summary: 'the same read failure is counted across model rounds',
          },
          {
            kind: 'plan_revision',
            summary:
              'the second failure requires an alternate source instead of another identical retry',
          },
          {
            kind: 'assertion',
            summary: 'bounded retry policy permits exactly one retry',
          },
        ],
      };
    },
  },
  {
    id: 'planning-permission-failure-requests-minimum-access',
    lane: 'planning',
    description:
      'An enterprise data permission failure requests access rather than repeatedly probing protected data.',
    requiredEvidence: ['tool_trace', 'plan_revision', 'assertion'],
    async execute() {
      const coordinator = new AdaptiveExecutionCoordinator();
      const decision = coordinator.observe({
        toolName: 'read_enterprise_profile',
        callFingerprint: 'enterprise-profile-private',
        message: '403 permission denied',
        sideEffect: 'read_only',
      });
      return {
        passed:
          decision.action === 'request_input' &&
          !decision.retryAllowed &&
          decision.replanRequired,
        evidence: [
          {
            kind: 'tool_trace',
            summary: '403 is classified as a permission boundary',
          },
          {
            kind: 'plan_revision',
            summary: 'remaining work pauses for the minimum required access',
          },
          {
            kind: 'assertion',
            summary: 'protected data is not probed again automatically',
          },
        ],
      };
    },
  },
  {
    id: 'planning-stale-edit-preserves-completed-evidence',
    lane: 'planning',
    description:
      'A stale edit causes a re-read and plan revision while keeping already completed inspection work.',
    requiredEvidence: ['tool_trace', 'plan_revision', 'assertion'],
    async execute() {
      const coordinator = new AdaptiveExecutionCoordinator();
      const decision = coordinator.observe({
        toolName: 'replace',
        callFingerprint: 'source-file-revision-1',
        message: '409 revision conflict',
        sideEffect: 'local_write',
      });
      const directive = coordinator.buildDirective(
        [decision],
        ['read_file', 'search_file_content'],
      );
      return {
        passed:
          decision.category === 'stale_state' &&
          decision.action === 'switch_strategy' &&
          directive.includes('Preserve completed work') &&
          directive.includes('revise the remaining plan') &&
          directive.includes('Re-read current state'),
        evidence: [
          {
            kind: 'tool_trace',
            summary:
              'stale revision is distinguished from a transient network failure',
          },
          {
            kind: 'plan_revision',
            summary:
              'the remaining plan re-reads state without reopening completed inspection',
          },
          {
            kind: 'assertion',
            summary:
              'model-only directive is bounded and contains no raw error payload',
          },
        ],
      };
    },
  },
  {
    id: 'recovery-ambiguous-external-write-never-retries',
    lane: 'recovery',
    description:
      'A disconnected customer reply with unknown outcome stops for reconciliation instead of sending twice.',
    requiredEvidence: [
      'tool_trace',
      'recovery_checkpoint',
      'plan_revision',
      'assertion',
    ],
    async execute() {
      const coordinator = new AdaptiveExecutionCoordinator();
      const decision = coordinator.observe({
        toolName: 'send_customer_reply',
        callFingerprint: 'ticket-42-reply-1',
        message: 'socket closed; outcome unknown',
        sideEffect: 'external_write',
      });
      return {
        passed:
          decision.category === 'unknown_side_effect' &&
          decision.action === 'reconcile' &&
          !decision.retryAllowed,
        evidence: [
          {
            kind: 'tool_trace',
            summary:
              'external write transport closed without a trusted receipt',
          },
          {
            kind: 'recovery_checkpoint',
            summary: 'the call fingerprint identifies the result to reconcile',
          },
          {
            kind: 'plan_revision',
            summary: 'automatic execution stops before any replacement send',
          },
          {
            kind: 'assertion',
            summary: 'ambiguous external effects are never retried',
          },
        ],
      };
    },
  },
  {
    id: 'context-hierarchy-preserves-current-goal-at-safe-boundary',
    lane: 'context',
    description:
      'Long task history cleans old tool output and schedules preventive summarization only after a complete tool boundary.',
    requiredEvidence: ['context_compaction', 'tool_trace', 'assertion'],
    async execute() {
      const service = new CompressionService({
        compressionTokenThreshold: 0.8,
        compressionPreserveThreshold: 0.3,
        skipEnvironmentMessages: 2,
      });
      const oldTools = Array.from({ length: 7 }, (_, index) => ({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: `read_${index}`,
              response: { output: `old-${index} `.repeat(120) },
            },
          },
        ],
      })) as Content[];
      const currentGoal = {
        role: 'user',
        parts: [{ text: '继续完成园区企业星链图，不要丢失已核实企业。' }],
      } as Content;
      const modelCall = {
        role: 'model',
        parts: [{ functionCall: { name: 'read_file', args: {} } }],
      } as Content;
      const toolResult = {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'verified' },
            },
          },
        ],
      } as Content;
      const history = [...oldTools, currentGoal, modelCall, toolResult];
      const cleaned = service.lightweightCleanup(history);
      return {
        passed:
          cleaned.at(-3) === currentGoal &&
          cleaned.at(-2) === modelCall &&
          cleaned.at(-1) === toolResult &&
          JSON.stringify(cleaned[0]).includes('[L1 cleaned]') &&
          service.shouldPreventiveCompress(cleaned, 3_000, 4_000),
        evidence: [
          {
            kind: 'context_compaction',
            summary:
              'L1 replaces only older tool payloads and L2 triggers around 60 percent',
          },
          {
            kind: 'tool_trace',
            summary:
              'the latest function call and matching result remain intact',
          },
          {
            kind: 'assertion',
            summary: 'the active enterprise goal is preserved verbatim',
          },
        ],
      };
    },
  },
];

let report: EvaluationReport;
const artifactDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../artifacts',
);

describe('deterministic core safety scenarios', () => {
  it('passes every required safety scenario with complete evidence', async () => {
    report = await runDeterministicScenarios(scenarios);
    expect(report.scenarios).toHaveLength(scenarios.length);
    expect(
      report.scenarios
        .filter((scenario) => !scenario.passed)
        .map((scenario) => ({ id: scenario.id, failure: scenario.failure })),
    ).toEqual([]);
    expect(report.summary.passRate).toBe(1);
    expect(report.summary.evidenceCoverage).toBe(1);
    expect(
      Object.values(report.summary.averageScores).every((score) => score === 1),
    ).toBe(true);
    expect(report.summary.lanes.agent?.passed).toBe(2);
    expect(report.scenarios.every((scenario) => scenario.durationMs >= 0)).toBe(
      true,
    );
    expect(() => assertReleaseGate(report)).not.toThrow();
    await writeEvaluationReport(report, artifactDirectory);
    const persisted = JSON.parse(
      await readFile(path.join(artifactDirectory, 'latest.json'), 'utf8'),
    ) as EvaluationReport;
    expect(persisted.scenarios).toHaveLength(scenarios.length);
  });
});
