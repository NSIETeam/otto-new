/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.dirname(fileURLToPath(import.meta.url));
const publicBrowserEntries = {
  'otto-core/recurring-tasks': {
    entry: '../../../core/src/recurringTasks.ts',
    modules: ['recurringTaskRegistry.ts', 'recurringTasks.ts'],
  },
  'otto-server/recruitment': {
    entry: '../../../server/src/modules/recruitment_intelligence/recruitmentPublic.ts',
    modules: ['recruitmentAssessment.ts', 'recruitmentPublic.ts', 'recruitmentSemantic.ts', 'recruitmentSemanticModel.ts'],
  },
};

function runtimeViolations(source: string): string[] {
  const imports = source.match(/^[ \t]*import[\s\S]*?;[ \t]*$/gm) ?? [];
  const staticViolations = imports.filter((statement) => {
    const module = statement.match(/(?:from\s+)?['"](otto-(?:server|core)(?:\/[^'"]*)?)['"]/)?.[1];
    return module && !Object.hasOwn(publicBrowserEntries, module) && !statement.trimStart().startsWith('import type ');
  });
  // Public exports are explicit static dependencies, not permission to hide
  // arbitrary package loading behind require() or dynamic import().
  const callViolations = [...source.matchAll(
    /\b(?:require|import)\(\s*['"]otto-(?:server|core)(?:\/[^'"]*)?['"]\s*\)/g,
  )].map((match) => match[0]);
  return [...staticViolations, ...callViolations].map((statement) => statement.replace(/\s+/g, ' ').trim());
}

function rendererSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return rendererSources(target);
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (entry.name.includes('.test.')) return [];
    return [target];
  });
}

describe('renderer runtime import boundary', () => {
  it('rejects package barrels and internals, permitting only verified browser-safe public static exports', () => {
    const violations = rendererSources(rendererRoot).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return runtimeViolations(source).map((statement) => ({
        file: path.relative(rendererRoot, file),
        statement,
      }));
    });

    expect(violations).toEqual([]);
  });
  it.each([
    "import { run } from 'otto-core';",
    "import { run } from 'otto-server';",
    "import { run } from 'otto-core/dist/src/core/client.js';",
    "import { run } from 'otto-core/recurring-tasks/internal';",
    // Build negative input at runtime so the repository's text scanner does
    // not mistake this deliberately forbidden fixture for a real import.
    ['import', "{ run } from 'otto-server/recruitment/internal';"].join(' '),
    "const runtime = require('otto-core/recurring-tasks');",
    "const runtime = import('otto-server/recruitment');",
  ])('still rejects unsafe or hidden runtime import: %s', (source) => {
    expect(runtimeViolations(source)).toHaveLength(1);
  });
  it('still permits erased type imports', () => {
    expect(runtimeViolations("import type { SettingsSnapshot } from 'otto-server';")).toEqual([]);
  });
  it.each(Object.entries(publicBrowserEntries))('verifies %s and its complete dependency graph are browser-safe', (_name, { entry, modules }) => {
    // esbuild requires Node's matching TextEncoder/Uint8Array realm. The rest
    // of this workspace runs in jsdom, so run the real compiler in a child.
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval',
      "import { build } from 'esbuild'; const result = await build({ entryPoints: [process.argv[1]], bundle: true, platform: 'browser', write: false, metafile: true }); console.log(JSON.stringify(Object.keys(result.metafile.inputs)));",
      path.resolve(rendererRoot, entry)], { cwd: path.resolve(rendererRoot, '../..'), encoding: 'utf8', timeout: 10_000 });
    expect((JSON.parse(output) as string[]).map((file) => path.basename(file)).sort()).toEqual(modules);
  });
});
