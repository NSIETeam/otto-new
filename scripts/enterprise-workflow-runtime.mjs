/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

// This workspace is built from the same source commit, not fetched from npm.
// It is a production dependency of the official local channel composition.
export function copyEnterpriseWorkflowRuntime({ repoRoot, releaseRoot }) {
  const source = path.join(repoRoot, 'packages/workflow');
  const metadata = JSON.parse(
    readFileSync(path.join(source, 'package.json'), 'utf8'),
  );
  if (
    metadata.name !== 'otto-workflow' ||
    metadata.type !== 'module' ||
    !/^\d+\.\d+\.\d+$/.test(metadata.version)
  ) {
    throw new Error('invalid workflow workspace identity');
  }
  if (
    Object.keys(metadata.dependencies ?? {}).length ||
    Object.keys(metadata.optionalDependencies ?? {}).length
  ) {
    throw new Error(
      'workflow dependencies changed: review standalone packaging closure',
    );
  }
  const dist = path.join(source, 'dist');
  const target = path.join(releaseRoot, 'node_modules/otto-workflow');
  if (existsSync(target))
    throw new Error('refusing to replace a workflow runtime');
  const files = [];
  const visit = (directory) => {
    const st = lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new Error('unsafe workflow build directory');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('workflow build contains a symlink');
      if (entry.isDirectory()) {
        if (entry.name !== 'test-support') visit(full);
        continue;
      }
      if (!entry.isFile()) throw new Error('unsupported workflow build entry');
      if (
        entry.name.endsWith('.js') &&
        !/\.(?:test|spec)\.js$/.test(entry.name)
      )
        files.push(full);
    }
  };
  visit(dist);
  if (!files.includes(path.join(dist, 'index.js')))
    throw new Error('workflow build entry missing');
  const bytes = files.reduce((sum, file) => sum + lstatSync(file).size, 0);
  if (bytes > 8 * 1024 * 1024)
    throw new Error('workflow runtime unexpectedly exceeds reviewed budget');
  for (const file of files) {
    const out = path.join(target, 'dist', path.relative(dist, file));
    mkdirSync(path.dirname(out), { recursive: true });
    copyFileSync(file, out);
  }
  writeFileSync(
    path.join(target, 'package.json'),
    JSON.stringify({
      name: metadata.name,
      version: metadata.version,
      type: 'module',
      private: true,
      main: './dist/index.js',
      license: 'Apache-2.0',
      dependencies: {},
    }) + '\n',
    { flag: 'wx' },
  );
  return {
    name: metadata.name,
    version: metadata.version,
    files: files.length,
    bytes,
  };
}
