/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import {
  Config,
  ApprovalMode,
  generateCustomModelId,
  BaseTool,
  Icon,
  type CustomModelConfig,
  type ToolResult,
} from 'otto-core';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { CoreSessionRuntime } from '../../../server/src/runtime.js';
import { InMemorySessionStore } from '../../../server/src/sessions.js';
import { FileTurnRecoveryStore } from '../../../server/src/turnRecoveryStore.js';
import type {
  ServerToClient,
  TokenUsage,
} from '../../../server/src/protocol.js';
import {
  LIVE_EVAL_EXECUTION_LIMITS,
  liveEvalPreflight,
  type LiveEvalBudget,
} from '../liveEvalGate.js';
import { summarizeLiveUsage } from '../liveRuntimeEval.js';
import {
  CODE_FIXTURES,
  PAYMENT_SOURCE,
  runCodeOracle,
  seedCodeProject,
} from './codeRepair.js';
import {
  EvidenceJournal,
  confinedFile,
  sha256,
  type Observation,
  type RealTaskId,
} from './evidence.js';
import { collectArtifactEvidence } from './artifacts.js';

type Schema = BaseTool['parameterSchema'];
type RuntimeCaseId =
  | 'login-retry'
  | 'utc-display'
  | 'ppt-preview'
  | 'dual-artifact'
  | 'steer-stop-backend'
  | 'steer-replace-artifact'
  | 'restart-known-receipt'
  | 'restart-unknown-outcome';
export interface RuntimeTaskOptions {
  caseId: RuntimeCaseId;
  /** New directory, never the developer checkout or the user's profile. */
  runDirectory: string;
  model: CustomModelConfig;
  mode: 'scripted' | 'real_model';
  experimentHash: string;
  sourceFingerprint: string;
  oraclePath?: string;
  recovery?: boolean;
  resume?: boolean;
  maxCaseMs?: number;
  extraTools?: BaseTool[];
  /** Shared controller budget, never constructed/reset per case. */
  budget?: LiveEvalBudget;
  onFrame?: (frame: ServerToClient, runtime: CoreSessionRuntime) => void;
}
class PublicCodeCheck extends BaseTool<Record<string, never>, ToolResult> {
  constructor(
    private readonly workspace: string,
    private readonly id: keyof typeof CODE_FIXTURES,
    private readonly grader: string,
  ) {
    super(
      'eval_validate',
      'Run public checks',
      'Run the fixed public checks for this temporary project; hidden acceptance is separate.',
      Icon.Tasks,
      { type: 'OBJECT' as Schema['type'], properties: {} },
    );
  }
  async execute(
    _params: Record<string, never>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const result = await runCodeOracle(
      this.workspace,
      this.id,
      this.grader,
      false,
      signal,
    );
    return {
      llmContent: JSON.stringify(result),
      returnDisplay: result.passed ? '公开测试通过' : '公开测试失败',
      ...(result.passed
        ? {}
        : { error: { message: 'Public tests failed', type: 'test_failure' } }),
    };
  }
}
const isCode = (id: RuntimeCaseId): id is keyof typeof CODE_FIXTURES =>
  id === 'login-retry' || id === 'utc-display';
export function runtimeTaskPrompt(
  id: RuntimeCaseId,
  workspace: string,
): string {
  const request = isCode(id)
    ? CODE_FIXTURES[id].request
    : (
        {
          'ppt-preview':
            '生成三页 PPT，保存为 output.pptx，三页分别包含 Overview、Progress、Next Steps。通过 generate_document 生成。交付可点击的文件链接，不要在正文裸露绝对路径，不要打开外部软件。',
          'dual-artifact':
            '使用 generate_document 生成 output.pptx 和 output.pdf，内容包括 Overview、Progress、Next Steps。生成初稿后将 Progress 更新为 Progress revised，重新生成并检查两份当前文件，交付文件链接，不要打开外部软件。',
          'steer-stop-backend':
            '读取 backend.cjs，在文件中补充说明，然后继续改进后端逻辑。',
          'steer-replace-artifact':
            '生成 output.pptx，内容是 Overview、Progress、Next Steps，随后发送给测试收件端。不要打开外部软件。',
          // Initial setup is the authorized send. The independent no-replay oracle
          // covers both processes. Resume uses the product's supported "continue"
          // input, not a fabricated record or a direct recovery-store mutation.
          'restart-known-receipt':
            '使用 eval_send_receipt 向隔离接收端发送一条消息，之后说明结果。',
          'restart-unknown-outcome':
            '使用 eval_send_receipt 向隔离接收端发送一条消息，等待回执后说明结果。',
        } as const
      )[id];
  return `${request}\n工作目录：${workspace}`;
}
let running = false;
/** Fail closed, not a flag callers can override with an unverified assertion.
 * Native read_file supports external access; DEFAULT write confirmation does
 * not isolate hidden graders or user files from an arbitrary model. Connect a
 * real confined worker before enabling the paid admission code below. */
