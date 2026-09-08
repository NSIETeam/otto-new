/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CoreSessionRuntime —— 把 otto-core「跑一整轮对话」封进一个 SessionRuntime。
 *
 * 设计为 headless 运行循环：
 *   1. chat.sendMessageStream(...) 拿逐 chunk 流；
 *   2. 文本 chunk → publish('chat_chunk')；functionCalls 累积；
 *   3. 本轮有工具调用 → 用 executeToolCall 一次性执行，把状态/结果 publish
 *      成 'tool_calls_update'，工具响应作为下一轮 user message 回灌；
 *   4. 无工具调用 → 本轮收口，publish('chat_complete')，返回。
 *
 * 与 nonInteractiveCli 的差异：
 *   - 输出不写 stdout，而是序列化成 protocol.ts 的 ServerToClient 帧，经
 *     store.publish 广播给该会话的所有订阅者（多 desktop 客户端各自实时收到）。
 *   - 一个 runtime 绑定一个 core Config（= 一个会话），持久 chat 历史在 core 内部。
 *   - cancel() 触发 AbortController；run() 被中止时收尾发 session_status=idle。
 *
 * 不在本文件做的（留接缝）：
 *   - 工具确认（CoreToolScheduler / handleConfirmationResponse）——当前用
 *     executeToolCall 直接执行（YOLO 风格，对齐 nonInteractive）。带确认的 GUI
 *     调度是后续增强，见 TODO。
 */

import {
  AuthType,
  Config,
  MESSAGE_ROLES,
  SceneType,
  ToolConfirmationOutcome,
  WebFetchTool,
  executeToolCall,
  installTurnExecutionGuard,
  getModelCapabilities,
  areAllFunctionCallsValid,
  fixAllFunctionCalls,
  appearIncompleteFromStreaming,
  getWorkLogger,
  getHabitAnalyzer,
  getRealtimeWatcher,
  ModelRequestSafetyError,
  loadBuiltinSkillInstructions,
  MODEL_SERVICE_URL_UNAVAILABLE,
  type ToolCallRequestInfo,
  type ToolRegistry,
  type ToolQuestionConfirmationDetails,
  type LogCategory,
} from 'otto-core';
import type {
  Content,
  FunctionCall,
  GenerateContentResponse,
  FinishReason,
  Part,
} from '@google/genai';
import { randomUUID } from 'node:crypto';

import type { SessionStore, SessionRuntime } from './sessions.js';
import { AgentTurnTracker } from './agentTurnTracker.js';
import { TASK_PLAN_DECLARATION, TASK_PLAN_TOOL_NAME } from './taskContract.js';
import { TaskContinuityLedger, type TurnSteeringRequest, type SteeringReceipt } from './taskContinuity.js';
import {
  DeliveryClosure,
  deliveryClosureDirective,
} from './deliveryClosure.js';
import { DeliveryRepairGuard } from './deliveryRepair.js';
import { REPAIR_PLAN_TOOL_NAME, REPAIR_FORMAT_TOOL_NAME, REPAIR_TOOL_DECLARATIONS } from './repairStrategyTools.js';
import { CLAIM_REVIEW_TOOL_NAME, CLAIM_REVIEW_DECLARATION } from './claimEvidenceTools.js';
import { TurnDirectiveLedger } from './turnDirectiveLedger.js';
import { TurnConstraintGuard } from './turnConstraints.js';
import { resolveTurnRequest } from './turnContinuation.js';
import {
  incompleteDelivery,
  retainedDeliveryDraft,
  unverifiedDeliveryText,
} from './incompleteDelivery.js';
import { hasSuccessfulProcessReceipt, hasFailedVerificationReceipt, verificationKind } from './verificationEvidence.js';
import { refineComplexityFromObjectives } from './complexityRouter.js';
import {
  AdaptiveExecutionCoordinator,
  type AdaptiveAttemptReview,
} from './adaptiveExecution.js';
import {
  deriveTurnControlPolicy,
  formatTurnControlDirective,
  isParallelSafeToolName,
  isPolicySafeWithoutConfirmation,
} from './turnControlPolicy.js';
import {
  ToolCallStatus,
  type MessageContent,
  type MessageSource,
  type ToolCall,
  type ToolExecutionResult,
  type TokenUsage,
  type AskUserQuestion,
  type ToolConfirmationResponsePayload,
  type TurnControlPolicy,
} from './protocol.js';
import {
  shouldRequestConfirmation,
  type RuntimeAuthorizationMode,
} from './modules/authorization/index.js';
import {
  FileTurnRecoveryStore,
  classifyRecoveryTool,
  toolExecutionFingerprint,
  turnIntentHash,
  type TurnRecoveryRecord,
} from './turnRecoveryStore.js';

const MODEL_CONNECTION_ERROR =
  '当前模型请求的结果未知：请求可能已被供应商接收并计费。Otto 已停止自动重试和跨供应商切换。如果手动重试或切换模型，可能产生双重费用。';

class ModelOutcomeUnknownError extends Error {
  readonly requestId: string;
  readonly providerRequestId?: string;

  constructor(requestId: string, cause: unknown, providerRequestId?: string) {
    super(MODEL_CONNECTION_ERROR, { cause });
    this.name = 'ModelOutcomeUnknownError';
    this.requestId = requestId;
    this.providerRequestId = providerRequestId;
  }

  safetyDetails() {
    return {
      requestId: this.requestId,
      requestState: 'unknown_outcome' as const,
      ...(this.providerRequestId
        ? { providerRequestId: this.providerRequestId }
        : {}),
    };
  }
}

/** 遍历 Error.cause 链，读取 provider/Node/undici 提供的结构化失败信息。 */
function runtimeErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current != null && !seen.has(current) && chain.length < 6) {
    seen.add(current);
    chain.push(current);
    if (typeof current !== 'object') break;
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * 判断请求是否已越过「确认未发送」边界、因而结果可能未知。
 *
 * 这里只负责归类并停止；绝不据此自动重试或切换 provider。优先读取 status、
 * code 和 stream 标记等结构化字段。最后的 TypeError 文本分支仅兼容 undici 在
 * 没有暴露 cause/code 时产生的通用 `fetch failed` 错误。
 */
function isAmbiguousModelTransportOutcome(error: unknown): boolean {
  return runtimeErrorChain(error).some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const details = entry as {
      status?: unknown;
      code?: unknown;
      name?: unknown;
      message?: unknown;
      isStreamInterrupt?: unknown;
    };
    if (
      typeof details.status === 'number' &&
      (details.status === 429 ||
        (details.status >= 500 && details.status <= 599))
    ) {
      return true;
    }
    if (details.isStreamInterrupt === true || details.name === 'TimeoutError') {
      return true;
    }
    if (
      typeof details.code === 'string' &&
      /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)$/i.test(
        details.code,
      )
    ) {
      return true;
    }
    return (
      entry instanceof TypeError &&
      typeof details.message === 'string' &&
      /^(?:fetch failed|network error)$/i.test(details.message.trim())
    );
  });
}

function userFacingRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('Failed to parse URL from /v1/') ||
    (message.includes('Invalid URL') && message.includes('/v1/'))
  ) {
    return MODEL_SERVICE_URL_UNAVAILABLE;
  }
  if (error instanceof ModelOutcomeUnknownError) {
    return `${MODEL_CONNECTION_ERROR}\n\n请求编号：${error.requestId}${
      error.providerRequestId
        ? `\n供应商请求编号：${error.providerRequestId}`
        : ''
    }`;
  }
  if (isAmbiguousModelTransportOutcome(error)) return MODEL_CONNECTION_ERROR;
  return message;
}

/** 创建并初始化一个绑定到指定 core Config 的会话运行时。 */
export async function createCoreSessionRuntime(
  store: SessionStore,
  sessionId: string,
  config: Config,
  options: CoreSessionRuntimeOptions = {},
): Promise<CoreSessionRuntime> {
  const runtime = new CoreSessionRuntime(
    store,
    sessionId,
    config,
    getWorkLogger(),
    options,
  );
  await runtime.initialize();
  return runtime;
}

/**
 * 把协议的 MessageContent（富片段）构造成 core 的 Part[]（首轮 user message）。
 * 文本类片段（text / 各种引用）合并成一个 text part；image_reference 转成
 * inlineData part —— core 的 customModelAdapter 会据 provider 自动转成 OpenAI
 * image_url / Anthropic image / Responses input_image，无需在此区分 provider。
 * 文本置于图片之前；若既无文本也无图片，回退一个空 text part 避免空 user turn。
 */
function messageContentToParts(content: MessageContent): Part[] {
  const imageParts: Part[] = [];
  const textChunks: string[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        textChunks.push(part.value);
        break;
      case 'file_reference':
        textChunks.push(`@${part.value.filePath}`);
        break;
      case 'folder_reference':
        textChunks.push(`@${part.value.folderPath}`);
        break;
      case 'code_reference':
        textChunks.push(`\n\`\`\`\n${part.value.code}\n\`\`\`\n`);
        break;
      case 'text_file_content':
        textChunks.push(`\n[${part.value.fileName}]\n${part.value.content}\n`);
        break;
      case 'image_reference':
        imageParts.push({
          inlineData: {
            mimeType: part.value.mimeType,
            data: part.value.data,
          },
        });
        break;
      default:
        break;
    }
  }
  const text = textChunks.join('\n').trim();
  const parts: Part[] = [];
  if (text) parts.push({ text });
  parts.push(...imageParts);
  if (parts.length === 0) parts.push({ text: '' });
  return parts;
}

/** 把员工本轮输入规整成可落日志的纯文本。 */
function messageContentToText(content: MessageContent): string {
  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.value;
        case 'file_reference':
          return `@${part.value.filePath}`;
        case 'folder_reference':
          return `@${part.value.folderPath}`;
        case 'code_reference':
          return part.value.code;
        case 'text_file_content':
          return `${part.value.fileName}: ${part.value.content}`;
        case 'image_reference':
          return '[图片]';
        default:
          return '';
      }
    })
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 普通会话中的 PPT 意图也要命中内置工作流，不能要求用户先找到专家入口。 */
export function messageNeedsBuiltinPptSkill(text: string): boolean {
  return /(?:\b(?:ppt|pptx)\b|幻灯片|演示文稿|\b(?:pitch|slide)\s+deck\b)/i.test(
    text,
  );
}

const GENERIC_SESSION_TITLES = new Set([
  '新会话',
  '新对话',
  '新会话…',
  '新对话…',
]);

function deriveWorkTitle(
  sessionTitle: string | undefined,
  userInput: string,
): string {
  const firstSentence = userInput.split(/[。！？!?\n]/)[0]?.trim() || '';
  const isFollowUp =
    /^(继续|好的?|可以|确认|开始|按这个来|就这样|下一步)$/i.test(firstSentence);
  if (firstSentence.length >= 4 && !isFollowUp)
    return firstSentence.slice(0, 60);
  const cleanSessionTitle = sessionTitle?.trim();
  if (cleanSessionTitle && !GENERIC_SESSION_TITLES.has(cleanSessionTitle)) {
    return cleanSessionTitle.slice(0, 60);
  }
  return (firstSentence || '本轮工作').slice(0, 60);
}

