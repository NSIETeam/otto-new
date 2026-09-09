/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorrespondingSource } from './heic-corresponding-source.mjs';

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (!['--output-dir', '--cache-dir'].includes(key) || !value || options[key])
    throw new Error(
      'usage: --output-dir <outside-checkout> [--cache-dir <verified-cache>]',
    );
  options[key] = value;
}
if (!options['--output-dir']) throw new Error('--output-dir is required');
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const result = await buildCorrespondingSource({
  repoRoot,
  outputDir: options['--output-dir'],
  cacheDir: options['--cache-dir'],
});
process.stdout.write(`${JSON.stringify(result)}\n`);
