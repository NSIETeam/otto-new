import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  linkSync,
  mkdirSync,
  unlinkSync,
  renameSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TurnConstraintGuard } from './turnConstraints.js';

const dirs: string[] = [];
function harness(request: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'otto-constraint-'));
  dirs.push(root);
  return {
    root,
    guard: new TurnConstraintGuard(request, {
      turnId: 'turn',
      sourceMessageId: 'message',
      workspacePath: root,
    }),
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe('native operational constraints', () => {
  it('accepts the host-selected workspace through an ancestor alias without permitting nested link escapes', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'otto-constraint-alias-'));
    dirs.push(fixture);
    const physical = path.join(fixture, 'physical');
    const workspace = path.join(physical, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const alias = path.join(fixture, 'alias');
    symlinkSync(physical, alias, 'junction');
    const selected = path.join(alias, 'workspace');
    const guard = new TurnConstraintGuard('只允许修改当前工作区。保持 `config.json` 不变。', {
      turnId: 'aliased-root', workspacePath: selected,
    });
    const review = (file_path: string) => guard.review({
      callId: file_path, name: 'write_file', nativeSafe: true, args: { file_path },
    });
    // The temp root can itself be an OS alias, so the native spelling must be realpath.
    for (const target of ['result.json', path.join(selected, 'result.json'), path.join(realpathSync(workspace), 'result.json')])
      expect(() => review(target)).not.toThrow();
    expect(() => review(path.join(selected, 'config.json'))).toThrow();
    expect(() => review(path.join(physical, 'outside.json'))).toThrow();
    symlinkSync(physical, path.join(workspace, 'escape'), 'junction');
    expect(() => review(path.join(selected, 'escape/outside.json'))).toThrow();
  });
  it('rejects an ancestor alias retargeted after the workspace identity was bound', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'otto-constraint-rebind-'));
    dirs.push(fixture);
    const physical = path.join(fixture, 'physical');
    const other = path.join(fixture, 'other');
    mkdirSync(path.join(physical, 'workspace'), { recursive: true });
    mkdirSync(path.join(other, 'workspace'), { recursive: true });
    const alias = path.join(fixture, 'alias');
    symlinkSync(physical, alias, 'junction');
    const selected = path.join(alias, 'workspace');
    const guard = new TurnConstraintGuard('只允许修改当前工作区。', {
      turnId: 'rebound-root', workspacePath: selected,
    });
    const call = { callId: 'write', name: 'write_file', args: { file_path: path.join(selected, 'result.json') } };
    expect(() => guard.review(call)).not.toThrow();
    unlinkSync(alias);
    symlinkSync(other, alias, 'junction');
    expect(() => guard.start(call)).toThrow();
  });
  it('rejects replacement of the workspace directory even when its path is unchanged', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'otto-constraint-replace-'));
    dirs.push(fixture);
    const workspace = path.join(fixture, 'workspace');
    mkdirSync(workspace);
    const guard = new TurnConstraintGuard('只允许修改当前工作区。', { turnId: 'replace-root', workspacePath: workspace });
    const call = { callId: 'write', name: 'write_file', args: { file_path: 'result.json' } };
    expect(() => guard.review(call)).not.toThrow();
    renameSync(workspace, path.join(fixture, 'original'));
    mkdirSync(workspace);
    expect(() => guard.start(call)).toThrow();
  });
  it('supports a new workspace under its bound existing ancestor without accepting a later link', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'otto-constraint-new-'));
    dirs.push(fixture);
    const workspace = path.join(fixture, 'workspace');
    const guard = new TurnConstraintGuard('只允许修改当前工作区。', { turnId: 'new-root', workspacePath: workspace });
    const call = { callId: 'write', name: 'write_file', args: { file_path: 'result.json' } };
    expect(() => guard.review(call)).not.toThrow();
    symlinkSync(fixture, workspace, 'junction');
    expect(() => guard.start(call)).toThrow();
  });
  it('pins a newly created workspace identity before a later same-path replacement', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'otto-constraint-late-root-'));
    dirs.push(fixture);
    const workspace = path.join(fixture, 'workspace');
    const guard = new TurnConstraintGuard('只允许修改当前工作区。', { turnId: 'late-root', workspacePath: workspace });
    const call = { callId: 'write', name: 'write_file', args: { file_path: 'result.json' } };
    mkdirSync(workspace);
    expect(() => guard.review(call)).not.toThrow();
    renameSync(workspace, path.join(fixture, 'original'));
    mkdirSync(workspace);
    expect(() => guard.start(call)).toThrow();
  });
  it.each(['file', 'parent'] as const)('rejects a dangling descendant %s link before any write', (kind) => {
    const { root, guard } = harness('只允许修改当前工作区。');
    const link = path.join(root, kind === 'file' ? 'result.json' : 'linked');
    // Windows needs elevated privileges for file symlinks; a final-component
    // junction exercises the same lstat rejection. POSIX uses a real file link.
    symlinkSync(path.join(root, '../missing-external-target'), link, process.platform === 'win32' ? 'junction' : kind === 'file' ? 'file' : 'dir');
    expect(() => guard.review({ callId: kind, name: 'write_file', args: {
      file_path: kind === 'file' ? link : path.join(link, 'result.json'),
    } })).toThrow();
  });
  it('rejects raw parent traversal that could hide a descendant link during normalization', () => {
    const { root, guard } = harness('只允许修改当前工作区。');
    const outside = mkdtempSync(path.join(tmpdir(), 'otto-constraint-dotdot-'));
    dirs.push(outside);
    symlinkSync(outside, path.join(root, 'escape'), 'junction');
    // Do not path.join this value: the native writer receives the raw spelling.
    for (const file_path of [`${root}/escape/../victim.json`, 'escape/../victim.json'])
      expect(() => guard.review({ callId: file_path, name: 'write_file', args: { file_path } })).toThrow();
  });
  it('pins newly observed intermediate directories while the workspace is still missing', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'otto-constraint-late-parent-'));
    dirs.push(fixture);
    const parent = path.join(fixture, 'new-parent');
    const guard = new TurnConstraintGuard('只允许修改当前工作区。', {
      turnId: 'late-parent', workspacePath: path.join(parent, 'workspace'),
    });
    const call = { callId: 'write', name: 'write_file', args: { file_path: 'result.json' } };
    mkdirSync(parent);
    expect(() => guard.review(call)).not.toThrow();
    renameSync(parent, path.join(fixture, 'original'));
    mkdirSync(parent);
    expect(() => guard.start(call)).toThrow();
  });
  it('permits bounded native document generation, but still blocks arbitrary scripts and protected targets', () => {
    const { root, guard } = harness('生成 PPT，但不要打开 WPS，只允许写入工作目录。');
    expect(() => guard.review({ callId: 'safe', name: 'generate_safe_document', nativeSafe: true, args: { file_path: path.join(root, 'report.pptx') } })).not.toThrow();
    for (const [name, nativeSafe, file_path] of [
      ['generate_safe_document', false, path.join(root, 'report.pptx')],
      ['generate_safe_document', true, path.join(root, '..', 'outside.pptx')],
      ['generate_document', false, path.join(root, 'report.pptx')],
      ['run_shell_command', false, path.join(root, 'report.pptx')],
    ] as const) expect(() => guard.review({ callId: String(name), name, nativeSafe, args: { file_path, command: 'node generate-safe-ppt-test.js' } })).toThrow();
  });
  it.each(['别打开 WPS', '勿打开 WPS', '不打开 WPS', '不启动外部应用', '不开 WPS'])(
    'enforces a short negative constraint: %s',
    (clause) => {
      const { guard } = harness(`生成报告，${clause}。`);
      expect(guard.requirements).toHaveLength(2);
      expect(guard.active).toBe(true);
      expect(() =>
        guard.review({ callId: 'open', name: 'open_file', args: {} }),
      ).toThrow();
    },
  );
  it.each([
    'open_file',
    'open_external',
    'run_shell_command',
    'mcp__open_file',
    'task',
    'batch',
  ])(
    'does not allow %s to bypass an external-application prohibition',
    (name) => {
      const { guard } = harness('生成文档，但不要打开 WPS。');
      expect(() =>
        guard.review({
          callId: 'x',
          name,
          args: { command: 'python script.py' },
        }),
      ).toThrow(/约束/);
      expect(guard.snapshot().blocked).toHaveLength(1);
    },
  );
  it('allows known local reads and writes without invoking an external app', () => {
    const { guard, root } = harness('不要打开 WPS。');
    const call = {
      callId: 'write',
      name: 'write_file',
      args: { file_path: path.join(root, 'a.txt') },
    };
    guard.coverageStarted();
    guard.start(call);
    guard.finish('write');
    expect(guard.checks('').every((c) => c.status === 'passed')).toBe(true);
  });
  it('does not equate missing receipts with no side effects', () => {
    const { guard } = harness('不要打开外部应用。');
    expect(guard.checks('').every((c) => c.status === 'passed')).toBe(false);
    guard.start({ callId: 'read', name: 'read_file', args: {} });
    guard.coverageStarted();
    expect(guard.checks('').some((c) => c.status === 'not_run')).toBe(true);
    guard.finish('read');
    expect(guard.checks('').every((c) => c.status === 'passed')).toBe(true);
    guard.markGap();
    expect(guard.checks('').some((c) => c.status === 'not_run')).toBe(true);
  });
  it('does not treat a successfully blocked attempt as an executed violation', () => {
    const { guard } = harness('不要打开 WPS。');
    guard.coverageStarted();
    expect(() =>
      guard.review({ callId: 'bad', name: 'run_shell_command', args: {} }),
    ).toThrow();
    expect(guard.checks('').every((c) => c.status === 'passed')).toBe(true);
    expect(guard.snapshot().blocked.length).toBe(1);
  });
  it.each(['../outside.txt', 'file:///outside.txt'])(
    'blocks out-of-scope target %s',
    (file) => {
      const { guard } = harness('只允许修改当前工作区。');
      expect(() =>
        guard.review({
          callId: 'write',
          name: 'write_file',
          args: { file_path: file },
        }),
      ).toThrow();
    },
  );
  it('rechecks paths after approval and rejects directory junction escape', () => {
    const { guard, root } = harness('只允许修改当前工作区。');
    const outside = mkdtempSync(path.join(tmpdir(), 'otto-outside-'));
    dirs.push(outside);
    const call = {
      callId: 'write',
      name: 'write_file',
      args: { file_path: path.join(root, 'sub/a.txt') },
    };
    guard.review(call);
    symlinkSync(outside, path.join(root, 'sub'), 'junction');
    expect(() => guard.start(call)).toThrow();
  });
  it('protects an explicitly preserved file by blocking mutations and comparing bytes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'otto-preserve-'));
    dirs.push(root);
    const target = path.join(root, 'config.json');
    writeFileSync(target, '{}');
    const guard = new TurnConstraintGuard('保持 `config.json` 不变。', {
      turnId: 't',
      workspacePath: root,
    });
    guard.coverageStarted();
    expect(() =>
      guard.review({
        callId: 'w',
        name: 'replace',
        args: { file_path: target },
      }),
    ).toThrow();
    writeFileSync(target, '[]');
    expect(guard.checks('').some((c) => c.status === 'failed')).toBe(true);
  });
  it('sanitizes visible paths but preserves friendly clickable link targets', () => {
    const { guard } = harness('不要把绝对路径展示给用户。');
    const safe = guard.sanitize(
      '交付 `C:\\Users\\test\\a.pptx` 和 /tmp/a.pdf。 [查看 PPT](<C:/Users/test/a.pptx>)',
    );
    expect(safe).not.toContain('`C:');
    expect(safe).not.toContain('/tmp/a.pdf');
    expect(safe).toContain('[查看 PPT](<C:/Users/test/a.pptx>)');
    expect(guard.checks(safe).every((c) => c.status === 'passed')).toBe(true);
  });
  it('does not strip unrelated web links or interpret quoted instructions as user constraints', () => {
    const { guard } = harness(
      '解释如下引用：\n> 不要打开 WPS\n```text\n禁止部署\n```',
    );
    expect(guard.active).toBe(false);
    expect(guard.sanitize('https://example.org/a/b')).toBe(
      'https://example.org/a/b',
    );
  });
  it('requires an authentic native one-time review, bound to content version', () => {
    const { guard } = harness('回答后由我人工确认。');
    const review = guard.prepareReview('draft A');
    expect(review).toBeTruthy();
    expect(guard.confirmReview('forged', 'draft A', true)).toBe(false);
    expect(guard.confirmReview(review!.id, 'draft B', true)).toBe(false);
    const current = guard.prepareReview('draft B')!;
    expect(guard.confirmReview(current.id, 'draft B', true)).toBe(true);
    expect(guard.checks('draft B').every((c) => c.status === 'passed')).toBe(
      true,
    );
    expect(guard.checks('draft C').some((c) => c.status === 'not_run')).toBe(
      true,
    );
  });
  it('invalidates manual review if a local delivered file changes while awaiting review', () => {
    const { guard, root } = harness('回答后由我人工确认。');
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'first');
    const draft = `[文件](<${file}>)`;
    const pending = guard.prepareReview(draft)!;
    writeFileSync(file, 'other');
    expect(guard.confirmReview(pending.id, draft, true)).toBe(false);
  });
  it('keeps ordinary questions on a zero-constraint path', () => {
    const { guard } = harness('你好');
    expect(guard.active).toBe(false);
    expect(guard.checks('你好')).toEqual([]);
  });
  it.each(['不把绝对路径展示给用户', '不裸露路径'])('enforces output shorthand: %s', request => {
    const { guard } = harness(request);
    expect(guard.protectsOutput).toBe(true);
    expect(guard.sanitize('文件 C:/private/a.txt')).not.toContain('C:/private');
  });
  it('rejects a same-name non-native implementation', () => {
    const { guard } = harness('不要打开 WPS。');
    expect(() =>
      guard.review({
        callId: 'fake',
        name: 'read_file',
        args: {},
        nativeSafe: false,
      }),
    ).toThrow(/原生实现/);
  });
  it('does not turn a narrower directory restriction into workspace-wide permission', () => {
    const { guard, root } = harness('只允许修改当前工作区的 `src` 目录。');
    expect(() =>
      guard.review({
        callId: 'wrong',
        name: 'write_file',
        args: { file_path: path.join(root, 'config.json') },
      }),
    ).toThrow();
    expect(() =>
      guard.review({
        callId: 'right',
        name: 'write_file',
        args: { file_path: path.join(root, 'src/a.ts') },
      }),
    ).not.toThrow();
  });
  it('rejects hardlink aliases before writes', () => {
    const { guard, root } = harness('只允许修改当前工作区。');
    const other = mkdtempSync(path.join(tmpdir(), 'otto-hardlink-'));
    dirs.push(other);
    writeFileSync(path.join(other, 'a'), 'safe');
    linkSync(path.join(other, 'a'), path.join(root, 'alias'));
    expect(() =>
      guard.start({
        callId: 'w',
        name: 'write_file',
        args: { file_path: path.join(root, 'alias') },
      }),
    ).toThrow();
  });
  it('does not preserve visible link syntax inside inline or fenced code', () => {
    const { guard } = harness('不要展示绝对路径。');
    const text =
      '`[文件](C:/private/secret.txt)`\n```text\n[文件](C:/private/secret.txt)\n```';
    expect(guard.sanitize(text)).not.toContain('C:/private/secret.txt');
  });
  it('does not relax an advance-approval precondition into final-answer approval', () => {
    const { guard, root } = harness('必须先由我人工确认后再修改文件。');
    expect(() =>
      guard.review({
        callId: 'w',
        name: 'write_file',
        args: { file_path: path.join(root, 'a') },
      }),
    ).toThrow();
  });
  it('retains web URLs while redacting actual paths', () => {
    const { guard } = harness('不要展示绝对路径。');
    expect(
      guard.sanitize('来源 https://example.org/docs/a 和 `C:/local/a.txt`'),
    ).toContain('https://example.org/docs/a');
    expect(guard.sanitize('[官网](https://example.org/docs)')).toBe(
      '[官网](https://example.org/docs)',
    );
  });
  it('uses the real workspace for a short no-out-of-bounds instruction', () => {
    const { guard } = harness('不要越界写入。');
    expect(() =>
      guard.review({
        callId: 'w',
        name: 'write_file',
        args: { file_path: '../outside' },
      }),
    ).toThrow();
  });
});
