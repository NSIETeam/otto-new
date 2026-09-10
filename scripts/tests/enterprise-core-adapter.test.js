/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';

const builder = fs.readFileSync('scripts/build-enterprise-oneclick.mjs', 'utf8');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each([true, false])('ships the actual workspace identity and fails closed if missing (present=%s)', (present) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-core-adapter-'));
  roots.push(root);
  const repoRoot = path.join(root, 'repo');
  const releaseRoot = path.join(root, 'release');
  const dist = path.join(repoRoot, 'packages/core/dist/src');
  fs.mkdirSync(path.join(dist, 'customer-modules'), { recursive: true });
  fs.mkdirSync(path.join(releaseRoot, 'node_modules/otto-core/dist/src/services'), { recursive: true });
  for (const relative of ['services/aliyunSmsSender.js', 'services/recurringTaskRegistry.js', 'memory/globalMemoryMaintenance.js', 'customer-modules/index.js']) {
    const file = path.join(dist, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export {};\n');
  }
  // Only unrelated adapter exports are stubs. The path identity implementation
  // and the server's re-export are real TypeScript compiled to native ESM.
  const implementation = ts.transpileModule(fs.readFileSync('packages/core/src/utils/workspacePathIdentity.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  fs.mkdirSync(path.join(dist, 'utils'));
  if (present) fs.writeFileSync(path.join(dist, 'utils/workspacePathIdentity.js'), implementation);
  fs.writeFileSync(path.join(dist, 'services/recurringTaskRegistry.js'), ts.transpileModule(
    fs.readFileSync('packages/core/src/services/recurringTaskRegistry.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText);
  const walk = builder.slice(builder.indexOf('function filesBelow('), builder.indexOf('\nconst enterpriseBuildWorkspaces'));
  const copy = builder.slice(builder.indexOf('  const coreDist ='), builder.indexOf('  const betterSqliteSource ='));
  expect(copy).toContain('cpSync(source, target)');
  const pack = () => runInNewContext(`${walk}\n${copy}`, { ...fs, path, repoRoot, releaseRoot }, { timeout: 5000 });
  if (!present) {
    expect(pack).toThrow(/missing built enterprise core runtime:.*workspacePathIdentity\.js/);
    return;
  }
  pack();
  const shipped = path.join(releaseRoot, 'node_modules/otto-core/dist/src/utils/workspacePathIdentity.js');
  expect(fs.existsSync(shipped)).toBe(true);
  expect(fs.readFileSync(shipped, 'utf8')).toBe(implementation);
  fs.writeFileSync(path.join(releaseRoot, 'package.json'), '{"type":"module"}');
  const serverExport = ts.transpileModule(fs.readFileSync('packages/server/src/workspacePathIdentity.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  fs.writeFileSync(path.join(releaseRoot, 'workspacePathIdentity.js'), serverExport);
  fs.writeFileSync(path.join(releaseRoot, 'probe.mjs'), `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { WorkspacePathIdentity } from './workspacePathIdentity.js';
    import { RecurringTaskRegistry } from 'otto-core';
    import { RecurringTaskRegistry as SubpathRegistry } from 'otto-core/recurring-tasks';
    assert.equal(RecurringTaskRegistry, SubpathRegistry);
    const workspace = path.resolve('workspace');
    fs.mkdirSync(workspace);
    const identity = new WorkspacePathIdentity(workspace);
    assert.equal(identity.currentPath(), fs.realpathSync(workspace));
    assert.equal(identity.resolveTarget('result.txt'), path.join(fs.realpathSync(workspace), 'result.txt'));
    fs.renameSync(workspace, workspace + '-old');
    fs.mkdirSync(workspace);
    assert.equal(identity.currentPath(), undefined);
    assert.throws(() => identity.resolveTarget('result.txt'), /Workspace identity changed/);
  `);
  const result = spawnSync(process.execPath, [path.join(releaseRoot, 'probe.mjs')], {
    cwd: releaseRoot, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it.each(['sourceScope', 'sourceInputFiles'])('includes workspace identity in %s', (name) => {
  const start = builder.indexOf(`const ${name} = [`);
  const end = builder.indexOf('\n]', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(builder.slice(start, end)).toContain("'packages/core/src/utils/workspacePathIdentity.ts'");
});
