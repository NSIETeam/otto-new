/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const workflows = ['ci.yml', 'release.yml'].map(name => ({ name,
  source: readFileSync(path.join(root, '.github/workflows', name), 'utf8').replaceAll('\r\n', '\n') }));
const title = '      - name: Build current-source native integration test runtime';
function step(source) {
  const start = source.indexOf(title);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n      - name:', start + title.length);
  return source.slice(start, end);
}

describe.each(workflows)('$name real native integration prerequisite', ({ source }) => {
  it('builds the locked current source before the full server/native test gate', () => {
    const setup = step(source);
    expect(setup).toContain('OTTO_NATIVE_RELEASE_TOOLCHAIN');
    expect(setup).toContain('rustup toolchain install "$rust_toolchain" --profile minimal');
    expect(setup).toContain('cargo "+$rust_toolchain" build --locked');
    expect(setup).toContain('--manifest-path otto-native/Cargo.toml --bin otto-native');
    expect(setup).toContain('--target-dir otto-native/target');
    expect(setup).toContain('test -x otto-native/target/debug/otto-native');
    expect(setup).toContain('git diff --exit-code -- otto-native/Cargo.lock');
    expect(setup).not.toMatch(/continue-on-error|\|\| true|cp |download-artifact|skip/i);
    const tests = source.search(/npm (?:--workspace otto-server run test|run test:ci)/);
    expect(tests).toBeGreaterThan(source.indexOf(title));
  });
});

it('uses identical current-source prerequisites for CI and the release quality gate', () => {
  expect(step(workflows[0].source)).toBe(step(workflows[1].source));
});
