import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  linkSync,
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
    result: { success: true, executionTime: 1, toolName: name },
  };
}
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'otto-repair-strategy-'));
  roots.push(root);
  const a = path.join(root, 'a.ts');
  const b = path.join(root, 'b.ts');
  const test = path.join(root, 'a.test.ts');
  writeFileSync(a, "import { b } from './b.js'; export const a = b;");
  writeFileSync(b, 'export const b=1;');
  const context = {
    workspacePath: root,
    requestRevision: 1,
    acceptanceKey: 'original-criteria',
  };
  const guard = new DeliveryRepairGuard(context);
  guard.observe(call('replace', a), false);
  guard.observe(call('read_file', b), false);
  const fail = (inputs = [a, b]) => {
    const t = call('run_shell_command', '');
    t.status = ToolCallStatus.Error;
    t.parameters = { command: 'npm test', directory: root };
    t.result = {
      success: false,
      executionTime: 1,
      toolName: t.toolName,
      error: 'assertion failed',
      process: {
        command: 'npm test',
        directory: root,
        status: 'exited',
        exitCode: 1,
        signal: null,
      },
    };
    guard.observe(t, true, inputs);
    return t.id;
  };
  const failedToolCallId = fail();
  const read = (file: string) => guard.observe(call('read_file', file), true);
  read(a);
  read(b);
  const plan = (files: string[]) =>
    guard.compare(
      {
        requestRevision: 1,
        failedToolCallId,
        alternatives: [
          {
            id: 'patch',
            reason: 'Fix the observed assertion without changing acceptance',
            files,
          },
        ],
      },
      context,
    );
  return {
    root,
    a,
    b,
    test,
    guard,
    context,
    fail,
    read,
    plan,
    failedToolCallId,
  };
}
describe('native finite repair strategy comparison', () => {
  it('does not let an absent workspace root make sensitive files eligible for fast repair', () => {
    const s = setup();
    for (const name of ['package.json', '.env']) {
      const file = path.join(s.root, name);
      writeFileSync(file, '{}');
      const guard = new DeliveryRepairGuard();
      guard.observe(call('replace', file), false);
      const failed = call('run_shell_command', '');
      failed.parameters = { command: 'npm test', directory: s.root };
      failed.status = ToolCallStatus.Error;
      failed.result = {
        success: false,
        toolName: failed.toolName,
        executionTime: 1,
        process: {
          command: 'npm test',
          directory: s.root,
          status: 'exited',
          exitCode: 1,
          signal: null,
        },
      };
      guard.observe(failed, true, [file]);
      guard.observe(call('read_file', file), true);
      expect(guard.reserve(call('write_file', file))).toBe(false);
    }
  });
  it('applies the workspace and sensitive-file restrictions to the single-file fast path too', () => {
    for (const name of ['package.json', '.env', '../outside-stage4.ts']) {
      const s = setup();
      // Keep the outside target in a separate, test-owned directory.
      const file = name.startsWith('../')
        ? path.join(setup().root, 'outside.ts')
        : path.join(s.root, name);
      writeFileSync(file, '{}');
      s.guard.observe(call('replace', file), false);
      s.fail([file]);
      s.read(file);
      expect(s.guard.reserve(call('write_file', file))).toBe(false);
    }
  });
  it('does not select existing acceptance tests as an easy repair or permit weakening through the fast path', () => {
    const s = setup();
    writeFileSync(s.test, 'test("retry",()=>expect(login()).toBe(2));');
    s.guard.observe(call('replace', s.test), false);
    const failedToolCallId = s.fail([s.a, s.test]);
    s.read(s.a);
    s.read(s.test);
    const result = s.guard.compare(
      {
        requestRevision: 1,
        failedToolCallId,
        alternatives: [
          { id: 'weaken', reason: 'edit assertion', files: [s.test] },
          { id: 'fix', reason: 'fix implementation', files: [s.a] },
        ],
      },
      s.context,
    );
    expect(result.alternatives.find((c) => c.id === 'weaken')?.eligible).toBe(
      false,
    );
    expect(result.selectedId).toBe('fix');
    const fresh = setup();
    writeFileSync(fresh.test, 'test("retry",()=>{});');
    fresh.guard.observe(call('replace', fresh.test), false);
    fresh.fail([fresh.test]);
    fresh.read(fresh.test);
    expect(fresh.guard.reserve(call('write_file', fresh.test))).toBe(false);
  });
  it.each([true, false])(
    'revokes pending repair after the same native verification succeeds (explicit plan %s)',
    (explicitPlan) => {
      const s = setup();
      if (explicitPlan) s.plan([s.a, s.b]);
      const pending = call('replace', s.a);
      expect(s.guard.reserve(pending)).toBe(true);
      const success = call('run_shell_command', '');
      success.parameters = { command: 'npm test', directory: s.root };
      success.result!.process = {
        command: 'npm test',
        directory: s.root,
        status: 'exited',
        exitCode: 0,
        signal: null,
      };
      s.guard.observe(success, true, [s.a, s.b]);
      expect(s.guard.validateReserved(pending.id)).toBe(false);
      s.read(s.b);
      expect(s.guard.reserve(call('replace', s.b))).toBe(false);
    },
  );
  it('does not open repairs from a mismatched native receipt directory', () => {
    const s = setup();
    s.guard.revise({ ...s.context, acceptanceKey: 'new' });
    const failed = call('run_shell_command', '');
    failed.status = ToolCallStatus.Error;
    failed.parameters = { command: 'npm test', directory: s.root };
    failed.result = {
      success: false,
      toolName: failed.toolName,
      executionTime: 1,
      process: {
        command: 'npm test',
        directory: path.dirname(s.root),
        status: 'exited',
        exitCode: 1,
        signal: null,
      },
    };
    s.guard.observe(failed, true, [s.a]);
    s.read(s.a);
    expect(s.guard.reserve(call('replace', s.a))).toBe(false);
  });
  it('allows a named regression for a related failing input, not an arbitrary new file', () => {
    const { guard, root, a, b, plan } = setup();
    const regression = path.join(root, 'b.test.ts');
    expect(plan([b, regression]).selectedId).toBe('patch');
    expect(guard.reserve(call('write_file', regression))).toBe(true);
    expect(
      guard.reserve(call('write_file', path.join(root, 'unrelated.test.ts'))),
    ).toBe(false);
    expect(guard.reserve(call('replace', a))).toBe(false);
  });
  it('rejects formatting if the user changes the source during its asynchronous preparation', async () => {
    const { guard, a, plan } = setup();
    plan([a]);
    const pending = guard.prepareFormat(a);
    writeFileSync(a, 'concurrent edit');
    await expect(pending).rejects.toThrow('stale');
  });
  it('compares bounded concrete alternatives and selects lower native risk/cost, not model scores', () => {
    const { guard, context, failedToolCallId, a, b, test } = setup();
    const result = guard.compare(
      {
        requestRevision: 1,
        failedToolCallId,
        alternatives: [
          {
            id: 'wide',
            reason: 'Fix two related inputs and add a regression',
            files: [a, b, test],
          },
          {
            id: 'small',
            reason: 'The assertion can be repaired in its original source',
            files: [a],
          },
        ],
      },
      context,
    );
    expect(result.selectedId).toBe('small');
    expect(result.alternatives).toHaveLength(2);
    expect(result.acceptanceKey).toBe(context.acceptanceKey);
    expect(result.requiresReverification).toBe(true);
    expect(guard.reserve(call('replace', b))).toBe(false);
  });
  it('repairs multiple connected inputs and creates a sibling test without authorizing arbitrary files', () => {
    const { guard, a, b, test, plan } = setup();
    expect(plan([a, b, test]).selectedId).toBe('patch');
    for (const [name, file] of [
      ['replace', a],
      ['replace', b],
      ['write_file', test],
    ]) {
      const t = call(name, file);
      t.parameters.content = 'export const fixed = true;';
      expect(guard.reserve(t)).toBe(true);
      expect(guard.validateReserved(t.id)).toBe(true);
      writeFileSync(file, String(t.parameters.content));
      guard.observe(t, true);
    }
    expect(guard.reserve(call('replace', b))).toBe(false);
  });
  it('fails closed for missing reads, unrelated files, secrets, out-of-root and dependency manifests', () => {
    const { root, guard, a, plan, read } = setup();
    for (const name of ['unrelated.ts', '.env', 'package.json']) {
      const file = path.join(root, name);
      writeFileSync(file, '{}');
      read(file);
      expect(plan([a, file]).selectedId).toBeUndefined();
    }
    expect(
      plan([path.join(root, '..', 'outside.ts')]).selectedId,
    ).toBeUndefined();
    const stale = call('replace', a);
    writeFileSync(a, 'concurrent edit');
    expect(guard.reserve(stale)).toBe(false);
  });
  it('rejects stale authority/acceptance and never restores old permits after steering', () => {
    const { guard, a, plan, context } = setup();
    plan([a]);
    const edit = call('replace', a);
    expect(guard.reserve(edit)).toBe(true);
    guard.revise({ ...context, requestRevision: 2 });
    expect(guard.validateReserved(edit.id)).toBe(false);
    expect(guard.reserve(call('replace', a))).toBe(false);
    expect(() => plan([a])).toThrow(/revision/i);
  });
  it('invalidates a permit when original acceptance changes, even without a user revision', () => {
    const { guard, a, plan, context } = setup();
    plan([a]);
    const edit = call('replace', a);
    expect(guard.reserve(edit)).toBe(true);
    guard.revise({ ...context, acceptanceKey: 'stronger-criteria' });
    expect(guard.validateReserved(edit.id)).toBe(false);
  });
  it('rechecks missing test identity and all ancestors after approval, rejecting aliases and hard links', () => {
    const { root, guard, a, b, test, plan } = setup();
    plan([a, b, test]);
    const edit = call('write_file', test);
    expect(guard.reserve(edit)).toBe(true);
    writeFileSync(test, 'user created test');
    expect(guard.validateReserved(edit.id)).toBe(false);
    const second = setup();
    const linked = path.join(second.root, 'linked.ts');
    linkSync(second.a, linked);
    expect(second.plan([second.a]).selectedId).toBeUndefined();
    const dir = path.join(root, 'alias');
    symlinkSync(root, dir, 'junction');
    expect(second.plan([path.join(dir, 'a.ts')]).selectedId).toBeUndefined();
  });
  it('bounds choices and cycles; a new failure is required before another repair batch', () => {
    const s = setup();
    expect(() =>
      s.guard.compare(
        {
          requestRevision: 1,
          failedToolCallId: s.failedToolCallId,
          alternatives: Array.from({ length: 4 }, (_, i) => ({
            id: `a${i}`,
            reason: 'repair',
            files: [s.a],
          })),
        },
        s.context,
      ),
    ).toThrow();
    s.plan([s.a]);
    expect(() => s.plan([s.a])).toThrow(/batch|budget|failure/i);
    const edit = call('replace', s.a);
    expect(s.guard.reserve(edit)).toBe(true);
    writeFileSync(s.a, 'fixed');
    s.guard.observe(edit, true);
    const id = s.fail();
    s.read(s.a);
    s.guard.compare(
      {
        requestRevision: 1,
        failedToolCallId: id,
        alternatives: [
          { id: 'two', reason: 'second bounded repair', files: [s.a] },
        ],
      },
      s.context,
    );
    expect(s.guard.reserve(call('replace', s.a))).toBe(true);
    s.fail();
    s.read(s.a);
    expect(s.guard.reserve(call('replace', s.a))).toBe(false);
  });
  it('formatting prepares content only, with no project config, shell, network, or automatic write', async () => {
    const { root, guard, a, plan } = setup();
    writeFileSync(
      path.join(root, '.prettierrc.cjs'),
      'throw new Error("must not load workspace config")',
    );
    plan([a]);
    const before = readFileSync(a, 'utf8');
    const result = await guard.prepareFormat(a);
    expect(result.content).toContain('export const a');
    expect(readFileSync(a, 'utf8')).toBe(before);
    expect(result.written).toBe(false);
    expect(result.sourceFingerprint).toBeTruthy();
    expect(guard.reserve(call('run_shell_command', a))).toBe(false);
    const sub = path.join(root, 'sub');
    mkdirSync(sub);
    await expect(
      guard.prepareFormat(path.join(sub, 'arbitrary.ts')),
    ).rejects.toThrow();
  });
  it('restores spent budgets but never restores executable permits or file-read authority', () => {
    const { guard, context, plan, a } = setup();
    plan([a]);
    const restored = new DeliveryRepairGuard(context);
    restored.restoreBudget(guard.budgetSnapshot());
    expect(restored.budgetSnapshot().batches).toBe(1);
    expect(restored.reserve(call('replace', a))).toBe(false);
    expect(() =>
      restored.restoreBudget({
        version: 1,
        batches: -1,
        comparisons: 0,
        formats: 0,
      }),
    ).toThrow();
  });
  it('rejects changed parameters after approval, oversized output and unseen false check receipts', () => {
    const { guard, a, plan } = setup();
    plan([a]);
    const edit = call('write_file', a);
    edit.parameters.content = 'safe';
    expect(guard.reserve(edit)).toBe(true);
    expect(
      guard.validateReserved(edit.id, {
        name: edit.toolName,
        args: edit.parameters,
      }),
    ).toBe(true);
    expect(
      guard.validateReserved(edit.id, {
        name: edit.toolName,
        args: { ...edit.parameters, content: 'different' },
      }),
    ).toBe(false);
    const second = setup();
    second.plan([second.a]);
    const huge = call('write_file', second.a);
    huge.parameters.content = 'x'.repeat(2_000_001);
    expect(second.guard.reserve(huge)).toBe(false);
  });
  it('will not select a plan whose required write capability is unavailable', () => {
    const { guard, context, failedToolCallId, a, test } = setup();
    expect(
      guard.compare(
        {
          requestRevision: 1,
          failedToolCallId,
          alternatives: [
            { id: 'new-test', reason: 'Add a regression', files: [a, test] },
          ],
        },
        context,
        ['read_file', 'replace'],
      ).selectedId,
    ).toBeUndefined();
  });
});
