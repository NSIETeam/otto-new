/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import type { TaskObjective } from './taskContract.js';
import type { TurnVerificationCheck } from './protocol.js';

export interface TaskRequirement {
  id: string;
  quote: string;
  behavioral: boolean;
  kind: TaskRequirementKind;
  expectedOutcome: TaskExpectedOutcome;
  category:
    'must_implement' | 'must_preserve' | 'must_not_happen' | 'human_judgment';
  subject?: string;
  behavior?: string;
  conditions?: string;
  scenarios: Array<'normal' | 'error' | 'boundary'>;
}

export type TaskRequirementKind =
  | 'behavior'
  | 'prohibition'
  | 'preservation'
  | 'scope'
  | 'precondition'
  | 'manual';
export type TaskExpectedOutcome = 'must_happen' | 'must_not_happen';

const BEHAVIOR =
  /修复|实现|新增|支持|保留|生成|创建|修改|删除|过期|提示|验证码|测试|验证|\b(?:fix|implement|create|generate|support|test|verify)\b/iu;
const PROHIBITION =
  /(?:不要|不得|禁止|不允许|不可|避免|严禁|切勿|无需|不必|而不是|而非|^(?:不能)|\bdo\s+not\b|\bdon['’]t\b|\bmust\s+not\b|\bnever\b|\bwithout\b|\binstead\s+of\b|\brather\s+than\b)/iu;
const SHORT_PROHIBITION =
  /(?:别|勿|不)(?:打开|启动|唤起|修改|删除|覆盖|发送|推送|部署|展示|显示|泄露|暴露|裸露|越界|调用|运行|执行|写入|联网|保留|开(?=\s*(?:WPS|Keynote|PowerPoint|外部应用)))|不(?:把|将)[^，；。]{1,60}(?:打开|展示|显示|泄露|暴露|发送|推送)/iu;
const PRESERVATION =
  /(?:保留|保持|继续使用|兼容|不得影响|不能影响|不影响|不受影响|不破坏|\bpreserve\b|\bkeep\b|\bmaintain\b|\bbackward[- ]compatible\b)/iu;
const SCOPE =
  /(?:^只|^仅|只允许|只能|仅限|仅允许|不得超出|不能超出|不扩大|\bonly\b|\bwithin\b)/iu;
const PRECONDITION =
  /(?:必须先|需要先|应先|先.+再|确认.+后|完成.+后|后才能|之后才能|在.+之前|\bbefore\b|\bonly\s+after\b)/iu;
const STARTING_CONSTRAINT =
  /^(?:不要|不得|禁止|不允许|不能|不可|避免|严禁|切勿|无需|不必|而不是|而非|保留|保持|继续使用|兼容|不影响|不受影响|不破坏|只|仅|必须先|需要先|应先|先.+再|确认.+后|完成.+后|do\s+not\b|don['’]t\b|must\s+not\b|never\b|without\b|instead\s+of\b|rather\s+than\b|preserve\b|keep\b|maintain\b|backward[- ]compatible\b|only\b|within\b|before\b)/iu;
const CLAUSE_START =
  '(?:修复|实现|新增|支持|保留|保持|生成|创建|修改|删除|运行|验证|测试|不要|不得|禁止|不允许|不能|不可|避免|严禁|切勿|无需|不必|只允许|只能|仅限|仅允许|必须先|需要先|应先|[^，；。]{1,20}(?:不得|禁止|不允许|不可|严禁|切勿|不受影响|只允许|只能|仅限|后才能))';

function classifyRequirement(text: string): {
  kind: TaskRequirementKind;
  expectedOutcome: TaskExpectedOutcome;
} {
  if (
    /(?:人工(?:确认|判断|验收)|由我.*(?:确认|验收)|human (?:review|judgment|approval))/iu.test(
      text,
    )
  )
    return { kind: 'manual', expectedOutcome: 'must_happen' };
  if (SHORT_PROHIBITION.test(text))
    return { kind: 'prohibition', expectedOutcome: 'must_not_happen' };
  // Preservation must win for phrases such as “不得影响现有功能”: the
  // observable outcome is that compatibility remains intact, not merely that
  // an arbitrary action did not happen.
  if (PRESERVATION.test(text))
    return { kind: 'preservation', expectedOutcome: 'must_happen' };
  if (PRECONDITION.test(text))
    return { kind: 'precondition', expectedOutcome: 'must_happen' };
  if (SCOPE.test(text))
    return { kind: 'scope', expectedOutcome: 'must_happen' };
  if (PROHIBITION.test(text))
    return { kind: 'prohibition', expectedOutcome: 'must_not_happen' };
  return { kind: 'behavior', expectedOutcome: 'must_happen' };
}

/** Conservative structural inventory from user text, never from model claims.
 * This does NOT establish semantic sufficiency of a test or a source. */
export function extractTaskRequirements(request: string): TaskRequirement[] {
  const entries = new Map<
    string,
    Omit<TaskRequirement, 'id' | 'scenarios' | 'category'>
  >();
  let fenced = false;
  for (const raw of request.split(/\r?\n/u)) {
    if (/^\s*(?:```|~~~)/u.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*[#>]/u.test(raw)) continue;
    const line = raw.trim().replace(/^(?:\d+[.)、]|[-*])\s*/u, '');
    if (line.startsWith('|')) {
      const cells = line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (
        cells.every((cell) => /^:?-+:?$/u.test(cell)) ||
        cells.every((c) =>
          /^(?:模块|行为|条件|要求|需求|功能|module|behavior|condition|requirement)$/iu.test(
            c,
          ),
        )
      )
        continue;
      if (cells.length >= 2) {
        // Keep the EXACT full row as the binding: identical verbs in different
        // modules or under different conditions must never share an identity.
        const classified = classifyRequirement(cells.slice(1).join('；'));
        entries.set(line, {
          quote: line,
          subject: cells[0],
          behavior: cells[1],
          conditions: cells.slice(2).join('；'),
          behavioral:
            classified.kind !== 'behavior' ||
            BEHAVIOR.test(cells.slice(1).join(' ')),
          ...classified,
        });
      }
      continue;
    }
    if (!line) continue;
    const startsWithConstraint =
      STARTING_CONSTRAINT.test(line) || SHORT_PROHIBITION.test(line);
    // Keep inline code (commands/paths) intact: punctuation there is not prose.
    const fragments = line.split(/(`[^`]*`)/u);
    let pending = '';
    const clauses: string[] = [];
    for (const fragment of fragments) {
      if (fragment.startsWith('`')) {
        pending += fragment;
        continue;
      }
      const clauseStart = `(?:${CLAUSE_START}|${SHORT_PROHIBITION.source})`;
      const commaBoundary = new RegExp(`，(?=${clauseStart})`, 'u');
      const coordinatingBoundary = new RegExp(
        `(?:，?但(?:是)?)(?=${clauseStart})|，?(?=而(?:不是|非))`,
        'u',
      );
      const parts = fragment
        .split(commaBoundary)
        .flatMap((part) => part.split(coordinatingBoundary))
        .flatMap((part) => part.split(/(?:并且|同时|以及)/u))
        .flatMap((part) => part.split(/并(?=支持|运行|验证|修复)/u))
        .flatMap((part) => (startsWithConstraint ? [part] : part.split('、')))
        .flatMap((part) =>
          part.split(/和(?=[\p{Script=Han}]{2,40}(?:处理|提示))/u),
        )
        .flatMap((part) => part.split(/[；。]/u));
      pending += parts[0];
      for (const part of parts.slice(1)) {
        clauses.push(pending);
        pending = part;
      }
    }
    clauses.push(pending);
    for (const clause of clauses) {
      const quote = clause.trim();
      if (quote.length >= 2 && !/^工作目录[：:]/u.test(quote)) {
        const classified = classifyRequirement(quote);
        entries.set(quote, {
          quote,
          behavioral: classified.kind !== 'behavior' || BEHAVIOR.test(line),
          ...classified,
        });
      }
    }
  }
  return [...entries.values()].map((entry) => ({
    ...entry,
    category:
      entry.kind === 'manual'
        ? 'human_judgment'
        : entry.kind === 'prohibition'
          ? 'must_not_happen'
          : ['preservation', 'scope', 'precondition'].includes(entry.kind)
            ? 'must_preserve'
            : 'must_implement',
    scenarios: requiredScenarios(entry.quote),
    id: `requirement-${createHash('sha256').update(entry.quote).digest('hex').slice(0, 16)}`,
  }));
}
function requiredScenarios(quote: string): TaskRequirement['scenarios'] {
  // Explicit scenario words are lower bounds, not semantic test generation.
  const scenarios: TaskRequirement['scenarios'] = [];
  if (/正常|成功路径|\bnormal\b|happy path/iu.test(quote))
    scenarios.push('normal');
  if (
    /异常|错误|拒绝|失败|过期|无效|\berror\b|\binvalid\b|\bdenied\b/iu.test(
      quote,
    )
  )
    scenarios.push('error');
  if (/边界|上限|下限|空列表|空值|\bboundar(?:y|ies)\b/iu.test(quote))
    scenarios.push('boundary');
  return scenarios.length ? scenarios : ['normal'];
}

/** One explicit binding per acceptance condition; a broad objective quotation
 * cannot silently stand for multiple independent requirements. */
export function auditTaskCoverage(
  requirements: readonly TaskRequirement[],
  objectives: readonly TaskObjective[],
): TurnVerificationCheck[] {
  if (requirements.length > 48)
    return [
      {
        id: 'coverage-size',
        label: '需求超过单轮核对上限，需拆分任务',
        status: 'not_run',
      },
    ];
  return requirements.map((requirement) => {
    const adequate = requirement.scenarios.every((scenario) =>
      objectives.some((objective) => {
        if (!objective.sourceQuote.includes(requirement.quote)) return false;
        const contained = requirements.filter((r) =>
          objective.sourceQuote.includes(r.quote),
        );
        return objective.criteria.some(
          (criterion) =>
            (criterion.requirementQuote === requirement.quote ||
              (!criterion.requirementQuote && contained.length === 1)) &&
            (!requirement.behavioral ||
              criterion.kind === 'manual' ||
              (criterion.kind === 'constraint' &&
                requirement.kind !== 'behavior') ||
              (criterion.kind === 'process' &&
                Boolean(criterion.testCase) &&
                criterion.testCase?.scenario === scenario &&
                (criterion.testCase?.expectedOutcome ?? 'must_happen') ===
                  requirement.expectedOutcome &&
                !objectives.some((other) =>
                  other.criteria.some(
                    (c) =>
                      c !== criterion &&
                      c.testCase?.name === criterion.testCase?.name &&
                      c.command === criterion.command &&
                      c.directory === criterion.directory &&
                      (c.requirementQuote ?? other.sourceQuote) !==
                        (criterion.requirementQuote ?? objective.sourceQuote),
                  ),
                ))),
        );
      }),
    );
    return {
      id: `coverage:${requirement.id}`,
      label: `验收覆盖：${requirement.quote.slice(0, 240)}`,
      status: adequate ? 'passed' : 'not_run',
    };
  });
}
