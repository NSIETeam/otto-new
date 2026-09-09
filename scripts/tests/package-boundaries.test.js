import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const validator = path.resolve('scripts/validate-boundaries.mjs');
const fixtures = [];

function checkImport(specifier, exports) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'otto-boundary-'));
  fixtures.push(rootDir);
  mkdirSync(path.join(rootDir, 'packages/server'), { recursive: true });
  mkdirSync(path.join(rootDir, 'packages/desktop/src'), { recursive: true });
  writeFileSync(
    path.join(rootDir, 'packages/server/package.json'),
    JSON.stringify({ name: 'otto-server', exports }),
  );
  writeFileSync(
    path.join(rootDir, 'packages/desktop/src/example.ts'),
    `export { value } from '${specifier}';\n`,
  );
  return spawnSync(process.execPath, [validator], {
    cwd: rootDir,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe('package boundary public exports', () => {
  it('accepts an explicitly exported server subpath', () => {
    const result = checkImport('otto-server/recruitment', {
      '.': './dist/index.js',
      './recruitment': './dist/src/modules/recruitment_intelligence/recruitmentPublic.js',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('rejects deep imports even when the package exposes a wildcard', () => {
    const result = checkImport('otto-server/dist/src/enterprise/server.js', {
      '.': './dist/index.js',
      './*': './*',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('desktop must import otto-server through public package exports');
  });

  it('rejects an unexported or disabled server subpath', () => {
    for (const exports of [{ '.': './dist/index.js' }, { './recruitment': null }]) {
      expect(checkImport('otto-server/recruitment', exports).status).toBe(1);
    }
  });

  it('continues to reject cross-package server source imports', () => {
    expect(checkImport('../../server/src/example.js', {
      './example': './dist/src/example.js',
    }).status).toBe(1);
  });
});