export function requireRealModelConfinement(): void {
  throw new Error(
    'Real-model task execution disabled: native read isolation / confined worker is not provisioned',
  );
}
export function assistantText(
  history: Array<{
    role: string;
    content: import('../../../server/src/protocol.js').MessageContent;
  }>,
) {
  return history
    .filter((m) => m.role === 'assistant')
    .flatMap((m) =>
      m.content.filter((p) => p.type === 'text').map((p) => p.value),
    )
    .join('\n');
}
export async function executeRuntimeTask(options: RuntimeTaskOptions) {
  if (running)
    throw new Error('Runtime tasks require a dedicated serial process');
  if (
    ![options.experimentHash, options.sourceFingerprint].every((s) =>
      /^[a-f\d]{64}$/u.test(s),
    )
  )
    throw new Error('Missing source/experiment identity');
  if (options.mode === 'real_model') {
    requireRealModelConfinement();
    const gate = liveEvalPreflight(process.env);
    if (
      !gate.ready ||
      !options.budget ||
      gate.identity?.model !== options.model.modelId ||
      gate.identity.endpointHash !==
        sha256(new URL(options.model.baseUrl!).href) ||
      options.model.apiKey !== process.env.OTTO_EVAL_API_KEY
    )
      throw new Error('Real model/budget configuration not ready');
  } else {
    const url = new URL(options.model.baseUrl!);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      options.model.apiKey !== 'loopback-not-a-secret'
    )
      throw new Error('Scripted mode only accepts the local fixture provider');
  }
  const root = path.resolve(options.runDirectory);
  if (!options.resume) await mkdir(root); // EEXIST is intentional, never overwrite.
  const workspace = path.join(root, 'workspace');
  const journal = new EvidenceJournal(
    path.join(root, options.resume ? 'resume-evidence' : 'evidence'),
  );
  const priorUserDir = process.env.OTTO_USER_DIR;
  process.env.OTTO_USER_DIR = path.join(root, 'profile');
  running = true;
  let runtime: CoreSessionRuntime | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reservation: number | null = null;
  try {
    if (!options.resume) {
      if (isCode(options.caseId))
        await seedCodeProject(workspace, options.caseId);
      else {
        await mkdir(workspace);
        await writeFile(
          path.join(workspace, 'backend.cjs'),
          'module.exports = { retained: true };\n',
          { flag: 'wx' },
        );
      }
    }
    const store = new InMemorySessionStore();
    const sessionFile = path.join(root, 'session-id.json');
    const savedSessionId = options.resume
      ? (JSON.parse(await readFile(sessionFile, 'utf8')) as string)
      : undefined;
    const session = store.createEphemeralSession({
      workspacePath: workspace,
      sessionId: savedSessionId,
    });
    // Recovery uses a stable product session ID across two independent processes.
    const sessionId = session.sessionId;
    if (!options.resume)
      await writeFile(sessionFile, JSON.stringify(sessionId), { flag: 'wx' });
    const config = new Config({
      sessionId,
      cwd: workspace,
      targetDir: workspace,
      debugMode: false,
      model: generateCustomModelId(options.model),
      customModels: [options.model],
      coreTools:
        isCode(options.caseId) || options.caseId === 'steer-stop-backend'
          ? ['read_file', 'write_file', 'replace']
          : ['read_file', 'write_file', 'generate_document'],
      disableMcpDiscovery: true,
      disableEnvironmentContext: true,
      approvalMode: ApprovalMode.DEFAULT,
      telemetry: { enabled: false, logPrompts: false },
      usageStatisticsEnabled: false,
      silentMode: true,
      noBrowser: true,
      maxSessionTurns: LIVE_EVAL_EXECUTION_LIMITS.maxRounds,
      userRules:
        'Only use the supplied tools in the temporary workspace. No installations, other user files, network connectors or external applications. Public checks are not hidden acceptance evidence. Preserve existing unrelated functionality.',
    });
    runtime = new CoreSessionRuntime(
      store,
      sessionId,
      config,
      { log: async () => undefined },
      {
        recoveryStore: options.recovery
          ? new FileTurnRecoveryStore(path.join(root, 'recovery'))
          : false,
      },
    );
    const frames: ServerToClient[] = [];
    const dispatches: Array<{
      index: number;
      at: number;
      id: string;
      name: string;
      args: unknown;
    }> = [];
    const seenDispatches = new Set<string>();
    let steeringPromise: Promise<unknown> | undefined;
    let appliedIndex = -1;
    let retainedAtSteer: string | null = null;
    const usages: Array<TokenUsage | undefined> = [];
    const approvals: Array<{ callId: string; approved: boolean; at: number }> =
      [];
    let timedOut = false;
    let observationError: string | null = null;
    const start = performance.now();
    unsubscribe = store.subscribe(sessionId, (frame) => {
      frames.push(frame);
      if (frame.type === 'turn_steering' && frame.payload.status === 'applied')
        appliedIndex = frames.length - 1;
      if (frame.type === 'tool_calls_update') {
        for (const call of frame.payload.toolCalls) {
          if (call.status === 'executing' && !seenDispatches.has(call.id)) {
            seenDispatches.add(call.id);
            dispatches.push({
              index: frames.length - 1,
              at: Date.now(),
              id: call.id,
              name: call.toolName,
              args: call.parameters,
            });
          }
          if (
            !steeringPromise &&
            options.caseId.startsWith('steer-') &&
            call.status === 'success' &&
            ['write_file', 'generate_document', 'read_file'].includes(
              call.toolName,
            )
          ) {
            const turnId = store.getHistory(sessionId).find((m) => m.turn)
              ?.turn?.turnId;
            if (!turnId) continue;
            retainedAtSteer = sha256(
              readFileSync(path.join(workspace, 'backend.cjs')),
            );
            steeringPromise = runtime!
              .steer({
                version: 1,
                turnId,
                expectedRevision: 1,
                clientMessageId: 'planned-steering-1',
                mode: 'replace',
                text:
                  options.caseId === 'steer-stop-backend'
                    ? '不要继续改后端，停止写入 backend.cjs，说明已经完成的改动。保留已有文件。'
                    : '取消旧的 PPT 发送操作，改为生成 output.pdf，内容包含 Overview、Progress、Next Steps。不要打开外部软件。',
              })
              .catch((error) => {
                observationError = String(error);
                runtime!.cancel();
              });
          }
        }
      }
      if (frame.type === 'chat_complete') usages.push(frame.payload.tokenUsage);
      try {
        options.onFrame?.(frame, runtime!);
      } catch (error) {
        observationError = String(error);
        runtime!.cancel();
      }
      if (frame.type === 'tool_confirmation_request') {
        void (async () => {
          const { toolName, parameters } = frame.payload.toolCall;
          let approved = false;
          try {
            if (
              ['write_file', 'replace', 'generate_document'].includes(toolName)
            ) {
              const target = await confinedFile(
                workspace,
                String(parameters?.file_path ?? parameters?.output_path ?? ''),
                false,
              );
              approved = isCode(options.caseId)
                ? path.basename(target) === CODE_FIXTURES[options.caseId].file
                : target.startsWith((await realpath(workspace)) + path.sep);
              if (
                typeof parameters?.content === 'string' &&
                parameters.content.length > 128_000
              )
                approved = false;
              if (
                toolName === 'generate_document' &&
                (/<\s*(?:script|iframe)|\b(?:https?|file):/iu.test(
                  String(parameters?.content),
                ) ||
                  parameters?.template_options)
              )
                approved = false;
            } else
              approved =
                options.extraTools?.some((t) => t.name === toolName) ?? false;
          } catch {
            approved = false;
          }
          approvals.push({
            callId: frame.payload.callId,
            approved,
            at: Date.now(),
          });
          runtime!.resolveToolConfirmation(
            frame.payload.callId,
            approved ? 'approved' : 'rejected',
          );
        })().catch(() =>
          runtime!.resolveToolConfirmation(frame.payload.callId, 'rejected'),
        );
      }
    });
    timer = setTimeout(
      () => {
        timedOut = true;
        runtime!.cancel();
      },
      Math.min(
        options.maxCaseMs ?? LIVE_EVAL_EXECUTION_LIMITS.maxCaseMs,
        LIVE_EVAL_EXECUTION_LIMITS.maxCaseMs,
      ),
    );
    if (options.mode === 'real_model') {
      reservation = options.budget!.reserve();
      if (reservation === null)
        throw new Error(
          'Shared experiment budget exhausted or prior usage unresolved',
        );
    }
    await runtime.initialize();
    const registry = await config.getToolRegistry();
    const nativeTools = registry
      .getAllTools()
      .map((t) => ({ name: t.name, implementation: t.constructor.name }));
    const oraclePath =
      options.oraclePath ??
      fileURLToPath(
        new URL(
          '../../../../scripts/real-task-code-oracle.cjs',
          import.meta.url,
        ),
      );
    if (isCode(options.caseId))
      registry.registerTool(
        new PublicCodeCheck(workspace, options.caseId, oraclePath),
      );
    for (const tool of options.extraTools ?? []) registry.registerTool(tool);
    const registeredTools = registry
      .getAllTools()
      .map((t) => ({ name: t.name, implementation: t.constructor.name }));
    await runtime.run(
      [
        {
          type: 'text',
          value: options.resume
            ? '继续。'
            : runtimeTaskPrompt(options.caseId, workspace),
        },
      ],
      'local',
    );
    await steeringPromise;
    const history = store.getHistory(sessionId);
    const turn = history.find((m) => m.turn)?.turn;
    const frameFile = await journal.add('product-frames.json', frames);
    await journal.add('native-tools.json', nativeTools);
    await journal.add('registered-tools.json', registeredTools);
    await journal.add('approvals.json', approvals);
    await journal.add('input-and-dispatches.json', {
      request: options.resume
        ? '继续。'
        : runtimeTaskPrompt(options.caseId, workspace),
      dispatches,
    });
    const observations: Observation[] = [];
    if (isCode(options.caseId)) {
      const fixture = CODE_FIXTURES[options.caseId];
      const after = await readFile(
        await confinedFile(workspace, fixture.file),
        'utf8',
      );
      const payment = await readFile(
        await confinedFile(workspace, 'payment.cjs'),
        'utf8',
      );
      const diffFile = await journal.add('source-diff.json', {
        file: fixture.file,
        before: fixture.source,
        after,
        beforeHash: sha256(fixture.source),
        afterHash: sha256(after),
        paymentUnchanged: payment === PAYMENT_SOURCE,
      });
      const hidden = await runCodeOracle(
        workspace,
        options.caseId,
        oraclePath,
        true,
      );
      const hiddenFile = await journal.add('hidden-tests.json', hidden);
      observations.push(
        {
          check: 'source-diff',
          passed: after !== fixture.source && payment === PAYMENT_SOURCE,
          evidence: [diffFile, frameFile],
        },
        {
          check: 'hidden-tests',
          passed: hidden.passed,
          evidence: [hiddenFile],
        },
        {
          check:
            options.caseId === 'login-retry'
              ? 'payment-regression'
              : 'timezone-boundaries',
          passed:
            hidden.checks
              .filter((c) =>
                options.caseId === 'login-retry'
                  ? c.name.startsWith('payment-')
                  : !c.name.startsWith('payment-'),
              )
              .every((c) => c.passed) && hidden.passed,
          evidence: [hiddenFile],
        },
      );
    }
    if (
      options.caseId === 'ppt-preview' ||
      options.caseId === 'dual-artifact' ||
      options.caseId === 'steer-replace-artifact'
    ) {
      observations.push(
        ...(await collectArtifactEvidence(
          workspace,
          options.caseId === 'dual-artifact'
            ? ['output.pptx', 'output.pdf']
            : options.caseId === 'ppt-preview'
              ? ['output.pptx']
              : ['output.pdf'],
          journal,
          options.caseId === 'dual-artifact',
        )),
      );
      const finalText = assistantText(history);
      const textEvidence = await journal.add('final-output.json', {
        finalText,
      });
      if (options.caseId === 'ppt-preview')
        observations.push({
          check: 'no-bare-path',
          passed: finalText.trim()
            ? !/(?:[a-z]:[\\/]|(?:~|\/(?:Users|home|tmp|mnt|var))\/)/iu.test(
                finalText.replace(/\[[^\]]+\]\([^\n]+\)/gu, ''),
              )
            : null,
          evidence: [textEvidence],
        });
    }
    if (options.caseId.startsWith('steer-')) {
      const state = {
        appliedIndex,
        retainedAtSteer,
        finalBackendHash: sha256(
          await readFile(path.join(workspace, 'backend.cjs')),
        ),
        dispatches,
        receipts: frames.filter((f) => f.type === 'turn_steering'),
      };
      const evidence = await journal.add('steering-timeline.json', state);
      observations.push({
        check: 'steering-applied',
        passed: appliedIndex >= 0 && !observationError,
        evidence: [evidence],
      });
      const later = dispatches.filter((d) => d.index > appliedIndex);
      observations.push({
        check: 'post-steer-writes',
        passed:
          appliedIndex < 0
            ? null
            : options.caseId === 'steer-replace-artifact'
              ? !later.some(
                  (d) =>
                    ['write_file', 'replace', 'generate_document'].includes(
                      d.name,
                    ) && JSON.stringify(d.args).includes('output.pptx'),
                )
              : !later.some(
                  (d) =>
                    ['write_file', 'replace'].includes(d.name) &&
                    JSON.stringify(d.args).includes('backend.cjs'),
                ) && retainedAtSteer === state.finalBackendHash,
        evidence: [evidence],
      });
      if (options.caseId === 'steer-stop-backend')
        observations.push({
          check: 'retained-work',
          passed:
            retainedAtSteer !== null &&
            retainedAtSteer === state.finalBackendHash,
          evidence: [evidence],
        });
      // An independent receiver must attest no old send. A missing send tool is
      // not evidence of cancellation; the process adapter adds this observation.
    }
    // Other adapters collect their own real file/UI/process/API observations.
    // Missing evidence remains unknown; native completed=true cannot fill it in.
    const usage = summarizeLiveUsage(
      usages,
      options.mode === 'real_model'
        ? {
            inputPerMillion: Number(process.env.OTTO_EVAL_INPUT_PER_MILLION),
            outputPerMillion: Number(process.env.OTTO_EVAL_OUTPUT_PER_MILLION),
          }
        : undefined,
    );
    if (reservation !== null) {
      options.budget!.settle(reservation, usage.estimatedCost);
      reservation = null;
    }
    const result = await journal.finish(
      options.caseId as RealTaskId,
      observations,
      {
        mode: options.mode,
        experimentHash: options.experimentHash,
        sourceFingerprint: options.sourceFingerprint,
        modelRevision:
          options.mode === 'real_model'
            ? process.env.OTTO_EVAL_MODEL_REVISION
            : 'scripted-not-a-trained-model',
        limits: LIVE_EVAL_EXECUTION_LIMITS,
        budget: options.budget?.snapshot() ?? null,
        realModelScoreEligible:
          options.mode === 'real_model' && !timedOut && !observationError,
        status: timedOut ? 'timeout' : 'executed',
        productCompleted: turn?.status === 'completed',
        durationMs: performance.now() - start,
        timedOut,
        observationError,
        plannedSteering: options.caseId.startsWith('steer-') ? 1 : 0,
        correctiveFollowups: 0,
        approvalRequests: approvals.length,
        ...usage,
      },
    );
    return { result, workspace, frames, history };
  } finally {
    if (reservation !== null) options.budget!.settle(reservation, null);
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    await runtime?.dispose();
    if (priorUserDir === undefined) delete process.env.OTTO_USER_DIR;
    else process.env.OTTO_USER_DIR = priorUserDir;
    running = false;
  }
}