function inferWorkResultCategory(text: string): LogCategory {
  if (/调研|竞品|搜索|网页|网站|资料/.test(text)) return 'web';
  if (/报告|文档|公文|方案|PPT|幻灯片/.test(text)) return 'document';
  if (/表格|Excel|数据清洗|透视/.test(text)) return 'spreadsheet';
  if (/代码|开发|修复|测试|重构|接口/.test(text)) return 'code';
  if (/会议|日程|日历/.test(text)) return 'calendar';
  if (/邮件/.test(text)) return 'email';
  if (/任务|待办/.test(text)) return 'task';
  return 'other';
}

/** Runtime 只依赖这一条窄接口，单测可验证真实落日志时机且不碰用户目录。 */
export interface WorkResultLogEntry {
  toolName: string;
  action: string;
  category: LogCategory;
  success: boolean;
  details?: string;
  sessionId?: string;
  projectRoot?: string;
  entryType: 'work_result';
  taskTitle: string;
  userInput: string;
}

export interface WorkResultLogger {
  log(entry: WorkResultLogEntry): Promise<void>;
}

/** 从一条流式响应里抽取可流式输出的文本（跳过 thought 片段）。 */
/**
 * 把 core 的流式响应 usageMetadata 转成协议的 TokenUsage（chat_complete 帧用）。
 * 覆盖式取值：流的最后一个带 usageMetadata 的 chunk 即代表本轮全量用量
 * （与 core turn.ts 对同一字段的处理方式一致，不是逐 chunk 累加）。
 */
function toProtocolTokenUsage(
  usage: GenerateContentResponse['usageMetadata'] | undefined,
  modelName: string,
): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    model: modelName,
  };
}

function extractStreamText(resp: GenerateContentResponse): string | null {
  const candidate = resp.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!parts || parts.length === 0) return null;
  // 与 nonInteractiveCli getResponseText 一致：首片段是 thought 时整体跳过。
  if (parts[0]?.thought) return null;
  const text = parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join('');
  return text.length > 0 ? text : null;
}

/** 把 executeToolCall 的 resultDisplay 规整成字符串（用于 ToolCall.result）。 */
function resultDisplayToString(display: unknown): string {
  if (display == null) return '';
  if (typeof display === 'string') return display;
  try {
    return JSON.stringify(display);
  } catch {
    return String(display);
  }
}

/** 当前轮仍未收口的工具状态；background 已脱离本轮，不阻塞会话。 */
function isToolCallInFlight(status: ToolCallStatus): boolean {
  return (
    status !== ToolCallStatus.Success &&
    status !== ToolCallStatus.Error &&
    status !== ToolCallStatus.Canceled &&
    status !== ToolCallStatus.BackgroundRunning
  );
}

/** 把尚未收口的工具卡转为明确的取消终态，已完成卡保持原样。 */
function cancelToolCall(card: ToolCall): ToolCall {
  if (!isToolCallInFlight(card.status)) return card;
  return {
    ...card,
    status: ToolCallStatus.Canceled,
    result: {
      success: false,
      error: '用户已停止生成',
      executionTime: card.startTime
        ? Math.max(0, Date.now() - card.startTime)
        : 0,
      toolName: card.toolName,
    },
    endTime: Date.now(),
  };
}

/** 一次工具确认应答（answers 等经 payload 回传）。 */
interface ConfirmationResult {
  outcome: 'approved' | 'rejected' | 'always_approve';
  payload?: ToolConfirmationResponsePayload;
}

export interface CoreSessionRuntimeOptions {
  /** A2A 等不可信远端输入必须在运行时硬性禁止工具，而不是依赖提示词。 */
  toolFree?: boolean;
  /** 注入持久恢复存储；false 明确关闭（测试或无状态嵌入场景）。 */
  recoveryStore?: FileTurnRecoveryStore | false;
}

export class CoreSessionRuntime implements SessionRuntime {
  private toolRegistry?: ToolRegistry;
  private abort?: AbortController;
  private running = false;
  private authorizationMode: RuntimeAuthorizationMode = 'manual';
  /** Active semantic turn; one runtime never runs two turns concurrently. */
  private activeTurnTracker?: AgentTurnTracker;
  private activeConstraints?: TurnConstraintGuard;
  private activeDeliveryRepair?: DeliveryRepairGuard;
  private activeTurnControl?: TurnControlPolicy;
  private readonly recoveryStore?: FileTurnRecoveryStore;
  private pendingRecovery: TurnRecoveryRecord | null = null;
  private activeRecovery?: TurnRecoveryRecord;
  private continuity?: TaskContinuityLedger;
  private steeringApplying = false;
  private steeringPersistence: Promise<void> = Promise.resolve();
  private steeringPersistenceFailed = false;
  private steeringBlocked = new Set<string>();
  private steeringClosed = true;

  private get steeringFence(): boolean { return !!this.continuity?.pending || this.steeringApplying || this.steeringPersistenceFailed; }
  async steer(input: TurnSteeringRequest): Promise<SteeringReceipt> {
    if (!this.running || !this.continuity || this.steeringClosed || this.continuity.request.source !== 'local' || this.abort?.signal.aborted) throw new Error('No running local turn available for steering');
    const receipt = this.continuity.accept(input); // synchronous fence before any persistence await
    for (const resolve of this.pendingConfirmations.values()) resolve({ outcome: 'rejected' });
    this.pendingConfirmations.clear();
    this.steeringPersistence = this.persistContinuity().catch(error => { this.steeringPersistenceFailed = true; throw error; });
    await this.steeringPersistence;
    this.store.publish(this.sessionId, { type: 'turn_steering', payload: { sessionId: this.sessionId, ...receipt } });
    return receipt;
  }
  private async persistContinuity(): Promise<void> {
    if (this.recoveryStore && this.activeRecovery && this.continuity) this.activeRecovery =
      await this.recoveryStore.recordContinuity(this.activeRecovery, this.continuity.snapshot(), this.activeConstraints?.snapshot(), this.activeTurnTracker?.taskGraphSnapshot(), this.activeTurnTracker?.nativeCheckpoint(), this.activeDeliveryRepair?.budgetSnapshot());
  }
  /**
   * 挂起中的工具确认：callId → resolver。AskUserQuestion 弹卡后在此登记，
   * server 收到 tool_confirmation_response 调 resolveToolConfirmation 唤醒。
   */
  private pendingConfirmations = new Map<
    string,
    (result: ConfirmationResult) => void
  >();

  constructor(
    private readonly store: SessionStore,
    private readonly sessionId: string,
    private readonly config: Config,
    private readonly workLogger: WorkResultLogger = getWorkLogger(),
    private readonly options: CoreSessionRuntimeOptions = {},
  ) {
    this.recoveryStore =
      options.recoveryStore === false
        ? undefined
        : (options.recoveryStore ??
          (process.env.NODE_ENV === 'test'
            ? undefined
            : new FileTurnRecoveryStore()));
  }

  /**
   * 初始化 core：config.initialize() + refreshAuth（USE_PROXY_AUTH，自定义模型走此鉴权）。
   * MCP 工具发现 best-effort：失败不阻塞会话可用（与 nonInteractiveCli 等价但更宽容）。
   */
  async initialize(): Promise<void> {
    await this.config.initialize();
    // 自定义模型（BYO-key）经 USE_PROXY_AUTH 鉴权，对齐 validateNonInteractiveAuth。
    await this.config.refreshAuth(AuthType.USE_PROXY_AUTH);
    this.toolRegistry = await this.config.getToolRegistry();
    if (this.recoveryStore) {
      this.pendingRecovery = await this.recoveryStore.recoverInterrupted(
        this.sessionId,
      );
    }
    // 默认使用 coreConfig 的 YOLO 模式（自动执行），
    // 用户可通过 /confirm 命令切回手动确认模式。
    // this.config.setApprovalMode?.(ApprovalMode.DEFAULT);
    // 同步 MCP 工具（若已配置）。失败仅告警，不阻塞。
    if (!this.options.toolFree) {
      try {
        await this.toolRegistry.discoverMcpTools();
      } catch {
        // MCP 不可用不影响纯对话与内置工具。
      }
    }
  }

  setAuthorizationMode(mode: RuntimeAuthorizationMode): void {
    this.authorizationMode = mode;
    // 保持当前的 approval mode，不覆盖——用户可能已切到手动模式
    // this.config.setApprovalMode?.(ApprovalMode.DEFAULT);
  }

  async setModel(model: string): Promise<void> {
    // 不能只改 Config：OttoChat 会缓存 specifiedModel，真实出网请求仍会走旧模型。
    // 统一走 core 的 switchModel，让 Config、live chat、工具与系统提示词一起切换。
    const result = await this.config
      .getOttoClient()
      .switchModel(model, new AbortController().signal);
    if (!result.success) {
      throw new Error(result.error || `无法切换到模型 ${model}`);
    }
  }

  async generateTitle(firstUserMessage: string): Promise<string> {
    const temporaryChat = await this.config
      .getOttoClient()
      .createTemporaryChat(
        SceneType.CONTENT_SUMMARY,
        undefined,
        { type: 'sub', agentId: 'SessionTitle' },
        { emptySystemPrompt: true },
      );
    const response = await temporaryChat.sendMessage(
      {
        message: [
          '请根据用户的第一条消息，为这段对话生成一个简洁、准确的中文标题。',
          '',
          '要求：',
          '1. 标题以 4～12 个汉字为宜，总长度不超过 24 个字符。',
          '2. 直接概括用户的核心意图或任务。',
          '3. 产品名、API 名、型号和版本号可保留必要的英文、数字；除此之外使用中文。',
          '4. 不使用句末标点、引号或 Markdown。',
          '5. 不使用“关于”“咨询”“问题”“新会话”等空泛表达。',
          '6. 只输出标题，不要解释。',
          '',
          '用户消息：',
          firstUserMessage,
        ].join('\n'),
        config: {
          maxOutputTokens: 32,
          temperature: 0.2,
        },
      },
      `session-title-${this.sessionId}-${Date.now()}`,
      SceneType.CONTENT_SUMMARY,
    );
    return extractStreamText(response)?.trim() ?? '';
  }

  /** 供 server.ts 的 GUI 面板 handler 只读查询/即时应用设置（context 分解/mcp/healthyUse 等）。 */
  getConfig(): Config {
    return this.config;
  }

  cancel(): void {
    this.abort?.abort();
  }

  private publishRuntimeActivity(
    kind: 'agent' | 'tool' | 'turn',
    state:
      | 'started'
      | 'streaming'
      | 'awaiting_confirmation'
      | 'completed'
      | 'cancelled'
      | 'failed',
    detail?: string,
  ): void {
    this.store.publish(this.sessionId, {
      type: 'runtime_activity',
      payload: {
        contractVersion: 1,
        sessionId: this.sessionId,
        kind,
        state,
        detail,
        timestamp: Date.now(),
      },
    });
  }

  /**
   * 回传一个待确认工具的应答，唤醒 runToolCalls 里挂起的等待。
   * callId 无对应挂起时静默忽略（幂等：迟到 / 重复应答无害）。
   */
  resolveToolConfirmation(
    callId: string,
    outcome: 'approved' | 'rejected' | 'always_approve',
    payload?: ToolConfirmationResponsePayload,
  ): void {
    const done = this.pendingConfirmations.get(callId);
    if (!done) return;
    done({ outcome, payload });
  }

