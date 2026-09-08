/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import path from 'node:path';
import type {
  AgentTaskRequest,
  MessageSource,
  OttoMessage,
} from './protocol.js';
import {
  TaskContractLedger,
  type TaskContractSnapshot,
} from './taskContract.js';
import { deriveTurnControlPolicy } from './turnControlPolicy.js';

// Deliberately recognizes whole short utterances, not a keyword buried in a
// new task, quoted document, or question. Ambiguous scope edits need clarification.
const CONTINUE =
  /^(?:继续(?:吧|做|处理|执行|下一步)?|接着(?:做|处理|执行)?|下一步|(?:照|按)(?:刚才|之前|上面)(?:说的|的要求|的方案)?(?:做|执行)|照办|把这个弄好|让它能用就行|go ahead|continue|proceed|do it)$/iu;
const AMBIGUOUS =
  /^(?:(?:继续|接着|下一步)\s*[,，;；]|(?:继续|接着)\s*但)|^(?:好|好的|可以|同意|确认|授权)$/u;
const CANCEL =
  /^(?:不要继续|取消(?:原|之前的)?任务|停止(?:原|之前的)?任务|换个话题)/u;
const MAX_REQUEST_LENGTH = 32_000;
const normalizedUtterance = (text: string) =>
  text
    .trim()
    .replace(/[。.!！]+$/u, '')
    .trim();

export type TurnRequestResolution =
  | { kind: 'fresh'; request: AgentTaskRequest }
  | {
      kind: 'continued';
      request: AgentTaskRequest;
      contract?: TaskContractSnapshot;
    }
  | { kind: 'clarify'; request: AgentTaskRequest; question: string };

function plainText(message: OttoMessage): string {
  return message.content
    .flatMap((part) => (part.type === 'text' ? [part.value] : []))
    .join('\n');
}
function canonicalWorkspace(value?: string): string | undefined {
  if (!value) return undefined;
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Resolve against native persisted messages only. No model history is authority. */
export function resolveTurnRequest(input: {
  text: string;
  source: MessageSource;
  workspacePath?: string;
  history: OttoMessage[];
  currentUserMessageId?: string;
}): TurnRequestResolution {
  const request: AgentTaskRequest = {
    version: 1,
    text: input.text,
    source: input.source,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
  };
  const clarify = (question: string): TurnRequestResolution => ({
    kind: 'clarify',
    request: { ...request, continuationBlocked: true },
    question,
  });
  let history = input.history;
  if (input.currentUserMessageId) {
    const current = history.findIndex(
      (message) =>
        message.id === input.currentUserMessageId &&
        message.role === 'user' &&
        message.source === input.source,
    );
    if (current < 0)
      return clarify(
        '找不到本次消息对应的任务上下文，请说明要继续的具体任务。',
      );
    history = history.slice(0, current);
  }
  const utterance = normalizedUtterance(input.text);
  if (AMBIGUOUS.test(utterance)) {
    return clarify(
      '请明确要继续哪项任务，以及是否调整原来的要求；这句话不会替代具体操作的授权确认。',
    );
  }
  if (!CONTINUE.test(utterance)) return { kind: 'fresh', request };

  const lastUser = [...history]
    .reverse()
    .find((message) => message.role === 'user');
  const userIndex = lastUser ? history.indexOf(lastUser) : -1;
  const user = userIndex < 0 ? undefined : history[userIndex];
  const responses = history.slice(userIndex + 1);
  const turn = [...responses]
    .reverse()
    .find((message) => message.role === 'assistant' && message.turn)?.turn;
  // Never search past a newer user request to revive an unrelated old task.
  const previous = turn?.request;
  if (
    previous &&
    (previous.version !== 1 ||
      typeof previous.text !== 'string' ||
      (previous.workspacePath !== undefined &&
        typeof previous.workspacePath !== 'string'))
  ) {
    return clarify(
      '之前保存的任务上下文无法安全读取，请补充具体目标和验收要求。',
    );
  }
  const originalText = previous?.text ?? (user ? plainText(user) : '');
  if (
    previous?.continuationBlocked ||
    !originalText.trim() ||
    originalText.length > MAX_REQUEST_LENGTH ||
    CONTINUE.test(normalizedUtterance(originalText)) ||
    AMBIGUOUS.test(normalizedUtterance(originalText)) ||
    CANCEL.test(originalText.trim())
  ) {
    return clarify(
      '当前无法确定要续做的未完成任务，请补充具体目标和需要保留的要求。',
    );
  }
  if (
    (previous?.source ?? user?.source) !== input.source ||
    (previous &&
      canonicalWorkspace(previous.workspacePath) !==
        canonicalWorkspace(input.workspacePath))
  ) {
    return clarify(
      '任务来源或工作目录已变化，请确认要继续的任务和目标目录；不会沿用之前的操作授权。',
    );
  }
  if (
    turn?.status === 'in_progress' ||
    turn?.outcome?.type === 'unknown_outcome' ||
    responses.some((message) =>
      message.associatedToolCalls?.some(
        (tool) =>
          [
            'scheduled',
            'validating',
            'executing',
            'awaiting_approval',
            'background_running',
          ].includes(tool.status) ||
          (tool.result?.process && tool.result.process.status !== 'exited'),
      ),
    )
  ) {
    return clarify(
      '上一次操作仍有结果或授权需要核对，请先确认执行结果；不会自动重复可能已经执行的操作。',
    );
  }
  const policy = deriveTurnControlPolicy({
    text: originalText,
    source: input.source,
    toolFree: false,
  });
  if (
    policy.intent === 'enterprise_action' ||
    ['external_write', 'destructive'].includes(policy.riskLevel)
  ) {
    return clarify(
      '原任务包含部署、发送或企业数据操作，请明确本次要继续的具体步骤；不会把“继续”当作重复外部操作的授权。',
    );
  }
  if (
    turn?.status === 'completed' &&
    policy.requiresVerification &&
    turn.verification?.status === 'passed'
  ) {
    return clarify('上一项任务已完成验收。你希望继续新增哪一项工作？');
  }
  let contract: TaskContractSnapshot | undefined;
  const snapshot = turn?.taskGraph?.taskContract;
  if (snapshot) {
    try {
      // The constructor validates citations, structure and revisions. The new
      // ledger has no native observations/replay permissions from the old turn.
      const definitions = structuredClone(snapshot);
      for (const objective of definitions.objectives) objective.evidence = [];
      contract = new TaskContractLedger(originalText, definitions).snapshot();
    } catch {
      return clarify(
        '之前保存的验收要求无法完整恢复，请先核对任务和验收标准；不会忽略它们后直接继续。',
      );
    }
  }
  return {
    kind: 'continued',
    request: {
      ...request,
      text: originalText,
      ...(turn ? { continuedFromTurnId: turn.turnId } : {}),
    },
    ...(contract ? { contract } : {}),
  };
}
