/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { resolveE2eeAdversarialCommands } from '../run-e2ee-adversarial-verification.mjs';

describe('E2EE adversarial runner', () => {
  it('builds the clean-checkout workspace chain before any adversarial test', () => {
    const commands = resolveE2eeAdversarialCommands();
    const rendered = commands.map(
      ([executable, args]) => `${executable} ${args.join(' ')}`,
    );

    expect(rendered).toHaveLength(6);
    expect(rendered[0]).toContain('--workspace otto-workflow run build');
    expect(rendered[1]).toContain('--workspace otto-rpa run build');
    expect(rendered[2]).toContain('--workspace otto-core run build');
    expect(rendered[3]).toContain('--workspace otto-desktop run test --');
    expect(rendered[4]).toContain('--workspace otto-server run test --');
    expect(rendered[5]).toContain(
      'cargo test --manifest-path otto-native/Cargo.toml mls::tests',
    );
  });
});
