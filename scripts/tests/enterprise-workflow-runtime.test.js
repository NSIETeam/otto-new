/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { copyEnterpriseWorkflowRuntime } from '../enterprise-workflow-runtime.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
function fixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'otto-workflow-package-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
describe('explicit enterprise workflow runtime', () => {
  it.each(['1.0.0', '2.3.4'])(
    'declares the copied workflow version %s in the generated production package',
    (workflowVersion) =>
      fixture((root) => {
        const dist = path.join(root, 'packages/workflow/dist');
        mkdirSync(dist, { recursive: true });
        writeFileSync(
          path.join(root, 'packages/workflow/package.json'),
          JSON.stringify({
            name: 'otto-workflow',
            version: workflowVersion,
            type: 'module',
          }),
        );
        writeFileSync(path.join(dist, 'index.js'), 'export {};');
        const releaseRoot = path.join(root, 'release');
        const workflowRuntime = copyEnterpriseWorkflowRuntime({
          repoRoot: root,
          releaseRoot,
        });
        const build = readFileSync(
          path.join(repoRoot, 'scripts/build-enterprise-oneclick.mjs'),
          'utf8',
        ).replaceAll('\r\n', '\n');
        const start = build.indexOf(
          "writeFileSync(\n    path.join(releaseRoot, 'package.json'),",
        );
        expect(start).toBeGreaterThan(0);
        const end = build.indexOf('\n  );', start);
        expect(end).toBeGreaterThan(start);
        // Execute the real generated-package statement with only local fixture
        // values. No signing, native downloads or full builder side effects.
        runInNewContext(build.slice(start, end + '\n  );'.length), {
          path,
          writeFileSync,
          releaseRoot,
          version: '1.9.15',
          workflowRuntime,
          runtimeDependencies: { directVersions: { pg: '8.22.0' } },
        });
        const generated = JSON.parse(
          readFileSync(path.join(releaseRoot, 'package.json'), 'utf8'),
        );
        const vendored = JSON.parse(
          readFileSync(
            path.join(releaseRoot, 'node_modules/otto-workflow/package.json'),
            'utf8',
          ),
        );
        expect(generated.dependencies).toMatchObject({
          pg: '8.22.0',
          'otto-workflow': vendored.version,
          'better-sqlite3': '12.11.1',
          'otto-core': '1.1.0-enterprise-adapter',
        });
      }),
  );

  it('loads the actual copied workflow without repository module resolution', () =>
    fixture((releaseRoot) => {
      copyEnterpriseWorkflowRuntime({ repoRoot, releaseRoot });
      const moduleUrl = pathToFileURL(
        path.join(releaseRoot, 'node_modules/otto-workflow/dist/index.js'),
      ).href;
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      const runtime = await import(${JSON.stringify(moduleUrl)});
      for (const name of ['FileWorkflowStore','FileWorkflowTraceSink','WorkflowRuntime','ResidentWorkflowSupervisor']) {
        if (typeof runtime[name] !== 'function') throw new Error('missing runtime constructor: ' + name);
      }
    `,
        ],
        {
          cwd: releaseRoot,
          encoding: 'utf8',
          timeout: 10_000,
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
        },
      );
      expect(result.status, result.stderr).toBe(0);
    }));
  it('fails on missing build output and does not fall back to source code', () =>
    fixture((root) => {
      mkdirSync(path.join(root, 'packages/workflow'), { recursive: true });
      writeFileSync(
        path.join(root, 'packages/workflow/package.json'),
        '{"name":"otto-workflow","version":"1.0.0","type":"module"}',
      );
      expect(() =>
        copyEnterpriseWorkflowRuntime({
          repoRoot: root,
          releaseRoot: path.join(root, 'release'),
        }),
      ).toThrow();
    }));
  it('binds workflow sources and the copier into package source provenance', () => {
    const build = readFileSync(
      path.join(repoRoot, 'scripts/build-enterprise-oneclick.mjs'),
      'utf8',
    );
    for (const input of [
      'packages/workflow/package.json',
      'packages/workflow/tsconfig.build.json',
      'scripts/enterprise-workflow-runtime.mjs',
    ]) {
      expect(build.split(`'${input}'`).length - 1).toBe(2);
    }
    expect(build).toContain("['otto-workflow', 'otto-core', 'otto-server']");
    expect(
      build.indexOf('copyEnterpriseWorkflowRuntime({ repoRoot, releaseRoot })'),
    ).toBeLessThan(
      build.indexOf('const releaseFiles = filesBelow(releaseRoot);'),
    );
  });
  it('excludes tests, source maps and declarations from the shipped runtime', () =>
    fixture((root) => {
      const dist = path.join(root, 'packages/workflow/dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(
        path.join(root, 'packages/workflow/package.json'),
        '{"name":"otto-workflow","version":"1.0.0","type":"module"}',
      );
      for (const name of [
        'index.js',
        'index.js.map',
        'runtime.test.js',
        'runtime.spec.js',
        'index.d.ts',
      ])
        writeFileSync(path.join(dist, name), 'export {};');
      const releaseRoot = path.join(root, 'release');
      copyEnterpriseWorkflowRuntime({ repoRoot: root, releaseRoot });
      expect(
        existsSync(
          path.join(releaseRoot, 'node_modules/otto-workflow/dist/index.js'),
        ),
      ).toBe(true);
      for (const name of [
        'index.js.map',
        'runtime.test.js',
        'runtime.spec.js',
        'index.d.ts',
      ])
        expect(
          existsSync(
            path.join(releaseRoot, 'node_modules/otto-workflow/dist', name),
          ),
        ).toBe(false);
    }));
  it('rejects newly introduced runtime dependencies instead of silently dropping them', () =>
    fixture((root) => {
      mkdirSync(path.join(root, 'packages/workflow'), { recursive: true });
      writeFileSync(
        path.join(root, 'packages/workflow/package.json'),
        '{"name":"otto-workflow","version":"1.0.0","type":"module","dependencies":{"new-module":"1.0.0"}}',
      );
      expect(() =>
        copyEnterpriseWorkflowRuntime({
          repoRoot: root,
          releaseRoot: path.join(root, 'release'),
        }),
      ).toThrow('workflow dependencies changed');
    }));
  it('rejects a linked build root before copying files', () =>
    fixture((root) => {
      mkdirSync(path.join(root, 'packages/workflow'), { recursive: true });
      mkdirSync(path.join(root, 'outside'));
      writeFileSync(
        path.join(root, 'packages/workflow/package.json'),
        '{"name":"otto-workflow","version":"1.0.0","type":"module"}',
      );
      symlinkSync(
        path.join(root, 'outside'),
        path.join(root, 'packages/workflow/dist'),
        'junction',
      );
      expect(() =>
        copyEnterpriseWorkflowRuntime({
          repoRoot: root,
          releaseRoot: path.join(root, 'release'),
        }),
      ).toThrow('unsafe workflow build directory');
    }));
});
