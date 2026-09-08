import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  freezeBaseline,
  verifyBaseline,
  sourceInventory,
  resolveEvaluationProtocol,
  assertComparableProtocols,
  assertComparableBaselines,
  hashEntries,
} from '../agent-eval-baseline.mjs';

const temporary = [];
function fixture() {
  const parent = mkdtempSync(path.join(tmpdir(), 'otto-baseline-unit-'));
  temporary.push(parent);
  const root = path.join(parent, 'repo');
  mkdirSync(root);
  const put = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  put('package.json', '{"name":"fixture","workspaces":[]}');
  put('package-lock.json', '{"lockfileVersion":3,"packages":{}}');
  put('.gitignore', 'node_modules/\n.env\ndist/\n');
  put('packages/server/src/runtime.ts', 'export const value = 1;');
  execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  execFileSync('git', ['add', '.'], { cwd: root, windowsHide: true });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: root, windowsHide: true },
  );
  return { root, parent, put, destination: path.join(parent, 'frozen') };
}
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('immutable source baseline, no API calls', () => {
  it('captures current dirty and untracked source, not HEAD content', () => {
    const f = fixture();
    f.put('packages/server/src/runtime.ts', 'export const value = 2;');
    f.put(
      'packages/server/src/newRequirement.ts',
      'export const fresh = true;',
    );
    const m = freezeBaseline(f.root, f.destination);
    expect(
      m.source.files.find((x) => x.path.endsWith('runtime.ts')).state,
    ).toBe('modified');
    expect(
      m.source.files.find((x) => x.path.endsWith('newRequirement.ts')).state,
    ).toBe('untracked');
    expect(
      readFileSync(
        path.join(f.destination, 'source/packages/server/src/runtime.ts'),
        'utf8',
      ),
    ).toContain('2');
    expect(verifyBaseline(f.destination).valid).toBe(true);
  });
  it('records deleted tracked files without resurrecting them', () => {
    const f = fixture();
    rmSync(path.join(f.root, 'packages/server/src/runtime.ts'));
    const m = freezeBaseline(f.root, f.destination);
    expect(m.source.deleted).toContain('packages/server/src/runtime.ts');
    expect(m.source.files.some((x) => x.path.endsWith('runtime.ts'))).toBe(
      false,
    );
  });
  it('excludes ignored credentials, generated payload and private key filenames', () => {
    const f = fixture();
    f.put('.env', 'SECRET=do-not-copy');
    f.put('node_modules/foo/index.js', 'generated');
    f.put('packages/server/dist/index.js', 'old-runtime');
    f.put('packages/server/production.pem', 'do-not-copy');
    f.put('vite-cache/vitest/results.json', '{"run":1}');
    f.put('packages/server/.vite/results.json', '{"run":1}');
    const m = freezeBaseline(f.root, f.destination);
    expect(
      m.source.files.every(
        (x) => !/\.env|node_modules|\/dist\/|\.pem|vite-cache|\.vite\//.test(x.path),
      ),
    ).toBe(true);
    expect(m.source.excluded.some((x) => x.path.endsWith('.pem'))).toBe(true);
  });
  it('rejects probable embedded credentials before writing a snapshot', () => {
    const f = fixture();
    f.put(
      'packages/server/src/leak.ts',
      `const key = '${'ghp_' + 'a'.repeat(36)}';`,
    );
    expect(() => freezeBaseline(f.root, f.destination)).toThrow(/credential/i);
  });
  it('never follows source directory links outside the worktree', () => {
    const f = fixture();
    const external = path.join(f.parent, 'external');
    mkdirSync(external);
    writeFileSync(path.join(external, 'leak.ts'), 'private');
    symlinkSync(external, path.join(f.root, 'packages/linked'), 'junction');
    expect(() => sourceInventory(f.root)).toThrow(/link/i);
  });
  it('rejects snapshot targets inside the source and never overwrites a prior baseline', () => {
    const f = fixture();
    expect(() => freezeBaseline(f.root, path.join(f.root, 'snapshot'))).toThrow(
      /outside/i,
    );
    freezeBaseline(f.root, f.destination);
    expect(() => freezeBaseline(f.root, f.destination)).toThrow(/exist/i);
  });
  it('detects same-size tampering, missing files and added executable source', () => {
    const f = fixture();
    freezeBaseline(f.root, f.destination);
    const file = path.join(
      f.destination,
      'source/packages/server/src/runtime.ts',
    );
    writeFileSync(file, 'export const value = 9;');
    expect(verifyBaseline(f.destination).valid).toBe(false);
    rmSync(file);
    writeFileSync(path.join(f.destination, 'source/injected.cjs'), 'malicious');
    const check = verifyBaseline(f.destination);
    expect(check.missing).toContain('packages/server/src/runtime.ts');
    expect(check.unexpected).toContain('injected.cjs');
  });
  it('is insensitive to traversal order but sensitive to path and contents', () => {
    const a = [
      { path: 'a', sha256: '1', bytes: 1 },
      { path: 'b', sha256: '2', bytes: 1 },
    ];
    expect(hashEntries(a)).toBe(hashEntries([...a].reverse()));
    expect(hashEntries(a)).not.toBe(
      hashEntries([{ ...a[0], path: 'c' }, a[1]]),
    );
  });
  it('refuses unsafe paths in a tampered manifest', () => {
    const f = fixture();
    freezeBaseline(f.root, f.destination);
    const p = path.join(f.destination, 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    m.source.files[0].path = '../outside';
    writeFileSync(p, JSON.stringify(m));
    expect(() => verifyBaseline(f.destination)).toThrow(/path|integrity/i);
  });
});

describe('fixed evaluation conditions are explicit and credential-free', () => {
  const rules = {
    schemaVersion: 1,
    dataset: 'stage0-v1',
    cases: [{ id: 'one' }],
  };
  const env = {
    OTTO_EVAL_MODEL: 'fixed-20260901',
    OTTO_EVAL_MODEL_REVISION: 'provider-revision-1',
    OTTO_EVAL_BASE_URL: 'https://models.example.invalid/v1',
    OTTO_EVAL_MAX_COST_USD: '2',
    OTTO_EVAL_API_KEY: 'never-serialize-me',
    OTTO_EVAL_INPUT_PER_MILLION: '1',
    OTTO_EVAL_OUTPUT_PER_MILLION: '2',
  };
  it('keeps missing model and budget pending, never invents a free run', () => {
    const p = resolveEvaluationProtocol({}, rules);
    expect(p.live.ready).toBe(false);
    expect(p.live.model).toBeNull();
    expect(p.live.maxCostUsd).toBeNull();
    expect(p.live.callsMade).toBe(0);
    expect(p.live.pending).toContain('model');
  });
  it('pins model revision, endpoint identity, prices and budgets, but not credentials', () => {
    const p = resolveEvaluationProtocol(env, rules);
    expect(p.live.ready).toBe(true);
    expect(JSON.stringify(p)).not.toContain(env.OTTO_EVAL_API_KEY);
    expect(JSON.stringify(p)).not.toContain(env.OTTO_EVAL_BASE_URL);
    expect(p.live.estimatedCost).toBeNull();
  });
  it.each(['-1', 'NaN', 'Infinity', '0'])(
    'rejects invalid paid-run budget %s',
    (budget) => {
      expect(() =>
        resolveEvaluationProtocol(
          { ...env, OTTO_EVAL_MAX_COST_USD: budget },
          rules,
        ),
      ).toThrow(/budget/i);
    },
  );
  it.each([
    'https://a:b@example.invalid',
    'https://example.invalid/?token=hidden',
    'http://example.invalid',
  ])('rejects credential-bearing or insecure endpoints', (url) => {
    expect(() =>
      resolveEvaluationProtocol({ ...env, OTTO_EVAL_BASE_URL: url }, rules),
    ).toThrow(/endpoint/i);
  });
  it('refuses pending, changed rules, changed model or changed price comparisons', () => {
    const fixed = resolveEvaluationProtocol(env, rules);
    expect(() => assertComparableProtocols(fixed, fixed)).not.toThrow();
    expect(() =>
      assertComparableProtocols(fixed, resolveEvaluationProtocol({}, rules)),
    ).toThrow(/pending/i);
    for (const changed of [
      resolveEvaluationProtocol({ ...env, OTTO_EVAL_MODEL: 'other' }, rules),
      resolveEvaluationProtocol(
        { ...env, OTTO_EVAL_INPUT_PER_MILLION: '2' },
        rules,
      ),
      resolveEvaluationProtocol(env, { ...rules, cases: [] }),
    ])
      expect(() => assertComparableProtocols(fixed, changed)).toThrow(
        /comparable/i,
      );
  });
  it('allows runtime variants but rejects changed grader, tools or environment', () => {
    const before = {
      protocol: resolveEvaluationProtocol(env, rules),
      identities: {
        runtimeFingerprint: 'old',
        harnessFingerprint: 'fixed-grader-and-fixture-tools',
      },
      environment: {
        nodeExecutableSha256: 'same-node',
        installed: ['same-deps'],
      },
    };
    const after = structuredClone(before);
    after.identities.runtimeFingerprint = 'new';
    expect(() => assertComparableBaselines(before, after)).not.toThrow();
    after.identities.harnessFingerprint = 'looser';
    expect(() => assertComparableBaselines(before, after)).toThrow(/Grader/);
    after.identities.harnessFingerprint = before.identities.harnessFingerprint;
    after.environment.installed = ['other-deps'];
    expect(() => assertComparableBaselines(before, after)).toThrow(
      /Environment/,
    );
  });
});
