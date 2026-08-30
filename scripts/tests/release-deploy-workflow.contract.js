import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const readRepoFile = (...segments) =>
  readFileSync(path.join(repoRoot, ...segments), 'utf8');

const deployWorkflow = readRepoFile(
  '.github',
  'workflows',
  'deploy-server.yml',
);
const releaseWorkflow = readRepoFile('.github', 'workflows', 'release.yml');
const sqlCipherWorkflow = readRepoFile(
  '.github',
  'workflows',
  'sqlcipher-native.yml',
);
const gatewayScript = readRepoFile(
  'deployment',
  'enterprise-oneclick',
  'ci-deploy-gateway.sh',
);
const gatewayInstaller = readRepoFile(
  'deployment',
  'enterprise-oneclick',
  'install-ci-deploy-gateway.sh',
);
const publishMirrorScript = readRepoFile(
  'deployment',
  'enterprise-oneclick',
  'ci',
  'publish-update-mirror.sh',
);
const rollbackMirrorScript = readRepoFile(
  'deployment',
  'enterprise-oneclick',
  'ci',
  'rollback-update-mirror.sh',
);
const releaseVisibilityCompensation = readRepoFile(
  'scripts',
  'release-visibility-compensation.mjs',
);
const releaseDraftCreationRecovery = readRepoFile(
  'scripts',
  'release-draft-creation-recovery.mjs',
);
const anonymousReleaseVerifier = readRepoFile(
  'scripts',
  'verify-anonymous-github-release-assets.mjs',
);

const gatewayInvocation =
  '/usr/bin/sudo -n -- /usr/local/sbin/otto-enterprise-ci-deploy';

function occurrences(source, value) {
  return source.split(value).length - 1;
}

function expectEverySshTransportHardened(workflow) {
  const lines = workflow.split(/\r?\n/);
  const transports = [];

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trimStart();
    if (trimmed === 'SSH_OPTIONS=(') {
      const optionsEnd = lines.findIndex(
        (line, candidateIndex) => candidateIndex > index && line.trim() === ')',
      );
      expect(optionsEnd).toBeGreaterThan(index);
      const options = lines.slice(index, optionsEnd + 1).join('\n');
      expect(options).toContain('-o BatchMode=yes');
      expect(options).toContain('-o StrictHostKeyChecking=yes');
      expect(options).toContain('-o IdentitiesOnly=yes');
      expect(options).toContain('-o ConnectTimeout=15');
      expect(options).toContain('-o ServerAliveInterval=15');
      expect(options).toContain('-o ServerAliveCountMax=3');
    }

    if (!/^(?:ssh|scp)\s/.test(trimmed)) continue;
    transports.push(trimmed);
    if (trimmed.startsWith('ssh "${SSH_OPTIONS[@]}"')) continue;
    const command = lines.slice(index, index + 6).join('\n');
    expect(command).toContain('-o BatchMode=yes');
    expect(command).toContain('-o StrictHostKeyChecking=yes');
    expect(command).toContain('-o IdentitiesOnly=yes');
    expect(command).toContain('-o ConnectTimeout=15');
    expect(command).toContain('-o ServerAliveInterval=15');
    expect(command).toContain('-o ServerAliveCountMax=3');
  }

  expect(transports.length).toBeGreaterThan(0);
}

