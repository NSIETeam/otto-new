/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  extractTaskRequirements,
  type TaskRequirement,
} from './taskRequirements.js';
import type { TurnVerificationCheck } from './protocol.js';
import { WorkspacePathIdentity } from './workspacePathIdentity.js';

type Call = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  nativeSafe?: boolean;
};
type Monitor =
  | 'external_app'
  | 'workspace'
  | 'preserved_file'
  | 'visible_path'
  | 'manual'
  | 'side_effect'
  | 'unresolved'
  | 'semantic';
type Rule = {
  requirement: TaskRequirement;
  monitor: Monitor;
  allowedRoot?: string;
  files?: Array<{ path: string; digest: string }>;
};
const READS = new Set([
  'read_file',
  'read_many_files',
  'list_directory',
  'glob',
  'search_file_content',
  'grep_search',
  'update_task_plan',
  'plan_delivery_repair',
  'prepare_repair_format',
  'review_answer_evidence',
  'ask_user_question',
]);
// Dispatch additionally verifies the exact native implementation (including the
// host learning wrapper). This is not a script/command keyword allowlist.
const WRITES = new Set(['write_file', 'replace', 'generate_safe_document']);
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

/** Resolve the bound host root, then reject every descendant alias. A recheck
 * runs at dispatch after any approval wait. This is not an OS sandbox. */
