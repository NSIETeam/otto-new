import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildUnitArguments,
  systemdRunDiagnostic,
  cleanStopProof,
  runtimeEnvironment,
  validateMounts,
  parseConfiguration,
} from '../../deployment/enterprise-oneclick/tools/canary-worker.mjs';
import {
  fetchHealthJson,
  validateSmsConfiguration,
} from '../../deployment/enterprise-oneclick/tools/health-check.mjs';

describe('signed upgrade canary isolation contract', () => {
  it.each([false, true])(
    'does not restore or restart anything after an unknown worker stop (existing evidence=%s)',
    (existing) => {
      const directory = mkdtempSync(
        path.join(os.tmpdir(), 'otto-canary-cleanup-'),
      );
      try {
        if (existing)
          writeFileSync(
            path.join(directory, 'recovery-required'),
            'original evidence',
          );
        const upgrade = readFileSync(
          new URL(
            '../../deployment/enterprise-oneclick/upgrade.sh',
            import.meta.url,
          ),
          'utf8',
        );
        const cleanup = upgrade.slice(
          upgrade.indexOf('cleanup() {'),
          upgrade.indexOf('\ntrap cleanup EXIT'),
        );
        const git =
          process.platform === 'win32'
            ? execFileSync('where.exe', ['git'], { encoding: 'utf8' })
                .trim()
                .split(/\r?\n/)[0]
            : null;
        const bash = git
          ? path.resolve(path.dirname(git), '../bin/bash.exe')
          : 'bash';
        const result = spawnSync(bash, [], {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, FIXTURE: directory.replaceAll('\\', '/') },
          input: `set -Eeuo pipefail
TXN_DIR="$FIXTURE"
CANARY_STARTED=1
SCRIPT_DIR="$FIXTURE"
NODE_PATH=fake_node
fake_node() { return 1; }
otto_warn() { :; }
install() { printf forbidden; }
cp() { printf forbidden; }
rm() { printf forbidden; }
systemctl() { printf forbidden; }
${cleanup}
cleanup
`,
        });
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain('forbidden');
        expect(
          readFileSync(path.join(directory, 'recovery-required'), 'utf8'),
        ).toBe(existing ? 'original evidence' : 'canary-stop-unknown\n');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it('requires observed read-only host IPC/package mounts and the sole writable worker bind', () => {
    const lines = [
      '/',
      '/run',
      '/tmp',
      '/var/tmp',
      '/run/otto-canary/package',
      '/run/otto-canary/control',
      '/run/otto-canary/node',
    ].map((mount) => `1 2 0:1 / ${mount} ro - tmpfs tmpfs ro`);
    lines.push('1 2 0:1 / /run/otto-canary/work rw - ext4 /dev/test rw');
    expect(validateMounts(lines.join('\n'))).toBe(true);
    expect(() =>
      validateMounts(lines.join('\n').replace('/run ro', '/run rw')),
    ).toThrow('canary-mount-isolation-mismatch');
    expect(() => validateMounts(lines.slice(1).join('\n'))).toThrow(
      'canary-mount-isolation-mismatch',
    );
  });
  it('parses the same literal configuration syntax without expanding shell text', () => {
    expect(
      parseConfiguration(
        ' # ignored\nexport ALIYUN_SMS_SIGN_NAME="$(not-executed)"\n',
      ),
    ).toEqual({ ALIYUN_SMS_SIGN_NAME: '$(not-executed)' });
    expect(() => parseConfiguration('source /tmp/untrusted')).toThrow(
      'canary-configuration-invalid',
    );
  });
  const request = {
    unit: 'otto-upgrade-canary-0123456789abcdef.service',
    transaction: '/tmp/root-only-txn',
    packageRoot: '/opt/package',
    nodeRoot: '/opt/node',
    uid: 991,
    gid: 991,
  };
  it('uses a host-resolvable exec trampoline for the namespace-only Node path, never a shell', () => {
    const args = buildUnitArguments(request);
    expect(args.slice(-5)).toEqual([
      '/usr/bin/env',
      '--',
      '/run/otto-canary/node',
      '/run/otto-canary/package/tools/canary-worker.mjs',
      '_worker',
    ]);
    expect(args).not.toContain('-c');
    expect(args).not.toContain('-i'); // systemd's CREDENTIALS_DIRECTORY must survive exec.
  });
  it('retains only bounded enum diagnostics, never raw systemd stderr or credentials', () => {
    expect(
      systemdRunDiagnostic(
        'Failed to find executable /run/otto-canary/node: No such file or directory',
      ),
    ).toBe('executable-unavailable');
    expect(
      systemdRunDiagnostic(
        'Failed to start transient service unit: secret-value',
      ),
    ).toBe('unit-start-rejected');
    expect(systemdRunDiagnostic('secret-value')).toBe('unclassified');
    expect(
      systemdRunDiagnostic(
        'x'.repeat(8192) + 'Failed to find executable secret',
      ),
    ).toBe('unclassified');
  });
  it('fixes resource limits and exposes only the canary work subtree writable', () => {
    const args = buildUnitArguments(request).join('\n');
    for (const property of [
      'MemoryMax=500M',
      'MemorySwapMax=0',
      'CPUQuota=50%',
      'RuntimeMaxSec=180',
      'TimeoutStopSec=60',
      'PrivateNetwork=yes',
      'NoNewPrivileges=yes',
      'CapabilityBoundingSet=',
      'AmbientCapabilities=',
      'ProtectSystem=strict',
      'TasksMax=64',
      'KillMode=control-group',
    ])
      expect(args).toContain(property);
    expect(args).toContain('TemporaryFileSystem=/run:ro');
    expect(args).toContain(
      'BindPaths=/tmp/root-only-txn/canary/work:/run/otto-canary/work',
    );
    expect(args).not.toContain('ReadWritePaths=/tmp/root-only-txn');
    expect(args).not.toContain('--collect');
    expect(args).not.toContain('--pipe');
    expect(args).not.toContain('ADMIN_TOKEN=');
  });
  it('never forwards production SMS, channel, proxy or admin credentials', () => {
    const env = runtimeEnvironment(
      {
        buildId: 'abc',
        version: '1.9.15',
        publicUrl: 'https://example.invalid',
        deploymentGrants: 'signed-grants',
        databaseKeyId: 'key',
      },
      '/run/credentials/unit',
      'random-canary-only',
    );
    expect(env.OTTO_ENTERPRISE_ADMIN_TOKEN).toBe('random-canary-only');
    expect(env.OTTO_DATABASE_ENCRYPTION_KEY_FILE).toBe(
      '/run/credentials/unit/database-key',
    );
    for (const key of [
      'ALIYUN_SMS_ACCESS_KEY_SECRET',
      'HTTPS_PROXY',
      'FEISHU_APP_SECRET',
      'PATH',
      'NODE_OPTIONS',
    ])
      expect(env).not.toHaveProperty(key);
  });
  const witness = {
    invocationId: 'a'.repeat(32),
    cgroup: '/system.slice/otto-upgrade-canary-0123456789abcdef.service',
  };
  const state = {
    InvocationID: 'a'.repeat(32),
    ActiveState: 'inactive',
    MainPID: '0',
    Result: 'success',
    ExecMainCode: '1',
    ExecMainStatus: '0',
  };
  it('requires independent matching clean systemd exit and recursive cgroup emptiness', () => {
    expect(
      cleanStopProof(witness, state, { populated: false, processes: [] }),
    ).toBe(true);
    for (const override of [
      { InvocationID: 'b'.repeat(32) },
      { Result: 'timeout' },
      { Result: 'oom-kill' },
      { ExecMainStatus: '7' },
      { MainPID: '12' },
      { ActiveState: 'active' },
    ])
      expect(
        cleanStopProof(
          witness,
          { ...state, ...override },
          { populated: false, processes: [] },
        ),
      ).toBe(false);
    expect(
      cleanStopProof(witness, state, { populated: true, processes: [] }),
    ).toBe(false);
    expect(
      cleanStopProof(witness, state, { populated: false, processes: [99] }),
    ).toBe(false);
    expect(cleanStopProof(witness, {}, { missing: true })).toBe(false);
    expect(
      cleanStopProof(witness, { LoadState: 'not-found' }, { missing: true }),
    ).toBe(false);
    expect(
      cleanStopProof(
        { ...witness, waitExit: 0 },
        { LoadState: 'not-found' },
        { missing: true },
      ),
    ).toBe(true);
    expect(
      cleanStopProof(
        { ...witness, waitExit: 7 },
        { LoadState: 'not-found' },
        { missing: true },
      ),
    ).toBe(false);
  });
});

describe('shared bounded upgrade health transport', () => {
  it('keeps SMS validation separate from runtime credentials and fails closed', () => {
    expect(() => validateSmsConfiguration({}, true)).toThrow(
      'SMS configuration is incomplete',
    );
    expect(validateSmsConfiguration({}, false)).toEqual({ required: false });
  });
  it('rejects a redirected response and does not report its body or secrets', async () => {
    const response = new Response('secret body');
    Object.defineProperty(response, 'url', {
      value: 'http://foreign.invalid/',
    });
    await expect(
      fetchHealthJson('http://127.0.0.1/test', {
        deadline: performance.now() + 1000,
        fetchImpl: async () => response,
      }),
    ).rejects.toThrow('health response URL changed');
  });
  it('caps streamed bytes and a body that never completes under one deadline', async () => {
    const response = new Response(new Uint8Array(1024 * 1024 + 1));
    Object.defineProperty(response, 'url', { value: 'http://127.0.0.1/test' });
    await expect(
      fetchHealthJson(response.url, {
        deadline: performance.now() + 1000,
        fetchImpl: async () => response,
      }),
    ).rejects.toThrow('health response exceeds size limit');
    const stalled = new Response(new ReadableStream({ start() {} }));
    Object.defineProperty(stalled, 'url', { value: response.url });
    await expect(
      fetchHealthJson(stalled.url, {
        deadline: performance.now() + 20,
        fetchImpl: async () => stalled,
      }),
    ).rejects.toThrow('health deadline exceeded');
  });
});
