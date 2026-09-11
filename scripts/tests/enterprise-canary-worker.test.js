import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
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
  publishControlHandshake,
  readinessPublicationComplete,
  readPackageManifest,
} from '../../deployment/enterprise-oneclick/tools/canary-worker.mjs';
import {
  fetchHealthJson,
  validateSmsConfiguration,
} from '../../deployment/enterprise-oneclick/tools/health-check.mjs';

describe('signed upgrade canary isolation contract', () => {
  it('accepts a root-owned package manifest larger than a control receipt', () => {
    const files = Object.fromEntries(
      Array.from({ length: 8000 }, (_, i) => [
        `node_modules/component-${i}/distribution/server-long-file-name-${i}.js`,
        'a'.repeat(64),
      ]),
    );
    const raw = JSON.stringify({ version: '1.9.15', files });
    expect(Buffer.byteLength(raw)).toBeGreaterThan(1024 * 1024);
    vi.spyOn(fs, 'lstatSync').mockReturnValue({
      isSymbolicLink: () => false,
      isFile: () => true,
      uid: 0,
      nlink: 1,
      mode: 0o444,
      size: Buffer.byteLength(raw),
    });
    vi.spyOn(fs, 'readFileSync').mockReturnValue(raw);
    try {
      expect(
        Object.keys(readPackageManifest('/package/manifest.json').files),
      ).toHaveLength(8000);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('bounds package manifests separately without relaxing custody or readiness limits', () => {
    const metadata = {
      isSymbolicLink: () => false,
      isFile: () => true,
      uid: 0,
      nlink: 1,
      mode: 0o444,
      size: 16 * 1024 * 1024,
    };
    const stat = vi.spyOn(fs, 'lstatSync').mockReturnValue(metadata);
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');
    try {
      expect(readPackageManifest('/package/manifest.json')).toEqual({});
      read.mockClear();
      stat.mockReturnValue({ ...metadata, size: metadata.size + 1 });
      expect(() => readPackageManifest('/package/manifest.json')).toThrow(
        'canary-manifest-too-large',
      );
      expect(read).not.toHaveBeenCalled();
      for (const changed of [
        { uid: 1 },
        { nlink: 2 },
        { mode: 0o666 },
        { isSymbolicLink: () => true },
        { isFile: () => false },
      ]) {
        stat.mockReturnValue({ ...metadata, ...changed });
        expect(() => readPackageManifest('/package/manifest.json')).toThrow(
          'canary-path-custody-invalid',
        );
      }
      stat.mockReturnValue({ ...metadata, size: 1024 * 1024 + 1 });
      expect(() => readinessPublicationComplete('/work/ready.json', 0)).toThrow(
        'canary-receipt-too-large',
      );
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it.each(['writeFileSync', 'fchmodSync', 'fsyncSync', 'linkSync'])(
    'never publishes partial control bytes after %s fails and removes only its own staging file',
    (operation) => {
      const directory = mkdtempSync(
        path.join(os.tmpdir(), 'otto-canary-fault-'),
      );
      const target = path.join(directory, 'go.json');
      const originalWrite = fs.writeFileSync.bind(fs);
      const unrelated = path.join(directory, 'unrelated.pending');
      originalWrite(unrelated, 'preserve');
      vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {});
      vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {});
      vi.spyOn(fs, operation).mockImplementation(() => {
        throw Object.assign(new Error('injected publication fault'), {
          code: 'EIO',
        });
      });
      try {
        expect(() => publishControlHandshake(target, 'a'.repeat(32))).toThrow(
          'injected publication fault',
        );
        expect(fs.existsSync(target)).toBe(false);
        expect(fs.readdirSync(directory)).toEqual(['unrelated.pending']);
        expect(readFileSync(unrelated, 'utf8')).toBe('preserve');
      } finally {
        vi.restoreAllMocks();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it.runIf(process.platform !== 'win32')(
    'does not replace existing or dangling control symlinks or modify their targets',
    () => {
      const directory = mkdtempSync(
        path.join(os.tmpdir(), 'otto-canary-links-'),
      );
      try {
        for (const exists of [true, false]) {
          const destination = path.join(directory, `destination-${exists}`);
          const target = path.join(directory, `go-${exists}.json`);
          if (exists) writeFileSync(destination, 'original');
          fs.symlinkSync(destination, target);
          expect(() =>
            publishControlHandshake(target, 'a'.repeat(32)),
          ).toThrow();
          expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
          expect(fs.readlinkSync(target)).toBe(destination);
          expect(fs.existsSync(destination)).toBe(exists);
          if (exists)
            expect(readFileSync(destination, 'utf8')).toBe('original');
          expect(
            fs.readdirSync(directory).some((name) => name.endsWith('.pending')),
          ).toBe(false);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it('waits for exclusive readiness publication without accepting unsafe or multiply-linked receipts', () => {
    const metadata = {
      isSymbolicLink: () => false,
      isFile: () => true,
      uid: 71,
      mode: 0o600,
      nlink: 2,
      size: 128,
    };
    const observed = vi.spyOn(fs, 'lstatSync').mockReturnValue(metadata);
    try {
      expect(readinessPublicationComplete('/fixture/ready.json', 71)).toBe(
        false,
      );
      observed.mockReturnValue({ ...metadata, nlink: 1 });
      expect(readinessPublicationComplete('/fixture/ready.json', 71)).toBe(
        true,
      );
      for (const changed of [
        { nlink: 0 },
        { nlink: 3 },
        { uid: 72 },
        { mode: 0o622 },
        { isSymbolicLink: () => true },
        { isFile: () => false },
      ]) {
        observed.mockReturnValue({ ...metadata, ...changed });
        expect(() =>
          readinessPublicationComplete('/fixture/ready.json', 71),
        ).toThrow('canary-path-custody-invalid');
      }
      observed.mockReturnValue({ ...metadata, size: 1024 * 1024 + 1 });
      expect(() =>
        readinessPublicationComplete('/fixture/ready.json', 71),
      ).toThrow('canary-receipt-too-large');
      observed.mockImplementation(() => {
        throw Object.assign(new Error('not present'), { code: 'ENOENT' });
      });
      expect(readinessPublicationComplete('/fixture/ready.json', 71)).toBe(
        false,
      );
      observed.mockImplementation(() => {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      });
      expect(() =>
        readinessPublicationComplete('/fixture/ready.json', 71),
      ).toThrow('access denied');
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('does not expose a control handshake until its complete bytes and readable mode are ready', () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), 'otto-canary-publish-'),
    );
    const target = path.join(directory, 'go.json');
    const syncProbe = path.join(directory, 'sync-probe');
    const originalOpen = fs.openSync.bind(fs);
    const permissions = [];
    writeFileSync(syncProbe, 'fixture');
    // Portable scheduling test. Actual POSIX permissions/directory fsync are
    // additionally exercised by the disposable Linux systemd acceptance.
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) =>
      originalOpen(file === directory ? syncProbe : file, ...args),
    );
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {});
    vi.spyOn(fs, 'fchmodSync').mockImplementation((_fd, mode) => {
      permissions.push({ mode, targetVisible: fs.existsSync(target) });
    });
    vi.spyOn(fs, 'chmodSync').mockImplementation((_file, mode) => {
      permissions.push({ mode, targetVisible: fs.existsSync(target) });
    });
    try {
      const nonce = 'a'.repeat(32);
      publishControlHandshake(target, nonce);
      expect(permissions).toEqual([{ mode: 0o444, targetVisible: false }]);
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ nonce });
      expect(fs.statSync(target).nlink).toBe(1);
      expect(() => publishControlHandshake(target, 'b'.repeat(32))).toThrow();
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ nonce });
      expect(fs.readdirSync(directory).sort()).toEqual([
        'go.json',
        'sync-probe',
      ]);
    } finally {
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    }
  });
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