function localTarget(raw: unknown, root: WorkspacePathIdentity): string {
  if (
    typeof raw !== 'string' ||
    !raw.trim() ||
    /\0|^[a-z][\w+.-]*:\/\//iu.test(raw) ||
    /^[a-z]:(?![\\/])/iu.test(raw)
  )
    throw new Error('无法核对文件目标');
  const target = root.resolveTarget(raw);
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    if (existsSync(cursor)) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
        throw new Error('文件目标含链接或目录联接');
    }
    if (cursor === path.dirname(cursor)) break;
  }
  return target;
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
function fingerprint(file: string): string {
  try {
    if (!existsSync(file)) return 'absent';
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
      return 'unobserved';
    return hash(readFileSync(file));
  } catch {
    return 'unobserved';
  }
}
// Link destinations are non-visible app navigation metadata, not bare path text.
// Web links are preserved, but a path used as a label is still redacted.
function redactPlainPaths(text: string): string {
  return text.replace(
    /(?:file:\/\/[^\s`<>"'\r\n]+|(?<![\w])[a-z]:[\\/][^`<>"'\r\n，。；！？)\]]+|\\\\[^\s`<>"']+|(?<![\w:/])(?:~\/|\/(?!\/))[^\s`<>"'，。；！？)\]]+)/giu,
    '文件（请通过附件或文件链接查看）',
  );
}
function redactProsePaths(text: string): string {
  const destinations: string[] = [];
  const nonce = `OTTO_LINK_${randomUUID()}_`;
  const links = text.replace(
    /(\]\()(<?(?:[a-z]:[\\/]|\/|~[\\/]|file:\/\/)[^\r\n)]*?)(\))/giu,
    (_m, prefix: string, target: string, suffix: string) => {
      destinations.push(target);
      return `${prefix}${nonce}${destinations.length - 1}_END${suffix}`;
    },
  );
  let redacted = redactPlainPaths(links);
  destinations.forEach((target, index) => {
    redacted = redacted.replaceAll(`${nonce}${index}_END`, target);
  });
  return redacted;
}
function redactVisiblePaths(text: string): string {
  // Markdown-looking links inside code are displayed literally, not navigable
  // targets. They must not receive the prose link exception.
  const code =
    /(?<fence>`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?(?:\k<fence>|$)|(?<ticks>`+)[^`]*?\k<ticks>/gu;
  let start = 0;
  let output = '';
  for (const match of text.matchAll(code)) {
    output +=
      redactProsePaths(text.slice(start, match.index)) +
      redactPlainPaths(match[0]);
    start = match.index + match[0].length;
  }
  return output + redactProsePaths(text.slice(start));
}

/** Native, per-turn evidence. Never accepts tool/model-reported "constraint passed".
 * Unsupported semantic constraints stay unobserved; a successful unrelated tool
 * cannot substitute for coverage. A deny is evidence of prevention, not execution. */
export class TurnConstraintGuard {
  readonly requirements: TaskRequirement[];
  private rules: Rule[];
  private root: string;
  private readonly workspaceIdentity?: WorkspacePathIdentity;
  private started = false;
  private gap = false;
  private pending = new Set<string>();
  private executed: string[] = [];
  private blocked: Array<{ callId: string; ruleId: string; reason: string }> =
    [];
  private reviewTicket?: { id: string; digest: string };
  private approvedDigest?: string;
  private readonly requestDigest: string;
  private reviews: Array<{
    id: string;
    digest: string;
    outcome: 'approved' | 'not_approved';
    at: number;
  }> = [];
  private semanticEvidence = new Map<string, TurnVerificationCheck[]>();
  constructor(
    request: string,
    private readonly context: {
      turnId: string;
      sourceMessageId?: string;
      workspacePath?: string;
    },
  ) {
    this.workspaceIdentity = context.workspacePath
      ? new WorkspacePathIdentity(context.workspacePath)
      : undefined;
    this.root = this.workspaceIdentity?.canonicalPath ?? '';
    this.requestDigest = hash(request);
    this.requirements = extractTaskRequirements(request);
    this.rules = this.requirements
      .filter((r) => r.kind !== 'behavior')
      .map((requirement) => {
        const text = requirement.quote;
        // Business predicates are checked by current named cases, not by banning
        // every write. Ambiguous operational boundaries remain fail-closed.
        let monitor: Monitor =
          /文件|路径|工作区|工作目录|WPS|Keynote|PowerPoint|外部|应用|程序|命令|脚本|后端|服务器|联网|网络|部署|推送|发送|人工|批准|确认.*(?:后|再)|(?:file|path|workspace|shell|script|app|deploy|network)\b/iu.test(
            text,
          )
            ? 'unresolved'
            : 'semantic';
        if (requirement.kind === 'manual')
          monitor =
            /确认.*(?:后|再).*(?:修改|写|执行|运行)|before|only after/iu.test(
              text,
            )
              ? 'unresolved'
              : 'manual';
        else if (
          requirement.kind === 'prohibition' &&
          /(?:绝对路径|裸露路径|absolute paths?)/iu.test(text)
        )
          monitor = 'visible_path';
        else if (
          requirement.kind === 'prohibition' &&
          /(?:打开|启动|唤起|(?:不|别|勿)开|open|launch).*(?:WPS|Keynote|PowerPoint|外部|应用|程序|app)/iu.test(
            text,
          )
        )
          monitor = 'external_app';
        else if (
          /(?:工作区|工作目录|workspace)/iu.test(text) &&
          /(?:只|仅|不.*(?:超出|越界)|within|only)/iu.test(text)
        )
          monitor = 'workspace';
        else if (
          requirement.kind === 'prohibition' &&
          /(?:越界|工作区外).*(?:写|修改|覆盖)/u.test(text)
        )
          monitor = 'workspace';
        else if (
          requirement.kind === 'prohibition' &&
          /(?:部署|发送|推送|deploy|send|push)/iu.test(text)
        )
          monitor = 'side_effect';
        const files: Rule['files'] = [];
        let allowedRoot: string | undefined;
        if (
          requirement.kind === 'scope' &&
          /目录|工作区|工作目录|workspace/iu.test(text)
        ) {
          const targets = [...text.matchAll(/`([^`]+)`/gu)];
          if (targets.length === 1 && this.root) {
            monitor = 'unresolved';
            try {
              const candidate = localTarget(targets[0][1], this.workspaceIdentity!);
              if (within(this.root, candidate)) {
                monitor = 'workspace';
                allowedRoot = candidate;
              }
            } catch {
              monitor = 'unresolved';
            }
          } else if (
            targets.length ||
            /(?:工作区|工作目录|workspace)(?:的|[\\/])\s*(?!文件)[^。]+/iu.test(
              text,
            )
          ) {
            monitor = 'unresolved';
          }
        }
        if (
          requirement.kind === 'preservation' &&
          /不变|不修改|unchanged/iu.test(text)
        ) {
          for (const match of text.matchAll(/`([^`]+)`/gu)) {
            try {
              const file = this.root ? localTarget(match[1], this.workspaceIdentity!) : '';
              if (file && within(this.root, file))
                files.push({ path: file, digest: fingerprint(file) });
            } catch {
              /* Remains unresolved; don't invent a successful observation. */
            }
          }
          if (
            files.length &&
            files.length === [...text.matchAll(/`([^`]+)`/gu)].length
          )
            monitor = 'preserved_file';
          else monitor = 'unresolved';
        }
        return {
          requirement,
          monitor,
          allowedRoot,
          ...(files.length ? { files } : {}),
        };
      });
  }
  get active(): boolean {
    return this.rules.length > 0;
  }
  get protectsOutput(): boolean {
    return this.rules.some((r) => r.monitor === 'visible_path');
  }
  get needsManualReview(): boolean {
    return this.rules.some((r) => r.monitor === 'manual');
  }
  coverageStarted(): void {
    this.started = true;
  }
  /** Carry native preservation baselines and coverage, never approvals, across a request revision. */
  inherit(previous: ReturnType<TurnConstraintGuard['snapshot']>, recovering = false): void {
    if (!previous || previous.version !== 1 || typeof previous.gap !== 'boolean' || typeof previous.coverage !== 'boolean' ||
      !Array.isArray(previous.monitors) || previous.monitors.length > 128 || !Array.isArray(previous.executed) ||
      !Array.isArray(previous.pending) || !Array.isArray(previous.blocked) || !Array.isArray(previous.reviews) ||
      previous.monitors.some(m => !m || typeof m.requirementId !== 'string' || typeof m.monitor !== 'string' ||
        (m.files !== undefined && (!Array.isArray(m.files) || m.files.some(f => !f || typeof f.path !== 'string' || typeof f.digest !== 'string')))))
      throw new Error('Invalid constraint continuity snapshot');
    if (previous.turnId !== this.context.turnId || previous.workspacePath !== this.context.workspacePath)
      throw new Error('Constraint continuity identity mismatch');
    for (const rule of this.rules) {
      const old = previous.monitors.find(m => m.requirementId === rule.requirement.id && m.monitor === rule.monitor);
      if (recovering && (!old || (!!rule.files && !old.files))) throw new Error('Missing original constraint observation');
      if (old?.files && (!rule.files || old.files.length !== rule.files.length || old.files.some((f, i) =>
        f.path !== rule.files![i].path || !/^(?:[a-f0-9]{64}|absent|unobserved)$/u.test(f.digest))))
        throw new Error('Invalid original preservation identity');
      if (old?.files) rule.files = structuredClone(old.files);
    }
    this.executed = [...previous.executed];
    this.blocked = structuredClone(previous.blocked);
    this.started = true;
    this.gap = previous.gap || previous.pending.length > 0 || (recovering && !previous.coverage);
    this.reviews = structuredClone(previous.reviews);
  }
  markGap(): void {
    this.gap = true;
  }
  private executionRules(): Rule[] {
    return this.rules.filter(
      (r) => !['visible_path', 'manual', 'semantic'].includes(r.monitor),
    );
  }
  setSemanticEvidence(evidence: Map<string, TurnVerificationCheck[]>): void {
    this.semanticEvidence = structuredClone(evidence);
  }
  needsDirection(text: string): boolean {
    const checks = this.checks(text);
    return this.rules.some(
      (r) =>
        r.monitor !== 'semantic' &&
        checks.find((c) => c.id === `constraint:${r.requirement.id}`)
          ?.status !== 'passed',
    );
  }
  review(call: Call): void {
    const rules = this.executionRules();
    if (!rules.length) return;
    const deny = (rule: Rule, reason: string): never => {
      if (
        !this.blocked.some(
          (b) => b.callId === call.callId && b.ruleId === rule.requirement.id,
        )
      )
        this.blocked.push({
          callId: call.callId,
          ruleId: rule.requirement.id,
          reason,
        });
      throw new Error(
        `用户约束阻止执行：${reason}。不能用工具批准覆盖本轮约束。`,
      );
    };
    if (call.nativeSafe === false)
      deny(rules[0], '工具不是可审计的原生实现，不能只凭名称放行');
    if (READS.has(call.name)) return;
    if (!WRITES.has(call.name))
      deny(
        rules[0],
        '该工具可能包含脚本、外部应用、委派或其他未受审计的副作用；纯文本 PPTX 可使用 generate_safe_document。任意脚本需要先具备经核实的隔离执行能力；当前不能凭命令名称放行，也不能取消原验收要求',
      );
    let target: string;
    try {
      if (!this.root) throw new Error('缺少可信工作目录');
      target = localTarget(call.args.file_path, this.workspaceIdentity!);
    } catch {
      return deny(rules[0], '文件目标无法安全核对');
    }
    for (const rule of rules) {
      if (
        rule.monitor === 'workspace' &&
        (!this.root || !within(rule.allowedRoot ?? this.root, target))
      )
        deny(rule, '文件写入超出授权工作目录');
      if (
        rule.monitor === 'preserved_file' &&
        rule.files?.some((f) => path.relative(f.path, target) === '')
      )
        deny(rule, '目标文件要求保持不变');
      if (rule.monitor === 'unresolved')
        deny(rule, '该约束尚没有可执行的原生检查器，需要明确操作范围');
    }
  }
  start(call: Call): void {
    this.review(call);
    this.pending.add(call.callId);
  }
  finish(callId: string): void {
    if (
      this.pending.delete(callId) &&
      !this.blocked.some((b) => b.callId === callId)
    )
      this.executed.push(callId);
  }
  sanitize(text: string): string {
    return this.protectsOutput ? redactVisiblePaths(text) : text;
  }
  /** Presentation copies only: keep raw native receipts for verification. */
  presentation<T>(value: T): T {
    if (!this.protectsOutput) return value;
    return JSON.parse(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'string' ? this.sanitize(item) : item,
      ),
    ) as T;
  }
  private reviewDigest(text: string): string | undefined {
    const files: Array<[string, string]> = [];
    for (const match of text.matchAll(/\]\(<?([^\r\n)]+?)>?\)/gu)) {
      const raw = match[1];
      if (/^https?:\/\//iu.test(raw)) continue;
      try {
        const file = this.root ? localTarget(raw, this.workspaceIdentity!) : '';
        if (!file || !within(this.root, file)) return undefined;
        const digest = fingerprint(file);
        if (['unobserved', 'absent'].includes(digest)) return undefined;
        files.push([file, digest]);
      } catch {
        return undefined;
      }
    }
    return hash(JSON.stringify([this.context, this.requirements, text, files]));
  }
  prepareReview(text: string): { id: string; text: string } | undefined {
    if (!this.needsManualReview) return undefined;
    const digest = this.reviewDigest(text);
    if (!digest || digest === this.approvedDigest) return undefined;
    this.reviewTicket = { id: `constraint-review-${randomUUID()}`, digest };
    return { id: this.reviewTicket.id, text };
  }
  confirmReview(id: string, text: string, approved: boolean): boolean {
    const ticket = this.reviewTicket;
    if (!ticket || ticket.id !== id) return false;
    this.reviewTicket = undefined;
    const valid = approved && ticket.digest === this.reviewDigest(text);
    this.reviews.push({
      ...ticket,
      outcome: valid ? 'approved' : 'not_approved',
      at: Date.now(),
    });
    if (!valid) return false;
    this.approvedDigest = ticket.digest;
    return true;
  }
  checks(text: string): TurnVerificationCheck[] {
    const coverage = this.started && !this.gap && this.pending.size === 0;
    return this.rules.map((rule) => {
      let status: TurnVerificationCheck['status'] = 'not_run';
      let evidence: string[] = [];
      if (rule.monitor === 'visible_path') {
        status = text === this.sanitize(text) ? 'passed' : 'failed';
        evidence = [`visible-text-sha256:${hash(text)}`];
      } else if (rule.monitor === 'manual') {
        const digest = this.reviewDigest(text);
        status =
          digest && digest === this.approvedDigest ? 'passed' : 'not_run';
        if (status === 'passed') evidence = [`human-approved:${digest}`];
      } else if (rule.monitor === 'preserved_file') {
        const current = rule.files?.map((f) => fingerprint(f.path)) ?? [];
        status =
          current.includes('unobserved') ||
          rule.files?.some((f) => f.digest === 'unobserved')
            ? 'not_run'
            : rule.files?.some((f, i) => f.digest !== current[i])
              ? 'failed'
              : coverage
                ? 'passed'
                : 'not_run';
        evidence = current.map((digest) => `file-sha256:${digest}`);
      } else if (rule.monitor === 'semantic') {
        const checks = this.semanticEvidence.get(rule.requirement.id) ?? [];
        status = checks.some((c) => c.status === 'failed')
          ? 'failed'
          : checks.length && checks.every((c) => c.status === 'passed')
            ? 'passed'
            : 'not_run';
        evidence = checks.flatMap((c) => c.evidence ?? []);
      } else if (rule.monitor !== 'unresolved') {
        status = coverage ? 'passed' : 'not_run';
        evidence = coverage
          ? ['native-dispatch-coverage', ...this.executed]
          : [];
      }
      return {
        id: `constraint:${rule.requirement.id}`,
        label: rule.requirement.quote,
        status,
        evidence,
      };
    });
  }
  snapshot() {
    return structuredClone({
      version: 1 as const,
      ...this.context,
      requestDigest: this.requestDigest,
      reviews: this.reviews,
      requirements: this.requirements,
      monitors: this.rules.map((r) => ({
        requirementId: r.requirement.id,
        monitor: r.monitor,
        ...(r.allowedRoot ? { allowedRoot: r.allowedRoot } : {}),
        ...(r.files ? { files: r.files } : {}),
      })),
      coverage: this.started && !this.gap && !this.pending.size,
      gap: this.gap,
      executed: this.executed,
      pending: [...this.pending],
      blocked: this.blocked,
    });
  }
}