function expectEveryExternalActionPinned(workflow) {
  const actionReferences = workflow
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*uses:\s+([^\s#]+)/)?.[1])
    .filter(Boolean)
    .filter((reference) => !reference.startsWith('./'));

  expect(actionReferences.length).toBeGreaterThan(0);
  for (const reference of actionReferences) {
    expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
  }
}

describe('release workflow production privilege boundary', () => {
  it('pins Node and npm inside every early release job that executes them', () => {
    const validateSourceJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf('  validate-source:'),
      releaseWorkflow.indexOf('  linux-enterprise-deployment-integration:'),
    );
    const ottoNativeJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf('  otto-native:'),
      releaseWorkflow.indexOf('  build:'),
    );
    const verifyWindowsJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf('  verify-windows-signature:'),
      releaseWorkflow.indexOf('  create-release-drafts:'),
    );
    for (const job of [validateSourceJob, ottoNativeJob, verifyWindowsJob]) {
      expect(job).toContain(
        'uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      );
      expect(job).toContain('test "$(node --version)" = "v${NODE_VERSION}"');
    }
    expect(verifyWindowsJob).toContain(
      'test "$(npm --version)" = "$NPM_VERSION"',
    );
    expect(verifyWindowsJob.indexOf('test "$(npm --version)"')).toBeLessThan(
      verifyWindowsJob.indexOf('npm ci --ignore-scripts'),
    );
  });

  it('gates every secret-bearing or production-mutating job behind the protected environment', () => {
    expect(
      releaseWorkflow.match(/^\s{4}environment: production-approval$/gm),
    ).toHaveLength(1);
    expect(
      releaseWorkflow.match(/^\s{4}environment: production-automation$/gm),
    ).toHaveLength(11);
    expect(deployWorkflow).toContain('    environment: production-automation');
  });

  it('queues every production workflow without replacing an older pending run', () => {
    for (const workflow of [releaseWorkflow, deployWorkflow]) {
      expect(workflow).toContain('  queue: max');
      expect(workflow).toContain('  cancel-in-progress: false');
    }
  });

  it('does not start the standalone production mutation job after cancellation', () => {
    const deployJobStart = deployWorkflow.indexOf('  deploy:');
    expect(deployJobStart).toBeGreaterThan(-1);
    const deployJob = deployWorkflow.slice(deployJobStart);
    expect(deployJob).toContain('always()');
    expect(deployJob).toContain('&& !cancelled()');
  });

  it('pins every third-party action in the production workflows to a full commit', () => {
    for (const workflow of [
      releaseWorkflow,
      deployWorkflow,
      sqlCipherWorkflow,
    ]) {
      expectEveryExternalActionPinned(workflow);
    }
  });

  it('locks the JavaScript runtime used by release, deployment and mirror verification', () => {
    expect(releaseWorkflow).toContain("NODE_VERSION: '22.23.1'");
    expect(releaseWorkflow).toContain("NPM_VERSION: '10.9.8'");
    expect(releaseWorkflow).toContain(
      'test "$(node --version)" = "v${NODE_VERSION}"',
    );
    expect(releaseWorkflow).toContain(
      'test "$(npm --version)" = "$NPM_VERSION"',
    );
    expect(deployWorkflow).toContain("NODE_VERSION: '22.23.1'");
    expect(deployWorkflow).toContain(
      'test "$(node --version)" = "v${NODE_VERSION}"',
    );
  });

  it('bounds every SQLCipher native build and matrix verification job', () => {
    const sqlCipherBuildJob = sqlCipherWorkflow.slice(
      sqlCipherWorkflow.indexOf('  build:'),
      sqlCipherWorkflow.indexOf('  verify-matrix:'),
    );
    const sqlCipherVerifyMatrixJob = sqlCipherWorkflow.slice(
      sqlCipherWorkflow.indexOf('  verify-matrix:'),
      sqlCipherWorkflow.indexOf('  verify-node-matrix:'),
    );
    const sqlCipherVerifyNodeJob = sqlCipherWorkflow.slice(
      sqlCipherWorkflow.indexOf('  verify-node-matrix:'),
    );
    expect(sqlCipherWorkflow).toContain('NODE_VERSION: 22.23.1');
    expect(sqlCipherWorkflow).toContain('NPM_VERSION: 10.9.8');
    expect(sqlCipherWorkflow).not.toContain('node-version: 24');
    expect(occurrences(sqlCipherBuildJob, 'actions/setup-node@')).toBe(2);
    expect(
      occurrences(
        sqlCipherBuildJob,
        'test "$(node --version)" = "v${NODE_VERSION}"',
      ),
    ).toBe(2);
    expect(
      occurrences(
        sqlCipherBuildJob,
        'test "$(npm --version)" = "$NPM_VERSION"',
      ),
    ).toBe(2);
    for (const job of [sqlCipherVerifyMatrixJob, sqlCipherVerifyNodeJob]) {
      expect(job).toContain('node-version: ${{ env.NODE_VERSION }}');
      expect(job).toContain('test "$(node --version)" = "v${NODE_VERSION}"');
      expect(job).toContain('test "$(npm --version)" = "$NPM_VERSION"');
    }
    expect(sqlCipherWorkflow).toMatch(
      /build:[\s\S]*?timeout-minutes: 90[\s\S]*?strategy:/,
    );
    expect(sqlCipherWorkflow).toMatch(
      /verify-matrix:[\s\S]*?timeout-minutes: 30[\s\S]*?steps:/,
    );
    expect(sqlCipherWorkflow).toMatch(
      /verify-node-matrix:[\s\S]*?timeout-minutes: 30[\s\S]*?steps:/,
    );
  });

  it('runs the root deployment transaction integration in a pinned offline Linux container', () => {
    expect(releaseWorkflow).toContain(
      'linux-enterprise-deployment-integration:',
    );
    expect(releaseWorkflow).toContain(
      'python@sha256:0f5b26b9518d002b6173fd61daad821fa340635ebfec5bba471013f9ca114579',
    );
    expect(releaseWorkflow).toContain('--network none');
    expect(releaseWorkflow).toContain(
      '/workspace/scripts/tests/enterprise-ci-linux-integration.sh',
    );
    expect(releaseWorkflow).toMatch(
      /build:[\s\S]*?needs:[\s\S]*?- linux-enterprise-deployment-integration[\s\S]*?- sqlcipher-native/,
    );
  });

  it('never transports a sudo password and exposes only the fixed root gateway', () => {
    for (const workflow of [deployWorkflow, releaseWorkflow]) {
      expect(workflow).not.toContain('DEPLOY_SUDO_PASSWORD');
      expect(workflow).not.toMatch(/sudo\s+(?:-[^\s]+\s+)*-S(?:\s|$)/);
      expect(workflow).not.toContain('sudo -k');
      expect(workflow).not.toContain('/bin/bash');
      for (const line of workflow
        .split(/\r?\n/)
        .filter((candidate) => /\bsudo\b/.test(candidate))) {
        expect(line).toContain(gatewayInvocation);
      }
    }

    expect(
      occurrences(deployWorkflow, gatewayInvocation),
    ).toBeGreaterThanOrEqual(1);
    expect(
      occurrences(releaseWorkflow, gatewayInvocation),
    ).toBeGreaterThanOrEqual(2);
    expect(deployWorkflow).toContain('deploy "$DEPLOY_TRANSACTION_ID"');
    expect(releaseWorkflow).toContain(
      'publish-mirror "$MIRROR_TRANSACTION_ID" \\\n            "${{ needs.build.outputs.version }}" \\\n            "${{ needs.build.outputs.package_identity }}" \\\n            "${{ needs.build.outputs.source_commit }}"',
    );
    expect(releaseWorkflow).toContain(
      'rollback-mirror "$MIRROR_TRANSACTION_ID"',
    );
  });

  it('reuses the deployment workflow with the immutable package identity', () => {
    expect(deployWorkflow).toContain('  workflow_call:');
    expect(deployWorkflow).toMatch(
      /workflow_call:[\s\S]*?package_identity:[\s\S]*?source_commit:[\s\S]*?required: true[\s\S]*?use_workflow_artifact:[\s\S]*?type: boolean/,
    );

    const deployJobStart = releaseWorkflow.indexOf('  deploy-enterprise:');
    const mirrorJobStart = releaseWorkflow.indexOf('  deploy-update-mirror:');
    expect(deployJobStart).toBeGreaterThan(-1);
    expect(mirrorJobStart).toBeGreaterThan(deployJobStart);
    const deployJob = releaseWorkflow.slice(deployJobStart, mirrorJobStart);
    expect(deployJob).toContain('uses: ./.github/workflows/deploy-server.yml');
    expect(deployJob).toContain(
      'package_identity: ${{ needs.build.outputs.package_identity }}',
    );
    expect(deployJob).toContain(
      'source_commit: ${{ needs.build.outputs.source_commit }}',
    );
    expect(deployJob).toContain('use_workflow_artifact: true');
    expect(deployJob).not.toContain('secrets: inherit');
    expect(deployJob).not.toContain('    secrets:');
    expect(deployWorkflow).not.toMatch(/workflow_call:[\s\S]*?\n\s{4}secrets:/);
    expect(deployJob).not.toContain('runs-on:');
    expect(deployJob).not.toContain('upgrade.sh');
    expect(deployJob).not.toContain('install.sh');
  });

  it('hardens every SSH path against prompts, host substitution and extra identities', () => {
    for (const workflow of [deployWorkflow, releaseWorkflow]) {
      expectEverySshTransportHardened(workflow);
      expect(workflow).not.toContain('StrictHostKeyChecking=no');
      expect(workflow).not.toContain('ssh-keyscan');
    }
  });

  it('revalidates the latest internal source before irreversible deployment', () => {
    expect(releaseWorkflow).toContain(
      'Revalidate exact latest internal source before creating drafts',
    );
    expect(deployWorkflow).toContain(
      'Revalidate exact latest internal source before deployment',
    );
    expect(deployWorkflow).toContain(
      'origin/internal changed immediately before deployment; refusing the old candidate.',
    );
    expect(releaseWorkflow).not.toContain(
      'Revalidate exact latest internal source before publication',
    );
  });

  it('fails closed unless both release repositories support draft rollback', () => {
    expect(occurrences(releaseWorkflow, "'/actions/permissions'")).toBe(3);
    expect(occurrences(releaseWorkflow, "'/immutable-releases'")).toBe(3);
    expect(releaseWorkflow).toContain(
      'secrets.OTTO_CANONICAL_ADMIN_READ_TOKEN',
    );
    expect(releaseWorkflow).toContain('secrets.OTTO_LEGACY_ADMIN_READ_TOKEN');
    expect(releaseWorkflow).toContain('X-GitHub-Api-Version: 2026-03-10');
    expect(releaseWorkflow).toContain(
      'Could not prove immutable releases are disabled',
    );
  });

  it('requires the exact installed gateway, helpers and signing trust anchor', () => {
    for (const workflow of [deployWorkflow, releaseWorkflow]) {
      expect(workflow).toContain('protocol=otto-enterprise-ci-deploy-v5');
      expect(workflow).toContain('config=/etc/otto-enterprise/enterprise.env');
      expect(workflow).toContain(
        'sha256sum deployment/enterprise-oneclick/ci-deploy-gateway.sh',
      );
      expect(workflow).toContain(
        'sha256sum deployment/enterprise-oneclick/ci/publish-update-mirror.sh',
      );
      expect(workflow).toContain(
        'sha256sum deployment/enterprise-oneclick/ci/rollback-update-mirror.sh',
      );
      expect(workflow).toContain('ACTUAL_PREFLIGHT');
      expect(workflow).toContain('EXPECTED_PREFLIGHT');
    }
  });

  it('signs the exact update-mirror manifest and verifies it again after root staging', () => {
    expect(releaseWorkflow).toContain(
      'MIRROR_CHECKSUMS="$DESKTOP_RELEASE/UPDATE-MIRROR-SHA256SUMS"',
    );
    expect(releaseWorkflow).toContain(
      'node scripts/release-payload-signature.mjs sign',
    );
    expect(releaseWorkflow).toContain(
      'node scripts/update-mirror-manifest.mjs create',
    );
    expect(releaseWorkflow).toContain(
      'node scripts/release-payload-signature.mjs verify',
    );
    expect(releaseWorkflow).toContain(
      'mirror-upload/UPDATE-MIRROR-SHA256SUMS.sig',
    );
    expect(gatewayScript).toContain("'UPDATE-MIRROR-SHA256SUMS'");
    expect(gatewayScript).toContain("'UPDATE-MIRROR-SHA256SUMS.sig'");

    const rootCopy = gatewayScript.indexOf(
      '"${MIRROR_UPLOAD_DIR}/${name}" "${MIRROR_STAGING_DIR}/${name}"',
    );
    const signatureVerification = gatewayScript.indexOf(
      '"${MIRROR_STAGING_DIR}/UPDATE-MIRROR-SHA256SUMS"',
      rootCopy,
    );
    const trustedPublisher = gatewayScript.indexOf(
      '"$PUBLISH_HELPER_PATH"',
      signatureVerification,
    );
    const boundManifestVerification = gatewayScript.indexOf(
      'verify_update_mirror_manifest \\',
      signatureVerification,
    );
    expect(rootCopy).toBeGreaterThan(-1);
    expect(signatureVerification).toBeGreaterThan(rootCopy);
    expect(boundManifestVerification).toBeGreaterThan(signatureVerification);
    expect(trustedPublisher).toBeGreaterThan(boundManifestVerification);
    expect(gatewayScript).toContain(
      "manifest['packageIdentity'] != expected_package_identity",
    );
    expect(gatewayScript).toContain(
      "manifest['sourceCommit'] != expected_source_commit",
    );
    expect(gatewayScript).toContain(
      'root-staged mirror payload does not contain the exact signed file set',
    );
    expect(publishMirrorScript).toContain(
      "'format', 'version', 'packageIdentity', 'sourceCommit', 'assets'",
    );
    expect(publishMirrorScript).not.toContain(
      'sha256sum -c -- UPDATE-MIRROR-SHA256SUMS',
    );
  });

  it('binds mirror publication, rollback and release visibility to one exact transaction', () => {
    const principalValidationStart = releaseWorkflow.indexOf(
      '  validate-deployment-principals:',
    );
    const deployEnterpriseStart = releaseWorkflow.indexOf(
      '  deploy-enterprise:',
    );
    const mirrorStart = releaseWorkflow.indexOf('  deploy-update-mirror:');
    const canonicalStart = releaseWorkflow.indexOf('  publish-canonical:');
    const legacyStart = releaseWorkflow.indexOf('  publish-legacy:');
    const finalizeEnterpriseStart = releaseWorkflow.indexOf(
      '  finalize-enterprise-release-transaction:',
    );
    const rollbackMirrorStart = releaseWorkflow.indexOf(
      '  rollback-update-mirror:',
    );
    const rollbackReleaseStart = releaseWorkflow.indexOf(
      '  rollback-release-publication:',
    );
    const rollbackEnterpriseStart = releaseWorkflow.indexOf(
      '  rollback-enterprise-release-transaction:',
    );
    const mirrorJob = releaseWorkflow.slice(mirrorStart, canonicalStart);
    const principalValidationJob = releaseWorkflow.slice(
      principalValidationStart,
      deployEnterpriseStart,
    );
    const deployPrincipalValidationStart = deployWorkflow.indexOf(
      '  validate-deployment-principals:',
    );
    const deployJobStart = deployWorkflow.indexOf('  deploy:');
    const deployPrincipalValidationJob = deployWorkflow.slice(
      deployPrincipalValidationStart,
      deployJobStart,
    );
    const deployEnterpriseJob = releaseWorkflow.slice(
      deployEnterpriseStart,
      mirrorStart,
    );
    const canonicalJob = releaseWorkflow.slice(canonicalStart, legacyStart);
    const legacyJob = releaseWorkflow.slice(
      legacyStart,
      finalizeEnterpriseStart,
    );
    const finalizeEnterpriseJob = releaseWorkflow.slice(
      finalizeEnterpriseStart,
      rollbackMirrorStart,
    );
    const publishJob = releaseWorkflow.slice(
      canonicalStart,
      finalizeEnterpriseStart,
    );
    expect(publishJob).toContain('always()');
    expect(publishJob).toContain('&& !cancelled()');
    expect(publishJob).toContain('- validate-deployment-principals');
    expect(publishJob).toContain(
      'uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    );
    expect(publishJob).toContain(
      'run: test "$(node --version)" = "v${NODE_VERSION}"',
    );
    expect(publishJob.indexOf('actions/setup-node@')).toBeLessThan(
      publishJob.indexOf('node scripts/update-mirror-manifest.mjs verify'),
    );
    const rollbackMirrorJob = releaseWorkflow.slice(
      rollbackMirrorStart,
      rollbackReleaseStart,
    );
    const rollbackReleaseJob = releaseWorkflow.slice(
      rollbackReleaseStart,
      rollbackEnterpriseStart,
    );
    const rollbackEnterpriseJob = releaseWorkflow.slice(
      rollbackEnterpriseStart,
    );
    const gatewayPublishStart = gatewayScript.indexOf(
      'if [ "$COMMAND" = \'publish-mirror\' ]; then',
    );
    const gatewayRollbackStart = gatewayScript.indexOf(
      'if [ "$COMMAND" = \'rollback-mirror\' ]; then',
    );
    const gatewayPublish = gatewayScript.slice(
      gatewayPublishStart,
      gatewayRollbackStart,
    );

    expect(principalValidationStart).toBeGreaterThan(-1);
    expect(deployEnterpriseStart).toBeGreaterThan(principalValidationStart);
    expect(deployPrincipalValidationStart).toBeGreaterThan(-1);
    expect(deployJobStart).toBeGreaterThan(deployPrincipalValidationStart);
    expect(principalValidationJob).not.toContain('actions/checkout@');
    expect(principalValidationJob).toContain('DEPLOY_SSH_KEY:');
    expect(principalValidationJob).toContain('ROLLBACK_DEPLOY_SSH_KEY:');
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
    const principalStepMarker =
      '      - name: Prove distinct keys and server-side account isolation';
    expect(
      deployPrincipalValidationJob
        .slice(deployPrincipalValidationJob.indexOf(principalStepMarker))
        .trim(),
    ).toBe(
      principalValidationJob
        .slice(principalValidationJob.indexOf(principalStepMarker))
        .trim(),
    );
    const rollbackPreflight = principalValidationJob.indexOf(
      'preflight_principal "$PRINCIPAL_AUDIT_DIR/rollback" "$ROLLBACK_DEPLOY_USER"',
    );
    expect(rollbackPreflight).toBeGreaterThan(-1);
    expect(
      principalValidationJob.indexOf(
        'reject_cross_login "$PRINCIPAL_AUDIT_DIR/deploy" "$ROLLBACK_DEPLOY_USER"',
      ),
    ).toBeGreaterThan(rollbackPreflight);
    expect(principalValidationJob).toContain(
      'reject_cross_login "$PRINCIPAL_AUDIT_DIR/deploy" "$ROLLBACK_DEPLOY_USER"',
    );
    expect(principalValidationJob).toContain(
      'reject_cross_login "$PRINCIPAL_AUDIT_DIR/rollback" "$DEPLOY_USER"',
    );
    expect(deployEnterpriseJob).toContain('- validate-deployment-principals');
    expect(mirrorStart).toBeGreaterThan(-1);
    expect(canonicalStart).toBeGreaterThan(mirrorStart);
    expect(legacyStart).toBeGreaterThan(canonicalStart);
    expect(finalizeEnterpriseStart).toBeGreaterThan(legacyStart);
    expect(rollbackMirrorStart).toBeGreaterThan(finalizeEnterpriseStart);
    expect(rollbackReleaseStart).toBeGreaterThan(rollbackMirrorStart);
    expect(mirrorJob).toContain(
      'publish-mirror "$MIRROR_TRANSACTION_ID" \\\n            "${{ needs.build.outputs.version }}" \\\n            "${{ needs.build.outputs.package_identity }}" \\\n            "${{ needs.build.outputs.source_commit }}"',
    );
    expect(mirrorJob).toContain(
      'DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}',
    );
    expect(mirrorJob).not.toContain('ROLLBACK_DEPLOY_SSH_KEY:');
    const deployServerJob = deployWorkflow.slice(
      deployWorkflow.indexOf('  deploy:'),
      deployWorkflow.indexOf('  finalize-enterprise-deployment:'),
    );
    expect(deployServerJob).toContain(
      'DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}',
    );
    expect(deployServerJob).not.toContain('ROLLBACK_DEPLOY_SSH_KEY:');
    expect(deployServerJob).toContain(
      'ssh-keygen -y -P \'\' -f "$KEY_AUDIT_DIR/deploy"',
    );
    expect(deployServerJob).not.toContain('ROLLBACK_KEY_FINGERPRINT');
    expect(canonicalJob).toContain('- deploy-enterprise');
    expect(canonicalJob).not.toContain('- deploy-update-mirror');
    expect(mirrorJob).toContain('- publish-canonical');
    expect(legacyJob).toContain('- publish-canonical');
    expect(legacyJob).toContain('- deploy-update-mirror');
    expect(deployEnterpriseJob).toContain('defer_finalize: true');
    expect(finalizeEnterpriseJob).toContain('- publish-legacy');
    expect(finalizeEnterpriseJob).toContain('finalize-deployment');
    expect(finalizeEnterpriseJob).toContain('DEPLOY_SSH_KEY:');
    expect(finalizeEnterpriseJob).not.toContain('ROLLBACK_DEPLOY_SSH_KEY:');
    expect(finalizeEnterpriseJob).toContain('for attempt in 1 2 3 4 5 6; do');
    expect(rollbackEnterpriseJob).toContain(
      "needs.rollback-release-publication.result == 'success'",
    );
    expect(rollbackEnterpriseJob).toContain(
      "needs.rollback-update-mirror.result == 'success'",
    );
    expect(rollbackEnterpriseJob).toContain('rollback-enterprise');
    expect(rollbackEnterpriseJob).toContain('ROLLBACK_DEPLOY_SSH_KEY:');
    expect(rollbackEnterpriseJob).not.toMatch(/^\s+DEPLOY_SSH_KEY:/m);
    expect(gatewayPublish).toContain(
      '[ "$#" -eq 5 ] || fail \'usage: publish-mirror TRANSACTION VERSION PACKAGE_ID SOURCE_COMMIT\'',
    );
    const deployedIdentityCheck = gatewayPublish.indexOf(
      'verify_current_deployment \\\n    "$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"',
    );
    expect(deployedIdentityCheck).toBeGreaterThan(-1);
    expect(
      gatewayPublish.indexOf('"$PUBLISH_HELPER_PATH" "$TRANSACTION_ID"'),
    ).toBeGreaterThan(deployedIdentityCheck);

    const publicReleaseCheck = mirrorJob.indexOf(
      'verify_public_release "$RELEASES_REPO" "$CANONICAL_TOKEN" "$SOURCE_COMMIT"',
    );
    expect(publicReleaseCheck).toBeGreaterThan(-1);
    expect(mirrorJob).toContain('"repos/${repository}/releases/latest"');
    expect(mirrorJob).toContain('.id == $id and .tag_name == $tag');
    expect(mirrorJob).toContain('for attempt in 1 2 3 4 5 6; do');
    expect(
      mirrorJob.indexOf('publish-mirror "$MIRROR_TRANSACTION_ID"'),
    ).toBeGreaterThan(publicReleaseCheck);
    expect(
      mirrorJob.indexOf('publish-mirror "$MIRROR_TRANSACTION_ID"'),
    ).toBeGreaterThan(
      mirrorJob.indexOf('"repos/${repository}/releases/latest"'),
    );
    expect(publishJob).toContain('"repos/${repository}/releases/latest"');
    expect(publishJob).toContain('.id == $id and .tag_name == $tag');
    expect(publishJob).toContain('for attempt in 1 2 3 4 5 6; do');
    expect(rollbackMirrorJob).toContain('mapfile -t RESTORED_LINES < <(');
    expect(rollbackMirrorJob).toContain(
      "grep -E '^restored_manifest_sha256=([0-9a-f]{64}|absent)$'",
    );
    expect(rollbackMirrorJob).toContain(
      'for rollback_attempt in 1 2 3 4 5 6; do',
    );
    expect(rollbackMirrorJob).toContain(
      'if ROLLBACK_OUTPUT="$(ssh "${SSH_OPTIONS[@]}"',
    );
    expect(rollbackMirrorJob).toContain(
      'if [ "$ROLLBACK_STATUS" -ne 255 ]; then',
    );
    expect(rollbackMirrorJob).toContain('retrying the idempotent transaction.');
    expect(rollbackMirrorJob).toContain(
      'if [ "${#RESTORED_LINES[@]}" -gt 1 ]; then',
    );
    expect(rollbackMirrorJob).toContain('if [ -z "$RESTORED_SHA256" ]; then');
    expect(rollbackMirrorJob).toContain(
      'Public update mirror did not converge to the exact restored manifest; keeping Releases public.',
    );
    expect(rollbackMirrorJob).toContain('if HTTP_STATUS="$(curl --noproxy');
    expect(rollbackMirrorJob).toContain(
      'Public mirror verification transport failed on attempt ${retry}; retrying.',
    );
    expect(rollbackMirrorJob).toContain('ROLLBACK_DEPLOY_SSH_KEY:');
    expect(rollbackMirrorJob).toContain(
      '${ROLLBACK_DEPLOY_USER}@${DEPLOY_HOST}',
    );
    expect(rollbackMirrorJob).toContain('~/.ssh/id_rollback');
    expect(rollbackMirrorJob).not.toContain(
      'DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}',
    );
    expect(rollbackMirrorJob).not.toContain('${DEPLOY_USER}@${DEPLOY_HOST}');
    expect(rollbackMirrorJob).not.toContain('~/.ssh/id_deploy');
    expect(rollbackReleaseJob).toContain(
      "needs.rollback-update-mirror.result == 'success'",
    );
    const compensationPreflight = rollbackReleaseJob.indexOf(
      'name: Reconfirm mutable release settings before compensation',
    );
    const compensationMutation = rollbackReleaseJob.indexOf(
      'name: Transactionally restore exact previous latest pointers',
    );
    expect(compensationPreflight).toBeGreaterThan(-1);
    expect(compensationMutation).toBeGreaterThan(compensationPreflight);
    expect(rollbackReleaseJob).toContain(
      'secrets.OTTO_CANONICAL_ADMIN_READ_TOKEN',
    );
    expect(rollbackReleaseJob).toContain(
      'secrets.OTTO_LEGACY_ADMIN_READ_TOKEN',
    );
    expect(rollbackReleaseJob).not.toContain('PUBLISH_SUCCEEDED:');
    expect(rollbackReleaseJob).toContain(
      'ref: ${{ needs.build.outputs.source_commit }}',
    );
    expect(rollbackReleaseJob).toContain(
      'node scripts/release-visibility-compensation.mjs \\',
    );
    expect(rollbackReleaseJob).toContain(
      'name: Download immutable release artifact for compensation identity',
    );
    expect(rollbackReleaseJob).toContain(
      'name: Download immutable release creation intent',
    );
    expect(rollbackReleaseJob).toContain(
      'name: otto-release-creation-intent-${{ needs.build.outputs.tag }}',
    );
    expect(rollbackReleaseJob).toContain(
      'name: otto-release-v${{ needs.build.outputs.version }}',
    );
    expect(rollbackReleaseJob).toContain('--artifact-dir release-download');
    expect(rollbackReleaseJob).toContain(
      '--package-identity "${{ needs.build.outputs.package_identity }}"',
    );
    expect(rollbackReleaseJob).toContain('--expected-prerelease');
    expect(rollbackReleaseJob).toContain(
      '--pre-public-latest-snapshot release-state/pre-public-latest.json',
    );
    expect(rollbackReleaseJob).toContain(
      '--pre-public-latest-sha256 "${{ needs.create-release-drafts.outputs.pre_public_latest_sha256 }}"',
    );
    expect(
      rollbackReleaseJob.indexOf('require_mutable_releases "$RELEASES_REPO"'),
    ).toBeLessThan(
      rollbackReleaseJob.indexOf(
        'node scripts/release-visibility-compensation.mjs',
      ),
    );
    expect(rollbackReleaseJob).toContain("curl --noproxy '*' --proto '=https'");
    expect(rollbackReleaseJob).toContain('--max-redirs 0');
    expect(releaseVisibilityCompensation).toContain(
      'const snapshots = await observeBoth(adapter, endpoints);',
    );
    expect(releaseVisibilityCompensation).toContain(
      'canonical.canonicalTagCommit !== expected.canonicalTagCommit',
    );
    expect(releaseVisibilityCompensation).toContain(
      'JSON.stringify(actual.assets) !== JSON.stringify(snapshot.assets)',
    );
    expect(releaseVisibilityCompensation).toContain(
      'snapshots[key].visibility',
    );
    expect(releaseVisibilityCompensation).toContain(
      'Restore both endpoints unconditionally',
    );
    expect(releaseVisibilityCompensation).toContain(
      'draft: snapshots.canonical.visibility.draft',
    );
    expect(releaseVisibilityCompensation).toContain(
      'draft: snapshots.legacy.visibility.draft',
    );
    expect(releaseVisibilityCompensation).not.toContain('draft: true');

    const prepareCreationStart = releaseWorkflow.indexOf(
      '  prepare-release-creation-intent:',
    );
    const createDraftsStart = releaseWorkflow.indexOf(
      '  create-release-drafts:',
    );
    const cleanupDraftsStart = releaseWorkflow.indexOf(
      '  cleanup-partial-release-drafts:',
    );
    const prepareCreationJob = releaseWorkflow.slice(
      prepareCreationStart,
      createDraftsStart,
    );
    const createDraftsJob = releaseWorkflow.slice(
      createDraftsStart,
      cleanupDraftsStart,
    );
    const cleanupDraftsJob = releaseWorkflow.slice(
      cleanupDraftsStart,
      principalValidationStart,
    );
    expect(prepareCreationStart).toBeGreaterThan(-1);
    expect(prepareCreationJob).toContain(
      'name: Capture exact release creation intent and pre-public latest',
    );
    expect(prepareCreationJob).toContain(
      'node scripts/release-draft-creation-recovery.mjs \\',
    );
    expect(prepareCreationJob).toContain('capture \\');
    expect(prepareCreationJob).toContain('--run-id "$GITHUB_RUN_ID"');
    expect(prepareCreationJob).toContain(
      '--canonical-tag-preexisting "$CANONICAL_TAG_PREEXISTING"',
    );
    expect(prepareCreationJob).toContain(
      'name: Upload immutable release creation intent before first mutation',
    );
    expect(prepareCreationJob).toContain(
      'name: otto-release-creation-intent-${{ needs.build.outputs.tag }}',
    );
    expect(prepareCreationJob).toContain('path: release-state');
    expect(createDraftsJob).toContain('- prepare-release-creation-intent');
    expect(createDraftsJob).toContain(
      'name: Download immutable release creation intent',
    );
    expect(createDraftsJob).toContain('verify-before-create \\');
    expect(createDraftsJob.indexOf('verify-before-create \\')).toBeLessThan(
      createDraftsJob.indexOf(
        'name: Create canonical and compatibility drafts with GitHub CLI',
      ),
    );
    expect(cleanupDraftsJob).toContain('always()');
    expect(cleanupDraftsJob).toContain(
      "needs.create-release-drafts.result == 'failure'",
    );
    expect(cleanupDraftsJob).toContain(
      "needs.create-release-drafts.result == 'cancelled'",
    );
    expect(cleanupDraftsJob).toContain('cleanup \\');
    expect(cleanupDraftsJob).not.toContain('github.run_attempt == 1');
    expect(releaseDraftCreationRecovery).toContain('release.draft !== true');
    expect(releaseDraftCreationRecovery).toContain(
      'assertExpectedAssetSubset(release.assets, intent.expected.assets, key)',
    );
    expect(releaseDraftCreationRecovery).toContain("asset.state === 'starter'");
    expect(releaseDraftCreationRecovery).toContain('asset.size === 0');
    expect(releaseDraftCreationRecovery).toContain(
      'await adapter.deleteAsset(endpoints[key], asset.id)',
    );
    expect(releaseDraftCreationRecovery).toContain(
      '!intent.preexisting[key].tag',
    );
    expect(releaseDraftCreationRecovery).toContain(
      'partial release identity is ambiguous',
    );
    expect(releaseDraftCreationRecovery).not.toContain('draft: false');
    expect(canonicalJob).toContain(
      'PRE_PUBLIC_LATEST_SHA256: ${{ needs.create-release-drafts.outputs.pre_public_latest_sha256 }}',
    );
    expect(canonicalJob).toContain('verify-pre-public-latest');
    expect(canonicalJob.indexOf('verify-pre-public-latest')).toBeLessThan(
      canonicalJob.indexOf(
        'GH_TOKEN="$CANONICAL_TOKEN" gh release edit "$TAG"',
      ),
    );
    expect(
      publishJob.indexOf('GH_TOKEN="$CANONICAL_TOKEN" gh release edit "$TAG"'),
    ).toBeLessThan(
      publishJob.indexOf('GH_TOKEN="$LEGACY_TOKEN" gh release edit "$TAG"'),
    );
  });

  it('proves canonical and legacy update paths remain anonymously downloadable', () => {
    const canonicalStart = releaseWorkflow.indexOf('  publish-canonical:');
    const legacyStart = releaseWorkflow.indexOf('  publish-legacy:');
    const finalizeStart = releaseWorkflow.indexOf(
      '  finalize-enterprise-release-transaction:',
    );
    const canonicalJob = releaseWorkflow.slice(canonicalStart, legacyStart);
    const legacyJob = releaseWorkflow.slice(legacyStart, finalizeStart);
    const canonicalMutation = canonicalJob.indexOf(
      'GH_TOKEN="$CANONICAL_TOKEN" gh release edit "$TAG"',
    );
    const canonicalAnonymousGate = canonicalJob.indexOf(
      '"$RELEASES_REPO" "$RELEASES_REPO" "$TAG" release-assets',
    );
    const legacyMutation = legacyJob.indexOf(
      'GH_TOKEN="$LEGACY_TOKEN" gh release edit "$TAG"',
    );
    const legacyAnonymousGate = legacyJob.indexOf(
      '"$LEGACY_RELEASES_REPO" "$RELEASES_REPO" "$TAG" release-assets',
    );

    expect(releaseWorkflow).toContain(
      'verify-anonymous-github-release-assets.mjs \\\n            --repo-public "$RELEASES_REPO"',
    );
    expect(canonicalMutation).toBeGreaterThan(-1);
    expect(canonicalAnonymousGate).toBeGreaterThan(canonicalMutation);
    expect(legacyMutation).toBeGreaterThan(-1);
    expect(legacyAnonymousGate).toBeGreaterThan(legacyMutation);
    expect(legacyJob).toContain(
      '"$RELEASES_REPO" "$RELEASES_REPO" "$TAG" release-assets',
    );
    expect(anonymousReleaseVerifier).toContain("redirect: 'manual'");
    expect(anonymousReleaseVerifier).toContain("credentials: 'omit'");
    expect(anonymousReleaseVerifier).not.toContain('Authorization');
    expect(anonymousReleaseVerifier).not.toContain('Cookie');
    expect(anonymousReleaseVerifier).toContain(
      "metadata.visibility !== 'public'",
    );
    expect(anonymousReleaseVerifier).toContain(
      "hostname === 'release-assets.githubusercontent.com'",
    );
    expect(anonymousReleaseVerifier).toContain(
      'actualSize !== expectedSize || actualSha256 !== expectedSha256',
    );
    expect(anonymousReleaseVerifier).toContain(
      'if (new Set(assetNames).size !== 6)',
    );
  });

  it('rejects partial production job replay and gives compensation enough time', () => {
    for (const stepName of [
      'Reject replayed production publication attempts',
      'Reject replayed production mirror attempts',
    ]) {
      expect(releaseWorkflow).toContain(`name: ${stepName}`);
    }
    expect(
      occurrences(
        releaseWorkflow,
        'if [ "$GITHUB_RUN_ATTEMPT" != \'1\' ]; then',
      ),
    ).toBe(4);
    expect(deployWorkflow).toContain(
      'name: Reject replayed production workflow attempts',
    );
    expect(deployWorkflow).toContain(
      'if [ "$GITHUB_RUN_ATTEMPT" != \'1\' ]; then',
    );

    const rollbackMirrorStart = releaseWorkflow.indexOf(
      '  rollback-update-mirror:',
    );
    const rollbackReleaseStart = releaseWorkflow.indexOf(
      '  rollback-release-publication:',
    );
    const rollbackMirrorJob = releaseWorkflow.slice(
      rollbackMirrorStart,
      rollbackReleaseStart,
    );
    const rollbackReleaseJob = releaseWorkflow.slice(rollbackReleaseStart);
    for (const compensationJob of [rollbackMirrorJob, rollbackReleaseJob]) {
      expect(compensationJob).toContain('&& github.run_attempt == 1');
      expect(compensationJob).toContain(
        "needs.deploy-update-mirror.result == 'skipped'",
      );
    }
    const deployJobStart = deployWorkflow.indexOf('  deploy:');
    const deployJob = deployWorkflow.slice(deployJobStart);
    expect(deployJobStart).toBeGreaterThan(-1);
    expect(deployJob).toContain('timeout-minutes: 90');
    expect(deployWorkflow.slice(0, deployJobStart)).toContain(
      'timeout-minutes: 30',
    );
    expect(releaseWorkflow).toMatch(
      /deploy-update-mirror:[\s\S]*?timeout-minutes: 90/,
    );
    expect(releaseWorkflow).toMatch(
      /publish-canonical:[\s\S]*?timeout-minutes: 30/,
    );
    expect(releaseWorkflow).toMatch(
      /publish-legacy:[\s\S]*?timeout-minutes: 45/,
    );
    expect(releaseWorkflow).toMatch(
      /rollback-update-mirror:[\s\S]*?timeout-minutes: 45/,
    );
    expect(releaseWorkflow).toMatch(
      /rollback-release-publication:[\s\S]*?timeout-minutes: 40/,
    );
    expect(releaseWorkflow).toContain('--retry-max-time 90');
    expect(releaseVisibilityCompensation).toContain('timeout: 30_000');
    expect(rollbackReleaseJob).not.toContain('EXPECTED_PRERELEASE:');
    expect(releaseVisibilityCompensation).toContain(
      'prerelease: snapshots.canonical.visibility.prerelease',
    );
    expect(releaseVisibilityCompensation).toContain(
      'prerelease: snapshots.legacy.visibility.prerelease',
    );
    expect(releaseVisibilityCompensation).toContain(
      'actual.visibility.draft !== visibility.draft',
    );
  });

  it('verifies the exact public enterprise health identity through HTTPS', () => {
    expect(deployWorkflow).toContain('secrets.OTTO_ENTERPRISE_PUBLIC_URL');
    expect(deployWorkflow).toContain("--proto '=https' --tlsv1.2");
    expect(deployWorkflow).toContain('--max-redirs 0');
    expect(deployWorkflow).not.toContain(
      'http://127.0.0.1:7778/enterprise/health',
    );
    for (const capability of [
      'password_auth',
      'sms_registration',
      'personal_enterprise_upgrade',
      'organization_invites',
      'usage_summary',
      'admin_console',
      'direct_messages',
      'atoa',
      'position_invites',
      'park_service_push',
      'park_repair_v1',
      'data_protection_v1',
      'encrypted_attachment_storage_v1',
      'encrypted_message_storage_v1',
      'signed_telemetry_transport_v1',
      'data_governance_v1',
      'privacy_self_service',
    ]) {
      expect(deployWorkflow).toContain(`"${capability}"`);
    }
    expect(deployWorkflow).toContain('] - .capabilities) | length == 0)');
  });

  it('copies packages into root staging before fixed-key verification and execution', () => {
    expect(gatewayScript).toContain(
      'TRUST_KEY_PATH="/etc/otto-enterprise/enterprise-package-signing-public.pem"',
    );
    expect(gatewayScript).toContain(
      'require_root_owned_regular_file "$TRUST_KEY_PATH"',
    );
    expect(gatewayScript).toContain('mkdir -m 0700 -- "$STAGING_DIR"');
    expect(gatewayScript).toContain(
      '"${UPLOAD_DIR}/${name}" "${STAGING_DIR}/${name}"',
    );
    expect(gatewayScript).toContain(
      'openssl pkeyutl -verify -pubin -inkey "$TRUST_KEY_PATH"',
    );

    const packageCopy = gatewayScript.indexOf(
      '"${UPLOAD_DIR}/${name}" "${STAGING_DIR}/${name}"',
    );
    const packageSignature = gatewayScript.indexOf(
      "'otto-enterprise-package-signature-v1'",
      packageCopy,
    );
    const packageExtraction = gatewayScript.indexOf(
      'tar --no-same-owner --no-same-permissions',
      packageSignature,
    );
    expect(packageCopy).toBeGreaterThan(-1);
    expect(packageSignature).toBeGreaterThan(packageCopy);
    expect(packageExtraction).toBeGreaterThan(packageSignature);
  });

  it('installs only root-owned gateway and libexec targets behind narrow sudoers', () => {
    expect(gatewayInstaller).toContain(
      "GATEWAY_PATH='/usr/local/sbin/otto-enterprise-ci-deploy'",
    );
    expect(gatewayInstaller).toContain(
      "LIBEXEC_DIR='/usr/local/libexec/otto-enterprise-ci'",
    );
    expect(gatewayInstaller).toContain(
      'atomic_install_fixed_file "$GATEWAY_TEMP" "$GATEWAY_PATH" 0755',
    );
    expect(gatewayInstaller).toContain(
      'atomic_install_fixed_file "$PUBLISH_TEMP" "$PUBLISH_PATH" 0755',
    );
    expect(gatewayInstaller).toContain(
      'atomic_install_fixed_file "$ROLLBACK_TEMP" "$ROLLBACK_PATH" 0755',
    );
    expect(gatewayInstaller).toContain(
      'printf \'%s ALL=(root) NOPASSWD: %s\\n\' "$DEPLOY_USER" "$GATEWAY_PATH"',
    );
    expect(gatewayScript).toContain(
      'PUBLISH_HELPER_PATH="${LIBEXEC_ROOT}/publish-update-mirror"',
    );
    expect(gatewayScript).toContain(
      'ROLLBACK_HELPER_PATH="${LIBEXEC_ROOT}/rollback-update-mirror"',
    );
    expect(publishMirrorScript).toContain(
      '[[ "$(stat -c \'%u:%g\' "$0")" == \'0:0\' ]]',
    );
    expect(rollbackMirrorScript).toContain(
      '[[ "$(stat -c \'%u:%g\' "$0")" == \'0:0\' ]]',
    );
  });
});
