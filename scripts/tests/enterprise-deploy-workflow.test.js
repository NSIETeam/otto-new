import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import './release-deploy-workflow.contract.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const workflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'deploy-server.yml'),
  'utf8',
);

describe('enterprise production deployment workflow', () => {
  it('supports both a reusable release call and an explicit manual deployment', () => {
    expect(workflow).toContain('  workflow_call:');
    expect(workflow).toContain('  workflow_dispatch:');
    expect(workflow).toContain('    environment: production-automation');
    expect(workflow).toMatch(
      /workflow_call:[\s\S]*?package_identity:[\s\S]*?source_commit:[\s\S]*?required: true/,
    );
    expect(workflow).toMatch(
      /workflow_call:[\s\S]*?use_workflow_artifact:[\s\S]*?type: boolean[\s\S]*?default: false/,
    );
    expect(workflow).toContain(
      'if: ${{ inputs.use_workflow_artifact == true }}',
    );
    expect(workflow).toContain(
      'if: ${{ inputs.use_workflow_artifact != true }}',
    );
  });

  it('passes inputs through the environment and validates the exact identity', () => {
    expect(workflow).toContain('VERSION_INPUT: ${{ inputs.version }}');
    expect(workflow).toContain(
      'PACKAGE_ID_INPUT: ${{ inputs.package_identity }}',
    );
    expect(workflow).toContain(
      'SOURCE_COMMIT_INPUT: ${{ inputs.source_commit }}',
    );
    expect(workflow).toContain(
      'RELEASE_REPOSITORY_INPUT: ${{ inputs.release_repository }}',
    );
    expect(workflow).toContain(
      String.raw`[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]`,
    );
    expect(workflow).toContain(
      '[[ "$PACKAGE_ID" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]]',
    );
    expect(workflow).not.toContain('VERSION="${{ inputs.version }}"');
    expect(workflow).not.toContain(
      "PACKAGE_ID='${{ inputs.package_identity }}'",
    );
  });

  it('requires protected approval for standalone production deployments', () => {
    expect(workflow).toContain('manual-production-approval:');
    expect(workflow).toContain('environment: production-approval');
    expect(workflow).toContain('- manual-production-approval');
    expect(workflow).toContain('always()\n        && !cancelled()');
    expect(workflow).toContain(
      "needs.manual-production-approval.result == 'success'",
    );
  });

  it('proves both deployment principals and rejects both cross-logins before checkout', () => {
    const principalValidationStart = workflow.indexOf(
      '  validate-deployment-principals:',
    );
    const deployStart = workflow.indexOf('  deploy:');
    const principalValidationJob = workflow.slice(
      principalValidationStart,
      deployStart,
    );
    const deployJob = workflow.slice(deployStart);

    expect(principalValidationStart).toBeGreaterThan(-1);
    expect(deployStart).toBeGreaterThan(principalValidationStart);
    expect(principalValidationJob).toContain(
      'name: Validate isolated deployment principals',
    );
    expect(principalValidationJob).toContain(
      'environment: production-automation',
    );
    expect(principalValidationJob).not.toMatch(/^\s+uses:/m);
    expect(principalValidationJob).not.toContain('actions/checkout@');
    expect(principalValidationJob).toContain(
      '[ "$DEPLOY_USER" != "$ROLLBACK_DEPLOY_USER" ]',
    );
    expect(principalValidationJob).toContain(
      '[ "$DEPLOY_KEY_FINGERPRINT" != "$ROLLBACK_KEY_FINGERPRINT" ]',
    );
    expect(principalValidationJob).toContain(
      'preflight_principal "$PRINCIPAL_AUDIT_DIR/deploy" "$DEPLOY_USER"',
    );
    expect(principalValidationJob).toContain(
      'preflight_principal "$PRINCIPAL_AUDIT_DIR/rollback" "$ROLLBACK_DEPLOY_USER"',
    );
    expect(principalValidationJob).toContain(
      '-o PreferredAuthentications=publickey',
    );
    expect(principalValidationJob).toContain('-o PasswordAuthentication=no');
    expect(principalValidationJob).toContain(
      '-o KbdInteractiveAuthentication=no',
    );
    expect(principalValidationJob).toContain('for cross_attempt in 1 2 3; do');
    expect(principalValidationJob).toContain(
      'stderr_file="$(mktemp "$PRINCIPAL_AUDIT_DIR/cross-login.XXXXXX")"',
    );
    expect(principalValidationJob).toContain('chmod 0600 "$stderr_file"');
    expect(principalValidationJob).toContain('2>"$stderr_file"');
    expect(principalValidationJob).toContain(
      'if [ "$status" -ne 255 ] || [ "${#stderr_lines[@]}" -ne 1 ]; then',
    );
    expect(principalValidationJob).toContain(
      String.raw`Permission\ denied\ \(publickey\)\.$`,
    );
    expect(principalValidationJob).not.toContain('[ "$status" -eq 255 ]');
    expect(principalValidationJob).toContain(
      'reject_cross_login "$PRINCIPAL_AUDIT_DIR/deploy" "$ROLLBACK_DEPLOY_USER"',
    );
    expect(principalValidationJob).toContain(
      'reject_cross_login "$PRINCIPAL_AUDIT_DIR/rollback" "$DEPLOY_USER"',
    );
    expect(principalValidationJob).toContain('-o StrictHostKeyChecking=yes');
    expect(principalValidationJob).toContain(
      '-o "UserKnownHostsFile=$PRINCIPAL_AUDIT_DIR/known_hosts"',
    );
    expect(deployJob).toContain('- validate-deployment-principals');
    expect(deployJob).toContain(
      "needs.validate-deployment-principals.result == 'success'",
    );
    expect(workflow.indexOf('actions/checkout@')).toBeGreaterThan(deployStart);
  });

  it('rejects stale workflow artifacts before touching production', () => {
    expect(workflow).toContain(
      'Revalidate exact latest internal source before deployment',
    );
    expect(workflow).toContain(
      'repos/${GITHUB_REPOSITORY}/git/ref/heads/internal',
    );
    expect(workflow).toContain(
      'origin/internal changed immediately before deployment; refusing the old candidate.',
    );
  });

  it('locks the archive name and rejects ambiguous package assets', () => {
    expect(workflow).toContain(
      'ARCHIVE_NAME="otto-enterprise-oneclick-v${VERSION}-${PACKAGE_ID}.tar.gz"',
    );
    expect(workflow).toContain('[ "${#archives[@]}" -eq 1 ]');
    expect(workflow).toContain('[ "${#checksums[@]}" -eq 1 ]');
    expect(workflow).toContain('[ "${#signatures[@]}" -eq 1 ]');
    expect(workflow).toContain('sha256sum -c -- "${ARCHIVE_NAME}.sha256"');
    expect(workflow).toContain(
      'node scripts/verify-enterprise-package-signature.mjs',
    );
  });

  it('scopes connection secrets and validates host, user and port grammar', () => {
    expect(workflow).toContain(
      '[[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]]',
    );
    expect(workflow).toContain('[[ "$DEPLOY_HOST" != *\'..\'* ]]');
    expect(workflow).toContain(
      '[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]',
    );
    expect(workflow).toContain(
      '[[ "$ROLLBACK_DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]',
    );
    expect(workflow).toContain('[ "$DEPLOY_USER" != "$ROLLBACK_DEPLOY_USER" ]');
    expect(workflow).toContain('[[ "$DEPLOY_PORT" =~ ^[0-9]+$ ]]');
    expect(workflow).toContain(
      '[ "$DEPLOY_PORT" -ge 1 ] && [ "$DEPLOY_PORT" -le 65535 ]',
    );
    expect(workflow).not.toContain('DEPLOY_SUDO_PASSWORD');
  });

  it('uses hardened SSH and uploads only the three exact package files', () => {
    expect(workflow).toContain('-o BatchMode=yes');
    expect(workflow).toContain('-o StrictHostKeyChecking=yes');
    expect(workflow).toContain('-o IdentitiesOnly=yes');
    expect(workflow).toContain('-o ConnectTimeout=15');
    expect(workflow).toContain('-o ServerAliveInterval=15');
    expect(workflow).toContain('-o ServerAliveCountMax=3');
    expect(workflow).not.toContain('StrictHostKeyChecking=no');
    expect(workflow).not.toContain('ssh-keyscan');
    expect(workflow).toContain(
      'ARCHIVE_PATH="enterprise-upload/${{ steps.package.outputs.archive_name }}"',
    );
    expect(workflow).toContain(
      'upload_file "checksum-${PACKAGE_ID}" "${ARCHIVE_PATH}.sha256"',
    );
    expect(workflow).toContain(
      'upload_file "signature-${PACKAGE_ID}" "${ARCHIVE_PATH}.sig"',
    );
    expect(workflow).not.toContain('enterprise-upload/*');
    expect(workflow).not.toMatch(/^\s*scp\s/gm);
  });

  it('matches the exact preinstalled root trust boundary before upload', () => {
    expect(workflow).toContain('protocol=otto-enterprise-ci-deploy-v4');
    expect(workflow).toContain(
      'deploy_user=${DEPLOY_USER} rollback_user=${ROLLBACK_DEPLOY_USER}',
    );
    expect(workflow).toContain('EXPECTED_PREFLIGHT');
    expect(workflow).toContain('ACTUAL_PREFLIGHT');
    expect(workflow).toContain(
      'OTTO_ENTERPRISE_SIGNING_PUBLIC_KEY: ${{ secrets.OTTO_ENTERPRISE_SIGNING_PUBLIC_KEY }}',
    );
  });

  it('delegates all privileged work to the root-owned passwordless gateway', () => {
    expect(workflow).toContain(
      '/usr/bin/sudo -n -- /usr/local/sbin/otto-enterprise-ci-deploy',
    );
    expect(workflow).toContain('deploy "$DEPLOY_TRANSACTION_ID"');
    expect(workflow).not.toContain('sudo -S');
    expect(workflow).not.toContain('sudo -k');
    expect(workflow).not.toContain('backup-now.sh');
    expect(workflow).not.toContain('upgrade.sh');
    expect(workflow).not.toContain('install.sh');
  });

  it('verifies public compatibility without depending on private build identity', () => {
    expect(workflow).toContain('name: Verify public enterprise identity');
    expect(workflow).toContain('.status == "ok"');
    expect(workflow).toContain('and .version == $version');
    expect(workflow).toContain('and .apiVersion == 4');
    expect(workflow).not.toContain('startswith($build_prefix)');
    expect(workflow).not.toMatch(/enterprise\/health[\s\S]*?buildCommit/);
    expect(workflow).toContain(
      'Deployment transport returned ${DEPLOY_STATUS}; reconciling the exact signed server identity.',
    );
    expect(workflow).toContain('verify-deployment');
    expect(workflow).toContain(
      'ENTERPRISE_PUBLIC_URL: ${{ secrets.OTTO_ENTERPRISE_PUBLIC_URL }}',
    );
    expect(workflow).toContain("curl --noproxy '*' --proto '=https' --tlsv1.2");
    expect(workflow).toContain('--max-redirs 0');
    expect(workflow).toContain('--retry 5 --retry-all-errors');
    expect(workflow).toContain(
      '(keys | sort) == ["apiVersion","appVersion","capabilities","service","status","version"]',
    );
    expect(workflow).toContain(
      '${PUBLIC_ORIGIN}/enterprise/legal?release_run=',
    );
    expect(workflow).toContain('def legal_documents:');
    expect(workflow).toContain('/enterprise/local-agent/pair');
    expect(workflow).toContain('/enterprise/sdk/otto-discovery.js');
    expect(workflow).toContain('if [ "$BLOCKED_STATUS" != \'404\' ]');
    expect(workflow).not.toContain('http://127.0.0.1:7778/enterprise/health');
    expect(workflow).toContain('name: Remove runner SSH material');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('rm -f -- ~/.ssh/id_deploy ~/.ssh/known_hosts');
  });
});
