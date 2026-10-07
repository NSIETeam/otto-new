/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

it('accepts the actual pinned release runtime, not a retired Electron runtime', () => {
  const source = readFileSync('packages/desktop/scripts/sharp-packaging.mjs', 'utf8');
  const condition = source.match(/if \(proof\.passed !== true[\s\S]*?throw new Error\('packaged Electron media proof mismatch'\);/)[0];
  const version = JSON.parse(readFileSync('packages/desktop/package.json', 'utf8')).build.electronVersion;
  const validate = (electron, override = {}) => vm.runInNewContext(condition, {
    proof: { passed: true, platform: 'win32', arch: 'x64', electron, sharp: '0.35.5', libvips: '8.18.7', rsvg: '2.63.2', ...override },
    target: 'win32-x64', expectedElectron: version,
  });
  expect(() => validate(version)).not.toThrow();
  expect(() => validate('43.2.0')).toThrow('proof mismatch');
  expect(() => validate(version, { sharp: '0.35.4', libvips: '8.18.6', rsvg: '2.62.91' })).toThrow('proof mismatch');
  expect(() => validate(version, { rsvg: '2.62.91' })).toThrow('proof mismatch');
});
