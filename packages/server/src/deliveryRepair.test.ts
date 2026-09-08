import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeliveryRepairGuard } from './deliveryRepair.js';
import { ToolCallStatus, type ToolCall } from './protocol.js';

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const card = (name: string, file: string): ToolCall => ({
  id: crypto.randomUUID(),
  toolName: name,
  parameters: { file_path: file },
  status: ToolCallStatus.Success,
  result: { success: true, executionTime: 1, toolName: name },
});
const failed = (): ToolCall => ({
  ...card('run_shell_command', ''),
  status: ToolCallStatus.Error,
  parameters: { command: 'npm test' },
  result: {
    success: false,
    error: 'test failure',
    toolName: 'run_shell_command',
    executionTime: 1,
    process: {
      command: 'npm test',
      directory: '/repo',
      exitCode: 1,
      signal: null,
      status: 'exited',
    },
  },
});
describe('bounded repair in the already authorized file scope', () => {
  it('requires an original write, failed check and fresh read; allows two repair/retest cycles', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'otto-repair-'));
    roots.push(root);
    const file = path.join(root, 'login.ts');
    writeFileSync(file, 'old');
    const guard = new DeliveryRepairGuard({
      workspacePath: root,
      requestRevision: 1,
      acceptanceKey: 'original',
    });
    const edit = card('replace', file);
    expect(guard.reserve(edit)).toBe(false);
    guard.observe(edit, false);
    guard.observe(card('read_file', file), false);
    expect(guard.reserve(edit)).toBe(false);
    for (let i = 0; i < 2; i++) {
      guard.observe(failed(), true);
      expect(guard.reserve(edit)).toBe(false);
      guard.observe(card('read_file', file), true);
      expect(guard.reserve(edit)).toBe(true);
      writeFileSync(file, `patch-${i}`);
      guard.observe(card('replace', file), true);
    }
    guard.observe(failed(), true);
    guard.observe(card('read_file', file), true);
    expect(guard.reserve(edit)).toBe(false);
  });
  it('rejects stale reads, untouched paths, shell commands and external actions', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'otto-repair-'));
    roots.push(root);
    const file = path.join(root, 'login.ts');
    writeFileSync(file, 'old');
    const guard = new DeliveryRepairGuard({
      workspacePath: root,
      requestRevision: 1,
      acceptanceKey: 'original',
    });
    guard.observe(card('replace', file), false);
    guard.observe(failed(), true);
    guard.observe(card('read_file', file), true);
    writeFileSync(file, 'user changed');
    expect(guard.reserve(card('replace', file))).toBe(false);
    expect(guard.reserve(card('write_file', path.join(root, 'new.ts')))).toBe(
      false,
    );
    expect(guard.reserve(card('run_shell_command', file))).toBe(false);
    expect(guard.reserve(card('send_email', file))).toBe(false);
  });
  it('rechecks the file after a permission wait instead of overwriting a concurrent user edit', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'otto-repair-'));
    roots.push(root);
    const file = path.join(root, 'login.ts');
    writeFileSync(file, 'old');
    const guard = new DeliveryRepairGuard({
      workspacePath: root,
      requestRevision: 1,
      acceptanceKey: 'original',
    });
    guard.observe(card('replace', file), false);
    guard.observe(failed(), true);
    guard.observe(card('read_file', file), true);
    const repair = card('replace', file);
    expect(guard.reserve(repair)).toBe(true);
    expect(guard.validateReserved(repair.id)).toBe(true);
    writeFileSync(file, 'concurrent edit');
    expect(guard.validateReserved(repair.id)).toBe(false);
  });
});