  async dispose(): Promise<void> {
    this.abort?.abort();
    // 释放前唤醒所有挂起的问答等待，避免 await 永久悬挂（视作用户取消）。
    for (const done of this.pendingConfirmations.values()) {
      done({ outcome: 'rejected' });
    }
    this.pendingConfirmations.clear();
    // core Config 目前无显式 close；GC 即可。预留 hook（TODO：若 core 增 dispose 在此调）。
  }

  /**
   * 跑一整轮对话（可能多回合工具往返）。
   * 期间所有流式/工具事件经 store.publish 广播；不写 stdout。
   */
  async run(
    input: MessageContent,
    source: MessageSource,
    context?: { userMessageId: string },
  ): Promise<void> {
    if (this.running) {
      // 同一会话已有一轮在跑：拒绝并行（保护 core chat 历史一致性）。
      this.store.publish(this.sessionId, {
        type: 'error',
        payload: {
          sessionId: this.sessionId,
          code: 'busy',
          message: '该会话正在生成回复，请稍候或先取消。',
        },
      });
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const promptId = `${this.sessionId}-${Date.now()}`;

    if (!this.toolRegistry) {
      // initialize 未成功：直接报错收口，避免 NPE。
      this.fail('not_initialized', 'core 运行时未初始化');
      this.running = false;
      return;
    }
    const toolRegistry = this.toolRegistry;
    // Keep existing recovery intent hashes stable; preserve line breaks separately
    // for exact request citations and explicitly listed acceptance requirements.
    const intentHash = turnIntentHash(messageContentToText(input));
    let recovery = this.pendingRecovery;
    // The server identifies the actual user message separately from retrieved
    // enterprise documents prepended to the model input. Those are not authority.
    const history = this.store.getHistory(this.sessionId, 200);
    const userMessage = context
      ? history.find(
          (message) =>
            message.id === context.userMessageId &&
            message.role === 'user' &&
            message.source === source,
        )
      : undefined;
    const submittedText = messageContentToParts(userMessage?.content ?? input)
      .map((part) => part.text ?? '')
      .filter(Boolean)
      .join('\n');
    const recoveredContinuity = recovery?.continuity ? TaskContinuityLedger.restore(recovery.continuity) : undefined;
    const resumeUtterance = /^(?:继续(?:吧|执行|处理)?|接着(?:执行|处理)?|continue|proceed)[。.!！]?$/iu.test(submittedText.trim());
    const workspacePath = this.store.getSession(this.sessionId)?.workspacePath;
    const validOrigin = !context || !!userMessage;
    const canResume = recoveredContinuity && validOrigin && source === 'local' && recoveredContinuity.request.source === source &&
      recoveredContinuity.request.workspacePath === workspacePath && (resumeUtterance || recoveredContinuity.request.text === submittedText || recovery?.intentHash === intentHash);
    if (recovery && ((recoveredContinuity && !canResume) || (!recoveredContinuity && recovery.intentHash !== intentHash))) {
      this.fail('recovery_reconciliation_required', '上一项任务仍有未完成工作或待核对的执行结果。请明确继续原任务，或先核对并结束其恢复记录。');
      this.running = false; this.abort = undefined; return;
    }
    let requestResolution = resolveTurnRequest({
      text: submittedText,
      source,
      history,
      workspacePath: this.store.getSession(this.sessionId)?.workspacePath,
      ...(context
        ? {
            currentUserMessageId: userMessage?.id ?? '__missing_user_message__',
          }
        : {}),
    });
    if (canResume && recoveredContinuity) {
      requestResolution = { kind: 'continued', request: recoveredContinuity.request };
      // The ledger was committed before the WS acknowledgement. Recreate a
      // missing display message after a crash, never resend an external action.
      for (const event of recoveredContinuity.snapshot().events) {
        if (!history.some(message => message.id === event.clientMessageId)) {
          const message = this.store.appendMessage(this.sessionId, { id: event.clientMessageId, role: 'user', source: 'local',
            turnId: recovery!.turnId, content: [{ type: 'text', value: event.text }], timestamp: event.acceptedAt });
          this.store.publish(this.sessionId, { type: 'message_start', payload: { message } });
        }
      }
      if (recoveredContinuity.paused && !recoveredContinuity.pending && resumeUtterance) recoveredContinuity.accept({
        version: 1, turnId: recovery!.turnId, expectedRevision: recoveredContinuity.revision,
        clientMessageId: context?.userMessageId ?? randomUUID(), mode: 'append', text: '继续当前任务。',
      });
    }
    if (requestResolution.kind === 'clarify') {
      try {
        const tracker = new AgentTurnTracker(
          this.store,
          this.sessionId,
          undefined,
          {
            request: requestResolution.request,
          },
        );
        const message = this.store.appendMessage(this.sessionId, {
          role: 'assistant',
          source: 'local',
          isStreaming: false,
          content: [{ type: 'text', value: requestResolution.question }],
          turnId: tracker.snapshot().turnId,
        });
        this.store.publish(this.sessionId, {
          type: 'message_start',
          payload: { message },
        });
        tracker.attachAssistantMessage(message.id);
        tracker.requestClarification(requestResolution.question);
        this.store.publish(this.sessionId, {
          type: 'chat_complete',
          payload: {
            sessionId: this.sessionId,
            messageId: message.id,
            text: requestResolution.question,
            finishReason: 'stop',
          },
        });
        this.store.setStatus(this.sessionId, 'idle');
      } finally {
        this.running = false;
        this.abort = undefined;
      }
      return;
    }
    let taskText = requestResolution.request.text;
    if (this.recoveryStore && !recovery) {
      recovery = await this.recoveryStore.begin({
        sessionId: this.sessionId,
        turnId: randomUUID(),
        intentHash,
      });
    }
    this.pendingRecovery = null;
    this.activeRecovery = recovery ?? undefined;
    let turnControl = deriveTurnControlPolicy({
      text: taskText,
      source,
      toolFree: Boolean(this.options.toolFree),
    });
    let turnTracker: AgentTurnTracker;
    try {
      turnTracker = new AgentTurnTracker(
        this.store,
        this.sessionId,
        turnControl,
        {
          taskText,
          request: requestResolution.request,
          ...(requestResolution.kind === 'continued' &&
          requestResolution.contract
            ? { taskContractSnapshot: requestResolution.contract }
            : {}),
          ...(recovery
            ? {
                turnId: recovery.turnId,
                attempt: recovery.attempt,
                ...(recovery.taskGraph && (!recoveredContinuity || recovery.taskGraphRequestRevision === recoveredContinuity.request.revision)
                  ? { taskGraphSnapshot: recovery.taskGraph }
                  : {}),
              }
            : {}),
        },
      );
      if (recoveredContinuity && recovery?.nativeEvidence) turnTracker.restoreNativeCheckpoint(recovery.nativeEvidence);
    } catch {
      const reason = '上次任务图无法安全恢复，需要核对已执行操作';
      if (this.recoveryStore && recovery) {
        recovery = await this.recoveryStore.markReconciliationRequired(
          recovery,
          reason,
        );
        this.activeRecovery = recovery;
      }
      turnTracker = new AgentTurnTracker(
        this.store,
        this.sessionId,
        turnControl,
        {
          taskText,
          request: requestResolution.request,
          ...(recovery
            ? { turnId: recovery.turnId, attempt: recovery.attempt }
            : {}),
        },
      );
    }
    if (this.recoveryStore && recovery) {
      recovery = await this.recoveryStore.recordTaskGraph(
        recovery,
        turnTracker.taskGraphSnapshot(),
      );
      this.activeRecovery = recovery;
    }
    const adaptiveExecution = new AdaptiveExecutionCoordinator();
    let constraints = new TurnConstraintGuard(taskText, {
      turnId: turnTracker.snapshot().turnId,
      sourceMessageId: context?.userMessageId,
      workspacePath: requestResolution.request.workspacePath,
    });
    // A recovered turn without the complete native trace is not negative evidence.
    if (recoveredContinuity && recovery?.constraints) constraints.inherit(recovery.constraints, true);
    else if ((recovery?.attempt ?? 1) > 1) constraints.markGap();
    const safeText = (text: string) => constraints.sanitize(text);
    const deliveryClosure = new DeliveryClosure();
    let closingDelivery = false;
    const deliveryRepair = new DeliveryRepairGuard(turnTracker.repairContext());
    if (recovery?.repairBudget) deliveryRepair.restoreBudget(recovery.repairBudget);
    this.activeDeliveryRepair = deliveryRepair;
    const partialDeliveries: string[] = [];
    if (recovery?.status === 'reconciliation_required') {
      turnTracker.markReconciliationRequired(
        recovery.reconciliationReason || '上次执行结果未知，禁止自动重放',
      );
    }
    this.activeTurnTracker = turnTracker;
    this.activeTurnControl = turnControl;
    this.continuity = recoveredContinuity ?? new TaskContinuityLedger(turnTracker.snapshot().turnId, requestResolution.request);
    this.steeringClosed = false;
    this.steeringPersistenceFailed = false;
    this.steeringPersistence = Promise.resolve();
    this.steeringBlocked.clear();

    // 自然语言“做 PPT”与 /ppt、专家卡片走同一内置 Skill。直接更新 system
    // instruction，不把可靠性寄托在模型是否记得调用 use_skill。
    if (messageNeedsBuiltinPptSkill(taskText)) {
      const currentRules = this.config.getUserRules();
      const marker = '<skill_loaded name="ppt-creator" source="otto-builtin">';
      if (!currentRules.includes(marker)) {
        const skill = loadBuiltinSkillInstructions('ppt-creator')?.trim();
        if (skill) {
          this.config.setUserRules(
            [
              currentRules,
              '## Otto 内置强制 Skill：ppt-creator',
              '以下完整 Skill 已由 Otto 在系统层直接加载。不要再次调用 use_skill，也不得跳过、缩写或改用快速模板；必须按其工作流执行。',
              marker,
              skill,
              '</skill_loaded>',
            ]
              .filter(Boolean)
              .join('\n\n'),
          );
          try {
            await this.config
              .getOttoClient()
              .updateSystemPromptWithMcpPrompts();
          } catch {
            // 动态刷新失败不让本轮对话直接报错；专家 profile 路径仍在初始化时注入。
          }
        }
      }
    }

    const chat = await this.config.getOttoClient().getChat();
    const modelName = this.config.getModel();
    const caps = getModelCapabilities(modelName);

    const directiveLedger = new TurnDirectiveLedger();
    let modelRequests = 0;
    const continuationContext =
      requestResolution.kind === 'continued'
        ? `原始用户任务（本轮继续其未完成工作，旧回执不代表本轮验证，仍须遵守当前授权）：\n${JSON.stringify(taskText)}`
        : '';
    const runtimeDirective = (includeGraph = false): string => {
      const contract = turnTracker.taskContractInstructions();
      // Read only user-role context: model/tool output is not runtime metadata.
      const retained =
        typeof chat.getUserTextHistory === 'function'
          ? chat.getUserTextHistory()
          : typeof chat.getHistory === 'function'
            ? chat
                .getHistory(true)
                .filter((entry) => entry.role === MESSAGE_ROLES.USER)
                .flatMap(
                  (entry) =>
                    entry.parts?.flatMap((part) =>
                      part.text ? [part.text] : [],
                    ) ?? [],
                )
            : undefined;
      const control = formatTurnControlDirective(turnControl);
      const delta = directiveLedger.update(
        {
          control,
          rules: contract.rules,
          request: this.continuity && ((this.continuity.request.revision ?? 1) > 1 || !!recoveredContinuity ||
            (modelRequests > 0 && retained !== undefined && !retained.some(entry => entry.includes(taskText))))
            ? this.continuity.directive() : continuationContext,
          state: contract.state,
        },
        retained,
      );
      // Rehydrate the CURRENT graph after context loss, never a cached old plan.
      return [
        delta,
        includeGraph || delta.includes(control)
          ? turnTracker.taskGraphDirective()
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    };

    // 首轮 user message：把协议 content 构造成 core Part[]（文本 + 图片 inlineData）。
    const turnDirective = runtimeDirective(true);
    let currentMessages: Content[] = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          ...(turnDirective ? [{ text: turnDirective }] : []),
          ...messageContentToParts(input),
        ],
      },
    ];

