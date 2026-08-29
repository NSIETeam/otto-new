import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const standaloneWorkflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'deploy-server.yml'),
  'utf8',
);
const releaseWorkflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);
const publishMirrorScript = readFileSync(
  path.join(repoRoot, '.github', 'scripts', 'publish-update-mirror.sh'),
  'utf8',
);
const rollbackMirrorScript = readFileSync(
  path.join(repoRoot, '.github', 'scripts', 'rollback-update-mirror.sh'),
  'utf8',
);

function expectPasswordOnStdin(productionWorkflow) {
  expect(productionWorkflow).toContain(
    'DEPLOY_SUDO_PASSWORD: ${{ secrets.DEPLOY_SUDO_PASSWORD }}',
  );
  expect(productionWorkflow).toContain(
    'printf \'%s\\n\' "$DEPLOY_SUDO_PASSWORD" |',
  );
  expect(productionWorkflow).not.toContain(
    'printf \'%s\\n\' "${{ secrets.DEPLOY_SUDO_PASSWORD }}" |',
  );
}

describe('release workflow production privilege boundary', () => {
  it('applies the protected-stdin sudo contract to both deployment workflows', () => {
    expectPasswordOnStdin(standaloneWorkflow);
    expectPasswordOnStdin(releaseWorkflow);
    expect(releaseWorkflow).toContain('test -n "$DEPLOY_SUDO_PASSWORD"');
    expect(releaseWorkflow).not.toContain('sudo -S ');
    expect(releaseWorkflow.match(/sudo -k -S -p ''/g)).toHaveLength(4);
    expect(
      releaseWorkflow.match(/printf '%s\\n' "\$DEPLOY_SUDO_PASSWORD" \|/g),
    ).toHaveLength(4);
  });

  it('backs up upgrades before using an independently authenticated deploy sudo', () => {
    const actionIndex = releaseWorkflow.indexOf('> deployment-action.txt');
    const firstSudoIndex = releaseWorkflow.indexOf("sudo -k -S -p ''");
    const backupIndex = releaseWorkflow.indexOf('backup-now.sh');
    const deployIndex = releaseWorkflow.indexOf('${DEPLOY_ENTRYPOINT}');
    expect(actionIndex).toBeGreaterThan(-1);
    expect(firstSudoIndex).toBeGreaterThan(actionIndex);
    expect(backupIndex).toBeGreaterThan(actionIndex);
    expect(deployIndex).toBeGreaterThan(backupIndex);
    expect(releaseWorkflow.slice(0, actionIndex)).not.toContain(
      "sudo -k -S -p ''",
    );
  });

  it('publishes and rolls back through one verified root script per privileged SSH session', () => {
    expect(releaseWorkflow).toContain('PAYLOAD_MANIFEST_SHA256');
    expect(releaseWorkflow).toContain('PUBLISH_SCRIPT_SHA256');
    expect(releaseWorkflow).toContain(
      "sudo -k -S -p '' /bin/bash '$REMOTE_DIR/publish-update-mirror.sh'",
    );
    expect(releaseWorkflow).toContain('ROLLBACK_SCRIPT_SHA256');
    expect(releaseWorkflow).toContain(
      "sudo -k -S -p '' /bin/bash '$REMOTE_SCRIPT'",
    );
    expect(publishMirrorScript).toContain(
      "readonly MIRROR_ROOT='/opt/otto-website'",
    );
    expect(publishMirrorScript).toContain('payload manifest digest mismatch');
    expect(publishMirrorScript).toContain("stat -c '%u:%g:%a'");
    expect(publishMirrorScript).toContain('previous-latest.json');
    expect(publishMirrorScript).toContain('previous-latest.absent');
    expect(rollbackMirrorScript).toContain('rollback script digest mismatch');
    expect(rollbackMirrorScript).toContain('previous-latest.json');
  });
});
