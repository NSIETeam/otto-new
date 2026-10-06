/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  admittedHostDirectory, assertHistoricalZip, historicalHostTools, LEGACY_ELECTRON,
} from '../prepare-windows-legacy-electron-host.mjs';

describe('separate byte-pinned historical test host', () => {
  it('loads download and extraction from the currently installed Electron dependency boundary', async () => {
    const tools = await historicalHostTools();
    expect(typeof tools.downloadArtifact).toBe('function');
    expect(typeof tools.extract).toBe('function');
  });
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_TEMP: path.resolve('synthetic-fixture'),
    GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  it.each(['linux', 'darwin'])('rejects a different actual platform (%s)', platform => {
    expect(() => admittedHostDirectory(env, platform)).toThrow('GitHub-hosted');
  });
  it.each(['GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_TEMP', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])(
    'rejects a missing admission field %s', key => {
      expect(() => admittedHostDirectory({ ...env, [key]: '' }, 'win32')).toThrow();
    },
  );
  it('binds an admitted fixture to its exact child without creating it', () => {
    expect(admittedHostDirectory(env, 'win32')).toBe(path.join(env.RUNNER_TEMP, 'otto-legacy-electron-host'));
    expect(() => admittedHostDirectory({ ...env, RUNNER_TEMP: path.parse(env.RUNNER_TEMP).root }, 'win32')).toThrow('Unsafe');
  });
  it('rejects a truncated or same-length tampered archive before extraction', () => {
    expect(() => assertHistoricalZip(Buffer.alloc(1))).toThrow('identity');
    expect(() => assertHistoricalZip(Buffer.alloc(LEGACY_ELECTRON.bytes))).toThrow('identity');
  });
  it('rejects a workstation invocation without downloading or executing a host', () => {
    const result = spawnSync(process.execPath, ['scripts/prepare-windows-legacy-electron-host.mjs'], {
      env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', windowsHide: true, timeout: 5_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('preparation rejected');
  });
});
