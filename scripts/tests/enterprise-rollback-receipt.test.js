import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const gateway = readFileSync(
  'deployment/enterprise-oneclick/ci-deploy-gateway.sh',
  'utf8',
);
const fn = gateway.slice(
  gateway.indexOf('complete_rolled_back_receipt_if_previous() {'),
);
// Execute the actual verification-to-receipt tail in command substitution,
// where Bash does not inherit errexit. Filesystem/witness checks above this
// slice are exercised by enterprise-ci-linux-integration.sh on Linux.
const tail = fn.slice(
  fn.indexOf('  verify_current_deployment \\\n'),
  fn.indexOf('\n}\n'),
);
const git =
  process.platform === 'win32'
    ? execFileSync('where.exe', ['git'], { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0]
    : null;
const bash = git ? path.resolve(path.dirname(git), '../bin/bash.exe') : 'bash';

describe('rollback receipt protocol', () => {
  it.each([0, 7])(
    'keeps health diagnostics separate and rejects failed verification (%s)',
    (code) => {
      expect(tail).toContain('write_once_durable');
      const result = spawnSync(bash, [], {
        encoding: 'utf8',
        timeout: 5000,
        input: `set -Eeuo pipefail
fail() { printf '%s\\n' "$*" >&2; exit 2; }
verify_current_deployment() { printf '%s\\n' '{"ok":true}' '[Otto Deploy] health checked'; return ${code}; }
sync_live_deployment_filesystems() { :; }
rollback_receipt_for_state() { printf '%s\\n' 'rolled_back exact-locked-identity'; }
write_once_durable() { :; }
complete() {
local previous_version=1.9.14 previous_package=fixture previous_source=fixture transaction_dir=fixture
local expected_receipt
${tail}
}
receipt="$(complete)"
printf 'recovered_%s\\n' "$receipt"
`,
      });
      if (code === 0) {
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(
          'recovered_rolled_back exact-locked-identity\n',
        );
        expect(result.stderr).toContain('[Otto Deploy] health checked');
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain('rolled_back');
      }
    },
  );
});
