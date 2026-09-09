/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('publishes a browser-safe recurring lifecycle entry without pulling in the Core barrel or Node modules', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(manifest.exports?.['./recurring-tasks']).toEqual({
    types: './dist/src/recurringTasks.d.ts',
    default: './dist/src/recurringTasks.js',
  });
  expect(manifest.exports['.'].default).toBe(`./${manifest.main}`);
  const output = await build({
    entryPoints: [fileURLToPath(new URL('./recurringTasks.ts', import.meta.url))],
    bundle: true, platform: 'browser', write: false, metafile: true,
  });
  expect(Object.keys(output.metafile!.inputs).map((file) => path.basename(file)).sort())
    .toEqual(['recurringTaskRegistry.ts', 'recurringTasks.ts']);
});
