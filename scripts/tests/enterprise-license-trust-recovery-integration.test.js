/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const upgrade = readFileSync(
  path.join(root, 'deployment/enterprise-oneclick/upgrade.sh'),
  'utf8',
);
const worker = readFileSync(
  path.join(
    root,
    'deployment/enterprise-oneclick/tools/canary-worker.mjs',
  ),
  'utf8',
);

describe('one-click License trust-root recovery wiring', () => {
  it('stages only the fixed root-owned recovery file into the transaction', () => {
    expect(upgrade).toContain(
      'LICENSE_RECOVERY_SOURCE="/etc/otto-enterprise/license-trust-recovery.json"',
    );
    expect(upgrade).toContain(
      'LICENSE_RECOVERY_STAGED="${TXN_DIR}/license-trust-recovery.json"',
    );
    expect(upgrade).toContain(
      'stat -c \'%u:%g:%a\' "$LICENSE_RECOVERY_SOURCE"',
    );
    expect(upgrade).toContain(
      'install -o root -g root -m 0600 "$LICENSE_RECOVERY_SOURCE" "$LICENSE_RECOVERY_STAGED"',
    );
    expect(upgrade).toContain(
      'LICENSE_RECOVERY_SOURCE_HASH="$(sha256sum "$LICENSE_RECOVERY_SOURCE"',
    );
    expect(upgrade).toContain(
      'LICENSE_RECOVERY_STAGED_HASH="$(sha256sum "$LICENSE_RECOVERY_STAGED"',
    );
    expect(upgrade).toContain(
      '[ "$LICENSE_RECOVERY_SOURCE_HASH" = "$LICENSE_RECOVERY_STAGED_HASH" ]',
    );
  });

  it('gives the isolated canary a credential only when recovery is staged', () => {
    expect(worker).toContain('licenseRecovery: recovery !== null');
    expect(worker).toContain(
      '`LoadCredential=license-recovery:${transaction}/license-trust-recovery.json`',
    );
    expect(worker).toContain(
      "`${credentials}/license-recovery`",
    );
    expect(worker).toContain(
      'hash(fs.readFileSync(recoveryFile)) !== config.licenseRecoveryHash',
    );
    expect(worker).toContain(
      "`${VIEW}/package/release/license-public-keys.json`",
    );
  });

  it('imports the recovery License after readiness and before licensed health checks', () => {
    const readiness = worker.indexOf('const ready = json(env.OTTO_ENTERPRISE_READY_FILE');
    const recovery = worker.indexOf('applyLicenseTrustRecovery({');
    const health = worker.indexOf('await runHealthChecks({');
    expect(readiness).toBeGreaterThan(-1);
    expect(recovery).toBeGreaterThan(readiness);
    expect(health).toBeGreaterThan(recovery);
    expect(worker).toContain('licenseRecoveryReceipt');
  });

  it('binds the redacted recovery receipt into the immutable canary deliverable', () => {
    expect(worker).toContain('recoveryReceipt: result.licenseRecoveryReceipt');
    expect(worker).toContain(
      'canonicalRecoveryJson(receipt.recoveryReceipt) !==',
    );
    expect(worker).toContain(
      'canonicalRecoveryJson(result.licenseRecoveryReceipt)',
    );
  });

  it('deletes the one-time source only after live verification and matching staged bytes', () => {
    const liveVerify = upgrade.lastIndexOf(
      '"${INSTALL_ROOT}/deploy/verify.sh"',
    );
    const deletion = upgrade.indexOf(
      'rm -f -- "$LICENSE_RECOVERY_SOURCE"',
    );
    expect(liveVerify).toBeGreaterThan(-1);
    expect(deletion).toBeGreaterThan(liveVerify);
    expect(upgrade).toContain(
      '[ "$(sha256sum "$LICENSE_RECOVERY_SOURCE" | awk \'{print $1}\')" = "$LICENSE_RECOVERY_SOURCE_HASH" ]',
    );
    expect(upgrade).toContain('/usr/bin/sync -f "$(dirname -- "$LICENSE_RECOVERY_SOURCE")"');
  });
});