    // 本轮 assistant 消息：先落一条占位（isStreaming），后续 chunk 增量填充。
    let assistantId: string | null = null;
    let assistantText = '';
    // Tool calls may arrive after text in the same model stream. Lexical intent
    // (especially a short continuation) cannot prove that this is a final answer.
    // Only an explicitly tool-free turn can stream before the native gate;
    // other drafts stay private, including history reloads, errors and cancels.
    let deferAssistantText =
      !this.options.toolFree ||
      turnControl.requiresVerification ||
      constraints.protectsOutput ||
      turnControl.requiresPlan;
    // cancel() 必须立即让 UI 收口，不能等一个忽略 AbortSignal 的工具自行返回。
    // 后续循环仍会检查 signal；此闸门保证 chat_complete(cancelled) 只发布一次。
    let cancellationPublished = false;
    const publishCancellation = (): void => {
      if (cancellationPublished) return;
      cancellationPublished = true;
      if (constraints.snapshot().pending.length) constraints.markGap();
      turnTracker.updateConstraints(constraints, safeText(assistantText));
      this.onCancelled(
        assistantId,
        safeText(deferAssistantText
          ? [
              '本轮已停止，尚未完成验收。',
              unverifiedDeliveryText(assistantText),
            ]
              .filter(Boolean)
              .join('\n\n')
          : assistantText),
      );
    };
    const onAbort = (): void => publishCancellation();
    signal.addEventListener('abort', onAbort, { once: true });

    const startAssistant = (): string => {
      const msg = this.store.appendMessage(this.sessionId, {
        role: 'assistant',
        content: [{ type: 'text', value: '' }],
        source: 'local',
        isStreaming: true,
        modelName,
        turnId: turnTracker.snapshot().turnId,
      });
      this.store.publish(this.sessionId, {
        type: 'message_start',
        payload: { message: msg },
      });
      turnTracker.attachAssistantMessage(msg.id);
      return msg.id;
    };

