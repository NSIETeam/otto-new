/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { runDesktopCoverage } from '../run-desktop-coverage.mjs';
import {
  sourceInventory,
  summarizeDesktopCoverage,
} from '../verify-desktop-coverage-ratchet.mjs';

const temporary = [];
// Match the native child's canonical cwd on macOS (/var -> /private/var).
const temporaryRoot = realpathSync(os.tmpdir());
const hash = (value) => createHash('sha256').update(value).digest('hex');
const runnerFile = fileURLToPath(
  new URL('../run-desktop-coverage.mjs', import.meta.url),
);

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    if (
      path.dirname(dir) !== temporaryRoot ||
      !path.basename(dir).startsWith('otto-coverage-runner-fixture-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(mode = 'pass') {
  const root = mkdtempSync(
    path.join(temporaryRoot, 'otto-coverage-runner-fixture-'),
  );
  temporary.push(root);
  const desktop = path.join(root, 'packages/desktop');
  for (const dir of [
    'packages/desktop/src/main',
    'packages/desktop/src/renderer',
    'packages/desktop/scripts',
    'node_modules/vitest',
    'node_modules/@vitest/coverage-v8',
    'config/test-baselines/desktop',
  ])
    mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, 'package-lock.json'), '{"fixture":true}\n');
  writeFileSync(path.join(desktop, 'vitest.config.ts'), 'export default {};\n');
  writeFileSync(
    path.join(desktop, 'src/main/value.ts'),
    'export const value = 1;\n',
  );
  writeFileSync(
    path.join(desktop, 'src/main/value.test.ts'),
    'test("value", () => {});\n',
  );
  writeFileSync(
    path.join(desktop, 'src/renderer/test-setup.ts'),
    '// fixture setup\n',
  );
  for (const dep of ['vitest', '@vitest/coverage-v8'])
    writeFileSync(
      path.join(root, `node_modules/${dep}/package.json`),
      '{"version":"4.1.11"}',
    );
  // A native Node fixture with Vitest-shaped output tests the runner facility.
  // This is not a product test, real Vitest run or publishable baseline.
  writeFileSync(
    path.join(root, 'node_modules/vitest/vitest.mjs'),
    String.raw`
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2); const mode=${JSON.stringify(mode)};
const output=args.find(a=>a.startsWith('--outputFile.json=')).split('=').slice(1).join('=');
const coverage=args.find(a=>a.startsWith('--coverage.reportsDirectory=')).split('=').slice(1).join('=');
fs.writeFileSync(path.join(path.dirname(output),'fixture-execution.json'),JSON.stringify({args,cwd:process.cwd(),secret:process.env.OTTO_TEST_SECRET??null,home:process.env.HOME,userDir:process.env.OTTO_USER_DIR}));
if(mode==='fail')process.exit(9);
if(mode!=='missing'){
  fs.mkdirSync(coverage,{recursive:true});
  const file=path.join(process.cwd(),'src/main/value.ts'); const loc={start:{line:1,column:0},end:{line:1,column:22}};
  fs.writeFileSync(path.join(coverage,'coverage-final.json'),JSON.stringify({[file]:{path:file,statementMap:{0:loc},s:{0:1},fnMap:{},f:{},branchMap:{},b:{}}}));
  fs.writeFileSync(output,JSON.stringify({numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:[{name:path.join(process.cwd(),'src/main/value.test.ts'),status:'passed',assertionResults:[{title:'value',status:'passed'}]}]}));
}
if(mode==='change')fs.appendFileSync(path.join(process.cwd(),'src/main/value.ts'),'// changed during test\n');
if(mode==='change-test')fs.appendFileSync(path.join(process.cwd(),'src/main/value.test.ts'),'// changed during test\n');
if(mode==='change-config')fs.appendFileSync(path.join(process.cwd(),'vitest.config.ts'),'// changed during test\n');
if(mode==='change-setup')fs.appendFileSync(path.join(process.cwd(),'src/renderer/test-setup.ts'),'// changed during test\n');
if(mode==='change-tool')fs.appendFileSync(process.argv[1],'// changed during test\n');
`,
  );
  return { root, desktop };
}

