import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const gateway = readFileSync(
  'deployment/enterprise-oneclick/ci-deploy-gateway.sh',
  'utf8',
);
const start = gateway.indexOf(
  'if [ "$COMMAND" = \'finalize-deployment\' ]; then',
);
const end = gateway.indexOf(
  'if [ "$COMMAND" = \'publish-mirror\' ]; then',
  start,
);
// Execute the actual command branch in its own Bash process, just like SSH.
// Root ownership, snapshots and durable writes are covered by the Linux suite.
const finalize = gateway.slice(start, end);
const git =
  process.platform === 'win32'
    ? execFileSync('where.exe', ['git'], { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0]
    : null;
const bash = git ? path.resolve(path.dirname(git), '../bin/bash.exe') : 'bash';

describe('finalization receipt protocol', () => {
  it.each([
    ['pending', 0],
    ['finalized', 0],
    ['pending', 7],
    ['finalized', 7],
    ['rolled-back', 0],
    ['rolled-back', 7],
  ])(
    'isolates health output and preserves rejection (%s, %s)',
    (state, code) => {
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const fixture = mkdtempSync(
        path.join(os.tmpdir(), 'otto-finalize-receipt-'),
      );
      try {
        if (state !== 'pending')
          writeFileSync(path.join(fixture, state), 'fixture');
        const result = spawnSync(bash, [], {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, FIXTURE: fixture.replaceAll('\\', '/') },
          input: `set -Eeuo pipefail
fail() { printf '%s\\n' "$*" >&2; exit 2; }
acquire_production_lock() { :; }
require_deployment_transaction() { printf '%s\\n' "$FIXTURE"; }
verify_current_deployment() { printf '%s\\n' '{"ok":true}' '[Otto Deploy] health checked'; return ${code}; }
sync_live_deployment_filesystems() { printf '%s\\n' 'durability barrier' >&2; }
deployment_receipt_for_state() { printf '%s\\n' 'deployed exact-locked-identity'; }
complete_deployment_receipt() { printf '%s\\n' 'completed receipt' >&2; deployment_receipt_for_state; }
write_once_durable() { printf 'write %s\\n' "\${1##*/}" >&2; }
COMMAND=finalize-deployment
set -- finalize-deployment v1.9.15-1-1 1.9.15 fixture fixture
${finalize}
`,
        });
        expect(result.error).toBeUndefined();
        expect(result.stderr).toContain('[Otto Deploy] health checked');
        if (code === 0 && state !== 'rolled-back') {
          expect(result.status).toBe(0);
          expect(result.stdout).toBe(
            'finalized deployed exact-locked-identity\n',
          );
          expect(result.stderr).toContain('write finalized');
          if (state === 'finalized') {
            expect(result.stderr).toContain('write receipt');
            expect(result.stderr).not.toContain('completed receipt');
          } else {
            expect(result.stderr).toContain('completed receipt');
          }
        } else {
          expect(result.status).not.toBe(0);
          expect(result.stdout).toBe('');
          expect(result.stderr).not.toContain('write finalized');
          expect(result.stderr).not.toContain('completed receipt');
          if (code !== 0)
            expect(result.stderr).not.toContain('durability barrier');
        }
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