    let releaseConstraintGuard: (() => void) | undefined;
    const applySteering = async (): Promise<boolean> => {
      if (!this.continuity?.pending) return false;
      this.steeringApplying = true;
      try {
        let writing: Promise<void>;
        do { writing = this.steeringPersistence; await writing; } while (writing !== this.steeringPersistence);
        if (this.steeringPersistenceFailed) throw new Error('Steering persistence failed; execution stopped');
        const previousConstraints = constraints.snapshot();
        const receipts = this.continuity.apply();
        const request = this.continuity.request;
        taskText = request.text;
        turnControl = deriveTurnControlPolicy({ text: taskText, source, toolFree: Boolean(this.options.toolFree) });
        turnTracker.reviseRequest(request, turnControl);
        deliveryRepair.revise(turnTracker.repairContext());
        constraints = new TurnConstraintGuard(taskText, { turnId: turnTracker.snapshot().turnId, workspacePath: request.workspacePath, sourceMessageId: receipts.at(-1)?.clientMessageId });
        constraints.inherit(previousConstraints);
        this.activeConstraints = constraints;
        this.activeTurnControl = turnControl;
        turnTracker.updateConstraints(constraints, '');
        await this.persistContinuity();
        for (const receipt of receipts) this.store.publish(this.sessionId, { type: 'turn_steering', payload: { sessionId: this.sessionId, ...receipt } });
        if (this.continuity.paused) { this.cancel(); return true; }
        closingDelivery = false;
        deferAssistantText = true;
        return true;
      } finally { this.steeringApplying = false; }
    };
    try {
      this.activeConstraints = constraints;
      releaseConstraintGuard = installTurnExecutionGuard(this.config, call => {
        if (this.steeringFence) { this.steeringBlocked.add(call.callId); throw new Error('Current request changed; old dispatch cancelled'); }
        constraints.review(call);
        if (!deliveryRepair.validateReserved(call.callId, call)) throw new Error('Repair target or authority changed before native dispatch');
      });
      constraints.coverageStarted();
      turnTracker.updateConstraints(constraints, '');
      await this.persistContinuity();
      this.store.setStatus(this.sessionId, 'thinking');
      this.publishRuntimeActivity('turn', 'started');
      let turnCount = 0;
      let toolCallCount = 0;
      let replanCount = 0;
      const configuredMaxTurns = this.config.getMaxSessionTurns();
      let admittedMaxTurns = turnControl.complexity.budget.maxModelRounds;

      // 多回合工具往返循环（移植自 nonInteractiveCli）。
      // 每一轮：流式拿文本+functionCalls；有工具则执行并回灌，无工具则收口。
      while (true) {
        if (await applySteering()) {
          if (assistantId) this.store.patchMessage(this.sessionId, assistantId, { isStreaming: false, content: [{ type: 'text', value: '' }] });
          assistantId = null; assistantText = '';
          currentMessages = [{ role: MESSAGE_ROLES.USER, parts: [
            ...(currentMessages[0]?.parts ?? []).filter(part => !!part.functionResponse), { text: runtimeDirective(true) },
          ] }];
        }
        admittedMaxTurns = Math.max(admittedMaxTurns, turnControl.complexity.budget.maxModelRounds);
        const routedMaxTurns = admittedMaxTurns;
        const maxTurns =
          configuredMaxTurns > 0
            ? Math.min(configuredMaxTurns, routedMaxTurns)
            : routedMaxTurns;
        turnCount++;
        if (turnCount > maxTurns) {
          const message = `本轮执行已达到模型回合预算（${maxTurns}），已安全停止。`;
          this.fail('max_turns', message);
          turnTracker.fail(message);
          this.publishRuntimeActivity('turn', 'failed', message);
          break;
        }
        if (signal.aborted) {
          publishCancellation();
          break;
        }

        // 本轮一开始就落一条 assistant 占位（isStreaming=true、正文暂空）：让渲染层在
        // 等待 LLM 首个 token 期间就显示"思考中"三点跳动，而不是空白→正文突然蹦出。
        // 多回合工具往返里每轮都补一次（上一轮工具执行后 assistantId 会被重置为 null）。
        if (assistantId === null) {
          assistantId = startAssistant();
        }

        const functionCalls: FunctionCall[] = [];
        let lastFinishReason: FinishReason | undefined;
        let lastUsage: GenerateContentResponse['usageMetadata'] | undefined;

        while (true) {
          try {
            // Compression is a projection, never authority. Rehydrate the latest
            // native revision if model history dropped it, without a second loop/store.
            const refresh = runtimeDirective();
            if (refresh && !(currentMessages[0]?.parts ?? []).some(p => p.text?.includes(refresh)))
              currentMessages[0].parts = [...(currentMessages[0].parts ?? []), { text: refresh }];
            const routedRequest = {
              message: currentMessages[0]?.parts ?? [],
              runtimeControl: {
                allowWorkflow: turnControl.complexity.exposesWorkflowTool,
              },
              config: {
                abortSignal: signal,
                tools: this.options.toolFree
                  ? []
                  : [
                      {
                        functionDeclarations: [
                          ...toolRegistry
                            .getFunctionDeclarations()
                            .filter(
                              (declaration) =>
                                ![TASK_PLAN_TOOL_NAME, REPAIR_PLAN_TOOL_NAME, REPAIR_FORMAT_TOOL_NAME, CLAIM_REVIEW_TOOL_NAME].includes(declaration.name ?? ''),
                            ),
                          TASK_PLAN_DECLARATION,
                          ...(turnTracker.offersClaimReview() ? [CLAIM_REVIEW_DECLARATION] : []),
                          ...(closingDelivery ? REPAIR_TOOL_DECLARATIONS : []),
                        ],
                      },
                    ],
              },
            } as Parameters<typeof chat.sendMessageStream>[0] & {
              runtimeControl: { allowWorkflow: boolean };
            };
            modelRequests++;
            const responseStream = await chat.sendMessageStream(
              routedRequest,
              promptId,
              SceneType.CHAT_CONVERSATION,
            );

            this.store.setStatus(this.sessionId, 'streaming');
            this.publishRuntimeActivity('agent', 'streaming');
            for await (const resp of responseStream) {
              if (signal.aborted) break;
              if (resp.candidates?.[0]?.finishReason) {
                lastFinishReason = resp.candidates[0].finishReason;
              }
              if (resp.usageMetadata) {
                lastUsage = resp.usageMetadata;
              }
              if (resp.functionCalls?.length) deferAssistantText = true;
              const delta = extractStreamText(resp);
              if (delta) {
                if (assistantId === null) {
                  assistantId = startAssistant();
                }
                assistantText += delta;
                turnTracker.markStreaming();
                if (!deferAssistantText) {
                  // 每个 delta 都同步把累积文本落进 store：客户端切走（退订）再切回时
                  // get_history 才能拿到已生成的部分，而不是空占位（否则切走期间的
                  // delta 全部丢失、回复缺头）。不改 isStreaming——收口仍由 patch 定稿。
                  // 持久层对高频 patch 已做去抖合并写盘（WRITE_DEBOUNCE_MS），不会写爆；
                  // patchMessage 不广播，不会产生重复帧。
                  this.store.patchMessage(this.sessionId, assistantId, {
                    content: [{ type: 'text', value: assistantText }],
                  });
                  this.store.publish(this.sessionId, {
                    type: 'chat_chunk',
                    payload: {
                      sessionId: this.sessionId,
                      messageId: assistantId,
                      delta,
                    },
                  });
                }
              }
              if (resp.functionCalls) {
                functionCalls.push(...resp.functionCalls);
              }
            }
            break;
          } catch (error) {
            if (error instanceof ModelRequestSafetyError) {
              if (error.requestState === 'unknown_outcome') {
                throw new ModelOutcomeUnknownError(
                  error.requestId,
                  error,
                  error.providerRequestId,
                );
              }
              throw error;
            }
            if (!signal.aborted && isAmbiguousModelTransportOutcome(error)) {
              throw new ModelOutcomeUnknownError(promptId, error);
            }
            throw error;
          }
        }

        if (signal.aborted) {
          publishCancellation();
          break;
        }

        // tool-free 是服务端安全边界。即使 provider 在未声明工具时仍返回了
        // functionCall，也必须在任何工具卡或执行发生前 fail closed。
        if (this.options.toolFree && functionCalls.length > 0) {
          if (assistantId !== null) {
            this.store.patchMessage(this.sessionId, assistantId, {
              content: [
                { type: 'text', value: unverifiedDeliveryText(assistantText) },
              ],
              isStreaming: false,
              isProcessingTools: false,
            });
          }
          this.fail(
            'tool_free_violation',
            'A2A 安全会话拒绝了模型生成的工具调用。',
          );
          turnTracker.fail('A2A 安全会话拒绝了模型生成的工具调用。');
          break;
        }

        // 无工具调用：本轮即终轮，定稿 assistant 消息并收口。
        if (functionCalls.length === 0) {
          if (await applySteering()) {
            if (assistantId) this.store.patchMessage(this.sessionId, assistantId, { isStreaming: false, content: [{ type: 'text', value: '' }] });
            assistantId = null; assistantText = '';
            currentMessages = [{ role: MESSAGE_ROLES.USER, parts: [{ text: runtimeDirective(true) }] }];
            continue;
          }
          assistantText = safeText(assistantText);
          turnTracker.setDeliveryDraft(assistantText);
          if (assistantId === null) {
            // 模型一句话都没出（极少见）：补一条空 assistant 以保 UI 一致。
            assistantId = startAssistant();
          }
          turnTracker.completeAssistantMessage(Boolean(assistantText.trim()));
          if (constraints.needsManualReview && source === 'local' && !signal.aborted) {
            const review = constraints.prepareReview(assistantText);
            if (review) {
              const waiting = this.waitForConfirmation(review.id, signal);
              const card: ToolCall = { id: review.id, toolName: 'otto_delivery_review', displayName: '确认当前交付',
                parameters: {}, status: ToolCallStatus.WaitingForConfirmation,
                confirmationDetails: { type: 'info', title: '请核对当前交付', requiresConfirmation: true,
                  message: safeText(`此确认仅适用于下面这版内容和文件，不会批准工具操作或改变原有约束。\n\n${assistantText}`) } };
              const reviewCards = new Map([[review.id, card]]);
              this.publishToolCards(reviewCards, assistantId);
              this.store.publish(this.sessionId, { type: 'tool_confirmation_request',
                payload: { sessionId: this.sessionId, callId: review.id, toolCall: card } });
              const result = await waiting;
              const approved = constraints.confirmReview(review.id, assistantText, result.outcome === 'approved' && !signal.aborted);
              reviewCards.set(review.id, { ...card, status: approved ? ToolCallStatus.Success : ToolCallStatus.Canceled,
                confirmationDetails: undefined, result: { success: approved, toolName: card.toolName, executionTime: 0,
                  data: approved ? '当前交付已获人工确认' : '当前交付未获有效人工确认' } });
              this.publishToolCards(reviewCards, assistantId);
              if (signal.aborted) { publishCancellation(); break; }
            }
          }
          turnTracker.updateConstraints(constraints, assistantText);
          await turnTracker.prepareDeliveryEvidence();
          if (signal.aborted) { publishCancellation(); break; }
          // A user edit may arrive during manual review or asynchronous format validation.
          if (this.steeringFence) continue;
          await this.persistContinuity();
          if (this.steeringFence) continue;
          const readiness = turnTracker.deliveryReadiness();
          if (
            deliveryClosure.next(readiness, {
              remainingRounds: maxTurns - turnCount,
              toolFree: Boolean(this.options.toolFree),
              restricted:
                turnControl.executionMode === 'restricted' ||
                ['external_write', 'destructive'].includes(
                  turnControl.riskLevel,
                ),
            })
          ) {
            closingDelivery = true;
            turnTracker.recordDeliveryClosure();
            // Replace the provisional success statement; never notify clients of
            // completion before the native gate has accepted the delivery.
          const partial = retainedDeliveryDraft(assistantText);
            if (partial) partialDeliveries.push(partial);
            const progress = safeText([
              '还有验收项需要核对，我会继续检查。',
              ...(partial ? ['以下工作说明暂未通过整体验收：', partial] : []),
            ].join('\n\n'));
            this.store.patchMessage(this.sessionId, assistantId, {
              content: [{ type: 'text', value: progress }],
              isStreaming: false,
              phase: 'commentary',
            });
            this.store.publish(this.sessionId, {
              type: 'chat_complete',
              payload: {
                sessionId: this.sessionId,
                messageId: assistantId,
                text: progress,
                tokenUsage: toProtocolTokenUsage(lastUsage, modelName),
                phase: 'commentary',
              },
            });
            const closureState = runtimeDirective();
            currentMessages = [
              {
                role: MESSAGE_ROLES.USER,
                parts: [
                  { text: deliveryClosureDirective(readiness) },
                  ...(closureState ? [{ text: closureState }] : []),
                ],
              },
            ];
            assistantId = null;
            assistantText = '';
            continue;
          }
          this.steeringClosed = true; // no await between final gate and closing steering
          turnTracker.complete();
          const finalTurn = turnTracker.snapshot();
          const succeeded = finalTurn.status === 'completed';
          if (!succeeded) {
            assistantText = incompleteDelivery(
              [
                ...new Set([
                  ...partialDeliveries,
                  retainedDeliveryDraft(assistantText),
                ]),
              ]
                .filter(Boolean)
                .join('\n\n'),
              turnTracker.deliveryReadiness(),
              finalTurn.artifacts,
            );
          }
          assistantText = safeText(assistantText);
          this.store.patchMessage(this.sessionId, assistantId, {
            content: [{ type: 'text', value: assistantText }],
            isStreaming: false,
            phase: 'final_answer',
          });
          this.store.publish(this.sessionId, {
            type: 'chat_complete',
            payload: {
              sessionId: this.sessionId,
              messageId: assistantId,
              finishReason: lastFinishReason
                ? String(lastFinishReason)
                : undefined,
              tokenUsage: toProtocolTokenUsage(lastUsage, modelName),
              // 带定稿全文：切走期间丢过 chunk 的客户端据此对账自愈（补缺头）。
              text: assistantText,
              phase: 'final_answer',
            },
          });
          // A2A 输入来自其他员工。tool-free 会话不仅不能调用工具，也不能把
          // 远端问题写进本机工作日志或触发 AutoSkill/习惯分析等状态变化。
          if (!this.options.toolFree) {
            await this.recordWorkResult(input, assistantText, succeeded);
          }

          this.store.setStatus(this.sessionId, 'idle');
          this.publishRuntimeActivity(
            'turn',
            succeeded ? 'completed' : 'failed',
            finalTurn.outcome?.type === 'incomplete'
              ? finalTurn.outcome.reason
              : undefined,
          );
          break;
        }

        // 有工具调用：定稿当前 assistant 文本段（若有），再执行工具并回灌。
        if (assistantId !== null) {
          turnTracker.completeAssistantMessage(Boolean(assistantText.trim()));
          const progressText = safeText(unverifiedDeliveryText(assistantText));
          this.store.patchMessage(this.sessionId, assistantId, {
            content: [{ type: 'text', value: progressText }],
            isStreaming: false,
            isProcessingTools: true,
            phase: 'commentary',
          });
          this.store.publish(this.sessionId, {
            type: 'chat_complete',
            payload: {
              sessionId: this.sessionId,
              messageId: assistantId,
              tokenUsage: toProtocolTokenUsage(lastUsage, modelName),
              // 同收口处：带定稿全文供客户端对账自愈。
              text: progressText,
              phase: 'commentary',
            },
          });
        }

        // 小模型格式容错（移植自 nonInteractiveCli）。
        let processed = functionCalls;
        if (caps.needsFormatTolerance) {
          const incomplete =
            caps.proneToIncompleteStream &&
            appearIncompleteFromStreaming(functionCalls, modelName);
          if (
            !areAllFunctionCallsValid(functionCalls, modelName) ||
            incomplete
          ) {
            processed = fixAllFunctionCalls(functionCalls, modelName);
          }
        }

        const remainingToolCalls =
          turnControl.complexity.budget.maxToolCalls - toolCallCount;
        if (processed.length > remainingToolCalls) {
          const message = `本轮工具调用将超出执行预算（${turnControl.complexity.budget.maxToolCalls}），未执行超额调用。`;
          if (assistantId !== null) {
            this.store.patchMessage(this.sessionId, assistantId, {
              isStreaming: false,
              isProcessingTools: false,
              toolsCompleted: true,
            });
          }
          this.fail('execution_budget_exceeded', message);
          turnTracker.fail(message);
          this.publishRuntimeActivity('turn', 'failed', message);
          break;
        }
        toolCallCount += processed.length;

        const toolMessageId = assistantId ?? startAssistant();
        assistantId = toolMessageId;
        const toolBatch = await this.runToolCalls(
          processed,
          promptId,
          toolRegistry,
          caps.maxConcurrentTools,
          signal,
          toolMessageId,
          closingDelivery,
          deliveryRepair,
          adaptiveExecution,
        );

        if (signal.aborted) {
          publishCancellation();
          break;
        }

        const adaptiveDecisions = toolBatch.decisions;
        await applySteering();
        const requestedReplans = adaptiveDecisions.some(
          (decision) => decision.replanRequired,
        )
          ? 1
          : 0;
        if (
          replanCount + requestedReplans >
          turnControl.complexity.budget.maxReplans
        ) {
          const message = `本轮已达到重规划预算（${turnControl.complexity.budget.maxReplans}），已停止重复失败路径。`;
          this.store.patchMessage(this.sessionId, toolMessageId, {
            isStreaming: false,
            isProcessingTools: false,
            toolsCompleted: true,
          });
          this.fail('execution_budget_exceeded', message);
          turnTracker.fail(message);
          this.publishRuntimeActivity('turn', 'failed', message);
          break;
        }
        replanCount += requestedReplans;
        if (this.recoveryStore && this.activeRecovery) {
          this.activeRecovery = await this.recoveryStore.recordTaskGraph(
            this.activeRecovery,
            turnTracker.taskGraphSnapshot(),
          );
        }
        if (
          adaptiveDecisions.some(
            (decision) => decision.action === 'compact_context',
          )
        ) {
          this.config.getOttoClient().scheduleHierarchicalCompaction('L3');
        }
        const adaptiveDirective = [
          runtimeDirective(
            adaptiveDecisions.some((decision) => decision.replanRequired),
          ),
          adaptiveExecution.buildDirective(
            adaptiveDecisions,
            toolBatch.completedToolNames,
          ),
          toolBatch.blockedAttempts.length > 0
            ? adaptiveExecution.buildAttemptDirective(toolBatch.blockedAttempts)
            : '',
        ]
          .filter(Boolean)
          .join('\n');

        // 工具响应回灌为下一轮 user message；重置本段 assistant 累积。
        currentMessages = [
          {
            role: MESSAGE_ROLES.USER,
            parts: [
              ...toolBatch.parts,
              ...(adaptiveDirective ? [{ text: adaptiveDirective }] : []),
            ],
          },
        ];
        assistantId = null;
        assistantText = '';
        this.store.setStatus(this.sessionId, 'thinking');
      }
    } catch (e) {
      if (signal.aborted) {
        publishCancellation();
      } else {
        const message = safeText(userFacingRuntimeError(e));
        if (assistantId !== null) {
          const finalText = safeText(deferAssistantText
            ? [message, unverifiedDeliveryText(assistantText)]
                .filter(Boolean)
                .join('\n\n')
            : assistantText.trim()
              ? assistantText
              : message);
          this.store.patchMessage(this.sessionId, assistantId, {
            content: [{ type: 'text', value: finalText }],
            isStreaming: false,
            isProcessingTools: false,
            toolsCompleted: true,
          });
          this.store.publish(this.sessionId, {
            type: 'chat_complete',
            payload: {
              sessionId: this.sessionId,
              messageId: assistantId,
              finishReason: 'error',
              text: finalText,
            },
          });
        }
        this.fail(
          e instanceof ModelOutcomeUnknownError
            ? 'model_outcome_unknown'
            : 'core_error',
          message,
          e instanceof ModelOutcomeUnknownError ? e.safetyDetails() : undefined,
        );
        if (e instanceof ModelOutcomeUnknownError) {
          turnTracker.interruptUnknown(message);
        } else {
          turnTracker.fail(message);
        }
        this.publishRuntimeActivity('turn', 'failed', message);
      }
    } finally {
      this.steeringClosed = true;
      releaseConstraintGuard?.();
      try { await this.settleRecovery(turnTracker); }
      finally {
        this.activeConstraints = undefined;
        this.activeDeliveryRepair = undefined;
        signal.removeEventListener('abort', onAbort);
        this.running = false;
        this.abort = undefined;
        this.activeTurnTracker = undefined;
        this.activeTurnControl = undefined;
        this.activeRecovery = undefined;
        this.continuity = undefined;
        this.steeringApplying = false;
      }
    }
  }

  /**
   * 执行一批工具调用（带并发上限），把状态/结果 publish 成 tool_calls_update，
   * 返回工具响应以及结构化成败观察（回灌给 core 下一轮）。
   */
  private async runToolCalls(
    calls: FunctionCall[],
    promptId: string,
    toolRegistry: ToolRegistry,
    maxConcurrent: number,
    signal: AbortSignal,
    messageId: string,
    closingDelivery = false,
    deliveryRepair?: DeliveryRepairGuard,
    adaptiveExecution = new AdaptiveExecutionCoordinator(),
  ): Promise<{
    parts: Part[];
    decisions: Array<ReturnType<AdaptiveExecutionCoordinator['observe']>>;
    completedToolNames: string[];
    blockedAttempts: AdaptiveAttemptReview[];
  }> {
    const responseParts: Part[] = [];
    const blockedAttempts: AdaptiveAttemptReview[] = [];
    const blockedCallIds = new Set<string>();
    const reusedCallIds = new Set<string>();
    const decisions: Array<ReturnType<AdaptiveExecutionCoordinator['observe']>> = [];
    const batchIds = new Set<string>();

    // 某些 provider（尤其 Gemini 原生 functionCall）不提供 id。一次绑定后全程复用，
    // 避免建卡与执行各生成一个随机 id，导致 cards.get() 永远取不到同一张卡。
    const callsWithIds = calls.map((fc) => {
      const name = (fc.name as string) ?? 'unknown';
      const parameters = (fc.args ?? {}) as Record<string, unknown>;
      const callId = this.callIdOf(fc);
      if (batchIds.has(callId) || this.activeTurnTracker?.hasObservedTool(callId)) throw new Error('Duplicate tool call ID; refusing ambiguous execution receipts');
      batchIds.add(callId);
      return {
        fc,
        callId,
        name,
        parameters,
        fingerprint: toolExecutionFingerprint(name, parameters),
        replayClass: classifyRecoveryTool(name),
        sideEffect: isParallelSafeToolName(name)
          ? ('read_only' as const)
          : classifyRecoveryTool(name) === 'never_replay'
            ? ('external_write' as const)
            : ('local_write' as const),
      };
    });

    // Queued cards are not execution evidence. Capture input versions only at dispatch.
    const cards = new Map<string, ToolCall>();
    for (const { callId, name, parameters } of callsWithIds) {
      const card: ToolCall = {
        id: callId,
        toolName: name,
        parameters,
        status: ToolCallStatus.Scheduled,
        startTime: Date.now(),
      };
      cards.set(callId, card);
    }
    if (cards.size > 0) {
      this.publishToolCards(cards, messageId);
      this.publishRuntimeActivity(
        'tool',
        'started',
        `${cards.size} 个工具调用`,
      );
    }

    // AbortSignal 只保证通知，不保证工具实现会配合退出。先把卡片与持久消息立即收口；
    // 若底层工具稍后才返回，下方 signal 检查仍保持 cancelled，不让迟到结果复活转圈。
    const cancelActiveCards = (): void => {
      let changed = false;
      for (const [callId, card] of cards) {
        const cancelled = cancelToolCall(card);
        if (cancelled !== card) {
          cards.set(callId, cancelled);
          changed = true;
        }
      }
      if (changed) this.publishToolCards(cards, messageId);
    };
    const startedNeverReplay = new Set<string>();
    let reconciliationPromise: Promise<void> | undefined;
    const requireReconciliation = (reason: string): Promise<void> => {
      reconciliationPromise ??= this.markRecoveryReconciliation(reason);
      return reconciliationPromise;
    };
    signal.addEventListener('abort', cancelActiveCards, { once: true });
    if (signal.aborted) cancelActiveCards();

    // 只有控制策略允许且名称已经过只读审查的工具才能并发。未知工具、写入、
    // 外部操作和审批动作全部单独成块，避免模型把相邻调用误当成可安全并行。
    const chunks: Array<typeof callsWithIds> = [];
    const routedParallelism =
      this.activeTurnControl?.complexity.budget.maxParallelTools ?? 1;
    const limit = Math.max(1, Math.min(maxConcurrent || 1, routedParallelism));
    let parallelReads: typeof callsWithIds = [];
    const flushParallelReads = (): void => {
      if (parallelReads.length === 0) return;
      chunks.push(parallelReads);
      parallelReads = [];
    };
    for (const call of callsWithIds) {
      const name = String(call.fc.name ?? '');
      if (
        this.activeTurnControl?.allowsParallelRead === true &&
        isParallelSafeToolName(name)
      ) {
        parallelReads.push(call);
        if (parallelReads.length >= limit) flushParallelReads();
        continue;
      }
      flushParallelReads();
      chunks.push([call]);
    }
    flushParallelReads();

    try {
      for (const chunk of chunks) {
        if (signal.aborted) break;
        await Promise.all(
          chunk.map(
            async ({
              fc,
              callId,
              name,
              parameters,
              fingerprint,
              replayClass,
              sideEffect,
            }) => {
              const card = cards.get(callId)!;
              const requestInfo: ToolCallRequestInfo = {
                callId,
                name,
                args: parameters,
                isClientInitiated: false,
                prompt_id: promptId,
              };

              let executionStarted = false;
              try {
                if (this.steeringFence) { this.steeringBlocked.add(callId); throw new Error('Old direction cancelled at steering boundary'); }
                this.activeConstraints?.review(requestInfo);
                if (name === CLAIM_REVIEW_TOOL_NAME) {
                  if (!this.activeTurnTracker || this.options.toolFree) throw new Error('Evidence review unavailable');
                  const result = this.activeTurnTracker.reviewAnswerEvidence(parameters);
                  cards.set(callId, { ...card, status: ToolCallStatus.Success,
                    result: { success: true, data: result, executionTime: 0, toolName: name }, endTime: Date.now() });
                  responseParts.push({ functionResponse: { id: callId, name, response: { ...result } } });
                  return;
                }
                if ([REPAIR_PLAN_TOOL_NAME, REPAIR_FORMAT_TOOL_NAME].includes(name)) {
                  if (!closingDelivery || !deliveryRepair || !this.activeTurnTracker || this.options.toolFree) throw new Error('Repair strategy tools are available only during authorized delivery closure');
                  const context = this.activeTurnTracker.repairContext();
                  deliveryRepair.revise(context);
                  const result = name === REPAIR_PLAN_TOOL_NAME
                    ? deliveryRepair.compare(parameters, context, ['read_file', 'write_file', 'replace'].filter(tool => !!toolRegistry.getTool(tool)))
                    : await deliveryRepair.prepareFormat(parameters.file_path as string);
                  if (this.steeringFence || signal.aborted) { this.steeringBlocked.add(callId); throw new Error('Repair proposal superseded'); }
                  cards.set(callId, { ...card, status: ToolCallStatus.Success,
                    result: { success: true, data: result, executionTime: 0, toolName: name }, endTime: Date.now() });
                  responseParts.push({ functionResponse: { id: callId, name, response: { success: true, ...result } } });
                  return;
                }
                const attemptReview = adaptiveExecution.reviewAttempt({
                  toolName: name,
                  callFingerprint: fingerprint,
                  sideEffect,
                  verification: Boolean(verificationKind(card)),
                });
                if (!attemptReview.allowed) {
                  blockedAttempts.push(attemptReview);
                  blockedCallIds.add(callId);
                  const error = attemptReview.guidance ?? 'Tool path blocked';
                  cards.set(callId, {
                    ...card,
                    status: ToolCallStatus.Error,
                    result: {
                      success: false,
                      error,
                      executionTime: 0,
                      toolName: name,
                    },
                    endTime: Date.now(),
                  });
                  responseParts.push({
                    functionResponse: {
                      id: callId,
                      name,
                      response: { error, strategyGuard: true },
                    },
                  });
                  return;
                }
                // An ADDITIONAL closure restriction, never a replacement for the
                // original central policy/confirmation gate below. Check runners
                // may themselves have side effects and still require that gate.
                const sourceTool = name === WebFetchTool.Name ? toolRegistry.getTool(name) : undefined;
                const nativeEvidenceRead = parameters.evidence_only === true && sourceTool &&
                  Object.getPrototypeOf(sourceTool) === WebFetchTool.prototype && sourceTool.execute === WebFetchTool.prototype.execute;
                if (
                  closingDelivery &&
                  name !== TASK_PLAN_TOOL_NAME &&
                  !nativeEvidenceRead &&
                  !isParallelSafeToolName(name) &&
                  !verificationKind(card) &&
                  !deliveryRepair?.reserve(card)
                )
                  throw new Error(
                    'Pre-delivery repair requires a failed check, fresh file versions and remaining budget. For multiple related files or new tests use plan_delivery_repair first. Shell repairs, new authority and external actions are not allowed.',
                  );
                // Native in-memory planning only. It cannot execute code or authorize a tool.
                if (name === TASK_PLAN_TOOL_NAME) {
                  if (
                    this.options.toolFree ||
                    !this.activeTurnTracker ||
                    !this.activeTurnControl
                  )
                    throw new Error('Task planning unavailable');
                  const result =
                    this.activeTurnTracker.updateTaskContract(parameters);
                  deliveryRepair?.revise(this.activeTurnTracker.repairContext());
                  this.activeTurnControl.complexity =
                    refineComplexityFromObjectives(
                      this.activeTurnControl.complexity,
                      result.taskPlan.objectives,
                      this.activeTurnControl.riskLevel,
                    );
                  cards.set(callId, {
                    ...card,
                    status: ToolCallStatus.Success,
                    result: {
                      success: true,
                      data: result,
                      executionTime: 0,
                      toolName: name,
                    },
                    endTime: Date.now(),
                  });
                  responseParts.push({
                    functionResponse: {
                      id: callId,
                      name,
                      response: { success: true, ...result },
                    },
                  });
                  return;
                }
                const decision =
                  this.recoveryStore && this.activeRecovery
                    ? this.recoveryStore.decisionForTool(this.activeRecovery, {
                        name,
                        fingerprint,
                        replayClass,
                      })
                    : { action: 'execute' as const };
                if (decision.action === 'reuse') {
                  reusedCallIds.add(callId);
                  const currentCard = cards.get(callId) ?? card;
                  cards.set(callId, {
                    ...currentCard,
                    status: ToolCallStatus.Success,
                    result: {
                      success: true,
                      data: decision.resultSummary,
                      executionTime: 0,
                      toolName: name,
                    },
                    endTime: Date.now(),
                  });
                  responseParts.push({
                    functionResponse: {
                      id: callId,
                      name,
                      response: {
                        recovered: true,
                        originalCallId: decision.originalCallId,
                        executed: false,
                        evidenceNote: 'This is the previous receipt, not a new execution or verification. Retain its original evidence ID; current file/version checks still apply.',
                        result: decision.resultSummary,
                      },
                    },
                  });
                  return;
                }
                if (decision.action === 'reconcile') {
                  await requireReconciliation(decision.reason);
                  const currentCard = cards.get(callId) ?? card;
                  cards.set(callId, {
                    ...currentCard,
                    status: ToolCallStatus.Error,
                    result: {
                      success: false,
                      error: decision.reason,
                      executionTime: 0,
                      toolName: name,
                    },
                    endTime: Date.now(),
                  });
                  responseParts.push({
                    functionResponse: {
                      id: callId,
                      name,
                      response: {
                        error: decision.reason,
                        reconciliationRequired: true,
                      },
                    },
                  });
                  return;
                }

                // AskUserQuestion 交互闸门：headless 的 executeToolCall 不会弹确认框，
                // 所以在此先弹问答卡、等用户答案写进工具的 pendingAnswers，再落入下面
                // 统一的 executeToolCall —— 它内部 execute() 会读到答案并格式化结果。
                // 用户跳过 / 会话取消时 answers 为空，execute() 自然回落到 "declined"。
                let explicitlyApproved = false;
                if ((fc.name as string) === 'ask_user_question') {
                  await this.gateAskUserQuestion(
                    requestInfo,
                    toolRegistry,
                    cards,
                    callId,
                    signal,
                    messageId,
                  );
                  explicitlyApproved = true;
                } else {
                  explicitlyApproved = await this.gateToolConfirmation(
                    requestInfo,
                    toolRegistry,
                    cards,
                    callId,
                    signal,
                    messageId,
                  );
                }

                if (
                  deliveryRepair &&
                  !deliveryRepair.validateReserved(callId, requestInfo)
                ) {
                  throw new Error(
                    'Repair target changed while awaiting confirmation; reread and reconcile the user edit before continuing.',
                  );
                }
                if (this.recoveryStore && this.activeRecovery) {
                  this.activeRecovery = await this.recoveryStore.recordStarted(
                    this.activeRecovery,
                    { callId, name, fingerprint, replayClass },
                  );
                  executionStarted = true;
                  if (replayClass === 'never_replay') {
                    startedNeverReplay.add(fingerprint);
                  }
                }

                if (this.steeringFence) { this.steeringBlocked.add(callId); throw new Error('Old approval superseded by steering'); }
                this.activeConstraints?.start(requestInfo);
                await this.persistContinuity();
                cards.set(callId, { ...(cards.get(callId) ?? card), status: ToolCallStatus.Executing });
                this.publishToolCards(cards, messageId);
                const toolResponse = await executeToolCall(
                  this.config,
                  requestInfo,
                  toolRegistry,
                  signal,
                  {
                    explicitlyApproved,
                    onOutput: (output) => {
                      if (signal.aborted) return;
                      const currentCard = cards.get(callId);
                      if (!currentCard) return;
                      cards.set(callId, { ...currentCard, liveOutput: output });
                      this.publishToolCards(cards, messageId);
                    },
                  },
                );

                if (this.steeringBlocked.has(callId)) throw new Error('Cancelled by native steering fence before execution');

                if (signal.aborted) {
                  cards.set(callId, cancelToolCall(cards.get(callId) ?? card));
                  return;
                }

                const display = resultDisplayToString(
                  toolResponse.resultDisplay,
                );
                const currentCard = cards.get(callId) ?? card;
                const execResult: ToolExecutionResult = {
                  ...(toolResponse.sourceEvidence ? { sourceEvidence: toolResponse.sourceEvidence } : {}),
                  ...(name === 'run_shell_command' && toolResponse.process
                    ? { process: toolResponse.process }
                    : {}),
                  success: !toolResponse.error,
                  data: display || undefined,
                  error: toolResponse.error
                    ? toolResponse.error.message
                    : undefined,
                  executionTime: currentCard.startTime
                    ? Date.now() - currentCard.startTime
                    : 0,
                  toolName: currentCard.toolName,
                };
                cards.set(callId, {
                  ...currentCard,
                  status: toolResponse.error
                    ? ToolCallStatus.Error
                    : ToolCallStatus.Success,
                  result: execResult,
                  endTime: Date.now(),
                });

                if (this.recoveryStore && this.activeRecovery) {
                  if (toolResponse.error && replayClass === 'never_replay') {
                    await requireReconciliation(
                      `工具 ${name} 已返回错误，但外部副作用是否发生无法安全确认：${toolResponse.error.message}`,
                    );
                  } else {
                    this.activeRecovery = toolResponse.error
                      ? await this.recoveryStore.recordFailed(
                          this.activeRecovery,
                          {
                            callId,
                            name,
                            fingerprint,
                            replayClass,
                            errorSummary: toolResponse.error.message,
                          },
                        )
                      : await this.recoveryStore.recordSucceeded(
                          this.activeRecovery,
                          {
                            callId,
                            name,
                            fingerprint,
                            replayClass,
                            resultSummary: display || '工具执行成功',
                          },
                        );
                    startedNeverReplay.delete(fingerprint);
                  }
                }

                // 工具响应 Part[] 回灌（executeToolCall 已构造 functionResponse）。
                const parts = Array.isArray(toolResponse.responseParts)
                  ? toolResponse.responseParts
                  : [toolResponse.responseParts];
                for (const p of parts) {
                  if (typeof p === 'string') {
                    responseParts.push({ text: p });
                  } else if (p) {
                    responseParts.push(p as Part);
                  }
                }
              } catch (e) {
                if (this.steeringBlocked.has(callId) || (this.steeringFence && !executionStarted)) {
                  blockedCallIds.add(callId);
                  cards.set(callId, { ...(cards.get(callId) ?? card), status: ToolCallStatus.Canceled,
                    result: { toolName: name, success: false, executionTime: 0, error: '未执行：用户已调整当前任务' } });
                  responseParts.push({ functionResponse: { id: callId, name, response: { cancelled: true, executed: false, reason: 'User steering superseded this call' } } });
                  if (executionStarted && this.recoveryStore && this.activeRecovery) this.activeRecovery = await this.recoveryStore.recordFailed(this.activeRecovery, { callId, name, fingerprint, replayClass, errorSummary: 'Cancelled before dispatch by native steering fence' });
                  return;
                }
                const message = e instanceof Error ? e.message : String(e);
                const currentCard = cards.get(callId) ?? card;
                if (
                  executionStarted &&
                  replayClass === 'never_replay' &&
                  this.recoveryStore &&
                  this.activeRecovery
                ) {
                  await requireReconciliation(
                    `工具 ${name} 已开始执行，但未取得可信终态：${message}`,
                  );
                } else if (
                  executionStarted &&
                  this.recoveryStore &&
                  this.activeRecovery
                ) {
                  this.activeRecovery = await this.recoveryStore.recordFailed(
                    this.activeRecovery,
                    {
                      callId,
                      name,
                      fingerprint,
                      replayClass,
                      errorSummary: message,
                    },
                  );
                }
                if (signal.aborted) {
                  cards.set(callId, cancelToolCall(currentCard));
                  return;
                }
                cards.set(callId, {
                  ...currentCard,
                  status: ToolCallStatus.Error,
                  result: {
                    success: false,
                    error: message,
                    executionTime: currentCard.startTime
                      ? Date.now() - currentCard.startTime
                      : 0,
                    toolName: currentCard.toolName,
                  },
                  endTime: Date.now(),
                });
                // 把错误作为 functionResponse 回灌，让模型可见并自我纠正。
                responseParts.push({
                  functionResponse: {
                    id: callId,
                    name: (fc.name as string) ?? '',
                    response: { error: message },
                  },
                });
              } finally {
                this.activeConstraints?.finish(callId);
                // Publish/observe the terminal receipt BEFORE the next serial call can start.
                this.publishToolCards(cards, messageId);
                const final = cards.get(callId)!;
                if (!reusedCallIds.has(callId)) deliveryRepair?.observe(final, closingDelivery, this.activeTurnTracker?.observedInputPaths(callId) ?? []);
                const observation = { toolName: name, callFingerprint: fingerprint, sideEffect,
                  verification: Boolean(verificationKind(final)), targetPaths: this.activeTurnTracker?.observedInputPaths(callId) ?? [] };
                if (final.status === ToolCallStatus.Error && !blockedCallIds.has(callId)) {
                  const decision = adaptiveExecution.observe({ ...observation, nativeVerificationFailed: hasFailedVerificationReceipt(final), message: final.result?.error || 'tool execution failed' });
                  decisions.push(decision);
                  this.activeTurnTracker?.recordAdaptation({ category: decision.category, action: decision.action,
                    toolName: name, attempt: decision.attempt, failureFingerprint: fingerprint, failedToolCallId: callId, alternatives: decision.alternatives });
                } else if (!reusedCallIds.has(callId) && final.status === ToolCallStatus.Success && final.result?.success === true &&
                  (!final.result.process || hasSuccessfulProcessReceipt(final))) {
                  const resolved = adaptiveExecution.recordSuccess(observation);
                  this.activeTurnTracker?.resolveRecoveries(resolved, callId);
                }
                await this.persistContinuity();
              }
            },
          ),
        );
        // 每块执行完广播一次最新状态，同时写回消息持久态。
        this.publishToolCards(cards, messageId);
      }
    } finally {
      signal.removeEventListener('abort', cancelActiveCards);
      if (signal.aborted && startedNeverReplay.size > 0) {
        await requireReconciliation(
          '不可安全重放的工具在取消时仍处于执行中，结果需要人工核对',
        );
      }
      await reconciliationPromise;
      if (signal.aborted) cancelActiveCards();
    }

    const callsById = new Map(
      callsWithIds.map((call) => [call.callId, call] as const),
    );
    const completedToolNames: string[] = [];
    for (const [callId, card] of cards) {
      const call = callsById.get(callId);
      if (!call) continue;
      if (card.status === ToolCallStatus.Success) {
        completedToolNames.push(call.name);
        continue;
      }
    }

    return {
      parts: responseParts,
      decisions,
      completedToolNames,
      blockedAttempts,
    };
  }

  /** 普通工具确认：手动模式全问；自动模式只问高危/删除。 */
  private async gateToolConfirmation(
    requestInfo: ToolCallRequestInfo,
    toolRegistry: ToolRegistry,
    cards: Map<string, ToolCall>,
    callId: string,
    signal: AbortSignal,
    messageId: string,
  ): Promise<boolean> {
    const tool = toolRegistry.getTool(requestInfo.name);
    if (!tool) return false;
    const details = await tool.shouldConfirmExecute(requestInfo.args, signal);
    if (!details) {
      if (
        this.activeTurnControl?.confirmationMode === 'always' &&
        !isPolicySafeWithoutConfirmation(requestInfo.name)
      ) {
        throw new Error(
          '当前任务涉及外部或破坏性操作，但该工具没有提供可审查的确认信息，Otto 已阻止执行。',
        );
      }
      return false;
    }

    if (
      this.activeTurnControl?.confirmationMode !== 'always' &&
      !shouldRequestConfirmation(this.authorizationMode, details)
    )
      return false;

    const confirmation = this.waitForConfirmation(callId, signal);

    const base = cards.get(callId);
    if (base) {
      const awaiting: ToolCall = {
        ...base,
        status: ToolCallStatus.WaitingForConfirmation,
        confirmationDetails: {
          ...(details as unknown as ToolCall['confirmationDetails']),
          riskLevel: (details as { warning?: string }).warning
            ? 'high'
            : (details as unknown as ToolCall['confirmationDetails'])
                ?.riskLevel,
        },
      };
      cards.set(callId, awaiting);
      this.publishToolCards(cards, messageId);
      this.store.publish(this.sessionId, {
        type: 'tool_confirmation_request',
        payload: { sessionId: this.sessionId, callId, toolCall: this.activeConstraints?.presentation(awaiting) ?? awaiting },
      });
    }

    const result = await confirmation;
    if (result.outcome === 'rejected') throw new Error('用户已取消此操作');
    await details.onConfirm(
      result.outcome === 'always_approve'
        ? ToolConfirmationOutcome.ProceedAlways
        : ToolConfirmationOutcome.ProceedOnce,
      result.payload,
    );
    const approved = cards.get(callId);
    if (approved) {
      cards.set(callId, {
        ...approved,
        status: ToolCallStatus.Executing,
        confirmationDetails: undefined,
      });
      this.publishToolCards(cards, messageId);
    }
    return true;
  }

  private publishToolCards(
    cards: Map<string, ToolCall>,
    messageId: string,
  ): void {
    const nativeToolCalls = Array.from(cards.values());
    const toolCalls = this.activeConstraints?.presentation(nativeToolCalls) ?? nativeToolCalls;
    const isProcessingTools = toolCalls.some((card) =>
      isToolCallInFlight(card.status),
    );
    // 工具卡状态与消息 busy 标记必须同源持久化；否则实时 UI 虽已成功，切换会话后
    // history 会把旧的 isProcessingTools=true 重新灌回，停止键永久复活。
    this.store.patchMessage(this.sessionId, messageId, {
      associatedToolCalls: toolCalls,
      isProcessingTools,
      toolsCompleted: !isProcessingTools,
    });
    this.activeTurnTracker?.updateToolCalls(nativeToolCalls);
    this.store.publish(this.sessionId, {
      type: 'tool_calls_update',
      payload: {
        sessionId: this.sessionId,
        messageId,
        toolCalls,
      },
    });
  }

  /**
   * AskUserQuestion 的交互闸门：把工具卡切到「待确认」并附上问题清单广播给客户端，
   * 挂起等待用户作答，收到答案后调工具的 onConfirm 把答案写进其 pendingAnswers。
   * 随后调用方的 executeToolCall → execute() 便能读到答案并格式化 tool_result。
   *
   * 校验失败 / 注册表无此工具 / 详情非 question 时直接返回，放行给 executeToolCall
   * 走它自己的错误路径（不吞异常，行为与其它工具一致）。
   */
  private async gateAskUserQuestion(
    requestInfo: ToolCallRequestInfo,
    toolRegistry: ToolRegistry,
    cards: Map<string, ToolCall>,
    callId: string,
    signal: AbortSignal,
    messageId: string,
  ): Promise<void> {
    const tool = toolRegistry.getTool('ask_user_question');
    if (!tool) return;

    let details: Awaited<ReturnType<typeof tool.shouldConfirmExecute>>;
    try {
      details = await tool.shouldConfirmExecute(requestInfo.args, signal);
    } catch {
      // 侦测阶段异常：交给 executeToolCall 复现并产出规范错误。
      return;
    }
    if (!details || (details as { type?: string }).type !== 'question') return;

    // shouldConfirmExecute 已就地自愈过 args，此处的 questions 是规范化后的清单。
    const args = requestInfo.args as unknown as {
      questions?: AskUserQuestion[];
      metadata?: { source?: string };
    };
    const questions = args.questions ?? [];

    // 先登记 resolver 再广播，避免飞书卡片或测试适配器极快应答时丢失确认。
    const confirmation = this.waitForConfirmation(callId, signal);

    // 工具卡 → 待确认态，挂上问题清单；广播 tool_calls_update + 单独发 confirmation_request。
    const base = cards.get(callId);
    if (base) {
      const awaitingCard: ToolCall = {
        ...base,
        status: ToolCallStatus.WaitingForConfirmation,
        confirmationDetails: {
          type: 'question',
          title: (details as { title?: string }).title ?? '请选择',
          questions,
          metadata: args.metadata,
        },
      };
      cards.set(callId, awaitingCard);
      this.publishToolCards(cards, messageId);
      this.publishRuntimeActivity(
        'tool',
        'awaiting_confirmation',
        awaitingCard.toolName,
      );
      this.store.publish(this.sessionId, {
        type: 'tool_confirmation_request',
        payload: {
          sessionId: this.sessionId,
          callId,
          toolCall: this.activeConstraints?.presentation(awaitingCard) ?? awaitingCard,
        },
      });
    }

    // 挂起等待用户作答（或会话取消）。
    const result = await confirmation;

    // 把答案交给工具 onConfirm 写进 pendingAnswers；rejected/取消 → Cancel（execute 回落 declined）。
    const outcome =
      result.outcome === 'rejected'
        ? ToolConfirmationOutcome.Cancel
        : ToolConfirmationOutcome.ProceedOnce;
    await (details as ToolQuestionConfirmationDetails).onConfirm(
      outcome,
      result.payload,
    );

    // 卡从「待确认」过渡回「执行中」，清掉问答详情，让 UI 收起选项、显示运行态。
    const answered = cards.get(callId);
    if (answered) {
      cards.set(callId, {
        ...answered,
        status: ToolCallStatus.Executing,
        confirmationDetails: undefined,
      });
      this.publishToolCards(cards, messageId);
    }
  }

  /**
   * 挂起等待某 callId 的确认应答；会话中止（signal.aborted）时按用户拒绝收口，
   * 避免 await 永久悬挂。resolver 登记进 pendingConfirmations，由 server 路由唤醒。
   */
  private waitForConfirmation(
    callId: string,
    signal: AbortSignal,
  ): Promise<ConfirmationResult> {
    return new Promise<ConfirmationResult>((resolve) => {
      let settled = false;
      const finish = (result: ConfirmationResult): void => {
        if (settled) return;
        settled = true;
        this.pendingConfirmations.delete(callId);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = (): void => finish({ outcome: 'rejected' });
      if (signal.aborted) {
        finish({ outcome: 'rejected' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingConfirmations.set(callId, finish);
    });
  }

  private callIdOf(fc: FunctionCall): string {
    return (
      fc.id ??
      `${fc.name}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
    );
  }

  private async markRecoveryReconciliation(reason: string): Promise<void> {
    if (!this.recoveryStore || !this.activeRecovery) return;
    this.activeRecovery = await this.recoveryStore.markReconciliationRequired(
      this.activeRecovery,
      reason,
    );
    this.activeTurnTracker?.markReconciliationRequired(reason);
  }

  private async settleRecovery(tracker: AgentTurnTracker): Promise<void> {
    if (!this.recoveryStore || !this.activeRecovery) return;
    const latest =
      (await this.recoveryStore.load(this.sessionId)) ?? this.activeRecovery;
    const snapshot = tracker.snapshot();
    const hasInFlightTool = latest.tools.some(
      (tool) => tool.state === 'started',
    );
    if (
      (snapshot.status === 'completed' || (!latest.continuity?.events.length && !latest.tools.length && snapshot.status !== 'interrupted')) &&
      !hasInFlightTool &&
      latest.status !== 'reconciliation_required'
    ) {
      await this.recoveryStore.clear(this.sessionId, latest.turnId);
      this.pendingRecovery = null;
      return;
    }
    this.pendingRecovery =
      (await this.recoveryStore.recoverInterrupted(this.sessionId)) ?? latest;
  }

  private onCancelled(assistantId: string | null, assistantText: string): void {
    const unknownSideEffect = this.activeRecovery?.tools.some(
      (tool) => tool.state === 'started' && tool.replayClass === 'never_replay',
    );
    if (unknownSideEffect) {
      this.activeTurnTracker?.interruptUnknown(
        '不可安全重放的工具在取消时仍处于执行中，结果需要人工核对',
      );
    } else {
      this.activeTurnTracker?.cancel();
    }
    if (assistantId !== null) {
      this.store.patchMessage(this.sessionId, assistantId, {
        content: [{ type: 'text', value: assistantText }],
        isStreaming: false,
        // 取消可能发生在工具执行阶段；若只清流式标记，持久历史仍会带
        // isProcessingTools=true，客户端重拉历史后又回到卡死的停止态。
        isProcessingTools: false,
        toolsCompleted: true,
      });
      this.store.publish(this.sessionId, {
        type: 'chat_complete',
        payload: {
          sessionId: this.sessionId,
          messageId: assistantId,
          finishReason: 'cancelled',
          // 取消也带已生成部分：客户端缺头时同样能自愈。
          text: assistantText,
        },
      });
    }
    this.store.setStatus(this.sessionId, 'idle');
    this.publishRuntimeActivity('turn', 'cancelled');
  }

  /**
   * 记录员工真正关心的一轮最终成果；工具流水仍由 core 记录，两者用途分离。
   * 写盘失败不影响聊天收口，但这里 await，确保 run() 返回时成果已可被桌面日志读取。
   */
  private async recordWorkResult(
    input: MessageContent,
    assistantText: string,
    success: boolean,
  ): Promise<void> {
    if (this.store.isEphemeralSession(this.sessionId)) return;
    const result = assistantText.trim();
    if (!result) return;
    const userInput = messageContentToText(input);
    const taskTitle = deriveWorkTitle(
      this.store.getSession(this.sessionId)?.title,
      userInput,
    );
    try {
      const category = inferWorkResultCategory(
        `${taskTitle} ${userInput} ${result}`,
      );
      const details = result.slice(0, 8_000);
      await this.workLogger.log({
        toolName: 'otto_work_result',
        action: taskTitle,
        category,
        success,
        entryType: 'work_result',
        taskTitle,
        userInput: userInput.slice(0, 2_000),
        details,
        sessionId: this.sessionId,
        projectRoot: this.config.getProjectRoot?.(),
      });
      if (!success) return;
      try {
        getRealtimeWatcher()?.record?.(taskTitle, userInput.slice(0, 500));
      } catch {
        /* AutoSkill realtime signals are best-effort. */
      }
      try {
        getHabitAnalyzer().feed({
          action: taskTitle,
          category,
          success: true,
          details: details.slice(0, 500),
          timestamp: new Date().toISOString(),
          toolName: 'otto_work_result',
        });
      } catch {
        /* Habit analysis must not affect chat completion. */
      }
    } catch {
      // 工作日志不可用不应让已完成的对话变成失败。
    }
  }

  private fail(
    code: string,
    message: string,
    modelRequestSafety?: {
      requestId: string;
      requestState: 'unknown_outcome';
      providerRequestId?: string;
    },
  ): void {
    this.store.publish(this.sessionId, {
      type: 'error',
      payload: {
        sessionId: this.sessionId,
        code,
        message,
        ...(modelRequestSafety ? { modelRequestSafety } : {}),
      },
    });
    this.store.setStatus(this.sessionId, 'error');
  }
}
