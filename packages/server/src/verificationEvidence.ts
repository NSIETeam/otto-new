/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import {
  ToolCallStatus,
  type ToolCall,
  type TurnVerificationCheck,
  type TurnVerificationKind,
} from './protocol.js';

export const VERIFICATION_LABELS: Record<TurnVerificationKind, string> = {
  test: '测试',
  typecheck: '类型检查',
  lint: '静态检查',
  build: '构建',
};

function scriptKind(
  script: string | undefined,
): TurnVerificationKind | undefined {
  const name = script?.split(':')[0];
  return name === 'test' ||
    name === 'typecheck' ||
    name === 'lint' ||
    name === 'build'
    ? name
    : undefined;
}

/**
 * Deliberately accepts only single foreground invocations of known check
 * runners. This is an evidence classifier, NOT a shell security/approval gate.
 * Wrappers, pipelines, optional scripts and arbitrary plugin names fail closed.
 */
export function verificationKind(
  tool: ToolCall,
): TurnVerificationKind | undefined {
  if (
    tool.toolName !== 'run_shell_command' ||
    typeof tool.parameters.command !== 'string'
  )
    return undefined;
  if (tool.parameters.action && tool.parameters.action !== 'execute')
    return undefined;
  const command = tool.parameters.command.trim();
  if (!command || /[\r\n;&|<>`$^%()]/u.test(command)) return undefined;
  const tokens = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/gu) ?? [];
  if (tokens.join('').replace(/\s/gu, '') !== command.replace(/\s/gu, ''))
    return undefined;
  const argv = tokens.map((token) => token.replace(/^(["'])(.*)\1$/u, '$2'));
  if (
    argv.some((arg) =>
      /^(?:--?(?:help|version|watch|watchAll|listTests|list|dry-run|if-present|passWithNoTests|ignore-scripts|collect-only|co|setup-only|fixtures|no-check|noCheck|no-run|showConfig|listFilesOnly|init|print-config|fix|update|updateSnapshot)|-[hvu])(?:=|$)/iu.test(
        arg,
      ),
    )
  )
    return undefined;
  let program = argv
    .shift()
    ?.split(/[\\/]/u)
    .at(-1)
    ?.replace(/\.(?:cmd|exe)$/iu, '');
  if (program === 'npx') program = argv.shift();
  if (program === 'npm' || program === 'pnpm' || program === 'yarn') {
    // Workspace options affect the evidence scope, but not the runner kind.
    while (argv[0]?.startsWith('-')) {
      const flag = argv.shift()!;
      if (/^(?:-w|--workspace|--filter|--prefix|--cwd)$/u.test(flag)) {
        if (!argv.shift()) return undefined;
      } else if (
        !/^(?:--workspace|--filter|--prefix|--cwd)=.+$/u.test(flag) &&
        flag !== '--workspaces'
      )
        return undefined;
    }
    if (argv[0] === 'run' || argv[0] === 'run-script') argv.shift();
    return scriptKind(argv[0]);
  }
  if (program === 'vitest') return argv[0] === 'run' ? 'test' : undefined;
  if (program === 'jest' || program === 'pytest') return 'test';
  if (program === 'python' || program === 'python3')
    return argv[0] === '-m' && argv[1] === 'pytest' ? 'test' : undefined;
  if (program === 'node') return argv[0] === '--test' ? 'test' : undefined;
  if (program === 'tsc')
    return argv.includes('--noEmit') ? 'typecheck' : 'build';
  if (program === 'eslint') return 'lint';
  if (program === 'cargo' || program === 'go') {
    if (argv[0] === 'test') return 'test';
    if (argv[0] === 'build') return 'build';
    if (program === 'cargo' && argv[0] === 'check') return 'typecheck';
    if (program === 'go' && argv[0] === 'vet') return 'lint';
  }
  return undefined;
}

export function hasSuccessfulProcessReceipt(tool: ToolCall): boolean {
  const receipt = tool.result?.process;
  return (
    tool.toolName === 'run_shell_command' &&
    tool.status === ToolCallStatus.Success &&
    tool.result?.success === true &&
    !tool.result.error &&
    !!receipt &&
    receipt.command === String(tool.parameters.command ?? '').trim() &&
    receipt.status === 'exited' &&
    receipt.exitCode === 0 &&
    receipt.signal === null
  );
}

interface Observation {
  tool: ToolCall;
  kind: TurnVerificationKind;
  revision?: number;
}

/** Retains every attempted scope. Only a retry of the SAME invocation replaces it. */
export class VerificationEvidenceLedger {
  private revision = 0;
  private mutationStates = new Map<string, ToolCallStatus>();
  private observations = new Map<string, Observation>();

  observe(tool: ToolCall, mutating: boolean): void {
    const kind = verificationKind(tool);
    if (kind) {
      const previous = this.observations.get(tool.id);
      this.observations.set(tool.id, {
        tool: {
          ...tool,
          parameters: { ...tool.parameters },
          ...(tool.result
            ? {
                result: {
                  ...tool.result,
                  ...(tool.result.process
                    ? { process: { ...tool.result.process } }
                    : {}),
                },
              }
            : {}),
        },
        kind,
        revision:
          previous?.revision ??
          ([
            ToolCallStatus.Scheduled,
            ToolCallStatus.Validating,
            ToolCallStatus.WaitingForConfirmation,
          ].includes(tool.status)
            ? undefined
            : this.revision),
      });
    } else if (
      mutating &&
      [
        ToolCallStatus.Executing,
        ToolCallStatus.Success,
        ToolCallStatus.Error,
        ToolCallStatus.Canceled,
      ].includes(tool.status)
    ) {
      if (this.mutationStates.get(tool.id) !== tool.status) this.revision++;
      this.mutationStates.set(tool.id, tool.status);
    }
  }

  checks(kind?: TurnVerificationKind): TurnVerificationCheck[] {
    const scopes = new Map<string, Observation>();
    for (const observation of this.observations.values()) {
      if (kind && observation.kind !== kind) continue;
      const { tool } = observation;
      const scope = JSON.stringify([
        tool.parameters.command,
        tool.result?.process?.directory ?? tool.parameters.directory ?? '',
      ]);
      scopes.set(scope, observation);
    }
    return [...scopes].map(([scope, { tool, kind: checkKind, revision }]) => {
      const receipt = tool.result?.process;
      const failed =
        tool.status === ToolCallStatus.Error ||
        tool.status === ToolCallStatus.Canceled ||
        tool.result?.success === false ||
        Boolean(tool.result?.error) ||
        Boolean(
          receipt &&
          (receipt.status === 'cancelled' ||
            receipt.status === 'timed_out' ||
            receipt.signal ||
            (receipt.exitCode !== null && receipt.exitCode !== 0)),
        );
      const stale = revision !== this.revision;
      const passed = !stale && hasSuccessfulProcessReceipt(tool);
      return {
        id: `verification-scope-${createHash('sha256').update(scope).digest('hex').slice(0, 16)}`,
        label: `${VERIFICATION_LABELS[checkKind]}（独立执行范围）`,
        status: failed ? 'failed' : passed ? 'passed' : 'not_run',
        evidence: [
          `工具调用：${tool.id}`,
          stale
            ? '检查后发生变更，需要重新验证'
            : passed
              ? '该检查进程已正常结束，退出码为 0；不代表其他验收项通过'
              : '未取得该范围的成功执行回执',
        ],
      };
    });
  }
}
