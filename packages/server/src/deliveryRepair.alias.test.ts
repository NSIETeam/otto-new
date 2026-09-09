/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  renameSync,
  linkSync,
  writeFileSync,
} from 'node:fs';
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
function call(name: string, file: string): ToolCall {
  return {
    id: crypto.randomUUID(),
    toolName: name,
    parameters: { file_path: file },
    status: ToolCallStatus.Success,
    result: { success: true, toolName: name, executionTime: 1 },
  };
}
function setup() {
  const base = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'otto-repair-alias-')),
  );
  roots.push(base);
  const physical = path.join(base, 'physical');
  const other = path.join(base, 'other');
  const alias = path.join(base, 'host-workspace');
  mkdirSync(physical);
  mkdirSync(other);
  symlinkSync(physical, alias, 'junction');
  for (const root of [physical, other])
    writeFileSync(path.join(root, 'a.ts'), 'export const a=1;');
  const file = path.join(alias, 'a.ts');
  const canonicalFile = path.join(physical, 'a.ts');
  const context = {
    workspacePath: alias,
    requestRevision: 1,
    acceptanceKey: 'original',
  };
  const guard = new DeliveryRepairGuard(context);
  guard.observe(call('replace', file), false);
  const failed = call('run_shell_command', '');
  failed.status = ToolCallStatus.Error;
  failed.parameters = { command: 'npm test', directory: alias };
  failed.result = {
    success: false,
    toolName: failed.toolName,
    executionTime: 1,
    process: {
      command: 'npm test',
      directory: alias,
      status: 'exited',
      exitCode: 1,
      signal: null,
    },
  };
  guard.observe(failed, true, [canonicalFile]);
  guard.observe(call('read_file', canonicalFile), true);
  const plan = (files: string[] = [file]) =>
    guard.compare(
      {
        requestRevision: 1,
        failedToolCallId: failed.id,
        alternatives: [
          { id: 'repair', reason: 'Repair the observed implementation', files },
        ],
      },
      context,
    );
  const retarget = () => {
    unlinkSync(alias);
    symlinkSync(other, alias, 'junction');
  };
  return {
    base,
    physical,
    other,
    alias,
    file,
    canonicalFile,
    guard,
    plan,
    retarget,
  };
}

it('maps only the host root alias and matches lexical calls to canonical native inputs', () => {
  const s = setup();
  expect(s.plan().selectedId).toBe('repair');
  const edit = call('replace', s.file);
  expect(s.guard.reserve(edit)).toBe(true);
  expect(
    s.guard.validateReserved(edit.id, {
      name: edit.toolName,
      args: edit.parameters,
    }),
  ).toBe(true);
});

it('revokes a pending approval if the host alias is retargeted to identical bytes', () => {
  const s = setup();
  s.plan();
  const edit = call('replace', s.file);
  expect(s.guard.reserve(edit)).toBe(true);
  s.retarget();
  expect(s.guard.validateReserved(edit.id)).toBe(false);
});

it('revokes a pending approval when the original root inode is replaced', () => {
  const s = setup();
  s.plan();
  const edit = call('replace', s.file);
  expect(s.guard.reserve(edit)).toBe(true);
  renameSync(s.physical, path.join(s.base, 'original'));
  mkdirSync(s.physical);
  writeFileSync(s.canonicalFile, 'export const a=1;');
  expect(s.guard.validateReserved(edit.id)).toBe(false);
});

it('rejects internal links, hard links, raw traversal and other roots before repair selection', () => {
  const s = setup();
  const internal = path.join(s.physical, 'linked');
  symlinkSync(s.physical, internal, 'junction');
  expect(
    s.plan([path.join(s.alias, 'linked', 'a.ts')]).selectedId,
  ).toBeUndefined();
  expect(s.plan([path.join(s.other, 'a.ts')]).selectedId).toBeUndefined();
  expect(() =>
    s.plan([`${s.alias}${path.sep}linked${path.sep}..${path.sep}a.ts`]),
  ).toThrow();
  linkSync(s.canonicalFile, path.join(s.physical, 'hard.ts'));
  expect(s.plan().selectedId).toBeUndefined();
});

it('rejects a dangling descendant inserted after approval for an absent regression', () => {
  const s = setup();
  const test = path.join(s.alias, 'a.test.ts');
  expect(s.plan([s.file, test]).selectedId).toBe('repair');
  const edit = call('write_file', test);
  expect(s.guard.reserve(edit)).toBe(true);
  symlinkSync(path.join(s.base, 'missing'), test, 'junction');
  expect(s.guard.validateReserved(edit.id)).toBe(false);
});

it('rechecks the original host identity after asynchronous formatting', async () => {
  const s = setup();
  expect(s.plan().selectedId).toBe('repair');
  const pending = s.guard.prepareFormat(s.file);
  s.retarget();
  await expect(pending).rejects.toThrow(/stale|identity/i);
});
