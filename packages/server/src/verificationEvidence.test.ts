/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { verificationKind } from './verificationEvidence.js';
import { ToolCallStatus, type ToolCall } from './protocol.js';

function shell(command: string): ToolCall {
  return {
    id: 'check',
    toolName: 'run_shell_command',
    parameters: { command },
    status: ToolCallStatus.Executing,
  };
}

describe('verification runner classification', () => {
  it.each([
    ['npm test', 'test'],
    ['npm run test:ci --workspace=packages/server', 'test'],
    ['npm --workspace packages/server run typecheck', 'typecheck'],
    ['pnpm --filter server test', 'test'],
    ['yarn build', 'build'],
    ['npx vitest run src/login.test.ts', 'test'],
    ['npx jest --runInBand', 'test'],
    ['python -m pytest tests/test_login.py', 'test'],
    ['node --test tests/login.js', 'test'],
    ['npx tsc --noEmit', 'typecheck'],
    ['npx eslint src', 'lint'],
    ['cargo check', 'typecheck'],
    ['cargo test', 'test'],
    ['go test ./...', 'test'],
  ])('recognizes the actual invocation %s', (command, kind) => {
    expect(verificationKind(shell(command))).toBe(kind);
  });
  it.each([
    'echo "npm test"',
    'node -e "console.log(\'tests passed\')"',
    'npm test && echo done',
    'npm test; exit 0',
    'npm test | cat',
    'npm test || true',
    'npm test\nnpm run build',
    'npm test &',
    'npm run test --if-present',
    'npm test -- --help',
    'npx vitest --version',
    'npx vitest run --passWithNoTests',
    'npx vitest run --list',
    'npx tsc --showConfig',
    'npx tsc --noCheck',
    'npx tsc --listFilesOnly',
    'cargo test --no-run',
    'python -m pytest --co',
    'pytest --setup-only',
    'pytest --fixtures',
    'npx tsc --init',
    'npx eslint --print-config src/file.ts',
    'npx eslint src --fix',
    'npm test -- -u',
    'npx jest --updateSnapshot',
    'npm test "unterminated',
    'cmd /c npm test',
  ])(
    'does not call a no-op, mutating check or compound shell command verification: %s',
    (command) => {
      expect(verificationKind(shell(command))).toBeUndefined();
    },
  );
});