// A synthetic baseline confined to this temporary runner fixture. It is never
// copied to the repository or claimed as real Desktop coverage evidence.
function fixtureBaseline(input, result) {
  const { sources, tests } = sourceInventory(input.desktop);
  const coverage = JSON.parse(
    readFileSync(path.join(result.directory, 'coverage/coverage-final.json')),
  );
  const baseline = {
    schemaVersion: 1,
    scope: 'desktop-source-v1',
    status: 'reviewed-measurement-baseline',
    environment: result.receipt.environment,
    review: {
      reference: 'https://github.com/NSIETeam/otto-new/pull/1',
      sourceCommit: 'a'.repeat(40),
      coverageSha256: result.receipt.reportHashes.coverage,
      testEvidence: {
        kind: 'vitest-json',
        sha256: result.receipt.reportHashes.tests,
      },
      measuredConfigSha256: result.receipt.environment.configSha256,
      sourceManifestSha256: hash(
        JSON.stringify(
          Object.entries(result.receipt.sourceHashesBefore).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      ),
    },
    tests: Object.keys(tests),
    files: summarizeDesktopCoverage({ root: input.desktop, sources, coverage }),
  };
  writeFileSync(
    path.join(
      input.root,
      'config/test-baselines/desktop',
      `${process.platform}-${process.arch}-node22-vitest4.json.gz`,
    ),
    gzipSync(JSON.stringify(baseline)),
  );
}

describe('native desktop coverage runner infrastructure', () => {
  it('passes only after the native result and read-only ratchet both pass, preserving previous runs', async () => {
    const input = fixture();
    const original = await runDesktopCoverage({ projectRoot: input.root });
    expect(original.code).toBe(1);
    const originalReceipt = readFileSync(
      path.join(original.directory, 'receipt.json'),
    );
    fixtureBaseline(input, original);
    const result = await runDesktopCoverage({ projectRoot: input.root });
    expect(result.code).toBe(0);
    expect(result.receipt.gate.status).toBe('passed');
    expect(result.receipt.gate.result.files).toBe(1);
    expect(result.directory).not.toBe(original.directory);
    expect(readFileSync(path.join(original.directory, 'receipt.json'))).toEqual(
      originalReceipt,
    );
    expect(
      JSON.parse(
        readFileSync(
          path.join(input.desktop, 'coverage/desktop-coverage-latest.json'),
        ),
      ).runId,
    ).toBe(result.receipt.runId);
  });
  it('runs the exact native command in isolation and fails closed without a platform baseline', async () => {
    const input = fixture();
    expect(realpathSync(input.desktop)).toBe(input.desktop);
    const oldSecret = process.env.OTTO_TEST_SECRET;
    process.env.OTTO_TEST_SECRET = 'do-not-propagate-to-child';
    let result;
    try {
      result = await runDesktopCoverage({ projectRoot: input.root });
    } finally {
      if (oldSecret === undefined) delete process.env.OTTO_TEST_SECRET;
      else process.env.OTTO_TEST_SECRET = oldSecret;
    }
    expect(result.code).toBe(1);
    expect(result.receipt.exitCode).toBe(0);
    expect(result.receipt.gate.status).toBe('failed');
    expect(result.receipt.gate.reason).toContain('baseline');
    const execution = JSON.parse(
      readFileSync(
        path.join(result.directory, 'fixture-execution.json'),
        'utf8',
      ),
    );
    expect(execution.secret).toBeNull();
    expect(execution.cwd).toBe(input.desktop);
    expect(execution.home.startsWith(result.directory)).toBe(true);
    expect(execution.userDir.startsWith(result.directory)).toBe(true);
    expect(execution.args.slice(0, 5)).toEqual([
      'run',
      '--coverage',
      '--maxWorkers=2',
      '--reporter=default',
      '--reporter=json',
    ]);
    expect(result.receipt.reportHashes.coverage).toBe(
      hash(
        readFileSync(
          path.join(result.directory, 'coverage/coverage-final.json'),
        ),
      ),
    );
    expect(result.receipt.sourceHashesAfter).toEqual(
      result.receipt.sourceHashesBefore,
    );
    expect(
      JSON.parse(
        readFileSync(
          path.join(input.desktop, 'coverage/desktop-coverage-latest.json'),
          'utf8',
        ),
      ).runId,
    ).toBe(result.receipt.runId);
  });

  it('preserves a nonzero native exit without inventing a successful receipt', async () => {
    const { root } = fixture('fail');
    const result = await runDesktopCoverage({ projectRoot: root });
    expect(result.code).toBe(1);
    expect(result.receipt.exitCode).toBe(9);
    expect(result.receipt.gate.status).toBe('not-run');
    expect(existsSync(path.join(result.directory, 'receipt.json'))).toBe(true);
  });

  it('does not use stale report files when this execution produces no reports', async () => {
    const { root, desktop } = fixture('missing');
    mkdirSync(path.join(desktop, 'coverage'), { recursive: true });
    writeFileSync(
      path.join(desktop, 'coverage/coverage-final.json'),
      '{"stale":true}',
    );
    const result = await runDesktopCoverage({ projectRoot: root });
    expect(result.code).toBe(1);
    expect(result.receipt.reportHashes.coverage).toBeNull();
    expect(result.receipt.gate.reason).toContain('report');
    expect(
      readFileSync(path.join(desktop, 'coverage/coverage-final.json'), 'utf8'),
    ).toBe('{"stale":true}');
  });

  it('detects source changed during the native child run', async () => {
    const { root } = fixture('change');
    const result = await runDesktopCoverage({ projectRoot: root });
    expect(result.code).toBe(1);
    expect(result.receipt.sourceHashesAfter).not.toEqual(
      result.receipt.sourceHashesBefore,
    );
    expect(result.receipt.gate.reason).toContain('changed');
  });

  it.each(['change-test', 'change-config', 'change-setup', 'change-tool'])(
    'rejects execution inputs changed during native run: %s',
    async (mode) => {
      const { root } = fixture(mode);
      const result = await runDesktopCoverage({ projectRoot: root });
      expect(result.code).toBe(1);
      expect(result.receipt.exitCode).toBe(0);
      expect(result.receipt.gate.reason).toContain('changed');
    },
  );

  it('rejects an unknown platform before launching a test', async () => {
    const { root } = fixture();
    await expect(
      runDesktopCoverage({ projectRoot: root, platform: 'unknown' }),
    ).rejects.toThrow(/platform/);
  });

  it('never overwrites a foreign latest index', async () => {
    const { root, desktop } = fixture();
    mkdirSync(path.join(desktop, 'coverage'), { recursive: true });
    const latest = path.join(desktop, 'coverage/desktop-coverage-latest.json');
    writeFileSync(latest, 'user owned content');
    await expect(runDesktopCoverage({ projectRoot: root })).rejects.toThrow(
      /latest/,
    );
    expect(readFileSync(latest, 'utf8')).toBe('user owned content');
  });

  it('rejects a redirected coverage directory without writing through it', async () => {
    const { root, desktop } = fixture();
    const redirected = path.join(root, 'redirected');
    mkdirSync(redirected);
    writeFileSync(path.join(redirected, 'sentinel'), 'user-owned');
    symlinkSync(
      redirected,
      path.join(desktop, 'coverage'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(runDesktopCoverage({ projectRoot: root })).rejects.toThrow(
      /directory/,
    );
    expect(existsSync(path.join(redirected, 'desktop-runs'))).toBe(false);
    expect(readFileSync(path.join(redirected, 'sentinel'), 'utf8')).toBe(
      'user-owned',
    );
  });

  it.each(['--skip-ratchet', '--baseline', '--update-baseline', '--root'])(
    'rejects injected CLI option %s',
    (option) => {
      const result = spawnSync(
        process.execPath,
        [runnerFile, option, 'ignored'],
        { encoding: 'utf8', shell: false, windowsHide: true },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('does not accept arguments');
    },
  );
});
